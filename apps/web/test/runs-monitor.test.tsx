// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunsMonitor } from "../components/runs-monitor";
import type { HunterApi, RunSummary } from "../lib/api";

afterEach(cleanup);

function run(runId: string, title: string, startedAt: string): RunSummary {
  return {
    run_id: runId,
    project_id: "prj_one",
    change_key: runId,
    title,
    run_status: "running",
    connection_status: "online",
    sync_completeness: "partial",
    current_phase: null,
    started_at: startedAt,
    ended_at: null,
    last_event_at: startedAt,
    last_heartbeat_at: startedAt,
    server_cursor: 0
  };
}

describe("RunsMonitor", () => {
  it("keeps newest runs first after loading a paginated response", async () => {
    const older = run("run_older", "Older run", "2026-08-08T01:00:00.000Z");
    const newer = run("run_newer", "Newer run", "2026-08-08T02:00:00.000Z");
    const api = {
      listProjectRuns: vi.fn(async () => ({
        items: [older, newer],
        total: 2,
        next_cursor: null
      })),
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    const list = await waitFor(() => {
      const node = document.querySelector(".runs-list");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    const buttons = within(list).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Newer run");
    expect(screen.getByRole("heading", { name: "Newer run" })).toBeInTheDocument();
  });
});
