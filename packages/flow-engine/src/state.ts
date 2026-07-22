import type { AttemptId, RequirementRevisionId, RunId, StepId, StepRunId, TaskId } from "@hunter/domain";

import type {
  ExecutionStatus,
  FlowEvent,
  RunStatus,
  StepConclusion,
  VerificationStatus,
} from "./events.js";
import type { WorkflowRunBinding } from "./run-binding.js";
import { EMPTY_RUN_BUDGET_USAGE, type RunBudgetUsage } from "./run-budget.js";

export interface StepAttemptState {
  readonly attemptId: AttemptId;
  readonly attemptNumber: number;
  readonly executionStatus: ExecutionStatus;
  readonly verificationStatus: VerificationStatus;
  readonly assignment?: {
    readonly operationId: string;
    readonly capabilityProbeReceiptId: string;
    readonly leaseIds: readonly string[];
  } | undefined;
}

export interface StepRunState {
  readonly stepRunId: StepRunId;
  readonly stepId: StepId;
  readonly executionStatus: ExecutionStatus;
  readonly verificationStatus: VerificationStatus;
  readonly conclusion: StepConclusion;
  readonly fixedContentHash: string;
  readonly attempts: readonly StepAttemptState[];
}

export interface WorkflowRunState {
  readonly binding: WorkflowRunBinding;
  readonly version: number;
  readonly status: RunStatus;
  readonly budgetUsage: RunBudgetUsage;
  readonly steps: readonly StepRunState[];
  readonly recoveryFacts: readonly { readonly kind: string; readonly status: "observed" | "indeterminate" | "needs_attention"; readonly reason: string }[];
  readonly scheduledChildren: readonly { readonly taskId: TaskId; readonly childRunId: RunId; readonly budget: import("./run-budget.js").RunBudgetLimit }[];
  readonly cancellationRequestedChildRunIds: readonly RunId[];
  readonly attemptCancellation: { readonly attemptId: AttemptId; readonly assignmentOperationId: string } | null;
  readonly scheduledRetry: {
    readonly stepRunId: StepRunId;
    readonly priorAttemptId: AttemptId;
    readonly nextAttemptId: AttemptId;
    readonly nextAttemptNumber: number;
    readonly notBefore: string;
  } | null;
  readonly loopUsage: Readonly<Record<string, {
    readonly iterations: number;
    readonly elapsedMs: number;
    readonly cost: number;
    readonly lastProgressFingerprint: string | null;
    readonly repeatedFailureFingerprintCount: number;
    readonly lastFailureFingerprint: string | null;
    readonly noProgressCount: number;
    readonly verifierErrorCount: number;
  }>>;
  readonly acceptedChildRunIds: readonly RunId[];
  readonly supersedingDecisions: readonly { readonly newerRevisionId: RequirementRevisionId; readonly decision: "continue_old_input" | "terminate" | "create_new_plan" }[];
  readonly dependencyFailureDecisions: readonly { readonly taskId: TaskId; readonly failedDependencyIds: readonly TaskId[]; readonly action: "blocked" | "skipped" | "compensate" | "waived" | "terminate"; readonly compensationTaskId: TaskId | null; readonly waiverReceiptHash: string | null }[];
}

function updateStep(
  state: WorkflowRunState,
  stepRunId: StepRunId,
  update: (step: StepRunState) => StepRunState,
): WorkflowRunState {
  const index = state.steps.findIndex((step) => step.stepRunId === stepRunId);
  if (index < 0) throw new Error("STEP_RUN_NOT_FOUND");
  return {
    ...state,
    steps: state.steps.map((step, current) => (current === index ? update(step) : step)),
  };
}

function applyEvent(current: WorkflowRunState | null, event: FlowEvent): WorkflowRunState {
  if (event.type === "RunStarted") {
    if (current !== null) throw new Error("RUN_ALREADY_STARTED");
    return {
      binding: event.binding,
      version: 1,
      status: "running",
      budgetUsage: { ...EMPTY_RUN_BUDGET_USAGE },
      steps: [],
      recoveryFacts: [],
      scheduledChildren: [],
      cancellationRequestedChildRunIds: [],
      attemptCancellation: null,
      scheduledRetry: null,
      loopUsage: {},
      acceptedChildRunIds: [],
      supersedingDecisions: [],
      dependencyFailureDecisions: [],
    };
  }
  if (current === null) throw new Error("RUN_NOT_STARTED");
  let state: WorkflowRunState = current;
  switch (event.type) {
    case "BudgetConsumed":
      state = {
        ...state,
        budgetUsage: {
          attempts: state.budgetUsage.attempts + event.attempts,
          elapsedMs: state.budgetUsage.elapsedMs + event.elapsedMs,
          cost: state.budgetUsage.cost + event.cost,
          tokens: state.budgetUsage.tokens + event.tokens,
          loopIterations: state.budgetUsage.loopIterations + event.loopIterations,
          lastProgressFingerprint: event.progressFingerprint ?? state.budgetUsage.lastProgressFingerprint,
          lastFailureFingerprint: event.failureFingerprint ?? state.budgetUsage.lastFailureFingerprint,
          repeatedFailureFingerprintCount:
            event.failureFingerprint === null
              ? state.budgetUsage.repeatedFailureFingerprintCount
              : event.failureFingerprint === state.budgetUsage.lastFailureFingerprint
                ? state.budgetUsage.repeatedFailureFingerprintCount + 1
                : 1,
          noDiffCount: event.noDiff ? state.budgetUsage.noDiffCount + 1 : 0,
          verifierErrorCount: event.verifierError ? state.budgetUsage.verifierErrorCount + 1 : 0,
        },
      };
      break;
    case "StepActivated": {
      const attempt: StepAttemptState = {
        attemptId: event.attemptId,
        attemptNumber: event.attemptNumber,
        executionStatus: "assigned",
        verificationStatus: "pending",
      };
      const existing = state.steps.find(({ stepRunId }) => stepRunId === event.stepRunId);
      state =
        existing === undefined
          ? {
              ...state,
              steps: [
                ...state.steps,
                {
                  stepRunId: event.stepRunId,
                  stepId: event.stepId,
                  executionStatus: "assigned",
                  verificationStatus: "pending",
                  conclusion: "active",
                  fixedContentHash: event.fixedContentHash,
                  attempts: [attempt],
                },
              ],
            }
          : updateStep(state, event.stepRunId, (step) => ({
              ...step,
              executionStatus: "assigned",
              verificationStatus: "pending",
              conclusion: "active",
              attempts: [...step.attempts, attempt],
            }));
      if (state.scheduledRetry?.nextAttemptId === event.attemptId) state = { ...state, scheduledRetry: null };
      break;
    }
    case "ExternalObservationRecorded":
      state = updateStep(state, event.stepRunId, (step) => ({
        ...step,
        executionStatus: event.executionStatus,
        attempts: step.attempts.map((attempt) =>
          attempt.attemptId === event.attemptId
            ? { ...attempt, executionStatus: event.executionStatus }
            : attempt,
        ),
      }));
      break;
    case "VerificationChanged":
      state = updateStep(state, event.stepRunId, (step) => ({
        ...step,
        verificationStatus: event.status,
        attempts: step.attempts.map((attempt) =>
          attempt.attemptId === event.attemptId
            ? { ...attempt, verificationStatus: event.status }
            : attempt,
        ),
      }));
      break;
    case "StepConcluded":
      state = updateStep(state, event.stepRunId, (step) => ({ ...step, conclusion: event.conclusion }));
      break;
    case "RunStatusChanged":
    case "RunConcluded":
      state = { ...state, status: event.status };
      break;
    case "RouteSelected":
      break;
    case "LoopActivated": {
      const previous = state.loopUsage[event.loopId];
      state = { ...state, loopUsage: { ...state.loopUsage, [event.loopId]: {
        iterations: event.iteration,
        elapsedMs: event.elapsedMs,
        cost: event.cost,
        lastProgressFingerprint: event.progressFingerprint ?? previous?.lastProgressFingerprint ?? null,
        repeatedFailureFingerprintCount: event.failureFingerprint === null
          ? previous?.repeatedFailureFingerprintCount ?? 0
          : event.failureFingerprint === previous?.lastFailureFingerprint
            ? (previous.repeatedFailureFingerprintCount + 1)
            : 1,
        lastFailureFingerprint: event.failureFingerprint ?? previous?.lastFailureFingerprint ?? null,
        noProgressCount: event.progressSatisfied ? 0 : (previous?.noProgressCount ?? 0) + 1,
        verifierErrorCount: event.verifierError ? (previous?.verifierErrorCount ?? 0) + 1 : 0,
      } } };
      break;
    }
    case "RecoveryFactsRecorded":
      state = { ...state, recoveryFacts: [...state.recoveryFacts, ...event.facts] };
      break;
    case "AttemptAssigned":
      state = {
        ...state,
        steps: state.steps.map((step) => ({
          ...step,
          attempts: step.attempts.map((attempt) => attempt.attemptId === event.attemptId
            ? { ...attempt, assignment: { operationId: event.operationId, capabilityProbeReceiptId: event.capabilityProbeReceiptId, leaseIds: [...event.leaseIds] } }
            : attempt),
        })),
      };
      break;
    case "TaskFanOutDecided":
      state = { ...state, scheduledChildren: [...state.scheduledChildren, ...event.children] };
      break;
    case "ChildConclusionAccepted":
      state = { ...state, acceptedChildRunIds: [...state.acceptedChildRunIds, event.childRunId] };
      break;
    case "SubflowConclusionAccepted":
      state = { ...state, acceptedChildRunIds: [...state.acceptedChildRunIds, event.childRunId] };
      break;
    case "SupersedingRequirementDecided":
      state = { ...state, supersedingDecisions: [...state.supersedingDecisions, { newerRevisionId: event.newerRevisionId, decision: event.decision }] };
      break;
    case "ChildCancellationRequested":
      state = { ...state, cancellationRequestedChildRunIds: [...new Set([...state.cancellationRequestedChildRunIds, ...event.childRunIds])] };
      break;
    case "AttemptCancellationRequested":
      state = { ...state, attemptCancellation: { attemptId: event.attemptId, assignmentOperationId: event.assignmentOperationId } };
      break;
    case "AttemptCancellationAcknowledged":
      state = { ...state, attemptCancellation: null };
      break;
    case "SessionHandoffRequested":
      break;
    case "RetryScheduled":
      state = { ...state, scheduledRetry: { stepRunId: event.stepRunId, priorAttemptId: event.priorAttemptId, nextAttemptId: event.nextAttemptId, nextAttemptNumber: event.nextAttemptNumber, notBefore: event.notBefore } };
      break;
    case "ExecutionFailed":
      state = updateStep(state, event.stepRunId, (step) => ({ ...step, executionStatus: "failed", attempts: step.attempts.map((attempt) => attempt.attemptId === event.attemptId ? { ...attempt, executionStatus: "failed" } : attempt) }));
      break;
    case "DependencyFailureDecided":
      state = { ...state, dependencyFailureDecisions: [...state.dependencyFailureDecisions, { taskId: event.taskId, failedDependencyIds: event.failedDependencyIds, action: event.action, compensationTaskId: event.compensationTaskId, waiverReceiptHash: event.waiverReceiptHash }] };
      break;
  }
  return { ...state, version: state.version + 1 };
}

export function reduceFlowEvents(
  initial: WorkflowRunState | null,
  events: readonly FlowEvent[],
): WorkflowRunState {
  return events.reduce<WorkflowRunState | null>(applyEvent, initial) as WorkflowRunState;
}
