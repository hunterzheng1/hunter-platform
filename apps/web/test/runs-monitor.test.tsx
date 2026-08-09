// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RunsMonitor } from "../components/runs-monitor";
import type { HunterApi, RunEventSummary, RunSummary } from "../lib/api";

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
  it("shows an ended warning phase as completed with a separate attention marker", async () => {
    const completedWithWarning: RunSummary = {
      ...run("run_warning_handoff", "正常阶段移交", "2026-08-09T14:00:00.000Z"),
      current_phase: "run",
      waiting_for_phase: "test",
      planned_phases: ["plan", "run", "test"],
      phases: [{
        id: "run",
        started_at: "2026-08-09T14:00:00.000Z",
        ended_at: "2026-08-09T14:04:30.000Z",
        duration_ms: 270_000,
        total_duration_ms: 270_000,
        attempt_count: 1,
        active_attempt: null,
        latest_status: "WARN",
        validity: "current",
        attempts: [{
          attempt: 1,
          run_id: "run_warning_handoff",
          trigger: null,
          from_phase: "plan",
          started_at: "2026-08-09T14:00:00.000Z",
          ended_at: "2026-08-09T14:04:30.000Z",
          status: "WARN",
          duration_ms: 270_000
        }],
        preparation_attempt_count: 0,
        active_preparation: null,
        blocked_preparation_count: 0,
        latest_preparation: null,
        preparations: []
      }]
    };
    const api = {
      listProjectRuns: vi.fn(async () => ({
        items: [completedWithWarning], total: 1, next_cursor: null
      })),
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    const phase = await waitFor(() => {
      const node = document.querySelector('.phase-step[data-phase="run"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(phase).toHaveAttribute("data-state", "done");
    expect(phase).toHaveAttribute("data-attention", "warning");
    expect(within(phase).getByText("需要注意")).toBeInTheDocument();
  });

  it("colors a connector green only when its preceding phase is complete", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/web/app/ui-v4.css"), "utf8");
    expect(css).toMatch(
      /\.phase-step\[data-state="done"\]\s*\+\s*\.phase-step::before[\s\S]*var\(--success\)/
    );
    for (const state of ["done", "active", "stale", "warning", "failed", "preparing"]) {
      expect(css).not.toMatch(new RegExp(`\\.phase-step\\[data-state="${state}"\\]::before`));
    }
  });

  it("shows a blocked fixback preparation without changing completed coding time", async () => {
    const blocked: RunSummary = {
      ...run("run_fixback_blocked", "修复回流测试", "2026-08-08T02:00:00.000Z"),
      current_phase: "run",
      active_phase: null,
      waiting_for_phase: "submit",
      workflow_status: "waiting",
      phases: [{
        id: "run",
        started_at: "2026-08-08T02:00:00.000Z",
        ended_at: "2026-08-08T02:02:00.000Z",
        duration_ms: 120_000,
        total_duration_ms: 120_000,
        attempt_count: 1,
        active_attempt: null,
        latest_status: "OK",
        validity: "current",
        attempts: [{
          attempt: 1,
          run_id: "run_fixback_blocked",
          trigger: null,
          from_phase: null,
          started_at: "2026-08-08T02:00:00.000Z",
          ended_at: "2026-08-08T02:02:00.000Z",
          status: "OK",
          duration_ms: 120_000
        }],
        preparation_attempt_count: 1,
        active_preparation: null,
        blocked_preparation_count: 1,
        latest_preparation: {
          attempt: 2,
          run_id: "run_fixback_blocked",
          trigger: "review-fixback",
          from_phase: "review",
          started_at: "2026-08-08T02:05:00.000Z",
          ended_at: "2026-08-08T02:08:01.000Z",
          status: "BLOCKED",
          duration_ms: 181_000,
          code: "CONTEXT_HANDOFF_REQUIRED",
          message: "阶段交接尚未完成，修复未启动。"
        },
        preparations: []
      }]
    };
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [blocked], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    expect((await screen.findAllByText("修复未启动")).length).toBeGreaterThan(0);
    expect(screen.getByText("已完成 1 次 · 启动受阻 1 次")).toBeInTheDocument();
    expect(screen.getByText("阶段交接尚未完成，修复未启动。")).toBeInTheDocument();
    expect(screen.getByText("2m")).toBeInTheDocument();
  });
  it("shows the Chinese title with the stable change key as a subtitle", async () => {
    const localized = {
      ...run("run_pomodoro", "番茄钟计时器", "2026-08-08T02:00:00.000Z"),
      change_key: "pomodoro-timer"
    };
    const api = {
      listProjectRuns: vi.fn(async () => ({
        items: [localized],
        total: 1,
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
    const item = within(list).getByRole("button");
    expect(within(item).getByText("番茄钟计时器")).toBeInTheDocument();
    expect(within(item).getByText("pomodoro-timer")).toHaveClass("run-subtitle");
    expect(screen.getByRole("heading", { name: "番茄钟计时器" })).toBeInTheDocument();
  });

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

  it("shows timeline events newest first with a readable description", async () => {
    const active = run("run_timeline", "时间线测试", "2026-08-08T02:00:00.000Z");
    const events: RunEventSummary[] = [
      {
        server_cursor: 1,
        run_id: active.run_id,
        event_id: "evt_start",
        producer_seq: 1,
        event_type: "phase.start",
        phase: "plan",
        occurred_at: "2026-08-08T02:00:00.000Z",
        payload: {}
      },
      {
        server_cursor: 2,
        run_id: active.run_id,
        event_id: "evt_decision",
        producer_seq: 2,
        event_type: "decision",
        phase: "plan",
        occurred_at: "2026-08-08T02:01:00.000Z",
        payload: { summary: "采用本地缓存，减少重复请求。" }
      }
    ];
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [active], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: events, next_cursor: 2 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    await screen.findByText("采用本地缓存，减少重复请求。");
    const timeline = document.querySelector(".timeline");
    expect(timeline).not.toBeNull();
    const items = within(timeline as HTMLElement).getAllByRole("listitem");
    const firstItem = items[0];
    expect(firstItem).toBeDefined();
    if (firstItem === undefined) throw new Error("timeline first item is missing");
    expect(firstItem).toHaveTextContent("记录决策");
    expect(firstItem).toHaveTextContent("采用本地缓存，减少重复请求。");
    expect(firstItem.querySelector(".timeline-phase-badge.phase-plan")).toHaveTextContent("计划");
    expect(items[1]).toHaveTextContent("阶段开始");
    expect(items[1]).toHaveTextContent("开始执行计划阶段。");
  });

  it("translates review execution reason codes and keeps the raw code in technical details", async () => {
    const active = run("run_review_mode", "评审方式", "2026-08-08T02:00:00.000Z");
    const events: RunEventSummary[] = [{
      server_cursor: 1,
      run_id: active.run_id,
      event_id: "evt_review_mode",
      producer_seq: 1,
      event_type: "decision",
      phase: "review",
      occurred_at: "2026-08-08T02:01:00.000Z",
      payload: {
        summary: "REVIEW_INLINE_UNAVAILABLE",
        execution_mode: "inline",
        fallback_reason_code: "REVIEW_INLINE_UNAVAILABLE"
      }
    }];
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [active], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: events, next_cursor: 1 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    expect(await screen.findByText("当前环境没有可用的隔离评审能力，已由主会话完成评审。")).toBeInTheDocument();
    expect(screen.getByText("主会话评审 · 当前环境不支持隔离评审")).toBeInTheDocument();
    expect(document.querySelector(".timeline-summary")).not.toHaveTextContent("REVIEW_INLINE_UNAVAILABLE");
    expect(document.querySelector(".timeline-technical code")).toHaveTextContent("REVIEW_INLINE_UNAVAILABLE");
  });

  it("translates the legacy inline-review code embedded in free text", async () => {
    const active = run("run_legacy_review", "旧版评审记录", "2026-08-08T02:00:00.000Z");
    const events: RunEventSummary[] = [{
      server_cursor: 1,
      run_id: active.run_id,
      event_id: "evt_legacy_review",
      producer_seq: 1,
      event_type: "decision",
      phase: "review",
      occurred_at: "2026-08-08T02:01:00.000Z",
      payload: {
        summary: "REVIEW_INLINE_NO_DELEGATE: 主会话只读审查；项目范围较小。"
      }
    }];
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [active], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: events, next_cursor: 1 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    expect(await screen.findByText("旧版记录未说明为何未委派，已由主会话完成评审。")).toBeInTheDocument();
    expect(document.querySelector(".timeline-summary")).not.toHaveTextContent("REVIEW_INLINE_NO_DELEGATE");
  });

  it("keeps machine hashes out of the readable timeline and behind technical details", async () => {
    const active = run("run_hash", "哈希展示测试", "2026-08-08T02:00:00.000Z");
    const digest = `sha256:${"a".repeat(64)}`;
    const events: RunEventSummary[] = [{
      server_cursor: 1,
      run_id: active.run_id,
      event_id: "evt_hash",
      producer_seq: 1,
      event_type: "decision",
      phase: "plan",
      occurred_at: "2026-08-08T02:01:00.000Z",
      payload: {
        summary: `原生规划协议自检通过；finalize ok artifactsHash=${digest}`,
        decision: `原生规划协议自检通过；finalize ok artifactsHash=${digest}`
      }
    }];
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [active], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: events, next_cursor: 1 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    await waitFor(() => expect(document.querySelector(".timeline-summary")).not.toBeNull());
    const summary = document.querySelector(".timeline-summary");
    expect(summary).not.toHaveTextContent("artifactsHash");
    expect(summary).not.toHaveTextContent(digest);
    expect(screen.getByText("技术详情")).toBeInTheDocument();
    expect(document.querySelector(".timeline-technical code")).toHaveTextContent(digest);
  });

  it("updates the active phase duration every second instead of staying at zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T02:00:05.000Z"));
    const active: RunSummary = {
      ...run("run_clock", "阶段计时测试", "2026-08-08T02:00:00.000Z"),
      current_phase: "run",
      active_phase: "run",
      workflow_status: "running",
      phases: [{
        id: "run",
        started_at: "2026-08-08T02:00:00.000Z",
        ended_at: null,
        duration_ms: null,
        total_duration_ms: 0,
        attempt_count: 1,
        active_attempt: 1,
        latest_status: null,
        validity: "current",
        attempts: [{
          attempt: 1,
          run_id: "run_clock",
          trigger: null,
          from_phase: null,
          started_at: "2026-08-08T02:00:00.000Z",
          ended_at: null,
          status: null,
          duration_ms: null
        }]
      }]
    };
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [active], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("5s")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("7s")).toBeInTheDocument();
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

  it("renders completed phase attempts without pretending the archive is still active", async () => {
    const archived: RunSummary = {
      ...run("run_archive", "归档状态测试", "2026-08-08T02:00:00.000Z"),
      run_status: "partial",
      connection_status: "closed",
      current_phase: "archive",
      active_phase: null,
      waiting_for_phase: null,
      workflow_status: "completed",
      result_status: "warning",
      ended_at: "2026-08-08T02:10:00.000Z",
      phases: [{
        id: "archive",
        started_at: "2026-08-08T02:09:00.000Z",
        ended_at: "2026-08-08T02:10:00.000Z",
        duration_ms: 60_000,
        total_duration_ms: 60_000,
        attempt_count: 3,
        active_attempt: null,
        latest_status: "WARN",
        validity: "current",
        attempts: [
          { attempt: 1, run_id: "run_archive", trigger: null, from_phase: null, started_at: "2026-08-08T02:07:00.000Z", ended_at: "2026-08-08T02:07:10.000Z", status: "FAIL", duration_ms: 10_000 },
          { attempt: 2, run_id: "run_archive", trigger: "retry", from_phase: "archive", started_at: "2026-08-08T02:08:00.000Z", ended_at: "2026-08-08T02:08:10.000Z", status: "FAIL", duration_ms: 10_000 },
          { attempt: 3, run_id: "run_archive", trigger: "retry", from_phase: "archive", started_at: "2026-08-08T02:09:00.000Z", ended_at: "2026-08-08T02:10:00.000Z", status: "WARN", duration_ms: 60_000 }
        ]
      }]
    };
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [archived], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    expect(await screen.findByText("已归档（有警告）")).toBeInTheDocument();
    expect(screen.getByText("归档 ×3")).toBeInTheDocument();
    expect(screen.getByText("已完成 3 次")).toBeInTheDocument();
    expect(document.querySelector('.phase-step[data-state="active"]')).toBeNull();
  });

  it("separates ended-early runs and shows real timing and file categories", async () => {
    const abandoned: RunSummary = {
      ...run("run_abandoned", "已停止的尝试", "2026-08-08T02:00:00.000Z"),
      run_status: "partial",
      connection_status: "closed",
      current_phase: "archive",
      workflow_status: "abandoned",
      result_status: "warning",
      closure_disposition: "abandoned",
      closure_reason: "方向调整，停止当前实现。",
      timing_breakdown: {
        product_verification_ms: 1_300,
        process_evidence_ms: 2_400,
        user_wait_ms: 93_000,
        wall_clock_reported_ms: 96_700
      },
      file_breakdown: { product_files: 3, process_evidence_files: 7 }
    };
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [abandoned], total: 1, next_cursor: null })),
      listProjectRunEvents: vi.fn(async () => ({ items: [], next_cursor: 0 })),
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    expect((await screen.findAllByText("已主动结束")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("提前结束")).toBeInTheDocument();
    expect(screen.getByText("方向调整，停止当前实现。")).toBeInTheDocument();
    expect(screen.getByText("产品验证 1.3 秒")).toBeInTheDocument();
    expect(screen.getByText("流程证据 2.4 秒")).toBeInTheDocument();
    expect(screen.getByText("等待确认 1 分 33 秒")).toBeInTheDocument();
    expect(screen.getByText("产品文件 3 个 · 流程证据文件 7 个")).toBeInTheDocument();
    expect(screen.getByText("0", { selector: ".runs-stat.tone-success strong" })).toBeInTheDocument();
  });

  it("shows a closed plan as waiting and refreshes the selected timeline on demand", async () => {
    const waiting: RunSummary = {
      ...run("run_waiting", "等待编码", "2026-08-08T02:00:00.000Z"),
      connection_status: "idle",
      current_phase: "plan",
      active_phase: null,
      waiting_for_phase: "run",
      workflow_status: "waiting",
      result_status: "pending",
      phases: [{
        id: "plan",
        started_at: "2026-08-08T02:00:00.000Z",
        ended_at: "2026-08-08T02:01:00.000Z",
        duration_ms: 60_000,
        total_duration_ms: 60_000,
        attempt_count: 1,
        active_attempt: null,
        latest_status: "OK",
        validity: "current",
        attempts: [{ attempt: 1, run_id: "run_waiting", trigger: null, from_phase: null, started_at: "2026-08-08T02:00:00.000Z", ended_at: "2026-08-08T02:01:00.000Z", status: "OK", duration_ms: 60_000 }]
      }]
    };
    const listProjectRunEvents = vi.fn(async () => ({ items: [], next_cursor: 0 }));
    const api = {
      listProjectRuns: vi.fn(async () => ({ items: [waiting], total: 1, next_cursor: null })),
      listProjectRunEvents,
      streamProjectRunEvents: vi.fn(async () => ({ abort: vi.fn() }))
    } as unknown as HunterApi;

    render(<RunsMonitor api={api} projectId="prj_one" />);

    expect(await screen.findByText("计划已结束 · 等待编码")).toBeInTheDocument();
    expect(screen.getByText("等待新阶段")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "刷新运行与事件" });
    await act(async () => { refresh.click(); await Promise.resolve(); });
    await waitFor(() => expect(listProjectRunEvents.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
