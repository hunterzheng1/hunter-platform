// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateExternalSkillRequest, ExternalSkill } from "@hunter-harness/contracts";

import { SkillDetail, SkillRegistry } from "../components/registry";
import { ToastProvider } from "../components/ui/Toast";
import type { HunterApi } from "../lib/api";

const SKILL_DESCRIPTION = "Evidence based review";
const skillMd = `---
name: harness-review
description: ${SKILL_DESCRIPTION}
kind: governance
triggers: ["review"]
inputs: ["change_ref"]
outputs: ["review_report"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
version: "1.1.0"
---

Review workflow body.`;

const skill = {
  skill_id: "skl_review",
  slug: "harness-review",
  name: "harness-review",
  description: SKILL_DESCRIPTION,
  kind: "governance" as const,
  tags: ["security"],
  status: "published" as const,
  latest_version: "1.1.0",
  defaultAgent: "claude-code" as const,
  agents: [{ agent: "claude-code" as const, enabled: true, isDefault: true, installTarget: ".claude/skills/harness-review", latestVersion: "1.1.0", draftVersion: null, sourcePackagePath: null }],
  revision: 2,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z",
  sourceFiles: [{ path: "SKILL.md", content: skillMd }],
  examples: [],
  npmReleases: []
};

const securityTag = {
  tag_id: "tag_security",
  slug: "security",
  label: "Security",
  active: true,
  revision: 1,
  usageCount: 0,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z"
};

const externalSkill: ExternalSkill = {
  id: "ext_codegraph",
  source: { type: "github", ref: "colbymchenry/codegraph" },
  snapshot: {
    name: "colbymchenry/codegraph",
    description: "Pre-indexed code knowledge graph, auto syncs on code changes, for Claude Code, Codex, Gemini, Cursor, OpenCode, AntiGravity, Kiro, and Hermes Agent — fewer tokens, fewer tool calls, 100% local",
    version: "v1.5.0",
    readme: "<div align=\"center\">\n\n# CodeGraph\n\n## Fast code intelligence\n\nReadable project knowledge.",
    installCommand: "https://github.com/colbymchenry/codegraph",
    license: "MIT",
    homepage: "https://github.com/colbymchenry/codegraph",
    releaseUrl: "https://github.com/colbymchenry/codegraph/releases/tag/v1.5.0",
    fetchedAt: "2026-08-10T08:00:00Z"
  },
  curationNote: "适合大型代码库分析",
  tags: ["code-intelligence"],
  updateAvailable: false,
  lastCheckedAt: "2026-08-10T08:00:00Z",
  revision: 1,
  created_at: "2026-08-10T08:00:00Z",
  updated_at: "2026-08-10T08:00:00Z"
};

const workflowFamily = {
  family_id: "wff_review",
  slug: "review",
  displayName: "Review",
  description: "Review workflow family",
  tags: ["review"],
  latest_version: "1.0.0",
  required_profiles: ["general"],
  revision: 1,
  npmReleases: [],
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z"
};

const draft = {
  slug: skill.slug,
  agent: "claude-code" as const,
  sourceFiles: [],
  examples: [],
  draftVersion: "0.1.0",
  checks: null,
  aiChecks: null,
  releaseNote: null,
  revision: 1,
  created_at: "2026-06-21T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z"
};

const draftChecks = {
  items: [
    { id: "c1", label: "Entry check", status: "green" as const, message: "ok", filePath: null, fixable: false },
    { id: "c2", label: "Secret scan", status: "yellow" as const, message: "warn", filePath: "reference.md", fixable: true }
  ],
  summary: { green: 1, yellow: 1, red: 0 },
  checkedAt: "2026-06-21T00:00:00Z"
};

const draftAiChecks = {
  items: [
    { id: "AI_TRIGGER_QUALITY", label: "AI 触发质量", status: "green" as const, message: "AI ok", filePath: null, fixable: false }
  ],
  summary: { green: 1, yellow: 0, red: 0 },
  checkedAt: "2026-06-21T00:00:00Z"
};

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    listSkills: vi.fn(async () => [skill]),
    getSkill: vi.fn(async () => skill),
    listSkillVersions: vi.fn(async () => [{
      skill_slug: skill.slug,
      version: "1.1.0",
      agent: "claude-code" as const,
      artifacts: [],
      source_proposal_id: "skp_review",
      sourceFiles: [],
      examples: [],
      changeNote: null,
      created_at: "2026-06-21T00:00:00Z"
    }]),
    listSkillProposals: vi.fn(async () => []),
    getSkillAdapterPreview: vi.fn(async () => ({
      path: ".claude/skills/harness-review/SKILL.md",
      content: "# harness-review\n",
      sourceIrHash: "sha256:" + "a".repeat(64),
      compilerVersion: "1.0.0",
      adapter: "claude-code"
    })),
    listTags: vi.fn(async () => [securityTag]),
    listWorkflowFamilies: vi.fn(async () => [workflowFamily]),
    getSkillDraft: vi.fn(async () => draft),
    runSkillDraftChecks: vi.fn(async () => draftChecks),
    diffSkillDraft: vi.fn(async () => []),
    publishSkillDraft: vi.fn(async () => ({
      skill_slug: skill.slug,
      version: "1.2.0",
      agent: "claude-code" as const,
      artifacts: [],
      source_proposal_id: "skp_new",
      sourceFiles: [],
      examples: [],
      changeNote: "published",
      created_at: "2026-06-22T00:00:00Z"
    })),
    publishSkill: vi.fn(async () => ({
      release: { slug: skill.slug, version: "0.1.0" },
      npmRelease: {
        status: "published" as const,
        packageName: "@hunter-harness/harness-review",
        version: "0.1.0",
        tarballHash: "sha256:" + "b".repeat(64)
      }
    })),
    discardSkillDraft: vi.fn(async () => ({ slug: skill.slug, discarded: true })),
    ...overrides
  } as unknown as HunterApi;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("governed workflow and Skill Center", () => {
  it("loads the canonical registry, exposes governance metadata, and applies compound filters", async () => {
    const { container } = render(<SkillRegistry api={api()} />);
    expect(await screen.findByText("harness-review")).toBeInTheDocument();
    expect(screen.getByText(/技能列表|Skill list/i)).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skill-registry-workbench"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skill-metric-strip"]')).toBeInTheDocument();
    expect(container.querySelector(".hub-rail")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /上传技能|Upload skill/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /引入外部技能|Import external skill/i })).toBeInTheDocument();
    expect(screen.queryByText(/^工作流$|^workflows$/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText("harness-review")).toBeInTheDocument();
    const statusFilter = screen.getAllByLabelText(/状态|Status/i).at(0);
    expect(statusFilter).toBeDefined();
    fireEvent.change(statusFilter as HTMLElement, { target: { value: "unpublished" } });
    expect(screen.queryByText("harness-review")).not.toBeInTheDocument();
  });

  it("presents external skill import as a clear two-source form", async () => {
    render(<SkillRegistry api={api()} />);
    await screen.findByText("harness-review");

    fireEvent.click(screen.getByRole("button", { name: /引入外部技能|Import external skill/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector('[data-slot="external-skill-import"]')).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="external-source-guides"]')).toBeInTheDocument();
    expect(within(dialog).getByText(/^(npm 包|npm package)$/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/^(GitHub 仓库|GitHub repository)$/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/来源标识|Source identifier/i)).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/package|github/i)
    );
    expect(within(dialog).getByLabelText(/策展笔记（可选）|Curator note \(optional\)/i)).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="external-skill-import-trust"]')).toHaveTextContent(
      /不托管代码|does not host code/i
    );
  });

  it("keeps a scoped npm package on the explicitly selected npm source", async () => {
    const createExternalSkill = vi.fn(async (input: CreateExternalSkillRequest) => ({
      ...externalSkill,
      id: "ext_lark_bridge",
      source: input.source,
      snapshot: {
        ...externalSkill.snapshot,
        name: input.source.ref,
        version: "0.3.15"
      }
    }));
    render(<SkillRegistry api={api({ createExternalSkill })} />);
    await screen.findByText("harness-review");

    fireEvent.click(screen.getByRole("button", { name: /引入外部技能|Import external skill/i }));
    const dialog = await screen.findByRole("dialog");
    const npmSource = within(dialog).getByRole("radio", { name: /npm 包|npm package/i });
    expect(npmSource).toBeChecked();

    fireEvent.change(within(dialog).getByLabelText(/来源标识|Source identifier/i), {
      target: { value: "@hunterzheng/lark-channel-bridge" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /抓取并录入|Fetch and register/i }));

    await waitFor(() => expect(createExternalSkill).toHaveBeenCalledWith({
      source: { type: "npm", ref: "@hunterzheng/lark-channel-bridge" },
      curationNote: "",
      tags: []
    }));
  });

  it("uses the selected GitHub source for an owner/repository reference", async () => {
    const createExternalSkill = vi.fn(async (input: CreateExternalSkillRequest) => ({
      ...externalSkill,
      source: input.source
    }));
    render(<SkillRegistry api={api({ createExternalSkill })} />);
    await screen.findByText("harness-review");

    fireEvent.click(screen.getByRole("button", { name: /引入外部技能|Import external skill/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /GitHub 仓库|GitHub repository/i }));
    fireEvent.change(within(dialog).getByLabelText(/来源标识|Source identifier/i), {
      target: { value: "hunterzheng/lark-channel-bridge" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /抓取并录入|Fetch and register/i }));

    await waitFor(() => expect(createExternalSkill).toHaveBeenCalledWith({
      source: { type: "github", ref: "hunterzheng/lark-channel-bridge" },
      curationNote: "",
      tags: []
    }));
  });

  it("shows a readable external skill name, repository reference, and aligned metadata", async () => {
    const summarizedExternalSkill: ExternalSkill = {
      ...externalSkill,
      aiSummary: {
        overview: "CodeGraph 是一个本地运行的代码知识图谱，可为编码智能体提供调用关系和源码上下文。",
        use_cases: ["理解大型代码库"],
        capabilities: ["查询调用关系"],
        getting_started: [],
        caveats: [],
        source_sha256: "sha256:" + "a".repeat(64),
        provider_id: "codex-account",
        model: "gpt-5.6-sol",
        generated_at: "2026-08-10T13:01:00Z"
      }
    };
    const { container } = render(<SkillRegistry api={api({
      listExternalSkills: vi.fn(async () => [summarizedExternalSkill])
    })} />);

    expect(await screen.findByText("CodeGraph")).toBeInTheDocument();
    const row = container.querySelector('[data-slot="external-skill-row"]');
    expect(row).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("colbymchenry/codegraph")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/本地运行的代码知识图谱/)).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/Pre-indexed code knowledge graph/)).not.toBeInTheDocument();
    expect(row?.querySelector('[data-slot="skill-card"]')).toHaveClass("external-skill-card");
    expect(row?.querySelector('[data-slot="external-skill-metadata"]')).toHaveTextContent(/v1\.5\.0/);
    expect(row?.querySelector('[data-slot="external-skill-metadata"]')).toHaveTextContent(/GitHub/i);
  });

  it("uses a dense card grid and keeps twelve skills on one page", async () => {
    const manySkills = Array.from({ length: 10 }, (_, index) => ({
      ...skill,
      skill_id: `skl_${index + 1}`,
      slug: `skill-${index + 1}`,
      name: `Skill ${index + 1}`,
      description: `第 ${index + 1} 个技能的简短说明`
    }));
    const { container } = render(<SkillRegistry api={api({
      listSkills: vi.fn(async () => manySkills),
      listExternalSkills: vi.fn(async () => [])
    })} />);

    expect(await screen.findByText("Skill 9")).toBeInTheDocument();
    const grid = container.querySelector('[data-slot="skill-card-grid"]');
    expect(grid).toHaveClass("skill-catalog-grid");
    expect(grid?.querySelectorAll('[data-slot="skill-card"]')).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /下一页|next page/i })).not.toBeInTheDocument();
  });

  it("shows readable tag labels and persists card order after drag", async () => {
    const codeTag = {
      ...securityTag,
      tag_id: "tag_code_intelligence",
      slug: "code-intelligence",
      label: "代码理解"
    };
    const getSkillCatalogOrder = vi.fn(async () => ({
      items: ["registry:harness-review", "external:ext_codegraph"],
      revision: 3,
      updated_at: "2026-08-10T14:00:00Z"
    }));
    const updateSkillCatalogOrder = vi.fn(async (input: { items: string[]; revision: number }) => ({
      items: input.items,
      revision: input.revision + 1,
      updated_at: "2026-08-10T14:01:00Z"
    }));
    const client = api({
      listSkills: vi.fn(async () => [skill]),
      listExternalSkills: vi.fn(async () => [externalSkill]),
      listTags: vi.fn(async () => [securityTag, codeTag])
    });
    Object.assign(client, { getSkillCatalogOrder, updateSkillCatalogOrder });

    const { container } = render(<SkillRegistry api={client} />);
    expect(await screen.findByText("CodeGraph")).toBeInTheDocument();

    const cards = [...container.querySelectorAll<HTMLElement>('[data-catalog-card="true"]')];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("harness-review");
    const externalCard = container.querySelector<HTMLElement>('[data-card-kind="external"]');
    expect(externalCard).toHaveTextContent("代码理解");
    expect(within(externalCard as HTMLElement).queryByText("code-intelligence")).not.toBeInTheDocument();

    const handles = screen.getAllByRole("button", { name: /拖动.*顺序|drag.*order/i });
    fireEvent.dragStart(handles[0] as HTMLElement);
    fireEvent.dragOver(cards[1] as HTMLElement);
    fireEvent.drop(cards[1] as HTMLElement);

    await waitFor(() => expect(updateSkillCatalogOrder).toHaveBeenCalledWith({
      items: ["external:ext_codegraph", "registry:harness-review"],
      revision: 3
    }));
  });

  it("renders source files, version history, and an agent-specific install command", async () => {
    const client = api();
    client.getSkill = vi.fn(function (this: HunterApi) {
      if (this !== client) throw new Error("API method lost its client binding");
      return Promise.resolve(skill);
    });
    render(<SkillDetail api={client} skillId="harness-review" />);
    expect(await screen.findByRole("heading", { name: "harness-review" })).toBeInTheDocument();
    expect(screen.getAllByText(/1\.1\.0/).length).toBeGreaterThan(0);
    expect(screen.getByText("npx @hunter-harness/skills install harness-review --agent claude-code")).toBeInTheDocument();
    // source tab 展示 SKILL.md body（frontmatter 剥离后的内容），取代旧 canonical IR JSON 展示
    fireEvent.click(screen.getByRole("tab", { name: /文件内容|files/i }));
    expect(await screen.findByText(/Review workflow body/)).toBeInTheDocument();
  });

  it("consolidates installation into the title card and removes the redundant overview", async () => {
    const listTags = vi.fn(async () => [securityTag]);
    const { container } = render(<SkillDetail api={api({ listTags })} skillId="harness-review" />);

    expect(await screen.findByRole("heading", { name: "harness-review" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /概览|overview/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /文件内容|files/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /检查与发布|checks & publish/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /版本记录|version history/i })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="local-skill-overview"]')).not.toBeInTheDocument();
    const install = container.querySelector('[data-slot="skill-hero-install"]');
    expect(install).toBeInTheDocument();
    expect(install?.closest("header")).toBe(container.querySelector("header.skill-detail-hero"));
    expect(within(install as HTMLElement).getByText("npx @hunter-harness/skills install harness-review --agent claude-code")).toBeInTheDocument();
    expect(screen.queryByText(/个可用 Agent|available agents/i)).not.toBeInTheDocument();
    expect(listTags).not.toHaveBeenCalled();
  });

  it("shows the copy notification every time the same action is repeated", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<ToastProvider><SkillDetail api={api()} skillId="harness-review" /></ToastProvider>);
    await screen.findByRole("heading", { name: "harness-review" });

    const copyButton = screen.getByRole("button", { name: /复制命令|copy command/i });
    fireEvent.click(copyButton);
    expect(await screen.findByRole("status")).toHaveTextContent(/安装命令已复制|install command copied/i);
    fireEvent.click(screen.getByRole("button", { name: /关闭通知|dismiss notification/i }));

    fireEvent.click(copyButton);
    expect(await screen.findByRole("status")).toHaveTextContent(/安装命令已复制|install command copied/i);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("renders registry tags as read-only metadata instead of a non-persistent editor", async () => {
    const bindSkillTag = vi.fn(async () => ({ ...skill, tags: [] }));
    render(<SkillDetail api={api({ bindSkillTag })} skillId="harness-review" />);
    expect(await screen.findByText("security")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /security/ })).not.toBeInTheDocument();
    expect(bindSkillTag).not.toHaveBeenCalled();
  });

  it("uploads a skill draft via the API as FormData and refreshes the list", async () => {
    const uploadSkillDraft = vi.fn(async () => ({
      slug: "harness-review",
      agent: "claude-code" as const,
      sourceFiles: [],
      examples: [],
      draftVersion: "0.1.0",
      checks: null,
      aiChecks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-21T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }));
    const listSkills = vi.fn(async () => [skill]);
    render(<SkillRegistry api={api({ uploadSkillDraft, listSkills })} />);
    await screen.findByText("harness-review");
    expect(screen.queryByLabelText(/选择文件|choose file/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /上传技能|Upload skill/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const input = screen.getByLabelText(/选择文件|choose file/i);
    fireEvent.change(input, { target: { files: [new File([skillMd], "SKILL.md")] } });
    const uploadButton = await screen.findByRole("button", { name: /添加为未发布|add as unpublished/i });
    await waitFor(() => expect(uploadButton).not.toBeDisabled());
    fireEvent.click(uploadButton);
    await waitFor(() => expect(uploadSkillDraft).toHaveBeenCalledTimes(1));
    const fd = (uploadSkillDraft.mock.calls as unknown as [FormData][])[0]?.[0];
    expect(fd).toBeInstanceOf(FormData);
    expect(fd?.getAll("file")).toHaveLength(1);
    expect(listSkills).toHaveBeenCalledTimes(2);
  });

  it("deletes a skill via the API and refreshes the list", async () => {
    const deleteSkill = vi.fn(async () => ({ slug: "harness-review", deleted: true }));
    const listSkills = vi.fn(async () => [skill]);
    render(<SkillRegistry api={api({ deleteSkill, listSkills })} />);
    await screen.findByText("harness-review");
    fireEvent.click(screen.getByRole("button", { name: /^删除$|^delete$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^删除$|^delete$/i }));
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("harness-review"));
    expect(listSkills).toHaveBeenCalledTimes(2);
  });

  it("runs draft checks via the API and renders the result in the checks tab", async () => {
    const runSkillDraftChecks = vi.fn(async () => draftChecks);
    render(<SkillDetail api={api({ runSkillDraftChecks, getSkillDraft: vi.fn(async () => ({ ...draft, checks: null })) })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^基础检查$|^Baseline checks$/i }));
    await waitFor(() => expect(runSkillDraftChecks).toHaveBeenCalledWith("harness-review", "claude-code"));
    fireEvent.click(document.querySelector('[data-slot="required-check-green"]') as HTMLElement);
    expect(await within(await screen.findByRole("dialog")).findByText("Entry check")).toBeInTheDocument();
  });

  it("loads version differences by default and keeps each check category in its own dialog", async () => {
    const diffSkillDraft = vi.fn(async () => ([{
      path: "SKILL.md",
      status: "modified" as const,
      publishedContent: "# old",
      draftContent: "# new"
    }]));
    const { container } = render(<SkillDetail api={api({
      diffSkillDraft,
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: draftChecks, aiChecks: draftAiChecks }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));

    await waitFor(() => expect(diffSkillDraft).toHaveBeenCalledWith("harness-review", "claude-code"));
    const diff = await waitFor(() => {
      const value = container.querySelector('[data-slot="default-version-diff"]');
      expect(value).toBeInTheDocument();
      return value as HTMLElement;
    });
    expect(within(diff).getByText("SKILL.md")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^版本差异$|^Version Diff$/i })).not.toBeInTheDocument();
    expect(container.querySelector(".check-list-bounded")).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('[data-slot="required-check-green"]') as HTMLElement);
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Entry check")).toBeInTheDocument();
    expect(within(dialog).queryByText("Secret scan")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("AI 触发质量")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /关闭|close/i }));

    fireEvent.click(container.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("AI 触发质量")).toBeInTheDocument();
    expect(within(dialog).queryByText("Entry check")).not.toBeInTheDocument();
  });

  it("keeps the publish toolbar content-sized and the changed-file tree independently scrollable", async () => {
    const files = Array.from({ length: 18 }, (_, index) => ({
      path: `references/section-${String(index + 1).padStart(2, "0")}.md`,
      status: "modified" as const,
      publishedContent: `# old ${index + 1}`,
      draftContent: `# new ${index + 1}`
    }));
    const { container } = render(<SkillDetail api={api({
      diffSkillDraft: vi.fn(async () => files),
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: draftChecks, aiChecks: draftAiChecks }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));

    const tree = await waitFor(() => {
      const value = container.querySelector('[data-slot="version-file-tree-scroll"]');
      expect(value).toBeInTheDocument();
      return value as HTMLElement;
    });
    expect(within(tree).getByRole("button", { name: /section-18\.md/i })).toBeInTheDocument();

    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    const toolbarRule = css.match(/\.check-workbench-toolbar\s*\{[^}]+\}/s)?.[0] ?? "";
    const compactUploadRule = css.match(/\.skill-upload-panel-compact\s*\{[^}]+\}/s)?.[0] ?? "";
    const workbenchRule = css.match(/\.default-version-diff \.version-diff-workbench\s*\{[^}]+\}/s)?.[0] ?? "";
    const fileTreeRule = css.match(/\.default-version-diff \.version-file-tree\s*\{[^}]+\}/s)?.[0] ?? "";
    const diffCodeRule = css.match(/\.version-diff-pane pre\s*\{[^}]+\}/s)?.[0] ?? "";
    const diffLineRule = css.match(/\.diff-line\s*\{[^}]+\}/s)?.[0] ?? "";
    expect(toolbarRule).toMatch(/align-items:\s*start/);
    expect(compactUploadRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(workbenchRule).toMatch(/height:\s*clamp\(/);
    expect(fileTreeRule).toMatch(/min-height:\s*0/);
    expect(fileTreeRule).toMatch(/overflow-y:\s*auto/);
    expect(diffCodeRule).toMatch(/display:\s*block/);
    expect(diffLineRule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(diffLineRule).toMatch(/word-break:\s*break-word/);
  });

  it("discloses the stable AI analysis rules without exposing the current skill payload", async () => {
    render(<SkillDetail api={api()} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(await screen.findByRole("button", { name: /查看 AI 分析规则|View AI analysis rules/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/触发条件质量/);
    expect(dialog).toHaveTextContent(/正文质量/);
    expect(dialog).toHaveTextContent(/使用示例/);
    expect(dialog).toHaveTextContent(/安全边界/);
    expect(dialog).toHaveTextContent(/简体中文/);
    expect(dialog).toHaveTextContent(/技能内容.*待检查数据/);
    expect(dialog).not.toHaveTextContent("Review workflow body");
  });

  it("runs AI checks via the API and keeps them separate from baseline checks (INT-002)", async () => {
    const runSkillDraftChecks = vi.fn(async () => draftChecks);
    const runSkillAiChecks = vi.fn(async () => ({ jobId: "test-job", status: "pending" }));
    const getAiJob = vi.fn(async () => ({ jobId: "test-job", status: "completed" as const, result: draftAiChecks, error: null, createdAt: "x", expiresAt: "x" }));
    render(<SkillDetail api={api({ runSkillDraftChecks, runSkillAiChecks, getAiJob, getSkillDraft: vi.fn(async () => ({ ...draft, checks: null, aiChecks: null })) })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^基础检查$|^Baseline checks$/i }));
    await waitFor(() => expect(runSkillDraftChecks).toHaveBeenCalledWith("harness-review", "claude-code"));
    fireEvent.click(screen.getByRole("button", { name: /^AI 质量建议$|^AI quality advice$/i }));
    await waitFor(() => expect(runSkillAiChecks).toHaveBeenCalledWith("harness-review", "claude-code"));
    fireEvent.click(document.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    expect(await within(await screen.findByRole("dialog")).findByText("AI 触发质量")).toBeInTheDocument();
  });

  it("keeps polling an AI quality job beyond the former 12-second client cutoff", async () => {
    const runSkillAiChecks = vi.fn(async () => ({ jobId: "slow-job", status: "pending" }));
    const getAiJob = vi.fn(async () => getAiJob.mock.calls.length <= 120
      ? { jobId: "slow-job", status: "running" as const, result: null, error: null, createdAt: "x", expiresAt: "x" }
      : { jobId: "slow-job", status: "completed" as const, result: draftAiChecks, error: null, createdAt: "x", expiresAt: "x" });
    render(<SkillDetail api={api({
      runSkillAiChecks,
      getAiJob,
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: null, aiChecks: null }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^AI 质量建议$|^AI quality advice$/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });

    expect(getAiJob.mock.calls.length).toBeGreaterThan(120);
    vi.useRealTimers();
    fireEvent.click(document.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    expect(within(await screen.findByRole("dialog")).getByText("AI 触发质量")).toBeInTheDocument();
    expect(screen.queryByText(/轮询超时|polling timed out/i)).not.toBeInTheDocument();
  });

  it("reports AI job failures through the global notification instead of a page-bottom notice", async () => {
    const runSkillAiChecks = vi.fn(async () => ({ jobId: "failed-job", status: "pending" }));
    const getAiJob = vi.fn(async () => ({
      jobId: "failed-job",
      status: "failed" as const,
      result: null,
      error: "模型服务暂不可用",
      createdAt: "x",
      expiresAt: "x"
    }));
    const { container } = render(<ToastProvider><SkillDetail api={api({
      runSkillAiChecks,
      getAiJob,
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: null, aiChecks: null }))
    })} skillId="harness-review" /></ToastProvider>);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^AI 质量建议$|^AI quality advice$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/AI 质量分析失败.*模型服务暂不可用/);
    expect(alert).toHaveAttribute("data-slot", "toast");
    expect(container.querySelector(".check-publish-layout > .notice")).toBeNull();
  });

  it("keeps AI quality findings advisory and hides automatic repair when nothing is fixable", async () => {
    const { container } = render(<SkillDetail api={api({
      getSkillDraft: vi.fn(async () => ({
        ...draft,
        checks: {
          items: [{ id: "entry", label: "Entry", status: "green" as const, message: "ok", filePath: null, fixable: true }],
          summary: { green: 1, yellow: 0, red: 0 },
          checkedAt: "2026-06-21T00:00:00Z"
        },
        aiChecks: {
          items: [{ id: "AI_STYLE", label: "表达建议", status: "red" as const, message: "可进一步精简", filePath: null, fixable: false }],
          summary: { green: 0, yellow: 0, red: 1 },
          checkedAt: "2026-06-21T00:01:00Z"
        }
      }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));

    const gateMetric = container.querySelector('[data-slot="required-check-red"]');
    expect(gateMetric).toBeInTheDocument();
    expect(within(gateMetric as HTMLElement).getByText("0")).toBeInTheDocument();
    fireEvent.click(gateMetric?.parentElement?.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    expect(within(await screen.findByRole("dialog")).getByText("表达建议")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动修复|automatic fix/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI 质量建议|AI quality advice/i })).toBeInTheDocument();
  });

  it("applyFix button triggers fix preview via the API (INT-004)", async () => {
    const previewSkillFix = vi.fn(async () => ({
      items: [{ checkId: "c2", action: "confirm" as const, label: "Secret scan", affectedPaths: ["SKILL.md"], riskDelta: null, message: "narrowed" }],
      mergedFiles: [{ path: "SKILL.md", status: "modified" as const, publishedContent: "# old", draftContent: "# new" }],
      summary: { autoCount: 0, confirmCount: 1, suggestCount: 0, changedFiles: 1, changedLines: 1 }
    }));
    const applySkillFix = vi.fn(async () => ({ ...draft, checks: null, aiChecks: null, revision: 2 }));
    render(<SkillDetail api={api({
      runSkillDraftChecks: vi.fn(async () => draftChecks),
      previewSkillFix, applySkillFix,
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: null }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^基础检查$|^Baseline checks$/i }));
    const yellowMetric = document.querySelector('[data-slot="required-check-yellow"]') as HTMLElement;
    await waitFor(() => expect(within(yellowMetric).getByText("1")).toBeInTheDocument());
    fireEvent.click(yellowMetric);
    const applyFixBtn = await within(await screen.findByRole("dialog")).findByRole("button", { name: /应用修复|apply fix/i });
    fireEvent.click(applyFixBtn);
    await waitFor(() => expect(previewSkillFix).toHaveBeenCalledWith("harness-review", "claude-code", ["c2"]));
  });

  it("fix preview degraded 项展示'建议手动改'明确提示（UT-014 web 展示缺口）", async () => {
    const previewSkillFix = vi.fn(async () => ({
      items: [{ checkId: "c2", action: "suggest" as const, label: "Secret scan", affectedPaths: [], riskDelta: "degraded: source-file region not auto-fixable (manual edit required)", message: "无法自动定位" }],
      mergedFiles: [],
      summary: { autoCount: 0, confirmCount: 0, suggestCount: 1, changedFiles: 0, changedLines: 0 }
    }));
    render(<SkillDetail api={api({
      runSkillDraftChecks: vi.fn(async () => draftChecks),
      previewSkillFix,
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: null }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^基础检查$|^Baseline checks$/i }));
    const yellowMetric = document.querySelector('[data-slot="required-check-yellow"]') as HTMLElement;
    await waitFor(() => expect(within(yellowMetric).getByText("1")).toBeInTheDocument());
    fireEvent.click(yellowMetric);
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: /应用修复|apply fix/i }));
    await waitFor(() => expect(previewSkillFix).toHaveBeenCalled());
    // degraded 项明确展示"建议手动改"（非静默，覆盖 UT-014 web 展示缺口）
    expect(await screen.findByTestId("degraded-fix-notice")).toBeInTheDocument();
    expect(screen.getByText(/该修复暂不支持自动应用|cannot be applied automatically/i)).toBeInTheDocument();
  });

  it("AI generate button fills release note textarea (T15 #1)", async () => {
    const generateReleaseNote = vi.fn(async () => ({
      releaseNote: "AI: 新增触发质量检查与发布校验",
      generatedAt: "2026-06-29T00:00:00Z"
    }));
    render(<SkillDetail api={api({ generateReleaseNote })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const publishBtn = await screen.findByRole("button", { name: /^发布$|^Publish$/i });
    fireEvent.click(publishBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^AI 生成$|^AI generate$/i }));
    await waitFor(() => expect(generateReleaseNote).toHaveBeenCalledWith("harness-review", "claude-code"));
    expect(await screen.findByDisplayValue("AI: 新增触发质量检查与发布校验")).toBeInTheDocument();
  });

  it("publishes the draft and npm package through one request without double bumping", async () => {
    const publishSkill = vi.fn(async () => ({
      release: { slug: skill.slug, version: "0.1.0" },
      npmRelease: {
        status: "published" as const,
        packageName: "@hunter-harness/harness-review",
        version: "0.1.0",
        tarballHash: "sha256:" + "c".repeat(64)
      }
    }));
    render(<ToastProvider><SkillDetail api={api({ publishSkill })} skillId="harness-review" /></ToastProvider>);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^发布$|^Publish$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /确认发布|confirm publish/i }));
    await waitFor(() => expect(publishSkill).toHaveBeenCalledWith("harness-review", expect.objectContaining({
      version: "0.1.0",
      sourceAgent: "claude-code",
      draftRevision: 1
    })));
    expect(await screen.findByRole("status")).toHaveTextContent(/版本 0\.1\.0 已发布|Version 0\.1\.0 was published/i);
  });

  it("AI generate degraded shows aiGenerateFailed notice (T15 #1)", async () => {
    const generateReleaseNote = vi.fn(async () => ({
      releaseNote: null,
      generatedAt: "2026-06-29T00:00:00Z",
      degraded: true,
      reason: "AI_TIMEOUT"
    }));
    render(<ToastProvider><SkillDetail api={api({ generateReleaseNote })} skillId="harness-review" /></ToastProvider>);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const publishBtn = await screen.findByRole("button", { name: /^发布$|^Publish$/i });
    fireEvent.click(publishBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^AI 生成$|^AI generate$/i }));
    await waitFor(() => expect(generateReleaseNote).toHaveBeenCalledWith("harness-review", "claude-code"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/AI 生成失败|AI generation failed/i);
  });

  it("AI 质量检查结果直接携带修改建议，不再展示第二个生成入口", async () => {
    const fetchFixSuggestions = vi.fn();
    const aiChecks = {
      items: [
        { id: "AI_TRIGGER_QUALITY", label: "触发条件质量", status: "green" as const, message: "范围清晰", filePath: "SKILL.md", fixable: false, suggestion: null },
        { id: "AI_BODY_QUALITY", label: "正文质量", status: "yellow" as const, message: "正文存在重复规则", filePath: "SKILL.md", fixable: true, suggestion: { suggestedContent: '["合并重复规则"]', explanation: "减少重复并保留唯一入口。", appliesTo: "instructions" as const, generatedAt: "2026-06-29T00:00:00Z", applicationState: "ready" as const, appliedAt: null } }
      ],
      summary: { green: 1, yellow: 1, red: 0 },
      checkedAt: "2026-06-29T00:00:00Z"
    };
    const { container } = render(<SkillDetail api={api({
      fetchFixSuggestions,
      getSkillDraft: vi.fn(async () => ({ ...draft, aiChecks }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));

    expect(screen.queryByRole("button", { name: /^生成改进建议$|^Generate improvement advice$/i })).not.toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/已通过，无需修改|passed.*no change/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /查看并应用|review and apply/i }));
    expect(await screen.findByText(/减少重复并保留唯一入口/)).toBeInTheDocument();
    expect(fetchFixSuggestions).not.toHaveBeenCalled();
  });

  it("应用一条 AI 建议后保留检查快照，并单独展示本次应用前后的修改", async () => {
    const readySuggestion = { suggestedContent: "更清晰的描述", explanation: "直接说明技能用途。", appliesTo: "description" as const, generatedAt: "2026-06-29T00:00:00Z", applicationState: "ready" as const, appliedAt: null };
    const aiChecks = {
      items: [{ id: "AI_DESC", label: "描述质量", status: "yellow" as const, message: "描述不清", filePath: "SKILL.md", fixable: true, suggestion: readySuggestion }],
      summary: { green: 0, yellow: 1, red: 0 },
      checkedAt: "2026-06-29T00:00:00Z"
    };
    const updatedAiChecks = {
      ...aiChecks,
      items: [{
        id: "AI_DESC",
        label: "描述质量",
        status: "yellow" as const,
        message: "描述不清",
        filePath: "SKILL.md",
        fixable: true,
        suggestion: { ...readySuggestion, applicationState: "applied" as const, appliedAt: "2026-06-29T00:01:00Z" }
      }]
    };
    const beforeContent = "---\ndescription: 原始描述\n---\n\n原始正文。";
    const afterContent = "---\ndescription: 更清晰的描述\n---\n\n原始正文。";
    const suggestionDraft = { ...draft, sourceFiles: [{ path: "SKILL.md", content: beforeContent }], aiChecks };
    const applyFixSuggestion = vi.fn(async () => ({
      ...suggestionDraft,
      sourceFiles: [{ path: "SKILL.md", content: afterContent }],
      aiChecks: updatedAiChecks,
      revision: 2
    }));
    const diffSkillDraft = vi.fn(async () => [{ path: "SKILL.md", status: "modified" as const, publishedContent: "description: old", draftContent: "description: 更清晰的描述" }]);
    const { container } = render(<SkillDetail api={api({
      applyFixSuggestion,
      diffSkillDraft,
      getSkillDraft: vi.fn(async () => suggestionDraft)
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(container.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /查看并应用|review and apply/i }));
    const suggestionDialog = await screen.findByRole("dialog");
    fireEvent.click(within(suggestionDialog).getByRole("button", { name: /直接应用|Apply directly/i }));

    await waitFor(() => expect(applyFixSuggestion).toHaveBeenCalledWith("harness-review", "claude-code", { checkId: "AI_DESC", suggestedContent: "更清晰的描述", appliesTo: "description" }));
    expect(await within(suggestionDialog).findByText(/已应用|applied/i)).toBeInTheDocument();
    await waitFor(() => expect(diffSkillDraft.mock.calls.length).toBeGreaterThanOrEqual(2));
    const diffPanel = container.querySelector('[data-slot="default-version-diff"]') as HTMLElement;
    expect(within(diffPanel).getByRole("button", { name: /本次修改|this change/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(diffPanel).getByText(/应用前|before applying/i)).toBeInTheDocument();
    expect(within(diffPanel).getByText(/应用后|after applying/i)).toBeInTheDocument();
    expect(within(diffPanel).getByText("description: 原始描述")).toBeInTheDocument();
    expect(within(diffPanel).getByText("description: 更清晰的描述")).toBeInTheDocument();
    expect(diffPanel).toHaveAttribute("data-diff-view", "suggestion");
  });

  it("只读 AI 建议仍可查看和复制，但不会显示直接应用", async () => {
    const aiChecks = {
      items: [{ id: "AI_CROSS_AGENT", label: "跨工具兼容", status: "yellow" as const, message: "仍有工具专属描述", filePath: "SKILL.md", fixable: false, suggestion: { suggestedContent: "将工具专属名称改为通用 Agent 表述。", explanation: "该项涉及多处正文，需要人工确认。", appliesTo: null, generatedAt: "2026-06-29T00:00:00Z", applicationState: "ready" as const, appliedAt: null } }],
      summary: { green: 0, yellow: 1, red: 0 },
      checkedAt: "2026-06-29T00:00:00Z"
    };
    const { container } = render(<SkillDetail api={api({ getSkillDraft: vi.fn(async () => ({ ...draft, aiChecks })) })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(container.querySelector('[data-slot="ai-quality-advice"]') as HTMLElement);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /查看建议|view suggestion/i }));
    const suggestionDialog = await screen.findByRole("dialog");
    expect(within(suggestionDialog).getByText(/需要人工确认/)).toBeInTheDocument();
    expect(within(suggestionDialog).queryByRole("button", { name: /直接应用|Apply directly/i })).not.toBeInTheDocument();
  });

  it("列表只按本地或外部来源筛选，并区分本地、GitHub 与 npm 卡片", async () => {
    const npmSkill: ExternalSkill = {
      ...externalSkill,
      id: "ext_lark_bridge",
      source: { type: "npm", ref: "@hunterzheng/lark-channel-bridge" },
      snapshot: {
        ...externalSkill.snapshot,
        name: "@hunterzheng/lark-channel-bridge",
        version: "0.3.15"
      }
    };
    const { container } = render(<SkillRegistry api={api({
      listExternalSkills: vi.fn(async () => [externalSkill, npmSkill])
    })} />);
    await screen.findByText("harness-review");
    await screen.findByText("@hunterzheng/lark-channel-bridge");

    const toolbar = container.querySelector(".skill-workbench-toolbar") as HTMLElement;
    expect(within(toolbar).queryByText(/^Agent$/i)).not.toBeInTheDocument();
    expect(within(toolbar).getAllByRole("combobox")).toHaveLength(2);
    const sourceSelect = within(toolbar).getByRole("combobox", { name: /^(来源|Source)$/i });
    expect(within(sourceSelect).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringMatching(/全部|All/i),
      expect.stringMatching(/本地技能|Local skills/i),
      expect.stringMatching(/外部技能|External skills/i)
    ]);
    expect(within(sourceSelect).queryByRole("option", { name: /^npm$/i })).not.toBeInTheDocument();
    expect(within(sourceSelect).queryByRole("option", { name: /^GitHub$/i })).not.toBeInTheDocument();

    expect(container.querySelector('[data-source-kind="local"]')).toBeInTheDocument();
    expect(container.querySelector('[data-source-kind="github"]')).toBeInTheDocument();
    expect(container.querySelector('[data-source-kind="npm"]')).toBeInTheDocument();

    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    const rootTokens = css.match(/:root\s*\{[^}]+\}/s)?.[0] ?? "";
    const localColor = rootTokens.match(/--source-local:\s*([^;]+);/)?.[1]?.trim();
    const githubColor = rootTokens.match(/--source-github:\s*([^;]+);/)?.[1]?.trim();
    const npmColor = rootTokens.match(/--source-npm:\s*([^;]+);/)?.[1]?.trim();
    expect(localColor).toBe("#22d3ee");
    expect(githubColor).toBe("#c084fc");
    expect(npmColor).toBe("#fb923c");
    expect(new Set([localColor, githubColor, npmColor]).size).toBe(3);
    expect(css.match(/\.skill-card-shell\s*\{[^}]+\}/s)?.[0] ?? "").toMatch(/--card-source-accent:\s*var\(--source-local\)/);
    expect(css.match(/\.skill-card-shell\[data-source-kind="github"\]\s*\{[^}]+\}/s)?.[0] ?? "").toMatch(/--card-source-accent:\s*var\(--source-github\)/);
    expect(css.match(/\.skill-card-shell\[data-source-kind="npm"\]\s*\{[^}]+\}/s)?.[0] ?? "").toMatch(/--card-source-accent:\s*var\(--source-npm\)/);

    fireEvent.change(sourceSelect, { target: { value: "external" } });
    expect(screen.queryByText("harness-review")).not.toBeInTheDocument();
    expect(screen.getAllByText("CodeGraph")).toHaveLength(2);
    fireEvent.change(sourceSelect, { target: { value: "registry" } });
    expect(screen.getByText("harness-review")).toBeInTheDocument();
    expect(screen.queryByText("CodeGraph")).not.toBeInTheDocument();
  });

  it("cursor download is wired to the API, not demo-only (T17)", async () => {
    const downloadSkillArtifact = vi.fn(async () => ({ blob: new Blob([]), hash: "sha256:abc", filename: "cursor.zip" }));
    render(<SkillDetail api={api({ downloadSkillArtifact })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    const agentSelect = screen.getByRole("combobox");
    fireEvent.change(agentSelect, { target: { value: "cursor" } });
    const downloadBtn = screen.getByRole("button", { name: /下载|download/i });
    fireEvent.click(downloadBtn);
    await waitFor(() => expect(downloadSkillArtifact).toHaveBeenCalledWith("harness-review", "cursor"));
  });
});
