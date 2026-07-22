import type { AttemptId, StepId, StepRunId } from "@hunter/domain";

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
  readonly recoveryFacts: readonly { readonly kind: string; readonly status: "indeterminate" | "needs_attention"; readonly reason: string }[];
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
    case "LoopActivated":
      break;
    case "RecoveryFactsRecorded":
      state = { ...state, recoveryFacts: [...state.recoveryFacts, ...event.facts] };
      break;
    case "AttemptAssigned":
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
