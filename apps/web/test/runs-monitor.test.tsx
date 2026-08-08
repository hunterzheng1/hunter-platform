// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunsMonitor } from "../components/runs-monitor";
import type { HunterApi, RunSummary } from "../lib/api";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

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

  it("discovers the first run without a manual refresh", async () => {
    vi.useFakeTimers();
    const first = run("run_first", "First live run", "2026-08-08T02:00:00.000Z");
    const listProjectRuns = vi.fn()
      .mockResolvedValueOnce({ items: [], total: 0, next_cursor: null })
      .mockResolvedValue({ items: [first], total: 1, next_cursor: null });
    const api = {
      listProjectRuns,
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("尚无上报的运行记录。")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByRole("heading", { name: "First live run" })).toBeInTheDocument();
    expect(listProjectRuns).toHaveBeenCalledTimes(2);
  });

  it("falls back to REST polling after an established SSE stream fails", async () => {
    vi.useFakeTimers();
    const active = run("run_active", "Active run", "2026-08-08T02:00:00.000Z");
    let onError: (() => void) | undefined;
    const listProjectRunEvents = vi.fn(async () => ({ items: [], next_cursor: 0 }));
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [active], total: 1, next_cursor: null })),
      listProjectRunEvents,
      streamProjectRunEvents: vi.fn(async (_projectId, _runId, _cursor, handlers) => {
        onError = handlers.onError;
        return { abort: vi.fn() };
      })
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onError).toBeDefined();

    act(() => onError?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(listProjectRunEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("轮询更新")).toBeInTheDocument();
  });
});
