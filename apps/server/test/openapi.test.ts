import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import Fastify, { type FastifyInstance } from "fastify";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PLATFORM_INFORMATION_HTTP_OPERATIONS,
  REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS,
  REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS,
  archiveIngestReceiptSchema,
  branchSnapshotSchema,
  contentSyncStatusesSchema,
  getLegacyArchiveCompatibilityResult,
  knowledgeCandidateSchema,
  legacyArchivePackageReceiptSchema,
  platformInformationExportResultSchema,
  platformInformationPageSchema,
  platformInformationListHttpQuerySchema,
  knowledgeExtractionRetryIntentSchema,
  projectContentCandidateSchema,
  remoteSyncArchiveSourceHttpSchema,
  remoteVersionIdentitySchema,
  restoreBranchFilesConfirmationIntentSchema,
  snapshotFileSchema,
  snapshotVersionSchema
} from "@hunter-harness/contracts";

interface OpenApiSchemaNode {
  $id?: string;
  $ref?: string;
  additionalProperties?: boolean;
  const?: string | number | boolean;
  definitions?: Record<string, OpenApiSchemaNode>;
  description?: string;
  enum?: string[];
  items?: OpenApiSchemaNode;
  maximum?: number;
  maxItems?: number;
  properties?: Record<string, OpenApiSchemaNode>;
  required?: string[];
  type?: string | string[];
}

interface OpenApiDocument {
  components: { schemas: Record<string, OpenApiSchemaNode> };
}

async function createOpenApiBodyValidator(
  document: OpenApiDocument,
  schemaName: string
): Promise<{ app: FastifyInstance; accepts: (value: unknown) => Promise<boolean> }> {
  const app = Fastify({
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false
      }
    }
  });
  const rewriteRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteRefs);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !key.startsWith("x-hunter-") && key !== "discriminator")
      .map(([key, entry]) => [
      key === "prefixItems" && Array.isArray(entry) && entry.length === 1
        ? "items"
        : key,
      key === "$ref" && typeof entry === "string"
        ? entry.replace("#/components/schemas/", "#/definitions/")
        : key === "prefixItems" && Array.isArray(entry) && entry.length === 1
          ? rewriteRefs(entry[0])
        : rewriteRefs(entry)
    ]));
  };
  const schema = rewriteRefs(
    structuredClone(document.components.schemas[schemaName])
  ) as OpenApiSchemaNode | undefined;
  if (schema === undefined) throw new Error(`Missing OpenAPI schema ${schemaName}`);
  schema.$id = `content-sync:${schemaName}`;
  schema.definitions = rewriteRefs(
    structuredClone(document.components.schemas)
  ) as Record<string, OpenApiSchemaNode>;
  app.post(`/${schemaName}`, { schema: { body: schema } }, async () => ({ ok: true }));
  await app.ready();
  return {
    app,
    accepts: async (value: unknown) => (await app.inject({
      method: "POST",
      url: `/${schemaName}`,
      payload: value
    })).statusCode === 200
  };
}

describe("OpenAPI v1 contract", () => {
  it("documents the bounded remote content upload and status operations", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8"
    )) as {
      paths: Record<string, Record<string, {
        operationId?: string;
        "x-hunter-auth-source"?: string;
        "x-hunter-project-allowlist-source"?: string;
        "x-hunter-project-key-scope"?: string;
        parameters?: Array<{ name?: string; in?: string; required?: boolean; schema?: { type?: string; minLength?: number; maxLength?: number } }>;
        requestBody?: { content?: Record<string, unknown> };
        responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
      }>>;
    };
    const upload = document.paths[REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_content.path]?.post;
    const status = document.paths[REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_status.path]?.get;

    expect(upload).toMatchObject({
      operationId: REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_content.operation_id,
      "x-hunter-auth-source": "authenticated_principal",
      "x-hunter-project-allowlist-source": "server_authority",
      "x-hunter-project-key-scope": "archive:write",
      requestBody: { content: { "application/zip": expect.anything() } }
    });
    expect(upload?.responses?.["201"]?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/RemoteContentUploadHttpResult");
    expect(upload?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/RemoteContentUploadHttpResult");
    expect(status).toMatchObject({
      operationId: REMOTE_CONTENT_UPLOAD_HTTP_OPERATIONS.upload_status.operation_id,
      "x-hunter-auth-source": "authenticated_principal",
      "x-hunter-project-allowlist-source": "server_authority",
      "x-hunter-project-key-scope": "archive:read"
    });
    expect(status?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/RemoteContentUploadHttpStatus");
  });

  it("documents every optional source binding on archive lookup operations", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8"
    )) as { paths: Record<string, Record<string, { parameters?: Array<{
      name?: string; in?: string; required?: boolean; schema?: { type?: string; minLength?: number; maxLength?: number };
    }> }>>; components: { schemas: Record<string, { properties?: Record<string, { pattern?: string }> }> } };
    for (const path of [
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/status",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/{operation_id}/receipt"
    ]) {
      const parameters = document.paths[path]?.get?.parameters ?? [];
      for (const name of ["commit_sha", "client_id", "change_key"]) {
        expect(parameters).toContainEqual({ name, in: "query", required: false,
          schema: { type: "string", minLength: 1, maxLength: 160 } });
        expect(remoteSyncArchiveSourceHttpSchema.safeParse({ project_id: "project", branch_name: "main", actor_id: "actor",
          [name]: "x".repeat(160) }).success).toBe(true);
        expect(remoteSyncArchiveSourceHttpSchema.safeParse({ project_id: "project", branch_name: "main", actor_id: "actor",
          [name]: "x".repeat(161) }).success).toBe(false);
      }
      const operation = parameters.find((parameter) => parameter.name === "operation_id");
      expect(operation?.schema).toMatchObject({ type: "string", pattern: "^remote_archive_operation:.{1,215}$" });
    }
    for (const name of [
      "RemoteSyncArchiveReceiptHttp", "RemoteSyncArchiveRecordHttp", "RemoteSyncArchiveClaimHttp",
      "RemoteSyncArchivePrepareHttpRequest", "RemoteSyncArchiveStatusHttpResponse"
    ]) {
      expect(document.components.schemas[name]?.properties?.operation_id?.pattern).toBe("^remote_archive_operation:.{1,215}$");
    }
    expect(document.components.schemas.RemoteSyncArchiveClaimHttp?.properties?.capability?.pattern)
      .toBe("^remote_archive_capability:.{1,214}$");
  });

  it("freezes stage 01 content-sync components and the protocol content hash", async () => {
    interface SchemaNode {
      $ref?: string;
      additionalProperties?: boolean;
      const?: string | number | boolean;
      description?: string;
      enum?: string[];
      items?: SchemaNode;
      maxItems?: number;
      properties?: Record<string, SchemaNode>;
      required?: string[];
      type?: string | string[];
    }
    const openApiUrl = new URL("../openapi/hunter-harness-v1.yaml", import.meta.url);
    const bytes = await readFile(openApiUrl);
    const expectedHash = (await readFile(
      new URL("../openapi/hunter-harness-v1.yaml.sha256", import.meta.url),
      "utf8"
    )).trim();
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    const document = parseYaml(bytes.toString("utf8")) as {
      components: { schemas: Record<string, SchemaNode> };
    };
    const schemas = document.components.schemas;

    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(actualHash).toBe(expectedHash);
    expect(schemas.ContentKind?.enum).toEqual([
      "config", "rule", "architecture", "instruction", "branch_file",
      "change_document", "archive_package", "knowledge_entry",
      "knowledge_candidate", "project_content_candidate"
    ]);
    expect(schemas.SyncScope?.enum).toEqual([
      "config", "rules", "architecture", "instructions", "branch_files", "archive"
    ]);
    expect(schemas.SyncDirection?.enum).toEqual(["push", "pull"]);
    expect(schemas.SyncAction?.enum).toEqual([
      "add", "modify", "delete", "restore", "rename", "no_change"
    ]);
    expect(schemas.ConflictResolution?.enum).toEqual([
      "keep_local", "accept_remote", "skip", "cancel"
    ]);
    expect(schemas.PullPolicy?.enum).toEqual([
      "regular", "explicit_source_only", "not_pullable"
    ]);
    expect(schemas.ContentScanPolicy?.enum).toEqual(["required", "skip_content_scan"]);

    expect(schemas.ContentSyncStatuses).toMatchObject({
      additionalProperties: false,
      required: [
        "schema_version", "archive_status", "change_index_status",
        "knowledge_extraction_status", "managed_snapshot_status"
      ]
    });
    for (const name of [
      "ArchiveStatus", "ChangeIndexStatus", "KnowledgeExtractionStatus",
      "ManagedSnapshotStatus", "CandidateProvenance", "ProjectContentCandidate",
      "KnowledgeCandidate", "RemoteVersionIdentity", "BranchSnapshot",
      "SnapshotVersion", "SnapshotFile", "BranchSnapshotPage",
      "SnapshotVersionPage", "SnapshotFilePage", "LegacyArchiveCompatibilityResult"
    ]) {
      expect(schemas[name]?.additionalProperties, name).toBe(false);
    }

    expect(schemas.RemoteVersionIdentity?.required).toEqual([
      "project_id", "branch_name", "commit_sha", "artifact_id", "project_version",
      "uploaded_at", "client_id", "manifest_hash"
    ]);
    expect(schemas.RemoteVersionIdentity?.properties).toHaveProperty("commit_sha");
    expect(schemas.RemoteVersionIdentity?.properties).toHaveProperty("change_key");
    expect(schemas.BranchSnapshot?.required).toEqual([
      "project_id", "branch_name", "latest_version", "artifact_id",
      "manifest_hash", "file_count", "changed_count", "uploaded_at"
    ]);
    expect(schemas.SnapshotVersion?.required).toEqual([
      "branch_name", "project_version", "artifact_id", "manifest_hash", "uploaded_at"
    ]);
    expect(schemas.SnapshotFile?.required).toEqual([
      "path", "content_kind", "size", "content_hash"
    ]);

    for (const name of ["BranchSnapshotPage", "SnapshotVersionPage", "SnapshotFilePage"]) {
      const page = schemas[name];
      expect(page?.required, name).toEqual(["items"]);
      expect(page?.properties?.items?.maxItems, name).toBe(100);
      expect(page?.properties?.next_cursor?.description, name).toContain("opaque");
      expect(page?.description, name).toContain("tie-breaker");
    }

    const legacy = schemas.ArchivePackageReceipt;
    expect(legacy?.required).toEqual([
      "schema_version", "archive_id", "project_id", "change_key",
      "package_sha256", "manifest_sha256", "artifact_id", "archive_status",
      "knowledge_status", "stored_files", "uploaded_at", "request_id"
    ]);
    expect(legacy?.properties?.archive_status?.const).toBe("durable");
    expect(legacy?.properties?.knowledge_status?.enum).toEqual([
      "indexing", "ready", "failed"
    ]);
  });

  it("covers every implemented public HTTP route with unique operation IDs", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/v1/artifacts/{artifact_id}/blobs/{content_sha256}",
      "/api/v1/artifacts/{artifact_id}/manifest",
      "/api/v1/agent-tools",
      "/api/v1/agent-tools/import/inspect",
      "/api/v1/agent-tools/import/ai-prefill",
      "/api/v1/agent-tools/{slug}",
      "/api/v1/dashboard/overview",
      "/api/v1/external-skills",
      "/api/v1/external-skills/{id}",
      "/api/v1/external-skills/{id}/check-upstream",
      "/api/v1/external-skills/{id}/refresh",
      "/api/v1/external-skills/{id}/summary",
      "/api/v1/external-skills/{id}/update-history/refresh",
      "/mcp",
      "/api/v1/projects",
      "/api/v1/projects/{project_id}",
      "/api/v1/projects/{project_id}/artifacts",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/content-upload",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/content-upload/status",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/status",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/{operation_id}/receipt",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive:commit",
      "/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive:prepare",
      "/api/v1/projects/{project_id}/changes/{change_key}/archive-package",
      "/api/v1/projects/{project_id}/changes/{change_key}/archive-package/download",
      "/api/v1/projects/{project_id}/information/branch-files:confirm-restore",
      "/api/v1/projects/{project_id}/information/branch-files:preview-restore",
      "/api/v1/projects/{project_id}/information/knowledge:retry-extraction",
      "/api/v1/projects/{project_id}/information/{view}",
      "/api/v1/projects/{project_id}/information/{view}/exports/{export_id}",
      "/api/v1/projects/{project_id}/information/{view}/{detail_id}",
      "/api/v1/projects/{project_id}/information/{view}:export",
      "/api/v1/projects/{project_id}/information/{view}:export-all",
      "/api/v1/projects/{project_id}/instruction-proposals",
      "/api/v1/projects/{project_id}/workflow-binding",
      "/api/v1/projects/{project_id}/semantic/overview",
      "/api/v1/projects/{project_id}/semantic/knowledge",
      "/api/v1/projects/{project_id}/semantic/rules",
      "/api/v1/projects/{project_id}/semantic/architecture",
      "/api/v1/projects/{project_id}/semantic/search",
      "/api/v1/projects/{project_id}/knowledge/query",
      "/api/v1/projects/{project_id}/semantic/changes",
      "/api/v1/projects/{project_id}/semantic/graph",
      "/api/v1/projects/{project_id}/proposal-sessions",
      "/api/v1/projects/{project_id}/proposals",
      "/api/v1/projects/{project_id}/update-manifest",
      "/api/v1/projects:resolve",
      "/api/v1/proposal-sessions/{session_id}/blobs/{content_sha256}",
      "/api/v1/proposal-sessions/{session_id}/blobs:query",
      "/api/v1/proposal-sessions/{session_id}:finalize",
      "/api/v1/proposals/{proposal_id}",
      "/api/v1/semantic/search",
      "/api/v1/skill-artifacts",
      "/api/v1/skill-catalog/order",
      "/api/v1/skills",
      "/api/v1/skills/draft",
      "/api/v1/skills/{slug}",
      "/api/v1/skills/{slug}/adapter-preview/{agent}",
      "/api/v1/skills/{slug}/artifacts/{agent}/download",
      "/api/v1/skills/{slug}/default-agent",
      "/api/v1/skills/{slug}/draft/{agent}",
      "/api/v1/skills/{slug}/draft/{agent}/ai-checks",
      "/api/v1/skills/{slug}/draft/{agent}/apply-fix",
      "/api/v1/skills/{slug}/draft/{agent}/apply-fix-suggestion",
      "/api/v1/skills/{slug}/draft/{agent}/checks",
      "/api/v1/skills/{slug}/draft/{agent}/diff",
      "/api/v1/skills/{slug}/draft/{agent}/fix-preview",
      "/api/v1/skills/{slug}/draft/{agent}/fix-suggestions",
      "/api/v1/skills/{slug}/draft/{agent}/publish",
      "/api/v1/skills/{slug}/publish",
      "/api/v1/skills/{slug}/npm-release",
      "/api/v1/skills/{slug}/draft/{agent}/release-note:generate",
      "/api/v1/skills/{slug}/tags/{tag_id}",
      "/api/v1/skills/{slug}/versions",
      "/api/v1/system/npm-publishing",
      "/api/v1/system/npm-publishing/credential",
      "/api/v1/system/npm-publishing/verify",
      "/api/v1/tags",
      "/api/v1/tags/{tag_id}",
      "/api/v1/tags/{tag_id}/merge",
      "/api/v1/workflow-families",
      "/api/v1/workflow-families/import",
      "/api/v1/workflow-families/import/inspect",
      "/api/v1/workflow-families/{slug}",
      "/api/v1/workflow-families/{slug}/draft",
      "/api/v1/workflow-families/{slug}/draft/checks",
      "/api/v1/workflow-families/{slug}/draft/diff",
      "/api/v1/workflow-families/{slug}/draft/profiles/{profile}",
      "/api/v1/workflow-families/{slug}/publish",
      "/api/v1/workflow-families/{slug}/npm-release",
      "/api/v1/workflow-families/{slug}/sync",
      "/api/v1/workflow-families/{slug}/versions",
      "/api/v1/workflow-families/{slug}/artifacts/{profile}/download",
      "/api/v1/ai-config/providers",
      "/api/v1/ai-config/providers/{provider_id}",
      "/api/v1/ai-config/providers/{provider_id}/test",
      "/api/v1/ai-config/codex",
      "/api/v1/ai-config/codex/login",
      "/api/v1/ai-config/codex/login/cancel",
      "/api/v1/ai-config/codex/test",
      "/api/v1/ai-config/usage",
      "/api/v1/ai-jobs/{jobId}",
      "/health"
    ].sort());
    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId).filter(Boolean)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("documents npm credentials as Owner-only metadata with a write-only token", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, { description?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, { properties?: Record<string, { writeOnly?: boolean }> }> };
    };
    expect(document.paths["/api/v1/system/npm-publishing"]?.get?.description).toContain("Owner session");
    expect(document.paths["/api/v1/system/npm-publishing/credential"]?.put?.responses).toHaveProperty("503");
    expect(document.components.schemas.NpmPublishingCredentialReplaceRequest?.properties?.token?.writeOnly).toBe(true);
    expect(document.components.schemas.NpmPublishingCredentialStatus?.properties).not.toHaveProperty("token");
  });

  it("keeps Agent Tool and workflow source-import contracts strict and idempotent", async () => {
    interface SchemaNode {
      $ref?: string;
      additionalProperties?: boolean;
      maxLength?: number;
      pattern?: string;
      required?: string[];
      items?: SchemaNode;
      properties?: Record<string, SchemaNode>;
    }
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        parameters?: Array<{ $ref?: string }>;
        responses?: Record<string, unknown>;
      }>>;
      components: { schemas: Record<string, SchemaNode> };
    };

    expect(document.components.schemas.AgentToolSource).toMatchObject({
      additionalProperties: false,
      properties: { ref: { maxLength: 1000 } }
    });
    expect(document.components.schemas.CreateAgentToolRequest?.additionalProperties).toBe(false);
    expect(document.components.schemas.WorkflowFamilySource?.additionalProperties).toBe(false);
    const slugPattern = new RegExp(document.components.schemas.RegistrySlug?.pattern ?? "a^");
    expect(["../java", "General", "two_words", ""].every((value) => !slugPattern.test(value))).toBe(true);
    expect(["general", "java-21"].every((value) => slugPattern.test(value))).toBe(true);
    expect(document.components.schemas.CreateAgentToolRequest?.properties?.slug?.$ref)
      .toBe("#/components/schemas/RegistrySlug");
    expect(document.components.schemas.AgentTool?.properties?.tags?.items?.$ref)
      .toBe("#/components/schemas/RegistrySlug");
    expect(document.components.schemas.WorkflowFamilySourceInspection?.required).toContain("source_digest");
    expect(document.components.schemas.WorkflowFamilySourceInspection?.properties?.profiles?.items?.properties?.profile?.$ref)
      .toBe("#/components/schemas/RegistrySlug");
    expect(document.components.schemas.ImportWorkflowFamilySourceRequest?.required).toContain("source_digest");
    expect(document.components.schemas.ImportWorkflowFamilySourceRequest?.properties)
      .not.toHaveProperty("required_profiles");

    const importResult = document.components.schemas.WorkflowFamilySourceImportResult;
    expect(importResult?.additionalProperties).toBe(false);
    expect(importResult?.properties?.family?.additionalProperties).toBe(false);
    expect(importResult?.properties?.draft?.additionalProperties).toBe(false);
    expect(importResult?.properties?.family?.properties?.required_profiles?.items?.$ref)
      .toBe("#/components/schemas/RegistrySlug");
    expect(importResult?.properties?.draft?.properties?.required_profiles?.items?.$ref)
      .toBe("#/components/schemas/RegistrySlug");
    const draftProfile = importResult?.properties?.draft?.properties?.profiles?.items;
    expect(draftProfile?.required).toEqual(["profile", "file_count"]);
    expect(draftProfile?.properties).not.toHaveProperty("sourceFiles");
    expect(importResult?.required).toContain("request_id");

    const versionSummary = document.components.schemas.WorkflowFamilyVersionSummary;
    expect(versionSummary?.additionalProperties).toBe(false);
    expect(versionSummary?.properties?.profiles?.items?.properties).not.toHaveProperty("sourceFiles");
    expect(versionSummary?.properties?.profiles?.items?.required).toContain("file_count");

    const sync = document.paths["/api/v1/workflow-families/{slug}/sync"]?.post;
    expect(sync?.parameters).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
    expect(sync?.responses).toHaveProperty("504");
    const syncSuccess = sync?.responses?.["200"] as {
      content?: { "application/json"?: { schema?: { $ref?: string } } };
    } | undefined;
    const syncConflict = sync?.responses?.["409"] as { description?: string } | undefined;
    expect(syncSuccess?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/WorkflowFamilySyncResult");
    expect(document.components.schemas.WorkflowFamilySyncResult).toMatchObject({
      additionalProperties: false,
      required: ["updated", "request_id"]
    });
    expect(syncConflict?.description).toContain("WORKFLOW_SOURCE_VERSION_CONFLICT");
    expect(syncConflict?.description).toContain("WORKFLOW_FAMILY_CHANGED");
    const importConflict = document.paths["/api/v1/workflow-families/import"]?.post
      ?.responses?.["409"] as { description?: string } | undefined;
    expect(importConflict?.description).toContain("WORKFLOW_SOURCE_CHANGED");
    expect(document.paths["/api/v1/workflow-families/import/inspect"]?.post?.responses).toHaveProperty("504");
    expect(document.paths["/api/v1/workflow-families/import"]?.post?.responses).toHaveProperty("504");
  });

  it("documents unified publish, review errors, and deprecated compatibility routes", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        deprecated?: boolean;
        parameters?: Array<{ schema?: { $ref?: string } }>;
        responses?: Record<string, unknown>;
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
      }>>;
      components: { schemas: Record<string, {
        enum?: string[];
        properties?: Record<string, { $ref?: string }>;
      }> };
    };
    const publish = document.paths["/api/v1/skills/{slug}/publish"]?.post;
    expect(publish?.responses).toHaveProperty("502");
    expect(publish?.responses).toHaveProperty("503");
    expect(publish?.requestBody?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/PublishUnifiedSkillRequest");
    expect(document.paths["/api/v1/skills/{slug}/draft/{agent}/publish"]?.post?.deprecated).toBe(true);
    expect(document.paths["/api/v1/skills/{slug}/npm-release"]?.post?.deprecated).toBe(true);
    expect(document.components.schemas.RegistryAgent?.enum).toContain("codebuddy");
    expect(document.paths["/api/v1/skills/draft"]?.post?.parameters?.[1]?.schema?.$ref)
      .toBe("#/components/schemas/SkillTargetAgent");
    expect(document.components.schemas.PublishUnifiedSkillRequest?.properties?.sourceAgent?.$ref)
      .toBe("#/components/schemas/SkillTargetAgent");
  });

  it("documents STALE_PUSH as a 409 response on finalizeProposal", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        operationId?: string;
        requestBody?: {
          content?: { "application/json"?: { schema?: { $ref?: string } } };
        };
        responses?: Record<string, { description?: string }>;
      }>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const finalize = document.paths["/api/v1/proposal-sessions/{session_id}:finalize"]?.post;
    expect(finalize?.operationId).toBe("finalizeProposal");
    expect(finalize?.responses?.["409"]?.description).toContain("STALE_PUSH");
    expect(finalize?.responses?.["422"]?.description).toContain("SENSITIVE_CONTENT_BLOCKED");
    expect(finalize?.requestBody?.content?.["application/json"]?.schema?.$ref)
      .toBe("#/components/schemas/FinalizeProposalRequest");
    expect(document.components.schemas.FinalizeProposalRequest?.properties?.sensitive_scan_skip)
      .toMatchObject({ const: true });
  });

  it("keeps archive upload and instruction proposal schemas aligned with runtime validation", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        requestBody?: { content?: Record<string, unknown> };
        responses?: Record<string, unknown>;
      }>>;
      components: { schemas: Record<string, {
        required?: string[];
        properties?: Record<string, {
          const?: string;
          default?: string;
          items?: {
            required?: string[];
            properties?: Record<string, unknown>;
          };
        }>;
      }> };
    };
    const upload = document.paths[
      "/api/v1/projects/{project_id}/changes/{change_key}/archive-package"
    ]?.put;
    expect(Object.keys(upload?.requestBody?.content ?? {})).toEqual(["application/zip"]);
    expect(upload?.responses).toHaveProperty("413");
    expect(upload?.responses).toHaveProperty("415");
    expect(document.components.schemas.ArchivePackageReceipt?.required)
      .toContain("request_id");

    const request = document.components.schemas.InstructionProposalRequest;
    expect(request?.required).not.toContain("language");
    expect(request?.properties?.language).toMatchObject({ const: "zh-CN", default: "zh-CN" });
    expect(request?.properties?.documents?.items?.properties?.path).toEqual({
      type: "string",
      enum: [
        "AGENTS.md",
        "CLAUDE.md",
        "CODEBUDDY.md",
        ".harness/rules/project-guidance.md",
        ".cursor/rules/project-guidance.mdc",
        "package.json",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "pyproject.toml"
      ]
    });
    expect(request?.properties?.recent_changes?.items).toMatchObject({
      required: ["change_key", "summary", "decisions"],
      properties: {
        change_key: { type: "string", minLength: 1, maxLength: 160 },
        summary: { type: "string", maxLength: 10000 },
        decisions: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 2000 }
        }
      }
    });
    const proposal = document.components.schemas.InstructionProposal;
    expect(proposal?.required).toContain("request_id");
    expect(proposal?.properties?.proposal_id).toMatchObject({
      pattern: "^ipr_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$"
    });
    expect(proposal?.properties?.files?.items).toMatchObject({
      additionalProperties: false,
      required: ["path", "operation", "base_content_sha256", "content_sha256", "content"],
      properties: {
        operation: { type: "string", enum: ["add", "modify"] },
        content_sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
      }
    });
  });

  it("ai-jobs GET 200 response schema includes slug+agent dedup key (Y9)", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      paths: Record<string, Record<string, {
        responses: Record<string, {
          content?: { "application/json"?: { schema?: { properties?: Record<string, { enum?: string[] }> } } };
        }>;
      }>>;
    };
    const schema = document.paths["/api/v1/ai-jobs/{jobId}"]?.get?.responses["200"]
      ?.content?.["application/json"]?.schema;
    const props = Object.keys(schema?.properties ?? {});
    expect(props).toEqual(expect.arrayContaining([
      "jobId", "slug", "agent", "status", "result", "error", "createdAt", "expiresAt"
    ]));
    expect(schema?.properties?.agent?.enum).toEqual(["claude-code", "codex", "cursor", "generic", "mcp"]);
  });
});

describe("stage 13 platform information OpenAPI contracts", () => {
  it("keeps descriptor and OpenAPI method, placement, auth, status and request-id in exact parity", async () => {
    const document = parseYaml(await readFile(new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8")) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    for (const descriptor of Object.values(PLATFORM_INFORMATION_HTTP_OPERATIONS)) {
      const operation = document.paths[descriptor.path]?.[descriptor.method.toLowerCase()];
      expect(operation).toBeDefined();
      expect(operation?.operationId).toBe(descriptor.operation_id);
      expect(operation?.["x-hunter-auth-source"]).toBe("authenticated_principal");
      expect(operation?.["x-hunter-project-allowlist-source"]).toBe("server_authority");
      if ("project_key_scope_by_view" in descriptor.auth) {
        expect(operation?.["x-hunter-project-key-scope-by-view"])
          .toEqual(descriptor.auth.project_key_scope_by_view);
      } else {
        expect(operation?.["x-hunter-project-key-scope"])
          .toBe(descriptor.auth.project_key_scope);
      }
      if ("validator_id" in descriptor) {
        expect(operation?.["x-hunter-validator-id"]).toBe(descriptor.validator_id);
      } else {
        expect(operation).not.toHaveProperty("x-hunter-validator-id");
      }
      if ("normalizer_id" in descriptor) {
        expect(operation?.["x-hunter-normalizer-id"]).toBe(descriptor.normalizer_id);
      } else {
        expect(operation).not.toHaveProperty("x-hunter-normalizer-id");
      }
      expect(operation?.["x-hunter-error-codes"]).toEqual(Object.fromEntries(
        Object.entries(descriptor.errors).map(([status, codes]) => [status, [...codes]])
      ));
      const responses = operation?.responses as Record<string, { headers?: object }>;
      expect(Object.keys(responses).map(Number).sort((a, b) => a - b)).toEqual(
        [...new Set([descriptor.success_status,
          ...("replay_status" in descriptor ? [descriptor.replay_status] : []),
          ...Object.keys(descriptor.errors).map(Number)])].sort((a, b) => a - b)
      );
      expect(responses[String(descriptor.success_status)]?.headers).toHaveProperty("X-Request-Id");
      const hasBody = Object.hasOwn(operation ?? {}, "requestBody");
      expect(hasBody).toBe(descriptor.request_placement === "path_and_json_body");
    }
  });

  it("routes colon actions ahead of a dynamic detail fallback", async () => {
    const app = Fastify();
    app.post("/api/v1/projects/:projectId/information/:view/:detailId", async () => ({ route: "dynamic" }));
    app.post(PLATFORM_INFORMATION_HTTP_OPERATIONS.preview_restore.fastify_path, async () => ({ route: "preview" }));
    app.post(PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore.fastify_path, async () => ({ route: "confirm" }));
    app.post(PLATFORM_INFORMATION_HTTP_OPERATIONS.retry_extraction.fastify_path, async () => ({ route: "retry" }));
    for (const [path, route] of [
      ["branch-files:preview-restore", "preview"],
      ["branch-files:confirm-restore", "confirm"],
      ["knowledge:retry-extraction", "retry"]
    ] as const) {
      const response = await app.inject({ method: "POST", url: `/api/v1/projects/prj_demo/information/${path}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ route });
    }
    await app.close();
  });

  it("normalizes an omitted first-page query and rejects hostile query authority", async () => {
    const document = parseYaml(await readFile(new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8")) as OpenApiDocument;
    const querySchema = structuredClone(document.components.schemas.PlatformInformationListHttpQuery);
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, useDefaults: true } } });
    app.get("/query", { schema: { querystring: querySchema } }, async (request) => request.query);
    const first = await app.inject({ method: "GET", url: "/query" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(platformInformationListHttpQuerySchema.parse({}));
    const limited = await app.inject({ method: "GET", url: "/query?limit=25" });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toEqual(platformInformationListHttpQuerySchema.parse({ limit: 25 }));
    const cursor = "pic_a25vd2xlZGdlOjI1";
    const continued = await app.inject({ method: "GET", url: `/query?limit=25&cursor=${cursor}` });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toEqual(platformInformationListHttpQuerySchema.parse({ limit: 25, cursor }));
    const hostile = await app.inject({ method: "GET", url: "/query?actor_id=actor_spoof" });
    expect(hostile.statusCode).toBe(400);
    expect(platformInformationListHttpQuerySchema.safeParse({ actor_id: "actor_spoof" }).success).toBe(false);
    await app.close();
  });

  it("publishes the six authenticated HTTP operations", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8"
    )) as { paths?: Record<string, Record<string, { operationId?: string; responses?: object }>> };
    const paths = document.paths ?? {};
    expect(paths["/api/v1/projects/{project_id}/information/{view}"]?.get?.operationId).toBe("listPlatformInformation");
    expect(paths["/api/v1/projects/{project_id}/information/{view}:export-all"]?.get?.operationId).toBe("exportAllPlatformInformation");
    expect(paths["/api/v1/projects/{project_id}/information/{view}/{detail_id}"]?.get?.operationId).toBe("getPlatformInformationDetail");
    expect(paths["/api/v1/projects/{project_id}/information/branch-files:preview-restore"]?.post?.operationId).toBe("previewBranchFilesRestore");
    expect(paths["/api/v1/projects/{project_id}/information/branch-files:confirm-restore"]?.post?.operationId).toBe("confirmBranchFilesRestore");
    expect(paths["/api/v1/projects/{project_id}/information/knowledge:retry-extraction"]?.post?.operationId).toBe("retryProjectKnowledgeExtraction");
    expect(paths["/api/v1/projects/{project_id}/information/{view}"]?.get?.responses)
      .toEqual(expect.objectContaining({ "200": expect.anything(), "400": expect.anything(), "401": expect.anything(), "403": expect.anything(), "503": expect.anything() }));
  });

  it("publishes the bounded query, page, detail, restore and export schemas", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as {
      components?: { schemas?: Record<string, unknown> };
    };
    const schemas = document.components?.schemas ?? {};
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining([
      "PlatformInformationQuery",
      "PlatformInformationPage",
      "PlatformInformationDetailRequest",
      "PlatformInformationDetailResponse",
      "KnowledgeExtractionRetryIntent",
      "RestoreBranchFilesIntent",
      "RestoreBranchFilesPreviewReceipt",
      "RestoreBranchFilesConfirmationIntent",
      "PlatformInformationExportResult",
      "LegacyPlatformInformation"
    ]));
    expect(schemas.PlatformInformationQuery).toMatchObject({
      additionalProperties: false,
      properties: {
        limit: { maximum: 100 },
        cursor: { pattern: "^[A-Za-z0-9_-]{16,512}$" },
        cursor_verification: { const: "server_port_required" }
      }
    });
    expect(schemas.RestoreBranchFilesIntent).toMatchObject({
      additionalProperties: false,
      properties: { preview_only: { const: true } }
    });
    const pathPattern = new RegExp((schemas.PlatformInformationPath as { pattern: string }).pattern, "u");
    expect(pathPattern.test(".harness/config/team.yaml")).toBe(true);
    expect(["/absolute", "../escape", "safe/../escape", "safe\\escape", "safe//escape"]
      .every((path) => !pathPattern.test(path))).toBe(true);
    const pageBranches = (schemas.PlatformInformationPage as {
      oneOf: Array<{ properties: { page_state: { const: string } } }>;
    }).oneOf;
    expect(pageBranches.map((branch) => branch.properties.page_state.const))
      .toEqual(["ready", "empty", "processing", "partial_failure", "failed", "forbidden"]);
    const confirmationBranches = (schemas.RestoreBranchFilesConfirmationIntent as {
      oneOf: Array<{ properties: { action: { const?: string; enum?: string[] } } }>;
    }).oneOf;
    expect(confirmationBranches[0]?.properties.action.const).toBe("continue");
    expect(confirmationBranches[1]?.properties.action.enum).toEqual(["review", "stop"]);
  });

  it("matches Zod with real Fastify/Ajv for page states and confirmation structure", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8"
    )) as OpenApiDocument;
    const current = JSON.parse(await readFile(new URL(
      "../../../packages/contracts/test/fixtures/platform-information-v1-current.json",
      import.meta.url
    ), "utf8")) as Record<string, unknown>;
    const pageValidator = await createOpenApiBodyValidator(document, "PlatformInformationPage");
    const confirmationValidator = await createOpenApiBodyValidator(
      document, "RestoreBranchFilesConfirmationIntent"
    );
    const retryValidator = await createOpenApiBodyValidator(
      document, "KnowledgeExtractionRetryIntent"
    );
    const exportValidator = await createOpenApiBodyValidator(
      document, "PlatformInformationExportResult"
    );
    const pages = current.pages as Record<string, unknown>[];
    const confirmation = current.restore_confirmation_intent as Record<string, unknown>;
    const cases: Array<[unknown, { safeParse(value: unknown): { success: boolean } },
      (value: unknown) => Promise<boolean>]> = [
      ...pages.map((page) => [page, platformInformationPageSchema, pageValidator.accepts] as const),
      [{ ...pages[2], failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }] },
        platformInformationPageSchema, pageValidator.accepts],
      [{ ...pages[0], next_cursor: "pic_cHJvY2Vzc2luZw" },
        platformInformationPageSchema, pageValidator.accepts],
      [current.knowledge_failed_page, platformInformationPageSchema, pageValidator.accepts],
      [current.knowledge_retry_intent, knowledgeExtractionRetryIntentSchema, retryValidator.accepts],
      [{ ...(current.knowledge_retry_intent as object), request_only: false },
        knowledgeExtractionRetryIntentSchema, retryValidator.accepts],
      [confirmation, restoreBranchFilesConfirmationIntentSchema, confirmationValidator.accepts],
      [{ ...confirmation, preview_hash: `sha256:${"f".repeat(64)}` },
        restoreBranchFilesConfirmationIntentSchema, confirmationValidator.accepts],
      [{ ...confirmation, action: "stop" },
        restoreBranchFilesConfirmationIntentSchema, confirmationValidator.accepts],
      [current.export_result, platformInformationExportResultSchema, exportValidator.accepts]
    ];
    for (const [value, zodSchema, accepts] of cases) {
      expect(await accepts(value)).toBe(zodSchema.safeParse(value).success);
    }
    await pageValidator.app.close();
    await confirmationValidator.app.close();
    await retryValidator.app.close();
    await exportValidator.app.close();
  });
});

describe("remote archive v2 OpenAPI contracts", () => {
  it("keeps every archive descriptor path, auth, scope, identity and response status in parity", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8"
    )) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    for (const descriptor of Object.values(REMOTE_SYNC_ARCHIVE_HTTP_OPERATIONS)) {
      const operation = document.paths[descriptor.path]?.[descriptor.method.toLowerCase()];
      expect(operation).toBeDefined();
      const operationRecord = operation as Record<string, unknown> | undefined;
      expect(operationRecord?.operationId).toBe(descriptor.operation_id);
      expect(operationRecord?.["x-hunter-auth-source"]).toBe("authenticated_principal");
      expect(operationRecord?.["x-hunter-project-allowlist-source"]).toBe("server_authority");
      expect(operationRecord?.["x-hunter-project-key-scope"]).toBe(descriptor.auth.project_key_scope);
      expect(operationRecord?.["x-hunter-error-codes"]).toEqual(Object.fromEntries(
        Object.entries(descriptor.errors).map(([status, codes]) => [status, [...codes]])
      ));
      const responses = operationRecord?.responses as Record<string, { headers?: object }> ?? {};
      expect(Object.keys(responses).map(Number).sort((a, b) => a - b)).toEqual(
        [...new Set([descriptor.success_status,
          ...("replay_status" in descriptor ? [descriptor.replay_status] : []),
          ...Object.keys(descriptor.errors).map(Number)])].sort((a, b) => a - b)
      );
      expect(responses[String(descriptor.success_status)]?.headers).toHaveProperty("X-Request-Id");
      expect(Object.hasOwn(operationRecord ?? {}, "requestBody")).toBe(descriptor.request_placement === "path_and_json_body");
    }
  });

  it("publishes the archive v2 schemas", async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url), "utf8"
    )) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(document.components.schemas)).toEqual(expect.arrayContaining([
      "RemoteSyncArchiveSourceHttp", "RemoteSyncArchiveUploadRefHttp", "RemoteSyncArchiveMetadataHttp",
      "RemoteSyncArchiveRecordHttp", "RemoteSyncArchivePrepareHttpRequest", "RemoteSyncArchivePrepareHttpResponse",
      "RemoteSyncArchiveCommitHttpRequest", "RemoteSyncArchiveCommitHttpResponse", "RemoteSyncArchiveStatusHttpResponse",
      "RemoteSyncArchiveReceiptHttpResponse"
    ]));
  });
});

describe("content-sync Zod and OpenAPI validator parity", () => {
  type PublicSchema = { safeParse: (value: unknown) => { success: boolean } };
  const apps: FastifyInstance[] = [];
  const validators = new Map<string, (value: unknown) => Promise<boolean>>();
  let currentFixture: Record<string, unknown>;
  let legacyFixture: Record<string, unknown>;

  beforeAll(async () => {
    const document = parseYaml(await readFile(
      new URL("../openapi/hunter-harness-v1.yaml", import.meta.url),
      "utf8"
    )) as OpenApiDocument;
    for (const name of [
      "ContentSyncStatuses",
      "ProjectContentCandidate",
      "KnowledgeCandidate",
      "RemoteVersionIdentity",
      "BranchSnapshot",
      "SnapshotVersion",
      "SnapshotFile",
      "ArchivePackageReceipt",
      "ArchiveIngestReceipt"
    ]) {
      const validator = await createOpenApiBodyValidator(document, name);
      apps.push(validator.app);
      validators.set(name, validator.accepts);
    }
    currentFixture = JSON.parse(await readFile(
      new URL("../../../packages/contracts/test/fixtures/content-sync-v1-current.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
    legacyFixture = JSON.parse(await readFile(
      new URL("../../../packages/contracts/test/fixtures/content-sync-v0-legacy.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
  });

  afterAll(async () => {
    await Promise.all(apps.map(async (app) => app.close()));
  });

  async function expectParity(
    schemaName: string,
    schema: PublicSchema,
    value: unknown,
    expected: boolean,
    caseName = schemaName
  ): Promise<void> {
    const accepts = validators.get(schemaName);
    if (accepts === undefined) throw new Error(`Missing validator ${schemaName}`);
    expect(schema.safeParse(value).success, `${schemaName} Zod: ${caseName}`).toBe(expected);
    expect(await accepts(value), `${schemaName} OpenAPI: ${caseName}`).toBe(expected);
  }

  it("requires RemoteVersionIdentity.commit_sha without changing stage 02 optional fields", async () => {
    const identity = currentFixture.remote_version_identity as Record<string, unknown>;
    const withoutCommit = Object.fromEntries(
      Object.entries(identity).filter(([key]) => key !== "commit_sha")
    );
    await expectParity("RemoteVersionIdentity", remoteVersionIdentitySchema, identity, true);
    await expectParity(
      "RemoteVersionIdentity",
      remoteVersionIdentitySchema,
      withoutCommit,
      false
    );
  });

  it("matches the unchanged legacy ArchivePackageReceipt wire boundary", async () => {
    const receipt = (legacyFixture.receipts as Record<string, unknown>[])[0];
    const cases: readonly [string, Record<string, unknown>, boolean][] = [
      ["valid", receipt, true],
      ["empty change_key", { ...receipt, change_key: "" }, true],
      ["empty artifact_id", { ...receipt, artifact_id: "" }, true],
      ["null artifact_id", { ...receipt, artifact_id: null }, true],
      ["RFC3339 offset", { ...receipt, uploaded_at: "2026-08-11T09:00:00+08:00" }, true],
      ["nil UUID", { ...receipt, request_id: "00000000-0000-0000-0000-000000000000" }, true],
      ["unsafe integer", { ...receipt, stored_files: 9007199254740992 }, true],
      ["bad archive_id pattern", { ...receipt, archive_id: "archive_1" }, false],
      ["bad project_id pattern", { ...receipt, project_id: "project_1" }, false],
      ["bad package hash", { ...receipt, package_sha256: "sha256:nope" }, false],
      ["bad manifest hash", { ...receipt, manifest_sha256: "sha256:nope" }, false],
      ["bad UUID", { ...receipt, request_id: "not-a-uuid" }, false],
      ["bad date-time", { ...receipt, uploaded_at: "yesterday" }, false],
      ["fractional stored_files", { ...receipt, stored_files: 1.5 }, false],
      ["unknown field", { ...receipt, unexpected: true }, false],
      ["missing change_key", Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== "change_key")
      ), false]
    ];
    for (const [name, value, expected] of cases) {
      await expectParity(
        "ArchivePackageReceipt",
        legacyArchivePackageReceiptSchema,
        value,
        expected,
        name
      );
      if (expected) {
        const compatibility = getLegacyArchiveCompatibilityResult(value);
        expect(compatibility.archive_status.value.status, name).toBe("stored");
        expect(compatibility.change_index_status.availability, name).toBe("unavailable");
        expect(compatibility.knowledge_extraction_status.availability, name)
          .toBe("unavailable");
        expect(compatibility.managed_snapshot_status.availability, name)
          .toBe("unavailable");
      }
    }
  });

  it("matches canonical ArchiveIngestReceipt structural wire variants", async () => {
    const receipts = currentFixture.archive_ingest_receipts as Record<string, Record<string, unknown>>;
    for (const [name, receipt] of Object.entries(receipts)) {
      await expectParity("ArchiveIngestReceipt", archiveIngestReceiptSchema, receipt, true, name);
      await expectParity("ArchiveIngestReceipt", archiveIngestReceiptSchema,
        { ...receipt, retryable: true }, false, `${name} duplicate retryable`);
      await expectParity("ArchiveIngestReceipt", archiveIngestReceiptSchema,
        { ...receipt, reason_code: "REMOTE_UNAVAILABLE" }, false,
        `${name} stored receipt has no top-level failure reason`);
    }
    const failed = receipts.planning_failed;
    await expectParity("ArchiveIngestReceipt", archiveIngestReceiptSchema, {
      ...failed,
      archive_status: {
        ...(failed.archive_status as object),
        updated_at: "2026-08-12T01:12:30.000Z"
      },
      knowledge_extraction_status: {
        ...(failed.knowledge_extraction_status as object),
        updated_at: "2026-08-12T01:14:00.000Z",
        reason_code: "KNOWLEDGE_JOB_PLAN_FAILED"
      }
    }, true, "independent status metadata");
    await expectParity("ArchiveIngestReceipt", archiveIngestReceiptSchema,
      Object.fromEntries(Object.entries(receipts.queued).filter(([key]) => key !== "retryable")),
      false, "missing top-level retransmit decision");
  });

  it("accepts RFC3339 offsets across new date-time fields", async () => {
    const statuses = currentFixture.statuses as Record<string, unknown>;
    const candidates = currentFixture.candidates as Record<string, Record<string, unknown>>;
    const identity = currentFixture.remote_version_identity as Record<string, unknown>;
    const branch = (currentFixture.branch_snapshots_page as {
      items: Record<string, unknown>[];
    }).items[0];
    const version = (currentFixture.snapshot_versions_page as {
      items: Record<string, unknown>[];
    }).items[0];
    const offset = "2026-08-12T09:04:00+08:00";
    const offsetStatuses = Object.fromEntries(Object.entries(statuses).map(([key, value]) => [
      key,
      key === "schema_version" ? value : { ...(value as object), updated_at: offset }
    ]));
    const cases: readonly [string, PublicSchema, Record<string, unknown>][] = [
      ["ContentSyncStatuses", contentSyncStatusesSchema, offsetStatuses],
      ["ProjectContentCandidate", projectContentCandidateSchema, {
        ...candidates.project_content_candidate,
        provenance: {
          ...(candidates.project_content_candidate.provenance as object),
          created_at: offset
        }
      }],
      ["KnowledgeCandidate", knowledgeCandidateSchema, {
        ...candidates.knowledge_candidate,
        provenance: {
          ...(candidates.knowledge_candidate.provenance as object),
          created_at: offset
        }
      }],
      ["RemoteVersionIdentity", remoteVersionIdentitySchema, { ...identity, uploaded_at: offset }],
      ["BranchSnapshot", branchSnapshotSchema, { ...branch, uploaded_at: offset }],
      ["SnapshotVersion", snapshotVersionSchema, { ...version, uploaded_at: offset }]
    ];
    for (const [name, schema, value] of cases) {
      await expectParity(name, schema, value, true);
    }
  });

  it("rejects integers outside the JavaScript safe range in new schemas", async () => {
    const branch = (currentFixture.branch_snapshots_page as {
      items: Record<string, unknown>[];
    }).items[0];
    const file = (currentFixture.snapshot_files_page as {
      items: Record<string, unknown>[];
    }).items[0];
    await expectParity(
      "BranchSnapshot",
      branchSnapshotSchema,
      { ...branch, file_count: 9007199254740992 },
      false
    );
    await expectParity(
      "SnapshotFile",
      snapshotFileSchema,
      { ...file, size: 9007199254740992 },
      false
    );
  });
});
