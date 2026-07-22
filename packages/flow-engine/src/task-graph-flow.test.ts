import { TaskIdSchema, createExecutionPlan } from "@hunter/domain";
import { describe, expect, it } from "vitest";

import { deriveTaskFanOut, resolveDependencyFailure, resolveResumeFailure, resolveSupersedingRequirement } from "./router.js";

const ids = {
  a: TaskIdSchema.parse("tsk_fanout0001"),
  b: TaskIdSchema.parse("tsk_fanout0002"),
  c: TaskIdSchema.parse("tsk_fanin00001"),
  compensation: TaskIdSchema.parse("tsk_compensate1"),
};

function plan() {
  const task = (taskId: typeof ids.a, dependsOn: readonly typeof ids.a[] = []) => ({ taskId, title: taskId, objective: "execute", acceptanceCriteria: ["verified"], repositoryIds: ["rep_flowgraph1"], moduleScopes: ["packages"], dependsOn, readSet: [], writeSet: ["packages"], access: "write" as const, workflowRevisionId: "wfr_flowgraph1", defaultAgentProfileId: "apr_flowgraph1", sessionPolicy: "new" as const, workspacePolicy: { mode: "write" as const, isolation: "worktree" as const, reuse: false } });
  return createExecutionPlan({ executionPlanId: "epl_flowgraph1", projectId: "prj_flowgraph1", changeRevisionId: "crv_flowgraph1", requirementRevisionIds: ["rrv_flowgraph1"], tasks: [task(ids.c, [ids.a, ids.b]), task(ids.b), task(ids.a)], publishedAt: "2026-07-22T10:00:00.000Z" });
}

describe("TaskGraph Flow decisions", () => {
  it("fans out all independent ready Tasks together and never duplicates an active child", () => {
    expect(deriveTaskFanOut(plan(), [])).toEqual([ids.a, ids.b]);
    expect(deriveTaskFanOut(plan(), [{ taskId: ids.a, status: "running" }])).toEqual([ids.b]);
    expect(deriveTaskFanOut(plan(), [{ taskId: ids.a, status: "succeeded" }, { taskId: ids.b, status: "succeeded" }])).toEqual([ids.c]);
  });

  it("fan-in waits for every dependency and a failed dependency is never guessed", () => {
    expect(deriveTaskFanOut(plan(), [{ taskId: ids.a, status: "succeeded" }, { taskId: ids.b, status: "running" }])).toEqual([]);
    expect(() => deriveTaskFanOut(plan(), [{ taskId: ids.a, status: "failed" }])).toThrow(/DEPENDENCY_FAILURE_DECISION_REQUIRED/u);
  });

  it.each([
    ["block", { action: "blocked" }],
    ["skip", { action: "skipped" }],
    ["terminate", { action: "terminate" }],
  ] as const)("resolves %s deterministically", (policy, expected) => {
    expect(resolveDependencyFailure({ policy })).toEqual(expected);
  });

  it("requires explicit compensation and waiver evidence", () => {
    expect(resolveDependencyFailure({ policy: "compensation", compensationTaskId: ids.compensation })).toEqual({ action: "compensate", taskId: ids.compensation });
    expect(() => resolveDependencyFailure({ policy: "compensation" })).toThrow(/COMPENSATION_TASK_REQUIRED/u);
    expect(resolveDependencyFailure({ policy: "waiver", waiver: { actorId: "approver", contentHash: "a".repeat(64) } })).toEqual({ action: "waived", receiptHash: "a".repeat(64) });
    expect(() => resolveDependencyFailure({ policy: "waiver" })).toThrow(/DEPENDENCY_WAIVER_REQUIRED/u);
  });

  it("keeps superseded bindings byte-identical and requires continue, terminate, or replan", () => {
    const binding = Object.freeze({ requirementRevisionIds: ["rrv_old000001"], bindingFingerprint: "b".repeat(64) });
    const result = resolveSupersedingRequirement(binding, { newerRevisionId: "rrv_new000001", decision: "continue_old_input" });
    expect(result.binding).toBe(binding);
    expect(result.action).toBe("continue_old_input");
    expect(() => resolveSupersedingRequirement(binding, { newerRevisionId: "rrv_new000001", decision: undefined as never })).toThrow(/SUPERSEDING_REQUIREMENT_DECISION_REQUIRED/u);
  });

  it("uses frozen SessionPolicy when resume cannot be proven", () => {
    expect(resolveResumeFailure("resume_if_supported")).toEqual({ action: "new_session_handoff", status: "paused" });
    expect(resolveResumeFailure("manual")).toEqual({ action: "needs_attention", status: "needs_attention" });
    expect(resolveResumeFailure("reuse")).toEqual({ action: "needs_attention", status: "needs_attention" });
  });
});
