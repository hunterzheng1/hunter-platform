import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  ConnectorIdSchema,
  EvidenceIdSchema,
  ExternalReferenceIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  RepositoryIdSchema,
  RuntimeProviderIdSchema,
  WorktreeIdSchema,
  type ConnectorId,
  type RepositoryId,
  type RuntimeProviderId,
} from "@hunter/domain";
import { z } from "zod";
import {
  CapabilityProbeReceiptSchema,
  type CapabilityProbeReceipt,
} from "./manifest.js";
import { ExternalOperationSchema, type ExternalOperation } from "./operations.js";

const MAX_PROVIDER_OBJECT_BYTES = 64 * 1024;
const MAX_PROVIDER_OBJECT_NODES = 2_048;
const MAX_EXTERNAL_PATH_BYTES = 4 * 1024;

declare const verifiedWorkspacePathBrand: unique symbol;
export type VerifiedWorkspacePath = string & {
  readonly [verifiedWorkspacePathBrand]: true;
};

export const CanonicalWorkspaceKeySchema = z
  .string()
  .min(1)
  .max(MAX_EXTERNAL_PATH_BYTES + 16)
  .refine((value) => {
    const separator = value.indexOf(":");
    const platform = value.slice(0, separator);
    const suffix = value.slice(separator + 1);
    return (
      (platform === "posix" || platform === "win32")
      && suffix.length > 0
      && [...suffix].every((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined
          && codePoint > 0x1f
          && codePoint !== 0x7f
        );
      })
    );
  }, "CANONICAL_WORKSPACE_KEY_INVALID")
  .brand<"CanonicalWorkspaceKey">();
export type CanonicalWorkspaceKey = z.infer<
  typeof CanonicalWorkspaceKeySchema
>;

export const WorkspaceRefSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f
        );
      }),
    "WORKSPACE_REF_INVALID",
  )
  .brand<"WorkspaceRef">();
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

const ReportedWorkspacePathSchema = z
  .string()
  .min(1)
  .refine((value) =>
    (process.platform === "win32" ? win32 : posix).isAbsolute(value),
  )
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_EXTERNAL_PATH_BYTES,
  )
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f
        );
      }),
  );

export const BoundedProviderWorkspaceSchema = z.strictObject({
  workspaceRef: WorkspaceRefSchema,
  reportedWorkspacePath: ReportedWorkspacePathSchema,
});

export const WorkspaceOperationResultSchema = z.strictObject({
  workspaceRef: WorkspaceRefSchema,
  worktreeId: WorktreeIdSchema,
  reportedWorkspacePath: ReportedWorkspacePathSchema,
});
export type WorkspaceOperationResult = z.infer<
  typeof WorkspaceOperationResultSchema
>;

export type ExternalBoundaryErrorCode =
  | "UNBRANDED_ID"
  | "PROVIDER_OUTPUT_SCHEMA_MISMATCH"
  | "PROVIDER_OUTPUT_TOO_LARGE"
  | "PATH_SCOPE_VIOLATION";

export class ExternalBoundaryError extends Error {
  public constructor(readonly code: ExternalBoundaryErrorCode) {
    super(code);
    this.name = "ExternalBoundaryError";
  }
}

export function decodeExternalId<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ExternalBoundaryError("UNBRANDED_ID");
  return parsed.data;
}

function encodedJsonStringBytes(value: string, byteBudget: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (
      codeUnit === 0x08
      || codeUnit === 0x09
      || codeUnit === 0x0a
      || codeUnit === 0x0c
      || codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > byteBudget) {
      throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
    }
  }
  return bytes;
}

function preflightProviderJson(input: unknown, maxBytes: number): void {
  let bytes = 0;
  let nodes = 0;
  const pending: unknown[] = [input];
  const visited = new WeakSet<object>();
  const addBytes = (count: number): void => {
    bytes += count;
    if (bytes > maxBytes) {
      throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
    }
  };

  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > MAX_PROVIDER_OBJECT_NODES) {
      throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
    }

    if (current === null) {
      addBytes(4);
      continue;
    }
    switch (typeof current) {
      case "string":
        addBytes(encodedJsonStringBytes(current, maxBytes - bytes));
        continue;
      case "boolean":
        addBytes(current ? 4 : 5);
        continue;
      case "number": {
        if (!Number.isFinite(current)) {
          throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
        }
        const encodedNumber = JSON.stringify(current);
        if (encodedNumber === undefined) {
          throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
        }
        addBytes(Buffer.byteLength(encodedNumber, "utf8"));
        continue;
      }
      case "object":
        break;
      default:
        throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
    }

    if (visited.has(current)) {
      throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
    }
    visited.add(current);

    if (Array.isArray(current)) {
      if (current.length > MAX_PROVIDER_OBJECT_NODES - nodes) {
        throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
      }
      const ownKeys = Reflect.ownKeys(current);
      if (
        ownKeys.some((key) =>
          key !== "length"
          && (
            typeof key !== "string"
            || !/^(?:0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= current.length
          )
        )
      ) {
        throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
      }
      addBytes(2 + Math.max(0, current.length - 1));
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !("value" in descriptor)
        ) {
          throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
        }
        pending.push(descriptor.value);
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
    }
    const enumerableKeys: string[] = [];
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      enumerableKeys.push(key);
      if (enumerableKeys.length > MAX_PROVIDER_OBJECT_NODES - nodes) {
        throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
      }
    }
    const ownKeys = Reflect.ownKeys(current);
    if (
      ownKeys.length !== enumerableKeys.length
      || ownKeys.some((key) => typeof key !== "string")
    ) {
      throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
    }
    addBytes(2 + Math.max(0, enumerableKeys.length - 1));
    for (let index = enumerableKeys.length - 1; index >= 0; index -= 1) {
      const key = enumerableKeys[index]!;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !("value" in descriptor)
      ) {
        throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
      }
      addBytes(encodedJsonStringBytes(key, maxBytes - bytes));
      addBytes(1);
      pending.push(descriptor.value);
    }
  }
}

export function parseBoundedProviderObject<Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  maxBytes = MAX_PROVIDER_OBJECT_BYTES,
): Output {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
  }
  preflightProviderJson(input, maxBytes);
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
  }
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, "utf8") > maxBytes
  ) {
    throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
  }
  return parsed.data;
}

type PathPlatform = "posix" | "win32";

interface WorkspacePathBoundaryOptions {
  readonly platform?: PathPlatform;
  readonly realpathNative?: (path: string) => string;
}

export interface WorkspacePathBoundary {
  verify(
    repositoryId: RepositoryId,
    reportedWorkspacePath: string,
  ): VerifiedWorkspacePath;
  canonicalKey(path: VerifiedWorkspacePath): CanonicalWorkspaceKey;
}

function windowsPathWithoutExtendedPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/iu.test(value)) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }
  return /^\\\\\?\\/u.test(value) ? value.slice("\\\\?\\".length) : value;
}

function normalizeForComparison(
  value: string,
  platform: PathPlatform,
): string {
  if (platform === "win32") {
    return win32
      .normalize(windowsPathWithoutExtendedPrefix(value))
      .toLocaleLowerCase("en-US");
  }
  return posix.normalize(value);
}

function isSegmentContained(
  registeredRoot: string,
  candidate: string,
  platform: PathPlatform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const relative = pathApi.relative(
    normalizeForComparison(registeredRoot, platform),
    normalizeForComparison(candidate, platform),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

export function createWorkspacePathBoundary(
  registeredRoots: ReadonlyMap<RepositoryId, string>,
  options: WorkspacePathBoundaryOptions = {},
): WorkspacePathBoundary {
  const platform =
    options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const resolveNative = options.realpathNative ?? realpathSync.native;
  const roots = new Map<RepositoryId, string>();
  for (const [repositoryIdInput, rootInput] of registeredRoots) {
    const repositoryId = decodeExternalId(
      RepositoryIdSchema,
      repositoryIdInput,
    );
    try {
      roots.set(repositoryId, resolveNative(rootInput));
    } catch {
      throw new ExternalBoundaryError("PATH_SCOPE_VIOLATION");
    }
  }

  const canonicalKey = (
    path: VerifiedWorkspacePath,
  ): CanonicalWorkspaceKey =>
    CanonicalWorkspaceKeySchema.parse(
      `${platform}:${normalizeForComparison(path, platform)}`,
    );

  return Object.freeze({
    verify(
      repositoryIdInput: RepositoryId,
      reportedWorkspacePath: string,
    ): VerifiedWorkspacePath {
      const repositoryId = decodeExternalId(
        RepositoryIdSchema,
        repositoryIdInput,
      );
      const root = roots.get(repositoryId);
      if (root === undefined) {
        throw new ExternalBoundaryError("PATH_SCOPE_VIOLATION");
      }
      const parsedPath = ReportedWorkspacePathSchema.safeParse(
        reportedWorkspacePath,
      );
      if (!parsedPath.success) {
        throw new ExternalBoundaryError("PATH_SCOPE_VIOLATION");
      }
      let resolved: string;
      try {
        resolved = resolveNative(parsedPath.data);
      } catch {
        throw new ExternalBoundaryError("PATH_SCOPE_VIOLATION");
      }
      if (!isSegmentContained(root, resolved, platform)) {
        throw new ExternalBoundaryError("PATH_SCOPE_VIOLATION");
      }
      return resolved as VerifiedWorkspacePath;
    },
    canonicalKey,
  });
}

export const RuntimeFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operation_accepted") }),
  z.strictObject({ kind: z.literal("agent_returned") }),
  z.strictObject({ kind: z.literal("process_exited"), exitCode: z.number().int().nullable() }),
  z.strictObject({ kind: z.literal("terminal_idle") }),
  z.strictObject({ kind: z.literal("native_surface_opened") }),
  z.strictObject({
    kind: z.literal("session_observed"),
    state: z.enum(["created", "running", "waiting_input", "returned", "missing", "unknown"]),
  }),
]);
export type RuntimeFact = z.infer<typeof RuntimeFactSchema>;

export function runtimeFactCanCompleteStep(fact: RuntimeFact): false {
  RuntimeFactSchema.parse(fact);
  return false;
}

const ReceiptSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provider"),
    providerId: RuntimeProviderIdSchema,
    implementationVersion: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("connector"),
    connectorId: ConnectorIdSchema,
    implementationVersion: z.string().min(1).max(256),
  }),
]);

export const ExternalOperationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  operationStatus: z.enum(["completed", "indeterminate", "needs_attention", "rejected"]),
  subject: ReceiptSubjectSchema,
  nativeReferences: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("session"), referenceId: NativeSessionIdSchema }),
    z.strictObject({ kind: z.enum(["workspace", "process", "artifact"]), referenceId: ExternalReferenceIdSchema }),
  ])).max(32),
  facts: z.array(RuntimeFactSchema).max(32),
  evidence: z.strictObject({
    evidenceId: EvidenceIdSchema,
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    proofScope: z.enum(["contract_only", "local_observation", "human_receipt"]),
  }),
  workspaceResult: WorkspaceOperationResultSchema.optional(),
  observedAt: z.iso.datetime(),
});
export type ExternalOperationReceipt = z.infer<typeof ExternalOperationReceiptSchema>;

export function decodeExternalOperationReceipt(
  input: unknown,
): ExternalOperationReceipt {
  return parseBoundedProviderObject(ExternalOperationReceiptSchema, input);
}

export function decodeExternalOperationReceiptJson(
  input: string,
): ExternalOperationReceipt {
  if (Buffer.byteLength(input, "utf8") > MAX_PROVIDER_OBJECT_BYTES) {
    throw new ExternalBoundaryError("PROVIDER_OUTPUT_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ExternalBoundaryError("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
  }
  return decodeExternalOperationReceipt(parsed);
}

export function decodeCapabilityProbeReceipt(
  input: unknown,
): CapabilityProbeReceipt {
  return parseBoundedProviderObject(CapabilityProbeReceiptSchema, input);
}

export interface ExternalOperationHandler {
  execute(operation: ExternalOperation): Promise<ExternalOperationReceipt>;
}

export const ExternalOperationReconciliationSchema = z.discriminatedUnion(
  "outcome",
  [
    z.strictObject({
      outcome: z.literal("attached"),
      receipt: ExternalOperationReceiptSchema,
    }),
    z.strictObject({ outcome: z.literal("confirmed_absent") }),
    z.strictObject({ outcome: z.literal("unknown") }),
  ],
);
export type ExternalOperationReconciliation = z.infer<
  typeof ExternalOperationReconciliationSchema
>;

export function decodeExternalOperationReconciliation(
  input: unknown,
): ExternalOperationReconciliation {
  return parseBoundedProviderObject(ExternalOperationReconciliationSchema, input);
}

export interface ExternalOperationReconciler {
  reconcile(
    operation: ExternalOperation,
  ): Promise<ExternalOperationReconciliation>;
}

export interface RuntimeProvider extends ExternalOperationHandler {
  readonly providerId: RuntimeProviderId;
  probe(): Promise<CapabilityProbeReceipt>;
}

export interface Connector extends ExternalOperationHandler {
  readonly connectorId: ConnectorId;
  probe(): Promise<CapabilityProbeReceipt>;
}

export function parseExternalOperation(input: unknown): ExternalOperation {
  return ExternalOperationSchema.parse(input);
}
