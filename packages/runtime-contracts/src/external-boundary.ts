import {
  ConnectorIdSchema,
  EvidenceIdSchema,
  ExternalReferenceIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  RuntimeProviderIdSchema,
  type ConnectorId,
  type RuntimeProviderId,
} from "@hunter/domain";
import { z } from "zod";
import type { CapabilityProbeReceipt } from "./manifest.js";
import { ExternalOperationSchema, type ExternalOperation } from "./operations.js";

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
    implementationVersion: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("connector"),
    connectorId: ConnectorIdSchema,
    implementationVersion: z.string().min(1),
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
  ])),
  facts: z.array(RuntimeFactSchema),
  evidence: z.strictObject({
    evidenceId: EvidenceIdSchema,
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    proofScope: z.enum(["contract_only", "local_observation", "human_receipt"]),
  }),
  observedAt: z.iso.datetime(),
});
export type ExternalOperationReceipt = z.infer<typeof ExternalOperationReceiptSchema>;

export interface ExternalOperationHandler {
  execute(operation: ExternalOperation): Promise<ExternalOperationReceipt>;
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
