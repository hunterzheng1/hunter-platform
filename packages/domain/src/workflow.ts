import { z } from "zod";

import {
  AgentProfileIdSchema,
  LoopIdSchema,
  RouteIdSchema,
  StepIdSchema,
  WorkflowRevisionIdSchema,
} from "./ids.js";
import type { LoopId, RouteId, StepId, WorkflowRevisionId } from "./ids.js";
import {
  assertUnique,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  deepFreeze,
} from "./immutable.js";
import { SessionPolicySchema, WorkspacePolicySchema } from "./task.js";
import type { SessionPolicy, WorkspacePolicy } from "./task.js";

export const StepKindSchema = z.enum(["agent", "command", "verify", "human_gate", "context", "subflow"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const RouteOutcomeSchema = z.enum(["passed", "failed", "canceled", "timed_out", "rejected"]);
export type RouteOutcome = z.infer<typeof RouteOutcomeSchema>;

export const AtomicCapabilitySchema = z.enum([
  "discover",
  "workspace_prepare",
  "workspace_isolation",
  "workspace_targeting",
  "launch",
  "attach",
  "observe",
  "send",
  "interrupt",
  "resume",
  "steer",
  "structured_events",
  "permission_events",
  "completion_receipt",
  "artifact_export",
  "native_surface",
  "headless",
  "mobile_control",
]);
export type AtomicCapability = z.infer<typeof AtomicCapabilitySchema>;

export const SchemaRefSchema = z
  .object({ schemaId: z.string().trim().min(1), version: z.number().int().positive() })
  .strict();
export type SchemaRef = z.infer<typeof SchemaRefSchema>;

export const ExecutorSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtime_agent"), selector: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("command"), selector: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("verifier"), selector: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("human"), selector: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("context"), selector: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("subflow"), selector: z.string().trim().min(1) }).strict(),
]);
export type ExecutorSelector = z.infer<typeof ExecutorSelectorSchema>;

export const AgentProfileSelectorSchema = z
  .object({
    strategy: z.enum(["fixed", "first_available"]),
    agentProfileIds: z.array(AgentProfileIdSchema).min(1),
  })
  .strict();
export type AgentProfileSelector = z.infer<typeof AgentProfileSelectorSchema>;

export const StepPermissionPolicySchema = z
  .object({
    decision: z.enum(["allow", "deny", "require_approval"]),
    permissions: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
export type StepPermissionPolicy = z.infer<typeof StepPermissionPolicySchema>;

export const VerifierDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("automated"),
      verifierId: z.string().trim().min(1),
      outputContract: SchemaRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("human_receipt"),
      requiredRole: z.string().trim().min(1),
    })
    .strict(),
]);
export type VerifierDefinition = z.infer<typeof VerifierDefinitionSchema>;

const FixedBackoffSchema = z
  .object({
    kind: z.literal("fixed"),
    initialDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
  })
  .strict();

const ExponentialBackoffSchema = z
  .object({
    kind: z.literal("exponential"),
    initialDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
    multiplier: z.number().gt(1),
  })
  .strict();

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive(),
    retryableErrorClasses: z.array(z.string().trim().min(1)),
    backoff: z.discriminatedUnion("kind", [FixedBackoffSchema, ExponentialBackoffSchema]),
    jitter: z.enum(["none", "full"]),
    waitingBudgetCost: z.number().int().positive(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.backoff.initialDelayMs > policy.backoff.maxDelayMs) {
      context.addIssue({ code: "custom", message: "RETRY_BACKOFF_BOUNDS_INVALID" });
    }
    if (
      policy.backoff.kind === "fixed" &&
      policy.backoff.initialDelayMs !== policy.backoff.maxDelayMs
    ) {
      context.addIssue({ code: "custom", message: "FIXED_BACKOFF_DELAY_MISMATCH" });
    }
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const TimeoutPolicySchema = z
  .object({
    timeoutMs: z.number().int().positive(),
    onTimeout: z.enum(["failed", "canceled", "needs_attention"]),
  })
  .strict();
export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;

export const BudgetCostSchema = z
  .object({
    units: z.number().int().positive(),
    elapsedMs: z.number().int().positive(),
    cost: z.number().nonnegative(),
  })
  .strict();
export type BudgetCost = z.infer<typeof BudgetCostSchema>;

export interface WorkflowStep {
  readonly stepId: StepId;
  readonly kind: StepKind;
  readonly inputContract: SchemaRef;
  readonly outputContract: SchemaRef;
  readonly executor: ExecutorSelector;
  readonly agentProfileSelector?: AgentProfileSelector | undefined;
  readonly requiredCapabilities: readonly AtomicCapability[];
  readonly permissionPolicy: StepPermissionPolicy;
  readonly verifier: VerifierDefinition;
  readonly retryPolicy: RetryPolicy;
  readonly timeoutPolicy: TimeoutPolicy;
  readonly budgetCost: BudgetCost;
  readonly sessionPolicy: SessionPolicy;
  readonly workspacePolicy: WorkspacePolicy;
}

export const WorkflowStepSchema = z
  .object({
    stepId: StepIdSchema,
    kind: StepKindSchema,
    inputContract: SchemaRefSchema,
    outputContract: SchemaRefSchema,
    executor: ExecutorSelectorSchema,
    agentProfileSelector: AgentProfileSelectorSchema.optional(),
    requiredCapabilities: z.array(AtomicCapabilitySchema),
    permissionPolicy: StepPermissionPolicySchema,
    verifier: VerifierDefinitionSchema,
    retryPolicy: RetryPolicySchema,
    timeoutPolicy: TimeoutPolicySchema,
    budgetCost: BudgetCostSchema,
    sessionPolicy: SessionPolicySchema,
    workspacePolicy: WorkspacePolicySchema,
  })
  .strict();

export const ConditionExpressionSchema = z
  .object({
    kind: z.literal("equals"),
    fact: z.string().trim().min(1),
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
  })
  .strict();
export type ConditionExpression = z.infer<typeof ConditionExpressionSchema>;

export interface RouteDefinition {
  readonly routeId: RouteId;
  readonly fromStepId: StepId;
  readonly outcome: RouteOutcome;
  readonly priority: number;
  readonly condition?: ConditionExpression | undefined;
  readonly toStepId: StepId | null;
}

export const RouteDefinitionSchema = z
  .object({
    routeId: RouteIdSchema,
    fromStepId: StepIdSchema,
    outcome: RouteOutcomeSchema,
    priority: z.number().int().nonnegative(),
    condition: ConditionExpressionSchema.optional(),
    toStepId: StepIdSchema.nullable(),
  })
  .strict();

export const ProgressPredicateSchema = z
  .object({
    kind: z.enum(["fingerprint_changed", "diff_present", "verifier_improved"]),
    source: z.string().trim().min(1),
  })
  .strict();
export type ProgressPredicate = z.infer<typeof ProgressPredicateSchema>;

export interface LoopPolicy {
  readonly loopId: LoopId;
  readonly routeId: RouteId;
  readonly fromStepId: StepId;
  readonly toStepId: StepId;
  readonly maxIterations: number;
  readonly maxElapsedMs: number;
  readonly maxCost?: number | undefined;
  readonly progressPredicate: ProgressPredicate;
  readonly stagnation: {
    readonly maxSameFailureFingerprint: number;
    readonly maxNoDiffIterations: number;
    readonly maxVerifierErrors: number;
  };
  readonly reuse: { readonly profile: boolean; readonly session: boolean; readonly workspace: boolean };
  readonly exhaustion: { readonly target: "paused" | "failed" | "needs_attention"; readonly notify: boolean };
}

export const LoopPolicySchema = z
  .object({
    loopId: LoopIdSchema,
    routeId: RouteIdSchema,
    fromStepId: StepIdSchema,
    toStepId: StepIdSchema,
    maxIterations: z.number().int().positive(),
    maxElapsedMs: z.number().int().positive(),
    maxCost: z.number().positive().optional(),
    progressPredicate: ProgressPredicateSchema,
    stagnation: z
      .object({
        maxSameFailureFingerprint: z.number().int().positive(),
        maxNoDiffIterations: z.number().int().positive(),
        maxVerifierErrors: z.number().int().positive(),
      })
      .strict(),
    reuse: z.object({ profile: z.boolean(), session: z.boolean(), workspace: z.boolean() }).strict(),
    exhaustion: z
      .object({
        target: z.enum(["paused", "failed", "needs_attention"]),
        notify: z.boolean(),
      })
      .strict(),
  })
  .strict();

export interface WorkflowRevision {
  readonly workflowRevisionId: WorkflowRevisionId;
  readonly title: string;
  readonly status: "published";
  readonly entryStepId: StepId;
  readonly steps: readonly WorkflowStep[];
  readonly routes: readonly RouteDefinition[];
  readonly loops: readonly LoopPolicy[];
  readonly workflowFingerprint: string;
  readonly publishedAt: string;
}

const WorkflowRevisionInputSchema = z
  .object({
    workflowRevisionId: WorkflowRevisionIdSchema,
    title: z.string().trim().min(1),
    status: z.literal("published"),
    entryStepId: StepIdSchema,
    steps: z.array(WorkflowStepSchema).min(1),
    routes: z.array(RouteDefinitionSchema),
    loops: z.array(LoopPolicySchema),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const EXPECTED_EXECUTOR: Readonly<Record<StepKind, ExecutorSelector["kind"]>> = {
  agent: "runtime_agent",
  command: "command",
  verify: "verifier",
  human_gate: "human",
  context: "context",
  subflow: "subflow",
};

function validateStep(step: WorkflowStep): void {
  assertUnique(step.requiredCapabilities, "step_capability");
  assertUnique(step.permissionPolicy.permissions, "step_permission");
  assertUnique(step.retryPolicy.retryableErrorClasses, "retryable_error_class");
  if (step.executor.kind !== EXPECTED_EXECUTOR[step.kind]) {
    throw new Error("STEP_EXECUTOR_INCOMPATIBLE");
  }
  if (step.kind === "agent" && step.agentProfileSelector === undefined) {
    throw new Error("AGENT_STEP_REQUIRES_AGENT_PROFILE_SELECTOR");
  }
  if (step.kind !== "agent" && step.agentProfileSelector !== undefined) {
    throw new Error("NON_AGENT_STEP_CANNOT_OVERRIDE_AGENT_PROFILE");
  }
  if (step.agentProfileSelector !== undefined) {
    assertUnique(step.agentProfileSelector.agentProfileIds, "agent_profile_selector");
  }
  if (step.kind === "human_gate" && step.verifier.kind !== "human_receipt") {
    throw new Error("HUMAN_GATE_REQUIRES_HUMAN_RECEIPT");
  }
  if (step.kind !== "human_gate" && step.verifier.kind === "human_receipt") {
    throw new Error("HUMAN_RECEIPT_ONLY_VALID_FOR_HUMAN_GATE");
  }
}

function validateRoutesAreDeterministic(routes: readonly RouteDefinition[]): void {
  const groups = new Map<string, RouteDefinition[]>();
  for (const route of routes) {
    const key = `${route.fromStepId}:${route.outcome}`;
    const group = groups.get(key) ?? [];
    group.push(route);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const priorities = group.map(({ priority }) => String(priority));
    if (new Set(priorities).size !== priorities.length) throw new Error("AMBIGUOUS_ROUTE_PRIORITY");
    if (group.filter(({ condition }) => condition === undefined).length !== 1) {
      throw new Error("DETERMINISTIC_ROUTE_DEFAULT_REQUIRED");
    }
    const conditions = group
      .filter(({ condition }) => condition !== undefined)
      .map(({ condition }) => canonicalJson(condition));
    if (new Set(conditions).size !== conditions.length) throw new Error("AMBIGUOUS_ROUTE_CONDITION");
  }
}

function assertAcyclic(
  stepIds: readonly StepId[],
  routes: readonly RouteDefinition[],
  loopRouteIds: ReadonlySet<RouteId>,
): void {
  const adjacency = new Map<StepId, StepId[]>(stepIds.map((stepId) => [stepId, []]));
  for (const route of routes) {
    if (!loopRouteIds.has(route.routeId) && route.toStepId !== null) {
      adjacency.get(route.fromStepId)?.push(route.toStepId);
    }
  }
  const visiting = new Set<StepId>();
  const visited = new Set<StepId>();
  const visit = (stepId: StepId): void => {
    if (visiting.has(stepId)) throw new Error("UNDECLARED_WORKFLOW_CYCLE");
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const next of adjacency.get(stepId) ?? []) visit(next);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const stepId of stepIds) visit(stepId);
}

function assertReachable(entryStepId: StepId, stepIds: readonly StepId[], routes: readonly RouteDefinition[]): void {
  const reachable = new Set<StepId>();
  const queue: StepId[] = [entryStepId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    for (const route of routes) {
      if (route.fromStepId === current && route.toStepId !== null) queue.push(route.toStepId);
    }
  }
  if (stepIds.some((stepId) => !reachable.has(stepId))) throw new Error("UNREACHABLE_WORKFLOW_STEP");
}

function canonicalStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    agentProfileSelector:
      step.agentProfileSelector === undefined
        ? undefined
        : {
            ...step.agentProfileSelector,
            agentProfileIds: [...step.agentProfileSelector.agentProfileIds].sort(),
          },
    requiredCapabilities: [...step.requiredCapabilities].sort(),
    permissionPolicy: {
      ...step.permissionPolicy,
      permissions: [...step.permissionPolicy.permissions].sort(),
    },
    retryPolicy: {
      ...step.retryPolicy,
      retryableErrorClasses: [...step.retryPolicy.retryableErrorClasses].sort(),
      backoff: { ...step.retryPolicy.backoff },
    },
    inputContract: { ...step.inputContract },
    outputContract: { ...step.outputContract },
    executor: { ...step.executor },
    verifier: { ...step.verifier },
    timeoutPolicy: { ...step.timeoutPolicy },
    budgetCost: { ...step.budgetCost },
    workspacePolicy: { ...step.workspacePolicy },
  };
}

export function createWorkflowRevision(input: unknown): Readonly<WorkflowRevision> {
  const parsed = WorkflowRevisionInputSchema.parse(input);
  const stepIds = parsed.steps.map(({ stepId }) => stepId);
  const routeIds = parsed.routes.map(({ routeId }) => routeId);
  const loopIds = parsed.loops.map(({ loopId }) => loopId);
  assertUnique(stepIds, "workflow_step_id");
  assertUnique(routeIds, "workflow_route_id");
  assertUnique(loopIds, "workflow_loop_id");

  const knownSteps = new Set(stepIds);
  if (!knownSteps.has(parsed.entryStepId)) throw new Error("WORKFLOW_ENTRY_STEP_MISSING");
  for (const route of parsed.routes) {
    if (!knownSteps.has(route.fromStepId) || (route.toStepId !== null && !knownSteps.has(route.toStepId))) {
      throw new Error("WORKFLOW_ROUTE_ENDPOINT_MISSING");
    }
  }

  const routesById = new Map(parsed.routes.map((route) => [route.routeId, route]));
  const loopRouteIds = parsed.loops.map(({ routeId }) => routeId);
  assertUnique(loopRouteIds, "loop_route");
  for (const loop of parsed.loops) {
    const route = routesById.get(loop.routeId);
    if (
      route === undefined ||
      route.toStepId === null ||
      route.fromStepId !== loop.fromStepId ||
      route.toStepId !== loop.toStepId
    ) {
      throw new Error("LOOP_ROUTE_ENDPOINT_MISMATCH");
    }
  }

  const loopRoutes = new Set(loopRouteIds);
  assertAcyclic(stepIds, parsed.routes, loopRoutes);
  assertReachable(parsed.entryStepId, stepIds, parsed.routes);
  validateRoutesAreDeterministic(parsed.routes);
  for (const step of parsed.steps) validateStep(step);

  const steps = parsed.steps
    .map(canonicalStep)
    .sort((left, right) => compareCanonicalText(left.stepId, right.stepId));
  const routes = [...parsed.routes].sort((left, right) => compareCanonicalText(left.routeId, right.routeId));
  const loops = [...parsed.loops].sort((left, right) => compareCanonicalText(left.loopId, right.loopId));
  const common = {
    workflowRevisionId: parsed.workflowRevisionId,
    title: parsed.title,
    status: parsed.status,
    entryStepId: parsed.entryStepId,
    steps,
    routes,
    loops,
  };
  const workflowFingerprint = canonicalSha256({ ...common, publishedAt: parsed.publishedAt });
  return deepFreeze({ ...common, workflowFingerprint, publishedAt: parsed.publishedAt });
}
