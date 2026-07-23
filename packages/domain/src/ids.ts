import { z } from "zod";

function canonicalId(prefix: string, label: string) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{7,63}$`, "u"),
      `${label} must be a canonical opaque identifier`,
    );
}

export const ProjectIdSchema = canonicalId("prj", "ProjectId").brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const DeviceIdSchema = canonicalId("dvc", "DeviceId").brand<"DeviceId">();
export type DeviceId = z.infer<typeof DeviceIdSchema>;

export const RequirementIdSchema = canonicalId("req", "RequirementId").brand<"RequirementId">();
export type RequirementId = z.infer<typeof RequirementIdSchema>;

export const RequirementRevisionIdSchema = canonicalId(
  "rrv",
  "RequirementRevisionId",
).brand<"RequirementRevisionId">();
export type RequirementRevisionId = z.infer<typeof RequirementRevisionIdSchema>;

export const ChangeIdSchema = canonicalId("chg", "ChangeId").brand<"ChangeId">();
export type ChangeId = z.infer<typeof ChangeIdSchema>;

export const ChangeRevisionIdSchema = canonicalId("crv", "ChangeRevisionId").brand<"ChangeRevisionId">();
export type ChangeRevisionId = z.infer<typeof ChangeRevisionIdSchema>;

export const TaskIdSchema = canonicalId("tsk", "TaskId").brand<"TaskId">();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const WorkflowRevisionIdSchema = canonicalId(
  "wfr",
  "WorkflowRevisionId",
).brand<"WorkflowRevisionId">();
export type WorkflowRevisionId = z.infer<typeof WorkflowRevisionIdSchema>;

export const StepIdSchema = canonicalId("stp", "StepId").brand<"StepId">();
export type StepId = z.infer<typeof StepIdSchema>;

export const StepRunIdSchema = canonicalId("spr", "StepRunId").brand<"StepRunId">();
export type StepRunId = z.infer<typeof StepRunIdSchema>;

export const RouteIdSchema = canonicalId("rte", "RouteId").brand<"RouteId">();
export type RouteId = z.infer<typeof RouteIdSchema>;

export const LoopIdSchema = canonicalId("lop", "LoopId").brand<"LoopId">();
export type LoopId = z.infer<typeof LoopIdSchema>;

export const ExecutionPlanIdSchema = canonicalId(
  "epl",
  "ExecutionPlanId",
).brand<"ExecutionPlanId">();
export type ExecutionPlanId = z.infer<typeof ExecutionPlanIdSchema>;

export const RunIdSchema = canonicalId("run", "RunId").brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;

export const AttemptIdSchema = canonicalId("att", "AttemptId").brand<"AttemptId">();
export type AttemptId = z.infer<typeof AttemptIdSchema>;

export const OperationIdSchema = canonicalId("opn", "OperationId").brand<"OperationId">();
export type OperationId = z.infer<typeof OperationIdSchema>;

export const EvidenceIdSchema = canonicalId("evd", "EvidenceId").brand<"EvidenceId">();
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

export const ArtifactIdSchema = canonicalId("art", "ArtifactId").brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const AgentProfileIdSchema = canonicalId("apr", "AgentProfileId").brand<"AgentProfileId">();
export type AgentProfileId = z.infer<typeof AgentProfileIdSchema>;

export const CapabilityProbeReceiptIdSchema = canonicalId(
  "cpr",
  "CapabilityProbeReceiptId",
).brand<"CapabilityProbeReceiptId">();
export type CapabilityProbeReceiptId = z.infer<typeof CapabilityProbeReceiptIdSchema>;

export const ConnectorIdSchema = canonicalId("con", "ConnectorId").brand<"ConnectorId">();
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;

export const RuntimeProviderIdSchema = canonicalId(
  "rtp",
  "RuntimeProviderId",
).brand<"RuntimeProviderId">();
export type RuntimeProviderId = z.infer<typeof RuntimeProviderIdSchema>;

export const WorkspaceIdSchema = canonicalId("wsp", "WorkspaceId").brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const WorktreeIdSchema = canonicalId("wtr", "WorktreeId").brand<"WorktreeId">();
export type WorktreeId = z.infer<typeof WorktreeIdSchema>;

export const RepositoryIdSchema = canonicalId("rep", "RepositoryId").brand<"RepositoryId">();
export type RepositoryId = z.infer<typeof RepositoryIdSchema>;

export const DeviceBindingIdSchema = canonicalId(
  "dev",
  "DeviceBindingId",
).brand<"DeviceBindingId">();
export type DeviceBindingId = z.infer<typeof DeviceBindingIdSchema>;

export const NativeSessionIdSchema = canonicalId(
  "ses",
  "NativeSessionId",
).brand<"NativeSessionId">();
export type NativeSessionId = z.infer<typeof NativeSessionIdSchema>;

export const ExternalReferenceIdSchema = canonicalId(
  "xrf",
  "ExternalReferenceId",
).brand<"ExternalReferenceId">();
export type ExternalReferenceId = z.infer<typeof ExternalReferenceIdSchema>;

export const LeaseOwnerIdSchema = canonicalId("own", "LeaseOwnerId").brand<"LeaseOwnerId">();
export type LeaseOwnerId = z.infer<typeof LeaseOwnerIdSchema>;

export const WorkspaceLeaseIdSchema = canonicalId(
  "wsl",
  "WorkspaceLeaseId",
).brand<"WorkspaceLeaseId">();
export type WorkspaceLeaseId = z.infer<typeof WorkspaceLeaseIdSchema>;

export const WriterLeaseIdSchema = canonicalId("wrl", "WriterLeaseId").brand<"WriterLeaseId">();
export type WriterLeaseId = z.infer<typeof WriterLeaseIdSchema>;

export const ControllerLeaseIdSchema = canonicalId(
  "ctl",
  "ControllerLeaseId",
).brand<"ControllerLeaseId">();
export type ControllerLeaseId = z.infer<typeof ControllerLeaseIdSchema>;
