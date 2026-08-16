import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryRunStore } from "../src/runs/memory-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("run monitoring (P4)", () => {
  let repository: MemoryRepository;
  let runStore: MemoryRunStore;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    runStore = new MemoryRunStore();
    await repository.createActorWithToken({ actorId: "actor_owner", token: "api-token" });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      runStore
    });
    const resolved = await repository.resolveProject({
      actorId: "actor_owner",
      localProjectKey: uuidV7(),
      displayName: "Run Project",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  it("ingests event batches idempotently and serves run snapshots", async () => {
    const batch = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: {
        protocol_version: "hunter-progress-sync/v1",
        run_id: "run_demo",
        change_key: "auth-change",
        events: [
          {
            event_id: "evt_1",
            producer_seq: 1,
            event_type: "phase.start",
            phase: "plan",
            occurred_at: "2026-08-06T10:00:00Z",
            payload: {
              schema_version: 3,
              timestamp: "2026-08-06T10:00:00Z",
              type: "phase.start",
              phase: "plan",
              summary: "开始梳理登录流程。",
              raw_output: "must not be stored"
            }
          },
          {
            event_id: "evt_2",
            producer_seq: 2,
            event_type: "phase.end",
            phase: "plan",
            occurred_at: "2026-08-06T10:01:00Z",
            payload: { type: "phase.end", phase: "plan", status: "OK" }
          }
        ]
      }
    });
    expect(batch.statusCode).toBe(200);
    const body = batch.json() as {
      items: Array<{ status: string }>;
      run: { run_status: string; current_phase: string; sync_completeness: string };
    };
    expect(body.items.every((item) => item.status === "accepted")).toBe(true);
    expect(body.run.current_phase).toBe("plan");
    expect(body.run.sync_completeness).toBe("complete");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: {
        protocol_version: "hunter-progress-sync/v1",
        run_id: "run_demo",
        change_key: "auth-change",
        events: [
          {
            event_id: "evt_1",
            producer_seq: 1,
            event_type: "phase.start",
            phase: "plan",
            occurred_at: "2026-08-06T10:00:00Z",
            payload: { type: "phase.start", phase: "plan" }
          }
        ]
      }
    });
    expect((again.json() as { items: Array<{ status: string }> }).items[0]?.status)
      .toBe("duplicate_accepted");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/runs`,
      headers: { authorization: "Bearer api-token" }
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json() as {
      items: Array<{ phases?: Array<{ id: string; duration_ms: number | null }> }>;
      total: number;
      next_cursor: string | null;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.phases?.some((phase) => phase.id === "plan")).toBe(true);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/runs/run_demo/events`,
      headers: { authorization: "Bearer api-token" }
    });
    const eventItems = (events.json() as {
      items: Array<{ payload: Record<string, unknown> }>;
    }).items;
    expect(eventItems).toHaveLength(2);
    expect(eventItems[0]?.payload).toMatchObject({
      schema_version: 3,
      timestamp: "2026-08-06T10:00:00Z",
      summary: "开始梳理登录流程。"
    });
    expect(eventItems[0]?.payload).not.toHaveProperty("raw_output");
  });

  it("marks an event-only client offline from the server-observed update time", async () => {
    const batch = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: {
        protocol_version: "hunter-progress-sync/v1",
        run_id: "run_event_only",
        change_key: "event-only",
        events: [{
          event_id: "evt_only",
          producer_seq: 1,
          event_type: "decision",
          occurred_at: "2020-01-01T00:00:00Z",
          payload: { type: "decision" }
        }]
      }
    });
    expect(batch.statusCode).toBe(200);
    const run = (batch.json() as {
      run: { connection_status: string; updated_at: string; last_heartbeat_at: null };
    }).run;
    expect(run.connection_status).toBe("online");
    expect(run.last_heartbeat_at).toBeNull();

    vi.spyOn(Date, "now").mockReturnValue(Date.parse(run.updated_at) + 121_000);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/runs`,
      headers: { authorization: "Bearer api-token" }
    });
    expect(list.json().items[0].connection_status).toBe("offline");
  });

  it("records heartbeats for connection status", async () => {
    const heartbeatAt = "2026-08-06T11:00:00Z";
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(heartbeatAt));
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/heartbeats`,
      headers: { authorization: "Bearer api-token" },
      payload: {
        protocol_version: "hunter-progress-sync/v1",
        run_id: "run_hb",
        change_key: "hb-change",
        client_time: "2099-01-01T00:00:00Z"
      }
    });
    expect(response.statusCode).toBe(200);
    const run = (response.json() as { run: { connection_status: string; last_heartbeat_at: string } }).run;
    expect(run.connection_status).toBe("online");
    expect(run.last_heartbeat_at).toBe(new Date(heartbeatAt).toISOString());

    now.mockReturnValue(Date.parse(heartbeatAt) + 50_000);
    const delayed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/runs`,
      headers: { authorization: "Bearer api-token" }
    });
    expect(delayed.json().items[0].connection_status).toBe("delayed");

    now.mockReturnValue(Date.parse(heartbeatAt) + 121_000);
    const offline = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/runs`,
      headers: { authorization: "Bearer api-token" }
    });
    expect(offline.json().items[0].connection_status).toBe("offline");
  });

  it("promotes a fallback change key to a display title without later downgrade", async () => {
    const heartbeat = (title: string) => app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/heartbeats`,
      headers: { authorization: "Bearer api-token" },
      payload: {
        protocol_version: "hunter-progress-sync/v1",
        run_id: "run_title",
        change_key: "pomodoro-timer",
        client_time: "2026-08-09T00:00:00Z",
        title
      }
    });

    expect((await heartbeat("pomodoro-timer")).json().run.title).toBe("pomodoro-timer");
    expect((await heartbeat("番茄钟计时器")).json().run.title).toBe("番茄钟计时器");
    expect((await heartbeat("pomodoro-timer")).json().run.title).toBe("番茄钟计时器");
  });

  it("persists canonical change identity and rejects run-id drift", async () => {
    const canonical = {
      protocol_version: "hunter-progress-sync/v1",
      run_id: "run_stage12_http",
      change_key: "stage12_http",
      lifecycle_kind: "change",
      branch_name: "feature/stage12-http",
      source_version: "plan-event-bundle/v1",
      events: [{
        event_id: `plan_event:${"a".repeat(64)}`,
        producer_seq: 1,
        event_type: "phase_started",
        phase: "plan",
        attempt: 1,
        occurred_at: "2026-08-13T10:00:00Z",
        idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        summary_zh: "规划阶段已开始",
        payload: {}
      }]
    };
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: canonical
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().run).toMatchObject({
      lifecycle_kind: "change",
      branch_name: "feature/stage12-http",
      source_version: "plan-event-bundle/v1"
    });
    for (const payload of [
      { ...canonical, run_id: "run_branch_too_long", change_key: "branch_too_long",
        branch_name: "b".repeat(513) },
      { ...canonical, run_id: "run_summary_too_long", change_key: "summary_too_long",
        events: [{ ...canonical.events[0], event_id: `plan_event:${"b".repeat(64)}`,
          summary_zh: "摘".repeat(2049) }] },
      { ...canonical, run_id: "run_ref_too_long", change_key: "ref_too_long",
        events: [{ ...canonical.events[0], event_id: `plan_event:${"c".repeat(64)}`,
          detail_ref: "r".repeat(513) }] }
    ]) {
      const rejected = await app.inject({ method: "POST",
        url: `/api/v1/projects/${projectId}/runs/events:batch`,
        headers: { authorization: "Bearer api-token" }, payload });
      expect(rejected.statusCode).toBe(400);
    }

    const drift = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: { ...canonical, branch_name: "feature/hostile-drift", events: [] }
    });
    expect(drift.statusCode).toBe(409);
    expect(await runStore.getRun(projectId, "run_stage12_http")).toMatchObject({
      branchName: "feature/stage12-http"
    });
  });

  it("derives Stage 12 terminal status from machine event types", async () => {
    const base = {
      protocol_version: "hunter-progress-sync/v1",
      run_id: "run_stage12_terminal",
      change_key: "stage12_terminal",
      lifecycle_kind: "change",
      branch_name: "feature/stage12-terminal",
      source_version: "plan-event-bundle/v1"
    };
    let identity = 0;
    const event = (_event_id: string, producer_seq: number, event_type: string) => ({
      event_id: `plan_event:${(++identity).toString(16).padStart(64, "0")}`,
      producer_seq, event_type, phase: "plan", attempt: 1,
      occurred_at: `2026-08-13T10:00:0${producer_seq}Z`,
      idempotency_key: `sha256:${producer_seq.toString(16).padStart(64, "0")}`,
      payload: {}
    });
    const success = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: { ...base, events: [event("plan_event:start_terminal", 1, "phase_started"),
        event("plan_event:end_terminal", 2, "phase_ended")] } });
    expect(success.json().run).toMatchObject({ run_status: "succeeded", current_phase: "plan" });

    const retryFailed = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/runs/events:batch`,
      headers: { authorization: "Bearer api-token" },
      payload: { ...base, run_id: "run_stage12_failed", change_key: "stage12_failed",
        events: [event("plan_event:start_failed", 1, "phase_started"),
          event("plan_event:validation_failed", 2, "validation_failed"),
          event("plan_event:end_failed", 3, "phase_ended")] } });
    expect(retryFailed.json().run).toMatchObject({
      run_status: "failed", ended_at: "2026-08-13T10:00:03Z"
    });
  });
});
