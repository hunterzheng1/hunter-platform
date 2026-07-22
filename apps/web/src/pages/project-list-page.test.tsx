// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectIdSchema } from "@hunter/domain";

import { ProjectListPage } from "./project-list-page.js";

describe("ProjectListPage", () => {
  it("creates, lists, and opens a project with clear empty and busy states", async () => {
    const existingProjectId = ProjectIdSchema.parse("prj_task2000001");
    const createdProjectId = ProjectIdSchema.parse("prj_task2000002");
    const api = {
      listProjects: vi.fn(async () => ({ projects: [{ projectId: existingProjectId, name: "既有项目" }] })),
      createProject: vi.fn(async () => ({ projectId: createdProjectId, name: "Hunter 控制台", authorization: "host_session_reissue_required" as const })),
    };
    const onOpen = vi.fn();
    render(<ProjectListPage api={api} onOpen={onOpen} />);

    const existingButton = await screen.findByRole("button", { name: "打开 既有项目" });
    fireEvent.click(existingButton);
    expect(onOpen).toHaveBeenCalledWith(existingProjectId);
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "Hunter 控制台" } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    expect(api.createProject).toHaveBeenCalledWith("Hunter 控制台");
    expect(await screen.findByRole("button", { name: "等待授权 Hunter 控制台" })).toHaveProperty("disabled", true);
    expect((await screen.findByRole("status")).textContent).toContain("可信宿主刷新安全会话");
  });

  it("shows an empty state when no project is authorized", async () => {
    const api = { listProjects: vi.fn(async () => ({ projects: [] })), createProject: vi.fn() };
    render(<ProjectListPage api={api} onOpen={vi.fn()} />);
    expect(await screen.findByText("还没有项目")).not.toBeNull();
  });

  it("announces project loading failures", async () => {
    const api = {
      listProjects: vi.fn(async () => { throw new Error("offline"); }),
      createProject: vi.fn(),
    };
    render(<ProjectListPage api={api} onOpen={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("无法加载项目");
  });
});
