import { validWorkflowInput } from "../../domain/src/workflow-test-fixtures.js";
import { createWorkflowRevision } from "@hunter/domain";
import { describe, expect, it } from "vitest";

import { deriveStepPolicy } from "./policy-engine.js";

describe("deriveStepPolicy", () => {
  it("derives executor, capabilities, permissions, timeout, retry, workspace, and budget from the frozen Step", () => {
    const workflow = createWorkflowRevision(validWorkflowInput());
    const step = workflow.steps.find(({ kind }) => kind === "agent")!;
    const decision = deriveStepPolicy(step, { policyVersion: 3, deniedPermissions: [] });
    expect(decision).toMatchObject({
      decision: "allow",
      executor: step.executor,
      requiredCapabilities: step.requiredCapabilities,
      permissionPolicy: step.permissionPolicy,
      retryPolicy: step.retryPolicy,
      timeoutPolicy: step.timeoutPolicy,
      workspacePolicy: step.workspacePolicy,
      budgetCost: step.budgetCost,
    });
    expect(decision.snapshotHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects caller attempts to override frozen execution authority", () => {
    const step = createWorkflowRevision(validWorkflowInput()).steps.find(({ kind }) => kind === "agent")!;
    expect(() => deriveStepPolicy(step, { policyVersion: 1, deniedPermissions: [] }, {
      timeoutMs: 1,
    })).toThrow(/CALLER_AUTHORITY_OVERRIDE/u);
  });
});
