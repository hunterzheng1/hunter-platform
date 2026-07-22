import { RequirementIdSchema, RequirementRevisionIdSchema } from "@hunter/domain";
import type { CreateProjectHttpResponse } from "@hunter/api-contracts";
import { describe, expect, it, vi } from "vitest";

import { assertRequirementRoutesServices } from "../src/app.js";
import { buildTestApp, projectA, projectB } from "./support/build-test-app.js";

const requirementId = RequirementIdSchema.parse("req_task2000001");
const revisionId = RequirementRevisionIdSchema.parse("rrv_task2000001");

const draft = {
  projectId: projectA,
  requirementId,
  revisionId,
  aggregateVersion: 0,
  title: "移动审批",
  body: "允许所有者从受信任设备审批需求版本。",
  acceptanceCriteria: ["审批后仍恢复同一个运行"],
  constraints: ["不得绕过本地认证"],
  status: "draft" as const,
};

const createPayload = {
  expectedVersion: 0,
  idempotencyKey: "create-requirement-task2",
  requirementId,
  revisionId,
  title: draft.title,
  body: draft.body,
  acceptanceCriteria: draft.acceptanceCriteria,
  constraints: draft.constraints,
};

describe("project and requirement routes", () => {
  it("rejects an incomplete optional requirement service group", () => {
    expect(() => assertRequirementRoutesServices({
      createRequirement: vi.fn(),
    })).toThrowError("REQUIREMENTS_SERVICE_GROUP_INCOMPLETE");
  });

  it("creates a project and returns only strict project response data", async () => {
    const createProject = vi.fn(async (): Promise<CreateProjectHttpResponse> => ({
      projectId: projectB,
      name: "Hunter",
      authorization: "host_session_reissue_required",
    }));
    const { app, headers } = buildTestApp({ createProject });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: {
        projectId: projectB,
        name: "Hunter",
        expectedVersion: 0,
        idempotencyKey: "create-project-task2",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      projectId: projectB,
      name: "Hunter",
      authorization: "host_session_reissue_required",
    });
    expect(createProject).toHaveBeenCalledOnce();
    await app.close();
  });

  it("creates a draft and approves the exact revision in its project", async () => {
    const createRequirement = vi.fn(async () => draft);
    const getRequirementRevision = vi.fn(() => ({
      projectId: projectA,
      revisionId,
      status: "draft" as const,
    }));
    const approveRequirement = vi.fn(async () => ({
      ...draft,
      aggregateVersion: 1,
      status: "approved" as const,
      approvedAt: "2026-07-23T01:00:00.000Z",
    }));
    const { app, headers } = buildTestApp({
      requirements: { createRequirement, getRequirementRevision, approveRequirement },
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/requirements`,
      headers,
      payload: createPayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(draft);

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${revisionId}/approve`,
      headers,
      payload: { expectedVersion: 0, idempotencyKey: "approve-revision-task2" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ revisionId, status: "approved" });
    expect(approveRequirement).toHaveBeenCalledWith(
      projectA,
      revisionId,
      { expectedVersion: 0, idempotencyKey: "approve-revision-task2" },
      { actorId: "desktop-owner", correlationId: "approve-revision-task2" },
    );
    await app.close();
  });

  it("rejects cross-project approval before the command is called", async () => {
    const getRequirementRevision = vi.fn(() => ({
      projectId: projectB,
      revisionId,
      status: "draft" as const,
    }));
    const approveRequirement = vi.fn();
    const { app, headers } = buildTestApp({ requirements: { getRequirementRevision, approveRequirement } });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${revisionId}/approve`,
      headers,
      payload: { expectedVersion: 0, idempotencyKey: "approve-cross-project" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "REQUIREMENT_REVISION_NOT_FOUND" });
    expect(approveRequirement).not.toHaveBeenCalled();
    await app.close();
  });

  it("never replaces a revision and distinguishes approved immutability", async () => {
    const status = { current: "approved" as "approved" | "draft" };
    const getRequirementRevision = vi.fn(() => ({ projectId: projectA, revisionId, status: status.current }));
    const { app, headers } = buildTestApp({ requirements: { getRequirementRevision } });

    const approved = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${revisionId}`,
      headers,
      payload: { title: "Changed" },
    });
    expect(approved.statusCode).toBe(409);
    expect(approved.json()).toEqual({ code: "APPROVED_REVISION_IMMUTABLE" });

    status.current = "draft";
    const draftResponse = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/requirement-revisions/${revisionId}`,
      headers,
      payload: { title: "Changed" },
    });
    expect(draftResponse.statusCode).toBe(409);
    expect(draftResponse.json()).toEqual({ code: "CREATE_NEW_REVISION" });
    await app.close();
  });

  it("rejects malformed params, bodies, and unknown fields before services", async () => {
    const createRequirement = vi.fn();
    const getRequirementRevision = vi.fn();
    const approveRequirement = vi.fn();
    const { app, headers } = buildTestApp({
      requirements: { createRequirement, getRequirementRevision, approveRequirement },
    });

    const invalidRequests = [
      app.inject({ method: "POST", url: "/api/v1/projects/not-a-project/requirements", headers, payload: createPayload }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/requirements`, headers, payload: { ...createPayload, absolutePath: "C:/private" } }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/requirements`, headers, payload: { ...createPayload, revisionId: "rrv_short" } }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/requirements`, headers, payload: { ...createPayload, acceptanceCriteria: ["same", " same "] } }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/requirement-revisions/${revisionId}/approve`, headers, payload: { expectedVersion: 0, idempotencyKey: "too-short", extra: true } }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectA}/requirement-revisions/not-a-revision/approve`, headers, payload: { expectedVersion: 0, idempotencyKey: "approve-invalid-id" } }),
    ];
    for (const response of await Promise.all(invalidRequests)) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "REQUEST_SCHEMA_INVALID" });
    }
    expect(createRequirement).not.toHaveBeenCalled();
    expect(getRequirementRevision).not.toHaveBeenCalled();
    expect(approveRequirement).not.toHaveBeenCalled();
    await app.close();
  });
});
