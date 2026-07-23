import {
  ProjectIdParamsSchema,
  PublishChangeHttpRequestSchema,
  PublishChangeHttpResponseSchema,
  type PublishChangeHttpRequest,
  type PublishChangeHttpResponse,
} from "@hunter/api-contracts";
import {
  createChangeRevision,
  validateTaskGraph,
  type ProjectId,
  type RequirementRevisionId,
} from "@hunter/domain";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

export interface ChangeRequirementRevisionIdentity {
  readonly projectId: ProjectId;
  readonly revisionId: RequirementRevisionId;
  readonly status: "draft" | "in_review" | "approved" | "superseded" | "withdrawn";
}

export interface ChangeRoutesServices {
  getRequirementRevision(revisionId: RequirementRevisionId): ChangeRequirementRevisionIdentity | null;
  publishChange(
    projectId: ProjectId,
    command: PublishChangeHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ): Promise<PublishChangeHttpResponse>;
}

const taskGraphCodes = new Set([
  "TASK_GRAPH_CYCLE",
  "UNKNOWN_TASK_DEPENDENCY",
  "WRITE_TASK_REQUIRES_WRITE_SET",
  "READ_TASK_CANNOT_DECLARE_WRITE_SET",
  "TASK_WORKSPACE_ACCESS_MISMATCH",
  "DUPLICATE_TASK_ID",
  "DUPLICATE_TASK_ACCEPTANCE_CRITERION",
  "DUPLICATE_TASK_REPOSITORY",
  "DUPLICATE_TASK_MODULE_SCOPE",
  "DUPLICATE_TASK_DEPENDENCY",
  "DUPLICATE_TASK_READ_SET",
  "DUPLICATE_TASK_WRITE_SET",
]);

function taskGraphFailureCode(error: unknown): string {
  if (error instanceof Error && taskGraphCodes.has(error.message)) return error.message;
  return "INVALID_TASK_GRAPH";
}

export function registerChangeRoutes(app: FastifyInstance, services: ChangeRoutesServices): void {
  app.post("/api/v1/projects/:projectId/changes", async (request, reply) => {
    const params = ProjectIdParamsSchema.safeParse(request.params);
    const body = PublishChangeHttpRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
    }
    const principal = requirePrincipal(request);
    if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
      return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    }

    try {
      createChangeRevision({
        changeId: body.data.changeId,
        revisionId: body.data.changeRevisionId,
        projectId: params.data.projectId,
        title: body.data.title,
        goal: body.data.goal,
        nonGoals: body.data.nonGoals,
        requirementRevisionIds: body.data.requirementRevisionIds,
        repositoryIds: body.data.repositoryIds,
        acceptanceCriteria: body.data.acceptanceCriteria,
        constraints: body.data.constraints,
        risks: body.data.risks,
        dependsOnChangeRevisionIds: body.data.dependsOnChangeRevisionIds,
        status: "draft",
      });
    } catch {
      return await reply.code(422).send({ code: "INVALID_CHANGE" });
    }
    try {
      validateTaskGraph(body.data.tasks);
    } catch (error) {
      return await reply.code(422).send({ code: taskGraphFailureCode(error) });
    }

    for (const requirementRevisionId of body.data.requirementRevisionIds) {
      const requirement = services.getRequirementRevision(requirementRevisionId);
      if (requirement === null || requirement.projectId !== params.data.projectId) {
        return await reply.code(404).send({ code: "REQUIREMENT_REVISION_NOT_FOUND" });
      }
      if (requirement.status !== "approved") {
        return await reply.code(422).send({ code: "REQUIREMENT_REVISION_NOT_APPROVED" });
      }
    }

    const result = PublishChangeHttpResponseSchema.parse(await services.publishChange(
      params.data.projectId,
      body.data,
      { actorId: principal.principalId, correlationId: body.data.idempotencyKey },
    ));
    if (
      result.projectId !== params.data.projectId
      || result.changeId !== body.data.changeId
      || result.changeRevisionId !== body.data.changeRevisionId
      || result.executionPlanId !== body.data.executionPlanId
    ) {
      throw new Error("PUBLISH_CHANGE_RESPONSE_SCOPE_MISMATCH");
    }
    return await reply.code(201).send(result);
  });
}
