import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../src/repositories/migrate.js";
import { PgRunStore } from "../src/runs/pg-store.js";
import { createBranchMonitorCursorPort } from "../src/runs/branch-monitor-cursor.js";
import { createRunStoreBranchMonitorSource } from "../src/runs/branch-monitor-source.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;

postgresDescribe("PgRunStore Stage 12 integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const projectId = "prj_run_stage12_pg";

  beforeAll(async () => {
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    await pool.query("TRUNCATE TABLE run_events, runs, projects, actors CASCADE");
    await pool.query("INSERT INTO actors(actor_id, display_name) VALUES ('actor_run_stage12_pg', 'Stage 12')");
    await pool.query(
      "INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1, 'actor_run_stage12_pg', 'Stage 12')",
      [projectId]
    );
  });

  afterAll(async () => { await pool.end(); });

  it("persists canonical change identity and plan events across adapter instances", async () => {
    const identity = {
      runId: "run_stage12_pg", projectId, changeKey: "change_stage12_pg",
      lifecycleKind: "change" as const, branchName: "feature/stage12-pg",
      sourceVersion: "plan-event-bundle/v1"
    };
    await new PgRunStore(pool).ensureRun(identity);
    await new PgRunStore(pool).ingestBatch({
      projectId, runId: identity.runId, events: [{
        eventId: "plan_event:stage12_pg", producerSeq: 1, eventType: "phase_started",
        phase: "plan", occurredAt: "2026-08-13T10:00:00Z", payload: {},
        planEvent: {
          schema_version: 1, event_id: "plan_event:stage12_pg", lifecycle_kind: "change",
          run_id: identity.runId, change_key: identity.changeKey, phase: "plan", attempt: 1,
          type: "phase_started", producer_seq: 1, occurred_at: "2026-08-13T10:00:00Z",
          idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }]
    });
    await expect(new PgRunStore(pool).getRun(projectId, identity.runId)).resolves.toMatchObject({
      lifecycleKind: "change", branchName: "feature/stage12-pg", sourceVersion: "plan-event-bundle/v1"
    });
    const events = await new PgRunStore(pool).listEvents(identity.runId);
    expect(events[0]?.planEvent).toMatchObject({ type: "phase_started", lifecycle_kind: "change" });
    await expect(new PgRunStore(pool).ensureRun({ ...identity, branchName: "feature/drift" }))
      .rejects.toThrow("RUN_IDENTITY_CONFLICT");

    const alpha = { ...identity, runId: "run_alpha_pg", changeKey: "change_alpha_pg" };
    const none = { ...identity, runId: "run_none_pg", changeKey: "change_none_pg" };
    await new PgRunStore(pool).ensureRun(alpha); await new PgRunStore(pool).ensureRun(none);
    await new PgRunStore(pool).ingestBatch({ projectId, runId: alpha.runId, events: [{
      eventId: "plan_event:alpha_pg", producerSeq: 1, eventType: "phase_started",
      phase: "plan", occurredAt: "2026-08-13T10:00:00Z", payload: {},
      planEvent: { schema_version: 1, event_id: "plan_event:alpha_pg", lifecycle_kind: "change",
        run_id: alpha.runId, change_key: alpha.changeKey, phase: "plan", attempt: 1,
        type: "phase_started", producer_seq: 1, occurred_at: "2026-08-13T10:00:00Z",
        idempotency_key: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    }] });
    const ordered = await new PgRunStore(pool).listRuns(projectId, { lifecycleKind: "change", limit: 10 });
    expect(ordered.items.map((run) => run.runId)).toEqual([
      "run_alpha_pg", "run_stage12_pg", "run_none_pg"
    ]);
  });

  it("keeps pre-migration-shaped rows explicitly unmarked and filters them from change pages", async () => {
    await pool.query(
      `INSERT INTO runs(run_id, project_id, change_key, title)
       VALUES ('run_legacy_pg', $1, 'legacy-sync', 'Legacy')`,
      [projectId]
    );
    const store = new PgRunStore(pool);
    await expect(store.getRun(projectId, "run_legacy_pg")).resolves.toMatchObject({
      lifecycleKind: "legacy_unmarked", branchName: null, sourceVersion: null
    });
    const listed = await store.listRuns(projectId, { lifecycleKind: "change", limit: 25 });
    expect(listed.items.map((run) => run.runId)).toEqual([
      "run_alpha_pg", "run_stage12_pg", "run_none_pg"
    ]);
  });

  it("rebuilds PostgreSQL run aggregates in canonical producer order after out-of-order delivery", async () => {
    const store = new PgRunStore(pool);
    const identity = {
      runId: "run_out_of_order_pg", projectId, changeKey: "change_out_of_order_pg",
      lifecycleKind: "change" as const, branchName: "feature/out-of-order-pg",
      sourceVersion: "plan-event-bundle/v1"
    };
    await store.ensureRun(identity);
    await store.ingestBatch({ projectId, runId: identity.runId, events: [{
      eventId: "plan_event:ended_pg", producerSeq: 2, eventType: "phase_ended", phase: "plan",
      occurredAt: "2026-08-13T12:00:02Z", payload: {}, planEvent: {
        schema_version: 1, event_id: "plan_event:ended_pg", lifecycle_kind: "change",
        run_id: identity.runId, change_key: identity.changeKey, phase: "plan", attempt: 1,
        type: "phase_ended", producer_seq: 2, occurred_at: "2026-08-13T12:00:02Z",
        idempotency_key: `sha256:${"e".repeat(64)}` }
    }] });
    await store.ingestBatch({ projectId, runId: identity.runId, events: [{
      eventId: "plan_event:started_pg", producerSeq: 1, eventType: "phase_started", phase: "plan",
      occurredAt: "2026-08-13T12:00:01Z", payload: {}, planEvent: {
        schema_version: 1, event_id: "plan_event:started_pg", lifecycle_kind: "change",
        run_id: identity.runId, change_key: identity.changeKey, phase: "plan", attempt: 1,
        type: "phase_started", producer_seq: 1, occurred_at: "2026-08-13T12:00:01Z",
        idempotency_key: `sha256:${"d".repeat(64)}` }
    }] });
    await expect(store.getRun(projectId, identity.runId)).resolves.toMatchObject({
      runStatus: "running", startedAt: "2026-08-13T12:00:01.000Z",
      lastEventAt: "2026-08-13T12:00:02.000Z", endedAt: null,
      currentPhase: "plan"
    });
    const next = await store.ingestBatch({ projectId, runId: identity.runId, events: [{
      eventId: "plan_event:run_started_pg", producerSeq: 1, eventType: "phase_started", phase: "run",
      occurredAt: "2026-08-13T12:00:03Z", payload: {}, planEvent: {
        schema_version: 1, event_id: "plan_event:run_started_pg", lifecycle_kind: "change",
        run_id: identity.runId, change_key: identity.changeKey, phase: "run", attempt: 1,
        type: "phase_started", producer_seq: 1, occurred_at: "2026-08-13T12:00:03Z",
        idempotency_key: `sha256:${"c".repeat(64)}` }
    }] });
    expect(next.items[0]).toMatchObject({ status: "accepted" });
    expect(next.run).toMatchObject({ runStatus: "running", currentPhase: "run", syncCompleteness: "complete" });
  });

  it("detects a 4097th PostgreSQL event instead of silently truncating the bundle", async () => {
    const identity = {
      runId: "run_overflow_pg", projectId, changeKey: "change_overflow_pg",
      lifecycleKind: "change" as const, branchName: "feature/overflow-pg",
      sourceVersion: "plan-event-bundle/v1"
    };
    await new PgRunStore(pool).ensureRun(identity);
    await pool.query(
      `INSERT INTO run_events(project_id, run_id, event_id, producer_seq, event_type,
         phase, occurred_at, payload, plan_event)
       SELECT $1::text, $2::text, 'plan_event:overflow_' || seq, seq, 'phase_started', 'plan',
         '2026-08-13T11:00:00Z'::timestamptz + (seq * interval '1 millisecond'), '{}'::jsonb,
         jsonb_build_object(
           'schema_version', 1, 'event_id', 'plan_event:overflow_' || seq,
           'lifecycle_kind', 'change', 'run_id', $2::text, 'change_key', $3::text,
           'phase', 'plan', 'attempt', 1, 'type', 'phase_started', 'producer_seq', seq,
           'occurred_at', to_char('2026-08-13T11:00:00Z'::timestamptz +
             (seq * interval '1 millisecond'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'idempotency_key', 'sha256:' || lpad(to_hex(seq), 64, '0')
         )
       FROM generate_series(1, 4097) AS seq`,
      [projectId, identity.runId, identity.changeKey]
    );
    const source = createRunStoreBranchMonitorSource(
      new PgRunStore(pool),
      createBranchMonitorCursorPort("stage12-pg-overflow-secret-at-least-32-bytes")
    );
    await expect(source.getDetail({
      actor_id: "actor_run_stage12_pg", project_id: projectId,
      accessible_project_ids: [projectId], content_types: ["run_event"],
      sort: "last_event_at_desc_run_id_asc", request_cursor: null,
      detail_id: identity.runId
    })).rejects.toThrow("BRANCH_MONITOR_EVENT_LIMIT_EXCEEDED");
  });
});
