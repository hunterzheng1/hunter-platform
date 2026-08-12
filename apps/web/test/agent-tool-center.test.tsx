// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTool } from "@hunter-harness/contracts";
import { AgentToolCenter } from "../components/agent-tool-center";
import { ToastProvider } from "../components/ui/Toast";
import type { HunterApi } from "../lib/api";

afterEach(cleanup);

const piTool: AgentTool = {
  tool_id: "atl_pi",
  slug: "pi-coding-agent",
  displayName: "Pi Coding Agent",
  description: "A coding agent package inside the Pi monorepo.",
  category: "runtime",
  status: "active",
  source: {
    type: "github",
    ref: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent"
  },
  homepage: "https://github.com/earendil-works/pi",
  packageName: "@mariozechner/pi-coding-agent",
  installCommand: "npm install @mariozechner/pi-coding-agent",
  tags: ["coding-agent", "pi"],
  relatedWorkflowFamilies: [],
  revision: 1,
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z"
};

describe("Agent Tool Center", () => {
  it("renders exact source subpaths and filters the dense card registry", async () => {
    const api = {
      listAgentTools: vi.fn(async () => [
        piTool,
        {
          ...piTool,
          tool_id: "atl_orca",
          slug: "orca",
          displayName: "Orca",
          category: "ade",
          source: { type: "github", ref: "https://github.com/stablyai/orca" }
        }
      ])
    } as unknown as HunterApi;
    render(<ToastProvider><AgentToolCenter api={api} /></ToastProvider>);

    expect(await screen.findByRole("heading", { name: "Pi Coding Agent" })).toBeInTheDocument();
    expect(screen.getByText(piTool.source.ref)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="agent-tool-grid"]')).toHaveAttribute("data-layout", "dense-cards");

    fireEvent.change(screen.getByRole("textbox", { name: /搜索 Agent 工具|Search Agent Tools/i }), {
      target: { value: "orca" }
    });
    expect(screen.getByRole("heading", { name: "Orca" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pi Coding Agent" })).toBeNull();
  });

  it("registers a tool with source, taxonomy, tags and related workflow families", async () => {
    const createAgentTool = vi.fn(async () => piTool);
    const listAgentTools = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([piTool]);
    const api = { listAgentTools, createAgentTool } as unknown as HunterApi;
    render(<ToastProvider><AgentToolCenter api={api} /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /登记工具|Register tool/i }));
    fireEvent.change(screen.getByLabelText(/显示名称|Display name/i), { target: { value: "Pi Coding Agent" } });
    fireEvent.change(screen.getByLabelText(/标识|Slug/i), { target: { value: "pi-coding-agent" } });
    fireEvent.change(screen.getByLabelText(/描述|Description/i), { target: { value: piTool.description } });
    fireEvent.change(screen.getByLabelText(/来源地址|来源标识|Source reference/i), { target: { value: piTool.source.ref } });
    fireEvent.change(screen.getByLabelText(/分类|Category/i), { target: { value: "runtime" } });
    fireEvent.change(screen.getByLabelText(/标签|Tags/i), { target: { value: "coding-agent, pi" } });
    fireEvent.change(screen.getByLabelText(/关联工作流|Related workflows/i), { target: { value: "harness, review-loop" } });
    fireEvent.click(screen.getByRole("button", { name: /保存登记|Save registration/i }));

    await waitFor(() => expect(createAgentTool).toHaveBeenCalledWith(expect.objectContaining({
      slug: "pi-coding-agent",
      category: "runtime",
      source: { type: "github", ref: piTool.source.ref },
      tags: ["coding-agent", "pi"],
      relatedWorkflowFamilies: ["harness", "review-loop"]
    })));
    await waitFor(() => expect(listAgentTools).toHaveBeenCalledTimes(2));
  });

  it("keeps the created tool visible when the background refresh fails", async () => {
    const api = {
      listAgentTools: vi.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("refresh failed")),
      createAgentTool: vi.fn(async () => piTool)
    } as unknown as HunterApi;
    render(<ToastProvider><AgentToolCenter api={api} /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /登记工具|Register tool/i }));
    fireEvent.change(screen.getByLabelText(/显示名称|Display name/i), { target: { value: piTool.displayName } });
    fireEvent.change(screen.getByLabelText(/标识|Slug/i), { target: { value: piTool.slug } });
    fireEvent.change(screen.getByLabelText(/描述|Description/i), { target: { value: piTool.description } });
    fireEvent.change(screen.getByLabelText(/来源地址|来源标识|Source reference/i), { target: { value: piTool.source.ref } });
    fireEvent.click(screen.getByRole("button", { name: /保存登记|Save registration/i }));

    expect(await screen.findByRole("heading", { name: piTool.displayName })).toBeInTheDocument();
    await waitFor(() => expect(api.listAgentTools).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: piTool.displayName })).toBeInTheDocument();
  });
});
