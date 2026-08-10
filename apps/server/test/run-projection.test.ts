import { describe, expect, it } from "vitest";

import {
  aggregateRunPhases,
  deriveRunStatus,
  publicRun,
  sanitizeEventPayload,
  type RunEventRecord,
  type RunRecord
} from "../src/runs/store.js";

function event(
  cursor: number,
  eventType: string,
  phase: string,
  occurredAt: string,
  payload: Record<string, unknown> = {}
): RunEventRecord {
  return {
    serverCursor: cursor,
    projectId: "prj_one",
    runId: "run_one",
    eventId: `evt_${cursor}`,
    producerSeq: cursor,
    eventType,
    phase,
    occurredAt,
    payload: { phase, ...payload },
    receivedAt: occurredAt
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run_one",
    projectId: "prj_one",
    changeKey: "demo",
    title: "演示变更",
    runStatus: "running",
    connectionStatus: "online",
    syncCompleteness: "complete",
    currentPhase: "run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: null,
    lastEventAt: "2026-08-09T00:08:00.000Z",
    lastHeartbeatAt: "2026-08-09T00:08:00.000Z",
    serverCursor: 8,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:08:00.000Z",
    ...overrides
  };
}

describe("run monitoring projection", () => {
  it("keeps every phase attempt and marks downstream evidence stale after fixback", () => {
    const phases = aggregateRunPhases([
      event(1, "phase.start", "plan", "2026-08-09T00:00:00.000Z", { attempt: 1 }),
      event(2, "phase.end", "plan", "2026-08-09T00:01:00.000Z", { attempt: 1, status: "OK" }),
      event(3, "phase.start", "run", "2026-08-09T00:02:00.000Z", { attempt: 1 }),
      event(4, "phase.end", "run", "2026-08-09T00:03:00.000Z", { attempt: 1, status: "OK" }),
      event(5, "phase.start", "test", "2026-08-09T00:04:00.000Z", { attempt: 1 }),
      event(6, "phase.end", "test", "2026-08-09T00:05:00.000Z", { attempt: 1, status: "WARN" }),
      event(7, "phase.start", "review", "2026-08-09T00:06:00.000Z", { attempt: 1 }),
      event(8, "phase.end", "review", "2026-08-09T00:07:00.000Z", { attempt: 1, status: "WARN" }),
      event(9, "phase.start", "run", "2026-08-09T00:08:00.000Z", {
        attempt: 2,
        trigger: "fixback",
        from_phase: "review"
      }),
      event(10, "phase.end", "run", "2026-08-09T00:09:30.000Z", {
        attempt: 2,
        status: "OK",
        trigger: "fixback"
      })
    ]);

    const coding = phases.find((phase) => phase.id === "run");
    expect(coding).toMatchObject({
      attempt_count: 2,
      active_attempt: null,
      latest_status: "OK",
      validity: "current",
      total_duration_ms: 150_000
    });
    expect(coding?.attempts).toHaveLength(2);
    expect(coding?.attempts[1]).toMatchObject({
      attempt: 2,
      trigger: "fixback",
      from_phase: "review"
    });
    expect(phases.find((phase) => phase.id === "test")?.validity).toBe("stale");
    expect(phases.find((phase) => phase.id === "review")?.validity).toBe("stale");
  });

  it("keeps a blocked fixback preparation separate from completed coding time", () => {
    const phases = aggregateRunPhases([
      event(1, "phase.start", "run", "2026-08-09T00:00:00.000Z", { attempt: 1 }),
      event(2, "phase.end", "run", "2026-08-09T00:02:00.000Z", {
        attempt: 1,
        status: "OK"
      }),
      event(3, "phase.prepare.start", "run", "2026-08-09T00:05:00.000Z", {
        attempt: 2,
        trigger: "review-fixback",
        from_phase: "review"
      }),
      event(4, "phase.prepare.end", "run", "2026-08-09T00:08:01.000Z", {
        attempt: 2,
        trigger: "review-fixback",
        from_phase: "review",
        status: "BLOCKED",
        code: "CONTEXT_HANDOFF_REQUIRED",
        message: "阶段交接尚未完成，修复未启动。",
        orchestration_active_ms: 181_000
      })
    ]);

    const coding = phases.find((phase) => phase.id === "run");
    expect(coding).toMatchObject({
      attempt_count: 1,
      total_duration_ms: 120_000,
      active_attempt: null,
      preparation_attempt_count: 1,
      active_preparation: null,
      blocked_preparation_count: 1
    });
    expect(coding?.latest_preparation).toMatchObject({
      attempt: 2,
      status: "BLOCKED",
      duration_ms: 181_000,
      code: "CONTEXT_HANDOFF_REQUIRED",
      message: "阶段交接尚未完成，修复未启动。"
    });
  });

  it("projects an active fixback preparation without claiming coding is running", () => {
    const events = [
      event(1, "phase.start", "run", "2026-08-09T00:00:00.000Z", { attempt: 1 }),
      event(2, "phase.end", "run", "2026-08-09T00:02:00.000Z", {
        attempt: 1,
        status: "OK"
      }),
      event(3, "phase.prepare.start", "run", "2026-08-09T00:05:00.000Z", {
        attempt: 2,
        trigger: "review-fixback",
        from_phase: "review"
      })
    ];

    expect(publicRun(run({ lastHeartbeatAt: new Date().toISOString() }), aggregateRunPhases(events), events)).toMatchObject({
      workflow_status: "preparing",
      active_phase: null,
      preparing_phase: "run",
      connection_status: "online"
    });
  });

  it("does not turn a retryable archive attempt into a terminal run failure", () => {
    expect(deriveRunStatus("running", "phase.end", {
      phase: "archive",
      status: "FAIL"
    })).toBe("running");
    expect(deriveRunStatus("running", "phase.end", {
      phase: "archive",
      status: "WARN"
    })).toBe("partial");
    expect(deriveRunStatus("running", "workflow.end", {
      status: "FAIL"
    })).toBe("failed");
  });

  it("collapses legacy pre-publish archive validation into the successful archive", () => {
    const phases = aggregateRunPhases([
      event(1, "phase.start", "archive", "2026-08-09T22:53:55.179Z", {
        attempt: 1,
        note: "finalize operation a-8280e633866e failed before publish"
      }),
      event(2, "phase.end", "archive", "2026-08-09T22:53:55.202Z", {
        attempt: 1,
        status: "FAIL",
        note: "finalize operation a-8280e633866e discarded: report adequacy failed"
      }),
      event(3, "phase.start", "archive", "2026-08-09T22:58:17.805Z", {
        attempt: 2,
        note: "finalize start"
      }),
      event(4, "phase.end", "archive", "2026-08-09T22:58:17.951Z", {
        attempt: 2,
        status: "WARN",
        note: "finalize facts complete"
      })
    ]);

    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      id: "archive",
      attempt_count: 1,
      latest_status: "WARN",
      started_at: "2026-08-09T22:53:55.179Z",
      ended_at: "2026-08-09T22:58:17.951Z",
      duration_ms: 262_772,
      total_duration_ms: 262_772
    });
  });

  it("projects a closed phase as waiting and a warning archive as completed", () => {
    const waitingPhases = aggregateRunPhases([
      event(1, "phase.start", "plan", "2026-08-09T00:00:00.000Z", { attempt: 1 }),
      event(2, "phase.end", "plan", "2026-08-09T00:01:00.000Z", { attempt: 1, status: "OK" })
    ]);
    expect(publicRun(run({ currentPhase: "plan" }), waitingPhases)).toMatchObject({
      active_phase: null,
      waiting_for_phase: null,
      connection_status: "idle"
    });

    const plannedEvents = [
      event(1, "phase.start", "review", "2026-08-09T00:00:00.000Z", {
        attempt: 1,
        planned_phases: ["plan", "run", "review", "archive"]
      }),
      event(2, "phase.end", "review", "2026-08-09T00:01:00.000Z", {
        attempt: 1,
        status: "OK",
        planned_phases: ["plan", "run", "review", "archive"],
        next_phase: "archive"
      })
    ];
    expect(
      publicRun(
        run({ currentPhase: "review" }),
        aggregateRunPhases(plannedEvents),
        plannedEvents
      )
    ).toMatchObject({
      waiting_for_phase: "archive",
      planned_phases: ["plan", "run", "review", "archive"],
      phase_plan_source: "reported"
    });

    const archivePhases = aggregateRunPhases([
      event(1, "phase.start", "archive", "2026-08-09T00:00:00.000Z", { attempt: 3 }),
      event(2, "phase.end", "archive", "2026-08-09T00:01:00.000Z", { attempt: 3, status: "WARN" })
    ]);
    expect(publicRun(run({ runStatus: "partial", currentPhase: "archive" }), archivePhases)).toMatchObject({
      active_phase: null,
      connection_status: "closed",
      workflow_status: "completed",
      result_status: "warning"
    });
  });

  it("auto-seals an earlier phase when later lifecycle events prove the workflow advanced", () => {
    const events = [
      event(1, "phase.start", "run", "2026-08-10T03:26:46.022Z", { attempt: 1 }),
      // The local phase.end(run) and phase.start(test) were lost during a legacy
      // to split-v1 stream switch. Later durable events still prove run ended.
      event(2, "phase.end", "test", "2026-08-10T03:47:20.805Z", {
        attempt: 1,
        status: "WARN"
      }),
      event(3, "phase.start", "review", "2026-08-10T03:48:15.000Z", { attempt: 1 }),
      event(4, "phase.end", "review", "2026-08-10T03:48:53.000Z", {
        attempt: 1,
        status: "OK"
      }),
      event(5, "phase.start", "archive", "2026-08-10T03:57:16.000Z", { attempt: 1 }),
      event(6, "phase.end", "archive", "2026-08-10T03:57:18.073Z", {
        attempt: 1,
        status: "WARN"
      })
    ];
    const phases = aggregateRunPhases(events);
    const coding = phases.find((phase) => phase.id === "run");

    expect(coding).toMatchObject({
      active_attempt: null,
      ended_at: "2026-08-10T03:47:20.805Z",
      duration_ms: 1_234_783,
      latest_status: "AUTO_SEALED",
      reconciled: true
    });
    expect(publicRun(run({
      runStatus: "partial",
      currentPhase: "archive",
      endedAt: "2026-08-10T03:57:18.073Z"
    }), phases, events)).toMatchObject({
      workflow_status: "completed",
      active_phase: null,
      connection_status: "closed",
      sync_completeness: "degraded"
    });
  });

  it("never exposes an active phase after the run reached a terminal status", () => {
    const events = [
      event(1, "phase.start", "run", "2026-08-10T03:26:46.022Z", { attempt: 1 })
    ];
    const projected = publicRun(run({
      runStatus: "partial",
      currentPhase: "archive",
      endedAt: "2026-08-10T03:57:18.073Z"
    }), aggregateRunPhases(events), events);

    expect(projected).toMatchObject({
      workflow_status: "completed",
      active_phase: null,
      connection_status: "closed",
      sync_completeness: "degraded",
      phases: [{
        id: "run",
        active_attempt: null,
        ended_at: "2026-08-10T03:57:18.073Z",
        latest_status: "AUTO_SEALED",
        reconciled: true
      }]
    });
  });

  it("keeps safe review delegation metadata but drops prompts and raw output", () => {
    expect(sanitizeEventPayload({
      executor_tool: "codex",
      executor_agent: "harness-reviewer",
      executor_model: "gpt-5",
      execution_mode: "delegated",
      decision_reason_code: "DELEGATE_FIRST",
      fallback_reason_code: null,
      summary: "已委派独立评审。",
      prompt: "private prompt",
      raw_output: "private output"
    })).toEqual({
      executor_tool: "codex",
      executor_agent: "harness-reviewer",
      executor_model: "gpt-5",
      execution_mode: "delegated",
      decision_reason_code: "DELEGATE_FIRST",
      fallback_reason_code: null,
      summary: "已委派独立评审。"
    });
  });

  it("projects closure outcome, real timing buckets, and product/process file counts", () => {
    const events = [
      event(1, "verification", "test", "2026-08-09T00:01:00.000Z", {
        runner_ms: 1_300,
        orchestration_active_ms: 240,
        wall_clock_ms: 1_740,
        user_wait_ms: 200,
        changed_files: ["src/timer.ts", ".harness/state/changes/demo/evidence/verification-ledger.json"]
      }),
      event(2, "workflow.end", "archive", "2026-08-09T00:02:00.000Z", {
        closure_disposition: "abandoned",
        closure_reason: "方向调整，停止当前实现。",
        orchestration_active_ms: 90,
        path: ".harness/archive/demo/summary.md"
      })
    ];

    expect(publicRun(run({ runStatus: "partial", currentPhase: "archive" }), [], events)).toMatchObject({
      workflow_status: "abandoned",
      result_status: "warning",
      connection_status: "closed",
      closure_disposition: "abandoned",
      closure_reason: "方向调整，停止当前实现。",
      timing_breakdown: {
        product_verification_ms: 1_300,
        process_evidence_ms: 330,
        user_wait_ms: 200,
        wall_clock_reported_ms: 1_740
      },
      file_breakdown: {
        product_files: 1,
        process_evidence_files: 2
      }
    });
  });
});
