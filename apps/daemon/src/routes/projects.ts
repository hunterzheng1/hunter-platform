import {
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  ProjectDetailHttpResponseSchema,
  ProjectIdParamsSchema,
  ProjectListHttpResponseSchema,
  type CreateProjectHttpRequest,
  type CreateProjectHttpResponse,
  type ProjectDetailHttpResponse,
} from "@hunter/api-contracts";
import type { ProjectId } from "@hunter/domain";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

export interface ProjectRoutesServices {
  listProjects(authorizedProjectIds: readonly ProjectId[]): Promise<readonly unknown[]>;
  createProject?: ((command: CreateProjectHttpRequest, actor: { readonly actorId: string; readonly correlationId: string }) => Promise<CreateProjectHttpResponse>) | undefined;
  getProject?: ((projectId: ProjectId) => Promise<ProjectDetailHttpResponse | null>) | undefined;
}

export function registerProjectRoutes(app: FastifyInstance, services: ProjectRoutesServices): void {
  app.get("/projects", async (request) => {
    const principal = requirePrincipal(request);
    return ProjectListHttpResponseSchema.parse({
      projects: await services.listProjects(principal.authorizedProjectIds),
    });
  });

  app.get("/api/v1/projects", async (request) => {
    const principal = requirePrincipal(request);
    return ProjectListHttpResponseSchema.parse({
      projects: await services.listProjects(principal.authorizedProjectIds),
    });
  });

  if (services.createProject !== undefined) {
    const createProject = services.createProject;
    app.post("/api/v1/projects", async (request, reply) => {
      const parsed = CreateProjectHttpRequestSchema.safeParse(request.body);
      if (!parsed.success) return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
      const principal = requirePrincipal(request);
      const response = await createProject(parsed.data, {
        actorId: principal.principalId,
        correlationId: parsed.data.idempotencyKey,
      });
      const created = CreateProjectHttpResponseSchema.parse(response);
      if (created.projectId !== parsed.data.projectId) throw new Error("CREATE_PROJECT_RESPONSE_SCOPE_MISMATCH");
      return await reply.code(201).send(created);
    });
  }

  if (services.getProject !== undefined) {
    const getProject = services.getProject;
    app.get("/api/v1/projects/:projectId", async (request, reply) => {
      const parsed = ProjectIdParamsSchema.safeParse(request.params);
      if (!parsed.success) return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
      const principal = requirePrincipal(request);
      if (!principal.authorizedProjectIds.includes(parsed.data.projectId)) {
        return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
      }
      const project = await getProject(parsed.data.projectId);
      if (project === null) return await reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      const response = ProjectDetailHttpResponseSchema.parse(project);
      if (response.projectId !== parsed.data.projectId) throw new Error("PROJECT_RESPONSE_SCOPE_MISMATCH");
      return response;
    });
  }
}
