import { createHash } from "node:crypto";

import {
  AttemptIdSchema,
  RunIdSchema,
  StepRunIdSchema,
  canonicalSha256,
  type ExecutionPlan,
  type RunId,
  type TaskId,
  type WorkflowRevision,
} from "@hunter/domain";
import type { ExternalOperation } from "@hunter/runtime-contracts";

import type {
  FlowCommand,
  FlowCommandReceipt,
  ExistingRunCommand,
  RecordExternalObservationCommand,
  RecordVerifierResultCommand,
  StartRunCommand,
} from "./commands.js";
import type { FlowEvent } from "./events.js";
import { deriveTaskFanOut, resolveDependencyFailure, resolveResumeFailure, resolveSupersedingRequirement, selectRoute, type FrozenDependencyFailureRule } from "./router.js";
import { createWorkflowRunBinding } from "./run-binding.js";
import type { WorkflowRunState } from "./state.js";
import { canTransitionExecution, isTerminalRun } from "./transition-table.js";

export interface FlowCommit {
  readonly commandId: string;
  readonly requestFingerprint: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly events: readonly FlowEvent[];
  readonly response: unknown;
  readonly operations?: readonly ExternalOperation[] | undefined;
}

export interface FlowStore {
  loadRun(runId: string): WorkflowRunState | null;
  activeTaskIds(parentRunId: string): readonly TaskId[];
  childRuns(parentRunId: string): readonly WorkflowRunState[];
  getReceipt(commandId: string, requestFingerprint: string): FlowCommandReceipt | null;
  commit(input: FlowCommit): FlowCommandReceipt;
}

export interface FlowDefinitions {
  getWorkflowRevision(workflowRevisionId: string): Readonly<WorkflowRevision> | null;
  getExecutionPlan(executionPlanId: string): Readonly<ExecutionPlan> | null;
  getDependencyFailureRule?(executionPlanId: string, taskId: TaskId): Readonly<FrozenDependencyFailureRule> | null;
}

function derivedId(prefix: "spr" | "att" | "run", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function activeStep(state: WorkflowRunState) {
  const step = [...state.steps].reverse().find(({ conclusion }) => conclusion === "active");
  if (step === undefined) throw new Error("ACTIVE_STEP_NOT_FOUND");
  const attempt = step.attempts.at(-1);
  if (attempt === undefined) throw new Error("ACTIVE_ATTEMPT_NOT_FOUND");
  return { step, attempt };
}

export class FlowEngine {
  public constructor(
    private readonly store: FlowStore,
    private readonly definitions: FlowDefinitions,
  ) {}

  public handle(command: FlowCommand): FlowCommandReceipt {
    const commandId = `${command.type}:${command.idempotencyKey}`;
    const requestFingerprint = canonicalSha256(command);
    const replay = this.store.getReceipt(commandId, requestFingerprint);
    if (replay !== null) return replay;
    switch (command.type) {
      case "StartRun":
        return this.startRun(command, commandId, requestFingerprint);
      case "RecordExternalObservation":
        return this.recordObservation(command, commandId, requestFingerprint);
      case "RecordVerifierResult":
        return this.recordVerifier(command, commandId, requestFingerprint);
      case "RecordTimeout":
        return this.recordTimeout(command, commandId, requestFingerprint);
      case "CancelRun":
        return this.cancelRun(command, commandId, requestFingerprint);
      case "RecordRecoveryFacts":
        return this.recordRecoveryFacts(command, commandId, requestFingerprint);
      case "AssignAttempt":
        return this.assignAttempt(command, commandId, requestFingerprint);
      case "ScheduleTaskFanOut":
        return this.scheduleTaskFanOut(command, commandId, requestFingerprint);
      case "ReconcileTaskChildren":
        return this.reconcileTaskChildren(command, commandId, requestFingerprint);
      case "ReconcileSubflowChild":
        return this.reconcileSubflowChild(command, commandId, requestFingerprint);
      case "RecordSupersedingRequirement":
        return this.recordSupersedingRequirement(command, commandId, requestFingerprint);
      case "RecordResumeFailure":
        return this.recordResumeFailure(command, commandId, requestFingerprint);
      case "RecordExecutionFailure":
        return this.recordExecutionFailure(command, commandId, requestFingerprint);
      case "ResolveTaskDependencyFailure":
        return this.resolveTaskDependencyFailure(command, commandId, requestFingerprint);
    }
  }

  private recordTimeout(command: ExistingRunCommand, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const workflow = this.requireWorkflow(state.binding.workflowRevisionId);
    const { step } = activeStep(state);
    const definition = workflow.steps.find(({ stepId }) => stepId === step.stepId);
    if (definition === undefined) throw new Error("WORKFLOW_STEP_NOT_FOUND");
    const status = definition.timeoutPolicy.onTimeout;
    const conclusion = status === "canceled" ? "canceled" : "failed";
    const runStatus = status === "needs_attention" ? "needs_attention" : status;
    const events: FlowEvent[] = [
      { type: "StepConcluded", stepRunId: step.stepRunId, conclusion },
      { type: "RunConcluded", status: runStatus },
    ];
    return this.commitExisting(command, commandId, requestFingerprint, events, { status: runStatus });
  }

  private cancelRun(command: ExistingRunCommand, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const { step } = activeStep(state);
    const activeChildren = this.store.childRuns(command.runId).filter((child) => !isTerminalRun(child.status));
    const events: FlowEvent[] = [
      ...(activeChildren.length === 0 ? [] : [{ type: "ChildCancellationRequested" as const, childRunIds: activeChildren.map(({ binding }) => binding.runId) }]),
      { type: "StepConcluded", stepRunId: step.stepRunId, conclusion: "canceled" },
      { type: "RunConcluded", status: "canceled" },
    ];
    return this.commitExisting(command, commandId, requestFingerprint, events, { status: "canceled" });
  }

  private recordRecoveryFacts(command: Extract<FlowCommand, { type: "RecordRecoveryFacts" }>, commandId: string, requestFingerprint: string) {
    this.requireActiveRun(command.runId);
    if (command.facts.length === 0) throw new Error("RECOVERY_FACTS_REQUIRED");
    const events: FlowEvent[] = [
      { type: "RecoveryFactsRecorded", facts: command.facts },
      { type: "RunStatusChanged", status: "needs_attention" },
    ];
    return this.commitExisting(command, commandId, requestFingerprint, events, { status: "needs_attention" });
  }

  private assignAttempt(command: Extract<FlowCommand, { type: "AssignAttempt" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const { attempt } = activeStep(state);
    if (command.operation.runId !== command.runId || command.operation.attemptId !== attempt.attemptId) throw new Error("ASSIGNMENT_OPERATION_SCOPE_MISMATCH");
    const events: FlowEvent[] = [{ type: "AttemptAssigned", attemptId: attempt.attemptId, operationId: command.operation.operationId, capabilityProbeReceiptId: command.capabilityProbeReceiptId, leaseIds: command.leaseIds }];
    return this.commitExisting(command, commandId, requestFingerprint, events, { operationId: command.operation.operationId, status: "scheduled" }, [command.operation]);
  }

  private scheduleTaskFanOut(command: Extract<FlowCommand, { type: "ScheduleTaskFanOut" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    if (state.binding.subjectKind !== "change") throw new Error("TASK_FANOUT_REQUIRES_ROOT_RUN");
    const plan = this.requirePlan(state.binding.executionPlanId);
    const actual = this.store.childRuns(command.runId)
      .filter((child) => child.binding.subjectKind === "task")
      .map((child) => ({ taskId: child.binding.subjectKind === "task" ? child.binding.taskId : plan.tasks[0]!.taskId, status: isTerminalRun(child.status) ? child.status as "succeeded" | "failed" | "canceled" : "running" as const }));
    const actualIds = new Set(actual.map(({ taskId }) => taskId));
    const decided = state.scheduledChildren.filter(({ taskId }) => !actualIds.has(taskId)).map(({ taskId }) => ({ taskId, status: "running" as const }));
    const taskIds = deriveTaskFanOut(plan, [...actual, ...decided], state.dependencyFailureDecisions);
    const children = taskIds.map((taskId) => ({ taskId, childRunId: RunIdSchema.parse(derivedId("run", `${command.runId}:${taskId}`)) }));
    const events: FlowEvent[] = [{ type: "TaskFanOutDecided", children }];
    return this.commitExisting(command, commandId, requestFingerprint, events, { children });
  }

  private reconcileTaskChildren(command: Extract<FlowCommand, { type: "ReconcileTaskChildren" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const terminal = this.store.childRuns(command.runId).flatMap((child) => {
      if (child.binding.subjectKind !== "task" || !isTerminalRun(child.status) || state.acceptedChildRunIds.includes(child.binding.runId)) return [];
      return [{ child, taskId: child.binding.taskId, status: child.status }];
    });
    if (terminal.length === 0) throw new Error("NO_NEW_CHILD_CONCLUSION");
    const events: FlowEvent[] = [];
    const rolled = terminal.reduce((usage, { child }) => ({ attempts: usage.attempts + child.budgetUsage.attempts, elapsedMs: usage.elapsedMs + child.budgetUsage.elapsedMs, cost: usage.cost + child.budgetUsage.cost, tokens: usage.tokens + child.budgetUsage.tokens, loopIterations: usage.loopIterations + child.budgetUsage.loopIterations }), { attempts: 0, elapsedMs: 0, cost: 0, tokens: 0, loopIterations: 0 });
    const exhausted = state.budgetUsage.attempts + rolled.attempts > state.binding.initialBudget.maxAttempts || state.budgetUsage.elapsedMs + rolled.elapsedMs > state.binding.initialBudget.maxElapsedMs || state.budgetUsage.cost + rolled.cost > state.binding.initialBudget.maxCost || state.budgetUsage.tokens + rolled.tokens > state.binding.initialBudget.maxTokens || state.budgetUsage.loopIterations + rolled.loopIterations > state.binding.initialBudget.maxLoopIterations;
    for (const { child, taskId, status } of terminal) {
      events.push({ type: "ChildConclusionAccepted", taskId, childRunId: child.binding.runId, status });
      events.push({ type: "BudgetConsumed", attempts: child.budgetUsage.attempts, elapsedMs: child.budgetUsage.elapsedMs, cost: child.budgetUsage.cost, tokens: child.budgetUsage.tokens, loopIterations: child.budgetUsage.loopIterations, progressFingerprint: null, failureFingerprint: null, noDiff: false, verifierError: false });
    }
    if (exhausted) events.push({ type: "RunStatusChanged", status: "needs_attention" });
    else {
      const accepted = new Set([...state.acceptedChildRunIds, ...terminal.map(({ child }) => child.binding.runId)]);
      const allScheduledAccepted = state.scheduledChildren.length > 0 && state.scheduledChildren.every(({ childRunId }) => accepted.has(childRunId));
      const allSucceeded = terminal.every(({ status }) => status === "succeeded") && this.store.childRuns(command.runId).filter((child) => child.binding.subjectKind === "task" && accepted.has(child.binding.runId)).every(({ status }) => status === "succeeded");
      const integrationSucceeded = state.steps.some(({ conclusion }) => conclusion === "succeeded");
      if (allScheduledAccepted && allSucceeded && integrationSucceeded) events.push({ type: "RunConcluded", status: "succeeded" });
      else if (terminal.some(({ status }) => status !== "succeeded")) events.push({ type: "RunStatusChanged", status: "needs_attention" });
    }
    return this.commitExisting(command, commandId, requestFingerprint, events, { acceptedChildRunIds: terminal.map(({ child }) => child.binding.runId) });
  }

  private reconcileSubflowChild(command: Extract<FlowCommand, { type: "ReconcileSubflowChild" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    if (state.acceptedChildRunIds.includes(command.childRunId)) throw new Error("CHILD_CONCLUSION_ALREADY_ACCEPTED");
    const child = this.store.loadRun(command.childRunId);
    if (child === null || child.binding.subjectKind !== "subflow" || child.binding.parentRunId !== command.runId) {
      throw new Error("SUBFLOW_CHILD_SCOPE_MISMATCH");
    }
    if (!isTerminalRun(child.status)) throw new Error("SUBFLOW_CHILD_NOT_TERMINAL");
    const { step } = activeStep(state);
    if (child.binding.parentStepRunId !== step.stepRunId) throw new Error("SUBFLOW_PARENT_STEP_MISMATCH");
    const workflow = this.requireWorkflow(state.binding.workflowRevisionId);
    const definition = workflow.steps.find(({ stepId }) => stepId === step.stepId);
    if (definition?.kind !== "subflow") throw new Error("ACTIVE_STEP_NOT_SUBFLOW");
    const events: FlowEvent[] = [
      { type: "SubflowConclusionAccepted", parentStepRunId: step.stepRunId, childRunId: child.binding.runId, status: child.status },
      { type: "BudgetConsumed", attempts: child.budgetUsage.attempts, elapsedMs: child.budgetUsage.elapsedMs, cost: child.budgetUsage.cost, tokens: child.budgetUsage.tokens, loopIterations: child.budgetUsage.loopIterations, progressFingerprint: null, failureFingerprint: null, noDiff: false, verifierError: false },
    ];
    const rolledState: WorkflowRunState = {
      ...state,
      budgetUsage: {
        ...state.budgetUsage,
        attempts: state.budgetUsage.attempts + child.budgetUsage.attempts,
        elapsedMs: state.budgetUsage.elapsedMs + child.budgetUsage.elapsedMs,
        cost: state.budgetUsage.cost + child.budgetUsage.cost,
        tokens: state.budgetUsage.tokens + child.budgetUsage.tokens,
        loopIterations: state.budgetUsage.loopIterations + child.budgetUsage.loopIterations,
      },
    };
    const budgetExhausted =
      rolledState.budgetUsage.attempts > state.binding.initialBudget.maxAttempts ||
      rolledState.budgetUsage.elapsedMs > state.binding.initialBudget.maxElapsedMs ||
      rolledState.budgetUsage.cost > state.binding.initialBudget.maxCost ||
      rolledState.budgetUsage.tokens > state.binding.initialBudget.maxTokens ||
      rolledState.budgetUsage.loopIterations > state.binding.initialBudget.maxLoopIterations;
    if (budgetExhausted) {
      events.push({ type: "RunStatusChanged", status: "needs_attention" });
      return this.commitExisting(command, commandId, requestFingerprint, events, { status: "needs_attention", childRunId: child.binding.runId });
    }
    const outcome = child.status === "succeeded" ? "passed" : child.status;
    const selected = selectRoute(workflow, step.stepId, outcome, { childStatus: child.status });
    if (selected === null || selected.loop !== null) {
      events.push({ type: "RunStatusChanged", status: "needs_attention" });
      return this.commitExisting(command, commandId, requestFingerprint, events, { status: "needs_attention", childRunId: child.binding.runId });
    }
    events.push({ type: "StepConcluded", stepRunId: step.stepRunId, conclusion: child.status === "succeeded" ? "succeeded" : child.status });
    events.push({ type: "RouteSelected", routeId: selected.route.routeId, fromStepId: selected.route.fromStepId, toStepId: selected.route.toStepId, outcome });
    if (selected.route.toStepId === null) {
      events.push({ type: "RunConcluded", status: child.status });
    } else {
      const target = workflow.steps.find(({ stepId }) => stepId === selected.route.toStepId);
      if (target === undefined) throw new Error("ROUTE_TARGET_STEP_MISSING");
      if (!this.budgetAvailable(rolledState, target)) {
        events.push({ type: "RunStatusChanged", status: "needs_attention" });
      } else {
        const stepRunId = StepRunIdSchema.parse(derivedId("spr", `${state.binding.runId}:${target.stepId}`));
        const attemptId = AttemptIdSchema.parse(derivedId("att", `${state.binding.runId}:${target.stepId}:1`));
        events.push({ type: "BudgetConsumed", attempts: 1, elapsedMs: target.budgetCost.elapsedMs, cost: target.budgetCost.cost, tokens: 0, loopIterations: 0, progressFingerprint: null, failureFingerprint: null, noDiff: false, verifierError: false });
        events.push({ type: "StepActivated", stepRunId, stepId: target.stepId, attemptId, attemptNumber: 1, fixedContentHash: canonicalSha256({ bindingFingerprint: state.binding.bindingFingerprint, stepId: target.stepId }) });
      }
    }
    return this.commitExisting(command, commandId, requestFingerprint, events, { status: child.status, childRunId: child.binding.runId });
  }

  private recordSupersedingRequirement(command: Extract<FlowCommand, { type: "RecordSupersedingRequirement" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const decision = resolveSupersedingRequirement(state.binding, command);
    const events: FlowEvent[] = [{ type: "SupersedingRequirementDecided", newerRevisionId: decision.newerRevisionId, decision: decision.action }];
    if (decision.action === "terminate") events.push({ type: "RunConcluded", status: "canceled" });
    return this.commitExisting(command, commandId, requestFingerprint, events, { decision: decision.action, bindingFingerprint: state.binding.bindingFingerprint });
  }

  private recordResumeFailure(command: Extract<FlowCommand, { type: "RecordResumeFailure" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const workflow = this.requireWorkflow(state.binding.workflowRevisionId);
    const { step } = activeStep(state);
    const definition = workflow.steps.find(({ stepId }) => stepId === step.stepId);
    if (definition === undefined) throw new Error("WORKFLOW_STEP_NOT_FOUND");
    const result = resolveResumeFailure(definition.sessionPolicy);
    const events: FlowEvent[] = [{ type: "SessionHandoffRequested", action: result.action }, { type: "RunStatusChanged", status: result.status }];
    return this.commitExisting(command, commandId, requestFingerprint, events, result);
  }

  private recordExecutionFailure(command: Extract<FlowCommand, { type: "RecordExecutionFailure" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    const workflow = this.requireWorkflow(state.binding.workflowRevisionId);
    const { step, attempt } = activeStep(state);
    const definition = workflow.steps.find(({ stepId }) => stepId === step.stepId);
    if (definition === undefined) throw new Error("WORKFLOW_STEP_NOT_FOUND");
    const retryable = definition.retryPolicy.retryableErrorClasses.includes(command.errorClass);
    const events: FlowEvent[] = [{ type: "ExecutionFailed", stepRunId: step.stepRunId, attemptId: attempt.attemptId, errorClass: command.errorClass }];
    if (!retryable || attempt.attemptNumber >= definition.retryPolicy.maxAttempts || !this.budgetAvailable(state, definition)) {
      events.push({ type: "StepConcluded", stepRunId: step.stepRunId, conclusion: "failed" });
      events.push({ type: "RunConcluded", status: retryable ? "needs_attention" : "failed" });
      return this.commitExisting(command, commandId, requestFingerprint, events, { retryScheduled: false });
    }
    const nextAttemptNumber = attempt.attemptNumber + 1;
    const rawDelay = definition.retryPolicy.backoff.kind === "fixed"
      ? definition.retryPolicy.backoff.initialDelayMs
      : Math.min(definition.retryPolicy.backoff.maxDelayMs, definition.retryPolicy.backoff.initialDelayMs * definition.retryPolicy.backoff.multiplier ** (attempt.attemptNumber - 1));
    const delayMs = definition.retryPolicy.jitter === "none"
      ? Math.round(rawDelay)
      : Number.parseInt(canonicalSha256({ runId: command.runId, attemptId: attempt.attemptId }).slice(0, 8), 16) % (Math.round(rawDelay) + 1);
    const nextAttemptId = AttemptIdSchema.parse(derivedId("att", `${state.binding.runId}:${step.stepId}:${nextAttemptNumber}`));
    events.push({ type: "RetryScheduled", stepRunId: step.stepRunId, priorAttemptId: attempt.attemptId, nextAttemptId, delayMs });
    events.push({ type: "BudgetConsumed", attempts: 1, elapsedMs: definition.budgetCost.elapsedMs + definition.retryPolicy.waitingBudgetCost, cost: definition.budgetCost.cost, tokens: 0, loopIterations: 0, progressFingerprint: null, failureFingerprint: command.errorClass, noDiff: false, verifierError: false });
    events.push({ type: "StepActivated", stepRunId: step.stepRunId, stepId: step.stepId, attemptId: nextAttemptId, attemptNumber: nextAttemptNumber, fixedContentHash: step.fixedContentHash });
    return this.commitExisting(command, commandId, requestFingerprint, events, { retryScheduled: true, attemptId: nextAttemptId, delayMs });
  }

  private resolveTaskDependencyFailure(command: Extract<FlowCommand, { type: "ResolveTaskDependencyFailure" }>, commandId: string, requestFingerprint: string) {
    const state = this.requireActiveRun(command.runId);
    if (state.binding.subjectKind !== "change") throw new Error("DEPENDENCY_DECISION_REQUIRES_ROOT_RUN");
    if (state.dependencyFailureDecisions.some(({ taskId }) => taskId === command.taskId)) throw new Error("DEPENDENCY_FAILURE_ALREADY_DECIDED");
    const plan = this.requirePlan(state.binding.executionPlanId);
    const task = plan.tasks.find(({ taskId }) => taskId === command.taskId);
    if (task === undefined) throw new Error("TASK_NOT_IN_EXECUTION_PLAN");
    const childByTask = new Map(
      this.store.childRuns(command.runId)
        .filter((child) => child.binding.subjectKind === "task")
        .map((child) => [child.binding.subjectKind === "task" ? child.binding.taskId : command.taskId, child] as const),
    );
    const failedDependencyIds = task.dependsOn
      .filter((taskId) => {
        const status = childByTask.get(taskId)?.status;
        return status === "failed" || status === "canceled";
      })
      .sort();
    if (failedDependencyIds.length === 0) throw new Error("FAILED_DEPENDENCY_REQUIRED");
    if (state.scheduledChildren.some(({ taskId }) => taskId === command.taskId) || childByTask.has(command.taskId)) {
      throw new Error("TASK_CHILD_ALREADY_SCHEDULED");
    }
    const rule = this.definitions.getDependencyFailureRule?.(state.binding.executionPlanId, command.taskId) ?? null;
    if (rule === null) throw new Error("DEPENDENCY_FAILURE_POLICY_NOT_CONFIGURED");
    if (rule.policy === "waiver") {
      const expectedContentHash = canonicalSha256({ runId: command.runId, taskId: command.taskId, failedDependencyIds });
      if (command.humanWaiver?.contentHash !== expectedContentHash) throw new Error("WAIVER_CONTENT_HASH_MISMATCH");
      if (command.humanWaiver.actorId !== command.actor.actorId) throw new Error("WAIVER_ACTOR_MISMATCH");
      if (!command.actor.roles?.includes(rule.requiredRole)) throw new Error("WAIVER_ROLE_REQUIRED");
    } else if (command.humanWaiver !== undefined) {
      throw new Error("WAIVER_NOT_ALLOWED");
    }
    const decision = resolveDependencyFailure({
      policy: rule.policy,
      compensationTaskId: rule.policy === "compensation" ? rule.compensationTaskId : undefined,
      waiver: command.humanWaiver,
    });
    const compensationTaskId = decision.action === "compensate" ? decision.taskId : null;
    const waiverReceiptHash = decision.action === "waived" ? decision.receiptHash : null;
    const events: FlowEvent[] = [{ type: "DependencyFailureDecided", taskId: command.taskId, failedDependencyIds, action: decision.action, compensationTaskId, waiverReceiptHash }];
    const scheduledTaskId = decision.action === "compensate" ? decision.taskId : decision.action === "waived" ? command.taskId : null;
    const children = scheduledTaskId === null ? [] : [{ taskId: scheduledTaskId, childRunId: RunIdSchema.parse(derivedId("run", `${command.runId}:${scheduledTaskId}`)) }];
    if (scheduledTaskId !== null) {
      if (!plan.tasks.some(({ taskId }) => taskId === scheduledTaskId)) throw new Error("DEPENDENCY_DECISION_TASK_NOT_IN_PLAN");
      if (state.scheduledChildren.some(({ taskId }) => taskId === scheduledTaskId) || childByTask.has(scheduledTaskId)) throw new Error("DEPENDENCY_DECISION_TASK_ALREADY_SCHEDULED");
      events.push({ type: "TaskFanOutDecided", children });
    }
    if (decision.action === "blocked") events.push({ type: "RunStatusChanged", status: "paused" });
    if (decision.action === "terminate") {
      const activeChildren = this.store.childRuns(command.runId).filter((child) => !isTerminalRun(child.status));
      if (activeChildren.length > 0) events.push({ type: "ChildCancellationRequested", childRunIds: activeChildren.map(({ binding }) => binding.runId) });
      const { step } = activeStep(state);
      events.push({ type: "StepConcluded", stepRunId: step.stepRunId, conclusion: "canceled" });
      events.push({ type: "RunConcluded", status: "canceled" });
    }
    return this.commitExisting(command, commandId, requestFingerprint, events, { action: decision.action, children });
  }

  private startRun(command: StartRunCommand, commandId: string, requestFingerprint: string) {
    if (this.store.loadRun(command.binding.runId) !== null) throw new Error("RUN_ALREADY_EXISTS");
    const workflow = this.requireWorkflow(command.binding.workflowRevisionId);
    const plan = this.requirePlan(command.binding.executionPlanId);
    const binding =
      command.binding.subjectKind === "change"
        ? createWorkflowRunBinding(command.binding)
        : createWorkflowRunBinding(command.binding, {
            parent: this.store.loadRun(command.binding.parentRunId)?.binding,
            executionPlan: plan,
            activeTaskIds: this.store.activeTaskIds(command.binding.parentRunId),
            parentTerminal: this.parentTerminal(command.binding.parentRunId),
          });
    if (binding.projectId !== plan.projectId || binding.changeRevisionId !== plan.changeRevisionId) {
      throw new Error("RUN_BINDING_EXECUTION_PLAN_CONTEXT_MISMATCH");
    }
    if (binding.subjectKind === "change" && binding.taskGraphFingerprint !== plan.taskGraphFingerprint) {
      throw new Error("RUN_TASK_GRAPH_FINGERPRINT_MISMATCH");
    }
    const entry = workflow.steps.find(({ stepId }) => stepId === workflow.entryStepId);
    if (entry === undefined) throw new Error("WORKFLOW_ENTRY_STEP_MISSING");
    this.assertBudgetAvailable(null, binding.initialBudget, entry, 0);
    const stepRunId = StepRunIdSchema.parse(derivedId("spr", `${binding.runId}:${entry.stepId}`));
    const attemptId = AttemptIdSchema.parse(derivedId("att", `${binding.runId}:${entry.stepId}:1`));
    const events: FlowEvent[] = [
      { type: "RunStarted", binding },
      {
        type: "BudgetConsumed",
        attempts: 1,
        elapsedMs: entry.budgetCost.elapsedMs,
        cost: entry.budgetCost.cost,
        tokens: 0,
        loopIterations: 0,
        progressFingerprint: null,
        failureFingerprint: null,
        noDiff: false,
        verifierError: false,
      },
      {
        type: "StepActivated",
        stepRunId,
        stepId: entry.stepId,
        attemptId,
        attemptNumber: 1,
        fixedContentHash: canonicalSha256({ bindingFingerprint: binding.bindingFingerprint, stepId: entry.stepId }),
      },
    ];
    return this.store.commit({
      commandId,
      requestFingerprint,
      runId: binding.runId,
      expectedVersion: command.expectedVersion,
      events,
      response: { runId: binding.runId, bindingFingerprint: binding.bindingFingerprint },
    });
  }

  private recordObservation(
    command: RecordExternalObservationCommand,
    commandId: string,
    requestFingerprint: string,
  ) {
    const state = this.requireActiveRun(command.runId);
    const { step, attempt } = activeStep(state);
    const executionStatus = command.fact === "agent_returned" ? "returned" : step.executionStatus;
    if (!canTransitionExecution(step.executionStatus, executionStatus)) {
      throw new Error("EXECUTION_TRANSITION_REJECTED");
    }
    const events: FlowEvent[] = [
      {
        type: "ExternalObservationRecorded",
        stepRunId: step.stepRunId,
        attemptId: attempt.attemptId,
        fact: command.fact,
        executionStatus,
      },
    ];
    return this.store.commit({
      commandId,
      requestFingerprint,
      runId: command.runId,
      expectedVersion: command.expectedVersion,
      events,
      response: { executionStatus, verificationStatus: step.verificationStatus },
    });
  }

  private recordVerifier(
    command: RecordVerifierResultCommand,
    commandId: string,
    requestFingerprint: string,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(command.evidenceFingerprint)) {
      throw new Error("EVIDENCE_FINGERPRINT_INVALID");
    }
    const state = this.requireActiveRun(command.runId);
    const workflow = this.requireWorkflow(state.binding.workflowRevisionId);
    const { step, attempt } = activeStep(state);
    if (step.executionStatus !== "returned") throw new Error("EXECUTION_NOT_RETURNED");
    const definition = workflow.steps.find(({ stepId }) => stepId === step.stepId);
    if (definition === undefined) throw new Error("WORKFLOW_STEP_NOT_FOUND");
    if (definition.verifier.kind === "human_receipt" && command.outcome === "passed") {
      if (command.humanReceipt?.contentHash !== step.fixedContentHash) {
        throw new Error("HUMAN_RECEIPT_CONTENT_HASH_MISMATCH");
      }
      if (command.humanReceipt.actorId !== command.actor.actorId) throw new Error("HUMAN_RECEIPT_ACTOR_MISMATCH");
      if (!command.actor.roles?.includes(definition.verifier.requiredRole)) throw new Error("HUMAN_RECEIPT_ROLE_REQUIRED");
    }
    const events: FlowEvent[] = [
      {
        type: "VerificationChanged",
        stepRunId: step.stepRunId,
        attemptId: attempt.attemptId,
        status: "verifying",
        evidenceFingerprint: command.evidenceFingerprint,
      },
      {
        type: "VerificationChanged",
        stepRunId: step.stepRunId,
        attemptId: attempt.attemptId,
        status: command.outcome,
        evidenceFingerprint: command.evidenceFingerprint,
      },
    ];
    if (command.outcome === "needs_human") {
      events.push({ type: "RunStatusChanged", status: "waiting_approval" });
      return this.commitExisting(command, commandId, requestFingerprint, events, {
        verificationStatus: "needs_human",
      });
    }
    const routeOutcome = command.outcome === "passed" ? "passed" : "failed";
    const selected = selectRoute(workflow, step.stepId, routeOutcome, {
      failureClass: command.outcome === "error" ? "verifier_infrastructure" : "product_verification",
    });
    if (selected === null) {
      events.push({ type: "RunConcluded", status: "needs_attention" });
      return this.commitExisting(command, commandId, requestFingerprint, events, {
        status: "needs_attention",
      });
    }
    events.push({
      type: "RouteSelected",
      routeId: selected.route.routeId,
      fromStepId: selected.route.fromStepId,
      toStepId: selected.route.toStepId,
      outcome: routeOutcome,
    });
    if (selected.loop !== null) {
      const target = workflow.steps.find(({ stepId }) => stepId === selected.loop?.toStepId);
      if (target === undefined) throw new Error("LOOP_TARGET_STEP_MISSING");
      const nextIteration = state.budgetUsage.loopIterations + 1;
      const repeatedFailureCount = command.failureFingerprint === undefined
        ? state.budgetUsage.repeatedFailureFingerprintCount
        : command.failureFingerprint === state.budgetUsage.lastFailureFingerprint
          ? state.budgetUsage.repeatedFailureFingerprintCount + 1
          : 1;
      const noDiffCount = command.diffFingerprint === undefined ? state.budgetUsage.noDiffCount + 1 : 0;
      const verifierErrorCount = command.outcome === "error" ? state.budgetUsage.verifierErrorCount + 1 : 0;
      const exhausted =
        nextIteration > selected.loop.maxIterations ||
        nextIteration > state.binding.initialBudget.maxLoopIterations ||
        state.budgetUsage.elapsedMs + target.budgetCost.elapsedMs > selected.loop.maxElapsedMs ||
        (selected.loop.maxCost !== undefined && state.budgetUsage.cost + target.budgetCost.cost > selected.loop.maxCost) ||
        repeatedFailureCount > selected.loop.stagnation.maxSameFailureFingerprint ||
        noDiffCount > selected.loop.stagnation.maxNoDiffIterations ||
        verifierErrorCount > selected.loop.stagnation.maxVerifierErrors ||
        !this.budgetAvailable(state, target);
      if (exhausted) {
        events.push({ type: "StepConcluded", stepRunId: step.stepRunId, conclusion: "failed" });
        events.push({ type: "RunConcluded", status: selected.loop.exhaustion.target === "failed" ? "failed" : "needs_attention" });
      } else {
        const targetState = state.steps.find(({ stepId }) => stepId === target.stepId);
        const attemptNumber = (targetState?.attempts.length ?? 0) + 1;
        const stepRunId = StepRunIdSchema.parse(
          targetState?.stepRunId ?? derivedId("spr", `${state.binding.runId}:${target.stepId}`),
        );
        const attemptId = AttemptIdSchema.parse(
          derivedId("att", `${state.binding.runId}:${target.stepId}:${attemptNumber}`),
        );
        events.push({ type: "LoopActivated", loopId: selected.loop.loopId, iteration: nextIteration });
        events.push({
          type: "BudgetConsumed",
          attempts: 1,
          elapsedMs: target.budgetCost.elapsedMs,
          cost: target.budgetCost.cost,
          tokens: 0,
          loopIterations: 1,
          progressFingerprint: command.diffFingerprint ?? null,
          failureFingerprint: command.failureFingerprint ?? null,
          noDiff: command.diffFingerprint === undefined,
          verifierError: command.outcome === "error",
        });
        events.push({
          type: "StepActivated",
          stepRunId,
          stepId: target.stepId,
          attemptId,
          attemptNumber,
          fixedContentHash: canonicalSha256({
            bindingFingerprint: state.binding.bindingFingerprint,
            stepId: target.stepId,
          }),
        });
      }
      return this.commitExisting(command, commandId, requestFingerprint, events, {
        loopIteration: nextIteration,
      });
    }

    events.push({
      type: "StepConcluded",
      stepRunId: step.stepRunId,
      conclusion: command.outcome === "passed" ? "succeeded" : "failed",
    });
    if (selected.route.toStepId === null) {
      const outstandingChildren = state.binding.subjectKind === "change" && (state.scheduledChildren.some(({ childRunId }) => !state.acceptedChildRunIds.includes(childRunId)) || this.store.childRuns(command.runId).some((child) => !isTerminalRun(child.status)));
      events.push(outstandingChildren && command.outcome === "passed"
        ? { type: "RunStatusChanged", status: "paused" }
        : { type: "RunConcluded", status: command.outcome === "passed" ? "succeeded" : "failed" });
    } else {
      const target = workflow.steps.find(({ stepId }) => stepId === selected.route.toStepId);
      if (target === undefined) throw new Error("ROUTE_TARGET_STEP_MISSING");
      if (!this.budgetAvailable(state, target)) {
        events.push({ type: "RunConcluded", status: "needs_attention" });
      } else {
        const stepRunId = StepRunIdSchema.parse(derivedId("spr", `${state.binding.runId}:${target.stepId}`));
        const attemptId = AttemptIdSchema.parse(derivedId("att", `${state.binding.runId}:${target.stepId}:1`));
        events.push({
          type: "BudgetConsumed",
          attempts: 1,
          elapsedMs: target.budgetCost.elapsedMs,
          cost: target.budgetCost.cost,
          tokens: 0,
          loopIterations: 0,
          progressFingerprint: null,
          failureFingerprint: null,
          noDiff: false,
          verifierError: false,
        });
        events.push({
          type: "StepActivated",
          stepRunId,
          stepId: target.stepId,
          attemptId,
          attemptNumber: 1,
          fixedContentHash: canonicalSha256({
            bindingFingerprint: state.binding.bindingFingerprint,
            stepId: target.stepId,
          }),
        });
      }
    }
    return this.commitExisting(command, commandId, requestFingerprint, events, {
      outcome: command.outcome,
    });
  }

  private commitExisting(
    command: ExistingRunCommand,
    commandId: string,
    requestFingerprint: string,
    events: readonly FlowEvent[],
    response: unknown,
    operations: readonly ExternalOperation[] = [],
  ) {
    return this.store.commit({
      commandId,
      requestFingerprint,
      runId: command.runId,
      expectedVersion: command.expectedVersion,
      events,
      response,
      operations,
    });
  }

  private requireActiveRun(runId: RunId): WorkflowRunState {
    const state = this.store.loadRun(runId);
    if (state === null) throw new Error("RUN_NOT_FOUND");
    if (isTerminalRun(state.status)) throw new Error("RUN_TERMINAL");
    return state;
  }

  private requireWorkflow(id: string): Readonly<WorkflowRevision> {
    const workflow = this.definitions.getWorkflowRevision(id);
    if (workflow === null) throw new Error("WORKFLOW_REVISION_NOT_FOUND");
    return workflow;
  }

  private requirePlan(id: string): Readonly<ExecutionPlan> {
    const plan = this.definitions.getExecutionPlan(id);
    if (plan === null) throw new Error("EXECUTION_PLAN_NOT_FOUND");
    return plan;
  }

  private parentTerminal(runId: RunId): boolean {
    const parent = this.store.loadRun(runId);
    return parent === null || isTerminalRun(parent.status);
  }

  private budgetAvailable(state: WorkflowRunState, step: WorkflowRevision["steps"][number]): boolean {
    return (
      state.budgetUsage.attempts + 1 <= state.binding.initialBudget.maxAttempts &&
      state.budgetUsage.elapsedMs + step.budgetCost.elapsedMs <= state.binding.initialBudget.maxElapsedMs &&
      state.budgetUsage.cost + step.budgetCost.cost <= state.binding.initialBudget.maxCost
      && state.budgetUsage.tokens <= state.binding.initialBudget.maxTokens
    );
  }

  private assertBudgetAvailable(
    state: WorkflowRunState | null,
    limit: WorkflowRunState["binding"]["initialBudget"],
    step: WorkflowRevision["steps"][number],
    loopIterations: number,
  ): void {
    const usage = state?.budgetUsage;
    if (
      (usage?.attempts ?? 0) + 1 > limit.maxAttempts ||
      (usage?.elapsedMs ?? 0) + step.budgetCost.elapsedMs > limit.maxElapsedMs ||
      (usage?.cost ?? 0) + step.budgetCost.cost > limit.maxCost ||
      loopIterations > limit.maxLoopIterations
    ) {
      throw new Error("RUN_BUDGET_EXHAUSTED");
    }
  }
}
