import {
  AppendProjectRepositoryHttpRequestSchema,
  AppendProjectRepositoryHttpResponseSchema,
  ConfirmProjectWorkflowMigrationHttpRequestSchema,
  ConfirmProjectWorkflowMigrationHttpResponseSchema,
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  ProjectDetailHttpResponseSchema,
  ProjectIdParamsSchema,
  ProjectListHttpResponseSchema,
  ProjectWorkflowBindingHttpResponseSchema,
  ProjectWorkflowMigrationPreviewHttpRequestSchema,
  ProjectWorkflowMigrationPreviewHttpResponseSchema,
  type AppendProjectRepositoryHttpRequest,
  type AppendProjectRepositoryHttpResponse,
  type ConfirmProjectWorkflowMigrationHttpRequest,
  type ConfirmProjectWorkflowMigrationHttpResponse,
  type CreateProjectHttpRequest,
  type CreateProjectHttpResponse,
  type ProjectDetailHttpResponse,
  type ProjectWorkflowBindingHttpResponse,
  type ProjectWorkflowMigrationPreviewHttpRequest,
  type ProjectWorkflowMigrationPreviewHttpResponse,
} from "@hunter/api-contracts";
import type { ProjectId } from "@hunter/domain";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

export interface ProjectRoutesServices {
  listProjects(authorizedProjectIds: readonly ProjectId[]): Promise<readonly unknown[]>;
  createProject?: ((command: CreateProjectHttpRequest, actor: { readonly actorId: string; readonly correlationId: string }) => Promise<CreateProjectHttpResponse>) | undefined;
  appendProjectRepository?: ((projectId: ProjectId, command: AppendProjectRepositoryHttpRequest, actor: { readonly actorId: string; readonly correlationId: string }) => Promise<AppendProjectRepositoryHttpResponse>) | undefined;
  getProjectWorkflowBinding?: ((projectId: ProjectId) => Promise<ProjectWorkflowBindingHttpResponse>) | undefined;
  previewProjectWorkflowMigration?: ((projectId: ProjectId, request: ProjectWorkflowMigrationPreviewHttpRequest) => Promise<ProjectWorkflowMigrationPreviewHttpResponse>) | undefined;
  confirmProjectWorkflowMigration?: ((projectId: ProjectId, command: ConfirmProjectWorkflowMigrationHttpRequest, actor: { readonly actorId: string; readonly correlationId: string }) => Promise<ConfirmProjectWorkflowMigrationHttpResponse>) | undefined;
  getProject?: ((projectId: ProjectId) => Promise<ProjectDetailHttpResponse | null>) | undefined;
}

export function registerProjectRoutes(app: FastifyInstance, services: ProjectRoutesServices): void {
  const workflowServiceCount = [
    services.getProjectWorkflowBinding,
    services.previewProjectWorkflowMigration,
    services.confirmProjectWorkflowMigration,
  ].filter((service) => service !== undefined).length;
  if (workflowServiceCount !== 0 && workflowServiceCount !== 3) {
    throw new Error("PROJECT_WORKFLOW_SERVICE_GROUP_INCOMPLETE");
  }
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

  if (services.appendProjectRepository !== undefined) {
    const appendProjectRepository = services.appendProjectRepository;
    app.post(
      "/api/v1/projects/:projectId/repositories",
      async (request, reply) => {
        const params = ProjectIdParamsSchema.safeParse(request.params);
        const body = AppendProjectRepositoryHttpRequestSchema.safeParse(
          request.body,
        );
        if (!params.success || !body.success) {
          return await reply.code(400).send({
            code: "REQUEST_SCHEMA_INVALID",
          });
        }
        const principal = requirePrincipal(request);
        if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
          return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
        }
        const response = AppendProjectRepositoryHttpResponseSchema.parse(
          await appendProjectRepository(
            params.data.projectId,
            body.data,
            {
              actorId: principal.principalId,
              correlationId: body.data.idempotencyKey,
            },
          ),
        );
        if (
          response.projectId !== params.data.projectId
          || response.repositoryBinding.repositoryId !== body.data.repositoryId
        ) {
          throw new Error("APPEND_PROJECT_REPOSITORY_SCOPE_MISMATCH");
        }
        return await reply.code(201).send(response);
      },
    );
  }

  if (
    services.getProjectWorkflowBinding !== undefined
    && services.previewProjectWorkflowMigration !== undefined
    && services.confirmProjectWorkflowMigration !== undefined
  ) {
    const getProjectWorkflowBinding = services.getProjectWorkflowBinding;
    const previewProjectWorkflowMigration =
      services.previewProjectWorkflowMigration;
    const confirmProjectWorkflowMigration =
      services.confirmProjectWorkflowMigration;
    app.get(
      "/api/v1/projects/:projectId/workflow-binding",
      async (request, reply) => {
        const params = ProjectIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          return await reply.code(400).send({
            code: "REQUEST_SCHEMA_INVALID",
          });
        }
        const principal = requirePrincipal(request);
        if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
          return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
        }
        const response = ProjectWorkflowBindingHttpResponseSchema.parse(
          await getProjectWorkflowBinding(params.data.projectId),
        );
        if (response.projectId !== params.data.projectId) {
          throw new Error("PROJECT_WORKFLOW_BINDING_SCOPE_MISMATCH");
        }
        return response;
      },
    );
    app.post(
      "/api/v1/projects/:projectId/workflow-migrations/preview",
      async (request, reply) => {
        const params = ProjectIdParamsSchema.safeParse(request.params);
        const body =
          ProjectWorkflowMigrationPreviewHttpRequestSchema.safeParse(
            request.body,
          );
        if (!params.success || !body.success) {
          return await reply.code(400).send({
            code: "REQUEST_SCHEMA_INVALID",
          });
        }
        const principal = requirePrincipal(request);
        if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
          return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
        }
        const response =
          ProjectWorkflowMigrationPreviewHttpResponseSchema.parse(
            await previewProjectWorkflowMigration(
              params.data.projectId,
              body.data,
            ),
          );
        if (
          response.projectId !== params.data.projectId
          || response.toWorkflowRevisionId
            !== body.data.toWorkflowRevisionId
        ) {
          throw new Error("PROJECT_WORKFLOW_PREVIEW_SCOPE_MISMATCH");
        }
        return response;
      },
    );
    app.post(
      "/api/v1/projects/:projectId/workflow-migrations/confirm",
      async (request, reply) => {
        const params = ProjectIdParamsSchema.safeParse(request.params);
        const body =
          ConfirmProjectWorkflowMigrationHttpRequestSchema.safeParse(
            request.body,
          );
        if (!params.success || !body.success) {
          return await reply.code(400).send({
            code: "REQUEST_SCHEMA_INVALID",
          });
        }
        const principal = requirePrincipal(request);
        if (!principal.authorizedProjectIds.includes(params.data.projectId)) {
          return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
        }
        const response =
          ConfirmProjectWorkflowMigrationHttpResponseSchema.parse(
            await confirmProjectWorkflowMigration(
              params.data.projectId,
              body.data,
              {
                actorId: principal.principalId,
                correlationId: body.data.idempotencyKey,
              },
            ),
          );
        if (
          response.projectId !== params.data.projectId
          || response.previousWorkflowRevisionId
            !== body.data.fromWorkflowRevisionId
          || response.currentWorkflowRevisionId
            !== body.data.toWorkflowRevisionId
        ) {
          throw new Error("PROJECT_WORKFLOW_CONFIRM_SCOPE_MISMATCH");
        }
        return response;
      },
    );
  }
}
