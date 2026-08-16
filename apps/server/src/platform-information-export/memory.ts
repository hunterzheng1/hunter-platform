import { createHash } from "node:crypto";

import {
  PLATFORM_INFORMATION_EXPORT_LIMITS,
  canonicalJson,
  platformInformationExportArtifactReceiptSchema,
  platformInformationPageSchema,
  type PlatformInformationExportArtifactReceipt,
  type PlatformInformationExportHashPort,
  type PlatformInformationPage,
  type PlatformInformationQuery,
} from "@hunter-harness/contracts";

import type {
  PlatformInformationExportArtifactAppendResult,
  PlatformInformationExportArtifactBeginResult,
  PlatformInformationExportArtifactCommitResult,
  PlatformInformationExportArtifactPort,
  PlatformInformationExportArtifactSection,
  PlatformInformationExportPageSourcePort,
} from "./ports.js";
import type { PlatformInformationExportSourceProofPayload } from "./types.js";

const encoder = new TextEncoder();

function nodeDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createNodePlatformInformationExportHashPort(): PlatformInformationExportHashPort {
  return {
    sha256: (bytes) => nodeDigest(bytes),
    create_sha256: () => {
      const hash = createHash("sha256");
      let digested = false;
      return {
        update(chunk) {
          if (digested) throw new Error("hash session already digested");
          hash.update(chunk);
        },
        digest() {
          if (digested) throw new Error("hash session already digested");
          digested = true;
          return `sha256:${hash.digest("hex")}`;
        },
      };
    },
  };
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

export interface MemoryPlatformInformationExportPageSource
  extends PlatformInformationExportPageSourcePort {
  readonly metrics: {
    read_count: number;
    active_pages: number;
    max_active_pages: number;
    max_serialized_page_bytes: number;
  };
}

export function createMemoryPlatformInformationExportPageSource(options: {
  readonly initial_query: PlatformInformationQuery;
  readonly pages: readonly PlatformInformationPage[];
  readonly hash_port: PlatformInformationExportHashPort;
  readonly before_read?: (input: { readonly index: number; readonly query: PlatformInformationQuery }) => void | Promise<void>;
}): MemoryPlatformInformationExportPageSource {
  const metrics = {
    read_count: 0,
    active_pages: 0,
    max_active_pages: 0,
    max_serialized_page_bytes: 0,
  };
  const initial = canonicalJson(options.initial_query);
  const cursorToIndex = new Map<string | null, number>();
  let requestCursor = options.initial_query.cursor;
  options.pages.forEach((page, index) => {
    cursorToIndex.set(requestCursor, index);
    requestCursor = page.next_cursor;
  });

  return {
    metrics,
    async read_page(query) {
      const invariantQuery = { ...query, cursor: options.initial_query.cursor };
      if (canonicalJson(invariantQuery) !== initial) throw new Error("query does not match memory source");
      const index = cursorToIndex.get(query.cursor);
      if (index === undefined) throw new Error("cursor not found");
      metrics.read_count += 1;
      metrics.active_pages += 1;
      metrics.max_active_pages = Math.max(metrics.max_active_pages, metrics.active_pages);
      try {
        await options.before_read?.({ index, query });
        const parsedPage = platformInformationPageSchema.parse(options.pages[index]);
        const items_sha = await options.hash_port.sha256(
          encoder.encode(canonicalJson(parsedPage.items)),
        );
        const payload = sourceProofPayload({ request: query, page: parsedPage, items_sha });
        const proof_sha = await options.hash_port.sha256(
          encoder.encode(canonicalJson(payload)),
        );
        const serialized = canonicalJson({ ...payload, proof_sha });
        metrics.max_serialized_page_bytes = Math.max(
          metrics.max_serialized_page_bytes,
          encoder.encode(serialized).byteLength,
        );
        return serialized;
      } finally {
        metrics.active_pages -= 1;
      }
    },
  };
}

interface Attempt {
  readonly attempt_id: string;
  readonly query_key: string;
  readonly query: PlatformInformationQuery;
  readonly metadata: { export_id: string; created_at: string; expires_at: string };
  readonly sections: Record<PlatformInformationExportArtifactSection, Uint8Array[]>;
  sealed: boolean;
  assembled: Uint8Array | null;
  reader_offset: number;
}

interface CommittedArtifact {
  readonly bytes: Uint8Array;
  readonly receipt: PlatformInformationExportArtifactReceipt;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function incrementalDigest(
  hashPort: PlatformInformationExportHashPort,
  chunks: readonly Uint8Array[],
): Promise<string> {
  const session = hashPort.create_sha256();
  for (const chunk of chunks) await session.update(chunk);
  return session.digest();
}

export interface MemoryPlatformInformationExportArtifactPort
  extends PlatformInformationExportArtifactPort {
  readonly metrics: {
    begin_count: number;
    append_count: number;
    commit_count: number;
    abort_count: number;
    active_appends: number;
    max_unacknowledged_appends: number;
    max_append_chunk_bytes: number;
  };
  read_committed(query_key: string): Uint8Array | null;
}

export function createMemoryPlatformInformationExportArtifactPort(options: {
  readonly hash_port: PlatformInformationExportHashPort;
  readonly now?: () => string;
  readonly lifetime_ms?: number;
  readonly fail_append_at?: number;
  readonly throw_on_commit?: boolean;
}): MemoryPlatformInformationExportArtifactPort {
  const now = options.now ?? (() => new Date().toISOString());
  const lifetimeMs = options.lifetime_ms ?? 24 * 60 * 60 * 1_000;
  const metadataByQuery = new Map<string, Attempt["metadata"]>();
  const attempts = new Map<string, Attempt>();
  const committed = new Map<string, CommittedArtifact>();
  const metrics = {
    begin_count: 0,
    append_count: 0,
    commit_count: 0,
    abort_count: 0,
    active_appends: 0,
    max_unacknowledged_appends: 0,
    max_append_chunk_bytes: 0,
  };
  let attemptSequence = 0;

  function requiredAttempt(attemptId: string): Attempt {
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) throw new Error("unknown export attempt");
    return attempt;
  }

  const port: MemoryPlatformInformationExportArtifactPort = {
    metrics,
    async begin(input): Promise<PlatformInformationExportArtifactBeginResult> {
      metrics.begin_count += 1;
      const metadata = metadataByQuery.get(input.query_key) ?? (() => {
        const created_at = now();
        const value = {
          export_id: `export_${input.query_key.slice("sha256:".length, "sha256:".length + 32)}`,
          created_at,
          expires_at: new Date(Date.parse(created_at) + lifetimeMs).toISOString(),
        };
        metadataByQuery.set(input.query_key, value);
        return value;
      })();
      const attempt_id = `attempt_${++attemptSequence}`;
      const attempt: Attempt = {
        attempt_id,
        query_key: input.query_key,
        query: structuredClone(input.query),
        metadata,
        sections: { manifest: [], items: [], footer: [] },
        sealed: false,
        assembled: null,
        reader_offset: 0,
      };
      attempts.set(attempt_id, attempt);
      return {
        attempt_id,
        ...metadata,
        staged_reader: {
          read() {
            const current = requiredAttempt(attempt_id);
            if (!current.sealed || current.assembled === null) {
              throw new Error("staging artifact is not sealed");
            }
            if (current.reader_offset === current.assembled.byteLength) return null;
            const end = Math.min(
              current.reader_offset + PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes,
              current.assembled.byteLength,
            );
            const chunk = current.assembled.slice(current.reader_offset, end);
            current.reader_offset = end;
            return chunk;
          },
        },
      };
    },
    async append(input): Promise<PlatformInformationExportArtifactAppendResult> {
      metrics.append_count += 1;
      metrics.active_appends += 1;
      metrics.max_unacknowledged_appends = Math.max(
        metrics.max_unacknowledged_appends,
        metrics.active_appends,
      );
      metrics.max_append_chunk_bytes = Math.max(
        metrics.max_append_chunk_bytes,
        input.chunk.byteLength,
      );
      try {
        if (options.fail_append_at === metrics.append_count) throw new Error("injected append failure");
        const attempt = requiredAttempt(input.attempt_id);
        if (attempt.sealed || !(input.chunk instanceof Uint8Array) || input.chunk.byteLength === 0 ||
            input.chunk.byteLength > PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes) {
          throw new Error("invalid artifact append");
        }
        attempt.sections[input.section].push(input.chunk.slice());
        if (!input.seal) return { sealed: false, content_sha: null, byte_count: null };
        if (input.section !== "footer") throw new Error("only the footer can seal an artifact");
        const assembled = concatBytes([
          ...attempt.sections.manifest,
          ...attempt.sections.items,
          ...attempt.sections.footer,
        ]);
        if (assembled.byteLength > PLATFORM_INFORMATION_EXPORT_LIMITS.artifact_bytes) {
          throw new Error("artifact too large");
        }
        attempt.assembled = assembled;
        attempt.sealed = true;
        attempt.reader_offset = 0;
        const content_sha = await incrementalDigest(options.hash_port, [
          ...attempt.sections.manifest,
          ...attempt.sections.items,
          ...attempt.sections.footer,
        ]);
        return { sealed: true, content_sha, byte_count: assembled.byteLength };
      } finally {
        metrics.active_appends -= 1;
      }
    },
    async commit(input): Promise<PlatformInformationExportArtifactCommitResult> {
      metrics.commit_count += 1;
      if (options.throw_on_commit === true) throw new Error("injected commit failure");
      const attempt = requiredAttempt(input.attempt_id);
      if (!attempt.sealed || attempt.assembled === null || attempt.query_key !== input.query_key) {
        throw new Error("unsealed or mismatched export attempt");
      }
      const parsed = platformInformationExportArtifactReceiptSchema.safeParse(
        JSON.parse(input.serialized_receipt) as unknown,
      );
      if (!parsed.success) throw new Error("invalid export receipt");
      // Recompute at commit instead of trusting the staged append summary.
      const committedChunks = [
        ...attempt.sections.manifest,
        ...attempt.sections.items,
        ...attempt.sections.footer,
      ];
      const committedByteCount = committedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const contentSha = await incrementalDigest(options.hash_port, committedChunks);
      if (contentSha !== parsed.data.artifact.content_sha ||
          committedByteCount !== parsed.data.artifact.byte_count ||
          parsed.data.export_id !== attempt.metadata.export_id) {
        throw new Error("commit receipt does not match staged artifact");
      }
      const prior = committed.get(input.query_key);
      if (prior !== undefined) {
        if (prior.receipt.artifact.content_sha !== contentSha ||
            canonicalJson(prior.receipt) !== canonicalJson(parsed.data)) {
          return { ok: false, reason_code: "different_output" };
        }
        attempts.delete(input.attempt_id);
        return { ok: true, receipt: prior.receipt };
      }
      const saved = { bytes: attempt.assembled.slice(), receipt: parsed.data };
      committed.set(input.query_key, saved);
      attempts.delete(input.attempt_id);
      return { ok: true, receipt: saved.receipt };
    },
    async abort(input) {
      metrics.abort_count += 1;
      attempts.delete(input.attempt_id);
    },
    read_committed(queryKey) {
      return committed.get(queryKey)?.bytes.slice() ?? null;
    },
  };
  return port;
}
