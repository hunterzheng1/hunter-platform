import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecutionPlanIdSchema, ProjectIdSchema, RunIdSchema, WorkflowRevisionIdSchema, createExecutionPlan, createWorkflowRevision } from "@hunter/domain";
import { createWorkflowRunBinding } from "@hunter/flow-engine";
import { RuntimeProviderIdSchema } from "@hunter/domain";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { validWorkflowInput } from "../../../packages/domain/src/workflow-test-fixtures.js";

describe("Foundation chain", () => {
  it("rebuilds a frozen Run across restart and exposes only verified success", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "hunter-foundation-")), "foundation.sqlite");
    const workflow = createWorkflowRevision(validWorkflowInput());
    const projectId = ProjectIdSchema.parse("prj_chain00001");
    const plan = createExecutionPlan({ executionPlanId: ExecutionPlanIdSchema.parse("epl_chain00001"), projectId, changeRevisionId: "crv_chain00001", requirementRevisionIds: ["rrv_chain00001"], tasks: [{ taskId: "tsk_chain00001", title: "Chain", objective: "verify", acceptanceCriteria: ["green"], repositoryIds: ["rep_chain00001"], moduleScopes: ["packages"], dependsOn: [], readSet: [], writeSet: ["packages"], access: "write", workflowRevisionId: workflow.workflowRevisionId, defaultAgentProfileId: "apr_chain00001", sessionPolicy: "new", workspacePolicy: { mode: "write", isolation: "worktree", reuse: false } }], publishedAt: "2026-07-22T10:00:00.000Z" });
    const definitions = { getWorkflowRevision: (id: string) => id === workflow.workflowRevisionId ? workflow : null, getExecutionPlan: (id: string) => id === plan.executionPlanId ? plan : null };
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_chain00001"), implementationVersion: "fake", observedAt: "2026-07-22T10:00:00.000Z" });
    const firstDb = new DatabaseSync(path);
    const first = createSqliteApplicationServices({ database: firstDb, repositories: definitions as never, externalHandler: fake, installSecret: "foundation-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    const runId = RunIdSchema.parse("run_chain00001");
    first.flowEngine.handle({ type: "StartRun", binding: createWorkflowRunBinding({ runId, projectId, changeRevisionId: plan.changeRevisionId, requirementRevisionIds: plan.requirementRevisionIds, workflowRevisionId: WorkflowRevisionIdSchema.parse(workflow.workflowRevisionId), policySnapshot: { snapshotHash: "a".repeat(64), policyVersion: 1 }, initialBudget: { maxAttempts: 5, maxElapsedMs: 60_000, maxCost: 10, maxTokens: 1000, maxLoopIterations: 2 }, subjectKind: "change", parentRunId: null, taskId: null, executionPlanId: plan.executionPlanId, taskGraphFingerprint: plan.taskGraphFingerprint }), expectedVersion: 0, idempotencyKey: "chain-start-1", actor: { actorId: "chain", correlationId: "chain" } });
    const before = first.flowStore.loadRun(runId)!;
    expect(before.status).toBe("running");
    expect(before.steps[0]!.conclusion).toBe("active");
    firstDb.close();

    const secondDb = new DatabaseSync(path);
    const second = createSqliteApplicationServices({ database: secondDb, repositories: definitions as never, externalHandler: fake, installSecret: "foundation-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    expect(second.flowStore.loadRun(runId)!.binding).toEqual(before.binding);
    await second.recovery.run();
    expect(second.eventReader.highWaterPosition()).toBeGreaterThan(0);
    expect(fake.nativeEffectCount).toBe(0);
    secondDb.close();
  });
});
