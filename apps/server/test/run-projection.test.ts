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

  it("projects a closed phase as waiting and a warning archive as completed", () => {
    const waitingPhases = aggregateRunPhases([
      event(1, "phase.start", "plan", "2026-08-09T00:00:00.000Z", { attempt: 1 }),
      event(2, "phase.end", "plan", "2026-08-09T00:01:00.000Z", { attempt: 1, status: "OK" })
    ]);
    expect(publicRun(run({ currentPhase: "plan" }), waitingPhases)).toMatchObject({
      active_phase: null,
      waiting_for_phase: "run",
      connection_status: "idle"
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
});
