import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import { buildTestApp, projectA, projectB } from "./support/build-test-app.js";

const ids = {
  change: ChangeIdSchema.parse("chg_boundary0001"),
  changeRevision: ChangeRevisionIdSchema.parse("crv_boundary0001"),
  executionPlan: ExecutionPlanIdSchema.parse("epl_boundary0001"),
  requirementRevision: RequirementRevisionIdSchema.parse("rrv_boundary0001"),
  repository: RepositoryIdSchema.parse("rep_boundary0001"),
  task: TaskIdSchema.parse("tsk_boundary0001"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_boundary0001"),
  profile: AgentProfileIdSchema.parse("apr_boundary0001"),
};

function changePayload() {
  return {
    changeId: ids.change,
    changeRevisionId: ids.changeRevision,
    executionPlanId: ids.executionPlan,
    title: "Boundary",
    goal: "Reject forged cross-project relations before commands.",
    nonGoals: [],
    requirementRevisionIds: [ids.requirementRevision],
    repositoryIds: [ids.repository],
    acceptanceCriteria: ["All boundary tests pass."],
    constraints: [],
    risks: [],
    dependsOnChangeRevisionIds: [],
    tasks: [
      {
        taskId: ids.task,
        title: "Boundary task",
        objective: "Exercise the route boundary.",
        acceptanceCriteria: ["Boundary rejects mismatch."],
        repositoryIds: [ids.repository],
        moduleScopes: ["apps/daemon"],
        dependsOn: [],
        readSet: [],
        writeSet: ["apps/daemon"],
        access: "write",
        workflowRevisionId: ids.workflow,
        defaultAgentProfileId: ids.profile,
        sessionPolicy: "new",
        workspacePolicy: {
          mode: "write",
          isolation: "worktree",
          reuse: false,
        },
      },
    ],
    expectedVersion: 0,
    idempotencyKey: "task14-change-boundary",
  };
}

describe("authenticated domain route boundary", () => {
  it.each([
    ["wrong prefix", "run_boundary0001"],
    ["too long", `prj_${"a".repeat(97)}`],
    ["dot segment", "prj_boundary..01"],
    ["slash", "prj_boundary%2F001"],
    ["backslash", "prj_boundary%5C001"],
    ["NUL", "prj_boundary%00001"],
  ])(
    "BND-06 rejects malformed Project params before Requirement commands: %s",
    async (_label, projectId) => {
      const createRequirement = vi.fn();
      const { app, headers } = buildTestApp({
        requirements: { createRequirement },
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/requirements`,
        headers,
        payload: {
          requirementId: "req_boundary0001",
          revisionId: "rrv_boundary0001",
          title: "Boundary",
          body: "Boundary body",
          acceptanceCriteria: ["Rejected before command."],
          constraints: [],
          expectedVersion: 0,
          idempotencyKey: "task14-requirement-boundary",
        },
      });

      if (_label === "too long") {
        // Fastify rejects route params over its bounded matcher before the
        // handler. That fail-closed 404 is an acceptable pre-command result.
        expect(response.statusCode).toBe(404);
      } else {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ code: "REQUEST_SCHEMA_INVALID" });
      }
      expect(createRequirement).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("BND-07 rejects unknown fields and a cross-Project RequirementRevision before commands", async () => {
    const approveRequirement = vi.fn();
    const publishChange = vi.fn();
    const { app, headers } = buildTestApp({
      requirements: {
        getRequirementRevision: vi.fn(() => ({
          projectId: projectB,
          revisionId: ids.requirementRevision,
          status: "draft" as const,
        })),
        approveRequirement,
      },
      changes: {
        getRequirementRevision: vi.fn(() => ({
          projectId: projectB,
          revisionId: ids.requirementRevision,
          status: "approved" as const,
        })),
        publishChange,
      },
    });

    const unknown = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: { ...changePayload(), workspacePath: "C:/private" },
    });
    const forgedRequirement = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${ids.requirementRevision}/approve`,
      headers,
      payload: {
        expectedVersion: 0,
        idempotencyKey: "task14-approve-boundary",
      },
    });
    const forgedCoverage = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: changePayload(),
    });
    const malformedReplace = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${ids.requirementRevision}`,
      headers,
      payload: { title: "replacement", workspacePath: "C:/private" },
    });

    expect(unknown.statusCode).toBe(400);
    expect(forgedRequirement.statusCode).toBe(404);
    expect(forgedCoverage.statusCode).toBe(404);
    expect(malformedReplace.statusCode).toBe(400);
    expect(approveRequirement).not.toHaveBeenCalled();
    expect(publishChange).not.toHaveBeenCalled();
    await app.close();
  });

  it("BND-08 rejects Change/ExecutionPlan and Run/Project mismatches before commands", async () => {
    const publishChange = vi.fn();
    const startRun = vi.fn();
    const getChangeExecutionPlanRelation = vi.fn(() => ({
      projectId: projectB,
      changeId: ids.change,
      changeRevisionId: ids.changeRevision,
      executionPlanId: ids.executionPlan,
    }));
    const { app, headers } = buildTestApp({
      changes: {
        getChangeExecutionPlanRelation,
        publishChange,
      } as never,
      projectForExecutionPlan: vi.fn(() => ({
        projectId: projectA,
        executionPlanId: ids.executionPlan,
      })),
      projectForRun: vi.fn(() => ({
        projectId: projectB,
        runId: "run_boundary0001",
      })),
      startRun,
    } as never);

    const changeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: changePayload(),
    });
    const runResponse = await app.inject({
      method: "POST",
      url: "/runs",
      headers,
      payload: {
        runId: "run_boundary0001",
        executionPlanId: ids.executionPlan,
        workflowRevisionId: ids.workflow,
        expectedVersion: 0,
        idempotencyKey: "task14-run-boundary",
      },
    });

    expect(changeResponse.statusCode).toBe(409);
    expect(changeResponse.json()).toEqual({
      code: "CHANGE_EXECUTION_PLAN_SCOPE_MISMATCH",
    });
    expect(runResponse.statusCode).toBe(409);
    expect(runResponse.json()).toEqual({
      code: "RUN_PROJECT_SCOPE_MISMATCH",
    });
    expect(publishChange).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("BND-08 rejects identities returned for a different RequirementRevision or ExecutionPlan before commands", async () => {
    const approveRequirement = vi.fn();
    const startRun = vi.fn();
    const { app, headers } = buildTestApp({
      requirements: {
        getRequirementRevision: vi.fn(() => ({
          projectId: projectA,
          revisionId: RequirementRevisionIdSchema.parse("rrv_boundary0002"),
          status: "draft" as const,
        })),
        approveRequirement,
      },
      projectForExecutionPlan: vi.fn(() => ({
        projectId: projectA,
        executionPlanId: ExecutionPlanIdSchema.parse("epl_boundary0002"),
      })),
      startRun,
    });

    const requirementResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${ids.requirementRevision}/approve`,
      headers,
      payload: {
        expectedVersion: 0,
        idempotencyKey: "task14-approve-returned-id",
      },
    });
    const runResponse = await app.inject({
      method: "POST",
      url: "/runs",
      headers,
      payload: {
        runId: "run_boundary0002",
        executionPlanId: ids.executionPlan,
        workflowRevisionId: ids.workflow,
        expectedVersion: 0,
        idempotencyKey: "task14-run-returned-id",
      },
    });

    expect(requirementResponse.statusCode).toBe(404);
    expect(requirementResponse.json()).toEqual({
      code: "REQUIREMENT_REVISION_NOT_FOUND",
    });
    expect(runResponse.statusCode).toBe(409);
    expect(runResponse.json()).toEqual({
      code: "EXECUTION_PLAN_SCOPE_MISMATCH",
    });
    expect(approveRequirement).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    await app.close();
  });
});
