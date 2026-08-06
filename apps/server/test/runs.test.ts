import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
            payload: { type: "phase.start", phase: "plan" }
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
    expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/runs/run_demo/events`,
      headers: { authorization: "Bearer api-token" }
    });
    expect((events.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it("records heartbeats for connection status", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/runs/heartbeats`,
      headers: { authorization: "Bearer api-token" },
      payload: {
        protocol_version: "hunter-progress-sync/v1",
        run_id: "run_hb",
        change_key: "hb-change",
        client_time: "2026-08-06T11:00:00Z"
      }
    });
    expect(response.statusCode).toBe(200);
    const run = (response.json() as { run: { connection_status: string; last_heartbeat_at: string } }).run;
    expect(run.connection_status).toBe("online");
    expect(run.last_heartbeat_at).toBe("2026-08-06T11:00:00Z");
  });
});
