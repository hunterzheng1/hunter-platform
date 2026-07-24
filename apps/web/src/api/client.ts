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
  EvidenceIdSchema,
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
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

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const KnowledgeBaseSchema = z.object({
  schemaVersion: z.literal(1),
  entryId: KnowledgeEntryIdSchema,
  status: z.enum(["active", "superseded", "withdrawn"]),
  scope: z.object({ projectId: ProjectIdSchema }).strict(),
  summary: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(10_000),
});
const KnowledgeEntrySchema = z.discriminatedUnion("level", [
  KnowledgeBaseSchema.extend({
    level: z.literal("authoritative"),
    source: z.object({
      type: z.literal("requirement_revision"),
      projectId: ProjectIdSchema,
      requirementRevisionId: RequirementRevisionIdSchema,
    }).strict(),
  }).strict(),
  KnowledgeBaseSchema.extend({
    level: z.literal("experiential"),
    confidence: z.object({
      level: z.enum(["low", "medium", "high"]),
      rationale: z.string().trim().min(1).max(1_000),
    }).strict(),
    invalidationConditions: z.array(z.object({
      condition: z.string().trim().min(1).max(1_000),
    }).strict()).min(1).max(32),
    source: z.object({
      type: z.literal("evidence"),
      projectId: ProjectIdSchema,
      evidenceId: EvidenceIdSchema,
      contentHash: Sha256Schema,
    }).strict(),
  }).strict(),
  KnowledgeBaseSchema.extend({
    level: z.literal("historical"),
    source: z.object({
      type: z.literal("archive"),
      projectId: ProjectIdSchema,
      runId: RunIdSchema,
      outcome: z.enum(["succeeded", "failed", "canceled"]),
      manifestSchemaVersion: z.literal(2),
      manifestHash: Sha256Schema,
      manifestRef: z.string().regex(/^cas:sha256:[a-f0-9]{64}$/u),
    }).strict(),
  }).strict(),
]);
const KnowledgeResponseSchema = z.object({
  projectId: ProjectIdSchema,
  entries: z.array(KnowledgeEntrySchema),
}).strict().superRefine((response, context) => {
  response.entries.forEach((entry, index) => {
    if (
      entry.scope.projectId !== response.projectId
      || entry.source.projectId !== response.projectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "scope"],
        message: "Knowledge entry must remain within the response Project",
      });
    }
    if (
      entry.level === "historical"
      && entry.source.manifestRef !== `cas:sha256:${entry.source.manifestHash}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "source", "manifestRef"],
        message: "manifest reference digest must match manifest hash",
      });
    }
  });
});
export type KnowledgeResponse = z.infer<typeof KnowledgeResponseSchema>;

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

  public async getKnowledge(
    projectId: string,
    includeHistorical = false,
  ): Promise<KnowledgeResponse> {
    const params = ProjectIdParamsSchema.parse({ projectId });
    const response = KnowledgeResponseSchema.parse(
      await this.transport.request(
        `/api/v1/projects/${params.projectId}/knowledge?includeHistorical=${includeHistorical}`,
      ),
    );
    if (response.projectId !== params.projectId) {
      throw new Error("KNOWLEDGE_RESPONSE_SCOPE_MISMATCH");
    }
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
