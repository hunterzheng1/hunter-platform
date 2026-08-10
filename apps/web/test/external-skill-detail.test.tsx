// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { ExternalSkill, RegistryTag } from "@hunter-harness/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalSkillDetail } from "../components/external-skill-detail";
import { ApiClientError, type HunterApi } from "../lib/api";

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
    const { container } = render(<ExternalSkillDetail api={api()} skillId={externalSkill.id} />);

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
    expect(screen.getByRole("button", { name: "复制地址" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "官方安装命令" })).not.toBeInTheDocument();
  });

  it("优先展示已缓存的结构化中文 AI 摘要", async () => {
    const { container } = render(<ExternalSkillDetail api={{ getExternalSkill: vi.fn(async () => summarizedSkill) } as unknown as HunterApi} skillId={externalSkill.id} />);

    expect(await screen.findAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(container.querySelector(".external-skill-hero-copy .lede")).toHaveTextContent("为编码 Agent 提供预索引的代码知识与调用关系。");
    const summaryTemplate = container.querySelector('[data-slot="external-skill-summary-template"]');
    expect(summaryTemplate).not.toBeNull();
    expect(within(summaryTemplate as HTMLElement).getAllByRole("heading").map((heading) => heading.textContent?.trim())).toEqual([
      "它是什么",
      "核心功能",
      "适用场景",
      "典型工作流",
      "使用前注意"
    ]);
    const workflow = container.querySelector('[data-slot="external-summary-workflow"]');
    expect(workflow).not.toBeNull();
    expect(within(workflow as HTMLElement).getByText("全局安装")).toBeInTheDocument();
    expect(within(workflow as HTMLElement).getByText("npm install -g @colbymchenry/codegraph")).toBeInTheDocument();
    expect(workflow).toHaveTextContent("codegraph init --index");
    expect(workflow).toHaveTextContent("codegraph status");
    expect(within(workflow as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "适用场景" })).toBeInTheDocument();
    expect(screen.getByText("快速理解大型代码库")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "核心功能" })).toBeInTheDocument();
    expect(screen.getByText("代码变更后需要刷新索引")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "使用前注意" }).closest("section"))
      .toHaveClass("external-summary-section-wide");
    expect(screen.getByText(/DeepSeek · deepseek-chat/i)).toBeInTheDocument();
    expect(screen.queryByText("Fast code intelligence")).not.toBeInTheDocument();
  });

  it("生成期间持续展示明确进度，完成后自动替换为摘要", async () => {
    let finish: ((skill: ExternalSkill) => void) | undefined;
    const pending = new Promise<ExternalSkill>((resolve) => { finish = resolve; });
    render(<ExternalSkillDetail api={{
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
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("可从详情页生成并立即展示 AI 摘要", async () => {
    const generate = vi.fn(async () => summarizedSkill);
    render(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => externalSkill),
      generateExternalSkillSummary: generate
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "生成 AI 摘要" }));
    expect(await screen.findAllByText("为编码 Agent 提供预索引的代码知识与调用关系。")).toHaveLength(2);
    expect(generate).toHaveBeenCalledWith(externalSkill.id, externalSkill.revision, false);
  });

  it("摘要解析失败时保留旧摘要，只显示可操作的中文提示", async () => {
    render(<ExternalSkillDetail api={{
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

  it("可选择已有标签并与维护备注一起保存", async () => {
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
      curationNote: input.curationNote ?? externalSkill.curationNote,
      tags: input.tags ?? externalSkill.tags,
      revision: 2
    }));
    render(<ExternalSkillDetail api={{
      getExternalSkill: vi.fn(async () => externalSkill),
      listTags: vi.fn(async () => tags),
      patchExternalSkill
    } as unknown as HunterApi} skillId={externalSkill.id} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加标签：代码评审" }));
    fireEvent.change(screen.getByLabelText("策展笔记"), { target: { value: "适合大型仓库的代码理解" } });
    fireEvent.click(screen.getByRole("button", { name: "保存维护信息" }));

    await waitFor(() => expect(patchExternalSkill).toHaveBeenCalledWith(externalSkill.id, {
      curationNote: "适合大型仓库的代码理解",
      tags: ["code-intelligence", "review"],
      revision: 1
    }));
    expect(await screen.findByText("备注和标签已保存")).toBeInTheDocument();
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
    render(<ExternalSkillDetail api={{
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
});
