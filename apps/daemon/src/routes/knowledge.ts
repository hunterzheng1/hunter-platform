import {
  KnowledgeHttpResponseSchema,
  ProjectIdParamsSchema,
} from "@hunter/api-contracts";
import type { ProjectId } from "@hunter/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../http/security-hooks.js";

const KnowledgeQuerySchema = z.object({
  includeHistorical: z.enum(["true", "false"]).optional(),
}).strict();

export interface KnowledgeRoutesServices {
  resolve(input: {
    readonly projectId: ProjectId;
    readonly includeHistorical: boolean;
  }): Promise<readonly unknown[]>;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  services: KnowledgeRoutesServices,
): void {
  app.get("/api/v1/projects/:projectId/knowledge", async (request, reply) => {
    const params = ProjectIdParamsSchema.safeParse(request.params);
    const query = KnowledgeQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
    }
    const principal = requirePrincipal(request);
    if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
      return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    }
    return KnowledgeHttpResponseSchema.parse({
      projectId: params.data.projectId,
      entries: await services.resolve({
        projectId: params.data.projectId,
        includeHistorical: query.data.includeHistorical === "true",
      }),
    });
  });
}
