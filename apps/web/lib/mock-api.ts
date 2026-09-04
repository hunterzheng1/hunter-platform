import type {
  AgentTool,
  AgentToolMutation,
  AiProviderConfig,
  AiProviderWithKeySet,
  AiQuotaUsage,
  CodexConnectionState,
  CodexLoginStart,
  CreateExternalSkillRequest,
  DashboardOverview,
  DraftState,
  ExternalSkill,
  PatchExternalSkillRequest,
  RegistryAgent,
  RegistrySkillDetail,
  RegistrySkillVersion,
  RegistryTag,
  SkillCatalogOrder,
  UpdateSkillCatalogOrderRequest,
  WorkflowFamilySource,
  WorkflowFamilySourceImportResult,
  WorkflowFamilySourceInspection,
  ImportWorkflowFamilySourceRequest,
  WorkflowFamily,
  WorkflowFamilyDraftState,
  WorkflowFamilyDraftSummary,
  WorkflowFamilyMutation,
  WorkflowFamilyVersionSummary,
  SkillCheckItem,
  SkillCheckResult,
  SkillDiffFile,
  FixPlan,
  PublishSkillRequest,
  NpmReleaseResponse,
  SemanticDocument,
  SemanticEdge,
  SemanticOverview,
  PlatformInformationPage,
  PlatformInformationDetailResponse,
  RestoreBranchFilesIntent,
  RestoreBranchFilesPreviewReceipt,
  RestoreBranchFilesConfirmationIntent,
  RestoreBranchFilesConfirmedIntent,
  PlatformInformationRetryExtractionHttpRequest,
  KnowledgeExtractionRetryIntent
} from "@hunter-harness/contracts";

import { bootstrapSkills } from "./catalog";
import { findDemoSourceSkill, sapFieldMapper } from "./demo-skills/sap-field-mapper";
import { ApiClientError } from "./api";
import { platformInformationErrorStatus, type PlatformInformationOperationName } from "./platform-information-api";
import type {
  AiJobState,
  HunterApi,
  ProjectSummary,
  ProjectDetailModel,
  ProjectFileProposalInput,
  ProjectFileProposalResult,
  ProjectFilesSnapshot,
  ProjectFileContent,
  ProjectLifecycleResult,
  ProjectSemanticGraph,
  ProposalSummary,
  ArtifactSummary,
  ArtifactManifestModel,
  ProjectFileMetadata,
  ProposalDetailModel,
  ReviewInput,
  ReviewResult,
  KnowledgeIngestListItem,
} from "./api";

// ── Rich mock data for local dev / demo ─────────────────────

const MOCK_PROJECT_SEED: ProjectSummary[] = [
  {
    project_id: "agent-harness",
    display_name: "Agent Harness",
    role: "owner",
    latest_project_version: "v2.4.1",
    latest_artifact_id: "art_a7f3c91b",
    created_at: "2025-11-15T08:30:00Z",
    current_file_count: 128,
    updated_at: "2026-07-17T06:42:18Z",
  },
  {
    project_id: "skill-registry",
    display_name: "Skill Registry",
    role: "contributor",
    latest_project_version: "v1.8.0",
    latest_artifact_id: "art_2e6d401f",
    created_at: "2025-12-01T14:00:00Z",
    current_file_count: 64,
    updated_at: "2026-07-16T22:11:05Z",
  },
  {
    project_id: "governance-api",
    display_name: "Governance API",
    role: "admin",
    latest_project_version: "v3.0.2",
    latest_artifact_id: "art_9b4c7e12",
    created_at: "2026-01-10T09:15:00Z",
    current_file_count: 41,
    updated_at: "2026-07-15T14:03:47Z",
  },
  {
    project_id: "review-dashboard",
    display_name: "Review Dashboard",
    role: "reviewer",
    latest_project_version: "v0.9.3",
    latest_artifact_id: "art_d51e8a06",
    created_at: "2026-03-22T16:45:00Z",
    current_file_count: 33,
    updated_at: "2026-07-14T09:28:12Z",
  },
  {
    project_id: "hunter-cli",
    display_name: "Hunter CLI",
    role: "owner",
    latest_project_version: "v1.2.0",
    latest_artifact_id: null,
    created_at: "2026-05-05T11:00:00Z",
    current_file_count: 19,
    updated_at: "2026-07-10T11:00:33Z",
  },
];

const MOCK_PROJECT_EXTRAS: Array<{ id: string; name: string; role: ProjectSummary["role"]; updated_at: string; files: number; version: string | null }> = [
  { id: "knowledge-vault", name: "Knowledge Vault", role: "owner", updated_at: "2026-07-13T18:44:09Z", files: 52, version: "v1.1.0" },
  { id: "workflow-studio", name: "Workflow Studio", role: "contributor", updated_at: "2026-07-12T07:21:55Z", files: 27, version: "v0.6.4" },
  { id: "artifact-mirror", name: "Artifact Mirror", role: "admin", updated_at: "2026-07-11T16:02:41Z", files: 88, version: "v2.0.1" },
  { id: "policy-engine", name: "Policy Engine", role: "reviewer", updated_at: "2026-07-09T03:15:28Z", files: 15, version: "v1.4.2" },
  { id: "sync-gateway", name: "Sync Gateway", role: "owner", updated_at: "2026-07-08T21:59:01Z", files: 36, version: "v0.3.8" },
  { id: "prompt-lab", name: "Prompt Lab", role: "contributor", updated_at: "2026-07-07T12:36:19Z", files: 22, version: null },
  { id: "eval-bench", name: "Eval Bench", role: "admin", updated_at: "2026-07-06T08:08:08Z", files: 47, version: "v1.0.0" },
  { id: "memory-bridge", name: "Memory Bridge", role: "owner", updated_at: "2026-07-05T19:47:33Z", files: 11, version: "v0.2.5" },
  { id: "release-train", name: "Release Train", role: "reviewer", updated_at: "2026-07-03T10:10:10Z", files: 29, version: "v3.1.0" },
  { id: "ops-console", name: "Ops Console", role: "admin", updated_at: "2026-06-28T05:30:44Z", files: 73, version: "v1.7.9" },
];

const MOCK_PROJECTS: ProjectSummary[] = [
  ...MOCK_PROJECT_SEED,
  ...MOCK_PROJECT_EXTRAS.map((item) => ({
    project_id: item.id,
    display_name: item.name,
    role: item.role,
    latest_project_version: item.version,
    latest_artifact_id: item.version === null ? null : `art_${item.id.slice(0, 8)}`,
    created_at: "2026-01-01T00:00:00Z",
    current_file_count: item.files,
    updated_at: item.updated_at,
  })),
];

const MOCK_PROJECT_FILE_PATHS = [
  ".claude/rules/harness-general.md",
  ".claude/skills/harness-plan/SKILL.md",
  ".claude/skills/harness-run/SKILL.md",
  ".claude/skills/harness-test/SKILL.md",
  ".claude/skills/harness-archive/SKILL.md",
  ".cursor/rules/harness-general.mdc",
  ".cursor/skills/harness-sync/SKILL.md",
  ".harness/knowledge/architecture.md",
  ".harness/knowledge/index.json",
  ".harness/knowledge/entries/active/decision-one.json",
  ".harness/knowledge/entries/candidate/note-two.json",
  ".harness/state/local/status.json",
  ".harness/state/baseline/manifest.json",
  ".harness/codebase/map/STACK.md",
  ".harness/codebase/map/STRUCTURE.md",
  ".harness/codebase/map/TESTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "packages/cli/src/commands/push.ts",
  "packages/cli/src/commands/update.ts",
  "packages/core/src/push/push.ts",
  "packages/core/src/sync/synchronize.ts",
  "packages/contracts/src/index.ts",
  "apps/web/app/projects/page.tsx",
  "apps/web/components/project-workspace.tsx",
  "apps/web/components/project-registry.tsx",
  "apps/server/src/app.ts",
  "apps/server/src/registry/store.ts",
  "harness/scripts/harness_archive.py",
  "harness/scripts/harness_events.py",
  "harness/scripts/harness_gate.py",
  "harness/harness-plan/SKILL.md",
  "harness/harness-run/SKILL.md",
  "harness/protocols/powershell-protocol.md",
  "resources/harness/migrations/README.md",
  ...Array.from({ length: 24 }, (_, index) =>
    `.harness/knowledge/entries/stale/legacy-${String(index + 1).padStart(2, "0")}.json`
  )
] as const;

const MOCK_PROJECT_FILES: ProjectFileMetadata[] = MOCK_PROJECT_FILE_PATHS.map((path, index) => ({
  path,
  file_kind: path.includes("/state/") || path.endsWith("index.json") ? "internal_state" : "user_editable",
  content_sha256: "sha256:" + String(index + 1).padStart(64, "0"),
  size_bytes: 40 + index * 17,
  project_version: "v2.4.1",
  updated_at: "2026-07-14T08:30:00Z"
}));

const MOCK_PROPOSALS: ProposalSummary[] = [
  {
    proposal_id: "prop_a1b2c3",
    project_id: "agent-harness",
    status: "pending_review",
    created_at: "2026-06-20T10:00:00Z",
    changed_item_count: 3,
    risk_count: 0,
    base_project_version: "v2.4.0",
    created_by: "alice",
  },
  {
    proposal_id: "prop_d4e5f6",
    project_id: "skill-registry",
    status: "pending_review",
    created_at: "2026-06-19T15:30:00Z",
    changed_item_count: 7,
    risk_count: 1,
    base_project_version: "v1.7.2",
    created_by: "bob",
  },
  {
    proposal_id: "prop_g7h8i9",
    project_id: "governance-api",
    status: "pending_review",
    created_at: "2026-06-18T09:45:00Z",
    changed_item_count: 2,
    risk_count: 0,
    base_project_version: "v3.0.1",
    created_by: "carol",
  },
  {
    proposal_id: "prop_j0k1l2",
    project_id: "agent-harness",
    status: "approved",
    created_at: "2026-06-15T08:00:00Z",
    changed_item_count: 5,
    risk_count: 0,
    base_project_version: "v2.3.1",
    created_by: "alice",
  },
  {
    proposal_id: "prop_m3n4o5",
    project_id: "review-dashboard",
    status: "rejected",
    created_at: "2026-06-14T13:00:00Z",
    changed_item_count: 1,
    risk_count: 0,
    base_project_version: "v0.9.2",
    created_by: "dave",
  },
  {
    proposal_id: "prop_p6q7r8",
    project_id: "skill-registry",
    status: "approved",
    created_at: "2026-06-12T11:00:00Z",
    changed_item_count: 4,
    risk_count: 0,
    base_project_version: "v1.7.0",
    created_by: "bob",
  },
];

const MOCK_ARTIFACTS: ArtifactSummary[] = [
  {
    artifact_id: "art_a7f3c91b",
    project_id: "agent-harness",
    project_version: "pv_20260615_a",
    base_project_version: "pv_20260610_b",
    proposal_id: "prop_j0k1l2",
    changed_item_count: 47,
    manifest_sha256: "sha256:a1b2c3d4e5f60001",
    created_at: "2026-06-15T08:05:00Z",
  },
  {
    artifact_id: "art_b8e4d02c",
    project_id: "agent-harness",
    project_version: "pv_20260610_b",
    base_project_version: "pv_20260601_c",
    proposal_id: "prop_m3n4o5",
    changed_item_count: 3,
    manifest_sha256: "sha256:a1b2c3d4e5f60011",
    created_at: "2026-06-10T14:20:00Z",
  },
  {
    artifact_id: "art_c9f5e13d",
    project_id: "agent-harness",
    project_version: "pv_20260601_c",
    base_project_version: null,
    proposal_id: "prop_p6q7r8",
    changed_item_count: 8,
    manifest_sha256: "sha256:a1b2c3d4e5f60021",
    created_at: "2026-06-01T09:00:00Z",
  },
  {
    artifact_id: "art_2e6d401f",
    project_id: "skill-registry",
    project_version: "pv_20260612_a",
    base_project_version: "pv_20260605_b",
    proposal_id: "prop_s1t2u3",
    changed_item_count: 4,
    manifest_sha256: "sha256:b2c3d4e5f60002",
    created_at: "2026-06-12T11:30:00Z",
  },
  {
    artifact_id: "art_9b4c7e12",
    project_id: "governance-api",
    project_version: "pv_20260608_a",
    base_project_version: "pv_20260601_b",
    proposal_id: "prop_x9y0z1",
    changed_item_count: 8,
    manifest_sha256: "sha256:c3d4e5f60003",
    created_at: "2026-06-08T17:00:00Z",
  },
];

const MOCK_MANIFEST_FILES: Record<string, ArtifactManifestModel["files"]> = {
  art_a7f3c91b: [
    { operation: "add", path: ".harness/knowledge/entries/active/reuse-llm.json", file_kind: "user_editable", content_sha256: "sha256:" + "a".repeat(64), size_bytes: 1200 },
    { operation: "modify", path: ".claude/rules/harness-general.md", file_kind: "user_editable", base_content_sha256: "sha256:" + "b".repeat(64), content_sha256: "sha256:" + "c".repeat(64), size_bytes: 840 },
    { operation: "modify", path: "AGENTS.md", file_kind: "user_editable", base_content_sha256: "sha256:" + "d".repeat(64), content_sha256: "sha256:" + "e".repeat(64), size_bytes: 2100 },
    { operation: "add", path: ".harness/archive/2026-06-15-sample/reports/final/summary-data.json", file_kind: "generated_reviewable", content_sha256: "sha256:" + "f".repeat(64), size_bytes: 4096 },
    {
      operation: "delete",
      path: ".harness/knowledge/entries/candidate/old-note.json",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "1".repeat(64),
      tombstone: {
        deleted_at: "2026-06-15T08:00:00.000Z",
        reason: "superseded",
        previous_sha256: "sha256:" + "1".repeat(64)
      }
    },
    ...Array.from({ length: 42 }, (_, index) => {
      const n = String(index + 1).padStart(2, "0");
      const op = (["add", "modify", "delete"] as const)[index % 3] ?? "add";
      if (op === "add") {
        return {
          operation: "add" as const,
          path: `.harness/knowledge/entries/active/bulk-${n}.json`,
          file_kind: "user_editable" as const,
          content_sha256: "sha256:" + String(index % 10).repeat(64),
          size_bytes: 200 + index
        };
      }
      if (op === "modify") {
        return {
          operation: "modify" as const,
          path: `.claude/rules/bulk-${n}.md`,
          file_kind: "user_editable" as const,
          base_content_sha256: "sha256:" + String((index + 1) % 10).repeat(64),
          content_sha256: "sha256:" + String((index + 2) % 10).repeat(64),
          size_bytes: 300 + index
        };
      }
      return {
        operation: "delete" as const,
        path: `.harness/knowledge/entries/candidate/bulk-${n}.json`,
        file_kind: "user_editable" as const,
        base_content_sha256: "sha256:" + String((index + 3) % 10).repeat(64),
        tombstone: {
          deleted_at: "2026-06-15T08:00:00.000Z",
          reason: "cleanup",
          previous_sha256: "sha256:" + String((index + 3) % 10).repeat(64)
        }
      };
    })
  ],
  art_b8e4d02c: [
    { operation: "modify", path: ".harness/knowledge/index.json", file_kind: "user_editable", base_content_sha256: "sha256:" + "2".repeat(64), content_sha256: "sha256:" + "3".repeat(64), size_bytes: 900 },
    { operation: "add", path: ".harness/codebase/map/ARCHITECTURE.md", file_kind: "generated_reviewable", content_sha256: "sha256:" + "4".repeat(64), size_bytes: 3200 },
    {
      operation: "rename",
      from_path: ".harness/knowledge/notes/old.md",
      to_path: ".harness/knowledge/notes/reuse.md",
      file_kind: "user_editable",
      base_content_sha256: "sha256:" + "5".repeat(64),
      content_sha256: "sha256:" + "6".repeat(64),
      size_bytes: 500
    }
  ],
  art_c9f5e13d: [
    { operation: "add", path: "AGENTS.md", file_kind: "user_editable", content_sha256: "sha256:" + "7".repeat(64), size_bytes: 1800 },
    { operation: "add", path: ".harness/project.yaml", file_kind: "user_editable", content_sha256: "sha256:" + "8".repeat(64), size_bytes: 420 },
    { operation: "add", path: ".claude/rules/harness-general.md", file_kind: "user_editable", content_sha256: "sha256:" + "9".repeat(64), size_bytes: 700 }
  ]
};

// ── MockApiClient — returns mock data without any network call ──

const DELAY_MS = 60; // 保留一点异步感，但不再拖慢切换体验（原 400ms 叠加多请求导致明显卡顿）

const ALL_AGENTS: RegistryAgent[] = ["claude-code", "codex", "cursor", "codebuddy", "pi", "generic", "mcp"];

// sap-field-mapper demo 元数据（原 canonical IR 字段，现作为纯展示常量；源文件见 sapFieldMapper.source.files）。
const SAP_FIELD_MAPPER_DESCRIPTION = "Extract SAP/S4 table and field references from Markdown and build entity-class mapping tables.";
const SAP_FIELD_MAPPER_VERSION = "1.0.0";
const SAP_FIELD_MAPPER_KIND = "tooling" as const;

const MOCK_SKILLS: RegistrySkillDetail[] = bootstrapSkills.map((skill, index) => ({
  skill_id: "skl_demo_" + index,
  slug: skill.name,
  name: skill.name,
  description: skill.description,
  kind: skill.kind,
  tags: skill.kind === "governance" ? ["review"] : ["bootstrap"],
  status: "published",
  latest_version: skill.version,
  defaultAgent: "claude-code",
  agents: ALL_AGENTS.map((agent) => ({
    agent,
    enabled: true,
    isDefault: agent === "claude-code",
    installTarget: ".claude/skills/" + skill.name,
    latestVersion: agent === "claude-code" ? skill.version : null,
    draftVersion: null,
    sourcePackagePath: null
  })),
  revision: 1,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
  sourceFiles: skill.sourceFiles.map((f) => ({ path: f.path, content: f.content })),
  examples: [],
  npmReleases: []
}));

MOCK_SKILLS.push({
  skill_id: "skl_demo_sap_field_mapper",
  slug: sapFieldMapper.slug,
  name: sapFieldMapper.slug,
  description: SAP_FIELD_MAPPER_DESCRIPTION,
  kind: SAP_FIELD_MAPPER_KIND,
  tags: ["sap", "source-package"],
  status: "published",
  latest_version: SAP_FIELD_MAPPER_VERSION,
  defaultAgent: "claude-code",
  agents: [
    { agent: "claude-code", enabled: true, isDefault: true, installTarget: ".claude/skills/" + sapFieldMapper.slug, latestVersion: SAP_FIELD_MAPPER_VERSION, draftVersion: null, sourcePackagePath: null },
    { agent: "codex", enabled: true, isDefault: false, installTarget: ".harness/generated/codex/" + sapFieldMapper.slug, latestVersion: null, draftVersion: null, sourcePackagePath: null }
  ],
  revision: 1,
  created_at: "2026-06-25T00:00:00Z",
  updated_at: "2026-06-25T00:00:00Z",
  sourceFiles: sapFieldMapper.source.files.map((f) => ({ path: f.path, content: f.content })),
  examples: [],
  npmReleases: []
});

const MOCK_TAGS: RegistryTag[] = [
  { tag_id: "tag_demo_bootstrap", slug: "bootstrap", label: "Bootstrap", active: true, revision: 1, usageCount: 0, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" },
  { tag_id: "tag_demo_review", slug: "review", label: "Review", active: true, revision: 1, usageCount: 0, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" }
];

const MOCK_EXTERNAL_SKILLS: ExternalSkill[] = [
  {
    id: "ext_demo_firecrawl",
    source: { type: "npm", ref: "@mendable/firecrawl-js" },
    snapshot: {
      name: "@mendable/firecrawl-js",
      description: "Official Firecrawl JS SDK for web scraping and crawling.",
      version: "1.21.0",
      readme: "# Firecrawl JS\n\nInstall via npm and follow the upstream docs.",
      installCommand: "npm install @mendable/firecrawl-js",
      license: "MIT",
      homepage: "https://www.npmjs.com/package/@mendable/firecrawl-js",
      releaseUrl: "https://www.npmjs.com/package/@mendable/firecrawl-js",
      fetchedAt: "2026-07-12T00:00:00.000Z"
    },
    curationNote: "Useful for research skills that need reliable page extraction.",
    tags: ["research"],
    updateAvailable: true,
    availableVersion: "1.22.0",
    updateHistory: [],
    lastCheckedAt: "2026-07-12T00:00:00.000Z",
    revision: 1,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z"
  },
  {
    id: "ext_demo_superpowers",
    source: { type: "github", ref: "obra/superpowers" },
    snapshot: {
      name: "obra/superpowers",
      description: "Composable agent skills and workflows.",
      version: "v4.0.0",
      readme: "# Superpowers\n\nInstall from the official GitHub repository.",
      installCommand: "https://github.com/obra/superpowers",
      license: "MIT",
      homepage: "https://github.com/obra/superpowers",
      releaseUrl: "https://github.com/obra/superpowers/releases/tag/v4.0.0",
      fetchedAt: "2026-07-12T00:00:00.000Z"
    },
    curationNote: "Keep as upstream reference; do not mirror into the registry.",
    tags: ["skills"],
    updateAvailable: false,
    availableVersion: null,
    updateHistory: [],
    lastCheckedAt: "2026-07-12T00:00:00.000Z",
    revision: 1,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z"
  }
];

const MOCK_WORKFLOW_FAMILIES: WorkflowFamily[] = [{
  family_id: "wff_harness",
  slug: "harness",
  displayName: "Harness 工作流",
  description: "hunter-harness CLI 的标准变更工作流：计划 → 编码 → 测试 → 评审 → 提交 → 归档（java overlay 另含打包与接口文档条件阶段）。",
  tags: ["harness", "sdd"],
  latest_version: "0.2.51",
  required_profiles: ["general"],
  revision: 12,
  npmReleases: [{
    packageName: "hunter-harness",
    version: "0.2.51",
    status: "published",
    publishedAt: "2026-08-01T09:20:00Z",
    error: null
  }],
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-08-01T09:20:00Z"
}, {
  family_id: "wff_demo_general",
  slug: "general",
  displayName: "General",
  description: "Explicit read-only demo workflow family",
  tags: ["bootstrap"],
  latest_version: "1.0.0",
  required_profiles: ["general"],
  revision: 1,
  npmReleases: [],
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z"
}];

const MOCK_AGENT_TOOLS: AgentTool[] = [
  {
    tool_id: "atl_pi_coding_agent",
    slug: "pi-coding-agent",
    displayName: "Pi Coding Agent",
    description: "面向终端的编码 Agent 运行时；保留 monorepo 中 coding-agent 包的精确来源路径。",
    category: "runtime",
    status: "active",
    source: {
      type: "github",
      ref: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent"
    },
    homepage: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
    packageName: null,
    installCommand: null,
    tags: ["coding-agent", "terminal"],
    relatedWorkflowFamilies: [],
    revision: 1,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z"
  },
  {
    tool_id: "atl_hunter_harness",
    slug: "hunter-harness",
    displayName: "Hunter Harness",
    description: "用于规范、执行和治理 Agent 开发工作流的 harness 与 CLI。",
    category: "harness",
    status: "active",
    source: { type: "github", ref: "https://github.com/hunterzheng1/Hunter-Harness" },
    homepage: "https://github.com/hunterzheng1/Hunter-Harness",
    packageName: "@hunter-harness/cli",
    installCommand: "npx @hunter-harness/cli",
    tags: ["harness", "workflow"],
    relatedWorkflowFamilies: ["harness"],
    revision: 1,
    created_at: "2026-08-01T08:00:00Z",
    updated_at: "2026-08-01T08:00:00Z"
  },
  {
    tool_id: "atl_herdr",
    slug: "herdr",
    displayName: "Herdr",
    description: "用于组织和编排多个编码 Agent 的开发工具。",
    category: "orchestrator",
    status: "experimental",
    source: { type: "github", ref: "https://github.com/herdrdev/herdr" },
    homepage: "https://github.com/herdrdev/herdr",
    packageName: null,
    installCommand: null,
    tags: ["multi-agent", "orchestration"],
    relatedWorkflowFamilies: [],
    revision: 1,
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:00:00Z"
  },
  {
    tool_id: "atl_orca",
    slug: "orca",
    displayName: "Orca",
    description: "围绕仓库、工作树和 Agent 会话构建的开发环境。",
    category: "ade",
    status: "experimental",
    source: { type: "github", ref: "https://github.com/stablyai/orca" },
    homepage: "https://github.com/stablyai/orca",
    packageName: null,
    installCommand: null,
    tags: ["ade", "worktree"],
    relatedWorkflowFamilies: [],
    revision: 1,
    created_at: "2026-07-30T08:00:00Z",
    updated_at: "2026-07-30T08:00:00Z"
  }
];

const MOCK_HARNESS_VERSIONS: WorkflowFamilyVersionSummary[] = [
  { version: "0.2.51", changeNote: "events-sync 断点续传与 ACK 游标修复", created_at: "2026-08-01T09:20:00Z" },
  { version: "0.2.50", changeNote: "archive 阶段产出归一化报告 normalizedReport", created_at: "2026-07-25T15:02:00Z" },
  { version: "0.2.49", changeNote: "新增 java overlay 的 package / apidoc 条件阶段", created_at: "2026-07-18T11:40:00Z" }
].map((entry) => ({
  family_slug: "harness",
  version: entry.version,
  profiles: [{
    profile: "general",
    bundle_manifest: { schema_version: 1, profile: "general", files: [{ path: "workflow.yaml", sha256: "sha256:" + "a".repeat(64) }] },
    artifact_id: `wfb_harness_${entry.version.replaceAll(".", "_")}`,
    file_count: 1
  }],
  artifacts: [],
  changeNote: entry.changeNote,
  created_at: entry.created_at
}));

function mockSemanticDoc(
  projectId: string,
  kind: SemanticDocument["kind"],
  title: string,
  body: string,
  path: string,
  metadata: Record<string, unknown> = {}
): SemanticDocument {
  return {
    document_id: `sem_${kind}_${title.replaceAll(/\W+/g, "_").toLowerCase()}`,
    project_id: projectId,
    artifact_id: "art_demo",
    kind,
    source_path: path,
    title,
    body,
    metadata,
    content_sha256: "sha256:" + "a".repeat(64)
  };
}

const MOCK_KNOWLEDGE_STATUSES = ["active", "candidate", "superseded", "archived"] as const;
const MOCK_KNOWLEDGE_TOPICS = [
  "Reuse LlmClient", "Gate policy calibration", "Ledger status vocabulary", "PowerShell path protocol",
  "Bundle hash stability", "Worktree npm isolation", "Semantic index rebuild", "Archive report pipeline",
  "Context pack export", "Skill deploy adapters", "Codegraph explore first", "Evidence honesty rules",
  "Windows shell hooks", "Cursor skill sync", "Knowledge promote judge", "Change folder layout",
  "Profile exclusion", "Smoke pack checks", "Vitest worker limits", "Fastify inject tests"
] as const;

function mockProjectKnowledge(projectId: string): SemanticDocument[] {
  return Array.from({ length: 86 }, (_, index) => {
    const status = MOCK_KNOWLEDGE_STATUSES[index % MOCK_KNOWLEDGE_STATUSES.length] ?? "active";
    const topic = MOCK_KNOWLEDGE_TOPICS[index % MOCK_KNOWLEDGE_TOPICS.length] ?? "Knowledge entry";
    const title = index === 0 ? topic : `${topic} #${String(index).padStart(2, "0")}`;
    const folder = status === "active" || status === "candidate" ? status : "archived";
    return mockSemanticDoc(
      projectId,
      index % 7 === 0 ? "knowledge_markdown" : "knowledge_entry",
      title,
      `## ${title}\n\nDemo knowledge body for local UI review.\n\n- Status: ${status}\n- Topic cluster: ${topic}\n`,
      `.harness/knowledge/entries/${folder}/${title.replaceAll(/\W+/g, "-").toLowerCase()}.json`,
      { status, tags: [topic.split(" ")[0]?.toLowerCase() ?? "knowledge", status] }
    );
  });
}

const MOCK_AI_PROVIDERS: AiProviderConfig[] = [
  { provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-v4-pro", enabled: true, is_default: true, api_key_env: "secret-file", revision: 1, daily_request_limit: 1000, daily_token_limit: 500000, created_at: "2026-06-25T09:30:00Z", updated_at: "2026-06-25T09:30:00Z", models: [{ id: "ds-chat", display_model: "DeepSeek Chat", request_model: "deepseek-chat", input_cost: 0.27, output_cost: 1.1, cache_hit_cost: 0.07, cache_create_cost: 0.27 }, { id: "ds-reasoner", display_model: "DeepSeek Reasoner", request_model: "deepseek-reasoner", input_cost: 0.55, output_cost: 2.19, cache_hit_cost: 0.14, cache_create_cost: 0.55 }], api_format: "openai", note: "主力供应商", website: "https://platform.deepseek.com", selected_model_id: "ds-chat", sort_order: 0 },
  { provider_id: "openai", label: "OpenAI", base_url: "https://api.openai.com", model: "gpt-4o", enabled: false, is_default: false, api_key_env: "secret-file", revision: 1, daily_request_limit: null, daily_token_limit: null, created_at: "2026-06-25T09:35:00Z", updated_at: "2026-06-25T09:35:00Z", models: [{ id: "o4o", display_model: "GPT-4o", request_model: "gpt-4o", input_cost: 2.5, output_cost: 10, cache_hit_cost: 1.25, cache_create_cost: 0 }], api_format: "openai", note: "", website: "https://platform.openai.com", selected_model_id: "o4o", sort_order: 1 }
];

const MOCK_DASHBOARD: DashboardOverview = {
  generated_at: "2026-06-22T12:00:00.000Z",
  window: { days: 7, starts_at: "2026-06-16T00:00:00.000Z", ends_at: "2026-06-22T12:00:00.000Z" },
  metrics: {
    projects: 5, workflows: 1, skills: MOCK_SKILLS.length, published_skills: MOCK_SKILLS.length,
    pending_reviews: 3, approved_proposals: 2, rejected_proposals: 1,
    artifacts: 15, project_artifacts: 3, skill_artifacts: 12,
    local_skills: MOCK_SKILLS.length, external_skills: 2,
    knowledge_entries: 18, knowledge_relations: 7,
    ai_requests: 26, ai_tokens: 18_400, ai_cost: 0.42
  },
  trend: [
    { date: "2026-06-16", submitted: 1, approved: 1, rejected: 0, pending: 0 },
    { date: "2026-06-17", submitted: 3, approved: 1, rejected: 0, pending: 1 },
    { date: "2026-06-18", submitted: 2, approved: 0, rejected: 1, pending: 1 },
    { date: "2026-06-19", submitted: 4, approved: 2, rejected: 0, pending: 2 },
    { date: "2026-06-20", submitted: 2, approved: 1, rejected: 0, pending: 1 },
    { date: "2026-06-21", submitted: 1, approved: 1, rejected: 0, pending: 0 },
    { date: "2026-06-22", submitted: 3, approved: 1, rejected: 0, pending: 2 }
  ],
  distributions: {
    skill_categories: [
      { key: "workflow", count: 5 }, { key: "governance", count: 3 },
      { key: "tooling", count: 2 }, { key: "migration", count: 2 }
    ],
    workflow_profiles: [{ key: "general", count: 1 }],
    knowledge_categories: [
      { key: "knowledge", count: 18 }, { key: "rules", count: 5 },
      { key: "architecture", count: 3 }, { key: "changes", count: 7 },
      { key: "instructions", count: 4 }, { key: "relations", count: 7 }
    ]
  },
  ai_usage: [
    { date: "2026-06-16", requests: 2, tokens: 900, cost: 0.02 },
    { date: "2026-06-17", requests: 3, tokens: 1_800, cost: 0.04 },
    { date: "2026-06-18", requests: 4, tokens: 2_400, cost: 0.06 },
    { date: "2026-06-19", requests: 5, tokens: 3_700, cost: 0.09 },
    { date: "2026-06-20", requests: 3, tokens: 2_000, cost: 0.05 },
    { date: "2026-06-21", requests: 4, tokens: 3_100, cost: 0.07 },
    { date: "2026-06-22", requests: 5, tokens: 4_500, cost: 0.09 }
  ],
  health: [
    { key: "review_backlog", label: "Review backlog", status: "attention", value: "3 pending", detail: "Human review is required before pending proposals can publish." },
    { key: "review_outcome", label: "Review outcome", status: "healthy", value: "2/3 approved", detail: "Calculated from recorded review decisions." },
    { key: "artifact_traceability", label: "Artifact traceability", status: "healthy", value: "15/15 linked", detail: "Every demo artifact has a governed source." },
    { key: "audit_evidence", label: "Audit evidence", status: "healthy", value: "12 recent events", detail: "Recent immutable audit entries are available." }
  ],
  services: [
    { key: "api", label: "Governance API", status: "operational", detail: "Authenticated overview request completed.", checked_at: "2026-06-22T12:00:00.000Z" },
    { key: "repository", label: "Project repository", status: "operational", detail: "Projects, proposals, and artifacts were read successfully.", checked_at: "2026-06-22T12:00:00.000Z" },
    { key: "registry", label: "Skill registry", status: "operational", detail: "Skill and Workflow metadata were read successfully.", checked_at: "2026-06-22T12:00:00.000Z" },
    { key: "audit", label: "Audit log", status: "operational", detail: "Recent audit events were read without exposing details.", checked_at: "2026-06-22T12:00:00.000Z" }
  ],
  activity: [
    { event_id: "evt_demo_1", action: "skill.proposal.created", target_id: "skp_demo_1", project_id: null, actor_id: "actor_owner", created_at: "2026-06-22T11:40:00.000Z" },
    { event_id: "evt_demo_2", action: "workflow.updated", target_id: "wf_demo_general", project_id: null, actor_id: "actor_owner", created_at: "2026-06-22T10:20:00.000Z" }
  ]
};

function demoReadOnly(): never {
  throw new ApiClientError(403, "DEMO_READ_ONLY", "Demo mode is read-only and did not write server state.");
}

function platformInformationDemoUnavailable(
  operationName: PlatformInformationOperationName,
  message: string,
): never {
  const status = platformInformationErrorStatus(operationName, "PLATFORM_INFORMATION_UNAVAILABLE");
  if (status === null) throw new Error(message);
  throw new ApiClientError(status, "PLATFORM_INFORMATION_UNAVAILABLE", message);
}

function demoChecksToResult(checks: readonly SkillCheckItem[]): SkillCheckResult {
  const items: SkillCheckItem[] = checks.map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status,
    message: c.message,
    filePath: c.filePath,
    fixable: c.fixable
  }));
  return {
    items,
    summary: {
      green: items.filter((i) => i.status === "green").length,
      yellow: items.filter((i) => i.status === "yellow").length,
      red: items.filter((i) => i.status === "red").length
    },
    checkedAt: "2026-06-25T15:20:00Z"
  };
}

function demoDiffToFiles(diffFiles: readonly SkillDiffFile[] | undefined): SkillDiffFile[] {
  return (diffFiles ?? []).map((d) => ({
    path: d.path,
    status: d.status,
    publishedContent: d.publishedContent,
    draftContent: d.draftContent
  }));
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), DELAY_MS));
}

export class MockApiClient implements HunterApi {
  private skillCatalogOrder: SkillCatalogOrder = { items: [], revision: 0, updated_at: null };
  private readonly projectLifecycle = new Map<string, {
    state: "active" | "archived" | "purged";
    archivedAt: string | null;
    purgeAfter: string | null;
    purgedAt: string | null;
  }>();

  async getDashboardOverview(): Promise<DashboardOverview> { return delay(clone(MOCK_DASHBOARD)); }

  async listPlatformInformation(
    projectId: string,
    view: PlatformInformationPage["view"],
  ): Promise<PlatformInformationPage> {
    const sortByView: Record<PlatformInformationPage["view"], PlatformInformationPage["sort"]> = {
      branch_monitor: "last_event_at_desc_run_id_asc",
      branch_files: "uploaded_at_desc_snapshot_version_asc",
      project_materials: "category_asc_path_asc_version_desc",
      project_knowledge: "extracted_at_desc_knowledge_id_asc",
    };
    return delay({
      schema_version: 1,
      contract_kind: "page",
      view,
      project_id: projectId,
      page_state: "processing",
      sort: sortByView[view],
      items: [],
      next_cursor: null,
      failures: [],
    });
  }

  async getPlatformInformationDetail(
    _projectId: string,
    _view: PlatformInformationPage["view"],
    _detailId: string,
  ): Promise<PlatformInformationDetailResponse> {
    void _projectId; void _view; void _detailId;
    return platformInformationDemoUnavailable("detail", "Platform information detail is unavailable in demo mode.");
  }

  async previewBranchFilesRestore(
    _projectId: string,
    _intent: RestoreBranchFilesIntent,
  ): Promise<RestoreBranchFilesPreviewReceipt> {
    void _projectId; void _intent;
    return platformInformationDemoUnavailable("preview_restore", "Branch restore is unavailable in demo mode.");
  }

  async confirmBranchFilesRestore(
    _projectId: string,
    _body: { preview_receipt: RestoreBranchFilesPreviewReceipt; confirmation_intent: RestoreBranchFilesConfirmationIntent },
  ): Promise<RestoreBranchFilesConfirmedIntent> {
    void _projectId; void _body;
    return platformInformationDemoUnavailable("confirm_restore", "Branch restore confirmation is unsupported in demo mode.");
  }

  async retryProjectKnowledgeExtraction(
    _projectId: string,
    _body: PlatformInformationRetryExtractionHttpRequest,
  ): Promise<KnowledgeExtractionRetryIntent> {
    void _projectId; void _body;
    return platformInformationDemoUnavailable("retry_extraction", "Knowledge extraction retry is unavailable in demo mode.");
  }

  async listSkills(): Promise<RegistrySkillDetail[]> {
    return delay(clone(MOCK_SKILLS));
  }

  async getSkillCatalogOrder(): Promise<SkillCatalogOrder> {
    return delay(clone(this.skillCatalogOrder));
  }

  async updateSkillCatalogOrder(input: UpdateSkillCatalogOrderRequest): Promise<SkillCatalogOrder> {
    if (input.revision !== this.skillCatalogOrder.revision) {
      throw new ApiClientError(409, "SKILL_CATALOG_ORDER_CONFLICT", "Demo catalog order revision is stale.");
    }
    this.skillCatalogOrder = {
      items: [...input.items],
      revision: input.revision + 1,
      updated_at: new Date().toISOString()
    };
    return delay(clone(this.skillCatalogOrder));
  }

  async listExternalSkills(): Promise<ExternalSkill[]> {
    return delay(clone(MOCK_EXTERNAL_SKILLS));
  }

  async getExternalSkill(id: string): Promise<ExternalSkill> {
    const skill = MOCK_EXTERNAL_SKILLS.find((item) => item.id === id);
    if (skill === undefined) throw new ApiClientError(404, "EXTERNAL_SKILL_NOT_FOUND", "Demo external skill not found.");
    return delay(clone(skill));
  }

  async createExternalSkill(_input: CreateExternalSkillRequest): Promise<ExternalSkill> {
    void _input;
    return demoReadOnly();
  }

  async patchExternalSkill(_id: string, _input: PatchExternalSkillRequest): Promise<ExternalSkill> {
    void _id;
    void _input;
    return demoReadOnly();
  }

  async refreshExternalSkill(_id: string): Promise<ExternalSkill> {
    void _id;
    return demoReadOnly();
  }

  async checkExternalSkill(_id: string): Promise<ExternalSkill> {
    void _id;
    return demoReadOnly();
  }

  async refreshExternalSkillUpdateHistory(_id: string, _appliedAt: string): Promise<ExternalSkill> {
    void _id;
    void _appliedAt;
    return demoReadOnly();
  }

  async generateExternalSkillSummary(_id: string, _revision: number, _force = false): Promise<ExternalSkill> {
    void _id;
    void _revision;
    void _force;
    return demoReadOnly();
  }

  async deleteExternalSkill(_id: string): Promise<{ id: string; deleted: boolean }> {
    void _id;
    return demoReadOnly();
  }

  async getSkill(slug: string): Promise<RegistrySkillDetail> {
    const skill = MOCK_SKILLS.find((item) => item.slug === slug);
    if (skill === undefined) throw new ApiClientError(404, "SKILL_NOT_FOUND", "Demo Skill not found.");
    return delay(clone(skill));
  }

  async listSkillVersions(slug: string, agent?: RegistryAgent): Promise<RegistrySkillVersion[]> {
    const skill = await this.getSkill(slug);
    const versionAgent = agent ?? skill.defaultAgent ?? skill.agents[0]?.agent ?? "claude-code";
    return delay([{ skill_slug: slug, version: skill.latest_version ?? "1.0.0", agent: versionAgent, artifacts: [], source_proposal_id: null, sourceFiles: [], examples: [], changeNote: null, created_at: skill.updated_at }]);
  }

  async getSkillAdapterPreview(slug: string, agent: RegistryAgent) {
    const sourceSkill = findDemoSourceSkill(slug);
    if (sourceSkill !== undefined) {
      const content = sourceSkill.preview(agent);
      if (content === null) throw new ApiClientError(422, "ADAPTER_NOT_INSTALLABLE", "Demo adapter is contract-only.");
      const path = agent === "claude-code"
        ? `.claude/skills/${slug}/SKILL.md`
        : `.harness/generated/codex/${slug}/SKILL.md`;
      return delay({ path, content, sourceIrHash: "sha256:" + "d".repeat(64), compilerVersion: "demo-source-package", adapter: agent });
    }
    const skill = await this.getSkill(slug);
    if (agent !== "claude-code") throw new ApiClientError(422, "ADAPTER_NOT_INSTALLABLE", "Demo adapter is contract-only.");
    return delay({ path: `.claude/skills/${slug}/SKILL.md`, content: `# ${slug}\n\n${skill.description}\n`, sourceIrHash: "sha256:" + "d".repeat(64), compilerVersion: "1.0.0", adapter: agent });
  }

  async listTags(): Promise<RegistryTag[]> { return delay(clone(MOCK_TAGS)); }
  async listWorkflowFamilies(): Promise<WorkflowFamily[]> { return delay(clone(MOCK_WORKFLOW_FAMILIES)); }
  async listAgentTools(): Promise<AgentTool[]> { return delay(clone(MOCK_AGENT_TOOLS)); }
  async getAgentTool(slug: string): Promise<AgentTool> {
    const tool = MOCK_AGENT_TOOLS.find((item) => item.slug === slug);
    if (tool === undefined) throw new ApiClientError(404, "AGENT_TOOL_NOT_FOUND", "Demo agent tool not found.");
    return delay(clone(tool));
  }
  async createAgentTool(input: AgentToolMutation): Promise<AgentTool> { void input; return demoReadOnly(); }
  async inspectAgentToolGithub(): Promise<never> { return demoReadOnly(); }
  async generateAgentToolPrefill(): Promise<never> { return demoReadOnly(); }
  async listSkillArtifacts() { return delay([]); }
  async downloadSkillArtifact(): Promise<{ blob: Blob; hash: string; filename: string }> { return demoReadOnly(); }
  async createTag(): Promise<RegistryTag> { return demoReadOnly(); }
  async updateTag(): Promise<RegistryTag> { return demoReadOnly(); }
  async mergeTag(): Promise<RegistryTag> { return demoReadOnly(); }
  async bindSkillTag(): Promise<RegistrySkillDetail> { return demoReadOnly(); }
  async createWorkflowFamily(input: WorkflowFamilyMutation): Promise<WorkflowFamily> { void input; return demoReadOnly(); }
  async inspectWorkflowFamilySource(source: WorkflowFamilySource): Promise<WorkflowFamilySourceInspection> {
    const isNpm = source.type === "npm";
    return delay({
      source: clone(source),
      source_digest: "sha256:" + "d".repeat(64),
      remote_version: isNpm ? "0.2.64" : null,
      manifest_detected: true,
      suggested: {
        slug: isNpm ? "harness" : "example-workflow",
        displayName: isNpm ? "Harness" : "Example workflow",
        description: "Demo preflight result. No remote request was made.",
        tags: isNpm ? ["harness"] : []
      },
      profiles: [
        { profile: "general", file_count: 3 },
        { profile: "java", file_count: 2 }
      ],
      warnings: [],
      ready: true
    });
  }
  async importWorkflowFamilySource(
    input: Omit<ImportWorkflowFamilySourceRequest, "schema_version">
  ): Promise<WorkflowFamilySourceImportResult> {
    void input;
    return demoReadOnly();
  }
  async getWorkflowFamily(slug: string): Promise<WorkflowFamily> {
    const family = MOCK_WORKFLOW_FAMILIES.find((item) => item.slug === slug);
    if (family === undefined) throw new ApiClientError(404, "WORKFLOW_FAMILY_NOT_FOUND", "Demo workflow family not found.");
    return delay(clone(family));
  }
  async uploadWorkflowFamilyProfileDraft(): Promise<WorkflowFamilyDraftState> { return demoReadOnly(); }
  async getWorkflowFamilyDraft(slug: string): Promise<WorkflowFamilyDraftSummary> {
    const family = MOCK_WORKFLOW_FAMILIES.find((item) => item.slug === slug);
    if (family === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo workflow family draft not found.");
    return delay({
      family_slug: family.slug,
      profiles: [],
      required_profiles: family.required_profiles,
      draftVersion: null,
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z"
    });
  }
  async discardWorkflowFamilyDraft(): Promise<{ slug: string; discarded: boolean }> { return demoReadOnly(); }
  async runWorkflowFamilyDraftChecks(slug: string): Promise<SkillCheckResult> {
    void slug;
    return delay(demoChecksToResult([
      { id: "WF_BUNDLE_MANIFEST", label: "Bundle manifest", status: "green", message: "ok", filePath: null, fixable: false }
    ]));
  }
  async publishWorkflowFamilyDraft(): Promise<WorkflowFamilyVersionSummary> { return demoReadOnly(); }
  async diffWorkflowFamilyDraft(): Promise<SkillDiffFile[]> { return []; }
  async listWorkflowFamilyVersions(slug: string): Promise<WorkflowFamilyVersionSummary[]> {
    const family = MOCK_WORKFLOW_FAMILIES.find((item) => item.slug === slug);
    if (family === undefined || family.latest_version === null) return delay([]);
    if (slug === "harness") return delay(clone(MOCK_HARNESS_VERSIONS));
    return delay([{
      family_slug: family.slug,
      version: family.latest_version,
      profiles: [{ profile: "general", bundle_manifest: { schema_version: 1, profile: "general", files: [{ path: "workflow.yaml", sha256: "sha256:" + "a".repeat(64) }] }, artifact_id: "wfb_demo_general", file_count: 1 }],
      artifacts: [],
      changeNote: "Demo release",
      created_at: "2026-06-20T00:00:00Z"
    }]);
  }
  async downloadWorkflowFamilyArtifact(): Promise<{ blob: Blob; hash: string; filename: string }> { return demoReadOnly(); }
  async releaseWorkflowFamilyToNpm(slug: string): Promise<NpmReleaseResponse> { void slug; return demoReadOnly(); }
  async listProjects(state: "active" | "archived" = "active"): Promise<ProjectSummary[]> {
    const projects = MOCK_PROJECTS.flatMap((project) => {
      const lifecycle = this.projectLifecycle.get(project.project_id) ?? {
        state: "active" as const,
        archivedAt: null,
        purgeAfter: null,
        purgedAt: null
      };
      if (lifecycle.state !== state) return [];
      return [{
        ...project,
        lifecycle_state: lifecycle.state,
        archived_at: lifecycle.archivedAt,
        purge_after: lifecycle.purgeAfter,
        purged_at: lifecycle.purgedAt
      }];
    });
    return delay(projects);
  }

  async createProject(input: { display_name: string }): Promise<ProjectSummary> {
    const project: ProjectSummary = {
      project_id: `prj_demo_${input.display_name.replaceAll(/\W+/g, "_").toLowerCase()}_${String(MOCK_PROJECTS.length).padStart(2, "0")}`,
      display_name: input.display_name,
      role: "owner",
      latest_project_version: null,
      latest_artifact_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_file_count: 0
    };
    MOCK_PROJECTS.push(project);
    return delay(clone(project));
  }

  async getProject(projectId: string): Promise<ProjectDetailModel> {
    const project = MOCK_PROJECTS.find((p) => p.project_id === projectId);    if (!project) throw new Error("Project not found");
    return delay({
      ...project,
      request_id: "mock-" + crypto.randomUUID(),
    });
  }

  async listProjectFiles(projectId: string): Promise<ProjectFilesSnapshot> {
    return delay({
      project_id: projectId,
      project_version: "v2.4.1",
      total: MOCK_PROJECT_FILES.length,
      items: clone(MOCK_PROJECT_FILES)
    });
  }

  async getProjectFileContent(projectId: string, path: string): Promise<ProjectFileContent> {
    const file = MOCK_PROJECT_FILES.find((item) => item.path === path);
    if (file === undefined) throw new ApiClientError(404, "PROJECT_FILE_NOT_FOUND", "Demo file not found.");
    return delay({
      ...file,
      project_id: projectId,
      content: `# ${path}\n\nDemo content for local UI review.\n`
    });
  }

  async archiveProject(projectId: string): Promise<ProjectLifecycleResult> {
    const archivedAt = new Date().toISOString();
    const purgeAfter = new Date(Date.now() + 30 * 86400000).toISOString();
    this.projectLifecycle.set(projectId, { state: "archived", archivedAt, purgeAfter, purgedAt: null });
    return delay({ project_id: projectId, display_name: projectId, lifecycle_state: "archived", archived_at: archivedAt, purge_after: purgeAfter, purged_at: null });
  }

  async restoreProject(projectId: string): Promise<ProjectLifecycleResult> {
    this.projectLifecycle.set(projectId, { state: "active", archivedAt: null, purgeAfter: null, purgedAt: null });
    return delay({ project_id: projectId, display_name: projectId, lifecycle_state: "active", archived_at: null, purge_after: null, purged_at: null });
  }

  async purgeProject(projectId: string): Promise<ProjectLifecycleResult> {
    const purgedAt = new Date().toISOString();
    this.projectLifecycle.set(projectId, { state: "purged", archivedAt: null, purgeAfter: null, purgedAt });
    return delay({ project_id: projectId, display_name: projectId, lifecycle_state: "purged", archived_at: null, purge_after: null, purged_at: purgedAt });
  }

  async getProjectSemanticOverview(projectId: string): Promise<SemanticOverview> {
    const knowledge = mockProjectKnowledge(projectId).length;
    return delay({
      project_id: projectId,
      artifact_id: "art_demo",
      counts: { documents: knowledge + 5, knowledge, rules: 2, changes: 3, architecture: 1, agent_instructions: 1, edges: 9 }
    });
  }

  async listProjectSemanticKnowledge(
    projectId: string,
    _options?: { limit?: number; cursor?: string | null; includeBody?: boolean }
  ): Promise<{ items: SemanticDocument[]; total: number; next_cursor: string | null }> {
    void _options;
    const items = mockProjectKnowledge(projectId);
    return delay({ items, total: items.length, next_cursor: null });
  }

  async syncWorkflowFamily(_slug: string): Promise<{ updated: boolean; version?: string }> {
    void _slug;
    return delay({ updated: false });
  }

  async listProjectSemanticRules(projectId: string): Promise<SemanticDocument[]> {
    return delay([
      mockSemanticDoc(projectId, "rule", "harness-general.md", "general rule body", ".claude/rules/harness-general.md", { status: "active" }),
      mockSemanticDoc(projectId, "rule", "windows-shell.md", "Prefer PowerShell for Chinese paths.", ".claude/rules/windows-shell.md", { status: "active" })
    ]);
  }

  async listProjectSemanticArchitecture(projectId: string): Promise<SemanticDocument[]> {
    return delay([
      mockSemanticDoc(
        projectId,
        "architecture_document",
        "项目架构总览",
        "# 项目架构总览\n\n项目采用分层模块结构，核心模块通过稳定接口协作。",
        ".harness/codebase/map-summary.md",
        { map_role: "summary" }
      ),
      mockSemanticDoc(
        projectId,
        "architecture_document",
        "项目架构地图元数据",
        "# 项目架构地图元数据\n\n- 生成时间：2026-08-12T08:00:00.000Z\n- 对应提交：abc1234",
        ".harness/codebase/map-manifest.json",
        {
          map_role: "manifest",
          generated_at: "2026-08-12T08:00:00.000Z",
          last_mapped_commit: "abc1234",
          warnings: []
        }
      )
    ]);
  }

  async listProjectSemanticChanges(
    projectId: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<{ items: SemanticDocument[]; total: number; next_cursor: string | null }> {
    const all = [
      mockSemanticDoc(
        projectId,
        "archive_record",
        "fix-gate-policy",
        JSON.stringify({
          schemaVersion: "2.3",
          changeName: "fix-gate-policy",
          businessGoal: "校准门禁策略阈值，避免误拦截合法提案。",
          finalStatus: "OK",
          verification: {
            unitTests: { status: "OK" },
            apiTests: { status: "OK" },
            dbCompatibility: { status: "OK" }
          },
          reviewSummary: { status: "ADVISORY" },
          knownRisks: ["阈值调整后首周需人工抽查 10% 提案"],
          gitFacts: { filesChanged: 6, insertions: 142, deletions: 38 }
        }, null, 2),
        ".harness/archive/2026-07-16-fix-gate-policy/reports/final/summary-data.json",
        { status: "archived" }
      ),
      mockSemanticDoc(
        projectId,
        "archive_record",
        "archive-report-pipeline",
        JSON.stringify({
          schemaVersion: "2.3",
          changeName: "archive-report-pipeline",
          businessGoal: "归档报告生成管线化，减少手工整理。",
          finalStatus: "OK",
          verification: { unitTests: { status: "OK" }, smoke: { status: "OK" } },
          reviewSummary: { status: "PASS" },
          knownRisks: [],
          gitFacts: { filesChanged: 11, insertions: 486, deletions: 92 }
        }, null, 2),
        ".harness/archive/2026-08-01-archive-report-pipeline/reports/final/summary-data.json",
        { status: "archived" }
      ),
      mockSemanticDoc(
        projectId,
        "archive_record",
        "knowledge-closeout",
        JSON.stringify({
          schemaVersion: "2.3",
          changeName: "knowledge-closeout",
          businessGoal: "知识库周检与候选清理。",
          finalStatus: "CONDITIONAL_OK",
          verification: { unitTests: { status: "FAILED" } },
          reviewSummary: { status: "ADVISORY" },
          knownRisks: ["3 条候选知识置信度不足，被自动降级"],
          gitFacts: { filesChanged: 2, insertions: 24, deletions: 9 }
        }, null, 2),
        ".harness/archive/2026-07-17-knowledge-closeout/reports/final/summary-data.json",
        { status: "archived" }
      )
    ];
    const limit = options.limit ?? 50;
    const offset = options.cursor === undefined || options.cursor === null
      ? 0
      : Number.parseInt(options.cursor, 10);
    const items = all.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return delay({
      items,
      total: all.length,
      next_cursor: nextOffset < all.length ? String(nextOffset) : null
    });
  }

  async getProjectSemanticGraph(projectId: string, focusDocumentId?: string): Promise<ProjectSemanticGraph> {
    const knowledge = (await this.listProjectSemanticKnowledge(projectId)).items.slice(0, 12);
    const rules = await this.listProjectSemanticRules(projectId);
    const changes = (await this.listProjectSemanticChanges(projectId)).items.slice(0, 2);
    const nodes = [...knowledge, ...rules, ...changes];
    const indexed = mockProjectKnowledge(projectId).length + 2 + 3;
    const edge = (
      edgeId: string,
      fromIndex: number,
      toIndex: number,
      kind: SemanticEdge["kind"]
    ): SemanticEdge | null => {
      const from = nodes[fromIndex];
      const to = nodes[toIndex];
      if (from === undefined || to === undefined) return null;
      return {
        edge_id: edgeId,
        project_id: projectId,
        artifact_id: "art_demo",
        from_document_id: from.document_id,
        to_document_id: to.document_id,
        kind,
        metadata: {}
      };
    };
    const allEdges = [
      edge("sed_supersedes_1", 1, 0, "supersedes"),
      edge("sed_conflicts_1", 2, 3, "conflicts_with"),
      edge("sed_shared_1", 4, 5, "shared_scope"),
      edge("sed_shared_2", 0, 4, "shared_scope"),
      edge("sed_tags_1", 2, 6, "tag_cooccurrence"),
      edge("sed_ref_rule_1", 0, knowledge.length, "references_path"),
      edge("sed_ref_rule_2", 3, knowledge.length + 1, "references_path"),
      edge("sed_archive_1", 0, knowledge.length + rules.length, "related_archive"),
      edge("sed_supersedes_2", 7, 1, "supersedes")
    ].filter((item): item is SemanticEdge => item !== null);

    const focusId = focusDocumentId
      ?? nodes[0]?.document_id
      ?? null;
    const neighbourhood = focusId === null
      ? allEdges
      : allEdges.filter((item) =>
        item.from_document_id === focusId || item.to_document_id === focusId
      );
    const keepIds = new Set<string>();
    if (focusId !== null) keepIds.add(focusId);
    for (const item of neighbourhood) {
      keepIds.add(item.from_document_id);
      keepIds.add(item.to_document_id);
    }
    const focusedNodes = keepIds.size === 0
      ? nodes
      : nodes.filter((node) => keepIds.has(node.document_id));

    return delay({
      nodes: focusedNodes,
      edges: neighbourhood,
      focus_document_id: focusId,
      relation_status: neighbourhood.length === 0 ? "no_relations" as const : "ready" as const,
      indexed_documents: indexed
    });
  }

  async searchSemanticDocuments(query: string, projectId?: string): Promise<Array<{ document: SemanticDocument; project_id: string }>> {
    const fallback = MOCK_PROJECTS[0];
    const id = projectId ?? fallback?.project_id ?? "agent-harness";
    const page = await this.listProjectSemanticKnowledge(id, { includeBody: true });
    const needle = query.toLowerCase();
    return delay(page.items
      .filter((document) => document.title.toLowerCase().includes(needle) || document.body.toLowerCase().includes(needle))
      .map((document) => ({ document, project_id: id })));
  }

  async listProjectProposals(projectId: string): Promise<ProposalSummary[]> {
    return delay(
      MOCK_PROPOSALS.filter((p) => p.project_id === projectId)
    );
  }

  async listAllProposals(): Promise<ProposalSummary[]> {
    return delay(
      [...MOCK_PROPOSALS].sort(
        (a, b) => b.created_at.localeCompare(a.created_at)
      )
    );
  }

  async listProjectArtifacts(projectId: string): Promise<ArtifactSummary[]> {
    return delay(
      MOCK_ARTIFACTS
        .filter((a) => a.project_id === projectId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    );
  }

  async listAllArtifacts(): Promise<ArtifactSummary[]> {
    return delay(
      [...MOCK_ARTIFACTS].sort(
        (a, b) => b.created_at.localeCompare(a.created_at)
      )
    );
  }

  async getArtifactManifest(artifactId: string): Promise<ArtifactManifestModel> {
    const artifact = MOCK_ARTIFACTS.find((item) => item.artifact_id === artifactId);
    const files = MOCK_MANIFEST_FILES[artifactId] ?? MOCK_MANIFEST_FILES.art_a7f3c91b ?? [];
    return delay({
      schema_version: 1,
      project_id: artifact?.project_id ?? "agent-harness",
      project_version: artifact?.project_version ?? null,
      artifact_id: artifactId,
      manifest_sha256: artifact?.manifest_sha256 ?? "sha256:" + "0".repeat(64),
      files
    });
  }

  async getArtifactText(
    artifactId: string,
    contentHash: string
  ): Promise<string> {
    void artifactId;
    void contentHash;
    return delay("// Mock artifact content\nconsole.log('hello hunter-harness');");
  }

  async createProjectFileProposal(input: ProjectFileProposalInput): Promise<ProjectFileProposalResult> {
    void input;
    return delay({
      proposal_id: "prop_mock" + Date.now(),
      status: "approved",
      artifact_id: "art_mock" + Date.now(),
      received_files: 1,
    });
  }

  async getProposal(proposalId: string): Promise<ProposalDetailModel> {
    void proposalId;
    return delay({
      schema_version: 1,
      proposal_id: "prop_a1b2c3",
      project_id: "agent-harness",
      status: "pending_review",
      created_by: "alice",
      created_at: "2026-06-20T10:00:00Z",
      items: [
        {
          item_id: "item_001",
          operation: {
            operation: "modify",
            path: "src/agent.ts",
            file_kind: "user_editable",
            base_content_sha256: "sha256:old123",
            content_sha256: "sha256:new456",
            size_bytes: 4096,
          },
        },
        {
          item_id: "item_002",
          operation: {
            operation: "add",
            path: "src/tools/skill-loader.ts",
            file_kind: "user_editable",
            content_sha256: "sha256:abc789",
            size_bytes: 1536,
          },
        },
        {
          item_id: "item_003",
          operation: {
            operation: "rename",
            from_path: "src/old-utils.ts",
            to_path: "src/utils/helpers.ts",
            file_kind: "user_editable",
            base_content_sha256: "sha256:old999",
            content_sha256: "sha256:old999",
            size_bytes: 2048,
          },
        },
      ],
      scan_summary: { redacted: true },
      review_history: [
        {
          review_id: "rev_001",
          decision: "need_more_evidence",
          created_at: "2026-06-20T12:00:00Z",
        },
      ],
    });
  }

  async reviewProposal(
    proposalId: string,
    input: ReviewInput
  ): Promise<ReviewResult> {
    return delay({
      review_id: "rev_" + Date.now(),
      proposal_id: proposalId,
      decision: input.decision,
      artifact_id:
        input.decision === "approve" ? "art_mock" + Date.now() : null,
      child_proposal_ids:
        input.decision === "split"
          ? ["prop_child_1", "prop_child_2"]
          : [],
    });
  }

  async uploadSkillDraft(form: FormData, agent: RegistryAgent): Promise<DraftState> {
    void form; void agent;
    return demoReadOnly();
  }

  async getSkillDraft(slug: string, agent: RegistryAgent): Promise<DraftState> {
    const src = findDemoSourceSkill(slug);
    if (src === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo draft not found.");
    const agentCfg = src.agents.find((a) => a.agent === agent) ?? src.agents.find((a) => a.agent === src.defaultAgent) ?? src.agents[0];
    if (agentCfg === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo agent not found.");
    return delay({
      slug: src.slug,
      agent,
      sourceFiles: src.source.files.map((f) => ({ path: f.path, content: f.content })),
      examples: src.examples.map((e) => ({ title: e.title, description: e.description, request: e.request, result: e.result, files: e.files ? [...e.files] : [] })),
      draftVersion: agentCfg.draftVersion?.version ?? null,
      checks: demoChecksToResult(agentCfg.checks),
      aiChecks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T15:20:00Z"
    });
  }

  async discardSkillDraft(slug: string, agent: RegistryAgent, revision: number): Promise<{ slug: string; discarded: boolean }> {
    void slug; void agent; void revision;
    return demoReadOnly();
  }

  async runSkillDraftChecks(slug: string, agent: RegistryAgent): Promise<SkillCheckResult> {
    const src = findDemoSourceSkill(slug);
    if (src === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo draft not found.");
    const agentCfg = src.agents.find((a) => a.agent === agent) ?? src.agents.find((a) => a.agent === src.defaultAgent) ?? src.agents[0];
    if (agentCfg === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo agent not found.");
    return delay(demoChecksToResult(agentCfg.checks));
  }

  async publishSkillDraft(slug: string, agent: RegistryAgent, req: PublishSkillRequest): Promise<RegistrySkillVersion> {
    void slug; void agent; void req;
    return demoReadOnly();
  }

  async diffSkillDraft(slug: string, agent: RegistryAgent): Promise<SkillDiffFile[]> {
    const src = findDemoSourceSkill(slug);
    if (src === undefined) throw new ApiClientError(404, "DRAFT_NOT_FOUND", "Demo draft not found.");
    const agentCfg = src.agents.find((a) => a.agent === agent) ?? src.agents.find((a) => a.agent === src.defaultAgent) ?? src.agents[0];
    return delay(demoDiffToFiles(agentCfg?.diffFiles));
  }

  async setDefaultAgent(slug: string, agent: RegistryAgent, revision: number): Promise<RegistrySkillDetail> {
    const skill = MOCK_SKILLS.find((item) => item.slug === slug);
    if (skill === undefined) throw new ApiClientError(404, "SKILL_NOT_FOUND", "Demo Skill not found.");
    if (revision !== skill.revision) throw new ApiClientError(409, "REVISION_CONFLICT", "Demo skill revision mismatch.");
    const cfg = skill.agents.find((a) => a.agent === agent);
    if (cfg === undefined || !cfg.enabled) throw new ApiClientError(422, "VALIDATION_FAILED", "Agent is not enabled for this skill.");
    skill.defaultAgent = agent;
    for (const a of skill.agents) a.isDefault = a.agent === agent;
    skill.updated_at = new Date().toISOString();
    return delay(clone(skill));
  }

  async deleteSkill(): Promise<{ slug: string; deleted: boolean }> { return demoReadOnly(); }

  async listAiProviders(): Promise<{ items: AiProviderWithKeySet[]; default_provider: string | null }> {
    return delay({ items: clone(MOCK_AI_PROVIDERS).map((p) => ({ ...p, key_set: p.provider_id === "deepseek" })), default_provider: "deepseek" });
  }
  async getCodexConnection(): Promise<CodexConnectionState> {
    return delay({
      status: "connected", auth_mode: "chatgpt", email: "demo@example.com", plan_type: "plus",
      enabled: false,
      selected_model: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", is_default: true, reasoning_efforts: ["medium", "high"] },
        { id: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", is_default: false, reasoning_efforts: ["medium", "high"] }
      ],
      error: null
    });
  }
  async startCodexLogin(): Promise<CodexLoginStart> { return demoReadOnly(); }
  async cancelCodexLogin(): Promise<{ cancelled: boolean }> { return demoReadOnly(); }
  async updateCodexConnection(): Promise<CodexConnectionState> { return demoReadOnly(); }
  async disconnectCodex(): Promise<{ disconnected: boolean }> { return demoReadOnly(); }
  async testCodexConnection(): Promise<{ ok: boolean; model: string | null }> {
    return delay({ ok: true, model: "gpt-5.6-sol" });
  }
  async createAiProvider(): Promise<AiProviderConfig> { return demoReadOnly(); }
  async updateAiProvider(): Promise<AiProviderConfig> { return demoReadOnly(); }
  async deleteAiProvider(): Promise<{ provider_id: string; deleted: boolean }> { return demoReadOnly(); }
  async testAiProvider(providerId: string): Promise<{ provider_id: string; ok: boolean; model?: string; error?: string }> {
    return delay({ provider_id: providerId, ok: true, model: "deepseek-v4-pro" });
  }
  async setAiProviderKey(providerId: string): Promise<{ provider_id: string; key_set: boolean }> {
    return delay({ provider_id: providerId, key_set: true });
  }
  async getAiUsage(): Promise<AiQuotaUsage[]> {
    const today = new Date().toISOString().slice(0, 10);
    return delay([
      { provider_id: "deepseek", date: today, model: "deepseek-chat", requests: 128, tokens: 1842000, input_tokens: 1200000, output_tokens: 642000, cache_hit_tokens: 50000, cache_create_tokens: 0, cost: 1.01 },
      { provider_id: "deepseek", date: today, model: "deepseek-reasoner", requests: 12, tokens: 400000, input_tokens: 180000, output_tokens: 220000, cache_hit_tokens: 0, cache_create_tokens: 0, cost: 0.58 }
    ]);
  }
  async reorderAiProviders(): Promise<{ provider_ids: string[] }> { return demoReadOnly(); }
  async runSkillAiChecks(slug: string, agent: RegistryAgent): Promise<{ jobId: string; status: string }> {
    void slug; void agent;
    return delay({ jobId: "demo-ai-job", status: "pending" });
  }
  async getAiJob(jobId: string): Promise<AiJobState> {
    void jobId;
    const now = new Date();
    return delay({
      jobId,
      status: "completed",
      result: {
        items: [{ id: "AI_TRIGGER_QUALITY", label: "AI 触发质量", status: "green", message: "AI 检查通过（demo）", filePath: null, fixable: false }],
        summary: { green: 1, yellow: 0, red: 0 },
        checkedAt: now.toISOString()
      },
      error: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    });
  }
  async previewSkillFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    void slug; void agent; void checkIds;
    return delay({ items: [], mergedFiles: [], summary: { autoCount: 0, confirmCount: 0, suggestCount: 0, changedFiles: 0, changedLines: 0 } });
  }
  async applySkillFix(slug: string, agent: RegistryAgent): Promise<DraftState> {
    return this.getSkillDraft(slug, agent);
  }
  async generateReleaseNote(slug: string, agent: RegistryAgent): Promise<{ releaseNote: string | null; generatedAt: string; degraded?: boolean; reason?: string }> {
    void slug; void agent;
    return delay({ releaseNote: "AI 生成的发布说明（demo）", generatedAt: "2026-06-29T00:00:00.000Z" });
  }
  async fetchFixSuggestions(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    void slug; void agent; void checkIds;
    return delay({ items: [], mergedFiles: [], summary: { autoCount: 0, confirmCount: 0, suggestCount: 0, changedFiles: 0, changedLines: 0 } });
  }
  async applyFixSuggestion(slug: string, agent: RegistryAgent): Promise<DraftState> {
    return this.getSkillDraft(slug, agent);
  }

  // ── Knowledge ingest（候选审核 demo）────────────────────
  async listKnowledgeEntries(
    projectId: string,
    options?: { status?: string; limit?: number }
  ): Promise<KnowledgeIngestListItem[]> {
    void projectId;
    const seed: KnowledgeIngestListItem[] = [
      {
        entry_id: "kn_cand_001",
        status: "candidate",
        content_sha256: "sha256:" + "a".repeat(64),
        payload: {
          title: "决策：事件上报改用 NDJSON 追加写",
          summary: "为降低锁竞争，events 上报从整文件重写改为 NDJSON 追加写，读端按 cursor 增量消费。"
        },
        updated_at: "2026-07-30T09:12:00Z",
        projected_at: null
      },
      {
        entry_id: "kn_cand_002",
        status: "candidate",
        content_sha256: "sha256:" + "b".repeat(64),
        payload: {
          title: "风险：技能发布缺少签名校验",
          summary: "当前发布流程未校验 artifact 签名，存在被篡改风险，建议引入 cosign 或内置校验。"
        },
        updated_at: "2026-07-29T15:40:00Z",
        projected_at: null
      },
      {
        entry_id: "kn_cand_003",
        status: "candidate",
        content_sha256: "sha256:" + "c".repeat(64),
        payload: {
          title: "实现笔记：工作流草稿三态机",
          summary: "工作流草稿采用 draft/staged/published 三态，staged 用于发布前 diff 预览。"
        },
        updated_at: "2026-07-28T11:05:00Z",
        projected_at: null
      }
    ];
    const filtered = options?.status === undefined ? seed : seed.filter((item) => item.status === options.status);
    const limited = options?.limit === undefined ? filtered : filtered.slice(0, options.limit);
    return delay(clone(limited));
  }

  async getKnowledgeProjectionStatus(projectId: string): Promise<{ pending_count: number; pending_capped: boolean }> {
    void projectId;
    return delay({ pending_count: 3, pending_capped: false });
  }

  async updateKnowledgeEntryStatus(
    projectId: string,
    entryId: string,
    status: string
  ): Promise<{ entry_id: string; status: string; updated_at: string }> {
    void projectId;
    return delay({ entry_id: entryId, status, updated_at: new Date().toISOString() });
  }
}

export const mockApi = new MockApiClient();
