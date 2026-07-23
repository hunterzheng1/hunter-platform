import {
  ExecutionPlanSchema,
  RunIdSchema,
  TaskIdSchema,
  canonicalSha256,
  deepFreeze,
  type ExecutionPlan,
  type RunId,
  type TaskId,
} from "@hunter/domain";
import {
  RunBudgetLimitSchema,
  createWorkflowRunBinding,
  deriveChildRunId,
  isTerminalRun,
  MAX_EXECUTION_PLAN_TASKS,
  type FlowActorContext,
  type FlowCommandHandler,
  type FlowDefinitions,
  type FlowStore,
  type WorkflowRunBinding,
  type WorkflowRunState,
} from "@hunter/flow-engine";
import { z } from "zod";

const ActorSchema = z
  .object({
    actorId: z.string().trim().min(1).max(256),
    correlationId: z.string().trim().min(1).max(256),
    causationId: z.string().trim().min(1).max(256).optional(),
    roles: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  })
  .strict();

const DispatchInputSchema = z
  .object({
    parentRunId: RunIdSchema,
    expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: z.string().trim().min(1).max(256),
    actor: ActorSchema,
  })
  .strict();

const ScheduledChildSchema = z
  .object({
    taskId: TaskIdSchema,
    childRunId: RunIdSchema,
    budget: RunBudgetLimitSchema,
  })
  .strict();

const FanOutReceiptSchema = z
  .object({
    commandId: z.string().trim().min(1).max(512),
    response: z
      .object({
        children: z.array(ScheduledChildSchema).max(MAX_EXECUTION_PLAN_TASKS),
      })
      .strict(),
  })
  .strict();

const StartRunReceiptSchema = z
  .object({
    commandId: z.string().trim().min(1).max(512),
    response: z
      .object({
        runId: RunIdSchema,
        bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict();

export interface RunCoordinatorPorts {
  readonly store: Pick<FlowStore, "loadRun" | "activeTaskIds">;
  readonly definitions: Pick<FlowDefinitions, "getExecutionPlan">;
  readonly commands: FlowCommandHandler;
}

export interface RunCoordinatorDispatch {
  readonly parentRunId: RunId;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: FlowActorContext;
}

function parseDispatch(input: unknown): z.infer<typeof DispatchInputSchema> {
  try {
    return DispatchInputSchema.parse(input);
  } catch {
    throw new Error("RUN_COORDINATOR_INPUT_INVALID");
  }
}

function parsePlan(input: unknown): Readonly<ExecutionPlan> {
  try {
    return deepFreeze(ExecutionPlanSchema.parse(input));
  } catch {
    throw new Error("RUN_COORDINATOR_PLAN_INVALID");
  }
}

function parseFanOutReceipt(input: unknown) {
  try {
    return FanOutReceiptSchema.parse(input);
  } catch {
    throw new Error("TASK_FANOUT_RECEIPT_INVALID");
  }
}

function parseStartRunReceipt(input: unknown) {
  try {
    return StartRunReceiptSchema.parse(input);
  } catch {
    throw new Error("CHILD_START_RECEIPT_INVALID");
  }
}

function requireParent(
  store: Pick<FlowStore, "loadRun">,
  parentRunId: RunId,
): WorkflowRunState & {
  readonly binding: Extract<WorkflowRunBinding, { readonly subjectKind: "change" }>;
} {
  const parent = store.loadRun(parentRunId);
  if (parent === null) throw new Error("PARENT_RUN_NOT_FOUND");
  if (parent.binding.subjectKind !== "change") {
    throw new Error("TASK_DISPATCH_REQUIRES_ROOT_RUN");
  }
  return parent as WorkflowRunState & {
    readonly binding: Extract<WorkflowRunBinding, { readonly subjectKind: "change" }>;
  };
}

export class RunCoordinator {
  public constructor(private readonly ports: RunCoordinatorPorts) {}

  public dispatch(input: RunCoordinatorDispatch) {
    const command = parseDispatch(input);
    const parent = requireParent(this.ports.store, command.parentRunId);
    const plan = parsePlan(
      this.ports.definitions.getExecutionPlan(parent.binding.executionPlanId),
    );
    if (
      plan.executionPlanId !== parent.binding.executionPlanId ||
      plan.projectId !== parent.binding.projectId ||
      plan.changeRevisionId !== parent.binding.changeRevisionId ||
      canonicalSha256([...plan.requirementRevisionIds].sort()) !==
        canonicalSha256([...parent.binding.requirementRevisionIds].sort()) ||
      plan.taskGraphFingerprint !== parent.binding.taskGraphFingerprint
    ) {
      throw new Error("PARENT_EXECUTION_PLAN_MISMATCH");
    }

    const fanOutKey = `coordinate-fanout:${command.idempotencyKey}`;
    const rawReceipt = this.ports.commands.handle({
      type: "ScheduleTaskFanOut",
      runId: parent.binding.runId,
      expectedVersion: command.expectedVersion,
      idempotencyKey: fanOutKey,
      actor: command.actor,
    });
    const fanOut = parseFanOutReceipt(rawReceipt);
    if (fanOut.commandId !== `ScheduleTaskFanOut:${fanOutKey}`) {
      throw new Error("TASK_FANOUT_RECEIPT_IDENTITY_MISMATCH");
    }

    const uniqueTasks = new Set<TaskId>();
    const uniqueRuns = new Set<RunId>();
    const scheduled = [...fanOut.response.children].sort((left, right) =>
      left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
    );
    const started = [];
    for (const child of scheduled) {
      if (uniqueTasks.has(child.taskId) || uniqueRuns.has(child.childRunId)) {
        throw new Error("TASK_FANOUT_RECEIPT_DUPLICATE_CHILD");
      }
      uniqueTasks.add(child.taskId);
      uniqueRuns.add(child.childRunId);
      if (deriveChildRunId(parent.binding.runId, child.taskId) !== child.childRunId) {
        throw new Error("TASK_FANOUT_CHILD_ID_MISMATCH");
      }
      const task = plan.tasks.find(({ taskId }) => taskId === child.taskId);
      if (task === undefined) throw new Error("TASK_FANOUT_TASK_NOT_IN_PLAN");
      const existing = this.ports.store.loadRun(child.childRunId);
      if (
        existing !== null &&
        (existing.binding.subjectKind !== "task" ||
          existing.binding.parentRunId !== parent.binding.runId ||
          existing.binding.taskId !== child.taskId)
      ) {
        throw new Error("EXISTING_CHILD_RUN_SCOPE_MISMATCH");
      }
      const validatedBinding = createWorkflowRunBinding(
        existing?.binding ?? {
          runId: child.childRunId,
          projectId: parent.binding.projectId,
          changeRevisionId: parent.binding.changeRevisionId,
          requirementRevisionIds: parent.binding.requirementRevisionIds,
          workflowRevisionId: task.workflowRevisionId,
          policySnapshot: parent.binding.policySnapshot,
          initialBudget: child.budget,
          subjectKind: "task",
          parentRunId: parent.binding.runId,
          taskId: task.taskId,
          executionPlanId: parent.binding.executionPlanId,
        },
        {
          parent: parent.binding,
          executionPlan: plan,
          activeTaskIds: this.ports.store
            .activeTaskIds(parent.binding.runId)
            .filter((taskId) => taskId !== child.taskId),
          parentTerminal: existing === null && isTerminalRun(parent.status),
          childBudgetAllocation: child.budget,
        },
      );
      if (
        existing !== null &&
        existing.binding.bindingFingerprint !== validatedBinding.bindingFingerprint
      ) {
        throw new Error("EXISTING_CHILD_RUN_BINDING_MISMATCH");
      }
      const binding = existing?.binding ?? validatedBinding;
      const startKey = `coordinate-child:${child.childRunId}`;
      const rawStartReceipt = this.ports.commands.handle({
        type: "StartRun",
        binding,
        expectedVersion: 0,
        idempotencyKey: startKey,
        actor: command.actor,
      });
      const receipt = parseStartRunReceipt(rawStartReceipt);
      if (receipt.commandId !== `StartRun:${startKey}`) {
        throw new Error("CHILD_START_RECEIPT_IDENTITY_MISMATCH");
      }
      if (
        receipt.response.runId !== child.childRunId ||
        receipt.response.bindingFingerprint !== binding.bindingFingerprint
      ) {
        throw new Error("CHILD_START_RECEIPT_SCOPE_MISMATCH");
      }
      started.push({
        taskId: child.taskId,
        childRunId: child.childRunId,
        startCommandId: receipt.commandId,
      });
    }
    return deepFreeze({
      fanOutCommandId: fanOut.commandId,
      children: started,
    });
  }
}
