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
});
