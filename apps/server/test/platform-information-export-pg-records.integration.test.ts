import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  type PlatformInformationExportArtifactReceipt,
} from "@hunter-harness/contracts";

import {
  PgPlatformInformationExportRecordPort,
  type PlatformInformationExportRecord,
} from "../src/platform-information-export/index.js";
import { runMigrations } from "../src/repositories/migrate.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
// Same guard as the other PG integration suites: no test database is a missing
// prerequisite, not a failure. Throwing at import turned that into a red suite.
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function record(input: {
  export_id: string; actor_id?: string; project_id?: string; key?: string;
  limit?: number; content_sha?: string; created_at?: string; expires_at?: string;
}): PlatformInformationExportRecord {
  const actor_id = input.actor_id ?? "actor_m6d";
  const project_id = input.project_id ?? "prj_m6d";
  const content_sha = input.content_sha ?? digest("content");
  const receipt: PlatformInformationExportArtifactReceipt = {
    schema_version: 1, contract_kind: "platform_information_export_artifact_receipt",
    export_id: input.export_id, project_id, view: "project_knowledge",
    range: { query_scope: { actor_id, accessible_project_ids: [project_id],
      content_types: ["knowledge_entry"] }, limit: input.limit ?? 10, source_cursor: null,
      cursor_verification: "server_port_required", sort: "extracted_at_desc_knowledge_id_asc" },
    m4_proof: { pages: [{ request_cursor: null, response_next_cursor: null, result_count: 0 }],
      exported_count: 0, items_sha: digest("items"), completed: true },
    proof_sha: digest("proof"), artifact: { format: "canonical_jsonl_v1",
      media_type: "application/x-ndjson", content_sha, items_sha: digest("items"),
      byte_count: 128, item_count: 0, page_count: 1 },
    download_ref: { export_id: input.export_id, project_id, content_sha }, status: "ready",
    created_at: input.created_at ?? "2026-08-13T00:00:00Z",
    expires_at: input.expires_at ?? "2026-08-15T00:00:00Z",
  };
  const query = { schema_version: 1, contract_kind: "query", view: receipt.view,
    project_id, query_scope: receipt.range.query_scope, limit: receipt.range.limit,
    cursor: receipt.range.source_cursor, cursor_verification: receipt.range.cursor_verification,
    sort: receipt.range.sort };
  return { actor_id, idempotency_key: digest(input.key ?? input.export_id),
    query_hash: digest(canonicalJson(query)), receipt };
}

async function seedProject(projectId = "prj_m6d", actorId = "actor_m6d"): Promise<void> {
  await pool.query("INSERT INTO actors(actor_id, display_name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [actorId]);
  await pool.query(`INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1,$2,$1)
    ON CONFLICT (project_id) DO NOTHING`, [projectId, actorId]);
}

postgresDescribe("PgPlatformInformationExportRecordPort", () => {
  beforeAll(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try { await pool.query("SELECT 1"); break; } catch (error) {
        if (attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE platform_information_export_batch_items, platform_information_export_batches, platform_information_export_cursors, platform_information_exports, projects, actors CASCADE");
    await seedProject();
  });
  afterAll(async () => { await pool.end(); });

  it("publishes one canonical durable record concurrently and reports both conflict kinds", async () => {
    const port = new PgPlatformInformationExportRecordPort(pool);
    const value = record({ export_id: "export_publish", key: "publish" });
    const results = await Promise.all(Array.from({ length: 8 }, () => port.publishReady(structuredClone(value))));
    expect(results.map((result) => result.status).sort()).toEqual([
      "existing", "existing", "existing", "existing", "existing", "existing", "existing", "published",
    ]);
    await expect(port.publishReady(record({ export_id: "export_other_query", key: "publish", limit: 9 })))
      .resolves.toEqual({ status: "conflict", reason_code: "different_query" });
    const changed = structuredClone(value);
    changed.receipt.proof_sha = digest("other-proof");
    await expect(port.publishReady(changed)).resolves.toEqual({
      status: "conflict", reason_code: "different_record",
    });
    const stored = await pool.query(`SELECT receipt_canonical, query_canonical, range_json, m4_proof_json,
      content_sha, items_sha, byte_count::int, item_count::int, page_count::int, status
      FROM platform_information_exports WHERE export_id=$1`, [value.receipt.export_id]);
    expect(stored.rows[0]).toMatchObject({ receipt_canonical: canonicalJson(value.receipt),
      content_sha: value.receipt.artifact.content_sha, items_sha: value.receipt.artifact.items_sha,
      byte_count: 128, item_count: 0, page_count: 1, status: "ready" });
    expect(stored.rows[0]?.query_canonical).toContain('"contract_kind":"query"');
    const ready = await port.findReadyByIdempotency({ actor_id: value.actor_id,
      project_id: value.receipt.project_id, idempotency_key: value.idempotency_key,
      query_hash: value.query_hash, now: "2026-08-14T00:00:00Z" });
    expect(ready).toEqual({ status: "ready", record: value });
    expect(Object.isFrozen(ready)).toBe(true);
    await expect(port.getReadyForDownload({ actor_id: value.actor_id,
      project_id: value.receipt.project_id, export_id: value.receipt.export_id,
      now: "2026-08-14T00:00:00Z" })).resolves.toEqual({ status: "ready", record: value });
  });

  it("uses explicit expiry, nonleaking ACL, project cascade, and all shared live refs", async () => {
    const port = new PgPlatformInformationExportRecordPort(pool);
    const shared = digest("shared");
    const first = record({ export_id: "export_acl", key: "acl", content_sha: shared,
      expires_at: "2026-08-14T02:00:00Z" });
    const live = record({ export_id: "export_live", key: "live", content_sha: shared,
      expires_at: "2026-08-16T02:00:00Z" });
    await port.publishReady(first); await port.publishReady(live);
    await expect(port.findReadyByIdempotency({ actor_id: first.actor_id,
      project_id: first.receipt.project_id, idempotency_key: first.idempotency_key,
      query_hash: first.query_hash, now: "2026-08-14T02:00:00Z" })).resolves.toEqual({ status: "expired" });
    await expect(port.getReadyForDownload({ actor_id: first.actor_id,
      project_id: first.receipt.project_id, export_id: first.receipt.export_id,
      now: "2026-08-14T02:00:00Z" })).resolves.toEqual({ status: "expired" });
    await expect(port.getReadyForDownload({ actor_id: "actor_foreign", project_id: first.receipt.project_id,
      export_id: first.receipt.export_id, now: "2026-08-14T03:00:00Z" }))
      .resolves.toEqual({ status: "not_found" });
    await expect(port.getReadyForDownload({ actor_id: first.actor_id, project_id: "prj_foreign",
      export_id: first.receipt.export_id, now: "2026-08-14T03:00:00Z" }))
      .resolves.toEqual({ status: "not_found" });
    expect(await port.hasLiveReference({ content_hash: shared, now: "2026-08-14T03:00:00Z" })).toBe(true);
    await pool.query("DELETE FROM projects WHERE project_id=$1", [first.receipt.project_id]);
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_exports")).rows[0]?.count).toBe(0);
  });

  it("durably replays, reclaims, and acknowledges leased Unicode pages across adapter instances", async () => {
    // ackExpired evaluates lease expiry against the database clock
    // (clock_timestamp()), so the whole scenario must run on a relative
    // timeline instead of a fixed date that goes stale after that day.
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const ids = [`export_${"界".repeat(153)}`, `export_${"😀".repeat(76)}`];
    for (const [index, export_id] of ids.entries()) await new PgPlatformInformationExportRecordPort(pool)
      .publishReady(record({ export_id, key: `unicode-${index}`, created_at: iso(now - 3 * 3_600_000),
        expires_at: iso(now - 2 * 3_600_000) }));
    const input = { now: iso(now - 3_600_000), limit: 1, worker_id: "worker_1",
      lease_until: iso(now - 30 * 60_000) };
    const [first, overlappingReplay] = await Promise.all([
      new PgPlatformInformationExportRecordPort(pool).claimExpired(input),
      new PgPlatformInformationExportRecordPort(pool).claimExpired(input),
    ]);
    if (first.status !== "claimed") throw new Error("claim missing");
    expect(overlappingReplay).toEqual(first);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await new PgPlatformInformationExportRecordPort(pool).claimExpired(input)).toEqual(first);
    const second = await new PgPlatformInformationExportRecordPort(pool).claimExpired({ ...input,
      cursor: first.next_cursor });
    if (second.status !== "claimed") throw new Error("claim missing");
    expect([...first.refs, ...second.refs].map((ref) => ref.export_id)).toEqual(ids);
    await expect(new PgPlatformInformationExportRecordPort(pool).claimExpired({ ...input,
      cursor: first.next_cursor, now: iso(now - 3_600_000 + 1_000) })).rejects
      .toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    await expect(new PgPlatformInformationExportRecordPort(pool).claimExpired({ ...input,
      cursor: "A".repeat(43) })).rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    const reclaimed = await new PgPlatformInformationExportRecordPort(pool).claimExpired({
      now: iso(now), limit: 10, worker_id: "worker_2",
      lease_until: iso(now + 3_600_000) });
    if (reclaimed.status !== "claimed") throw new Error("reclaim missing");
    await expect(portAck(first.batch_id, "worker_1")).resolves.toEqual({ status: "lease_lost" });
    await expect(portAck(reclaimed.batch_id, "worker_1")).resolves.toEqual({ status: "not_owner" });
    await expect(portAck(reclaimed.batch_id, "worker_2")).resolves.toEqual({ status: "acked" });
    await expect(portAck(reclaimed.batch_id, "worker_2")).resolves.toEqual({ status: "already_acked" });
    expect(await new PgPlatformInformationExportRecordPort(pool).hasLiveReference({
      content_hash: digest("content"), now: "2026-08-13T23:00:00Z",
    })).toBe(false);
  });

  it("fails closed on hostile or unrepresentable input without a partial row", async () => {
    const port = new PgPlatformInformationExportRecordPort(pool);
    const getter = { calls: 0 };
    const accessor = Object.defineProperty({}, "actor_id", { enumerable: true,
      get() { getter.calls += 1; return "actor_m6d"; } });
    const traps = { calls: 0 };
    const proxy = new Proxy({}, { ownKeys() { traps.calls += 1; return []; },
      getPrototypeOf() { traps.calls += 1; return Object.prototype; } });
    for (const hostile of [accessor, proxy, record({ export_id: "export_\uD800", key: "surrogate" })]) {
      await expect(port.publishReady(hostile as PlatformInformationExportRecord))
        .rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    }
    expect(getter.calls).toBe(0); expect(traps.calls).toBe(0);
    const before = (await pool.query("SELECT count(*)::int count FROM platform_information_exports"))
      .rows[0]?.count;
    await expect(port.publishReady(record({ export_id: "export_missing_project",
      project_id: "prj_missing", key: "missing-project" }))).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_exports"))
      .rows[0]?.count).toBe(before);
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_exports")).rows[0]?.count).toBe(0);
  });

  it("cascades cursor and lease metadata with its project without touching another project", async () => {
    await seedProject("prj_cascade", "actor_cascade");
    await seedProject("prj_cascade_other", "actor_cascade_other");
    const port = new PgPlatformInformationExportRecordPort(pool);
    for (const suffix of ["a", "b"]) await port.publishReady(record({
      export_id: `export_cascade_${suffix}`, actor_id: "actor_cascade", project_id: "prj_cascade",
      key: `cascade-${suffix}`, expires_at: "2026-08-14T01:00:00Z",
    }));
    const claimed = await port.claimExpired({ now: "2026-08-14T02:00:00Z", limit: 1,
      worker_id: "worker_cascade", lease_until: "2026-08-14T03:00:00Z" });
    expect(claimed.status).toBe("claimed");
    await port.publishReady(record({ export_id: "export_cascade_other", actor_id: "actor_cascade_other",
      project_id: "prj_cascade_other", key: "cascade-other", expires_at: "2026-08-14T01:00:00Z" }));
    const mixed = await port.claimExpired({ now: "2026-08-14T04:00:00Z", limit: 10,
      worker_id: "worker_mixed", lease_until: "2026-08-14T05:00:00Z" });
    if (mixed.status !== "claimed") throw new Error("mixed claim missing");
    expect(mixed.refs.map((ref) => ref.project_id).sort()).toEqual([
      "prj_cascade", "prj_cascade_other", "prj_cascade",
    ].sort());
    await pool.query("DELETE FROM projects WHERE project_id='prj_cascade'");
    expect((await pool.query(`SELECT count(*)::int count FROM platform_information_exports
      WHERE project_id='prj_cascade'`)).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int count FROM platform_information_export_batch_items
      WHERE export_id LIKE 'export_cascade_%'`)).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_exports"))
      .rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_export_batches"))
      .rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_export_batch_items"))
      .rows[0]?.count).toBe(1);
    await pool.query("DELETE FROM projects WHERE project_id='prj_cascade_other'");
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_export_batches"))
      .rows[0]?.count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM platform_information_export_cursors"))
      .rows[0]?.count).toBe(0);
  });

  it("rejects stale acknowledgement using database time and serializes it with reclaim", async () => {
    const port = new PgPlatformInformationExportRecordPort(pool);
    await port.publishReady(record({ export_id: "export_stale_ack", key: "stale-ack",
      expires_at: "2026-08-13T00:30:00Z" }));
    const databaseNow = await pool.query<{ now: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now");
    const now = databaseNow.rows[0]?.now as string;
    const first = await port.claimExpired({ now: "2026-08-13T01:00:00Z", limit: 10,
      worker_id: "worker_stale", lease_until: "2026-08-13T02:00:00Z" });
    if (first.status !== "claimed") throw new Error("stale claim missing");
    await expect(pool.query(`UPDATE platform_information_export_batches
      SET lease_until_ms=lease_until_ms+1 WHERE batch_id=$1`, [first.batch_id])).rejects
      .toThrow(/lease_time_consistent/u);
    await expect(port.ackExpired({ batch_id: first.batch_id, worker_id: "worker_stale" }))
      .resolves.toEqual({ status: "lease_lost" });
    const [ack, reclaimed] = await Promise.all([
      port.ackExpired({ batch_id: first.batch_id, worker_id: "worker_stale" }),
      new PgPlatformInformationExportRecordPort(pool).claimExpired({ now, limit: 10,
        worker_id: "worker_reclaim", lease_until: new Date(Date.parse(now) + 60_000).toISOString() }),
    ]);
    expect(ack).toEqual({ status: "lease_lost" });
    expect(reclaimed.status).toBe("claimed");
  });

  it("serializes concurrent project cascades for one mixed batch without globally locking other batches", async () => {
    for (const [project, actor] of [["prj_race_a", "actor_race_a"],
      ["prj_race_b", "actor_race_b"], ["prj_race_c", "actor_race_c"],
      ["prj_race_d", "actor_race_d"]] as const) await seedProject(project, actor);
    const port = new PgPlatformInformationExportRecordPort(pool);
    for (const [suffix, project, actor] of [["a", "prj_race_a", "actor_race_a"],
      ["b", "prj_race_b", "actor_race_b"], ["c", "prj_race_c", "actor_race_c"],
      ["d", "prj_race_d", "actor_race_d"]] as const) await port.publishReady(record({
      export_id: `export_race_${suffix}`, project_id: project, actor_id: actor,
      key: `race-${suffix}`, expires_at: "2026-08-14T01:00:00Z",
    }));
    const mixed = await port.claimExpired({ now: "2026-08-14T02:00:00Z", limit: 2,
      worker_id: "worker_race_mixed", lease_until: "2026-08-14T03:00:00Z" });
    const other = await port.claimExpired({ now: "2026-08-14T02:00:00Z", limit: 2,
      worker_id: "worker_race_other", lease_until: "2026-08-14T03:00:00Z" });
    if (mixed.status !== "claimed" || other.status !== "claimed") throw new Error("race batches missing");

    const left = await pool.connect(); const right = await pool.connect();
    const independent = await pool.connect(); const observer = await pool.connect();
    try {
      await Promise.all([left.query("BEGIN"), right.query("BEGIN"), independent.query("BEGIN")]);
      await Promise.all([left.query("SET LOCAL lock_timeout='5s'"), right.query("SET LOCAL lock_timeout='5s'"),
        independent.query("SET LOCAL lock_timeout='5s'")]);
      await right.query("SET LOCAL application_name='m6d_right_parent_lock_waiter'");
      await left.query("DELETE FROM projects WHERE project_id='prj_race_a'");
      const secondDelete = right.query("DELETE FROM projects WHERE project_id='prj_race_b'");
      const deadline = Date.now() + 5_000;
      let observedParentLockWait = false;
      while (Date.now() < deadline) {
        const activity = await observer.query<{ wait_event_type: string | null }>(`SELECT wait_event_type
          FROM pg_stat_activity WHERE application_name='m6d_right_parent_lock_waiter'
            AND state='active'`);
        if (activity.rows[0]?.wait_event_type === "Lock") {
          observedParentLockWait = true;
          break;
        }
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      expect(observedParentLockWait).toBe(true);
      const independentDelete = independent.query("DELETE FROM projects WHERE project_id='prj_race_c'");
      await independentDelete;
      await independent.query("COMMIT");
      await left.query("COMMIT");
      await secondDelete;
      await right.query("COMMIT");
    } finally { left.release(); right.release(); independent.release(); observer.release(); }

    expect((await pool.query(`SELECT count(*)::int count FROM platform_information_export_batch_items
      WHERE batch_id=$1`, [mixed.batch_id])).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int count FROM platform_information_export_batches
      WHERE batch_id=$1`, [mixed.batch_id])).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int count FROM platform_information_export_cursors
      WHERE export_id IN ('export_race_a','export_race_b')`)).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int count FROM platform_information_export_batches
      WHERE batch_id=$1`, [other.batch_id])).rows[0]?.count).toBe(1);
  });

  it("reruns migration with exactly one parent-lock and one empty-cleanup trigger", async () => {
    const migration = await readFile(fileURLToPath(new URL(
      "../migrations/021_platform_information_exports.sql", import.meta.url)), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    const triggers = await pool.query<{ tgname: string; count: number }>(`SELECT tgname,count(*)::int count
      FROM pg_trigger WHERE tgrelid='platform_information_export_batch_items'::regclass
        AND NOT tgisinternal GROUP BY tgname ORDER BY tgname`);
    expect(triggers.rows).toEqual([
      { tgname: "platform_information_export_batch_items_cleanup_empty", count: 1 },
      { tgname: "platform_information_export_batch_items_lock_parent", count: 1 },
    ]);
  });
});

async function portAck(batch_id: string, worker_id: string) {
  return new PgPlatformInformationExportRecordPort(pool).ackExpired({ batch_id, worker_id });
}
