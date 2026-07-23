import { describe, expect, it } from "vitest";
import { TaskDefinitionSchema } from "@hunter/domain";

import {
  ApproveRequirementHttpRequestSchema,
  ChangePlanningDefaultsHttpSchema,
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  CreateRequirementHttpRequestSchema,
  ProjectDetailHttpResponseSchema,
  ProjectIdParamsSchema,
  PublishChangeHttpRequestSchema,
  PublishChangeHttpResponseSchema,
  RequirementRevisionHttpResponseSchema,
  RequirementRevisionParamsSchema,
  StartRunHttpRequestSchema,
} from "./http.js";

describe("HTTP command schemas", () => {
  it("accepts only the stable root StartRun authority", () => {
    const valid = { runId: "run_http000001", executionPlanId: "epl_http000001", workflowRevisionId: "wfr_http000001", expectedVersion: 0, idempotencyKey: "start-http-1" };
    expect(StartRunHttpRequestSchema.parse(valid)).toEqual(valid);
    for (const forbidden of ["absolutePath", "policySnapshot", "remainingBudget", "actor", "projectId", "deviceBindingPath"] as const) {
      expect(() => StartRunHttpRequestSchema.parse({ ...valid, [forbidden]: "caller-owned" })).toThrow();
    }
  });

  it("rejects malformed IDs, unknown fields, and invalid versions", () => {
    expect(() => StartRunHttpRequestSchema.parse({ runId: "bad", executionPlanId: "epl_http000001", workflowRevisionId: "wfr_http000001", expectedVersion: -1, idempotencyKey: "x", extra: true })).toThrow();
  });
});

describe("Workbench HTTP schemas", () => {
  const projectId = "prj_task2000001";
  const requirementId = "req_task2000001";
  const revisionId = "rrv_task2000001";

  it("strictly decodes project and requirement commands", () => {
    expect(CreateProjectHttpRequestSchema.parse({
      projectId,
      name: "Hunter",
      expectedVersion: 0,
      idempotencyKey: "create-project-task2",
    })).toMatchObject({ projectId, name: "Hunter" });
    expect(CreateRequirementHttpRequestSchema.parse({
      requirementId,
      revisionId,
      title: "移动审批",
      body: "允许所有者审批需求。",
      acceptanceCriteria: ["审批后恢复同一个运行"],
      constraints: [],
      expectedVersion: 0,
      idempotencyKey: "create-requirement-task2",
    })).toMatchObject({ requirementId, revisionId });
    expect(ApproveRequirementHttpRequestSchema.parse({ expectedVersion: 0, idempotencyKey: "approve-task2" })).toEqual({ expectedVersion: 0, idempotencyKey: "approve-task2" });
  });

  it("rejects unknown fields and malformed route IDs", () => {
    expect(() => CreateProjectHttpRequestSchema.parse({ projectId, name: "Hunter", expectedVersion: 0, idempotencyKey: "create-project-task2", absolutePath: "C:/private" })).toThrow();
    expect(() => CreateRequirementHttpRequestSchema.parse({ requirementId, revisionId, title: "移动审批", body: "正文", acceptanceCriteria: ["验收"], constraints: [], expectedVersion: 0, idempotencyKey: "create-requirement-task2", extra: true })).toThrow();
    expect(() => ProjectIdParamsSchema.parse({ projectId: "not-a-project" })).toThrow();
    expect(() => RequirementRevisionParamsSchema.parse({ projectId, revisionId: "rrv_short" })).toThrow();
  });

  it("rejects duplicate requirement list items after normalization", () => {
    expect(() => CreateRequirementHttpRequestSchema.parse({
      requirementId,
      revisionId,
      title: "移动审批",
      body: "正文",
      acceptanceCriteria: ["审批后恢复运行", " 审批后恢复运行 "],
      constraints: [],
      expectedVersion: 0,
      idempotencyKey: "create-requirement-task2",
    })).toThrow();

    expect(() => RequirementRevisionHttpResponseSchema.parse({
      projectId,
      requirementId,
      revisionId,
      aggregateVersion: 0,
      title: "移动审批",
      body: "正文",
      acceptanceCriteria: ["验收"],
      constraints: ["仅限本地", " 仅限本地 "],
      status: "draft",
    })).toThrow();
  });

  it("strictly validates Workbench responses", () => {
    const revision = { projectId, requirementId, revisionId, aggregateVersion: 0, title: "移动审批", body: "正文", acceptanceCriteria: ["验收"], constraints: [], status: "draft" };
    expect(RequirementRevisionHttpResponseSchema.parse(revision)).toEqual(revision);
    expect(ProjectDetailHttpResponseSchema.parse({ projectId, name: "Hunter", requirements: [revision] })).toMatchObject({ projectId, name: "Hunter" });
    expect(() => ProjectDetailHttpResponseSchema.parse({ projectId, name: "Hunter", requirements: [], extra: true })).toThrow();
    expect(CreateProjectHttpResponseSchema.parse({ projectId, name: "Hunter", authorization: "host_session_reissue_required" })).toMatchObject({ projectId });
  });

  it("owns the complete provider-neutral Change planning request and response", () => {
    const request = {
      changeId: "chg_task3000001",
      changeRevisionId: "crv_task3000001",
      executionPlanId: "epl_task3000001",
      title: "并行交付",
      goal: "并行完成实现后集成",
      nonGoals: ["不接入真实 Provider"],
      requirementRevisionIds: ["rrv_task3000001"],
      repositoryIds: ["rep_task3000001"],
      acceptanceCriteria: ["集成测试通过"],
      constraints: ["provider-neutral"],
      risks: ["集成冲突"],
      dependsOnChangeRevisionIds: [],
      tasks: [{
        taskId: "tsk_task300api1",
        title: "控制 API",
        objective: "交付控制接口",
        acceptanceCriteria: ["接口测试通过"],
        repositoryIds: ["rep_task3000001"],
        moduleScopes: ["control-api"],
        dependsOn: [],
        readSet: ["control-contract"],
        writeSet: ["control-api"],
        access: "write",
        workflowRevisionId: "wfr_task3000001",
        defaultAgentProfileId: "apr_task3000001",
        sessionPolicy: "new",
        workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
      }],
      expectedVersion: 0,
      idempotencyKey: "publish-change-task3",
    };
    const parsed = PublishChangeHttpRequestSchema.parse(request);
    expect(parsed).toMatchObject({
      changeId: request.changeId,
      tasks: [expect.objectContaining({ objective: "交付控制接口", access: "write" })],
    });
    expect(TaskDefinitionSchema.parse(parsed.tasks[0])).toEqual(parsed.tasks[0]);
    expect(() => PublishChangeHttpRequestSchema.parse({
      ...request,
      tasks: [{ ...request.tasks[0], providerId: "private" }],
    })).toThrow();
    for (const forbidden of ["absolutePath", "workspaceRef", "providerId", "terminalId", "windowId"] as const) {
      expect(() => PublishChangeHttpRequestSchema.parse({ ...request, [forbidden]: "private" })).toThrow();
    }
    const response = {
      projectId,
      changeId: request.changeId,
      changeRevisionId: request.changeRevisionId,
      executionPlanId: request.executionPlanId,
      status: "published",
      taskGraphFingerprint: "a".repeat(64),
    };
    expect(PublishChangeHttpResponseSchema.parse(response)).toEqual(response);
    expect(() => PublishChangeHttpResponseSchema.parse({ ...response, localPath: "C:/private" })).toThrow();
  });

  it("accepts only isolated non-reused write worktrees as parallel planning defaults", () => {
    const valid = {
      repositoryIds: ["rep_task3000001"],
      workflowRevisionId: "wfr_task3000001",
      defaultAgentProfileId: "apr_task3000001",
      sessionPolicy: "new",
      workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
    };
    expect(ChangePlanningDefaultsHttpSchema.parse(valid)).toEqual(valid);
    expect(() => ChangePlanningDefaultsHttpSchema.parse({
      ...valid,
      workspacePolicy: { ...valid.workspacePolicy, isolation: "shared_snapshot" },
    })).toThrow();
    expect(() => ChangePlanningDefaultsHttpSchema.parse({
      ...valid,
      workspacePolicy: { ...valid.workspacePolicy, isolation: "single_writer" },
    })).toThrow();
    expect(() => ChangePlanningDefaultsHttpSchema.parse({
      ...valid,
      workspacePolicy: { ...valid.workspacePolicy, reuse: true },
    })).toThrow();
  });
});
