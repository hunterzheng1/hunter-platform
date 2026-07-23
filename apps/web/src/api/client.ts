import {
  ApproveRequirementHttpRequestSchema,
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  CreateRequirementHttpRequestSchema,
  ProjectDetailHttpResponseSchema,
  ProjectIdParamsSchema,
  ProjectListHttpResponseSchema,
  PublishChangeHttpRequestSchema,
  PublishChangeHttpResponseSchema,
  RequirementRevisionHttpResponseSchema,
  RequirementRevisionParamsSchema,
  RunIdParamsSchema,
  RunViewHttpResponseSchema,
  type ProjectDetailHttpResponse,
  type ProjectListHttpResponse,
  type PublishChangeHttpRequest,
  type PublishChangeHttpResponse,
  type CreateProjectHttpResponse,
  type RequirementRevisionHttpResponse,
  type RunViewHttpResponse,
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

interface PendingCommandEnvelope {
  readonly path: string;
  readonly init: RequestInit;
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

export type PublishChangeDraftInput = Omit<PublishChangeHttpRequest, "expectedVersion" | "idempotencyKey">;

export class HunterApi {
  private readonly pendingCommands = new Map<string, PendingCommandEnvelope>();
  private static readonly pendingCommandLimit = 32;

  public constructor(
    private readonly transport: AuthenticatedHunterTransport,
    private readonly ids: HunterIdFactory = defaultIds,
  ) {}

  public async listProjects(): Promise<ProjectListHttpResponse> {
    return ProjectListHttpResponseSchema.parse(await this.transport.request("/api/v1/projects"));
  }

  public async createProject(name: string): Promise<CreateProjectHttpResponse> {
    const normalizedName = name.trim();
    const logicalKey = `create-project:${JSON.stringify([normalizedName])}`;
    return this.sendPending(
      logicalKey,
      () => {
        const command = CreateProjectHttpRequestSchema.parse({
          projectId: ProjectIdSchema.parse(this.ids.projectId()),
          name: normalizedName,
          expectedVersion: 0,
          idempotencyKey: this.ids.idempotencyKey("create-project"),
        });
        return this.jsonCommand("/api/v1/projects", command);
      },
      (response) => CreateProjectHttpResponseSchema.parse(response),
    );
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
    const normalized = {
      title: input.title.trim(),
      body: input.body.trim(),
      acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()),
      constraints: input.constraints.map((item) => item.trim()),
    };
    const logicalKey = `create-requirement:${JSON.stringify([params.projectId, normalized.title, normalized.body, normalized.acceptanceCriteria, normalized.constraints])}`;
    return this.sendPending(
      logicalKey,
      () => {
        const command = CreateRequirementHttpRequestSchema.parse({
          ...normalized,
          requirementId: RequirementIdSchema.parse(this.ids.requirementId()),
          revisionId: RequirementRevisionIdSchema.parse(this.ids.requirementRevisionId()),
          expectedVersion: 0,
          idempotencyKey: this.ids.idempotencyKey("create-requirement"),
        });
        return this.jsonCommand(`/api/v1/projects/${params.projectId}/requirements`, command);
      },
      (response) => RequirementRevisionHttpResponseSchema.parse(response),
    );
  }

  public async approveRequirement(
    projectId: string,
    revisionId: string,
    expectedVersion: number,
  ): Promise<RequirementRevisionHttpResponse> {
    const params = RequirementRevisionParamsSchema.parse({ projectId, revisionId });
    const logicalKey = `approve-requirement:${JSON.stringify([params.projectId, params.revisionId, expectedVersion])}`;
    return this.sendPending(
      logicalKey,
      () => {
        const command = ApproveRequirementHttpRequestSchema.parse({
          expectedVersion,
          idempotencyKey: this.ids.idempotencyKey("approve-requirement"),
        });
        return this.jsonCommand(
          `/api/v1/projects/${params.projectId}/requirement-revisions/${params.revisionId}/approve`,
          command,
        );
      },
      (response) => RequirementRevisionHttpResponseSchema.parse(response),
    );
  }

  public async publishChange(
    projectId: string,
    input: PublishChangeDraftInput,
  ): Promise<PublishChangeHttpResponse> {
    const params = ProjectIdParamsSchema.parse({ projectId });
    const logicalKey = `publish-change:${JSON.stringify([params.projectId, input])}`;
    return this.sendPending(
      logicalKey,
      () => {
        const command = PublishChangeHttpRequestSchema.parse({
          ...input,
          expectedVersion: 0,
          idempotencyKey: this.ids.idempotencyKey("publish-change"),
        });
        return this.jsonCommand(`/api/v1/projects/${params.projectId}/changes`, command);
      },
      (response) => {
        const published = PublishChangeHttpResponseSchema.parse(response);
        if (
          published.projectId !== params.projectId
          || published.changeId !== input.changeId
          || published.changeRevisionId !== input.changeRevisionId
          || published.executionPlanId !== input.executionPlanId
        ) {
          throw new Error("PUBLISH_CHANGE_RESPONSE_SCOPE_MISMATCH");
        }
        return published;
      },
    );
  }

  public async getRun(runId: string): Promise<RunViewHttpResponse> {
    const params = RunIdParamsSchema.parse({ runId });
    const response = RunViewHttpResponseSchema.parse(
      await this.transport.request(`/api/v1/runs/${params.runId}`),
    );
    if (response.runId !== params.runId) throw new Error("RUN_RESPONSE_SCOPE_MISMATCH");
    return response;
  }

  private jsonCommand(path: string, command: unknown): PendingCommandEnvelope {
    return {
      path,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      },
    };
  }

  private async sendPending<T>(
    logicalKey: string,
    createEnvelope: () => PendingCommandEnvelope,
    parseResponse: (response: unknown) => T,
  ): Promise<T> {
    let envelope = this.pendingCommands.get(logicalKey);
    if (envelope === undefined) {
      if (this.pendingCommands.size >= HunterApi.pendingCommandLimit) {
        throw new Error("PENDING_COMMAND_LIMIT_REACHED");
      }
      envelope = createEnvelope();
      this.pendingCommands.set(logicalKey, envelope);
    }
    const response = await this.transport.request(envelope.path, envelope.init);
    const parsed = parseResponse(response);
    this.pendingCommands.delete(logicalKey);
    return parsed;
  }

}
