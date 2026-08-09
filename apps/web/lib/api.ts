import {
  canonicalJson,
  type AiProviderApiFormat,
  type AiProviderConfig,
  type AiProviderWithKeySet,
  type AiQuotaUsage,
  type ProviderModel,
  type DashboardOverview,
  type DraftState,
  type ExternalSkill,
  type CreateExternalSkillRequest,
  type PatchExternalSkillRequest,
  type FileOperation,
  type FixPlan,
  type NpmReleaseResponse,
  type PublishSkillResponse,
  type PublishUnifiedSkillRequest,
  type PublishSkillRequest,
  type RegistryAgent,
  type RegistryArtifact,
  type PublishWorkflowFamilyRequest,
  type RegistryProjectWorkflowBinding,
  type RegistrySkillDetail,
  type RegistrySkillVersion,
  type RegistryTag,
  type SetDefaultAgentRequest,
  type SkillCheckResult,
  type SkillDiffFile,
  type SensitiveReviewSubmission,
  type WorkflowFamily,
  type WorkflowFamilyDraftState,
  type WorkflowFamilyMutation,
  type WorkflowFamilyVersion,
  type SemanticDocument,
  type SemanticEdge,
  type SemanticOverview
} from "@hunter-harness/contracts";

import type { WebFileKind } from "./file-policy";

// 异步 AI 检查 job 状态（GET /api/v1/ai-jobs/:id 响应；与 server AiJobStore 对齐）
export interface AiJobState {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed";
  result: SkillCheckResult | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Raw knowledge ingest entry as returned by GET .../knowledge/entries. */
export interface KnowledgeIngestListItem {
  entry_id: string;
  status: string;
  content_sha256: string;
  payload: Record<string, unknown>;
  updated_at: string;
  projected_at: string | null;
}

export interface RunPhaseSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  total_duration_ms?: number | null;
  attempt_count?: number;
  active_attempt?: number | null;
  latest_status?: string | null;
  validity?: "current" | "stale";
  attempts?: Array<{
    attempt: number;
    run_id?: string | null;
    trigger?: string | null;
    from_phase?: string | null;
    started_at: string;
    ended_at: string | null;
    status: string | null;
    duration_ms: number | null;
  }>;
}

export interface RunSummary {
  run_id: string;
  project_id: string;
  change_key: string;
  title: string | null;
  run_status: string;
  connection_status: string;
  sync_completeness: string;
  current_phase: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_event_at: string | null;
  last_heartbeat_at: string | null;
  server_cursor: number;
  active_phase?: string | null;
  waiting_for_phase?: string | null;
  workflow_status?: "running" | "waiting" | "completed" | "failed" | "abandoned" | "superseded";
  result_status?: "pending" | "warning" | "success" | "failure";
  planned_phases?: string[] | null;
  skipped_phases?: unknown[];
  phase_plan_source?: string;
  closure_disposition?: "completed" | "abandoned" | "superseded" | null;
  closure_reason?: string | null;
  timing_breakdown?: {
    product_verification_ms: number;
    process_evidence_ms: number;
    user_wait_ms: number;
    wall_clock_reported_ms: number;
  };
  file_breakdown?: { product_files: number; process_evidence_files: number };
  phases?: RunPhaseSummary[];
}

export interface ChangeArchiveSummary {
  changeKey: string;
  archivedAt: string | null;
  files: Array<{
    path: string;
    sizeBytes: number;
    kind: "design" | "plan" | "report" | "evidence" | "meta" | "log" | "knowledge";
    tier: "core" | "supporting" | "diagnostic";
  }>;
}

export interface RunEventSummary {
  server_cursor: number;
  run_id: string;
  event_id: string;
  producer_seq: number;
  event_type: string;
  phase: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface ProjectSummary {
  project_id: string;
  display_name: string;
  role: "owner" | "contributor" | "reviewer" | "admin";
  latest_project_version: string | null;
  latest_artifact_id: string | null;
  lifecycle_state?: "active" | "archived" | "purged";
  archived_at?: string | null;
  purge_after?: string | null;
  current_files_version?: string | null;
  current_file_count?: number;
  local_project_key?: string | null;
  updated_at?: string;
  created_at: string;
}

export interface ProjectDetailModel extends ProjectSummary {
  request_id: string;
}

export interface ArtifactManifestModel {
  schema_version: 1;
  project_id: string;
  project_version: string | null;
  artifact_id: string;
  manifest_sha256: string;
  files: FileOperation[];
}

export interface ProjectFileProposalInput {
  projectId: string;
  baseProjectVersion: string | null;
  baseManifestHash: string;
  baseArtifactId?: string | null;
  action: "add" | "modify" | "rename" | "delete";
  path: string;
  targetPath?: string;
  baseContentHash?: string;
  content?: string;
  fileKind: WebFileKind;
  confirmProjectLocal: boolean;
}

export interface ProjectFileProposalResult {
  proposal_id: string;
  status: "approved" | "pending_review";
  artifact_id?: string | null;
  received_files: number;
}

export interface ProjectFileMetadata {
  path: string;
  file_kind: WebFileKind;
  content_sha256: string;
  size_bytes: number;
  project_version: string;
  updated_at: string;
}

export interface ProjectFilesSnapshot {
  project_id: string;
  project_version: string | null;
  total: number;
  items: ProjectFileMetadata[];
}

export interface ProjectFileContent extends ProjectFileMetadata {
  project_id: string;
  content: string;
}

export interface ProjectLifecycleResult {
  project_id: string;
  display_name: string;
  lifecycle_state: "active" | "archived" | "purged";
  archived_at: string | null;
  purge_after: string | null;
  purged_at: string | null;
}

export interface ProjectSemanticGraph {
  nodes: SemanticDocument[];
  edges: SemanticEdge[];
  focus_document_id: string | null;
  relation_status: "ready" | "no_relations";
  indexed_documents: number;
}

export interface ProposalSummary {
  proposal_id: string;
  project_id: string;
  status: string;
  created_at: string;
  changed_item_count: number;
  risk_count: number;
  base_project_version: string | null;
  created_by: string;
}

export interface ArtifactSummary {
  artifact_id: string;
  project_id: string;
  project_version: string;
  base_project_version: string | null;
  proposal_id: string;
  changed_item_count: number;
  manifest_sha256: string;
  created_at: string;
}

export interface ProposalDetailModel {
  schema_version: 1;
  proposal_id: string;
  project_id: string;
  status: string;
  created_by: string;
  created_at: string;
  items: Array<{ item_id: string; operation: FileOperation }>;
  scan_summary: { redacted: true };
  review_history: Array<{
    review_id: string;
    decision: string;
    created_at: string;
  }>;
}

export interface ReviewInput {
  decision: "approve" | "reject" | "need_more_evidence" | "split" | "auto-approved";
  comment: string | null;
  target_scope: string;
  split_groups: Array<{
    name: string;
    item_ids: string[];
    target_scope: string;
  }>;
}

export interface ReviewResult {
  review_id: string;
  proposal_id: string;
  decision: ReviewInput["decision"];
  artifact_id: string | null;
  child_proposal_ids: string[];
}

export interface HunterApi {
  getDashboardOverview(days?: number): Promise<DashboardOverview>;
  listProjects(state?: "active" | "archived"): Promise<ProjectSummary[]>;
  createProject?(input: {
    display_name: string;
    withKey?: boolean;
  }): Promise<ProjectSummary & { api_key?: string; key_id?: string }>;
  getProject(projectId: string): Promise<ProjectDetailModel>;
  listProjectProposals(projectId: string): Promise<ProposalSummary[]>;
  listAllProposals(): Promise<ProposalSummary[]>;
  listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]>;
  listAllArtifacts(): Promise<ArtifactSummary[]>;
  getArtifactManifest(artifactId: string): Promise<ArtifactManifestModel>;
  getArtifactText(artifactId: string, contentHash: string): Promise<string>;
  createProjectFileProposal(input: ProjectFileProposalInput): Promise<ProjectFileProposalResult>;
  listProjectFiles?(projectId: string): Promise<ProjectFilesSnapshot>;
  getProjectFileContent?(projectId: string, path: string): Promise<ProjectFileContent>;
  archiveProject?(projectId: string): Promise<ProjectLifecycleResult>;
  restoreProject?(projectId: string): Promise<ProjectLifecycleResult>;
  purgeProject?(projectId: string): Promise<ProjectLifecycleResult>;
  getProposal(proposalId: string): Promise<ProposalDetailModel>;
  reviewProposal?(proposalId: string, input: ReviewInput): Promise<ReviewResult>;
  listSkills?(filters?: Record<string, string>): Promise<RegistrySkillDetail[]>;
  listExternalSkills?(filters?: Record<string, string>): Promise<ExternalSkill[]>;
  getExternalSkill?(id: string): Promise<ExternalSkill>;
  createExternalSkill?(input: CreateExternalSkillRequest): Promise<ExternalSkill>;
  patchExternalSkill?(id: string, input: PatchExternalSkillRequest): Promise<ExternalSkill>;
  refreshExternalSkill?(id: string): Promise<ExternalSkill>;
  deleteExternalSkill?(id: string): Promise<{ id: string; deleted: boolean }>;
  listSkillArtifacts?(): Promise<RegistryArtifact[]>;
  getSkill?(slug: string): Promise<RegistrySkillDetail>;
  listSkillVersions?(slug: string, agent?: RegistryAgent): Promise<RegistrySkillVersion[]>;
  getSkillAdapterPreview?(slug: string, agent: RegistryAgent): Promise<{ path: string; content: string; sourceIrHash: string; compilerVersion: string; adapter: string }>;
  downloadSkillArtifact?(slug: string, agent: RegistryAgent): Promise<{ blob: Blob; hash: string; filename: string }>;
  listTags?(): Promise<RegistryTag[]>;
  createTag?(slug: string, label: string): Promise<RegistryTag>;
  updateTag?(tagId: string, input: { revision: number; label?: string; active?: boolean }): Promise<RegistryTag>;
  mergeTag?(tagId: string, targetTagId: string, revision: number): Promise<RegistryTag>;
  bindSkillTag?(skillSlug: string, tagId: string, remove?: boolean): Promise<RegistrySkillDetail>;
  listWorkflowFamilies?(): Promise<WorkflowFamily[]>;
  createWorkflowFamily?(input: WorkflowFamilyMutation): Promise<WorkflowFamily>;
  getWorkflowFamily?(slug: string): Promise<WorkflowFamily>;
  uploadWorkflowFamilyProfileDraft?(slug: string, profile: string, form: FormData): Promise<WorkflowFamilyDraftState>;
  getWorkflowFamilyDraft?(slug: string): Promise<WorkflowFamilyDraftState>;
  discardWorkflowFamilyDraft?(slug: string, revision: number): Promise<{ slug: string; discarded: boolean }>;
  runWorkflowFamilyDraftChecks?(slug: string): Promise<SkillCheckResult>;
  publishWorkflowFamilyDraft?(slug: string, req: PublishWorkflowFamilyRequest): Promise<WorkflowFamilyVersion>;
  diffWorkflowFamilyDraft?(slug: string, profile?: string): Promise<SkillDiffFile[]>;
  listWorkflowFamilyVersions?(slug: string): Promise<WorkflowFamilyVersion[]>;
  syncWorkflowFamily?(slug: string): Promise<{ updated: boolean; version?: string }>;
  getChangeArchive?(projectId: string, changeKey: string): Promise<ChangeArchiveSummary>;
  getChangeArchiveContent?(projectId: string, changeKey: string, path: string): Promise<{ content: string }>;
  downloadWorkflowFamilyArtifact?(slug: string, profile: string, version?: string): Promise<{ blob: Blob; hash: string; filename: string }>;
  getProjectWorkflowBinding?(projectId: string): Promise<RegistryProjectWorkflowBinding | null>;
  bindProjectWorkflow?(projectId: string, familySlug: string, profile: string, revision: number | null, version?: string | null): Promise<RegistryProjectWorkflowBinding>;
  getProjectSemanticOverview?(projectId: string): Promise<SemanticOverview>;
  listProjectSemanticKnowledge?(
    projectId: string,
    options?: { limit?: number; cursor?: string | null; includeBody?: boolean }
  ): Promise<{ items: SemanticDocument[]; total: number; next_cursor: string | null }>;
  listProjectSemanticRules?(projectId: string): Promise<SemanticDocument[]>;
  listProjectSemanticChanges?(projectId: string): Promise<SemanticDocument[]>;
  getProjectSemanticGraph?(projectId: string, focusDocumentId?: string): Promise<ProjectSemanticGraph>;
  searchSemanticDocuments?(query: string, projectId?: string): Promise<Array<{ document: SemanticDocument; project_id: string }>>;
  listKnowledgeEntries?(projectId: string, options?: {
    status?: string;
    limit?: number;
  }): Promise<KnowledgeIngestListItem[]>;
  getKnowledgeProjectionStatus?(projectId: string): Promise<{
    pending_count: number;
    pending_capped: boolean;
  }>;
  updateKnowledgeEntryStatus?(
    projectId: string,
    entryId: string,
    status: string
  ): Promise<{ entry_id: string; status: string; updated_at: string }>;
  listProjectRuns?(
    projectId: string,
    options?: { limit?: number; cursor?: string | null; status?: string }
  ): Promise<{ items: RunSummary[]; total: number; next_cursor: string | null }>;
  getProjectRun?(projectId: string, runId: string): Promise<RunSummary>;
  listProjectRunEvents?(
    projectId: string,
    runId: string,
    afterCursor?: number
  ): Promise<{ items: RunEventSummary[]; next_cursor: number }>;
  streamProjectRunEvents?(
    projectId: string,
    runId: string,
    afterCursor: number,
    handlers: {
      onEvent: (event: RunEventSummary) => void;
      onRun?: (run: RunSummary) => void;
      onError?: (error: unknown) => void;
    }
  ): Promise<{ abort: () => void } | null>;
  uploadSkillDraft?(form: FormData, agent: RegistryAgent): Promise<DraftState>;
  getSkillDraft?(slug: string, agent: RegistryAgent): Promise<DraftState>;
  discardSkillDraft?(slug: string, agent: RegistryAgent, revision: number): Promise<{ slug: string; discarded: boolean }>;
  runSkillDraftChecks?(slug: string, agent: RegistryAgent): Promise<SkillCheckResult>;
  publishSkillDraft?(slug: string, agent: RegistryAgent, req: PublishSkillRequest): Promise<RegistrySkillVersion>;
  publishSkill?(slug: string, req: PublishUnifiedSkillRequest): Promise<PublishSkillResponse>;
  releaseSkillToNpm?(slug: string): Promise<NpmReleaseResponse>;
  releaseWorkflowFamilyToNpm?(slug: string): Promise<NpmReleaseResponse>;
  diffSkillDraft?(slug: string, agent: RegistryAgent): Promise<SkillDiffFile[]>;
  setDefaultAgent?(slug: string, agent: RegistryAgent, revision: number): Promise<RegistrySkillDetail>;
  deleteSkill?(slug: string): Promise<{ slug: string; deleted: boolean }>;
  listAiProviders?(): Promise<{ items: AiProviderWithKeySet[]; default_provider: string | null }>;
  createAiProvider?(input: {
    provider_id: string; label: string; base_url: string; model: string;
    enabled: boolean; api_key_env: string; is_default?: boolean;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
    models?: ProviderModel[]; api_format?: AiProviderApiFormat;
    note?: string; website?: string; selected_model_id?: string | null; sort_order?: number;
    api_key?: string;
  }): Promise<AiProviderConfig>;
  updateAiProvider?(providerId: string, revision: number, patch: {
    label?: string; base_url?: string; model?: string; enabled?: boolean; api_key_env?: string;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
    models?: ProviderModel[]; api_format?: AiProviderApiFormat;
    note?: string; website?: string; selected_model_id?: string | null; sort_order?: number;
    api_key?: string;
  }): Promise<AiProviderConfig>;
  reorderAiProviders?(providerIds: string[]): Promise<{ provider_ids: string[] }>;
  deleteAiProvider?(providerId: string): Promise<{ provider_id: string; deleted: boolean }>;
  testAiProvider?(providerId: string): Promise<{ provider_id: string; ok: boolean; model?: string; error?: string }>;
  setAiProviderKey?(providerId: string, key: { api_key: string; base_url?: string; model?: string }): Promise<{ provider_id: string; key_set: boolean }>;
  getAiUsage?(): Promise<AiQuotaUsage[]>;
  runSkillAiChecks?(slug: string, agent: RegistryAgent): Promise<{ jobId: string; status: string }>;
  getAiJob?(jobId: string): Promise<AiJobState>;
  previewSkillFix?(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan>;
  applySkillFix?(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<DraftState>;
  generateReleaseNote?(slug: string, agent: RegistryAgent): Promise<{ releaseNote: string | null; generatedAt: string; degraded?: boolean; reason?: string }>;
  fetchFixSuggestions?(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan>;
  applyFixSuggestion?(slug: string, agent: RegistryAgent, input: { checkId: string; suggestedContent: string; appliesTo: string | null }): Promise<DraftState>;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(redact(message));
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function redact(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z]:\\[^\s]+/g, "[REDACTED_PATH]")
    .slice(0, 500);
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return "sha256:" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildUploadFormData(files: File[], review?: SensitiveReviewSubmission): FormData {
  const fd = new FormData();
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const filename = rel && rel.length > 0 ? rel : f.name;
    fd.append("file", f, filename);
  }
  if (review !== undefined) fd.append("sensitive_review", JSON.stringify(review));
  return fd;
}

export class HttpHunterApi implements HunterApi {
  readonly baseUrl: string;
  readonly tokenProvider: () => string | null;
  readonly fetch: typeof globalThis.fetch;

  constructor(options: {
    baseUrl: string;
    tokenProvider: () => string | null;
    fetch?: typeof globalThis.fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    const headers = new Headers({
      Accept: "application/json",
      Authorization: "Bearer " + token,
      "X-Request-Id": uuid()
    });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
      headers.set("Idempotency-Key", uuid());
    }
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw new ApiClientError(0, "NETWORK_ERROR", "Unable to reach the governance server while requesting " + path + ".");
    }
    const payload = await response.json() as {
      error?: { code?: string; message?: string; details?: unknown };
    } & T;
    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        payload.error?.code ?? "HTTP_ERROR",
        payload.error?.message ?? "Governance request failed.",
        payload.error?.details
      );
    }
    return payload;
  }

  private async binaryRequest(
    method: string,
    path: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>
  ): Promise<void> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    const uploadBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const response = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "X-Request-Id": uuid(),
        "Idempotency-Key": uuid(),
        ...headers
      },
      body: uploadBody
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new ApiClientError(response.status, payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? "Upload failed.");
    }
  }

  async listProjects(state: "active" | "archived" = "active"): Promise<ProjectSummary[]> {
    const items: ProjectSummary[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100", state });
      if (cursor !== null) query.set("cursor", cursor);
      const result = await this.request<{
        items: ProjectSummary[];
        page: { next_cursor: string | null };
      }>("GET", "/api/v1/projects?" + query.toString());
      items.push(...result.items);
      cursor = result.page.next_cursor;
    } while (cursor !== null);
    return items;
  }

  async getDashboardOverview(days = 7): Promise<DashboardOverview> {
    return this.request("GET", "/api/v1/dashboard/overview?days=" + encodeURIComponent(String(days)));
  }

  async getProject(projectId: string): Promise<ProjectDetailModel> {
    return this.request("GET", "/api/v1/projects/" + encodeURIComponent(projectId));
  }

  async createProject(input: {
    display_name: string;
    withKey?: boolean;
  }): Promise<ProjectSummary & { api_key?: string; key_id?: string }> {
    const query = input.withKey === true ? "?withKey=true" : "";
    const result = await this.request<
      | { project: ProjectSummary; api_key?: string; key_id?: string }
      | (ProjectSummary & { api_key?: string; key_id?: string })
    >(
      "POST",
      "/api/v1/projects" + query,
      { display_name: input.display_name }
    );
    if ("project" in result) {
      return {
        ...result.project,
        ...(result.api_key === undefined ? {} : { api_key: result.api_key }),
        ...(result.key_id === undefined ? {} : { key_id: result.key_id })
      };
    }
    return result;
  }

  async listProjectFiles(projectId: string): Promise<ProjectFilesSnapshot> {
    return this.request("GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/files");
  }

  async getProjectFileContent(projectId: string, path: string): Promise<ProjectFileContent> {
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/files/content?path=" + encodeURIComponent(path)
    );
  }

  async archiveProject(projectId: string): Promise<ProjectLifecycleResult> {
    return this.request("DELETE", "/api/v1/projects/" + encodeURIComponent(projectId));
  }

  async restoreProject(projectId: string): Promise<ProjectLifecycleResult> {
    return this.request("POST", "/api/v1/projects/" + encodeURIComponent(projectId) + "/restore", {});
  }

  async purgeProject(projectId: string): Promise<ProjectLifecycleResult> {
    return this.request("DELETE", "/api/v1/projects/" + encodeURIComponent(projectId) + "/purge");
  }

  async listProjectProposals(projectId: string): Promise<ProposalSummary[]> {
    const result = await this.request<{ items: ProposalSummary[] }>(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/proposals?limit=100"
    );
    return result.items.map((item) => ({ ...item, project_id: projectId }));
  }

  async listAllProposals(): Promise<ProposalSummary[]> {
    const projects = await this.listProjects();
    return (await Promise.all(projects.map(async (project) =>
      this.listProjectProposals(project.project_id)
    ))).flat().sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]> {
    const result = await this.request<{ items: ArtifactSummary[] }>(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/artifacts?limit=100"
    );
    return result.items;
  }

  async listAllArtifacts(): Promise<ArtifactSummary[]> {
    const projects = await this.listProjects();
    return (await Promise.all(projects.map(async (project) =>
      this.listProjectArtifacts(project.project_id)
    ))).flat().sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async getArtifactManifest(artifactId: string): Promise<ArtifactManifestModel> {
    return this.request("GET", "/api/v1/artifacts/" + encodeURIComponent(artifactId) + "/manifest");
  }

  async getArtifactText(artifactId: string, contentHash: string): Promise<string> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    const response = await this.fetch(
      this.baseUrl + "/api/v1/artifacts/" + encodeURIComponent(artifactId) + "/blobs/" + encodeURIComponent(contentHash),
      { method: "GET", headers: { Accept: "text/plain", Authorization: "Bearer " + token, "X-Request-Id": uuid() } }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new ApiClientError(response.status, payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? "Artifact content is unavailable.");
    }
    const content = await response.text();
    if (await sha256Text(content) !== contentHash || response.headers.get("X-Content-SHA256") !== contentHash) {
      throw new ApiClientError(422, "ARTIFACT_HASH_MISMATCH", "Artifact content failed integrity verification.");
    }
    return content;
  }

  async createProjectFileProposal(input: ProjectFileProposalInput): Promise<ProjectFileProposalResult> {
    const encoded = input.content === undefined ? undefined : new TextEncoder().encode(input.content);
    const contentHash = encoded === undefined ? undefined : await sha256Text(input.content ?? "");
    let operation: FileOperation;
    if (input.action === "delete") {
      if (input.baseContentHash === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "A delete proposal requires the current file hash.");
      operation = {
        operation: "delete",
        path: input.path,
        file_kind: input.fileKind,
        base_content_sha256: input.baseContentHash,
        tombstone: { deleted_at: new Date().toISOString(), reason: "Web Console proposal", previous_sha256: input.baseContentHash }
      };
    } else if (input.action === "add") {
      if (contentHash === undefined || encoded === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "An add proposal requires content.");
      operation = { operation: "add", path: input.path, file_kind: input.fileKind, content_sha256: contentHash, size_bytes: encoded.byteLength };
    } else if (input.action === "modify") {
      if (contentHash === undefined || encoded === undefined || input.baseContentHash === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "A modification proposal requires content and the current file hash.");
      operation = { operation: "modify", path: input.path, file_kind: input.fileKind, base_content_sha256: input.baseContentHash, content_sha256: contentHash, size_bytes: encoded.byteLength };
    } else {
      if (contentHash === undefined || encoded === undefined || input.baseContentHash === undefined || input.targetPath === undefined) throw new ApiClientError(400, "VALIDATION_FAILED", "A rename proposal requires content, source hash, and target path.");
      operation = { operation: "rename", from_path: input.path, to_path: input.targetPath, file_kind: input.fileKind, base_content_sha256: input.baseContentHash, content_sha256: contentHash, size_bytes: encoded.byteLength };
    }
    const session = await this.request<{
      session_id: string;
      missing_blobs: string[];
    }>("POST", "/api/v1/projects/" + encodeURIComponent(input.projectId) + "/proposal-sessions", {
      schema_version: 1,
      request_id: uuid(),
      client_id: "cli_web_console",
      base_project_version: input.baseProjectVersion,
      base_manifest_hash: input.baseManifestHash,
      proposal_manifest: { files: [operation] },
      artifact_manifest: { schema_version: 1, files: [operation] },
      confirmations: {
        project_local_paths: input.confirmProjectLocal
          ? [...new Set([input.path, input.targetPath].filter((path): path is string => path !== undefined))]
          : []
      }
    });
    if (contentHash !== undefined && encoded !== undefined && session.missing_blobs.includes(contentHash)) {
      await this.binaryRequest("PUT", "/api/v1/proposal-sessions/" + encodeURIComponent(session.session_id) + "/blobs/" + encodeURIComponent(contentHash), encoded, {
        "Content-Type": "application/octet-stream",
        "Content-Range": encoded.byteLength === 0
          ? "bytes */0"
          : "bytes 0-" + (encoded.byteLength - 1) + "/" + encoded.byteLength,
        "X-Chunk-SHA256": contentHash
      });
    }
    return this.request("POST", "/api/v1/proposal-sessions/" + encodeURIComponent(session.session_id) + ":finalize", {
      schema_version: 1,
      manifest_sha256: await sha256Text(canonicalJson([operation])),
      base_artifact_id: input.baseArtifactId ?? null
    });
  }

  async getProposal(proposalId: string): Promise<ProposalDetailModel> {
    return this.request(
      "GET",
      "/api/v1/proposals/" + encodeURIComponent(proposalId)
    );
  }

  async listSkills(filters: Record<string, string> = {}): Promise<RegistrySkillDetail[]> {
    const query = new URLSearchParams(filters);
    const result = await this.request<{ items: RegistrySkillDetail[] }>(
      "GET", "/api/v1/skills" + (query.size === 0 ? "" : "?" + query.toString())
    );
    return result.items;
  }

  async listExternalSkills(filters: Record<string, string> = {}): Promise<ExternalSkill[]> {
    const query = new URLSearchParams(filters);
    const result = await this.request<{ items: ExternalSkill[] }>(
      "GET", "/api/v1/external-skills" + (query.size === 0 ? "" : "?" + query.toString())
    );
    return result.items;
  }

  async getExternalSkill(id: string): Promise<ExternalSkill> {
    return this.request("GET", "/api/v1/external-skills/" + encodeURIComponent(id));
  }

  async createExternalSkill(input: CreateExternalSkillRequest): Promise<ExternalSkill> {
    return this.request("POST", "/api/v1/external-skills", input);
  }

  async patchExternalSkill(id: string, input: PatchExternalSkillRequest): Promise<ExternalSkill> {
    return this.request("PATCH", "/api/v1/external-skills/" + encodeURIComponent(id), input);
  }

  async refreshExternalSkill(id: string): Promise<ExternalSkill> {
    return this.request("POST", "/api/v1/external-skills/" + encodeURIComponent(id) + "/refresh");
  }

  async deleteExternalSkill(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request("DELETE", "/api/v1/external-skills/" + encodeURIComponent(id));
  }

  async listSkillArtifacts(): Promise<RegistryArtifact[]> {
    return (await this.request<{ items: RegistryArtifact[] }>("GET", "/api/v1/skill-artifacts")).items;
  }

  async getSkill(slug: string): Promise<RegistrySkillDetail> {
    return this.request("GET", "/api/v1/skills/" + encodeURIComponent(slug));
  }

  async listSkillVersions(slug: string, agent?: RegistryAgent): Promise<RegistrySkillVersion[]> {
    const base = "/api/v1/skills/" + encodeURIComponent(slug) + "/versions";
    const path = agent === undefined ? base : base + "?agent=" + encodeURIComponent(agent);
    const result = await this.request<{ items: RegistrySkillVersion[] }>("GET", path);
    return result.items;
  }

  async getSkillAdapterPreview(slug: string, agent: RegistryAgent): Promise<{
    path: string;
    content: string;
    sourceIrHash: string;
    compilerVersion: string;
    adapter: string;
  }> {
    return this.request(
      "GET",
      "/api/v1/skills/" + encodeURIComponent(slug) + "/adapter-preview/" + encodeURIComponent(agent)
    );
  }

  async downloadSkillArtifact(
    slug: string,
    agent: RegistryAgent
  ): Promise<{ blob: Blob; hash: string; filename: string }> {
    const token = this.tokenProvider();
    if (token === null || token === "") throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    const response = await this.fetch(
      this.baseUrl + "/api/v1/skills/" + encodeURIComponent(slug) + "/artifacts/" + encodeURIComponent(agent) + "/download",
      { headers: { Authorization: "Bearer " + token, "X-Request-Id": uuid() } }
    );
    if (!response.ok) throw new ApiClientError(response.status, "DOWNLOAD_FAILED", "Skill artifact download failed.");
    return {
      blob: await response.blob(),
      hash: response.headers.get("X-Content-SHA256") ?? "",
      filename: /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? slug + ".zip"
    };
  }

  async listTags(): Promise<RegistryTag[]> {
    return (await this.request<{ items: RegistryTag[] }>("GET", "/api/v1/tags")).items;
  }

  async createTag(slug: string, label: string): Promise<RegistryTag> {
    return this.request("POST", "/api/v1/tags", { schema_version: 1, slug, label });
  }

  async updateTag(tagId: string, input: { revision: number; label?: string; active?: boolean }): Promise<RegistryTag> {
    return this.request("PATCH", "/api/v1/tags/" + encodeURIComponent(tagId), input);
  }

  async mergeTag(tagId: string, targetTagId: string, revision: number): Promise<RegistryTag> {
    return this.request("POST", "/api/v1/tags/" + encodeURIComponent(tagId) + "/merge", {
      revision, target_tag_id: targetTagId
    });
  }

  async bindSkillTag(skillSlug: string, tagId: string, remove = false): Promise<RegistrySkillDetail> {
    return this.request(remove ? "DELETE" : "PUT", "/api/v1/skills/" + encodeURIComponent(skillSlug) + "/tags/" + encodeURIComponent(tagId), {});
  }

  async listWorkflowFamilies(): Promise<WorkflowFamily[]> {
    return (await this.request<{ items: WorkflowFamily[] }>("GET", "/api/v1/workflow-families")).items;
  }

  async createWorkflowFamily(input: WorkflowFamilyMutation): Promise<WorkflowFamily> {
    return this.request("POST", "/api/v1/workflow-families", { schema_version: 1, ...input });
  }

  async getWorkflowFamily(slug: string): Promise<WorkflowFamily> {
    return this.request("GET", "/api/v1/workflow-families/" + encodeURIComponent(slug));
  }

  async uploadWorkflowFamilyProfileDraft(slug: string, profile: string, form: FormData): Promise<WorkflowFamilyDraftState> {
    return this.multipartRequest<WorkflowFamilyDraftState>(
      "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/draft/profiles/" + encodeURIComponent(profile),
      form
    );
  }

  async getWorkflowFamilyDraft(slug: string): Promise<WorkflowFamilyDraftState> {
    return this.request("GET", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/draft");
  }

  async discardWorkflowFamilyDraft(slug: string, revision: number): Promise<{ slug: string; discarded: boolean }> {
    return this.request("DELETE", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/draft", { revision });
  }

  async runWorkflowFamilyDraftChecks(slug: string): Promise<SkillCheckResult> {
    return this.request("POST", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/draft/checks", {});
  }

  async publishWorkflowFamilyDraft(slug: string, req: PublishWorkflowFamilyRequest): Promise<WorkflowFamilyVersion> {
    return this.request("POST", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/publish", req);
  }

  async diffWorkflowFamilyDraft(slug: string, profile?: string): Promise<SkillDiffFile[]> {
    const suffix = profile === undefined ? "" : "?profile=" + encodeURIComponent(profile);
    const result = await this.request<{ items: SkillDiffFile[] }>(
      "GET", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/draft/diff" + suffix
    );
    return result.items;
  }

  async listWorkflowFamilyVersions(slug: string): Promise<WorkflowFamilyVersion[]> {
    const result = await this.request<{ items: WorkflowFamilyVersion[] }>(
      "GET", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/versions"
    );
    return result.items;
  }

  async downloadWorkflowFamilyArtifact(
    slug: string,
    profile: string,
    version?: string
  ): Promise<{ blob: Blob; hash: string; filename: string }> {
    const token = this.tokenProvider();
    if (token === null || token === "") throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    const query = version === undefined ? "" : "?version=" + encodeURIComponent(version);
    const response = await this.fetch(
      this.baseUrl + "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/artifacts/" + encodeURIComponent(profile) + "/download" + query,
      { headers: { Authorization: "Bearer " + token, "X-Request-Id": uuid() } }
    );
    if (!response.ok) throw new ApiClientError(response.status, "DOWNLOAD_FAILED", "Workflow family artifact download failed.");
    return {
      blob: await response.blob(),
      hash: response.headers.get("X-Content-SHA256") ?? "",
      filename: /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? slug + "-" + profile + ".zip"
    };
  }

  async getProjectWorkflowBinding(projectId: string): Promise<RegistryProjectWorkflowBinding | null> {
    const result = await this.request<{ binding: RegistryProjectWorkflowBinding | null }>(
      "GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/workflow-binding"
    );
    return result.binding;
  }

  async bindProjectWorkflow(
    projectId: string,
    familySlug: string,
    profile: string,
    revision: number | null,
    version?: string | null
  ): Promise<RegistryProjectWorkflowBinding> {
    return this.request("PUT", "/api/v1/projects/" + encodeURIComponent(projectId) + "/workflow-binding", {
      schema_version: 1,
      family_slug: familySlug,
      profile,
      revision,
      ...(version === undefined ? {} : { version })
    });
  }

  async getProjectSemanticOverview(projectId: string): Promise<SemanticOverview> {
    return this.request("GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/semantic/overview");
  }

  async listProjectSemanticKnowledge(
    projectId: string,
    options: { limit?: number; cursor?: string | null; includeBody?: boolean } = {}
  ): Promise<{ items: SemanticDocument[]; total: number; next_cursor: string | null }> {
    const items: SemanticDocument[] = [];
    let cursor: string | null = options.cursor ?? null;
    let total: number;
    const pageLimit = options.limit ?? 100;
    const includeBody = options.includeBody === true;
    // When caller passes an explicit cursor, return a single page; otherwise drain.
    const singlePage = options.cursor !== undefined;
    do {
      const query = new URLSearchParams({
        limit: String(pageLimit),
        include_body: includeBody ? "1" : "0"
      });
      if (cursor !== null) query.set("cursor", cursor);
      const result = await this.request<{
        items: SemanticDocument[];
        total: number;
        next_cursor: string | null;
      }>(
        "GET",
        "/api/v1/projects/" + encodeURIComponent(projectId) + "/semantic/knowledge?" + query.toString()
      );
      items.push(...result.items);
      total = result.total;
      cursor = result.next_cursor;
      if (singlePage) break;
    } while (cursor !== null);
    return { items, total, next_cursor: singlePage ? cursor : null };
  }

  async listProjectSemanticRules(projectId: string): Promise<SemanticDocument[]> {
    const result = await this.request<{ items: SemanticDocument[] }>(
      "GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/semantic/rules"
    );
    return result.items;
  }

  async listProjectSemanticChanges(projectId: string): Promise<SemanticDocument[]> {
    const result = await this.request<{ items: SemanticDocument[] }>(
      "GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/semantic/changes"
    );
    return result.items;
  }

  async getProjectSemanticGraph(projectId: string, focusDocumentId?: string): Promise<ProjectSemanticGraph> {
    const query = focusDocumentId === undefined
      ? ""
      : "?focus_document_id=" + encodeURIComponent(focusDocumentId);
    return this.request("GET", "/api/v1/projects/" + encodeURIComponent(projectId) + "/semantic/graph" + query);
  }

  async searchSemanticDocuments(
    query: string,
    projectId?: string
  ): Promise<Array<{ document: SemanticDocument; project_id: string }>> {
    const params = new URLSearchParams({ q: query });
    if (projectId !== undefined) params.set("project_id", projectId);
    const result = await this.request<{ items: Array<{ document: SemanticDocument; project_id: string }> }>(
      "GET", "/api/v1/semantic/search?" + params.toString()
    );
    return result.items;
  }

  async listKnowledgeEntries(
    projectId: string,
    options: { status?: string; limit?: number } = {}
  ): Promise<KnowledgeIngestListItem[]> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString() === "" ? "" : "?" + params.toString();
    const result = await this.request<{ items: KnowledgeIngestListItem[]; projected_pending?: number }>(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/knowledge/entries" + query
    );
    return result.items;
  }

  async getKnowledgeProjectionStatus(projectId: string): Promise<{
    pending_count: number;
    pending_capped: boolean;
  }> {
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/knowledge/projection-status"
    );
  }

  async updateKnowledgeEntryStatus(
    projectId: string,
    entryId: string,
    status: string
  ): Promise<{ entry_id: string; status: string; updated_at: string }> {
    return this.request(
      "POST",
      "/api/v1/projects/" + encodeURIComponent(projectId) +
        "/knowledge/entries/" + encodeURIComponent(entryId) + "/status",
      { status }
    );
  }

  async listProjectRuns(
    projectId: string,
    options: { limit?: number; cursor?: string | null; status?: string } = {}
  ): Promise<{ items: RunSummary[]; total: number; next_cursor: string | null }> {
    const items: RunSummary[] = [];
    let cursor: string | null = options.cursor ?? null;
    let total: number;
    const pageLimit = options.limit ?? 100;
    const singlePage = options.cursor !== undefined;
    do {
      const query = new URLSearchParams({ limit: String(pageLimit) });
      if (cursor !== null) query.set("cursor", cursor);
      if (options.status !== undefined) query.set("status", options.status);
      const result = await this.request<{
        items: RunSummary[];
        total: number;
        next_cursor: string | null;
      }>(
        "GET",
        "/api/v1/projects/" + encodeURIComponent(projectId) + "/runs?" + query.toString()
      );
      items.push(...result.items);
      total = result.total;
      cursor = result.next_cursor;
      if (singlePage) break;
    } while (cursor !== null);
    return { items, total, next_cursor: singlePage ? cursor : null };
  }

  async syncWorkflowFamily(slug: string): Promise<{ updated: boolean; version?: string }> {
    return this.request(
      "POST",
      "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/sync",
      {}
    );
  }

  async getChangeArchive(projectId: string, changeKey: string): Promise<ChangeArchiveSummary> {
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) +
        "/changes/" + encodeURIComponent(changeKey) + "/archive"
    );
  }

  async getChangeArchiveContent(
    projectId: string,
    changeKey: string,
    path: string
  ): Promise<{ content: string }> {
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) +
        "/changes/" + encodeURIComponent(changeKey) +
        "/archive/content?path=" + encodeURIComponent(path)
    );
  }

  async getProjectRun(projectId: string, runId: string): Promise<RunSummary> {
    const result = await this.request<{ run: RunSummary }>(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) +
        "/runs/" + encodeURIComponent(runId)
    );
    return result.run;
  }

  async listProjectRunEvents(
    projectId: string,
    runId: string,
    afterCursor = 0
  ): Promise<{ items: RunEventSummary[]; next_cursor: number }> {
    return this.request(
      "GET",
      "/api/v1/projects/" + encodeURIComponent(projectId) +
        "/runs/" + encodeURIComponent(runId) +
        "/events?after_cursor=" + encodeURIComponent(String(afterCursor))
    );
  }

  /**
   * SSE stream via fetch (Authorization header supported). Returns null if the
   * stream cannot be opened; callers should fall back to REST polling.
   */
  async streamProjectRunEvents(
    projectId: string,
    runId: string,
    afterCursor: number,
    handlers: {
      onEvent: (event: RunEventSummary) => void;
      onRun?: (run: RunSummary) => void;
      onError?: (error: unknown) => void;
    }
  ): Promise<{ abort: () => void } | null> {
    const token = this.tokenProvider();
    if (token === null || token === "") return null;
    const controller = new AbortController();
    const path =
      "/api/v1/projects/" + encodeURIComponent(projectId) +
      "/runs/" + encodeURIComponent(runId) +
      "/stream?after_cursor=" + encodeURIComponent(String(afterCursor));
    try {
      const response = await this.fetch(this.baseUrl + path, {
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer " + token,
          "X-Request-Id": globalThis.crypto.randomUUID(),
          ...(afterCursor > 0 ? { "Last-Event-ID": String(afterCursor) } : {})
        },
        signal: controller.signal
      });
      if (!response.ok || response.body === null) {
        handlers.onError?.(new ApiClientError(response.status, "SSE_FAILED", "SSE stream failed"));
        return null;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (!controller.signal.aborted) {
                handlers.onError?.(new Error("SSE_STREAM_CLOSED"));
              }
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const lines = chunk.split("\n");
              let eventName = "message";
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
              }
              if (dataLines.length === 0) continue;
              try {
                const data = JSON.parse(dataLines.join("\n")) as unknown;
                if (eventName === "event") handlers.onEvent(data as RunEventSummary);
                else if (eventName === "run" || eventName === "snapshot") handlers.onRun?.(data as RunSummary);
              } catch {
                // ignore malformed SSE payloads
              }
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) handlers.onError?.(error);
        }
      })();
      return { abort: () => controller.abort() };
    } catch (error) {
      handlers.onError?.(error);
      return null;
    }
  }

  private async multipartRequest<T>(path: string, formData: FormData): Promise<T> {
    const token = this.tokenProvider();
    if (token === null || token === "") {
      throw new ApiClientError(401, "AUTH_REQUIRED", "Authentication required.");
    }
    let response: Response;
    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: "Bearer " + token
      });
      headers.set("X-Request-Id", uuid());
      headers.set("Idempotency-Key", uuid());
      response = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers,
        body: formData
      });
    } catch {
      throw new ApiClientError(0, "NETWORK_ERROR", "Unable to reach the governance server while uploading " + path + ".");
    }
    const payload = await response.json() as { error?: { code?: string; message?: string; details?: unknown } } & T;
    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        payload.error?.code ?? "HTTP_ERROR",
        payload.error?.message ?? "Skill upload failed.",
        payload.error?.details
      );
    }
    return payload;
  }

  private draftPath(slug: string, agent: RegistryAgent, suffix = ""): string {
    return "/api/v1/skills/" + encodeURIComponent(slug) + "/draft/" + encodeURIComponent(agent) + suffix;
  }

  async uploadSkillDraft(form: FormData, agent: RegistryAgent): Promise<DraftState> {
    return this.multipartRequest<DraftState>("/api/v1/skills/draft?agent=" + encodeURIComponent(agent), form);
  }

  async getSkillDraft(slug: string, agent: RegistryAgent): Promise<DraftState> {
    return this.request("GET", this.draftPath(slug, agent));
  }

  async discardSkillDraft(slug: string, agent: RegistryAgent, revision: number): Promise<{ slug: string; discarded: boolean }> {
    return this.request("DELETE", this.draftPath(slug, agent), { revision });
  }

  async runSkillDraftChecks(slug: string, agent: RegistryAgent): Promise<SkillCheckResult> {
    return this.request("POST", this.draftPath(slug, agent, "/checks"), {});
  }

  async publishSkillDraft(slug: string, agent: RegistryAgent, req: PublishSkillRequest): Promise<RegistrySkillVersion> {
    return this.request("POST", this.draftPath(slug, agent, "/publish"), req);
  }

  async publishSkill(slug: string, req: PublishUnifiedSkillRequest): Promise<PublishSkillResponse> {
    return this.request("POST", "/api/v1/skills/" + encodeURIComponent(slug) + "/publish", req);
  }

  async releaseSkillToNpm(slug: string): Promise<NpmReleaseResponse> {
    return this.request("POST", "/api/v1/skills/" + encodeURIComponent(slug) + "/npm-release", {});
  }

  async releaseWorkflowFamilyToNpm(slug: string): Promise<NpmReleaseResponse> {
    return this.request("POST", "/api/v1/workflow-families/" + encodeURIComponent(slug) + "/npm-release", {});
  }

  async diffSkillDraft(slug: string, agent: RegistryAgent): Promise<SkillDiffFile[]> {
    const result = await this.request<{ items: SkillDiffFile[] }>("GET", this.draftPath(slug, agent, "/diff"));
    return result.items;
  }

  async setDefaultAgent(slug: string, agent: RegistryAgent, revision: number): Promise<RegistrySkillDetail> {
    const body: SetDefaultAgentRequest = { defaultAgent: agent, revision };
    return this.request("PATCH", "/api/v1/skills/" + encodeURIComponent(slug) + "/default-agent", body);
  }

  async deleteSkill(slug: string): Promise<{ slug: string; deleted: boolean }> {
    return this.request("DELETE", "/api/v1/skills/" + encodeURIComponent(slug), {});
  }

  async listAiProviders(): Promise<{ items: AiProviderWithKeySet[]; default_provider: string | null }> {
    return this.request("GET", "/api/v1/ai-config/providers");
  }
  async createAiProvider(input: {
    provider_id: string; label: string; base_url: string; model: string;
    enabled: boolean; api_key_env: string; is_default?: boolean;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
    models?: ProviderModel[]; api_format?: AiProviderApiFormat;
    note?: string; website?: string; selected_model_id?: string | null; sort_order?: number;
    api_key?: string;
  }): Promise<AiProviderConfig> {
    return this.request("POST", "/api/v1/ai-config/providers", { schema_version: 1, ...input });
  }
  async updateAiProvider(providerId: string, revision: number, patch: {
    label?: string; base_url?: string; model?: string; enabled?: boolean; api_key_env?: string;
    daily_request_limit?: number | null; daily_token_limit?: number | null;
    models?: ProviderModel[]; api_format?: AiProviderApiFormat;
    note?: string; website?: string; selected_model_id?: string | null; sort_order?: number;
    api_key?: string;
  }): Promise<AiProviderConfig> {
    const path = "/api/v1/ai-config/providers/" + encodeURIComponent(providerId);
    const body = { schema_version: 1, revision, ...patch };
    try {
      return await this.request("PATCH", path, body);
    } catch (err) {
      const expected = err instanceof ApiClientError && err.code === "REVISION_CONFLICT"
        && err.details !== null && typeof err.details === "object"
        && typeof (err.details as { expected?: unknown }).expected === "number"
        ? (err.details as { expected: number }).expected
        : null;
      if (expected === null || expected === revision) throw err;
      return this.request("PATCH", path, { ...body, revision: expected });
    }
  }
  async reorderAiProviders(providerIds: string[]): Promise<{ provider_ids: string[] }> {
    return this.request("POST", "/api/v1/ai-config/providers/reorder", { schema_version: 1, provider_ids: providerIds });
  }
  async deleteAiProvider(providerId: string): Promise<{ provider_id: string; deleted: boolean }> {
    return this.request("DELETE", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId), {});
  }
  async testAiProvider(providerId: string): Promise<{ provider_id: string; ok: boolean; model?: string; error?: string }> {
    return this.request("POST", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId) + "/test", {});
  }
  async setAiProviderKey(providerId: string, key: { api_key: string; base_url?: string; model?: string }): Promise<{ provider_id: string; key_set: boolean }> {
    return this.request("POST", "/api/v1/ai-config/providers/" + encodeURIComponent(providerId) + "/key", key);
  }
  async getAiUsage(): Promise<AiQuotaUsage[]> {
    const res = await this.request<{ usage: AiQuotaUsage[] }>("GET", "/api/v1/ai-config/usage");
    return res.usage;
  }
  async runSkillAiChecks(slug: string, agent: RegistryAgent): Promise<{ jobId: string; status: string }> {
    return this.request("POST", this.draftPath(slug, agent, "/ai-checks"), {});
  }
  async getAiJob(jobId: string): Promise<AiJobState> {
    return this.request("GET", "/api/v1/ai-jobs/" + encodeURIComponent(jobId));
  }
  async previewSkillFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    return this.request("POST", this.draftPath(slug, agent, "/fix-preview"), { checkIds });
  }
  async applySkillFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<DraftState> {
    return this.request("POST", this.draftPath(slug, agent, "/apply-fix"), { checkIds });
  }
  async generateReleaseNote(slug: string, agent: RegistryAgent): Promise<{ releaseNote: string | null; generatedAt: string; degraded?: boolean; reason?: string }> {
    return this.request("POST", this.draftPath(slug, agent, "/release-note:generate"), {});
  }
  async fetchFixSuggestions(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    return this.request("POST", this.draftPath(slug, agent, "/fix-suggestions"), { checkIds });
  }
  async applyFixSuggestion(slug: string, agent: RegistryAgent, input: { checkId: string; suggestedContent: string; appliesTo: string | null }): Promise<DraftState> {
    return this.request("POST", this.draftPath(slug, agent, "/apply-fix-suggestion"), input);
  }
}

export function browserApi(): HunterApi {
  return new HttpHunterApi({
    baseUrl: process.env.NEXT_PUBLIC_HUNTER_HARNESS_API_URL ?? "",
    tokenProvider: () => typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem("hunter-harness-token")
  });
}
