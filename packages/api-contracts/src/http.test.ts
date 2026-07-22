import { describe, expect, it } from "vitest";

import {
  ApproveRequirementHttpRequestSchema,
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  CreateRequirementHttpRequestSchema,
  ProjectDetailHttpResponseSchema,
  ProjectIdParamsSchema,
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
});
