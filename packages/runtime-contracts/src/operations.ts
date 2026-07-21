import { createHash } from "node:crypto";
import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import { z } from "zod";
import { AtomicCapabilitySchema } from "./manifest.js";

const operationFields = {
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema.nullable(),
  attemptId: AttemptIdSchema.nullable(),
  operationVersion: z.literal(1),
  requestedCapabilities: z.array(AtomicCapabilitySchema).min(1),
};

const fingerprintField = { fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) };

const workspacePreparePayload = z.strictObject({
  repositoryId: RepositoryIdSchema,
  deviceBindingId: DeviceBindingIdSchema,
  workspaceId: WorkspaceIdSchema,
  mode: z.enum(["read_only", "write"]),
  baselineRevision: z.string().min(7).max(128),
});
const workspaceReleasePayload = z.strictObject({ workspaceId: WorkspaceIdSchema });
const sessionLaunchPayload = z.strictObject({
  agentProfileId: AgentProfileIdSchema,
  workspaceId: WorkspaceIdSchema,
});
const sessionObservePayload = z.strictObject({ nativeSessionId: NativeSessionIdSchema });
const sessionSendPayload = z.strictObject({
  nativeSessionId: NativeSessionIdSchema,
  inputEvidenceId: EvidenceIdSchema,
});
const sessionInterruptPayload = z.strictObject({
  nativeSessionId: NativeSessionIdSchema,
  reason: z.string().min(1).max(512),
});
const nativeSurfacePayload = z.strictObject({ workspaceId: WorkspaceIdSchema });

const unsignedVariants = [
  z.strictObject({
    ...operationFields,
    operationType: z.literal("workspace.prepare"),
    payload: workspacePreparePayload,
  }),
  z.strictObject({
    ...operationFields,
    operationType: z.literal("workspace.release"),
    payload: workspaceReleasePayload,
  }),
  z.strictObject({
    ...operationFields,
    operationType: z.literal("session.launch"),
    payload: sessionLaunchPayload,
  }),
  z.strictObject({
    ...operationFields,
    operationType: z.literal("session.observe"),
    payload: sessionObservePayload,
  }),
  z.strictObject({
    ...operationFields,
    operationType: z.literal("session.send"),
    payload: sessionSendPayload,
  }),
  z.strictObject({
    ...operationFields,
    operationType: z.literal("session.interrupt"),
    payload: sessionInterruptPayload,
  }),
  z.strictObject({
    ...operationFields,
    operationType: z.literal("native_surface.open"),
    payload: nativeSurfacePayload,
  }),
] as const;

const signedVariants = [
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("workspace.prepare"),
    payload: workspacePreparePayload,
  }),
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("workspace.release"),
    payload: workspaceReleasePayload,
  }),
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("session.launch"),
    payload: sessionLaunchPayload,
  }),
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("session.observe"),
    payload: sessionObservePayload,
  }),
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("session.send"),
    payload: sessionSendPayload,
  }),
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("session.interrupt"),
    payload: sessionInterruptPayload,
  }),
  z.strictObject({
    ...operationFields,
    ...fingerprintField,
    operationType: z.literal("native_surface.open"),
    payload: nativeSurfacePayload,
  }),
] as const;

function rejectDuplicateCapabilities(
  operation: { requestedCapabilities: readonly string[] },
  context: z.core.$RefinementCtx,
): void {
  if (new Set(operation.requestedCapabilities).size !== operation.requestedCapabilities.length) {
    context.addIssue({ code: "custom", message: "DUPLICATE_REQUESTED_CAPABILITY" });
  }
}

export const ExternalOperationUnsignedSchema = z
  .discriminatedUnion("operationType", unsignedVariants)
  .superRefine(rejectDuplicateCapabilities);
export const ExternalOperationSchema = z
  .discriminatedUnion("operationType", signedVariants)
  .superRefine(rejectDuplicateCapabilities);
export type ExternalOperation = z.infer<typeof ExternalOperationSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function createExternalOperation(input: unknown): ExternalOperation {
  const unsigned = ExternalOperationUnsignedSchema.parse(input);
  return ExternalOperationSchema.parse({ ...unsigned, fingerprint: hash(unsigned) });
}

export function fingerprintExternalOperation(operation: ExternalOperation): string {
  const unsigned = Object.fromEntries(
    Object.entries(operation).filter(([key]) => key !== "fingerprint"),
  );
  return hash(ExternalOperationUnsignedSchema.parse(unsigned));
}
