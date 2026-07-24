import {
  AgentProfileIdSchema,
  LoopIdSchema,
  RouteIdSchema,
  StepIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
} from "./ids.js";

const workflowId = WorkflowIdSchema.parse("wfl_workflow0001");
const workflowRevisionId = WorkflowRevisionIdSchema.parse("wfr_workflow02");
const agentProfileId = AgentProfileIdSchema.parse("apr_profile01");

const stepIds = {
  implement: StepIdSchema.parse("stp_implement01"),
  test: StepIdSchema.parse("stp_test00001"),
  subflow: StepIdSchema.parse("stp_subflow001"),
  gate: StepIdSchema.parse("stp_gate000001"),
};

function policies() {
  return {
    inputContract: { schemaId: "hunter.step.input", version: 1 },
    outputContract: { schemaId: "hunter.step.output", version: 1 },
    requiredCapabilities: ["observe" as const],
    permissionPolicy: { decision: "allow" as const, permissions: ["repository.read"] },
    verifier: {
      kind: "automated" as const,
      verifierId: "verifier.schema",
      outputContract: { schemaId: "hunter.step.output", version: 1 },
    },
    retryPolicy: {
      maxAttempts: 2,
      retryableErrorClasses: ["transient"],
      backoff: {
        kind: "exponential" as const,
        initialDelayMs: 10,
        maxDelayMs: 100,
        multiplier: 2,
      },
      jitter: "none" as const,
      waitingBudgetCost: 1,
    },
    timeoutPolicy: { timeoutMs: 5_000, onTimeout: "failed" as const },
    budgetCost: { units: 1, elapsedMs: 5_000, cost: 0 },
    sessionPolicy: "new" as const,
    workspacePolicy: { mode: "write" as const, isolation: "worktree" as const, reuse: false },
  };
}

export function validWorkflowInput() {
  const base = policies();
  return {
    workflowId,
    workflowRevisionId,
    title: "Default development workflow",
    status: "published" as const,
    entryStepId: stepIds.implement,
    steps: [
      {
        ...base,
        stepId: stepIds.implement,
        kind: "agent" as const,
        executor: { kind: "runtime_agent" as const, selector: "capability_match" },
        agentProfileSelector: { strategy: "fixed" as const, agentProfileIds: [agentProfileId] },
        requiredCapabilities: ["launch" as const, "send" as const, "observe" as const],
      },
      {
        ...base,
        stepId: stepIds.test,
        kind: "verify" as const,
        executor: { kind: "verifier" as const, selector: "project-test" },
        workspacePolicy: { mode: "read" as const, isolation: "shared_snapshot" as const, reuse: true },
      },
      {
        ...base,
        stepId: stepIds.subflow,
        kind: "subflow" as const,
        executor: { kind: "subflow" as const, selector: "review-workflow" },
        workspacePolicy: { mode: "read" as const, isolation: "shared_snapshot" as const, reuse: true },
      },
      {
        ...base,
        stepId: stepIds.gate,
        kind: "human_gate" as const,
        executor: { kind: "human" as const, selector: "project-approver" },
        permissionPolicy: { decision: "require_approval" as const, permissions: ["change.accept"] },
        verifier: { kind: "human_receipt" as const, requiredRole: "project-approver" },
        sessionPolicy: "manual" as const,
        workspacePolicy: { mode: "read" as const, isolation: "shared_snapshot" as const, reuse: true },
      },
    ],
    routes: [
      route("rte_impl_pass01", stepIds.implement, "passed", 0, stepIds.test),
      route("rte_impl_fail01", stepIds.implement, "failed", 0, null),
      route("rte_test_pass01", stepIds.test, "passed", 0, stepIds.subflow),
      {
        ...route("rte_test_error1", stepIds.test, "failed", 10, null),
        condition: { kind: "equals" as const, fact: "failureClass", value: "verifier_infrastructure" },
      },
      route("rte_test_retry1", stepIds.test, "failed", 0, stepIds.implement),
      route("rte_test_cancel", stepIds.test, "canceled", 0, null),
      route("rte_test_timeout", stepIds.test, "timed_out", 0, null),
      route("rte_sub_pass001", stepIds.subflow, "passed", 0, stepIds.gate),
      route("rte_sub_fail001", stepIds.subflow, "failed", 0, null),
      route("rte_gate_pass01", stepIds.gate, "passed", 0, null),
      route("rte_gate_reject", stepIds.gate, "rejected", 0, null),
    ],
    loops: [
      {
        loopId: LoopIdSchema.parse("lop_testloop01"),
        routeId: RouteIdSchema.parse("rte_test_retry1"),
        fromStepId: stepIds.test,
        toStepId: stepIds.implement,
        maxIterations: 3,
        maxElapsedMs: 30_000,
        maxCost: 10,
        progressPredicate: { kind: "diff_present" as const, source: "workspace.diff" },
        stagnation: {
          maxSameFailureFingerprint: 2,
          maxNoDiffIterations: 1,
          maxVerifierErrors: 1,
        },
        reuse: { profile: true, session: false, workspace: true },
        exhaustion: { target: "needs_attention" as const, notify: true },
      },
    ],
    publishedAt: "2026-07-22T00:00:00.000Z",
  };
}

function route(
  routeId: string,
  fromStepId: (typeof stepIds)[keyof typeof stepIds],
  outcome: "passed" | "failed" | "canceled" | "timed_out" | "rejected",
  priority: number,
  toStepId: (typeof stepIds)[keyof typeof stepIds] | null,
) {
  return {
    routeId: RouteIdSchema.parse(routeId),
    fromStepId,
    outcome,
    priority,
    toStepId,
  };
}

export { stepIds };
