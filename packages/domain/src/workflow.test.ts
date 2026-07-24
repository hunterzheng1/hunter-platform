import { describe, expect, it } from "vitest";

import { WorkflowIdSchema } from "./ids.js";
import { LoopIdSchema, RouteIdSchema, StepIdSchema, createWorkflowRevision } from "./index.js";
import { stepIds, validWorkflowInput } from "./workflow-test-fixtures.js";

describe("WorkflowRevision", () => {
  it("binds every published revision to a stable Workflow identity", () => {
    const workflowId = WorkflowIdSchema.parse("wfl_workflow0001");

    expect(createWorkflowRevision({
      ...validWorkflowInput(),
      workflowId,
    }).workflowId).toBe(workflowId);
  });

  it("freezes an executable graph covering gate, timeout, cancel, verifier error, terminal, subflow, and a declared Loop", () => {
    const workflow = createWorkflowRevision(validWorkflowInput());

    expect(workflow.workflowFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(workflow)).toBe(true);
    expect(Object.isFrozen(workflow.steps)).toBe(true);
    expect(Object.isFrozen(workflow.steps[0]?.retryPolicy.backoff)).toBe(true);
    expect(workflow.routes.some(({ outcome }) => outcome === "timed_out")).toBe(true);
    expect(workflow.routes.some(({ outcome }) => outcome === "canceled")).toBe(true);
    expect(workflow.routes.some(({ outcome }) => outcome === "rejected")).toBe(true);
    expect(workflow.steps.some(({ kind }) => kind === "subflow")).toBe(true);
  });

  it.each([
    ["duplicate Step IDs", (input: ReturnType<typeof validWorkflowInput>) => input.steps.push(input.steps[0]!)],
    ["duplicate Route IDs", (input: ReturnType<typeof validWorkflowInput>) => input.routes.push(input.routes[0]!)],
    ["duplicate Loop IDs", (input: ReturnType<typeof validWorkflowInput>) => input.loops.push(input.loops[0]!)],
  ])("rejects %s", (_label, mutate) => {
    const input = validWorkflowInput();
    mutate(input);
    expect(() => createWorkflowRevision(input)).toThrow();
  });

  it("rejects missing entry and dangling route endpoints", () => {
    const missingEntry = validWorkflowInput();
    missingEntry.entryStepId = StepIdSchema.parse("stp_missing001");
    expect(() => createWorkflowRevision(missingEntry)).toThrow(/entry/iu);

    const dangling = validWorkflowInput();
    dangling.routes[0] = { ...dangling.routes[0]!, toStepId: StepIdSchema.parse("stp_missing001") };
    expect(() => createWorkflowRevision(dangling)).toThrow(/endpoint/iu);
  });

  it("requires every Loop to match exactly one real route and its endpoints", () => {
    const missingRoute = validWorkflowInput();
    missingRoute.loops[0] = {
      ...missingRoute.loops[0]!,
      routeId: RouteIdSchema.parse("rte_missing001"),
    };
    expect(() => createWorkflowRevision(missingRoute)).toThrow(/loop/iu);

    const wrongEndpoint = validWorkflowInput();
    wrongEndpoint.loops[0] = { ...wrongEndpoint.loops[0]!, toStepId: stepIds.gate };
    expect(() => createWorkflowRevision(wrongEndpoint)).toThrow(/loop/iu);
  });

  it("rejects zero or invalid retry, timeout, budget, and Loop bounds", () => {
    const retry = validWorkflowInput();
    retry.steps[0] = { ...retry.steps[0]!, retryPolicy: { ...retry.steps[0]!.retryPolicy, maxAttempts: 0 } };
    expect(() => createWorkflowRevision(retry)).toThrow();

    const timeout = validWorkflowInput();
    timeout.steps[0] = { ...timeout.steps[0]!, timeoutPolicy: { ...timeout.steps[0]!.timeoutPolicy, timeoutMs: 0 } };
    expect(() => createWorkflowRevision(timeout)).toThrow();

    const budget = validWorkflowInput();
    budget.steps[0] = { ...budget.steps[0]!, budgetCost: { ...budget.steps[0]!.budgetCost, units: 0 } };
    expect(() => createWorkflowRevision(budget)).toThrow();

    const loop = validWorkflowInput();
    loop.loops[0] = { ...loop.loops[0]!, maxIterations: 0 };
    expect(() => createWorkflowRevision(loop)).toThrow();
  });

  it("rejects ambiguous routes and outcomes without a deterministic default", () => {
    const duplicatePriority = validWorkflowInput();
    duplicatePriority.routes.push({
      ...duplicatePriority.routes.find(({ routeId }) => routeId === "rte_test_error1")!,
      routeId: RouteIdSchema.parse("rte_test_error2"),
    });
    expect(() => createWorkflowRevision(duplicatePriority)).toThrow(/ambiguous/iu);

    const noDefault = validWorkflowInput();
    noDefault.routes = noDefault.routes.filter(({ routeId }) => routeId !== "rte_test_retry1");
    noDefault.loops = [];
    expect(() => createWorkflowRevision(noDefault)).toThrow(/default/iu);
  });

  it("removes declared Loop routes before rejecting remaining non-Loop cycles", () => {
    expect(() => createWorkflowRevision(validWorkflowInput())).not.toThrow();

    const cycle = validWorkflowInput();
    const gatePassIndex = cycle.routes.findIndex(({ routeId }) => routeId === "rte_gate_pass01");
    cycle.routes[gatePassIndex] = { ...cycle.routes[gatePassIndex]!, toStepId: stepIds.implement };
    expect(() => createWorkflowRevision(cycle)).toThrow(/UNDECLARED_WORKFLOW_CYCLE/u);
  });

  it("rejects missing/unknown executor and incompatible AgentProfile selectors", () => {
    const missingExecutor = validWorkflowInput();
    const withoutExecutor = { ...missingExecutor.steps[0]! } as Partial<(typeof missingExecutor.steps)[number]>;
    delete withoutExecutor.executor;
    missingExecutor.steps[0] = withoutExecutor as (typeof missingExecutor.steps)[number];
    expect(() => createWorkflowRevision(missingExecutor)).toThrow();

    const unknownExecutor = validWorkflowInput() as unknown as Record<string, unknown>;
    (unknownExecutor.steps as Array<Record<string, unknown>>)[0]!.executor = {
      kind: "screen_automation",
      selector: "window-title",
    };
    expect(() => createWorkflowRevision(unknownExecutor)).toThrow();

    const agentWithoutProfile = validWorkflowInput();
    const withoutSelector = { ...agentWithoutProfile.steps[0]! } as Record<string, unknown>;
    delete withoutSelector.agentProfileSelector;
    agentWithoutProfile.steps[0] = withoutSelector as unknown as (typeof agentWithoutProfile.steps)[number];
    expect(() => createWorkflowRevision(agentWithoutProfile)).toThrow(/profile/iu);

    const verifierWithProfile = validWorkflowInput();
    const agentProfileSelector = (validWorkflowInput().steps[0] as unknown as Record<string, unknown>)[
      "agentProfileSelector"
    ];
    verifierWithProfile.steps[1] = {
      ...verifierWithProfile.steps[1]!,
      agentProfileSelector,
    } as unknown as (typeof verifierWithProfile.steps)[number];
    expect(() => createWorkflowRevision(verifierWithProfile)).toThrow(/profile/iu);
  });

  it("strictly validates retry backoff, delay bounds, jitter, and waiting budget", () => {
    const badBackoff = validWorkflowInput();
    badBackoff.steps[0] = {
      ...badBackoff.steps[0]!,
      retryPolicy: {
        ...badBackoff.steps[0]!.retryPolicy,
        backoff: { ...badBackoff.steps[0]!.retryPolicy.backoff, initialDelayMs: 200, maxDelayMs: 100 },
      },
    };
    expect(() => createWorkflowRevision(badBackoff)).toThrow(/backoff/iu);

    const unknownField = validWorkflowInput() as unknown as Record<string, unknown>;
    (unknownField.steps as Array<Record<string, unknown>>)[0]!.retryDelayMs = 99;
    expect(() => createWorkflowRevision(unknownField)).toThrow();

    const missingBackoff = validWorkflowInput() as unknown as Record<string, unknown>;
    const retryPolicy = ((missingBackoff.steps as Array<Record<string, unknown>>)[0]![
      "retryPolicy"
    ] ?? {}) as Record<string, unknown>;
    delete retryPolicy.backoff;
    expect(() => createWorkflowRevision(missingBackoff)).toThrow();
  });

  it("requires a strict Step permission policy", () => {
    const input = validWorkflowInput() as unknown as Record<string, unknown>;
    delete (input.steps as Array<Record<string, unknown>>)[0]!.permissionPolicy;
    expect(() => createWorkflowRevision(input)).toThrow();
  });

  it("validates mandatory Loop progress, stagnation, and exhaustion fields", () => {
    const input = validWorkflowInput();
    const incompleteLoop = { ...input.loops[0]! } as Partial<(typeof input.loops)[number]>;
    delete incompleteLoop.progressPredicate;
    input.loops[0] = incompleteLoop as (typeof input.loops)[number];
    expect(() => createWorkflowRevision(input)).toThrow();
  });

  it("rejects duplicate conditions even when priorities differ", () => {
    const input = validWorkflowInput();
    input.routes.push({
      ...input.routes.find(({ routeId }) => routeId === "rte_test_error1")!,
      routeId: RouteIdSchema.parse("rte_test_error3"),
      priority: 11,
    });
    expect(() => createWorkflowRevision(input)).toThrow(/ambiguous/iu);
  });

  it("uses opaque canonical workflow graph IDs", () => {
    expect(() => LoopIdSchema.parse("while(true)")).toThrow();
  });
});
