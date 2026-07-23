import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  type TaskId,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import type { ChangeRequirementRevisionIdentity } from "../src/routes/changes.js";
import { assertChangeRoutesServices } from "../src/app.js";
import { buildTestApp, projectA, projectB } from "./support/build-test-app.js";

const ids = {
  change: ChangeIdSchema.parse("chg_task3000001"),
  changeRevision: ChangeRevisionIdSchema.parse("crv_task3000001"),
  executionPlan: ExecutionPlanIdSchema.parse("epl_task3000001"),
  requirement: RequirementRevisionIdSchema.parse("rrv_task3000001"),
  repository: RepositoryIdSchema.parse("rep_task3000001"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_task3000001"),
  profile: AgentProfileIdSchema.parse("apr_task3000001"),
  taskA: TaskIdSchema.parse("tsk_task300api1"),
  taskB: TaskIdSchema.parse("tsk_task300ui01"),
};

function task(taskId: TaskId, dependsOn: readonly TaskId[]) {
  return {
    taskId,
    title: taskId === ids.taskA ? "控制 API" : "客户端界面",
    objective: "交付可验证工作",
    acceptanceCriteria: ["精确测试通过"],
    repositoryIds: [ids.repository],
    moduleScopes: ["delivery"],
    dependsOn,
    readSet: ["delivery-contract"],
    writeSet: ["delivery-output"],
    access: "write",
    workflowRevisionId: ids.workflow,
    defaultAgentProfileId: ids.profile,
    sessionPolicy: "new",
    workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
  };
}

function payload(tasks: readonly object[]) {
  return {
    changeId: ids.change,
    changeRevisionId: ids.changeRevision,
    executionPlanId: ids.executionPlan,
    title: "并行交付",
    goal: "并行交付两个实现并完成集成",
    nonGoals: ["不接入真实 Provider"],
    requirementRevisionIds: [ids.requirement],
    repositoryIds: [ids.repository],
    acceptanceCriteria: ["集成测试通过"],
    constraints: ["保持 provider-neutral"],
    risks: ["集成冲突"],
    dependsOnChangeRevisionIds: [],
    tasks,
    expectedVersion: 0,
    idempotencyKey: "publish-change-task3",
  };
}

describe("Change routes", () => {
  it("rejects an incomplete optional Change service group", () => {
    expect(() => assertChangeRoutesServices({ getRequirementRevision: vi.fn() }))
      .toThrowError("CHANGES_SERVICE_GROUP_INCOMPLETE");
  });

  it("rejects a cycle with a stable 422 before the command service", async () => {
    const publishChange = vi.fn();
    const getRequirementRevision = vi.fn(() => ({
      projectId: projectA,
      revisionId: ids.requirement,
      status: "approved" as const,
    }));
    const { app, headers } = buildTestApp({ changes: { getRequirementRevision, publishChange } });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: payload([task(ids.taskA, [ids.taskB]), task(ids.taskB, [ids.taskA])]),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ code: "TASK_GRAPH_CYCLE" });
    expect(publishChange).not.toHaveBeenCalled();
    await app.close();
  });

  it("publishes the complete authenticated command and strictly scopes the response", async () => {
    const publishChange = vi.fn(async (projectId, command) => ({
      projectId,
      changeId: command.changeId,
      changeRevisionId: command.changeRevisionId,
      executionPlanId: command.executionPlanId,
      status: "published" as const,
      taskGraphFingerprint: "a".repeat(64),
    }));
    const { app, headers } = buildTestApp({ changes: { publishChange } });
    const command = payload([task(ids.taskA, [])]);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: command,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      projectId: projectA,
      changeId: ids.change,
      changeRevisionId: ids.changeRevision,
      executionPlanId: ids.executionPlan,
      status: "published",
      taskGraphFingerprint: "a".repeat(64),
    });
    expect(publishChange).toHaveBeenCalledWith(
      projectA,
      command,
      { actorId: "desktop-owner", correlationId: command.idempotencyKey },
    );
    await app.close();
  });

  it("keeps auth in front of Change services and rejects private response fields", async () => {
    const publishChange = vi.fn(async (projectId, command) => ({
      projectId,
      changeId: command.changeId,
      changeRevisionId: command.changeRevisionId,
      executionPlanId: command.executionPlanId,
      status: "published" as const,
      taskGraphFingerprint: "a".repeat(64),
      localPath: "C:/private",
    }));
    const { app, headers } = buildTestApp({ changes: { publishChange } });
    const { authorization: ignoredAuthorization, ...withoutAuthorization } = headers;
    void ignoredAuthorization;
    const command = payload([task(ids.taskA, [])]);
    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers: withoutAuthorization,
      payload: command,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(publishChange).not.toHaveBeenCalled();

    const invalidResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: command,
    });
    expect(invalidResponse.statusCode).toBe(500);
    expect(invalidResponse.body).not.toContain("C:/private");
    await app.close();
  });

  it("rejects malformed, unknown, cross-project, and unapproved Requirement inputs before publish", async () => {
    const publishChange = vi.fn();
    const relation: { current: ChangeRequirementRevisionIdentity } = {
      current: { projectId: projectB, revisionId: ids.requirement, status: "approved" },
    };
    const getRequirementRevision = vi.fn(() => relation.current);
    const { app, headers } = buildTestApp({ changes: { getRequirementRevision, publishChange } });
    const valid = payload([task(ids.taskA, [])]);

    const malformed = await app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/changes`, headers, payload: { ...valid, changeId: "bad" } });
    const unknown = await app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/changes`, headers, payload: { ...valid, absolutePath: "C:/private" } });
    expect(getRequirementRevision).not.toHaveBeenCalled();
    const crossProject = await app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/changes`, headers, payload: valid });
    relation.current = { projectId: projectA, revisionId: ids.requirement, status: "draft" };
    const unapproved = await app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/changes`, headers, payload: valid });

    expect([malformed.statusCode, unknown.statusCode]).toEqual([400, 400]);
    expect(crossProject.statusCode).toBe(404);
    expect(unapproved.statusCode).toBe(422);
    expect(publishChange).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a relation lookup that returns a different RequirementRevision identity", async () => {
    const publishChange = vi.fn();
    const getRequirementRevision = vi.fn(() => ({
      projectId: projectA,
      revisionId: RequirementRevisionIdSchema.parse("rrv_task3000002"),
      status: "approved" as const,
    }));
    const { app, headers } = buildTestApp({ changes: { getRequirementRevision, publishChange } });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: payload([task(ids.taskA, [])]),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "REQUIREMENT_REVISION_NOT_FOUND" });
    expect(getRequirementRevision).toHaveBeenCalledWith(ids.requirement);
    expect(publishChange).not.toHaveBeenCalled();
    await app.close();
  });

  it("distinguishes invalid Change content from TaskGraph failures", async () => {
    const publishChange = vi.fn();
    const { app, headers } = buildTestApp({ changes: { publishChange } });
    const valid = payload([task(ids.taskA, [])]);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: { ...valid, requirementRevisionIds: [ids.requirement, ids.requirement] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ code: "INVALID_CHANGE" });
    expect(publishChange).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["unknown dependency", [task(ids.taskA, [TaskIdSchema.parse("tsk_task300miss")])], "UNKNOWN_TASK_DEPENDENCY"],
    [
      "access mismatch",
      [{ ...task(ids.taskA, []), access: "read", workspacePolicy: { mode: "write", isolation: "worktree", reuse: false } }],
      "READ_TASK_CANNOT_DECLARE_WRITE_SET",
    ],
  ])("rejects %s before publish", async (_label, tasks, code) => {
    const publishChange = vi.fn();
    const { app, headers } = buildTestApp({ changes: { publishChange } });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/changes`,
      headers,
      payload: payload(tasks),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ code });
    expect(publishChange).not.toHaveBeenCalled();
    await app.close();
  });
});
