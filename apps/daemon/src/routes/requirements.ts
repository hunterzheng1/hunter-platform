import {
  ApproveRequirementHttpRequestSchema,
  CreateRequirementHttpRequestSchema,
  ReplaceRequirementHttpRequestSchema,
  RequirementRevisionHttpResponseSchema,
  RequirementRevisionParamsSchema,
  ProjectIdParamsSchema,
  type ApproveRequirementHttpRequest,
  type CreateRequirementHttpRequest,
  type RequirementRevisionHttpResponse,
} from "@hunter/api-contracts";
import type { ProjectId, RequirementRevisionId } from "@hunter/domain";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

interface RequirementRevisionIdentity {
  readonly projectId: ProjectId;
  readonly revisionId: RequirementRevisionId;
  readonly status: RequirementRevisionHttpResponse["status"];
}

export interface RequirementRoutesServices {
  createRequirement(
    projectId: ProjectId,
    command: CreateRequirementHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ): Promise<RequirementRevisionHttpResponse>;
  getRequirementRevision(revisionId: RequirementRevisionId): RequirementRevisionIdentity | null;
  approveRequirement(
    projectId: ProjectId,
    revisionId: RequirementRevisionId,
    command: ApproveRequirementHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ): Promise<RequirementRevisionHttpResponse>;
}

export function registerRequirementRoutes(app: FastifyInstance, services: RequirementRoutesServices): void {
  app.post("/api/v1/projects/:projectId/requirements", async (request, reply) => {
    const params = ProjectIdParamsSchema.safeParse(request.params);
    const body = CreateRequirementHttpRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
    const principal = requirePrincipal(request);
    if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
      return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    }
    const result = await services.createRequirement(params.data.projectId, body.data, {
      actorId: principal.principalId,
      correlationId: body.data.idempotencyKey,
    });
    const created = RequirementRevisionHttpResponseSchema.parse(result);
    if (
      created.projectId !== params.data.projectId
      || created.requirementId !== body.data.requirementId
      || created.revisionId !== body.data.revisionId
      || created.status !== "draft"
    ) throw new Error("CREATE_REQUIREMENT_RESPONSE_SCOPE_MISMATCH");
    return await reply.code(201).send(created);
  });

  app.post("/api/v1/projects/:projectId/requirement-revisions/:revisionId/approve", async (request, reply) => {
    const params = RequirementRevisionParamsSchema.safeParse(request.params);
    const body = ApproveRequirementHttpRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
    const principal = requirePrincipal(request);
    if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
      return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    }
    const existing = services.getRequirementRevision(params.data.revisionId);
    if (existing === null || existing.projectId !== params.data.projectId) {
      return await reply.code(404).send({ code: "REQUIREMENT_REVISION_NOT_FOUND" });
    }
    if (existing.status !== "draft" && existing.status !== "in_review") {
      return await reply.code(409).send({ code: existing.status === "approved" ? "APPROVED_REVISION_IMMUTABLE" : "REQUIREMENT_REVISION_NOT_APPROVABLE" });
    }
    const result = await services.approveRequirement(params.data.projectId, params.data.revisionId, body.data, {
      actorId: principal.principalId,
      correlationId: body.data.idempotencyKey,
    });
    const approved = RequirementRevisionHttpResponseSchema.parse(result);
    if (
      approved.projectId !== params.data.projectId
      || approved.revisionId !== params.data.revisionId
      || approved.status !== "approved"
    ) throw new Error("APPROVE_REQUIREMENT_RESPONSE_SCOPE_MISMATCH");
    return approved;
  });

  app.put("/api/v1/projects/:projectId/requirement-revisions/:revisionId", async (request, reply) => {
    const params = RequirementRevisionParamsSchema.safeParse(request.params);
    const body = ReplaceRequirementHttpRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
    const principal = requirePrincipal(request);
    if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
      return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    }
    const existing = services.getRequirementRevision(params.data.revisionId);
    if (existing === null || existing.projectId !== params.data.projectId) {
      return await reply.code(404).send({ code: "REQUIREMENT_REVISION_NOT_FOUND" });
    }
    return await reply.code(409).send({
      code: existing.status === "approved" ? "APPROVED_REVISION_IMMUTABLE" : "CREATE_NEW_REVISION",
    });
  });
}
