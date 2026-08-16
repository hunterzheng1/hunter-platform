// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProjectWorkspaceShell,
  WorkspaceFilterBar,
  WorkspaceState,
  type ProjectWorkspaceSection
} from "../components/project-workspace-shell";

afterEach(cleanup);

const labels: Record<ProjectWorkspaceSection, string> = {
  monitor: "分支监控",
  branchFiles: "分支文件",
  materials: "项目资料",
  knowledge: "项目知识",
  changes: "变更记录",
  versions: "版本记录",
  apiKeys: "API 密钥"
};

describe("ProjectWorkspaceShell", () => {
  it("exposes the canonical navigation order and keyboard-selects one linked panel", () => {
    const onSectionChange = vi.fn();
    render(<ProjectWorkspaceShell
      activeSection="monitor"
      ariaLabel="项目工作台"
      labels={labels}
      onSectionChange={onSectionChange}
      fallback={<p>待接入</p>}
      slots={{
        monitor: { content: <p>运行内容</p> },
        knowledge: { content: <p>知识内容</p>, keepMounted: true }
      }}
    />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "分支监控",
      "分支文件",
      "项目资料",
      "项目知识",
      "变更记录",
      "版本记录",
      "API 密钥"
    ]);

    const monitor = screen.getByRole("tab", { name: "分支监控" });
    expect(monitor).toHaveAttribute("tabindex", "0");
    const activePanel = screen.getByRole("tabpanel");
    expect(monitor).toHaveAttribute("aria-controls", activePanel.id);
    expect(activePanel).toHaveTextContent("运行内容");
    expect(screen.getByText("知识内容").closest("[role=tabpanel]")).toHaveAttribute("hidden");

    fireEvent.keyDown(monitor, { key: "ArrowRight" });
    expect(onSectionChange).toHaveBeenLastCalledWith("branchFiles");
    fireEvent.keyDown(monitor, { key: "End" });
    expect(onSectionChange).toHaveBeenLastCalledWith("apiKeys");
  });

  it("renders shared filter and machine-distinct states without exposing details by default", () => {
    const onQueryChange = vi.fn();
    render(<>
      <WorkspaceFilterBar
        label="筛选分支文件"
        query=""
        placeholder="搜索路径"
        onQueryChange={onQueryChange}
      >
        <button type="button">全部文件</button>
      </WorkspaceFilterBar>
      <WorkspaceState technicalDetailsLabel="技术详情" state={{
        kind: "partialFailure",
        title: "部分结果暂不可用",
        description: "已加载的内容仍可查看。",
        technicalDetails: [{ label: "错误码", value: "CURSOR_STALE" }]
      }}>
        <p>已加载 8 项</p>
      </WorkspaceState>
    </>);

    fireEvent.change(screen.getByRole("searchbox", { name: "筛选分支文件" }), { target: { value: "src" } });
    expect(onQueryChange).toHaveBeenCalledWith("src");
    expect(screen.getByRole("status")).toHaveTextContent("部分结果暂不可用");
    expect(screen.getByText("已加载 8 项")).toBeInTheDocument();
    const details = screen.getByText("技术详情").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("CURSOR_STALE");
  });

  it("keeps forbidden and loading states semantically distinct", () => {
    const { rerender } = render(<WorkspaceState technicalDetailsLabel="技术详情" state={{
      kind: "forbidden",
      title: "无权查看",
      description: "请联系项目管理员。"
    }} />);
    expect(screen.getByRole("alert")).toHaveAttribute("data-state", "forbidden");

    rerender(<WorkspaceState technicalDetailsLabel="技术详情" state={{ kind: "loading", label: "正在加载项目资料" }} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("正在加载项目资料");
  });

  it("keeps tab and panel ids unique across multiple shells", () => {
    const slots = { monitor: { content: <p>运行内容</p> } };
    render(<>
      <ProjectWorkspaceShell activeSection="monitor" ariaLabel="项目一" labels={labels} onSectionChange={vi.fn()} slots={slots} fallback={<p>尚未接入</p>} />
      <ProjectWorkspaceShell activeSection="monitor" ariaLabel="项目二" labels={labels} onSectionChange={vi.fn()} slots={slots} fallback={<p>尚未接入</p>} />
    </>);

    const tabs = screen.getAllByRole("tab", { name: "分支监控" });
    const panels = screen.getAllByRole("tabpanel", { name: "分支监控" });
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2);
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(2);
    expect(tabs[0]).toHaveAttribute("aria-controls", panels[0]?.id);
    expect(tabs[1]).toHaveAttribute("aria-controls", panels[1]?.id);
  });

  it("always renders one panel per tab and uses an honest fallback for a missing slot", () => {
    const { rerender } = render(<ProjectWorkspaceShell
      activeSection="monitor"
      ariaLabel="项目工作台"
      labels={labels}
      onSectionChange={vi.fn()}
      slots={{ monitor: { content: <p>运行内容</p> } }}
      fallback={<WorkspaceState technicalDetailsLabel="技术详情" state={{ kind: "processing", title: "查询正在接入", description: "尚无生产数据。" }} />}
    />);

    expect(document.querySelectorAll('[data-slot="project-workspace-panel"]')).toHaveLength(7);
    const materialsTab = screen.getByRole("tab", { name: "项目资料" });
    const materialsPanel = document.getElementById(materialsTab.getAttribute("aria-controls") ?? "");
    expect(materialsPanel).toHaveAttribute("hidden");

    rerender(<ProjectWorkspaceShell
      activeSection="materials"
      ariaLabel="项目工作台"
      labels={labels}
      onSectionChange={vi.fn()}
      slots={{ monitor: { content: <p>运行内容</p> } }}
      fallback={<WorkspaceState technicalDetailsLabel="技术详情" state={{ kind: "processing", title: "查询正在接入", description: "尚无生产数据。" }} />}
    />);
    expect(screen.getByRole("tabpanel", { name: "项目资料" })).toHaveTextContent("查询正在接入");
  });

  it("marks every shared interaction as a touch target", () => {
    render(<>
      <ProjectWorkspaceShell activeSection="monitor" ariaLabel="项目工作台" labels={labels} onSectionChange={vi.fn()} slots={{}} fallback={<p>待接入</p>} />
      <WorkspaceFilterBar label="筛选" query="" placeholder="搜索" onQueryChange={vi.fn()}>
        <button type="button">全部</button>
      </WorkspaceFilterBar>
      <WorkspaceState
        technicalDetailsLabel="Technical details"
        state={{ kind: "error", title: "Failed", description: "Retry.", technicalDetails: [{ label: "Code", value: "FAILED" }] }}
      />
    </>);

    for (const tab of screen.getAllByRole("tab")) expect(tab).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByRole("searchbox")).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByText("Technical details")).toHaveAttribute("data-touch-target", "true");
  });

  it("takes the technical-details summary from the caller locale", () => {
    const state = { kind: "error" as const, title: "Failed", description: "Retry.", technicalDetails: [{ label: "Code", value: "FAILED" }] };
    const { rerender } = render(<WorkspaceState technicalDetailsLabel="Technical details" state={state} />);
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.queryByText("技术详情")).not.toBeInTheDocument();

    rerender(<WorkspaceState technicalDetailsLabel="技术详情" state={state} />);
    expect(screen.getByText("技术详情")).toBeInTheDocument();
  });
});
