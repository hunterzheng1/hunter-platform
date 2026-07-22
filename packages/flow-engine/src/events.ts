import type { AttemptId, RunId, StepId, StepRunId, TaskId } from "@hunter/domain";

import type { ExternalObservation } from "./commands.js";
import type { WorkflowRunBinding } from "./run-binding.js";

export type ExecutionStatus =
  | "assigned"
  | "running"
  | "waiting_input"
  | "returned"
  | "failed"
  | "canceled"
  | "stale"
  | "needs_attention";
export type VerificationStatus = "pending" | "verifying" | "passed" | "failed" | "error" | "needs_human";
export type StepConclusion = "active" | "succeeded" | "failed" | "blocked" | "canceled";
export type RunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "canceled"
  | "needs_attention";

export type FlowEvent =
  | { readonly type: "RunStarted"; readonly binding: WorkflowRunBinding }
  | {
      readonly type: "BudgetConsumed";
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly cost: number;
      readonly tokens: number;
      readonly loopIterations: number;
      readonly progressFingerprint: string | null;
      readonly failureFingerprint: string | null;
      readonly noDiff: boolean;
      readonly verifierError: boolean;
    }
  | {
      readonly type: "StepActivated";
      readonly stepRunId: StepRunId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly attemptNumber: number;
      readonly fixedContentHash: string;
    }
  | {
      readonly type: "ExternalObservationRecorded";
      readonly stepRunId: StepRunId;
      readonly attemptId: AttemptId;
      readonly fact: ExternalObservation;
      readonly executionStatus: ExecutionStatus;
    }
  | {
      readonly type: "VerificationChanged";
      readonly stepRunId: StepRunId;
      readonly attemptId: AttemptId;
      readonly status: VerificationStatus;
      readonly evidenceFingerprint: string;
    }
  | {
      readonly type: "StepConcluded";
      readonly stepRunId: StepRunId;
      readonly conclusion: Exclude<StepConclusion, "active">;
    }
  | {
      readonly type: "RouteSelected";
      readonly routeId: string;
      readonly fromStepId: StepId;
      readonly toStepId: StepId | null;
      readonly outcome: string;
    }
  | { readonly type: "LoopActivated"; readonly loopId: string; readonly iteration: number }
  | { readonly type: "RecoveryFactsRecorded"; readonly facts: readonly { readonly kind: string; readonly status: "indeterminate" | "needs_attention"; readonly reason: string }[] }
  | { readonly type: "AttemptAssigned"; readonly attemptId: AttemptId; readonly operationId: string; readonly capabilityProbeReceiptId: string; readonly leaseIds: readonly string[] }
  | { readonly type: "TaskFanOutDecided"; readonly children: readonly { readonly taskId: TaskId; readonly childRunId: RunId }[] }
  | { readonly type: "ChildConclusionAccepted"; readonly taskId: TaskId; readonly childRunId: RunId; readonly status: "succeeded" | "failed" | "canceled" }
  | { readonly type: "SubflowConclusionAccepted"; readonly parentStepRunId: StepRunId; readonly childRunId: RunId; readonly status: "succeeded" | "failed" | "canceled" }
  | { readonly type: "ChildCancellationRequested"; readonly childRunIds: readonly RunId[] }
  | { readonly type: "SupersedingRequirementDecided"; readonly newerRevisionId: string; readonly decision: "continue_old_input" | "terminate" | "create_new_plan" }
  | { readonly type: "SessionHandoffRequested"; readonly action: "new_session_handoff" | "needs_attention" }
  | { readonly type: "ExecutionFailed"; readonly stepRunId: StepRunId; readonly attemptId: AttemptId; readonly errorClass: string }
  | { readonly type: "RetryScheduled"; readonly stepRunId: StepRunId; readonly priorAttemptId: AttemptId; readonly nextAttemptId: AttemptId; readonly delayMs: number }
  | { readonly type: "DependencyFailureDecided"; readonly taskId: TaskId; readonly failedDependencyIds: readonly TaskId[]; readonly action: "blocked" | "skipped" | "compensate" | "waived" | "terminate"; readonly compensationTaskId: TaskId | null; readonly waiverReceiptHash: string | null }
  | { readonly type: "RunStatusChanged"; readonly status: RunStatus }
  | { readonly type: "RunConcluded"; readonly status: "succeeded" | "failed" | "canceled" | "needs_attention" };
