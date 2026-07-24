import {
  ArtifactIdParamsSchema,
  ArtifactPageHttpQuerySchema,
  ArtifactPageHttpResponseSchema,
  type ArtifactPageHttpQuery,
  type ArtifactPageHttpResponse,
} from "@hunter/api-contracts";
import type { ArtifactId, ProjectId } from "@hunter/domain";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

export interface ArtifactRoutesServices {
  projectForArtifact(artifactId: ArtifactId): {
    readonly projectId: ProjectId;
    readonly artifactId: ArtifactId;
  } | null;
  readPage(
    artifactId: ArtifactId,
    query: ArtifactPageHttpQuery,
  ): ArtifactPageHttpResponse | null;
}

export function registerArtifactRoutes(
  app: FastifyInstance,
  services: ArtifactRoutesServices,
): void {
  app.get(
    "/api/v1/artifacts/:artifactId/pages",
    async (request, reply) => {
      const params = ArtifactIdParamsSchema.safeParse(request.params);
      const query = ArtifactPageHttpQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return await reply
          .code(400)
          .send({ code: "REQUEST_SCHEMA_INVALID" });
      }
      const principal = requirePrincipal(request);
      const scope = services.projectForArtifact(params.data.artifactId);
      if (scope === null) {
        return await reply.code(404).send({ code: "ARTIFACT_NOT_FOUND" });
      }
      if (!principal.authorizedProjectIds.includes(scope.projectId)) {
        return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
      }
      if (scope.artifactId !== params.data.artifactId) {
        return await reply
          .code(409)
          .send({ code: "ARTIFACT_PROJECT_SCOPE_MISMATCH" });
      }
      let rawResponse: ArtifactPageHttpResponse | null;
      try {
        rawResponse = services.readPage(
          params.data.artifactId,
          query.data,
        );
      } catch (error) {
        if (
          error instanceof Error
          && error.message === "ARTIFACT_CURSOR_AHEAD_OF_HIGH_WATER"
        ) {
          return await reply.code(409).send({
            code: "ARTIFACT_CURSOR_AHEAD_OF_HIGH_WATER",
          });
        }
        throw error;
      }
      if (rawResponse === null) {
        return await reply.code(404).send({ code: "ARTIFACT_NOT_FOUND" });
      }
      const response = ArtifactPageHttpResponseSchema.parse(rawResponse);
      const responseArtifactId = response.status === "ok"
        ? response.artifact.artifactId
        : response.artifactId;
      if (
        responseArtifactId !== params.data.artifactId
        || (
          response.status === "ok"
          && response.artifact.projectId !== scope.projectId
        )
      ) {
        throw new Error("ARTIFACT_RESPONSE_SCOPE_MISMATCH");
      }
      return response;
    },
  );
}
