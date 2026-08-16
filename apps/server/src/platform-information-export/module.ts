import { isProxy, isUint8Array } from "node:util/types";

import {
  PLATFORM_INFORMATION_EXPORT_FORMAT,
  PLATFORM_INFORMATION_EXPORT_LIMITS,
  PLATFORM_INFORMATION_EXPORT_MEDIA_TYPE,
  canonicalJson,
  platformInformationExportArtifactReceiptSchema,
  platformInformationExportProofPayload,
  platformInformationQuerySchema,
  verifyPlatformInformationExportArtifact,
  verifyPlatformInformationExportResult,
  type PlatformInformationExportArtifactReceipt,
  type PlatformInformationExportHashSession,
  type PlatformInformationPage,
  type PlatformInformationQuery,
} from "@hunter-harness/contracts";

import type { PlatformInformationExportPorts } from "./ports.js";
import type { PlatformInformationExportArtifactBeginResult } from "./ports.js";
import { discriminateTrustedAsyncResult } from "../trusted-async-result/index.js";
import {
  platformInformationExportSourcePageSchema,
  type PlatformInformationExportFailureCode,
  type PlatformInformationExportModuleResult,
  type PlatformInformationExportSourceProofPayload,
} from "./types.js";

const encoder = new TextEncoder();
const SOURCE_PAGE_MAX_BYTES = 1024 * 1024;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const MAXIMUM_SNAPSHOT_ARRAY_LENGTH = 10_000;

async function settlePortOutput(
  output: unknown,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const trusted = discriminateTrustedAsyncResult(output);
  if (trusted === undefined) return { ok: false };
  if (trusted.kind === "sync") return { ok: true, value: trusted.value };
  try {
    return { ok: true, value: await trusted.promise };
  } catch {
    return { ok: false };
  }
}

function ownDataSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || isProxy(value)) return null;
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (descriptorKeys.some((key) => typeof key !== "string")) return null;
  const actualKeys = (descriptorKeys as string[]).sort();
  const exactKeys = [...expectedKeys].sort();
  if (actualKeys.length !== exactKeys.length ||
      actualKeys.some((key, index) => key !== exactKeys[index])) return null;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of exactKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return null;
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function safeOwnDataString(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || isProxy(value)) return null;
  let prototype: object | null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
  if ((prototype !== Object.prototype && prototype !== null) ||
      descriptor === undefined || !("value" in descriptor) ||
      typeof descriptor.value !== "string") return null;
  return descriptor.value;
}

function trustedCallable(value: unknown): ((...args: readonly unknown[]) => unknown) | null {
  return typeof value === "function" && !isProxy(value)
    ? value as (...args: readonly unknown[]) => unknown
    : null;
}

function deepDataSnapshot(value: unknown): unknown | null {
  const seen = new WeakSet<object>();
  let remaining = 200_000;
  const visit = (current: unknown, depth: number): { ok: true; value: unknown } | { ok: false } => {
    remaining -= 1;
    if (remaining < 0 || depth > 64) return { ok: false };
    if (current === null || typeof current === "string" || typeof current === "number" ||
        typeof current === "boolean" || typeof current === "undefined") {
      return { ok: true, value: current };
    }
    if (typeof current !== "object" || isProxy(current) || seen.has(current)) return { ok: false };
    seen.add(current);
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(current) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return { ok: false };
    }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return { ok: false };
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) return { ok: false };
      const lengthDescriptor = descriptors.length;
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0) return { ok: false };
      const length = lengthDescriptor.value;
      if (length > MAXIMUM_SNAPSHOT_ARRAY_LENGTH || length > remaining || keys.length !== length + 1) {
        return { ok: false };
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
      }
      const copy = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
        const nested = visit(descriptor.value, depth + 1);
        if (!nested.ok) return nested;
        copy[index] = nested.value;
      }
      return { ok: true, value: Object.freeze(copy) };
    }
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    if (keys.length > remaining) return { ok: false };
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
      const nested = visit(descriptor.value, depth + 1);
      if (!nested.ok) return nested;
      Object.defineProperty(copy, key, {
        value: nested.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return { ok: true, value: Object.freeze(copy) };
  };
  const result = visit(value, 0);
  return result.ok ? result.value : null;
}

function hashSessionSnapshot(value: unknown): PlatformInformationExportHashSession | null {
  const record = ownDataSnapshot(value, ["update", "digest"]);
  if (record === null) return null;
  const update = trustedCallable(record.update);
  const digest = trustedCallable(record.digest);
  if (update === null || digest === null) return null;
  const receiver = Object.freeze({ update, digest });
  return {
    update: (chunk) => Reflect.apply(update, receiver, [chunk]) as void | Promise<void>,
    digest: () => Reflect.apply(digest, receiver, []) as string | Promise<string>,
  };
}

function beginSnapshot(value: unknown): PlatformInformationExportArtifactBeginResult | null {
  const record = ownDataSnapshot(value, [
    "attempt_id", "export_id", "created_at", "expires_at", "staged_reader",
  ]);
  if (record === null || typeof record.attempt_id !== "string" ||
      typeof record.export_id !== "string" || typeof record.created_at !== "string" ||
      typeof record.expires_at !== "string") return null;
  const readerRecord = ownDataSnapshot(record.staged_reader, ["read"]);
  if (readerRecord === null) return null;
  const read = trustedCallable(readerRecord.read);
  if (read === null) return null;
  const readerReceiver = Object.freeze({ read });
  return Object.freeze({
    attempt_id: record.attempt_id,
    export_id: record.export_id,
    created_at: record.created_at,
    expires_at: record.expires_at,
    staged_reader: Object.freeze({
      async read() {
        let rawOutput: unknown;
        try { rawOutput = Reflect.apply(read, readerReceiver, []); } catch {
          throw new Error("staged reader failed");
        }
        let output: unknown;
        if (rawOutput === null ||
            (typeof rawOutput === "object" && !isProxy(rawOutput) && isUint8Array(rawOutput))) {
          output = rawOutput;
        } else {
          const settled = await settlePortOutput(rawOutput);
          if (!settled.ok) throw new Error("untrusted staged reader output");
          output = settled.value;
        }
        if (output === null) return null;
        if (typeof output !== "object" || isProxy(output) || !isUint8Array(output)) {
          throw new Error("untrusted staged reader output");
        }
        return new Uint8Array(output as Uint8Array);
      },
    }),
  });
}

function sourceProofPayload(input: {
  readonly request: PlatformInformationQuery;
  readonly page: PlatformInformationPage;
  readonly items_sha: string;
}): PlatformInformationExportSourceProofPayload {
  return {
    schema_version: 1,
    source_kind: "platform_information_export_page",
    request: input.request,
    page: input.page,
    items_sha: input.items_sha,
  };
}

async function safeHash(
  hashPort: PlatformInformationExportPorts["hash_port"],
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    const settled = await settlePortOutput(hashPort.sha256(bytes));
    if (!settled.ok) return null;
    const value = settled.value;
    return typeof value === "string" && hashPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function safeDigest(session: PlatformInformationExportHashSession): Promise<string | null> {
  try {
    const settled = await settlePortOutput(session.digest());
    if (!settled.ok) return null;
    return typeof settled.value === "string" && hashPattern.test(settled.value)
      ? settled.value
      : null;
  } catch {
    return null;
  }
}

async function incrementalHash(
  hashPort: PlatformInformationExportPorts["hash_port"],
  bytes: Uint8Array,
): Promise<string | null> {
  let session: PlatformInformationExportHashSession;
  try {
    const snapshot = hashSessionSnapshot(hashPort.create_sha256());
    if (snapshot === null) return null;
    session = snapshot;
  } catch {
    return null;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes) {
    if (!await updateHash(
      session,
      bytes.slice(offset, Math.min(offset + PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes, bytes.byteLength)),
    )) return null;
  }
  return safeDigest(session);
}

async function appendBytes(
  ports: PlatformInformationExportPorts,
  attemptId: string,
  section: "manifest" | "items" | "footer",
  bytes: Uint8Array,
  sealLast: boolean,
): Promise<{ readonly ok: true; readonly final: { readonly content_sha: string; readonly byte_count: number } | null } |
  { readonly ok: false }> {
  let final: { content_sha: string; byte_count: number } | null = null;
  for (let offset = 0; offset < bytes.byteLength; offset += PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes) {
    const end = Math.min(offset + PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes, bytes.byteLength);
    const seal = sealLast && end === bytes.byteLength;
    let result: unknown;
    try {
      const settled = await settlePortOutput(ports.artifact_port.append({
        attempt_id: attemptId,
        section,
        chunk: bytes.slice(offset, end),
        seal,
      }));
      if (!settled.ok) return { ok: false };
      result = settled.value;
    } catch {
      return { ok: false };
    }
    const value = ownDataSnapshot(result, ["sealed", "content_sha", "byte_count"]);
    if (value === null || typeof value.sealed !== "boolean") return { ok: false };
    if (!seal && (value.sealed !== false || value.content_sha !== null || value.byte_count !== null)) {
      return { ok: false };
    }
    if (seal) {
      if (value.sealed !== true || typeof value.content_sha !== "string" ||
          !hashPattern.test(value.content_sha) || typeof value.byte_count !== "number" ||
          !Number.isSafeInteger(value.byte_count) || value.byte_count < 1) return { ok: false };
      final = { content_sha: value.content_sha, byte_count: value.byte_count };
    }
  }
  return { ok: true, final };
}

async function updateHash(
  session: PlatformInformationExportHashSession,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const settled = await settlePortOutput(session.update(bytes));
    return settled.ok && settled.value === undefined;
  } catch {
    return false;
  }
}

export interface PlatformInformationExportModule {
  export_all(trusted_query: unknown): Promise<PlatformInformationExportModuleResult>;
}

export function createPlatformInformationExportModule(
  ports: PlatformInformationExportPorts,
): PlatformInformationExportModule {
  return {
    async export_all(trustedQuery) {
      const queryResult = platformInformationQuerySchema.safeParse(trustedQuery);
      if (!queryResult.success) {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_QUERY_INVALID" };
      }
      const initialQuery = queryResult.data;
      const queryKey = await safeHash(ports.hash_port, encoder.encode(canonicalJson(initialQuery)));
      if (queryKey === null) {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE" };
      }

      let beginOutput: unknown;
      try {
        const settled = await settlePortOutput(
          ports.artifact_port.begin({ query_key: queryKey, query: initialQuery }),
        );
        if (!settled.ok) {
          return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE" };
        }
        beginOutput = settled.value;
      } catch {
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE" };
      }
      const begin = beginSnapshot(beginOutput);
      if (begin === null) {
        const safeAttemptId = safeOwnDataString(beginOutput, "attempt_id");
        if (safeAttemptId !== null) {
          try {
            await settlePortOutput(ports.artifact_port.abort({ attempt_id: safeAttemptId }));
          } catch { /* best-effort cleanup */ }
        }
        return { ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE" };
      }
      const attemptId = begin.attempt_id;
      let finished = false;
      let aborted = false;
      const fail = async (reason_code: PlatformInformationExportFailureCode): Promise<PlatformInformationExportModuleResult> => {
        if (!finished && !aborted) {
          aborted = true;
          try {
            const abortResult = await settlePortOutput(
              ports.artifact_port.abort({ attempt_id: attemptId }),
            );
            if (!abortResult.ok || abortResult.value !== undefined) {
              // Invalid cleanup output never masks the stable primary failure.
            }
          } catch { /* best-effort cleanup */ }
          finished = true;
        }
        return { ok: false, reason_code };
      };

      let itemsHashSession: PlatformInformationExportHashSession;
      try {
        const snapshot = hashSessionSnapshot(ports.hash_port.create_sha256());
        if (snapshot === null) return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
        itemsHashSession = snapshot;
      } catch {
        return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
      }
      const pages: Array<{ request_cursor: string | null; response_next_cursor: string | null; result_count: number }> = [];
      const seenCursors = new Set<string | null>([initialQuery.cursor]);
      let cursor = initialQuery.cursor;
      let ordinal = 0;
      let stagedItemBytes = 0;

      while (true) {
        if (pages.length === PLATFORM_INFORMATION_EXPORT_LIMITS.pages) {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_LIMIT_EXCEEDED");
        }
        const request: PlatformInformationQuery = { ...initialQuery, cursor };
        let serialized: unknown;
        try {
          const settled = await settlePortOutput(ports.page_source.read_page(request));
          if (!settled.ok) return fail("PLATFORM_INFORMATION_EXPORT_PAGE_SOURCE_FAILURE");
          serialized = settled.value;
        } catch {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_SOURCE_FAILURE");
        }
        if (typeof serialized !== "string") {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_SERIALIZED_JSON_REQUIRED");
        }
        const serializedBytes = encoder.encode(serialized);
        if (serializedBytes.byteLength > SOURCE_PAGE_MAX_BYTES) {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_SERIALIZED_JSON_TOO_LARGE");
        }
        let raw: unknown;
        try { raw = JSON.parse(serialized) as unknown; } catch {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_INVALID");
        }
        const sourceResult = platformInformationExportSourcePageSchema.safeParse(raw);
        if (!sourceResult.success) return fail("PLATFORM_INFORMATION_EXPORT_PAGE_INVALID");
        const source = sourceResult.data;
        if (canonicalJson(source.request) !== canonicalJson(request) ||
            source.page.project_id !== request.project_id || source.page.view !== request.view ||
            source.page.sort !== request.sort || source.page.items.length > request.limit) {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_IDENTITY_MISMATCH");
        }
        const actualItemsSha = await safeHash(
          ports.hash_port,
          encoder.encode(canonicalJson(source.page.items)),
        );
        if (actualItemsSha === null) return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
        if (actualItemsSha !== source.items_sha) {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_ITEMS_HASH_MISMATCH");
        }
        const actualProofSha = await safeHash(
          ports.hash_port,
          encoder.encode(canonicalJson(sourceProofPayload(source))),
        );
        if (actualProofSha === null) return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
        if (actualProofSha !== source.proof_sha) {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_PROOF_HASH_MISMATCH");
        }
        if (source.page.page_state !== "ready" && source.page.page_state !== "empty") {
          return fail("PLATFORM_INFORMATION_EXPORT_PAGE_STATE_NOT_EXPORTABLE");
        }

        if (ordinal + source.page.items.length > PLATFORM_INFORMATION_EXPORT_LIMITS.items) {
          return fail("PLATFORM_INFORMATION_EXPORT_ITEM_LIMIT_EXCEEDED");
        }
        for (const currentItem of source.page.items) {
          const item_sha = await safeHash(
            ports.hash_port,
            encoder.encode(canonicalJson(currentItem)),
          );
          if (item_sha === null) return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
          ordinal += 1;
          const itemLineBytes = encoder.encode(`${canonicalJson({
            schema_version: 1,
            line_kind: "item",
            ordinal,
            item_sha,
            item: currentItem,
          })}\n`);
          if (!await updateHash(itemsHashSession, itemLineBytes)) {
            return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
          }
          stagedItemBytes += itemLineBytes.byteLength;
          if (stagedItemBytes > PLATFORM_INFORMATION_EXPORT_LIMITS.artifact_bytes) {
            return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_TOO_LARGE");
          }
          const appended = await appendBytes(ports, attemptId, "items", itemLineBytes, false);
          if (!appended.ok) return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
        }

        pages.push({
          request_cursor: cursor,
          response_next_cursor: source.page.next_cursor,
          result_count: source.page.items.length,
        });
        const next = source.page.next_cursor;
        if (next === null) break;
        if (next === cursor) return fail("PLATFORM_INFORMATION_EXPORT_CURSOR_NONPROGRESS");
        if (seenCursors.has(next)) return fail("PLATFORM_INFORMATION_EXPORT_CURSOR_LOOP");
        seenCursors.add(next);
        cursor = next;
      }

      const itemsSha = await safeDigest(itemsHashSession);
      if (itemsSha === null) return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
      const range = {
        query_scope: initialQuery.query_scope,
        limit: initialQuery.limit,
        source_cursor: initialQuery.cursor,
        cursor_verification: initialQuery.cursor_verification,
        sort: initialQuery.sort,
      } as const;
      const m4Proof = { pages, exported_count: ordinal, items_sha: itemsSha, completed: true as const };
      const proofIdentity = {
        export_id: begin.export_id,
        project_id: initialQuery.project_id,
        view: initialQuery.view,
        range,
        m4_proof: m4Proof,
      };
      const proofSha = await incrementalHash(ports.hash_port, encoder.encode(canonicalJson({
        schema_version: 1,
        ...proofIdentity,
      })));
      if (proofSha === null) return fail("PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE");
      const manifestBytes = encoder.encode(`${canonicalJson({
        schema_version: 1,
        line_kind: "manifest",
        format: PLATFORM_INFORMATION_EXPORT_FORMAT,
        ...proofIdentity,
        proof_sha: proofSha,
        created_at: begin.created_at,
        expires_at: begin.expires_at,
      })}\n`);
      const footerBytes = encoder.encode(`${canonicalJson({
        schema_version: 1,
        line_kind: "footer",
        export_id: begin.export_id,
        proof_sha: proofSha,
        items_sha: itemsSha,
        item_count: ordinal,
        page_count: pages.length,
      })}\n`);
      const expectedBytes = manifestBytes.byteLength + stagedItemBytes + footerBytes.byteLength;
      if (expectedBytes > PLATFORM_INFORMATION_EXPORT_LIMITS.artifact_bytes) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_TOO_LARGE");
      }
      const manifestAppend = await appendBytes(ports, attemptId, "manifest", manifestBytes, false);
      if (!manifestAppend.ok) return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      const footerAppend = await appendBytes(ports, attemptId, "footer", footerBytes, true);
      if (!footerAppend.ok || footerAppend.final === null) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }
      if (footerAppend.final.byte_count > PLATFORM_INFORMATION_EXPORT_LIMITS.artifact_bytes) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_TOO_LARGE");
      }
      if (footerAppend.final.byte_count !== expectedBytes) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }

      const receiptCandidate: PlatformInformationExportArtifactReceipt = {
        schema_version: 1,
        contract_kind: "platform_information_export_artifact_receipt",
        ...proofIdentity,
        proof_sha: proofSha,
        artifact: {
          format: PLATFORM_INFORMATION_EXPORT_FORMAT,
          media_type: PLATFORM_INFORMATION_EXPORT_MEDIA_TYPE,
          content_sha: footerAppend.final.content_sha,
          items_sha: itemsSha,
          byte_count: footerAppend.final.byte_count,
          item_count: ordinal,
          page_count: pages.length,
        },
        download_ref: {
          export_id: begin.export_id,
          project_id: initialQuery.project_id,
          content_sha: footerAppend.final.content_sha,
        },
        status: "ready",
        created_at: begin.created_at,
        expires_at: begin.expires_at,
      };
      const receiptResult = platformInformationExportArtifactReceiptSchema.safeParse(receiptCandidate);
      if (!receiptResult.success || canonicalJson(platformInformationExportProofPayload(receiptResult.data)) !==
          canonicalJson({ schema_version: 1, ...proofIdentity })) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_SELF_VERIFICATION_FAILED");
      }
      const m4Result = verifyPlatformInformationExportResult(JSON.stringify({
        schema_version: 1,
        contract_kind: "export_all_result",
        view: initialQuery.view,
        project_id: initialQuery.project_id,
        range,
        pages,
        exported_count: ordinal,
        completed: true,
      }), initialQuery);
      if (!m4Result.ok) return fail("PLATFORM_INFORMATION_EXPORT_M4_SELF_VERIFICATION_FAILED");
      const artifactResult = await verifyPlatformInformationExportArtifact(
        JSON.stringify(receiptResult.data),
        { hash_port: ports.hash_port, chunk_reader: begin.staged_reader },
      );
      if (!artifactResult.ok) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_SELF_VERIFICATION_FAILED");
      }

      let committed: unknown;
      try {
        const settled = await settlePortOutput(ports.artifact_port.commit({
          attempt_id: attemptId,
          query_key: queryKey,
          serialized_receipt: JSON.stringify(receiptResult.data),
        }));
        if (!settled.ok) return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
        committed = settled.value;
      } catch {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }
      const commitDiscriminator = ownDataSnapshot(committed, ["ok", "receipt"])
        ?? ownDataSnapshot(committed, ["ok", "reason_code"]);
      if (commitDiscriminator === null || typeof commitDiscriminator.ok !== "boolean") {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }
      if (commitDiscriminator.ok === false) {
        if (commitDiscriminator.reason_code !== "different_output" ||
            Object.hasOwn(commitDiscriminator, "receipt")) {
          return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
        }
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_COMMIT_CONFLICT");
      }
      if (!Object.hasOwn(commitDiscriminator, "receipt") ||
          Object.hasOwn(commitDiscriminator, "reason_code")) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }
      const committedReceipt = deepDataSnapshot(commitDiscriminator.receipt);
      if (committedReceipt === null) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }
      const parsedCommitted = platformInformationExportArtifactReceiptSchema.safeParse(committedReceipt);
      if (!parsedCommitted.success || canonicalJson(parsedCommitted.data) !== canonicalJson(receiptResult.data)) {
        return fail("PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE");
      }
      finished = true;
      return { ok: true, value: parsedCommitted.data };
    },
  };
}
