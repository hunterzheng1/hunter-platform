// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ExternalSkill, RegistryTag } from "@hunter-harness/contracts";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalSkillDetail } from "../components/external-skill-detail";
import { ToastProvider } from "../components/ui/Toast";
import { ApiClientError, type HunterApi } from "../lib/api";

function renderWithToast(element: ReactElement) {
  return render(<ToastProvider>{element}</ToastProvider>);
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() })
}));

const readme = `<div align="center">

# CodeGraph

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png">
  <img alt="CodeGraph 标志" src="https://example.com/codegraph.png">
</picture>

[![release](https://example.com/release.svg)](https://github.com/colbymchenry/codegraph/releases)
[![license](https://example.com/license.svg)](https://github.com/colbymchenry/codegraph/blob/main/LICENSE)
[![windows](https://example.com/windows.svg)](https://github.com/colbymchenry/codegraph#windows)

## Fast code intelligence

Pre-indexed code knowledge for coding agents.

### Install

\`\`\`bash
npx codegraph init
\`\`\`
</div>`;

const imageGalleryReadme = `## Language Support

<p align="center">
  <img src="https://example.com/typescript.svg" width="104" height="104" alt="TypeScript" />
  <img src="https://example.com/javascript.svg" width="104" height="104" alt="JavaScript" />
  <img src="https://example.com/python.svg" width="104" height="104" alt="Python" />
</p>`;

const comparisonInFenceReadme = `## Auto-sync

\`\`\`text
watcher fires (<100ms)
\`\`\`

<span>Index status</span>

## Measured cross-file coverage

| Language | Coverage |
|---|---|
| TypeScript | 95.8% |`;

const externalSkill: ExternalSkill = {
  id: "ext_codegraph",
  source: { type: "github", ref: "colbymchenry/codegraph" },
  snapshot: {
    name: "colbymchenry/codegraph",
    description: "Pre-indexed code knowledge graph for coding agents.",
    version: "v1.5.0",
    readme,
    installCommand: "https://github.com/colbymchenry/codegraph",
    license: "MIT",
    homepage: "https://github.com/colbymchenry/codegraph",
    releaseUrl: "https://github.com/colbymchenry/codegraph/releases/tag/v1.5.0",
    fetchedAt: "2026-08-10T08:00:00Z"
  },
  curationNote: "适合大型代码库分析",
  tags: ["code-intelligence"],
  updateAvailable: false,
  availableVersion: null,
  updateHistory: [],
  lastCheckedAt: "2026-08-10T08:00:00Z",
  revision: 1,
  created_at: "2026-08-10T08:00:00Z",
  updated_at: "2026-08-10T08:00:00Z"
};

function api(): HunterApi {
  return {
    getExternalSkill: vi.fn(async () => externalSkill)
  } as unknown as HunterApi;
}

function apiWithReadme(content: string): HunterApi {
  return {
    getExternalSkill: vi.fn(async () => ({
      ...externalSkill,
      snapshot: { ...externalSkill.snapshot, readme: content }
    }))
  } as unknown as HunterApi;
}

const summarizedSkill: ExternalSkill = {
  ...externalSkill,
  aiSummary: {
    overview: "为编码 Agent 提供预索引的代码知识与调用关系。",
    use_cases: ["快速理解大型代码库", "定位跨模块影响"],
    capabilities: ["构建代码关系图", "按符号查询上下文"],
    getting_started: ["在项目根目录运行初始化命令"],
    quick_start: [
      {
        title: "全局安装",
        instruction: "只需安装一次命令行工具。",
        commands: ["npm install -g @colbymchenry/codegraph"]
      },
      {
        title: "初始化并验证",
        instruction: "进入项目后构建索引，并确认索引已经可用。",
        commands: ["cd <project-path>", "codegraph init --index", "codegraph status"]
      }
    ],
    command_cheatsheet: [
      { command: "codegraph status", description: "检查当前项目索引是否就绪。" },
      { command: "codegraph explore \"<question-about-code>\"", description: "用自然语言查询代码结构和调用关系。" },
      { command: "codegraph upgrade", description: "检查并升级命令行工具到可用的新版本。" }
    ],
    caveats: ["代码变更后需要刷新索引"],
    source_sha256: "sha256:" + "a".repeat(64),
    provider_id: "deepseek",
    model: "deepseek-chat",
    generated_at: "2026-08-10T08:30:00Z"
  },
  revision: 2
};

afterEach(cleanup);

describe("external skill reader", () => {
  it("默认展示可读概览并按需展开原始 README", async () => {
    const { container } = renderWithToast(<ExternalSkillDetail api={api()} skillId={externalSkill.id} />);

    expect((await screen.findAllByText("colbymchenry/codegraph")).length).toBeGreaterThan(0);
    expect(container.querySelector('[data-slot="external-skill-title"]')).toHaveTextContent("CodeGraph");
    expect(container.querySelector(".external-skill-repository-line")).toHaveTextContent("colbymchenry/codegraph");
    expect(screen.getByRole("heading", { name: "技能概览" })).toBeInTheDocument();
    expect(screen.getByText("尚未生成 AI 摘要")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="external-readme-reader"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看原始 README" }));
    const reader = await waitFor(() => container.querySelector('[data-slot="external-readme-reader"]'));
    expect(reader).toBeInTheDocument();
    expect(reader).toHaveClass("external-readme-reader");
    expect(within(reader as HTMLElement).queryByText(/<div|<picture|<source|<img/i)).not.toBeInTheDocument();
    expect(within(reader as HTMLElement).getByAltText("CodeGraph 标志")).toBeInTheDocument();
    const badgeRow = reader?.querySelector('[data-slot="markdown-badge-row"]');
    expect(badgeRow).toBeInTheDocument();
    expect(within(badgeRow as HTMLElement).getAllByRole("img")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "上游仓库地址" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://github.com/colbymchenry/codegraph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制地址" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看版本记录" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "官方安装命令" })).not.toBeInTheDocument();
  });

  it("将 HTML 段落中的连续内容图片渲染为同一横向图片组", async () => {
    const { container } = renderWithToast(
      <ExternalSkillDetail api={apiWithReadme(imageGalleryReadme)} skillId={externalSkill.id} />
    );

    fireEvent.click(await screen.findByRole("button", { name: "查看原始 README" }));
    const reader = await waitFor(() => container.querySelector('[data-slot="external-readme-reader"]'));
    const imageGrid = reader?.querySelector('[data-slot="markdown-image-grid"]');

    expect(imageGrid).toBeInTheDocument();
    expect(within(imageGrid as HTMLElement).getAllByRole("img")).toHaveLength(3);
  });

  it("保留代码围栏中的小于号文本并继续渲染后续 Markdown 块", async () => {
    const { container } = renderWithToast(
      <ExternalSkillDetail api={apiWithReadme(comparisonInFenceReadme)} skillId={externalSkill.id} />
    );

    fireEvent.click(await screen.findByRole("button", { name: "查看原始 README" }));
    const reader = await waitFor(() => container.querySelector('[data-slot="external-readme-reader"]'));

    expect(within(reader as HTMLElement).getByText("watcher fires (<100ms)")).toBeInTheDocument();
    expect(within(reader as HTMLElement).getByRole("heading", { name: "Measured cross-file coverage" }))
      .toBeInTheDocument();
    expect(Array.from(reader?.querySelectorAll("pre") ?? []).some((pre) =>
      pre.textContent?.includes("## Measured cross-file coverage")
    )).toBe(false);
  });

  it("优先展示已缓存的结构化中文 AI 摘要", async () => {
    const { container } = renderWithToast(<ExternalSkillDetail api={{ getExternalSkill: vi.fn(async () => summarizedSkill) } as unknown as HunterApi} skillId={externalSkill.id} />);

    expect(await screen.findAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(container.querySelector(".external-skill-hero-copy .lede")).toHaveTextContent("为编码 Agent 提供预索引的代码知识与调用关系。");
    const summaryTemplate = container.querySelector('[data-slot="external-skill-summary-template"]');
    expect(summaryTemplate).not.toBeNull();
    expect(within(summaryTemplate as HTMLElement).getAllByRole("heading").map((heading) => heading.textContent?.trim())).toEqual([
      "它是什么",
      "典型工作流",
      "命令速查",
      "核心功能",
      "适用场景",
      "使用前注意"
    ]);
    const workflow = container.querySelector('[data-slot="external-summary-workflow"]');
    expect(workflow).not.toBeNull();
    expect(workflow).toHaveAttribute("data-priority", "primary");
    expect(workflow).toHaveAttribute("aria-labelledby", "external-summary-workflow-title");
    expect(within(workflow as HTMLElement).getByText("从这里开始")).toBeInTheDocument();
    expect(within(workflow as HTMLElement).getByText("2 个步骤")).toBeInTheDocument();
    expect(within(workflow as HTMLElement).getByText("全局安装")).toBeInTheDocument();
    expect(within(workflow as HTMLElement).getByText("npm install -g @colbymchenry/codegraph")).toBeInTheDocument();
    expect(workflow).toHaveTextContent("codegraph init --index");
    expect(workflow).toHaveTextContent("codegraph status");
    expect(within(workflow as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(workflow?.querySelectorAll('[data-slot="external-workflow-step"]')).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "适用场景" })).toBeInTheDocument();
    expect(screen.getByText("快速理解大型代码库")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "核心功能" })).toBeInTheDocument();
    expect(screen.getByText("代码变更后需要刷新索引")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "使用前注意" }).closest("section"))
      .toHaveClass("external-summary-section-wide");
    expect(screen.getByText(/DeepSeek · deepseek-chat/i)).toBeInTheDocument();
    const commonCommands = container.querySelector('[data-slot="external-summary-common-commands"]');
    expect(commonCommands).not.toBeNull();
    expect(commonCommands).toHaveAttribute("data-layout", "cheatsheet");
    expect(commonCommands?.querySelectorAll('[data-slot="external-command-cheatsheet-item"]')).toHaveLength(3);
    expect(commonCommands).toHaveTextContent("检查当前项目索引是否就绪。");
    expect(commonCommands).toHaveTextContent("用自然语言查询代码结构和调用关系。");
    expect(commonCommands).not.toHaveTextContent("npm install -g @colbymchenry/codegraph");
    expect(screen.queryByText("Fast code intelligence")).not.toBeInTheDocument();
  });

  it("在典型工作流说明中突出技能名称，便于快速识别调用关系", async () => {
    const existingSummary = summarizedSkill.aiSummary;
    if (existingSummary === null || existingSummary === undefined) throw new Error("fixture summary is required");
    const skillWithReferences: ExternalSkill = {
      ...summarizedSkill,
      aiSummary: {
        ...existingSummary,
        quick_start: [{
          title: "选择澄清方式",
          instruction: "先用 grill-with-docs 澄清工程变更，或用 grill-me 澄清非代码计划。",
          commands: []
        }]
      }
    };
    const { container } = renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => skillWithReferences)
    } as unknown as HunterApi} skillId={skillWithReferences.id} />);

    await screen.findByText("选择澄清方式");
    expect(Array.from(container.querySelectorAll('[data-slot="external-workflow-skill-reference"]')).map((node) => node.textContent))
      .toEqual(["grill-with-docs", "grill-me"]);
  });

  it("把典型工作流命令展示为高辨识终端块并支持一键复制", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => summarizedSkill)
    } as unknown as HunterApi} skillId={summarizedSkill.id} />);

    await screen.findByText("全局安装");
    const workflow = container.querySelector('[data-slot="external-summary-workflow"]');
    const commandBlocks = workflow?.querySelectorAll('[data-slot="external-workflow-command"]') ?? [];
    expect(commandBlocks).toHaveLength(2);
    const first = commandBlocks[0] as HTMLElement;
    expect(first.querySelectorAll('[data-slot="external-workflow-command-line"]')).toHaveLength(1);
    expect(first).toHaveTextContent("npm install -g @colbymchenry/codegraph");
    fireEvent.click(within(first).getByRole("button", { name: "复制命令" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm install -g @colbymchenry/codegraph"));
  });

  it("官方安装命令复用典型工作流的高辨识终端块", async () => {
    const npmSkill: ExternalSkill = {
      ...externalSkill,
      source: { type: "npm", ref: "@hunterzheng/lark-channel-bridge" },
      snapshot: {
        ...externalSkill.snapshot,
        installCommand: "npm install @hunterzheng/lark-channel-bridge",
        homepage: "https://www.npmjs.com/package/@hunterzheng/lark-channel-bridge"
      }
    };
    const { container } = renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => npmSkill)
    } as unknown as HunterApi} skillId={npmSkill.id} />);

    expect(await screen.findByRole("heading", { name: "官方安装命令" })).toBeInTheDocument();
    const installBlock = container.querySelector('[data-slot="external-install-command"]');
    expect(installBlock).toHaveClass("external-workflow-command");
    expect(installBlock?.querySelector('[data-slot="external-workflow-command-line"]'))
      .toHaveTextContent("npm install @hunterzheng/lark-channel-bridge");
    expect(within(installBlock as HTMLElement).getByRole("button", { name: "复制命令" })).toBeInTheDocument();
  });

  it("生成期间持续展示明确进度，完成后自动替换为摘要", async () => {
    let finish: ((skill: ExternalSkill) => void) | undefined;
    const pending = new Promise<ExternalSkill>((resolve) => { finish = resolve; });
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => externalSkill),
      generateExternalSkillSummary: vi.fn(() => pending)
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "生成 AI 摘要" }));
    const progress = screen.getByRole("status");
    expect(progress).toHaveTextContent("正在生成中文摘要");
    expect(progress).toHaveTextContent("完成后会自动显示，无需刷新页面");
    expect(progress.querySelector(".spinner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /正在生成/ })).toHaveAttribute("aria-busy", "true");

    finish?.(summarizedSkill);
    expect(await screen.findAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(document.querySelector('[data-slot="external-summary-progress"]')).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("AI 摘要已生成并缓存");
  });

  it("可从详情页生成并立即展示 AI 摘要", async () => {
    const generate = vi.fn(async () => summarizedSkill);
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => externalSkill),
      generateExternalSkillSummary: generate
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "生成 AI 摘要" }));
    expect(await screen.findAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(generate).toHaveBeenCalledWith(externalSkill.id, externalSkill.revision, false);
  });

  it("生成请求报错但服务端已保存时自动对账并展示新摘要", async () => {
    const getExternalSkill = vi.fn()
      .mockResolvedValueOnce(externalSkill)
      .mockResolvedValueOnce(summarizedSkill);
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill,
      generateExternalSkillSummary: vi.fn(async () => {
        throw new ApiClientError(0, "NETWORK_ERROR", "response connection closed");
      })
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "生成 AI 摘要" }));

    expect(await screen.findAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(getExternalSkill).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("AI 摘要已生成并缓存");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("摘要解析失败时保留旧摘要，只显示可操作的中文提示", async () => {
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => summarizedSkill),
      generateExternalSkillSummary: vi.fn(async () => {
        throw new ApiClientError(502, "AI_PARSE_FAILED", "ai summary response was not valid structured content");
      })
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "重新生成" }));

    expect(await screen.findByText(/模型返回的摘要格式不完整/)).toBeInTheDocument();
    expect(screen.getAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(screen.queryByText(/AI_PARSE_FAILED|valid structured content/)).not.toBeInTheDocument();
  });

  it("可选择已有标签并保存", async () => {
    const tags: RegistryTag[] = [
      {
        tag_id: "tag_code",
        slug: "code-intelligence",
        label: "代码理解",
        active: true,
        revision: 1,
        usageCount: 1,
        created_at: "2026-08-10T08:00:00Z",
        updated_at: "2026-08-10T08:00:00Z"
      },
      {
        tag_id: "tag_review",
        slug: "review",
        label: "代码评审",
        active: true,
        revision: 1,
        usageCount: 0,
        created_at: "2026-08-10T08:00:00Z",
        updated_at: "2026-08-10T08:00:00Z"
      }
    ];
    const patchExternalSkill = vi.fn(async (_id, input) => ({
      ...externalSkill,
      tags: input.tags ?? externalSkill.tags,
      revision: 2
    }));
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => externalSkill),
      listTags: vi.fn(async () => tags),
      patchExternalSkill
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加标签：代码评审" }));
    expect(screen.queryByLabelText("策展笔记")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));

    await waitFor(() => expect(patchExternalSkill).toHaveBeenCalledWith(externalSkill.id, {
      tags: ["code-intelligence", "review"],
      revision: 1
    }));
    expect(await screen.findByText("技能标签已保存")).toBeInTheDocument();
  });

  it("可用中文名称新增标签并自动加入当前技能", async () => {
    const created: RegistryTag = {
      tag_id: "tag_graph",
      slug: "tag-graph",
      label: "知识图谱",
      active: true,
      revision: 1,
      usageCount: 0,
      created_at: "2026-08-10T08:00:00Z",
      updated_at: "2026-08-10T08:00:00Z"
    };
    const createTag = vi.fn(async (slug: string, label: string) => {
      void slug;
      void label;
      return created;
    });
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => externalSkill),
      listTags: vi.fn(async () => []),
      createTag
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.change(await screen.findByLabelText("新标签名称"), { target: { value: "知识图谱" } });
    fireEvent.click(screen.getByRole("button", { name: "新增标签" }));

    await waitFor(() => expect(createTag).toHaveBeenCalledTimes(1));
    expect(createTag.mock.calls[0]?.[1]).toBe("知识图谱");
    expect(await screen.findByRole("button", { name: "移除标签：知识图谱" })).toBeInTheDocument();
  });

  it("已知存在新版本时直接提供更新入口，并保留摘要版本提示", async () => {
    const checked = {
      ...summarizedSkill,
      updateAvailable: true,
      availableVersion: "v1.6.0",
      revision: 3
    } as ExternalSkill;
    const applied = {
      ...checked,
      snapshot: { ...checked.snapshot, version: "v1.6.0" },
      updateAvailable: false,
      availableVersion: null,
      revision: 4
    } as ExternalSkill;
    const refreshExternalSkill = vi.fn(async () => applied);
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => checked),
      refreshExternalSkill,
      deleteExternalSkill: vi.fn(async () => ({ id: externalSkill.id, deleted: true }))
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    expect(await screen.findByText(/摘要基于.*v1\.5\.0/)).toBeInTheDocument();
    expect(screen.queryByLabelText("策展笔记")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即更新至 v1.6.0" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即更新至 v1.6.0" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("v1.5.0");
    expect(dialog).toHaveTextContent("v1.6.0");
    fireEvent.click(within(dialog).getByRole("button", { name: "应用更新" }));
    await waitFor(() => expect(refreshExternalSkill).toHaveBeenCalledWith(externalSkill.id));
  });

  it("将跨版本更新合并为简洁项目符号，并允许单独刷新说明", async () => {
    const updated = {
      ...externalSkill,
      updateHistory: [{
        from_version: "0.3.15",
        to_version: "0.3.17",
        applied_at: "2026-08-12T09:23:00.000Z",
        source_url: "https://example.com/releases",
        changes: ["修复任务重试逻辑", "新增运行状态查询命令"],
        releases: [
          { version: "0.3.16", published_at: "2026-08-11T08:00:00.000Z", source_url: null, title: null, changes: ["修复重试逻辑"] },
          { version: "0.3.17", published_at: "2026-08-12T08:00:00.000Z", source_url: null, title: null, changes: ["新增状态查询命令"] }
        ]
      }]
    } as ExternalSkill;
    const refreshed = {
      ...updated,
      revision: updated.revision + 1,
      updateHistory: [{
        ...updated.updateHistory[0],
        changes: ["修复任务重试逻辑", "新增运行状态查询命令", "改善运行状态展示"]
      }]
    } as ExternalSkill;
    const refreshExternalSkillUpdateHistory = vi.fn(async () => refreshed);
    renderWithToast(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => updated),
      refreshExternalSkillUpdateHistory
    } as unknown as HunterApi} skillId={updated.id} />);

    const history = await screen.findByTestId("external-skill-update-history");
    expect(within(history).getByText("修复任务重试逻辑")).toBeInTheDocument();
    expect(within(history).getByText("新增运行状态查询命令")).toBeInTheDocument();
    expect(within(history).queryByText(/^0\.3\.1[67]：/)).not.toBeInTheDocument();
    expect(history.querySelectorAll(".external-update-release")).toHaveLength(0);
    fireEvent.click(within(history).getByRole("button", { name: "刷新说明" }));
    await waitFor(() => expect(refreshExternalSkillUpdateHistory)
      .toHaveBeenCalledWith(updated.id, "2026-08-12T09:23:00.000Z"));
    expect(await within(history).findByText("改善运行状态展示")).toBeInTheDocument();
    expect(await screen.findByText("更新说明已刷新")).toBeInTheDocument();
  });
});
