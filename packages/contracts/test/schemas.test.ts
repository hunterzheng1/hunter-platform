import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  BranchSnapshotPage,
  ContentSyncStatuses,
  KnowledgeCandidate,
  ProjectContentCandidate,
  RemoteVersionIdentity,
  SnapshotFilePage,
  SnapshotVersionPage
} from "../src/index.js";

import {
  adapterNameSchema,
  addOperationSchema,
  agentSkillConfigSchema,
  aiConfigStateSchema,
  aiJobStateSchema,
  aiProviderApiFormatSchema,
  aiProviderConfigSchema,
  aiProviderReorderRequestSchema,
  aiProviderWithKeySetSchema,
  aiQuotaUsageSchema,
  providerModelSchema,
  apiErrorEnvelopeSchema,
  artifactManifestSchema,
  branchSnapshotPageSchema,
  canonicalJson,
  checkStatusSchema,
  conflictResolutionSchema,
  contentKindSchema,
  contentScanPolicySchema,
  contentSyncStatusesSchema,
  draftStateSchema,
  fileOperationSchema,
  filePolicySchema,
  fixActionSchema,
  fixPlanItemSchema,
  fixPlanSchema,
  getLegacyArchiveCompatibilityResult,
  HARNESS_AGENT_ORDER,
  harnessAgentSchema,
  initConfigSchema,
  knowledgeFrontmatterSchema,
  knowledgeCandidateSchema,
  legacyArchiveCompatibilityResultSchema,
  legacyArchivePackageReceiptSchema,
  mcpToolContractSchema,
  modifyOperationSchema,
  projectConfigSchema,
  platformInformationContractSchema,
  PLATFORM_INFORMATION_HTTP_OPERATIONS,
  platformInformationConfirmRestoreHttpRequestSchema,
  platformInformationDetailResponseSchema,
  platformInformationExportResultSchema,
  platformInformationListHttpQuerySchema,
  platformInformationPreviewRestoreHttpRequestSchema,
  platformInformationRetryExtractionHttpRequestSchema,
  validatePlatformInformationConfirmRestoreHttpRequest,
  knowledgeExtractionRetryIntentSchema,
  platformInformationPageSchema,
  platformInformationQuerySchema,
  readPlatformInformationContract,
  verifyPlatformInformationExportResult,
  restoreBranchFilesConfirmationIntentSchema,
  restoreBranchFilesIntentSchema,
  restoreBranchFilesPreviewReceiptSchema,
  projectContentCandidateSchema,
  pullPolicySchema,
  publishSkillRequestSchema,
  publishUnifiedSkillRequestSchema,
  registryAgentSchema,
  registryArtifactSchema,
  registrySkillDetailSchema,
  registrySkillProposalSchema,
  registrySkillSummarySchema,
  registrySkillVersionSchema,
  registryTagSchema,
  remoteVersionIdentitySchema,
  setDefaultAgentRequestSchema,
  skillCheckItemSchema,
  skillCheckResultSchema,
  skillDiffFileSchema,
  skillFrontmatterSchema,
  skillTargetAgentSchema,
  skillNameSchema,
  skillUsageExampleSchema,
  snapshotFilePageSchema,
  snapshotVersionPageSchema,
  sortHarnessAgents,
  apiErrorCodeSchema,
  SKILL_NAME_REGEX,
  SKILL_ERROR_CODE,
  sourceFileSchema,
  syncActionSchema,
  syncDirectionSchema,
  syncScopeSchema,
  workflowFamilySchema,
  publishWorkflowFamilyRequestSchema,
  registryProjectWorkflowBindingSchema,
  workflowFamilyDraftStateSchema,
  workflowFamilyVersionSchema,
  workflowBundleManifestSchema,
} from "../src/index.js";

describe("active Skill target contracts", () => {
  it.each(["generic", "mcp"])("rejects legacy agent %s for unified publish", (sourceAgent) => {
    expect(skillTargetAgentSchema.safeParse(sourceAgent).success).toBe(false);
    expect(publishUnifiedSkillRequestSchema.safeParse({
      version: "1.0.0",
      sourceAgent,
      draftRevision: 1
    }).success).toBe(false);
  });
});

describe("stage 13 platform information contract mirror", () => {
  it("freezes the authenticated HTTP operation contract", () => {
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS).toEqual({
      list: expect.objectContaining({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}", operation_id: "listPlatformInformation", request_placement: "path_and_query", success_status: 200, success_schema: "PlatformInformationPage" }),
      export_all: expect.objectContaining({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}:export-all", operation_id: "exportAllPlatformInformation", request_placement: "path_and_query", success_status: 200, success_schema: "PlatformInformationExportResult" }),
      create_export: expect.objectContaining({ method: "POST", path: "/api/v1/projects/{project_id}/information/{view}:export", operation_id: "createPlatformInformationExport", success_status: 201, success_schema: "PlatformInformationExportArtifactReceipt" }),
      download_export: expect.objectContaining({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}/exports/{export_id}", operation_id: "downloadPlatformInformationExport", success_status: 200, success_schema: null, success_headers: { content_sha256: "X-Content-SHA256", content_disposition: "Content-Disposition" } }),
      detail: expect.objectContaining({ method: "GET", path: "/api/v1/projects/{project_id}/information/{view}/{detail_id}", operation_id: "getPlatformInformationDetail", request_placement: "path_only", success_status: 200, success_schema: "PlatformInformationDetailResponse" }),
      list_files: expect.objectContaining({ method: "GET", path: "/api/v1/projects/{project_id}/information/branch_files/{detail_id}/files", operation_id: "listPlatformInformationBranchFiles", request_placement: "path_and_query", success_status: 200, success_schema: "PlatformInformationBranchFilesPage" }),
      preview_restore: expect.objectContaining({ method: "POST", path: "/api/v1/projects/{project_id}/information/branch-files:preview-restore", operation_id: "previewBranchFilesRestore", request_placement: "path_and_json_body", success_schema: "RestoreBranchFilesPreviewReceipt" }),
      confirm_restore: expect.objectContaining({ method: "POST", path: "/api/v1/projects/{project_id}/information/branch-files:confirm-restore", operation_id: "confirmBranchFilesRestore", request_placement: "path_and_json_body", success_schema: "RestoreBranchFilesConfirmedIntent" }),
      retry_extraction: expect.objectContaining({ method: "POST", path: "/api/v1/projects/{project_id}/information/knowledge:retry-extraction", operation_id: "retryProjectKnowledgeExtraction", request_placement: "path_and_json_body", success_schema: "KnowledgeExtractionRetryIntent" })
    });
    expect(platformInformationListHttpQuerySchema.parse({})).toEqual({ limit: 50, cursor: null });
    expect(platformInformationListHttpQuerySchema.safeParse({ limit: 25, cursor: null, actor_id: "actor_spoof" }).success).toBe(false);
    expect(platformInformationRetryExtractionHttpRequestSchema.safeParse({ job_id: "job_knowledge_01", expected_generation: 2, actor_id: "actor_spoof" }).success).toBe(false);
    const preview = { schema_version: 1, contract_kind: "branch_files_pull_preview_intent", project_id: "prj_demo", source_branch_name: "main", source_commit_sha: "a".repeat(40), source_artifact_id: "artifact_1", source_project_version: "pv_1", scopes: ["branch_files"], selected_paths: ["AGENTS.md"], preview_only: true };
    expect(platformInformationPreviewRestoreHttpRequestSchema.safeParse(preview).success).toBe(true);
    expect(platformInformationPreviewRestoreHttpRequestSchema.safeParse({ ...preview, actor_id: "actor_spoof" }).success).toBe(false);
    expect(platformInformationConfirmRestoreHttpRequestSchema.safeParse({ preview_receipt: {}, confirmation_intent: {} }).success).toBe(false);
    for (const operation of Object.values(PLATFORM_INFORMATION_HTTP_OPERATIONS)) {
      expect(operation.request_id_header).toBe("X-Request-Id");
      expect(operation.errors[401]).toEqual(["AUTH_REQUIRED", "TOKEN_INVALID", "SESSION_INVALID"]);
    }
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.list.auth.project_key_scope_by_view.branch_monitor).toBe("platform:read");
    expect(apiErrorEnvelopeSchema.safeParse({ error: {
      code: "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE", message: "export unavailable",
      request_id: "0198f012-3456-7abc-8def-0123456789ab", details: {},
    } }).success).toBe(true);
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore).toMatchObject({ validator_id: "validatePlatformInformationConfirmRestoreHttpRequest" });
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS.preview_restore.fastify_path).toContain("branch-files::preview-restore");
  });

  it("matches the independently frozen HTTP descriptor fixture", async () => {
    const frozen = JSON.parse(await readFile(new URL("./fixtures/platform-information-http-v1-current.json", import.meta.url), "utf8"));
    expect(PLATFORM_INFORMATION_HTTP_OPERATIONS).toEqual(frozen);
  });

  it("validates confirm restore only through the serialized semantic entrypoint", async () => {
    const current = JSON.parse(await readFile(new URL("./fixtures/platform-information-v1-current.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const body = { preview_receipt: current.restore_preview_receipt, confirmation_intent: current.restore_confirmation_intent };
    expect(validatePlatformInformationConfirmRestoreHttpRequest(JSON.stringify(body), { project_id: "prj_demo", client_id: "platform_console" })).toMatchObject({ ok: true });
    expect(validatePlatformInformationConfirmRestoreHttpRequest(JSON.stringify(body), { project_id: "prj_other", client_id: "platform_console" })).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" });
    expect(validatePlatformInformationConfirmRestoreHttpRequest(JSON.stringify({ ...body, confirmation_intent: { ...(body.confirmation_intent as object), preview_hash: `sha256:${"f".repeat(64)}` } }), { project_id: "prj_demo", client_id: "platform_console" })).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" });
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("trap"); } });
    expect(validatePlatformInformationConfirmRestoreHttpRequest(hostile, { project_id: "prj_demo", client_id: "platform_console" })).toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" });
    expect(traps).toBe(0);
  });

  it("parses current fixtures and keeps legacy payloads read-only", async () => {
    const current = JSON.parse(await readFile(fileURLToPath(new URL(
      "./fixtures/platform-information-v1-current.json", import.meta.url
    )), "utf8")) as Record<string, unknown>;
    const legacy = JSON.parse(await readFile(fileURLToPath(new URL(
      "./fixtures/platform-information-v0-legacy.json", import.meta.url
    )), "utf8")) as Record<string, unknown>;

    for (const query of current.queries as unknown[]) {
      expect(platformInformationQuerySchema.safeParse(query).success).toBe(true);
      expect(platformInformationContractSchema.safeParse(query).success).toBe(true);
    }
    for (const page of current.pages as unknown[]) {
      expect(platformInformationPageSchema.safeParse(page).success).toBe(true);
    }
    const monitorPage = (current.pages as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(platformInformationPageSchema.safeParse({
      ...monitorPage,
      page_state: "ready",
      items: [{
        item_kind: "branch_monitor",
        lifecycle_kind: "change",
        run_id: "run_01",
        branch_name: "feature/monitor",
        change_key: "change_monitor",
        run_status: "running",
        current_phase: "sync",
        started_at: "2026-08-13T01:00:00Z",
        ended_at: null,
        duration_ms: null,
        last_event_at: "2026-08-13T01:00:00Z",
        sort_key: "2026-08-13T01:00:00Z|run_01"
      }]
    }).success).toBe(false);
    expect(platformInformationPageSchema.safeParse(current.knowledge_failed_page).success).toBe(true);
    expect(knowledgeExtractionRetryIntentSchema.safeParse(current.knowledge_retry_intent).success).toBe(true);
    expect(restoreBranchFilesIntentSchema.safeParse(current.restore_intent).success).toBe(true);
    expect(restoreBranchFilesPreviewReceiptSchema.safeParse(current.restore_preview_receipt).success).toBe(true);
    expect(restoreBranchFilesConfirmationIntentSchema.safeParse(current.restore_confirmation_intent).success).toBe(true);
    expect(platformInformationExportResultSchema.safeParse(current.export_result).success).toBe(true);
    expect(platformInformationDetailResponseSchema.safeParse({
      schema_version: 1,
      contract_kind: "detail_response",
      view: "project_materials",
      project_id: "prj_demo",
      detail_id: "material_rules",
      detail: {
        detail_kind: "project_material",
        content: "# canonical rule projection",
        content_hash: `sha256:${"b".repeat(64)}`,
        media_type: "text/markdown"
      }
    }).success).toBe(true);
    expect(readPlatformInformationContract(JSON.stringify(legacy))).toMatchObject({
      ok: true, mode: "legacy_read_only", source_schema_version: 0
    });
    expect(readPlatformInformationContract(JSON.stringify({ ...legacy, unexpected: true }))).toEqual({
      ok: false, reason_code: "PLATFORM_INFORMATION_CONTRACT_INVALID"
    });
  });

  it("verifies complete null-start export walks against their trusted query", async () => {
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/platform-information-v1-current.json", import.meta.url
    ), "utf8")) as Record<string, unknown>;
    const proof = current.export_result as Record<string, unknown>;
    const query = (current.queries as unknown[])[3];
    expect(platformInformationExportResultSchema.safeParse(proof).success).toBe(true);
    expect(platformInformationExportResultSchema.safeParse({
      ...proof,
      pages: [{ request_cursor: null, response_next_cursor: null, result_count: 3 }],
      exported_count: 3
    }).success).toBe(true);
    expect(verifyPlatformInformationExportResult(JSON.stringify(proof), query)).toMatchObject({
      ok: true, value: { exported_count: 28 }
    });
    const range = proof.range as Record<string, unknown>;
    const queryScope = range.query_scope as Record<string, unknown>;
    expect(verifyPlatformInformationExportResult(JSON.stringify({
      ...proof,
      range: { ...range, query_scope: { ...queryScope, actor_id: "actor_2" } }
    }), query)).toEqual({
      ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_RANGE_MISMATCH"
    });
  });

  it("rejects incomplete, discontinuous, repeated-terminal, and incorrect export proofs", async () => {
    const current = JSON.parse(await readFile(new URL(
      "./fixtures/platform-information-v1-current.json", import.meta.url
    ), "utf8")) as Record<string, unknown>;
    const proof = current.export_result as Record<string, unknown>;
    const cursor25 = "pic_a25vd2xlZGdlOjI1";
    const cursor50 = "pic_a25vd2xlZGdlOjUw";
    const invalidPages: unknown[][] = [
      [{ request_cursor: null, response_next_cursor: cursor25, result_count: 25 }],
      [
        { request_cursor: null, response_next_cursor: cursor25, result_count: 25 },
        { request_cursor: cursor50, response_next_cursor: null, result_count: 3 }
      ],
      [
        { request_cursor: null, response_next_cursor: null, result_count: 25 },
        { request_cursor: null, response_next_cursor: null, result_count: 3 }
      ]
    ];
    for (const pages of invalidPages) {
      expect(platformInformationExportResultSchema.safeParse({
        ...proof,
        pages,
        exported_count: pages.reduce((sum, page) =>
          sum + (page as { result_count: number }).result_count, 0)
      }).success).toBe(false);
    }
    expect(platformInformationExportResultSchema.safeParse({
      ...proof, exported_count: 27
    }).success).toBe(false);
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("trap"); } });
    expect(verifyPlatformInformationExportResult(hostile, (current.queries as unknown[])[3])).toEqual({
      ok: false, reason_code: "PLATFORM_INFORMATION_EXPORT_SERIALIZED_JSON_REQUIRED"
    });
    expect(traps).toBe(0);
  });
});

describe("multi-agent contracts", () => {
  it("harnessAgentSchema accepts exactly four agents", () => {
    for (const a of ["claude-code", "codex", "cursor", "codebuddy"] as const) {
      expect(harnessAgentSchema.parse(a)).toBe(a);
    }
    expect(() => harnessAgentSchema.parse("generic")).toThrow();
    expect(() => harnessAgentSchema.parse("mcp")).toThrow();
  });

  it("sortHarnessAgents dedupes and orders deterministically", () => {
    expect(sortHarnessAgents(["codebuddy", "claude-code", "codebuddy", "codex"]))
      .toEqual(["claude-code", "codex", "codebuddy"]);
    expect(HARNESS_AGENT_ORDER).toEqual(["claude-code", "codex", "cursor", "codebuddy"]);
  });

  it("initConfigSchema requires agents array and defaults codebuddy_surface", () => {
    const parsed = initConfigSchema.parse({ agents: ["codex", "cursor"], profile: "java" });
    expect(parsed.agents).toEqual(["codex", "cursor"]);
    expect(parsed.codebuddy_surface).toBe("both");
    expect(() => initConfigSchema.parse({ agents: [], profile: "java" })).toThrow();
    expect(() => initConfigSchema.parse({ adapter: "claude-code", profile: "java" })).toThrow();
  });

  it("adapterNameSchema now includes codebuddy and keeps legacy names", () => {
    for (const a of ["claude-code", "codex", "cursor", "codebuddy", "generic", "mcp"] as const) {
      expect(adapterNameSchema.parse(a)).toBe(a);
    }
  });

  it("projectConfigSchema accepts optional adapter_options.codebuddy.surface", () => {
    const base = {
      harness: { name: "hunter-harness", schema_version: 1 },
      project: {
        name: "x",
        root: ".",
        local_project_key: "018f6d00-0000-7000-8000-000000000000",
        project_id: null,
        profiles: ["general"]
      },
      server: { url: null, token_env: "HUNTER_HARNESS_TOKEN" },
      adapters: { enabled: ["claude-code", "codebuddy"] }
    };
    expect(projectConfigSchema.parse(base).adapter_options).toBeUndefined();
    const withOptions = { ...base, adapter_options: { codebuddy: { surface: "both" } } };
    expect(projectConfigSchema.parse(withOptions).adapter_options?.codebuddy.surface).toBe("both");
    expect(() => projectConfigSchema.parse({
      ...base,
      adapter_options: { codebuddy: { surface: "web" } }
    })).toThrow();
  });
});

describe("shared contracts", () => {
  it("accepts an offline project configuration", () => {
    const parsed = projectConfigSchema.parse({
      harness: { name: "hunter-harness", schema_version: 1 },
      project: {
        name: "sample",
        root: ".",
        local_project_key: "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
        project_id: null,
        profiles: ["java"]
      },
      server: { url: null, token_env: "HUNTER_HARNESS_TOKEN" },
      adapters: { enabled: ["claude-code"] }
    });

    expect(parsed.project.project_id).toBeNull();
  });

  it("uses file_kind and policy fields instead of legacy classes", () => {
    expect(filePolicySchema.parse({
      file_kind: "generated_reviewable",
      edit_policy: "discourage",
      push_policy: "full-diff-proposal",
      update_policy: "skip-if-local-dirty",
      conflict_policy: "skip-and-report"
    })).toMatchObject({ file_kind: "generated_reviewable" });

    expect(filePolicySchema.safeParse({ class: "A" }).success).toBe(false);
  });

  it("requires explicit tombstones and rename paths", () => {
    const common = {
      file_kind: "user_editable",
      content_sha256: "sha256:" + "a".repeat(64),
      size_bytes: 12
    };
    const result = artifactManifestSchema.safeParse({
      schema_version: 1,
      project_id: "prj_1",
      project_version: "pv_1",
      artifact_id: "art_1",
      files: [{ ...common, path: "AGENTS.md", operation: "delete" }],
      manifest_sha256: "sha256:" + "b".repeat(64)
    });

    expect(result.success).toBe(false);
  });

  it("rejects secrets and unknown fields in init config", () => {
    expect(initConfigSchema.safeParse({
      adapter: "claude-code",
      profile: "java",
      token: "secret"
    }).success).toBe(false);
  });

  it("validates Knowledge frontmatter", () => {
    expect(knowledgeFrontmatterSchema.parse({
      id: "knowledge.architecture.boundary",
      type: "architecture",
      scope: "project",
      confidence: "verified",
      status: "active",
      domains: ["platform"],
      modules: ["core"],
      related_paths: ["packages/core/**"],
      source: { kind: "review", ref: "prp_1" },
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z",
      last_verified_at: "2026-06-20T00:00:00Z",
      expires_at: null,
      supersedes: [],
      superseded_by: []
    }).status).toBe("active");
  });

  it("validates governed registry records and direct workflow metadata", () => {
    expect(registryAgentSchema.parse("claude-code")).toBe("claude-code");
    expect(registryAgentSchema.parse("codebuddy")).toBe("codebuddy");
    expect(registryAgentSchema.safeParse("unknown-agent").success).toBe(false);
    expect(registrySkillDetailSchema.parse({
      skill_id: "skl_review",
      slug: "harness-review",
      name: "harness-review",
      description: "Evidence based review",
      tags: ["review", "security"],
      status: "published",
      latest_version: "1.1.0",
      defaultAgent: "claude-code",
      agents: [{
        agent: "claude-code",
        enabled: true,
        isDefault: true,
        installTarget: ".claude/skills/harness-review",
        latestVersion: "1.1.0",
        draftVersion: null,
        sourcePackagePath: null
      }],
      revision: 3,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }).tags).toEqual(["review", "security"]);

    expect(workflowFamilySchema.parse({
      family_id: "wff_harness",
      slug: "harness",
      displayName: "Harness",
      description: "Default harness workflow family",
      tags: ["core"],
      latest_version: "1.0.0",
      required_profiles: ["general", "java"],
      revision: 2,
      npmReleases: [],
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }).revision).toBe(2);

    expect(registryTagSchema.parse({
      tag_id: "tag_security",
      slug: "security",
      label: "Security",
      active: true,
      revision: 1,
      usageCount: 0,
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z"
    }).slug).toBe("security");

    expect(registrySkillProposalSchema.parse({
      proposal_id: "skp_review",
      skill_slug: "harness-review",
      proposed_ir: { name: "harness-review", version: "1.1.0" },
      status: "pending_review",
      created_by: "actor_owner",
      validation: { schema_valid: true, sensitive_findings: 0, claude_compilable: true },
      created_at: "2026-06-21T00:00:00Z",
      reviewed_at: null
    }).status).toBe("pending_review");
  });

  it("enforces the common API error envelope", () => {
    const parsed = apiErrorEnvelopeSchema.parse({
      error: {
        code: "PROJECT_VERSION_CONFLICT",
        message: "The baseline is stale.",
        request_id: "018f1f2e-7b5a-7cc0-8c2d-2b320cab1234",
        details: {}
      }
    });
    expect(parsed.error.code).toBe("PROJECT_VERSION_CONFLICT");
  });

  it("canonicalizes object keys deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}');
  });

});

describe("skill frontmatter schema (UT-001~004, UT-002b RED#1)", () => {
  it("parses valid frontmatter with required name+description (UT-001)", () => {
    expect(skillFrontmatterSchema.parse({
      name: "harness-x",
      description: "demo skill"
    }).name).toBe("harness-x");
  });

  it("preserves extra undeclared fields via passthrough (UT-002b, RED#1)", () => {
    const parsed = skillFrontmatterSchema.parse({
      name: "harness-x",
      description: "d",
      author: "someone",
      tags: ["a"],
      license: "MIT"
    });
    expect(parsed.author).toBe("someone");
    expect(parsed.tags).toEqual(["a"]);
    expect(parsed.license).toBe("MIT");
  });

  it("rejects name not matching slug regex (UT-003)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "Foo Bar",
      description: "d"
    }).success).toBe(false);
  });

  it("accepts missing optional fields (UT-004)", () => {
    const parsed = skillFrontmatterSchema.parse({
      name: "harness-x",
      description: "d"
    });
    expect(parsed.triggers).toBeUndefined();
    expect(parsed.forbidden_actions).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
  });

  it("rejects missing description", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "harness-x"
    }).success).toBe(false);
  });

  it("rejects missing name", () => {
    expect(skillFrontmatterSchema.safeParse({
      description: "d"
    }).success).toBe(false);
  });

  it("accepts name without harness- prefix (U-02)", () => {
    expect(skillFrontmatterSchema.parse({
      name: "my-skill",
      description: "d"
    }).name).toBe("my-skill");
  });

  it("rejects name starting with hyphen (U-04)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "-x",
      description: "d"
    }).success).toBe(false);
  });

  it("rejects name with underscore (U-05)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "_x",
      description: "d"
    }).success).toBe(false);
  });

  it("rejects name exceeding 64 chars (U-07)", () => {
    expect(skillFrontmatterSchema.safeParse({
      name: "a".repeat(65),
      description: "d"
    }).success).toBe(false);
  });

  it("accepts name exactly 64 chars (U-07b)", () => {
    expect(skillFrontmatterSchema.parse({
      name: "a".repeat(64),
      description: "d"
    }).name).toBe("a".repeat(64));
  });
});

describe("SKILL_NAME_REGEX (U-01~U-07b standalone)", () => {
  it("matches old harness-xxx format (U-01)", () => {
    expect(SKILL_NAME_REGEX.test("harness-x")).toBe(true);
  });

  it("matches new format without harness- prefix (U-02)", () => {
    expect(SKILL_NAME_REGEX.test("my-skill")).toBe(true);
  });

  it("rejects uppercase/spaces (U-03)", () => {
    expect(SKILL_NAME_REGEX.test("Foo Bar")).toBe(false);
  });

  it("rejects hyphen-start (U-04)", () => {
    expect(SKILL_NAME_REGEX.test("-x")).toBe(false);
  });

  it("rejects underscore (U-05)", () => {
    expect(SKILL_NAME_REGEX.test("_x")).toBe(false);
  });

  it("rejects consecutive hyphens (YELLOW-2 alignment)", () => {
    expect(SKILL_NAME_REGEX.test("a--b")).toBe(false);
    expect(skillFrontmatterSchema.safeParse({
      name: "a--b",
      description: "d"
    }).success).toBe(false);
  });

  it("rejects trailing hyphen (YELLOW-2 alignment)", () => {
    expect(SKILL_NAME_REGEX.test("a-")).toBe(false);
  });

  it("allows 65 chars at regex level (length enforced by skillNameSchema.max(64))", () => {
    // SKILL_NAME_REGEX 仅校验格式，长度由 skillNameSchema.max(64) 单独强制
    expect(SKILL_NAME_REGEX.test("a".repeat(65))).toBe(true);
    expect(skillFrontmatterSchema.safeParse({
      name: "a".repeat(65),
      description: "d"
    }).success).toBe(false);
  });

  it("accepts 64 chars (U-07b)", () => {
    expect(SKILL_NAME_REGEX.test("a".repeat(64))).toBe(true);
    expect(skillFrontmatterSchema.parse({
      name: "a".repeat(64),
      description: "d"
    }).name).toBe("a".repeat(64));
  });
});

describe("apiErrorCodeSchema 7 new skill codes (U-08)", () => {
  const newCodes = [
    "SKILL_VALIDATION_FAILED",
    "SKILL_ENTRY_NOT_FOUND",
    "SKILL_NOT_FOUND",
    "DRAFT_NOT_FOUND",
    "REVISION_CONFLICT",
    "ADAPTER_NOT_INSTALLABLE",
    "WORKFLOW_PACKAGE_REDIRECT"
  ] as const;

  for (const code of newCodes) {
    it(`accepts ${code}`, () => {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    });
  }
});

describe("SKILL_ERROR_CODE constant", () => {
  it("contains wire codes + non-wire codes", () => {
    expect(SKILL_ERROR_CODE.VALIDATION_FAILED).toBe("SKILL_VALIDATION_FAILED");
    expect(SKILL_ERROR_CODE.ENTRY_NOT_FOUND).toBe("SKILL_ENTRY_NOT_FOUND");
    expect(SKILL_ERROR_CODE.NOT_FOUND).toBe("SKILL_NOT_FOUND");
    expect(SKILL_ERROR_CODE.DRAFT_NOT_FOUND).toBe("DRAFT_NOT_FOUND");
    expect(SKILL_ERROR_CODE.REVISION_CONFLICT).toBe("REVISION_CONFLICT");
    expect(SKILL_ERROR_CODE.ADAPTER_NOT_INSTALLABLE).toBe("ADAPTER_NOT_INSTALLABLE");
    expect(SKILL_ERROR_CODE.WORKFLOW_PACKAGE_REDIRECT).toBe("WORKFLOW_PACKAGE_REDIRECT");
    // non-wire (internal) codes
    expect(SKILL_ERROR_CODE.SLUG_INVALID).toBe("SKILL_SLUG_INVALID");
    expect(SKILL_ERROR_CODE.FRONTMATTER_INVALID).toBe("FRONTMATTER_INVALID");
  });

  it("skillNameSchema uses SKILL_NAME_REGEX", () => {
    expect(skillNameSchema.safeParse("my-skill").success).toBe(true);
    expect(skillNameSchema.safeParse("-x").success).toBe(false);
  });
});

describe("skill-center schemas", () => {
  const agentCfg = {
    agent: "claude-code",
    enabled: true,
    isDefault: true,
    installTarget: ".claude/skills/harness-x",
    latestVersion: "1.0.0",
    draftVersion: null,
    sourcePackagePath: null
  };
  const validProviderCfg = {
    provider_id: "deepseek",
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    is_default: true,
    api_key_env: "secret-file",
    revision: 1,
    daily_request_limit: 1000,
    daily_token_limit: 500000,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:00Z",
    models: [{
      id: "m1",
      display_model: "deepseek-v4-pro",
      request_model: "deepseek-v4-pro",
      input_cost: 1,
      output_cost: 2,
      cache_hit_cost: 0.1,
      cache_create_cost: 0.5
    }],
    api_format: "openai",
    note: "",
    website: "https://deepseek.com",
    selected_model_id: "m1",
    sort_order: 0
  };

  it("checkStatus accepts green/yellow/red and rejects others", () => {
    expect(checkStatusSchema.parse("green")).toBe("green");
    expect(checkStatusSchema.parse("yellow")).toBe("yellow");
    expect(checkStatusSchema.parse("red")).toBe("red");
    expect(checkStatusSchema.safeParse("blue").success).toBe(false);
  });

  it("sourceFile requires path+content", () => {
    expect(() => sourceFileSchema.parse({ path: "a.md" })).toThrow();
    expect(sourceFileSchema.parse({ path: "a.md", content: "x" })).toEqual({ path: "a.md", content: "x" });
  });

  it("skillUsageExample defaults files to []", () => {
    expect(skillUsageExampleSchema.parse({
      title: "t", description: "d", request: "r", result: "s"
    }).files).toEqual([]);
  });

  it("agentSkillConfig parses valid and rejects extras", () => {
    expect(agentSkillConfigSchema.parse(agentCfg)).toEqual(agentCfg);
    expect(() => agentSkillConfigSchema.parse({ ...agentCfg, extra: 1 })).toThrow();
  });

  it("skillCheckItem and skillCheckResult parse", () => {
    const item = { id: "SENSITIVE", label: "敏感信息", status: "red", message: "token", filePath: "SKILL.md", fixable: false };
    expect(skillCheckItemSchema.parse(item)).toEqual(item);
    const r = skillCheckResultSchema.parse({
      items: [item],
      summary: { green: 0, yellow: 0, red: 1 },
      checkedAt: "2026-06-26T00:00:00Z"
    });
    expect(r.summary.red).toBe(1);
  });

  it("draftState defaults examples (ir optional, legacy tolerated COM-001/002)", () => {
    const d = draftStateSchema.parse({
      slug: "harness-x",
      agent: "claude-code",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.examples).toEqual([]);
    expect(d.revision).toBe(1);
    const legacy = draftStateSchema.parse({
      slug: "harness-x",
      agent: "claude-code",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      ir: { legacy: "ir-shape" },
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(legacy.ir).toEqual({ legacy: "ir-shape" });
  });

  it("publishSkillRequest requires version and accepts optional releaseNote", () => {
    expect(() => publishSkillRequestSchema.parse({})).toThrow();
    expect(publishSkillRequestSchema.parse({ version: "1.0.0" }).releaseNote).toBeUndefined();
    expect(publishSkillRequestSchema.parse({ version: "1.0.0", releaseNote: "init" }).releaseNote).toBe("init");
  });

  it("skillDiffFile only allows modified/added/removed", () => {
    expect(skillDiffFileSchema.parse({ path: "a", status: "modified", publishedContent: "1", draftContent: "2" }).status).toBe("modified");
    expect(() => skillDiffFileSchema.parse({ path: "a", status: "deleted", publishedContent: null, draftContent: null })).toThrow();
  });

  it("summary has no category, has agents+defaultAgent, rejects category", () => {
    const s = {
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    };
    const parsed = registrySkillSummarySchema.parse(s);
    expect(parsed).not.toHaveProperty("category");
    expect(parsed.kind).toBeUndefined();
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.defaultAgent).toBe("claude-code");
    expect(() => registrySkillSummarySchema.parse({ ...s, category: "tooling" })).toThrow();
  });

  it("summary kind 反范式化字段（从 frontmatter 派生，供 dashboard 分类）", () => {
    const base = {
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    };
    expect(registrySkillSummarySchema.parse({ ...base, kind: "workflow" }).kind).toBe("workflow");
    expect(registrySkillSummarySchema.parse({ ...base, kind: null }).kind).toBeNull();
    expect(registrySkillSummarySchema.safeParse({ ...base, kind: "invalid" }).success).toBe(false);
  });

  it("detail defaults sourceFiles/examples (ir optional, legacy tolerated)", () => {
    const d = registrySkillDetailSchema.parse({
      skill_id: "skl_1", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.sourceFiles).toEqual([]);
    expect(d.examples).toEqual([]);
    const legacy = registrySkillDetailSchema.parse({
      skill_id: "skl_2", slug: "harness-x", name: "harness-x", description: "d",
      tags: [], status: "published", latest_version: "1.0.0",
      defaultAgent: "claude-code", agents: [agentCfg],
      ir: { legacy: "ir-shape", name: "harness-x" },
      revision: 1, created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z"
    });
    expect(legacy.ir).toEqual({ legacy: "ir-shape", name: "harness-x" });
  });

  it("version has sourceFiles/examples/changeNote and nullable source_proposal_id", () => {
    const v = registrySkillVersionSchema.parse({
      skill_slug: "harness-x", version: "1.0.0", agent: "claude-code", artifacts: [],
      source_proposal_id: null, sourceFiles: [], examples: [], changeNote: null,
      created_at: "2026-06-26T00:00:00Z"
    });
    expect(v.changeNote).toBeNull();
    expect(v.sourceFiles).toEqual([]);
  });

  it("artifact allows null source_proposal_id for draft-published artifacts", () => {
    const a = registryArtifactSchema.parse({
      artifact_id: "ska_1", skill_slug: "harness-x", version: "1.0.0", agent: "claude-code",
      content_sha256: "sha256:" + "a".repeat(64), size_bytes: 10, source_proposal_id: null,
      created_at: "2026-06-26T00:00:00Z"
    });
    expect(a.source_proposal_id).toBeNull();
  });

  it("tag has nonnegative usageCount", () => {
    const t = registryTagSchema.parse({
      tag_id: "tag_1", slug: "x", label: "X", active: true, revision: 1,
      created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:00:00Z", usageCount: 0
    });
    expect(t.usageCount).toBe(0);
    expect(() => registryTagSchema.parse({ ...t, usageCount: -1 })).toThrow();
  });

  it("aiProviderConfig parses valid with quota (no key) and rejects apiKey extra", () => {
    expect(aiProviderConfigSchema.parse(validProviderCfg)).toEqual(validProviderCfg);
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, apiKey: "sk-xxx" })).toThrow();
  });

  it("aiProviderConfig accepts null quota (explicit unlimited)", () => {
    const cfg = { ...validProviderCfg, daily_request_limit: null, daily_token_limit: null };
    const parsed = aiProviderConfigSchema.parse(cfg);
    expect(parsed.daily_request_limit).toBeNull();
    expect(parsed.daily_token_limit).toBeNull();
  });

  it("aiProviderConfig defaults quota to null when missing (legacy migration COM-002)", () => {
    const legacy = {
      provider_id: "deepseek",
      label: "DeepSeek",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      enabled: true,
      is_default: true,
      api_key_env: "secret-file",
      revision: 1,
      created_at: "2026-06-28T00:00:00Z",
      updated_at: "2026-06-28T00:00:00Z"
    };
    const parsed = aiProviderConfigSchema.parse(legacy);
    expect(parsed.daily_request_limit).toBeNull();
    expect(parsed.daily_token_limit).toBeNull();
  });

  it("aiProviderConfig rejects negative or non-integer quota", () => {
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, daily_request_limit: -1 })).toThrow();
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, daily_token_limit: 1.5 })).toThrow();
  });

  it("aiQuotaUsageSchema parses provider_id/date/requests/tokens and is strict", () => {
    const u = {
      provider_id: "deepseek",
      date: "2026-07-01",
      requests: 10,
      tokens: 500,
      model: "deepseek-v4-pro",
      input_tokens: 300,
      output_tokens: 200,
      cache_hit_tokens: 0,
      cache_create_tokens: 0,
      cost: 0.0007
    };
    expect(aiQuotaUsageSchema.parse(u)).toEqual(u);
    expect(() => aiQuotaUsageSchema.parse({ ...u, extra: 1 })).toThrow();
    expect(() => aiQuotaUsageSchema.parse({ provider_id: "x", date: "2026-07-01", requests: -1, tokens: 0 })).toThrow();
  });

  it("providerModelSchema parses valid model with costs and defaults missing costs to 0 (U-01)", () => {
    const m = providerModelSchema.parse({
      id: "m1", display_model: "v4", request_model: "v4",
      input_cost: 1, output_cost: 2, cache_hit_cost: 0.1, cache_create_cost: 0.5
    });
    expect(m.input_cost).toBe(1);
    // 缺省成本字段默认 0（迁移生成条目兼容）
    const partial = providerModelSchema.parse({ id: "m2", display_model: "v4-lite", request_model: "v4-lite" });
    expect(partial.input_cost).toBe(0);
    expect(partial.output_cost).toBe(0);
    expect(() => providerModelSchema.parse({ id: "m3", display_model: "x", request_model: "x", extra: 1 })).toThrow();
  });

  it("aiProviderConfig accepts multi-model fields (U-02)", () => {
    const parsed = aiProviderConfigSchema.parse(validProviderCfg);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.id).toBe("m1");
    expect(parsed.api_format).toBe("openai");
    expect(parsed.note).toBe("");
    expect(parsed.website).toBe("https://deepseek.com");
    expect(parsed.selected_model_id).toBe("m1");
    expect(parsed.sort_order).toBe(0);
  });

  it("aiProviderConfig legacy without models defaults to []/openai/null/0 (U-03 contracts)", () => {
    const legacy = {
      provider_id: "deepseek",
      label: "DeepSeek",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      enabled: true,
      is_default: true,
      api_key_env: "secret-file",
      revision: 1,
      created_at: "2026-06-28T00:00:00Z",
      updated_at: "2026-06-28T00:00:00Z"
    };
    const parsed = aiProviderConfigSchema.parse(legacy);
    expect(parsed.models).toEqual([]);
    expect(parsed.api_format).toBe("openai");
    expect(parsed.selected_model_id).toBeNull();
    expect(parsed.sort_order).toBe(0);
  });

  it("aiProviderConfig rejects invalid api_format (U-02b)", () => {
    expect(() => aiProviderConfigSchema.parse({ ...validProviderCfg, api_format: "gemini" })).toThrow();
  });

  it("aiQuotaUsage per-model fields parse with defaults (U-04)", () => {
    const parsed = aiQuotaUsageSchema.parse({
      provider_id: "deepseek", date: "2026-07-01", requests: 10, tokens: 500,
      model: "deepseek-v4-pro", input_tokens: 300, output_tokens: 200, cache_hit_tokens: 0, cost: 0.0007
    });
    expect(parsed.model).toBe("deepseek-v4-pro");
    expect(parsed.input_tokens).toBe(300);
    expect(parsed.cache_create_tokens).toBe(0);
    expect(parsed.cost).toBe(0.0007);
    // 旧条目（无 per-model 字段）默认 ""/0
    const legacy = aiQuotaUsageSchema.parse({ provider_id: "x", date: "2026-07-01", requests: 1, tokens: 10 });
    expect(legacy.model).toBe("");
    expect(legacy.input_tokens).toBe(0);
    expect(legacy.cache_create_tokens).toBe(0);
    expect(legacy.cost).toBe(0);
  });

  it("aiProviderReorderRequest requires non-empty provider_ids array (U-reorder)", () => {
    expect(aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: ["a", "b"] }).provider_ids).toEqual(["a", "b"]);
    expect(() => aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: [] })).toThrow();
    expect(() => aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: ["", "b"] })).toThrow();
    expect(() => aiProviderReorderRequestSchema.parse({ schema_version: 1, provider_ids: ["a"], extra: 1 })).toThrow();
  });

  it("aiProviderApiFormatSchema accepts openai/anthropic/custom only", () => {
    expect(aiProviderApiFormatSchema.parse("openai")).toBe("openai");
    expect(aiProviderApiFormatSchema.parse("anthropic")).toBe("anthropic");
    expect(aiProviderApiFormatSchema.parse("custom")).toBe("custom");
    expect(aiProviderApiFormatSchema.safeParse("gemini").success).toBe(false);
  });

  it("aiConfigState has nullable defaultProvider and providers array", () => {
    expect(aiConfigStateSchema.parse({ defaultProvider: null, providers: [] }).defaultProvider).toBeNull();
    expect(aiConfigStateSchema.parse({ defaultProvider: "deepseek", providers: [] }).providers).toEqual([]);
  });

  it("aiConfigState defaults usage to [] and accepts usage array", () => {
    expect(aiConfigStateSchema.parse({ defaultProvider: null, providers: [] }).usage).toEqual([]);
    const state = aiConfigStateSchema.parse({
      defaultProvider: "deepseek",
      providers: [],
      usage: [{ provider_id: "deepseek", date: "2026-07-01", requests: 5, tokens: 100 }]
    });
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]?.requests).toBe(5);
  });

  it("aiConfigState legacy data without usage migrates to [] (COM-001)", () => {
    const legacy = { defaultProvider: "deepseek", providers: [] };
    expect(aiConfigStateSchema.parse(legacy).usage).toEqual([]);
  });

  it("draftState defaults aiChecks to null (separate from program checks)", () => {
    const d = draftStateSchema.parse({
      slug: "harness-x",
      agent: "claude-code",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    });
    expect(d.aiChecks).toBeNull();
  });

  it("draftState requires agent field (per-agent version)", () => {
    const base = {
      slug: "harness-x",
      sourceFiles: [{ path: "SKILL.md", content: "..." }],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-26T00:00:00Z",
      updated_at: "2026-06-26T00:00:00Z"
    };
    expect(draftStateSchema.safeParse(base).success).toBe(false);
    expect(draftStateSchema.safeParse({ ...base, agent: "cursor" }).success).toBe(true);
    expect(draftStateSchema.parse({ ...base, agent: "cursor" }).agent).toBe("cursor");
  });

  it("registrySkillVersion requires agent field (per-agent version)", () => {
    const base = {
      skill_slug: "harness-x", version: "1.0.0", artifacts: [],
      source_proposal_id: null, sourceFiles: [], examples: [], changeNote: null,
      created_at: "2026-06-26T00:00:00Z"
    };
    expect(registrySkillVersionSchema.safeParse(base).success).toBe(false);
    expect(registrySkillVersionSchema.safeParse({ ...base, agent: "claude-code" }).success).toBe(true);
    expect(registrySkillVersionSchema.parse({ ...base, agent: "claude-code" }).agent).toBe("claude-code");
  });

  it("setDefaultAgentRequest requires defaultAgent + positive revision (strict)", () => {
    expect(setDefaultAgentRequestSchema.parse({ defaultAgent: "cursor", revision: 1 }).defaultAgent).toBe("cursor");
    expect(setDefaultAgentRequestSchema.safeParse({ defaultAgent: "cursor", revision: 0 }).success).toBe(false);
    expect(setDefaultAgentRequestSchema.safeParse({ defaultAgent: "invalid", revision: 1 }).success).toBe(false);
    expect(setDefaultAgentRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
    expect(() => setDefaultAgentRequestSchema.parse({ defaultAgent: "cursor", revision: 1, extra: 1 })).toThrow();
  });
});

describe("aiProviderWithKeySet schema (key_set 响应字段)", () => {
  const validWithKeySet = {
    provider_id: "deepseek",
    label: "DeepSeek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    enabled: true,
    is_default: true,
    api_key_env: "secret-file",
    revision: 1,
    created_at: "2026-06-28T00:00:00Z",
    updated_at: "2026-06-28T00:00:00Z",
    key_set: true
  };

  it("parses valid provider with key_set (U-01)", () => {
    const parsed = aiProviderWithKeySetSchema.parse(validWithKeySet);
    expect(parsed.key_set).toBe(true);
  });

  it("rejects missing key_set (U-02)", () => {
    const { key_set, ...withoutKeySet } = validWithKeySet;
    void key_set;
    expect(aiProviderWithKeySetSchema.safeParse(withoutKeySet).success).toBe(false);
  });

  it("rejects non-boolean key_set (U-03)", () => {
    expect(aiProviderWithKeySetSchema.safeParse({ ...validWithKeySet, key_set: "yes" }).success).toBe(false);
  });
});

describe("aiJobState schema (dedup key: slug+agent)", () => {
  const validAiJob = {
    jobId: "aijob_1",
    slug: "harness-review",
    agent: "claude-code",
    status: "running",
    result: null,
    error: null,
    createdAt: "2026-07-01T00:00:00Z",
    expiresAt: "2026-07-01T01:00:00Z"
  };

  it("parses valid AiJobState with slug+agent", () => {
    const parsed = aiJobStateSchema.parse(validAiJob);
    expect(parsed.slug).toBe("harness-review");
    expect(parsed.agent).toBe("claude-code");
    expect(parsed.status).toBe("running");
  });

  it("rejects missing slug (dedup key required)", () => {
    const { slug, ...withoutSlug } = validAiJob;
    void slug;
    expect(aiJobStateSchema.safeParse(withoutSlug).success).toBe(false);
  });

  it("rejects missing agent (dedup key required)", () => {
    const { agent, ...withoutAgent } = validAiJob;
    void agent;
    expect(aiJobStateSchema.safeParse(withoutAgent).success).toBe(false);
  });

  it("rejects invalid agent (must be registry agent)", () => {
    expect(aiJobStateSchema.safeParse({ ...validAiJob, agent: "unknown-agent" }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => aiJobStateSchema.parse({ ...validAiJob, extra: 1 })).toThrow();
  });

  it("accepts completed status with SkillCheckResult", () => {
    const completed = {
      ...validAiJob,
      status: "completed",
      result: {
        items: [],
        summary: { green: 0, yellow: 0, red: 0 },
        checkedAt: "2026-07-01T00:00:00Z"
      }
    };
    expect(aiJobStateSchema.parse(completed).status).toBe("completed");
  });
});

describe("OpenAPI v1", () => {
  it("covers every required client/server route", async () => {
    const path = fileURLToPath(
      new URL("../../../apps/server/openapi/hunter-harness-v1.yaml", import.meta.url)
    );
    const document = parseYaml(await readFile(path, "utf8")) as {
      openapi: string;
      paths: Record<string, unknown>;
    };

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      "/api/v1/projects:resolve",
      "/api/v1/projects/{project_id}/proposal-sessions",
      "/api/v1/proposal-sessions/{session_id}/blobs:query",
      "/api/v1/proposal-sessions/{session_id}/blobs/{content_sha256}",
      "/api/v1/proposal-sessions/{session_id}:finalize",
      "/api/v1/projects/{project_id}/update-manifest",
      "/api/v1/artifacts/{artifact_id}/manifest",
      "/api/v1/artifacts/{artifact_id}/blobs/{content_sha256}"
    ]));
  });
});

describe("fix plan schemas", () => {
  it("accepts a valid fix plan", () => {
    const plan = {
      items: [{
        checkId: "VERSION",
        action: "auto",
        label: "版本前进",
        affectedPaths: ["skill-ir.json"],
        riskDelta: null,
        message: "1.0.0 → 1.0.1"
      }],
      mergedFiles: [{ path: "skill-ir.json", status: "modified", publishedContent: "{}", draftContent: "{}\n" }],
      summary: { autoCount: 1, confirmCount: 0, suggestCount: 0, changedFiles: 1, changedLines: 1 }
    };
    expect(fixPlanSchema.parse(plan).items).toHaveLength(1);
  });

  it("rejects invalid action", () => {
    expect(() => fixActionSchema.parse("auto-magic")).toThrow();
  });

  it("rejects extra fields on fixPlan (strict)", () => {
    const plan = {
      items: [],
      mergedFiles: [],
      summary: { autoCount: 0, confirmCount: 0, suggestCount: 0, changedFiles: 0, changedLines: 0 },
      extra: true
    };
    expect(() => fixPlanSchema.parse(plan)).toThrow();
  });

  it("fixPlanItem accepts optional AI suggestion fields", () => {
    const item = {
      checkId: "AI_USAGE_EXAMPLES",
      action: "suggest",
      label: "使用示例",
      affectedPaths: [],
      riskDelta: null,
      message: "缺少示例",
      suggestedContent: '[{"title":"t","description":"d","request":"r","result":"s"}]',
      explanation: "补充一个使用示例",
      appliesTo: "examples",
      generatedAt: "2026-06-29T00:00:00.000Z"
    };
    expect(fixPlanItemSchema.safeParse(item).success).toBe(true);
  });

  it("fixPlanItem accepts legacy item without AI suggestion fields", () => {
    const legacy = {
      checkId: "VERSION",
      action: "auto",
      label: "版本",
      affectedPaths: ["skill-ir.json"],
      riskDelta: null,
      message: "bump"
    };
    expect(fixPlanItemSchema.safeParse(legacy).success).toBe(true);
  });

  it("fixPlanItem rejects non-whitelist appliesTo", () => {
    const item = {
      checkId: "x",
      action: "suggest",
      label: "l",
      affectedPaths: [],
      riskDelta: null,
      message: "m",
      appliesTo: "ir.secret"
    };
    expect(fixPlanItemSchema.safeParse(item).success).toBe(false);
  });
});

describe("cursor adapter + managed-block block_id (T1)", () => {
  it("cursor is a valid registry agent and adapter name", () => {
    expect(registryAgentSchema.safeParse("cursor").success).toBe(true);
    expect(adapterNameSchema.safeParse("cursor").success).toBe(true);
  });

  it("modify op accepts optional block_id for managed-block install", () => {
    const result = modifyOperationSchema.safeParse({
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "a".repeat(64),
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10,
      block_id: "harness-skill-x"
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.block_id).toBe("harness-skill-x");
    }
  });

  it("modify op without block_id still valid (backward compat)", () => {
    const result = modifyOperationSchema.safeParse({
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "a".repeat(64),
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10
    });
    expect(result.success).toBe(true);
  });

  it("add op accepts optional block_id", () => {
    const result = addOperationSchema.safeParse({
      operation: "add",
      path: "AGENTS.md",
      file_kind: "user_editable",
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10,
      block_id: "harness-skill-y"
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.block_id).toBe("harness-skill-y");
    }
  });

  it("fileOperation union dispatches modify with block_id", () => {
    const result = fileOperationSchema.safeParse({
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "a".repeat(64),
      content_sha256: "sha256:" + "b".repeat(64),
      size_bytes: 10,
      block_id: "harness-skill-z"
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.operation === "modify") {
      expect(result.data.block_id).toBe("harness-skill-z");
    }
  });
});

describe("workflow family schemas", () => {
  const manifest = {
    schema_version: 1 as const,
    profile: "general",
    files: [{ path: ".harness-build.json", sha256: "sha256:" + "a".repeat(64) }]
  };

  it("bundle manifest parses profile + file hashes", () => {
    const parsed = workflowBundleManifestSchema.parse(manifest);
    expect(parsed.profile).toBe("general");
    expect(parsed.files).toHaveLength(1);
  });

  it("draft state tracks per-profile bundles", () => {
    const draft = workflowFamilyDraftStateSchema.parse({
      family_slug: "harness",
      profiles: [{
        profile: "general",
        sourceFiles: [{ path: ".harness-build.json", content: "{}" }],
        bundle_manifest: manifest
      }],
      required_profiles: ["general"],
      draftVersion: "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-30T00:00:00Z",
      updated_at: "2026-06-30T00:00:00Z"
    });
    expect(draft.profiles[0].profile).toBe("general");
  });

  it("version carries profiles + artifacts + nullable changeNote", () => {
    const version = workflowFamilyVersionSchema.parse({
      family_slug: "harness",
      version: "1.0.0",
      profiles: [{
        profile: "general",
        bundle_manifest: manifest,
        artifact_id: "wfb_1",
        sourceFiles: []
      }],
      artifacts: [{
        artifact_id: "wfb_1",
        family_slug: "harness",
        profile: "general",
        version: "1.0.0",
        content_sha256: "sha256:" + "a".repeat(64),
        size_bytes: 10,
        bundle_manifest: manifest,
        created_at: "2026-06-30T00:00:00Z"
      }],
      changeNote: null,
      created_at: "2026-06-30T00:00:00Z"
    });
    expect(version.profiles).toHaveLength(1);
    expect(version.changeNote).toBeNull();
  });

  it("project binding uses family_slug + profile", () => {
    const binding = registryProjectWorkflowBindingSchema.parse({
      project_id: "prj_1",
      family_slug: "harness",
      profile: "general",
      version: "1.0.0",
      revision: 1,
      updated_at: "2026-06-30T00:00:00Z"
    });
    expect(binding.family_slug).toBe("harness");
  });

  it("publishWorkflowFamilyRequest requires version and accepts optional releaseNote", () => {
    expect(() => publishWorkflowFamilyRequestSchema.parse({})).toThrow();
    expect(publishWorkflowFamilyRequestSchema.parse({ version: "1.0.0" }).releaseNote).toBeUndefined();
    expect(publishWorkflowFamilyRequestSchema.parse({ version: "1.0.0", releaseNote: "init" }).releaseNote).toBe("init");
  });
});

describe("mcp tool contract schema (UT-010~012)", () => {
  const validContract = {
    tool_name: "harness-foo",
    description: "foo tool",
    input_schema: {
      type: "object",
      properties: { doc: { type: "string" } },
      required: ["doc"]
    }
  };

  it("round-trips a valid mcp tool contract (UT-010)", () => {
    const parsed = mcpToolContractSchema.parse(validContract);
    expect(parsed.tool_name).toBe("harness-foo");
    expect(parsed.description).toBe("foo tool");
    expect(parsed.input_schema).toEqual(validContract.input_schema);
  });

  it("rejects contract missing tool_name (UT-011)", () => {
    expect(mcpToolContractSchema.safeParse({
      description: "foo tool",
      input_schema: { type: "object", properties: {}, required: [] }
    }).success).toBe(false);
  });

  it("rejects contract missing input_schema (UT-012)", () => {
    expect(mcpToolContractSchema.safeParse({
      tool_name: "harness-foo",
      description: "foo tool"
    }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(mcpToolContractSchema.safeParse({ ...validContract, extra: 1 }).success).toBe(false);
  });
});

const contentSyncSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function readContentSyncFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    new URL(`./fixtures/${name}`, import.meta.url),
    "utf8"
  )) as Record<string, unknown>;
}

describe("content-sync canonical mirror", () => {
  it("locks the Harness canonical source and shared fixture bytes", async () => {
    const source = await readFile(new URL("../src/content-sync.ts", import.meta.url));
    const current = await readFile(
      new URL("./fixtures/content-sync-v1-current.json", import.meta.url)
    );
    const legacy = await readFile(
      new URL("./fixtures/content-sync-v0-legacy.json", import.meta.url)
    );

    // 2026-08-18：归档交付物（plans/spec/reports/docs）放行为 branch_file，
    // 并导出 mayContainArchiveDeliverables 供工作区遍历决定下钻。
    // 与 Hunter-Harness/packages/contracts/src/content-sync.ts 逐字节镜像。
    expect(contentSyncSha256(source)).toBe(
      "45b7ab01d0855dc2d287688055f165cb40cb34d84cab5691f5cda70d42eb11aa"
    );
    expect(contentSyncSha256(current)).toBe(
      "a5d700084708255d25a9be7de889024c5c8ce644dd671f300251369fa6fcdb4c"
    );
    expect(contentSyncSha256(legacy)).toBe(
      "5945db02c0fb5906d76d0ed85f82ccfb84c49d6c366780214f7052fa1656992a"
    );
  });

  it("keeps exact v1 enums and parses current status and candidate projections", async () => {
    const fixture = await readContentSyncFixture("content-sync-v1-current.json");
    const enums = fixture.enums as Record<string, unknown>;
    expect(contentKindSchema.options).toEqual([
      "config", "rule", "architecture", "instruction", "branch_file",
      "change_document", "archive_package", "knowledge_entry",
      "knowledge_candidate", "project_content_candidate"
    ]);
    expect(syncScopeSchema.options).toEqual([
      "config", "rules", "architecture", "instructions", "branch_files", "archive"
    ]);
    expect(syncDirectionSchema.options).toEqual(["push", "pull"]);
    expect(syncActionSchema.options).toEqual([
      "add", "modify", "delete", "restore", "rename", "no_change"
    ]);
    expect(conflictResolutionSchema.options).toEqual([
      "keep_local", "accept_remote", "skip", "cancel"
    ]);
    expect(pullPolicySchema.options).toEqual([
      "regular", "explicit_source_only", "not_pullable"
    ]);
    expect(contentScanPolicySchema.options).toEqual(["required", "skip_content_scan"]);
    expect(enums.content_kind).toEqual(contentKindSchema.options);

    const statuses = contentSyncStatusesSchema.parse(fixture.statuses);
    const candidates = fixture.candidates as Record<string, unknown>;
    const projectCandidate = projectContentCandidateSchema.parse(
      candidates.project_content_candidate
    );
    const knowledgeCandidate = knowledgeCandidateSchema.parse(candidates.knowledge_candidate);
    expectTypeOf(statuses).toEqualTypeOf<ContentSyncStatuses>();
    expectTypeOf(projectCandidate).toEqualTypeOf<ProjectContentCandidate>();
    expectTypeOf(knowledgeCandidate).toEqualTypeOf<KnowledgeCandidate>();
    expect(statuses).toMatchObject({
      archive_status: { status: "uploading" },
      change_index_status: { status: "indexing" },
      knowledge_extraction_status: { status: "extracting" },
      managed_snapshot_status: { status: "conflict" }
    });
    expect(projectCandidate.candidate_id).toMatch(/^pcc_/u);
    expect(knowledgeCandidate.candidate_id).toMatch(/^kc_/u);
  });

  it("projects strict remote identity and bounded snapshot pages", async () => {
    const fixture = await readContentSyncFixture("content-sync-v1-current.json");
    const identity = remoteVersionIdentitySchema.parse(fixture.remote_version_identity);
    const branches = branchSnapshotPageSchema.parse(fixture.branch_snapshots_page);
    const versions = snapshotVersionPageSchema.parse(fixture.snapshot_versions_page);
    const files = snapshotFilePageSchema.parse(fixture.snapshot_files_page);
    expectTypeOf(identity).toEqualTypeOf<RemoteVersionIdentity>();
    expectTypeOf(branches).toEqualTypeOf<BranchSnapshotPage>();
    expectTypeOf(versions).toEqualTypeOf<SnapshotVersionPage>();
    expectTypeOf(files).toEqualTypeOf<SnapshotFilePage>();
    expect(files.items.map((item) => item.path)).toEqual([
      ".harness/project.yaml", ".harness/rules/security.md", "AGENTS.md"
    ]);

    for (const [schema, value] of [
      [remoteVersionIdentitySchema, fixture.remote_version_identity],
      [branchSnapshotPageSchema, fixture.branch_snapshots_page],
      [snapshotVersionPageSchema, fixture.snapshot_versions_page],
      [snapshotFilePageSchema, fixture.snapshot_files_page]
    ] as const) {
      expect(schema.safeParse({ ...(value as object), unexpected: true }).success).toBe(false);
    }
    expect(branchSnapshotPageSchema.safeParse({
      items: Array.from({ length: 101 }, () => branches.items[0])
    }).success).toBe(false);
  });

  it("accepts legacy runtime receipts without inferring split statuses", async () => {
    const fixture = await readContentSyncFixture("content-sync-v0-legacy.json");
    const receipts = legacyArchivePackageReceiptSchema.array().parse(fixture.receipts);
    const expected = fixture.compatibility_results as unknown[];
    expect(receipts.map((receipt) => receipt.knowledge_status)).toEqual([
      "indexing", "ready", "failed"
    ]);
    for (const [index, receipt] of receipts.entries()) {
      const compatibility = getLegacyArchiveCompatibilityResult(receipt);
      expect(legacyArchiveCompatibilityResultSchema.parse(expected[index]))
        .toEqual(compatibility);
      expect(compatibility.complete_v1_statuses).toBe(false);
      expect(compatibility.change_index_status.availability).toBe("unavailable");
      expect(compatibility.knowledge_extraction_status.availability).toBe("unavailable");
      expect(compatibility.managed_snapshot_status.availability).toBe("unavailable");
    }
  });
});
