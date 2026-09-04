// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRegistry } from "../components/project-registry";
import type { HunterApi, ProjectSummary } from "../lib/api";
import {
  formatProjectDateTime,
  paginateProjects,
  PROJECT_LIST_PAGE_SIZE,
  projectMatchesQuery,
  sortProjectsByUpdatedDesc
} from "../lib/project-list";

afterEach(cleanup);

function project(partial: Partial<ProjectSummary> & Pick<ProjectSummary, "project_id" | "display_name">): ProjectSummary {
  return {
    role: "owner",
    latest_project_version: "v1.0.0",
    latest_artifact_id: "art_x",
    created_at: "2026-01-01T00:00:00Z",
    current_file_count: 1,
    ...partial
  };
}

describe("project-list helpers", () => {
  it("uses a ten-project page for the denser card layout", () => {
    expect(PROJECT_LIST_PAGE_SIZE).toBe(10);
  });

  it("sorts by updated_at descending and falls back to created_at", () => {
    const items = [
      project({ project_id: "a", display_name: "Alpha", updated_at: "2026-07-01T10:00:00Z" }),
      project({ project_id: "b", display_name: "Beta", created_at: "2026-07-10T12:00:00Z" }),
      project({ project_id: "c", display_name: "Charlie", updated_at: "2026-07-15T08:00:05Z" })
    ];
    expect(sortProjectsByUpdatedDesc(items).map((item) => item.project_id)).toEqual(["c", "b", "a"]);
  });

  it("formats datetime with seconds", () => {
    const formatted = formatProjectDateTime("2026-07-17T06:42:18Z", "zh");
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/42/);
    expect(formatted).toMatch(/18/);
  });

  it("paginates with a safe page clamp", () => {
    const items = Array.from({ length: 13 }, (_, index) => index);
    expect(paginateProjects(items, 0, 6).pageItems).toHaveLength(6);
    expect(paginateProjects(items, 1, 6).pageItems).toEqual(items.slice(6, 12));
    expect(paginateProjects(items, 99, 6).safePage).toBe(2);
    expect(paginateProjects(items, 99, 6).pageItems).toEqual(items.slice(12));
  });

  it("only matches the user-facing project name", () => {
    const item = project({ project_id: "agent-harness", display_name: "Agent Harness" });
    expect(projectMatchesQuery(item, "agent")).toBe(true);
    expect(projectMatchesQuery(item, "harness")).toBe(true);
    expect(projectMatchesQuery(item, "agent-harness")).toBe(false);
    expect(projectMatchesQuery(item, "nope")).toBe(false);
  });
});

describe("ProjectRegistry list UX", () => {
  it("keeps project ids out of the visible catalog and labels search by project name", async () => {
    const hiddenId = "prj_internal_8f62a9";
    const internalVersion = "pv_cb80b916df224661afb2ae7923387101";
    const api = {
      listProjects: vi.fn(async (state: "active" | "archived" = "active") => state === "active"
        ? [project({ project_id: hiddenId, display_name: "支付网关", latest_project_version: internalVersion, current_file_count: 14 })]
        : []),
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: hiddenId,
        artifact_id: "art_test",
        counts: { documents: 18, knowledge: 10, rules: 2, changes: 3, architecture: 1, agent_instructions: 2, edges: 8 }
      }))
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);

    expect(await screen.findByRole("heading", { name: "支付网关" })).toBeInTheDocument();
    expect(screen.queryByText(hiddenId)).toBeNull();
    expect(screen.queryByText(internalVersion)).toBeNull();
    expect(screen.getByText("已有远端版本")).toBeInTheDocument();
    expect(screen.getAllByText("项目文件").length).toBeGreaterThan(0);
    expect(await screen.findByText("10 条知识")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /搜索项目|Search projects/i }))
      .toHaveAttribute("placeholder", "按项目名称搜索");
    expect(document.querySelector('[data-slot="project-card-grid"]'))
      .toHaveAttribute("data-layout", "two-column");
  });

  it("loads knowledge previews only for projects on the visible page", async () => {
    const items = Array.from({ length: 13 }, (_, index) => project({
      project_id: `prj_${String(index + 1).padStart(2, "0")}`,
      display_name: `项目 ${String(index + 1).padStart(2, "0")}`,
      updated_at: "2026-08-11T08:00:00Z"
    }));
    const getProjectSemanticOverview = vi.fn(async (projectId: string) => ({
      project_id: projectId,
      artifact_id: "art_test",
      counts: { documents: 18, knowledge: 10, rules: 2, changes: 3, architecture: 1, agent_instructions: 2, edges: 8 }
    }));
    const api = {
      listProjects: vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []),
      getProjectSemanticOverview
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);

    expect(await screen.findByRole("heading", { name: "项目 01" })).toBeInTheDocument();
    await waitFor(() => expect(getProjectSemanticOverview).toHaveBeenCalledTimes(PROJECT_LIST_PAGE_SIZE));
    expect(getProjectSemanticOverview).not.toHaveBeenCalledWith("prj_11");
    expect(screen.getAllByText("10 条知识").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /下一页|Next/i }));
    await waitFor(() => expect(getProjectSemanticOverview).toHaveBeenCalledTimes(items.length));
    expect(await screen.findByRole("heading", { name: "项目 11" })).toBeInTheDocument();
  });

  it("shows newest projects first with second-precision timestamps and pages at 6", async () => {
    const items = Array.from({ length: PROJECT_LIST_PAGE_SIZE + 3 }, (_, index) => {
      const n = index + 1;
      return project({
        project_id: `prj_${String(n).padStart(2, "0")}`,
        display_name: `Project ${String(n).padStart(2, "0")}`,
        updated_at: `2026-07-${String(Math.min(17, n)).padStart(2, "0")}T${String(n % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:${String((n * 3) % 60).padStart(2, "0")}Z`
      });
    });
    // Make Project 01 the newest explicitly.
    items[0] = project({
      project_id: "prj_01",
      display_name: "Project 01",
      updated_at: "2026-07-17T23:59:59Z"
    });
    items[1] = project({
      project_id: "prj_02",
      display_name: "Project 02",
      updated_at: "2026-07-17T22:00:00Z"
    });

    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []);
    const api = {
      listProjects,
      listWorkflowFamilies: vi.fn(async () => []),
      getProjectWorkflowBinding: vi.fn(async () => null)
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);

    expect(await screen.findByRole("heading", { name: "Project 01" })).toBeInTheDocument();
    const cards = screen.getAllByRole("article").filter((node) => node.classList.contains("project-list-card"));
    expect(cards).toHaveLength(PROJECT_LIST_PAGE_SIZE);
    const firstCard = cards[0];
    expect(firstCard).toBeTruthy();
    if (firstCard === undefined) throw new Error("expected first project card");
    expect(within(firstCard).getByRole("heading", { name: "Project 01" })).toBeInTheDocument();
    // Local timezone may shift the hour; seconds must still render.
    expect(within(firstCard).getByText(/:59\b/)).toBeInTheDocument();
    expect(screen.getAllByText(/第 1\s*\/\s*2 页|Page 1\s*\/\s*2/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /下一页|Next/i }));
    const pageTwo = screen.getAllByRole("article").filter((node) => node.classList.contains("project-list-card"));
    expect(pageTwo).toHaveLength(3);
    expect(screen.getAllByText(/第 2\s*\/\s*2 页|Page 2\s*\/\s*2/i).length).toBeGreaterThan(0);
  });

  it("hides the pager on a single page and shows readable version states", async () => {
    const items = [
      project({ project_id: "a", display_name: "Alpha", latest_project_version: "v2.4.1", updated_at: "2026-07-17T12:00:00Z" }),
      project({ project_id: "b", display_name: "Beta", latest_project_version: null, updated_at: "2026-07-16T12:00:00Z" })
    ];
    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []);
    const api = {
      listProjects,
      listWorkflowFamilies: vi.fn(async () => []),
      getProjectWorkflowBinding: vi.fn(async () => null)
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);
    expect(await screen.findByText(/已有远端版本|Remote version available/i)).toBeInTheDocument();
    expect(screen.queryByText("v2.4.1")).toBeNull();
    expect(screen.getByText(/等待首次同步|Awaiting first sync/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下一页|Next/i })).toBeNull();
    expect(document.querySelector(".project-registry-toolbar > span")?.textContent).toMatch(/2/);
  });

  it("filters by project name and closes the confirm dialog with Escape", async () => {
    const items = [
      project({ project_id: "agent-harness", display_name: "Agent Harness", updated_at: "2026-07-17T12:00:00Z" }),
      project({ project_id: "skill-registry", display_name: "Skill Registry", updated_at: "2026-07-16T12:00:00Z" })
    ];
    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []);
    const api = {
      listProjects,
      listWorkflowFamilies: vi.fn(async () => []),
      getProjectWorkflowBinding: vi.fn(async () => null)
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);
    expect(await screen.findByRole("heading", { name: "Agent Harness" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /搜索项目|Search projects/i }), {
      target: { value: "Skill Registry" }
    });
    expect(screen.getByRole("heading", { name: "Skill Registry" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agent Harness" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: /搜索项目|Search projects/i }), {
      target: { value: "" }
    });
    const archiveButtons = screen.getAllByRole("button", { name: /移到回收站|Move to recycle bin/i });
    const firstArchive = archiveButtons[0];
    expect(firstArchive).toBeTruthy();
    if (firstArchive === undefined) throw new Error("expected archive button");
    fireEvent.click(firstArchive);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    const metrics = document.querySelectorAll(".project-registry-metrics > article");
    expect(metrics).toHaveLength(3);
  });
});
