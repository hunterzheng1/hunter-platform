import { createHash } from "node:crypto";

import { canonicalJson, readPlanEventBundle } from "@hunter-harness/contracts";
import { describe, expect, it } from "vitest";

import { createRunStoreBranchMonitorSource } from "../src/runs/branch-monitor-source.js";
import { createBranchMonitorCursorPort } from "../src/runs/branch-monitor-cursor.js";
import { MemoryRunStore } from "../src/runs/memory-store.js";
import { createStage12MonitorVerifierAdapter } from "../src/runs/stage12-monitor-verifier.js";
import { createProductionBranchMonitorTrust } from "../src/runs/production-branch-monitor-trust.js";
import type { RunStore } from "../src/runs/store.js";

const canonicalIdentity = {
  runId: "run_stage12",
  projectId: "prj_stage12",
  changeKey: "change_stage12",
  title: "Stage 12 monitor",
  lifecycleKind: "change" as const,
  branchName: "feature/stage12-monitor",
  sourceVersion: "plan-event-bundle/v1"
};
const cursorPort = () => createBranchMonitorCursorPort("stage12-monitor-test-secret-at-least-32-bytes");
const digest = (serialized: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;

async function addEvent(store: MemoryRunStore, identity: typeof canonicalIdentity, input: {
  id: string; seq: number; at: string; trusted?: boolean;
}): Promise<void> {
  await store.ingestBatch({ projectId: identity.projectId, runId: identity.runId, events: [{
    eventId: input.id, producerSeq: input.seq, eventType: "phase_started", phase: "plan",
    occurredAt: input.at, payload: {}, ...(input.trusted === false ? {} : { planEvent: {
      schema_version: 1 as const, event_id: input.id, lifecycle_kind: "change" as const,
      run_id: identity.runId, change_key: identity.changeKey, phase: "plan", attempt: 1,
      type: "phase_started", producer_seq: input.seq, occurred_at: input.at,
      idempotency_key: `sha256:${input.seq.toString(16).padStart(64, "0")}`
    } })
  }] });
}

describe("RunStore Stage 12 identity", () => {
  it("binds opaque monitor cursors to actor, project, view and sort", async () => {
    const port = cursorPort();
    const scope = {
      actor_id: "actor_stage12", project_id: "prj_stage12",
      view: "branch_monitor" as const, sort: "last_event_at_desc_run_id_asc" as const
    };
    const token = await port.issue({ ...scope, offset: 25 });
    expect(token.length).toBeGreaterThan(16);
    expect(await port.verify({ ...scope, cursor: token })).toBe(true);
    expect(await port.decode({ ...scope, cursor: token })).toBe(25);
    expect(await port.verify({ ...scope, project_id: "prj_foreign", cursor: token })).toBe(false);
    expect(await port.decode({ ...scope, cursor: token.slice(0, -1) + "A" })).toBeNull();
    const encoded = token.slice(0, -43);
    const signature = token.slice(-43);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const aliasTail = [...alphabet].find((candidate) => {
      const alias = encoded.slice(0, -1) + candidate;
      return alias !== encoded && Buffer.from(alias, "base64url").equals(Buffer.from(encoded, "base64url"));
    });
    expect(aliasTail).toBeDefined();
    expect(await port.decode({
      ...scope, cursor: `${encoded.slice(0, -1)}${aliasTail ?? ""}${signature}`
    })).toBeNull();
  });

  it("freezes canonical branch, source version and lifecycle on first ensure", async () => {
    const store = new MemoryRunStore();
    const created = await store.ensureRun(canonicalIdentity);
    expect(created).toMatchObject({
      lifecycleKind: "change",
      branchName: "feature/stage12-monitor",
      sourceVersion: "plan-event-bundle/v1"
    });

    await expect(store.ensureRun({
      ...canonicalIdentity,
      branchName: "feature/hostile-drift"
    })).rejects.toThrow("RUN_IDENTITY_CONFLICT");
    await expect(store.ensureRun({
      ...canonicalIdentity,
      lifecycleKind: "legacy_unmarked",
      branchName: null,
      sourceVersion: null
    })).rejects.toThrow("RUN_IDENTITY_CONFLICT");
  });

  it("keeps old progress-sync rows explicitly unmarked and outside change monitoring", async () => {
    const store = new MemoryRunStore();
    const run = await store.ensureRun({
      runId: "run_legacy",
      projectId: "prj_stage12",
      changeKey: "legacy-sync",
      lifecycleKind: "legacy_unmarked",
      branchName: null,
      sourceVersion: null
    });
    expect(run).toMatchObject({
      lifecycleKind: "legacy_unmarked",
      branchName: null,
      sourceVersion: null
    });

    const source = createRunStoreBranchMonitorSource(store, cursorPort());
    const page = JSON.parse(await source.listPage({
      actor_id: "actor_stage12",
      project_id: "prj_stage12",
      accessible_project_ids: ["prj_stage12"],
      content_types: ["run_event"],
      sort: "last_event_at_desc_run_id_asc",
      request_cursor: null,
      cursor: null,
      limit: 25
    })) as { page_state: string; stage12_bundles: string[] };
    expect(page.page_state).toBe("empty");
    expect(page.stage12_bundles).toEqual([]);
  });

  it("sorts monitor runs by last event descending, run id ascending, with no-event rows last", async () => {
    const store = new MemoryRunStore();
    const runB = { ...canonicalIdentity, runId: "run_b", changeKey: "change_b" };
    const runA = { ...canonicalIdentity, runId: "run_a", changeKey: "change_a" };
    const runNone = { ...canonicalIdentity, runId: "run_none", changeKey: "change_none" };
    const identities = [runB, runA, runNone];
    for (const identity of identities) await store.ensureRun(identity);
    await addEvent(store, runB, { id: "plan_event:b", seq: 1, at: "2026-08-13T02:00:00Z" });
    await addEvent(store, runA, { id: "plan_event:a", seq: 1, at: "2026-08-13T02:00:00Z" });
    const listed = await store.listRuns(canonicalIdentity.projectId, { lifecycleKind: "change" });
    expect(listed.items.map((run) => run.runId)).toEqual(["run_a", "run_b", "run_none"]);
  });

  it("rebuilds Memory run aggregates in canonical producer order after out-of-order delivery", async () => {
    const store = new MemoryRunStore();
    const identity = { ...canonicalIdentity, runId: "run_out_of_order", changeKey: "change_out_of_order" };
    await store.ensureRun(identity);
    await store.ingestBatch({ projectId: identity.projectId, runId: identity.runId, events: [{
      eventId: "plan_event:ended", producerSeq: 2, eventType: "phase_ended", phase: "plan",
      occurredAt: "2026-08-13T04:00:02Z", payload: {}, planEvent: {
        schema_version: 1, event_id: "plan_event:ended", lifecycle_kind: "change",
        run_id: identity.runId, change_key: identity.changeKey, phase: "plan", attempt: 1,
        type: "phase_ended", producer_seq: 2, occurred_at: "2026-08-13T04:00:02Z",
        idempotency_key: `sha256:${"e".repeat(64)}` }
    }] });
    await store.ingestBatch({ projectId: identity.projectId, runId: identity.runId, events: [{
      eventId: "plan_event:started", producerSeq: 1, eventType: "phase_started", phase: "plan",
      occurredAt: "2026-08-13T04:00:01Z", payload: {}, planEvent: {
        schema_version: 1, event_id: "plan_event:started", lifecycle_kind: "change",
        run_id: identity.runId, change_key: identity.changeKey, phase: "plan", attempt: 1,
        type: "phase_started", producer_seq: 1, occurred_at: "2026-08-13T04:00:01Z",
        idempotency_key: `sha256:${"d".repeat(64)}` }
    }] });
    await expect(store.getRun(identity.projectId, identity.runId)).resolves.toMatchObject({
      runStatus: "running", startedAt: "2026-08-13T04:00:01Z",
      lastEventAt: "2026-08-13T04:00:02Z", endedAt: null,
      currentPhase: "plan"
    });
  });

  it("allows producer sequence one in a new Stage 12 phase/attempt group", async () => {
    const store = new MemoryRunStore();
    const identity = { ...canonicalIdentity, runId: "run_grouped_seq", changeKey: "change_grouped_seq" };
    await store.ensureRun(identity);
    const event = (phase: "plan" | "run", attempt: number, type: "phase_ended" | "phase_started") => ({
      eventId: `plan_event:${phase}_${attempt}`, producerSeq: 1, eventType: type, phase,
      occurredAt: `2026-08-13T05:00:0${phase === "plan" ? 1 : 2}Z`, payload: {}, planEvent: {
        schema_version: 1 as const, event_id: `plan_event:${phase}_${attempt}`,
        lifecycle_kind: "change" as const, run_id: identity.runId, change_key: identity.changeKey,
        phase, attempt, type, producer_seq: 1,
        occurred_at: `2026-08-13T05:00:0${phase === "plan" ? 1 : 2}Z`,
        idempotency_key: `sha256:${(phase === "plan" ? "1" : "2").repeat(64)}`
      }
    });
    expect((await store.ingestBatch({ projectId: identity.projectId, runId: identity.runId,
      events: [event("plan", 1, "phase_ended"), event("run", 1, "phase_started")] })).items)
      .toEqual([expect.objectContaining({ status: "accepted" }), expect.objectContaining({ status: "accepted" })]);
    await expect(store.getRun(identity.projectId, identity.runId)).resolves.toMatchObject({
      syncCompleteness: "complete", currentPhase: "run", runStatus: "running"
    });
  });

  it("builds production trust from the shared reader and disables it without a secret", async () => {
    expect(createProductionBranchMonitorTrust(undefined)).toBeUndefined();
    const trust = createProductionBranchMonitorTrust("production-monitor-secret-at-least-32-bytes");
    expect(trust).toBeDefined();
    await expect(trust?.eventBundleReader.readEventBundle("{}")).resolves.toMatchObject({
      ok: false, reason_code: "PLAN_EVENT_BUNDLE_INVALID"
    });
  });

  it("continues bounded source scans past unprojectable rows without truncating later runs", async () => {
    const store = new MemoryRunStore();
    const invalid = { ...canonicalIdentity, runId: "run_invalid", changeKey: "change_invalid" };
    const valid = { ...canonicalIdentity, runId: "run_valid", changeKey: "change_valid" };
    await store.ensureRun(invalid); await store.ensureRun(valid);
    await addEvent(store, invalid, { id: "legacy_event", seq: 1, at: "2026-08-13T03:00:00Z", trusted: false });
    await addEvent(store, valid, { id: "plan_event:valid", seq: 1, at: "2026-08-13T02:00:00Z" });
    const page = JSON.parse(await createRunStoreBranchMonitorSource(store, cursorPort()).listPage({
      actor_id: "actor_stage12", project_id: canonicalIdentity.projectId,
      accessible_project_ids: [canonicalIdentity.projectId], content_types: ["run_event"],
      sort: "last_event_at_desc_run_id_asc", request_cursor: null, cursor: null, limit: 1
    })) as { page_state: string; stage12_bundles: string[]; next_cursor: string | null };
    expect(page.page_state).toBe("partial_failure");
    expect(page.stage12_bundles).toHaveLength(1);
    expect(JSON.parse(page.stage12_bundles[0] ?? "{}").run_id).toBe("run_valid");
    expect(page.next_cursor).toBeNull();
  });

  it("returns bounded canonical bundles only for marked change runs", async () => {
    const store = new MemoryRunStore();
    await store.ensureRun(canonicalIdentity);
    await store.ingestBatch({
      projectId: canonicalIdentity.projectId,
      runId: canonicalIdentity.runId,
      events: [{
        eventId: "plan_event:trusted",
        producerSeq: 1,
        eventType: "phase_started",
        phase: "plan",
        occurredAt: "2026-08-13T01:00:00Z",
        payload: {},
        planEvent: {
          schema_version: 1,
          event_id: "plan_event:trusted",
          lifecycle_kind: "change",
          run_id: canonicalIdentity.runId,
          change_key: canonicalIdentity.changeKey,
          phase: "plan",
          attempt: 1,
          type: "phase_started",
          producer_seq: 1,
          occurred_at: "2026-08-13T01:00:00Z",
          idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }]
    });

    const source = createRunStoreBranchMonitorSource(store, cursorPort());
    const request = {
      actor_id: "actor_stage12",
      project_id: "prj_stage12",
      accessible_project_ids: ["prj_stage12"],
      content_types: ["run_event"] as const,
      sort: "last_event_at_desc_run_id_asc" as const,
      request_cursor: null,
      cursor: null,
      limit: 25
    };
    const page = JSON.parse(await source.listPage(request)) as {
      page_state: string; stage12_bundles: string[];
    };
    expect(page.page_state).toBe("ready");
    expect(page.stage12_bundles).toHaveLength(1);
    expect(JSON.parse(page.stage12_bundles[0] ?? "{}")).toMatchObject({
      schema_version: 1,
      lifecycle_kind: "change",
      run_id: canonicalIdentity.runId,
      change_key: canonicalIdentity.changeKey
    });

    const detail = JSON.parse(await source.getDetail({
      ...request,
      request_cursor: null,
      detail_id: canonicalIdentity.runId
    })) as { detail_id: string; stage12_bundle: string };
    expect(detail.detail_id).toBe(canonicalIdentity.runId);
    expect(detail.stage12_bundle).toBe(page.stage12_bundles[0]);

    const conflict = await store.ingestBatch({
      projectId: canonicalIdentity.projectId,
      runId: canonicalIdentity.runId,
      events: [{
        eventId: "plan_event:trusted", producerSeq: 1, eventType: "phase_started",
        phase: "plan", occurredAt: "2026-08-13T01:00:00Z", payload: {},
        planEvent: {
          schema_version: 1, event_id: "plan_event:trusted", lifecycle_kind: "change",
          run_id: canonicalIdentity.runId, change_key: canonicalIdentity.changeKey,
          phase: "plan", attempt: 1, type: "phase_started", producer_seq: 1,
          occurred_at: "2026-08-13T01:00:00Z",
          idempotency_key: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      }]
    });
    expect(conflict.items[0]).toMatchObject({ status: "id_conflict", error_code: "ID_CONFLICT" });
  });

  it("delegates bundle trust to the Harness reader and merges only frozen RunStore identity", async () => {
    const store = new MemoryRunStore();
    await store.ensureRun(canonicalIdentity);
    const machine = {
      lifecycle_kind: "change" as const,
      run_id: canonicalIdentity.runId,
      change_key: canonicalIdentity.changeKey,
      phase: "plan" as const,
      attempt: 1,
      type: "phase_started" as const,
      producer_seq: 1
    };
    const event = {
      schema_version: 1 as const,
      ...machine,
      occurred_at: "2026-08-13T01:00:00Z",
      event_id: `plan_event:${digest(canonicalJson({
        ...machine, occurred_at: "2026-08-13T01:00:00Z"
      })).slice(7)}`,
      idempotency_key: digest(canonicalJson(machine)),
      summary_zh: "规划阶段已开始"
    };
    await store.ingestBatch({
      projectId: canonicalIdentity.projectId,
      runId: canonicalIdentity.runId,
      events: [{
        eventId: event.event_id,
        producerSeq: event.producer_seq,
        eventType: event.type,
        phase: event.phase,
        occurredAt: event.occurred_at,
        payload: {},
        planEvent: event
      }]
    });
    const source = createRunStoreBranchMonitorSource(store, cursorPort());
    const page = JSON.parse(await source.listPage({
      actor_id: "actor_stage12", project_id: canonicalIdentity.projectId,
      accessible_project_ids: [canonicalIdentity.projectId], content_types: ["run_event"],
      sort: "last_event_at_desc_run_id_asc", request_cursor: null, cursor: null, limit: 25
    })) as { stage12_bundles: string[] };
    const serialized = page.stage12_bundles[0] ?? "";
    const reader = {
      async readEventBundle(input: unknown) {
        return readPlanEventBundle(input, { async sha256(value) { return digest(value); } });
      }
    };
    const adapter = createStage12MonitorVerifierAdapter({ eventBundleReader: reader, runStore: store });
    const projected = JSON.parse(await adapter.verify({
      serialized_bundle: serialized,
      bundle_sha256: digest(serialized),
      project_id: canonicalIdentity.projectId
    })) as Record<string, unknown>;
    expect(projected).toMatchObject({
      anchor_kind: "stage12_monitor_projection",
      project_id: canonicalIdentity.projectId,
      lifecycle_kind: "change",
      run_id: canonicalIdentity.runId,
      branch_name: canonicalIdentity.branchName,
      change_key: canonicalIdentity.changeKey,
      run_status: "running"
    });
    expect(projected.events).toEqual([expect.objectContaining({
      type: "phase_started", display_summary_zh: "规划阶段已开始"
    })]);

    const rejected = createStage12MonitorVerifierAdapter({
      eventBundleReader: { async readEventBundle() {
        return { ok: false as const, reason_code: "PLAN_EVENT_BUNDLE_INVALID" as const };
      } },
      runStore: store
    });
    await expect(rejected.verify({
      serialized_bundle: serialized,
      bundle_sha256: `sha256:${"0".repeat(64)}`,
      project_id: canonicalIdentity.projectId
    })).rejects.toThrow("STAGE12_MONITOR_BUNDLE_HASH_INVALID");
  });

  it("canonicalizes producer order and fails closed on duplicate sequence or a 4097th stored event", async () => {
    const run = { ...canonicalIdentity, runId: "run_bounds", changeKey: "change_bounds" };
    const base = (seq: number) => ({
      serverCursor: seq, projectId: run.projectId, runId: run.runId,
      eventId: `plan_event:${seq}`, producerSeq: seq, eventType: "phase_started", phase: "plan",
      occurredAt: `2026-08-13T01:00:${String(seq % 60).padStart(2, "0")}Z`, payload: {}, receivedAt: "2026-08-13T01:00:00Z",
      planEvent: { schema_version: 1 as const, event_id: `plan_event:${seq}`, lifecycle_kind: "change" as const,
        run_id: run.runId, change_key: run.changeKey, phase: "plan", attempt: 1,
        type: "phase_started", producer_seq: seq,
        occurred_at: `2026-08-13T01:00:${String(seq % 60).padStart(2, "0")}Z`,
        idempotency_key: `sha256:${seq.toString(16).padStart(64, "0")}` }
    });
    const fake = (events: ReturnType<typeof base>[]) => ({
      async listRuns() { return { items: [run], nextCursor: null, total: 1 }; },
      async getRun() { return run; },
      async listEvents(_runId: string, options?: { limit?: number }) { return events.slice(0, options?.limit); }
    }) as unknown as RunStore;
    const request = {
      actor_id: "actor_stage12", project_id: run.projectId,
      accessible_project_ids: [run.projectId], content_types: ["run_event"] as const,
      sort: "last_event_at_desc_run_id_asc" as const, request_cursor: null, cursor: null, limit: 1
    };
    const ordered = JSON.parse(await createRunStoreBranchMonitorSource(
      fake([base(2), base(1)]), cursorPort()
    ).listPage(request)) as { stage12_bundles: string[] };
    expect(JSON.parse(ordered.stage12_bundles[0] ?? "{}").events.map(
      (event: { producer_seq: number }) => event.producer_seq
    )).toEqual([1, 2]);

    const duplicate = base(2); duplicate.planEvent.producer_seq = 1;
    await expect(createRunStoreBranchMonitorSource(fake([base(1), duplicate]), cursorPort()).listPage(request))
      .rejects.toThrow("BRANCH_MONITOR_EVENT_IDENTITY_INVALID");
    await expect(createRunStoreBranchMonitorSource(
      fake(Array.from({ length: 4097 }, (_, index) => base(index + 1))), cursorPort()
    ).listPage(request)).rejects.toThrow("BRANCH_MONITOR_EVENT_LIMIT_EXCEEDED");
  });

  it("fails closed when an underlying cursor cycles or bounded scanning cannot finish", async () => {
    const run = { ...canonicalIdentity, runId: "run_scanning", changeKey: "change_scanning" };
    const request = {
      actor_id: "actor_stage12", project_id: run.projectId,
      accessible_project_ids: [run.projectId], content_types: ["run_event"] as const,
      sort: "last_event_at_desc_run_id_asc" as const, request_cursor: null, cursor: null, limit: 1
    };
    const fake = (next: (call: number) => string) => {
      let calls = 0;
      return { store: {
        async listRuns() { calls += 1; return { items: [run], nextCursor: next(calls), total: 1_000 }; },
        async listEvents() { return []; }
      } as unknown as RunStore, calls: () => calls };
    };
    const cycle = fake(() => Buffer.from("run-offset:0").toString("base64url"));
    await expect(createRunStoreBranchMonitorSource(cycle.store, cursorPort()).listPage(request))
      .rejects.toThrow("BRANCH_MONITOR_CURSOR_NO_PROGRESS");

    const endless = fake((call) => Buffer.from(`run-offset:${call}`).toString("base64url"));
    await expect(createRunStoreBranchMonitorSource(endless.store, cursorPort()).listPage(request))
      .rejects.toThrow("BRANCH_MONITOR_SCAN_LIMIT_EXCEEDED");
    expect(endless.calls()).toBe(100);
  });
});
