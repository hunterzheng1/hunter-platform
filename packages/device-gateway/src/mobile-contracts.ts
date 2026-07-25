import {
  GateIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  StepRunIdSchema,
} from "@hunter/domain/ids";
import { z } from "zod";

export const MobileScopeSchema = z.enum([
  "runs:read",
  "artifacts:read",
  "gates:approve",
  "runs:control",
]);
export type MobileScope = z.infer<typeof MobileScopeSchema>;

export const MobileScopeSetSchema = z
  .array(MobileScopeSchema)
  .min(1)
  .max(MobileScopeSchema.options.length)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: "custom", message: "mobile scopes must be unique" });
    }
  });

export const MobileCommandActionSchema = z.enum([
  "approve_gate",
  "reject_gate",
  "supplement_input",
  "pause_run",
  "resume_run",
  "terminate_run",
]);
export type MobileCommandAction = z.infer<typeof MobileCommandActionSchema>;

export const MobileStepKindSchema = z.enum([
  "agent",
  "command",
  "verify",
  "human_gate",
  "context",
  "subflow",
]);
export type MobileStepKind = z.infer<typeof MobileStepKindSchema>;

export const MobileGatePermissionRiskSchema = z.enum([
  "low",
  "medium",
  "high",
  "unknown",
]);
export type MobileGatePermissionRisk = z.infer<
  typeof MobileGatePermissionRiskSchema
>;

const MOBILE_GATE_PERMISSION_RISKS: Readonly<
  Record<string, Exclude<MobileGatePermissionRisk, "unknown">>
> = Object.freeze({
  "workflow.approve-plan": "medium",
  "filesystem.outside-project": "high",
  "credentials.undeclared": "high",
  "filesystem.destructive": "high",
  "system.install": "high",
  "remote.mutate": "high",
  "permissions.bypass": "high",
  "mobile.high-risk-command": "high",
});

export function classifyMobileGatePermissionRisk(
  permission: string,
): MobileGatePermissionRisk {
  return MOBILE_GATE_PERMISSION_RISKS[permission] ?? "unknown";
}

export const MobileSafeGatePermissionSchema = z.enum([
  "workflow.approve-plan",
]);
export type MobileSafeGatePermission = z.infer<
  typeof MobileSafeGatePermissionSchema
>;

const ExpectedVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const IdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const EmptyPayloadSchema = z.strictObject({});
const RejectPayloadSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1_000).optional(),
});
const SupplementPayloadSchema = z.strictObject({
  text: z.string().trim().min(1).max(4_000),
});
const commonCommandShape = {
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  expectedVersion: ExpectedVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
};
const gateTargetShape = {
  stepRunId: z.never().optional(),
  gateId: GateIdSchema,
};
const stepTargetShape = {
  stepRunId: StepRunIdSchema,
  gateId: z.never().optional(),
};

export const MobileCommandEnvelopeSchema = z.union([
  z.strictObject({ ...commonCommandShape, ...gateTargetShape, action: z.literal("approve_gate"), payload: EmptyPayloadSchema }),
  z.strictObject({ ...commonCommandShape, ...gateTargetShape, action: z.literal("reject_gate"), payload: RejectPayloadSchema }),
  z.strictObject({ ...commonCommandShape, ...stepTargetShape, action: z.literal("supplement_input"), payload: SupplementPayloadSchema }),
  z.strictObject({ ...commonCommandShape, ...stepTargetShape, action: z.literal("pause_run"), payload: EmptyPayloadSchema }),
  z.strictObject({ ...commonCommandShape, ...stepTargetShape, action: z.literal("resume_run"), payload: EmptyPayloadSchema }),
  z.strictObject({ ...commonCommandShape, ...stepTargetShape, action: z.literal("terminate_run"), payload: EmptyPayloadSchema }),
]);
export type MobileCommandEnvelope = z.infer<typeof MobileCommandEnvelopeSchema>;

export const MobileCommandReceiptSchema = z.strictObject({
  commandId: z.string().trim().min(1).max(256),
  response: z.unknown(),
});
export const MobileCommandResultSchema = z.strictObject({
  status: z.enum(["accepted", "rejected", "conflict"]),
  receipt: MobileCommandReceiptSchema,
});
export type MobileCommandResult = z.infer<typeof MobileCommandResultSchema>;

const mobileRunProjectionShape = {
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  projectName: z.string().trim().min(1).max(120),
  currentStep: MobileStepKindSchema,
  attention: z.string().trim().min(1).max(500),
  commands: z.array(MobileCommandEnvelopeSchema).max(6),
};

export const MobileRunProjectionSchema = z.discriminatedUnion("connection", [
  z.strictObject({
    ...mobileRunProjectionShape,
    connection: z.literal("online"),
    cachedAt: z.never().optional(),
  }),
  z.strictObject({
    ...mobileRunProjectionShape,
    connection: z.literal("offline"),
    cachedAt: z.string().datetime({ offset: true }),
  }),
]).superRefine((projection, context) => {
  const keys = new Set<string>();
  projection.commands.forEach((command, index) => {
    if (command.projectId !== projection.projectId || command.runId !== projection.runId) {
      context.addIssue({
        code: "custom",
        path: ["commands", index],
        message: "mobile command scope must match its Run projection",
      });
    }
    if (keys.has(command.idempotencyKey)) {
      context.addIssue({
        code: "custom",
        path: ["commands", index, "idempotencyKey"],
        message: "mobile command idempotency keys must be unique within a projection",
      });
    }
    keys.add(command.idempotencyKey);
  });
});
export type MobileRunProjection = z.infer<typeof MobileRunProjectionSchema>;
