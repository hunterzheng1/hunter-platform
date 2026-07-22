import {
  ApproveRequirementHttpRequestSchema,
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  CreateRequirementHttpRequestSchema,
  ProjectDetailHttpResponseSchema,
  ProjectIdParamsSchema,
  ProjectListHttpResponseSchema,
  RequirementRevisionHttpResponseSchema,
  RequirementRevisionParamsSchema,
  type ProjectDetailHttpResponse,
  type ProjectListHttpResponse,
  type CreateProjectHttpResponse,
  type RequirementRevisionHttpResponse,
} from "@hunter/api-contracts";
import {
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
} from "@hunter/domain/ids";
import { z } from "zod";

export interface AuthenticatedHunterTransport {
  request(path: string, init?: RequestInit): Promise<unknown>;
}

export const AuthenticatedHunterTransportSchema = z.custom<AuthenticatedHunterTransport>(
  (value) => value !== null && typeof value === "object" && "request" in value && typeof value.request === "function",
  "trusted host transport is required",
);

interface HunterIdFactory {
  projectId(): string;
  requirementId(): string;
  requirementRevisionId(): string;
  idempotencyKey(action: string): string;
}

const defaultIds: HunterIdFactory = {
  projectId: () => `prj_${crypto.randomUUID()}`,
  requirementId: () => `req_${crypto.randomUUID()}`,
  requirementRevisionId: () => `rrv_${crypto.randomUUID()}`,
  idempotencyKey: (action) => `${action}-${crypto.randomUUID()}`,
};

export interface CreateRequirementDraftInput {
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
}

export class HunterApi {
  public constructor(
    private readonly transport: AuthenticatedHunterTransport,
    private readonly ids: HunterIdFactory = defaultIds,
  ) {}

  public async listProjects(): Promise<ProjectListHttpResponse> {
    return ProjectListHttpResponseSchema.parse(await this.transport.request("/api/v1/projects"));
  }

  public async createProject(name: string): Promise<CreateProjectHttpResponse> {
    const command = CreateProjectHttpRequestSchema.parse({
      projectId: ProjectIdSchema.parse(this.ids.projectId()),
      name,
      expectedVersion: 0,
      idempotencyKey: this.ids.idempotencyKey("create-project"),
    });
    const response = await this.transport.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    return CreateProjectHttpResponseSchema.parse(response);
  }

  public async getProject(projectId: string): Promise<ProjectDetailHttpResponse> {
    const params = ProjectIdParamsSchema.parse({ projectId });
    return ProjectDetailHttpResponseSchema.parse(
      await this.transport.request(`/api/v1/projects/${params.projectId}`),
    );
  }

  public async createRequirement(
    projectId: string,
    input: CreateRequirementDraftInput,
  ): Promise<RequirementRevisionHttpResponse> {
    const params = ProjectIdParamsSchema.parse({ projectId });
    const command = CreateRequirementHttpRequestSchema.parse({
      ...input,
      requirementId: RequirementIdSchema.parse(this.ids.requirementId()),
      revisionId: RequirementRevisionIdSchema.parse(this.ids.requirementRevisionId()),
      expectedVersion: 0,
      idempotencyKey: this.ids.idempotencyKey("create-requirement"),
    });
    const response = await this.transport.request(
      `/api/v1/projects/${params.projectId}/requirements`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      },
    );
    return RequirementRevisionHttpResponseSchema.parse(response);
  }

  public async approveRequirement(
    projectId: string,
    revisionId: string,
  ): Promise<RequirementRevisionHttpResponse> {
    const params = RequirementRevisionParamsSchema.parse({ projectId, revisionId });
    const command = ApproveRequirementHttpRequestSchema.parse({
      expectedVersion: 0,
      idempotencyKey: this.ids.idempotencyKey("approve-requirement"),
    });
    const response = await this.transport.request(
      `/api/v1/projects/${params.projectId}/requirement-revisions/${params.revisionId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      },
    );
    return RequirementRevisionHttpResponseSchema.parse(response);
  }
}
