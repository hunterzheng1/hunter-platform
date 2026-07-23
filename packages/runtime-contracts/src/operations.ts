import { createHash } from "node:crypto";
import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
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
  requestedCapabilities: z.array(AtomicCapabilitySchema).min(1),
};
const versionOneFields = { ...operationFields, operationVersion: z.literal(1) };
const versionTwoFields = { ...operationFields, operationVersion: z.literal(2) };

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
const controllerAuthorityFields = {
  controllerLeaseId: ControllerLeaseIdSchema,
  controllerLeaseOwnerId: LeaseOwnerIdSchema,
  controllerLeaseGeneration: z.number().int().positive(),
};
const sessionObserveV1Payload = z.strictObject({ nativeSessionId: NativeSessionIdSchema });
const sessionObservePayload = z.strictObject({ nativeSessionId: NativeSessionIdSchema, ...controllerAuthorityFields });
const sessionSendV1Payload = z.strictObject({ nativeSessionId: NativeSessionIdSchema, inputEvidenceId: EvidenceIdSchema });
const sessionSendPayload = z.strictObject({
  nativeSessionId: NativeSessionIdSchema,
  inputEvidenceId: EvidenceIdSchema,
  ...controllerAuthorityFields,
});
const sessionInterruptV1Payload = z.strictObject({ nativeSessionId: NativeSessionIdSchema, reason: z.string().min(1).max(512) });
const sessionInterruptPayload = z.strictObject({
  nativeSessionId: NativeSessionIdSchema,
  reason: z.string().min(1).max(512),
  ...controllerAuthorityFields,
});
const nativeSurfacePayload = z.strictObject({ workspaceId: WorkspaceIdSchema });
const taskPackWritePayload = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  inputEvidenceId: EvidenceIdSchema,
});
const sessionResumePayload = z.strictObject({
  nativeSessionId: NativeSessionIdSchema,
  ...controllerAuthorityFields,
});

const unsignedVariants = [
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("workspace.prepare"),
    payload: workspacePreparePayload,
  }),
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("workspace.release"),
    payload: workspaceReleasePayload,
  }),
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("session.launch"),
    payload: sessionLaunchPayload,
  }),
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("session.observe"),
    payload: sessionObserveV1Payload,
  }),
  z.strictObject({
    ...versionTwoFields,
    operationType: z.literal("session.observe"),
    payload: sessionObservePayload,
  }),
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("session.send"),
    payload: sessionSendV1Payload,
  }),
  z.strictObject({
    ...versionTwoFields,
    operationType: z.literal("session.send"),
    payload: sessionSendPayload,
  }),
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("session.interrupt"),
    payload: sessionInterruptV1Payload,
  }),
  z.strictObject({
    ...versionTwoFields,
    operationType: z.literal("session.interrupt"),
    payload: sessionInterruptPayload,
  }),
  z.strictObject({
    ...versionOneFields,
    operationType: z.literal("native_surface.open"),
    payload: nativeSurfacePayload,
  }),
  z.strictObject({
    ...versionTwoFields,
    operationType: z.literal("task_pack.write"),
    payload: taskPackWritePayload,
  }),
  z.strictObject({
    ...versionTwoFields,
    operationType: z.literal("session.resume"),
    payload: sessionResumePayload,
  }),
] as const;

const signedVariants = [
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("workspace.prepare"),
    payload: workspacePreparePayload,
  }),
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("workspace.release"),
    payload: workspaceReleasePayload,
  }),
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("session.launch"),
    payload: sessionLaunchPayload,
  }),
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("session.observe"),
    payload: sessionObserveV1Payload,
  }),
  z.strictObject({
    ...versionTwoFields,
    ...fingerprintField,
    operationType: z.literal("session.observe"),
    payload: sessionObservePayload,
  }),
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("session.send"),
    payload: sessionSendV1Payload,
  }),
  z.strictObject({
    ...versionTwoFields,
    ...fingerprintField,
    operationType: z.literal("session.send"),
    payload: sessionSendPayload,
  }),
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("session.interrupt"),
    payload: sessionInterruptV1Payload,
  }),
  z.strictObject({
    ...versionTwoFields,
    ...fingerprintField,
    operationType: z.literal("session.interrupt"),
    payload: sessionInterruptPayload,
  }),
  z.strictObject({
    ...versionOneFields,
    ...fingerprintField,
    operationType: z.literal("native_surface.open"),
    payload: nativeSurfacePayload,
  }),
  z.strictObject({
    ...versionTwoFields,
    ...fingerprintField,
    operationType: z.literal("task_pack.write"),
    payload: taskPackWritePayload,
  }),
  z.strictObject({
    ...versionTwoFields,
    ...fingerprintField,
    operationType: z.literal("session.resume"),
    payload: sessionResumePayload,
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
  .union(unsignedVariants)
  .superRefine(rejectDuplicateCapabilities);
export const ExternalOperationSchema = z
  .union(signedVariants)
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
