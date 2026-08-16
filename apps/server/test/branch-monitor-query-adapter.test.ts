import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createBranchMonitorQueryAdapter,
  type BranchMonitorQueryAdapterDependencies,
  type BranchMonitorSourceRequest,
  type Stage12MonitorVerifierRequest
} from "../src/branch-monitor-query/index.js";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const cursor = "pic_YnJhbmNoX21vbml0b3I6MjU";

function bundle(runId: string): string {
  return JSON.stringify({ schema_version: 1, receipt: { run_id: runId }, events: [] });
}

function projection(serializedBundle: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    anchor_kind: "stage12_monitor_projection",
    bundle_sha256: digest(serializedBundle),
    project_id: "prj_demo",
    lifecycle_kind: "change",
    run_id: "run_01",
    branch_name: "feature/monitor",
    change_key: "change_monitor",
    run_status: "succeeded",
    current_phase: "archive",
    started_at: "2026-08-13T01:00:00Z",
    ended_at: "2026-08-13T01:03:00Z",
    duration_ms: 180000,
    last_event_at: "2026-08-13T01:03:00Z",
    events: [
      {
        event_id: "plan_event_end_01",
        idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        type: "phase_ended",
        phase: "archive",
        attempt: 1,
        producer_seq: 9,
        occurred_at: "2026-08-13T01:03:00Z",
        display_summary_zh: "归档阶段已结束",
        technical_code: "PLAN_PHASE_ENDED",
        detail_ref: null,
        receipt_ref: "plan_quality:final:receipt_01"
      }
    ],
    ...overrides
  });
}

function sourcePage(bundles: string[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    source_kind: "branch_monitor_page",
    actor_id: "actor_1",
    project_id: "prj_demo",
    accessible_project_ids: ["prj_demo"],
    content_types: ["run_event"],
    sort: "last_event_at_desc_run_id_asc",
    request_cursor: null,
    page_state: bundles.length === 0 ? "empty" : "ready",
    stage12_bundles: bundles,
    next_cursor: null,
    failures: [],
    ...overrides
  });
}

function dependencies(input: {
  page?: string;
  detail?: string;
  project?: (request: Stage12MonitorVerifierRequest) => string | Promise<string>;
  cursorValid?: unknown;
} = {}): BranchMonitorQueryAdapterDependencies {
  return {
    source_port: {
      listPage: vi.fn(async (request: BranchMonitorSourceRequest) => {
        void request;
        return input.page ?? sourcePage([]);
      }),
      getDetail: vi.fn(async () => input.detail ?? JSON.stringify({
        schema_version: 1,
        source_kind: "branch_monitor_detail",
        actor_id: "actor_1",
        project_id: "prj_demo",
        accessible_project_ids: ["prj_demo"],
        content_types: ["run_event"],
        sort: "last_event_at_desc_run_id_asc",
        request_cursor: null,
        detail_id: "run_01",
        stage12_bundle: bundle("run_01")
      }))
    },
    stage12_verifier_port: {
      verify: vi.fn(async (request) => input.project?.(request) ?? projection(request.serialized_bundle))
    },
    cursor_verifier: {
      verify: vi.fn(async () => input.cursorValid ?? true) as never
    }
  };
}

describe("BranchMonitorQueryAdapter", () => {
  it("preserves Stage 12 display/reference and branch boundary lengths without truncation", async () => {
    const serialized = bundle("run_01");
    const branch = "b".repeat(512);
    const summary = "摘".repeat(2048);
    const reference = "r".repeat(512);
    const bounded = projection(serialized, { branch_name: branch, events: [{
      event_id: "event_1", idempotency_key: `sha256:${"a".repeat(64)}`,
      type: "phase_started", phase: "plan", attempt: 1, producer_seq: 1,
      occurred_at: "2026-08-13T01:00:00Z", display_summary_zh: summary,
      technical_code: "PLAN_PHASE_STARTED", detail_ref: reference, receipt_ref: reference
    }] });
    const page = await createBranchMonitorQueryAdapter(dependencies({
      page: sourcePage([serialized]), project: () => bounded
    })).queryPage(await fixture("branch-monitor-query-v1-current.json"));
    expect(page).toMatchObject({ ok: true, value: { items: [{ branch_name: branch }] } });
    const detail = await createBranchMonitorQueryAdapter(dependencies({ project: () => bounded }))
      .queryDetail(JSON.stringify({ schema_version: 1, contract_kind: "detail_request",
        view: "branch_monitor", project_id: "prj_demo", query_scope: { actor_id: "actor_1",
          accessible_project_ids: ["prj_demo"], content_types: ["run_event"] }, detail_id: "run_01" }));
    expect(detail.ok).toBe(true);
    for (const invalid of [
      { branch_name: "b".repeat(513) },
      { events: [{ ...JSON.parse(bounded).events[0], display_summary_zh: "摘".repeat(2049) }] },
      { events: [{ ...JSON.parse(bounded).events[0], detail_ref: "r".repeat(513) }] }
    ]) {
      const result = await createBranchMonitorQueryAdapter(dependencies({
        page: sourcePage([serialized]), project: () => projection(serialized, invalid)
      })).queryPage(await fixture("branch-monitor-query-v1-current.json"));
      expect(result.ok).toBe(false);
    }
  });
  it("projects only verifier-anchored change runs with stable sorting and no payload body", async () => {
    const first = bundle("run_01");
    const second = bundle("run_02");
    const deps = dependencies({
      page: sourcePage([first, second]),
      project: (request) => request.serialized_bundle === second
        ? projection(second, {
            run_id: "run_02",
            branch_name: "feature/second",
            change_key: "change_second",
            last_event_at: "2026-08-13T00:59:00Z",
            ended_at: null,
            duration_ms: null,
            run_status: "running",
            current_phase: "run",
            events: []
          })
        : projection(first)
    });
    const result = await createBranchMonitorQueryAdapter(deps).queryPage(await fixture("branch-monitor-query-v1-current.json"));

    expect(result).toEqual({ ok: true, value: {
      schema_version: 1,
      contract_kind: "page",
      view: "branch_monitor",
      project_id: "prj_demo",
      page_state: "ready",
      sort: "last_event_at_desc_run_id_asc",
      items: [
        {
          item_kind: "branch_monitor",
          lifecycle_kind: "change",
          run_id: "run_01",
          branch_name: "feature/monitor",
          change_key: "change_monitor",
          run_status: "succeeded",
          current_phase: "archive",
          started_at: "2026-08-13T01:00:00Z",
          ended_at: "2026-08-13T01:03:00Z",
          duration_ms: 180000,
          last_event_at: "2026-08-13T01:03:00Z",
          sort_key: "2026-08-13T01:03:00Z|run_01"
        },
        {
          item_kind: "branch_monitor",
          lifecycle_kind: "change",
          run_id: "run_02",
          branch_name: "feature/second",
          change_key: "change_second",
          run_status: "running",
          current_phase: "run",
          started_at: "2026-08-13T01:00:00Z",
          ended_at: null,
          duration_ms: null,
          last_event_at: "2026-08-13T00:59:00Z",
          sort_key: "2026-08-13T00:59:00Z|run_02"
        }
      ],
      next_cursor: null,
      failures: []
    }});
    expect(JSON.stringify(result)).not.toContain("payload");
    expect(deps.stage12_verifier_port.verify).toHaveBeenCalledTimes(2);
  });

  it("returns detail event references while Chinese summaries and technical codes remain separate in the anchor", async () => {
    const serializedBundle = bundle("run_01");
    const deps = dependencies({
      detail: JSON.stringify({
        schema_version: 1,
        source_kind: "branch_monitor_detail",
        actor_id: "actor_1",
        project_id: "prj_demo",
        accessible_project_ids: ["prj_demo"],
        content_types: ["run_event"],
        sort: "last_event_at_desc_run_id_asc",
        request_cursor: null,
        detail_id: "run_01",
        stage12_bundle: serializedBundle
      }),
      project: () => projection(serializedBundle)
    });
    const request = JSON.stringify({
      schema_version: 1,
      contract_kind: "detail_request",
      view: "branch_monitor",
      project_id: "prj_demo",
      query_scope: { actor_id: "actor_1", accessible_project_ids: ["prj_demo"], content_types: ["run_event"] },
      detail_id: "run_01"
    });

    const result = await createBranchMonitorQueryAdapter(deps).queryDetail(request);
    expect(result).toEqual({ ok: true, value: {
      schema_version: 1,
      contract_kind: "detail_response",
      view: "branch_monitor",
      project_id: "prj_demo",
      detail_id: "run_01",
      detail: { detail_kind: "branch_monitor", lifecycle_kind: "change", event_refs: ["plan_event_end_01"] }
    }});
    const verifyRequest = vi.mocked(deps.stage12_verifier_port.verify).mock.calls[0]?.[0];
    expect(verifyRequest).toEqual({
      serialized_bundle: serializedBundle,
      bundle_sha256: digest(serializedBundle),
      project_id: "prj_demo"
    });
  });

  it("verifies opaque cursors and requires exact true", async () => {
    const current = JSON.parse(await fixture("branch-monitor-query-v1-current.json")) as Record<string, unknown>;
    current.cursor = cursor;
    const deps = dependencies({ cursorValid: "true" });
    const result = await createBranchMonitorQueryAdapter(deps).queryPage(JSON.stringify(current));
    expect(result).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_CURSOR_INVALID" });
  });

  it("rejects legacy requests as read-only", async () => {
    const result = await createBranchMonitorQueryAdapter(dependencies()).queryPage(
      await fixture("branch-monitor-query-v0-legacy.json")
    );
    expect(result).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_LEGACY_READ_ONLY" });
  });

  it("rejects object and Proxy requests without inspecting their properties", async () => {
    let traps = 0;
    const hostile = new Proxy({}, {
      get() { traps += 1; throw new Error("trap"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("trap"); },
      ownKeys() { traps += 1; throw new Error("trap"); }
    });
    const result = await createBranchMonitorQueryAdapter(dependencies()).queryPage(hostile);
    expect(result).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_QUERY_INVALID" });
    expect(traps).toBe(0);
  });

  it("rejects non-primitive serialized source and verifier results", async () => {
    const serializedBundle = bundle("run_01");
    const badSource = dependencies({ page: sourcePage([serializedBundle]) });
    badSource.source_port.listPage = vi.fn(async () => new String(sourcePage([])) as never);
    expect(await createBranchMonitorQueryAdapter(badSource).queryPage(
      await fixture("branch-monitor-query-v1-current.json")
    )).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" });

    const badVerifier = dependencies({ page: sourcePage([serializedBundle]) });
    badVerifier.stage12_verifier_port.verify = vi.fn(async () => ({}) as never);
    expect(await createBranchMonitorQueryAdapter(badVerifier).queryPage(
      await fixture("branch-monitor-query-v1-current.json")
    )).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" });
  });

  it.each([
    ["wrong source request echo", { actor_id: "actor_foreign" }],
    ["sync source", {}, { lifecycle_kind: "sync" }],
    ["sync current phase", {}, { current_phase: "sync" }],
    ["sync event phase", {}, { events: [{ event_id: "bad", idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "phase_ended", phase: "sync", attempt: 1, producer_seq: 1, occurred_at: "2026-08-13T01:00:00Z", display_summary_zh: "阶段结束", technical_code: null, detail_ref: null, receipt_ref: null }] }],
    ["unanchored bundle", {}, { bundle_sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    ["unknown event type", {}, { events: [{ event_id: "bad", idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "checklist_passed", phase: "plan", attempt: 1, producer_seq: 1, occurred_at: "2026-08-13T01:00:00Z", display_summary_zh: "自检通过", technical_code: null, detail_ref: null, receipt_ref: null }] }],
    ["payload-shaped event field", {}, { events: [{ event_id: "bad", idempotency_key: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "phase_ended", phase: "plan", attempt: 1, producer_seq: 1, occurred_at: "2026-08-13T01:00:00Z", display_summary_zh: "阶段结束", technical_code: null, detail_ref: null, receipt_ref: null, payload: { secret: "body" } }] }]
  ])("fails closed for %s", async (_name, sourceOverride, projectionOverride = {}) => {
    const serializedBundle = bundle("run_01");
    const deps = dependencies({
      page: sourcePage([serializedBundle], sourceOverride),
      project: () => projection(serializedBundle, projectionOverride)
    });
    const result = await createBranchMonitorQueryAdapter(deps).queryPage(await fixture("branch-monitor-query-v1-current.json"));
    expect(result).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" });
  });

  it.each([
    ["duplicate run", [bundle("run_01"), bundle("run_01")]],
    ["over limit", Array.from({ length: 26 }, (_, index) => bundle(`run_${index}`))]
  ])("rejects %s pages before returning a response", async (_name, bundles) => {
    const deps = dependencies({ page: sourcePage(bundles) });
    const result = await createBranchMonitorQueryAdapter(deps).queryPage(await fixture("branch-monitor-query-v1-current.json"));
    expect(result).toEqual({ ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" });
  });

  it("preserves forbidden and partial failure page states without inventing data", async () => {
    const forbidden = sourcePage([], {
      page_state: "forbidden",
      failures: [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN", retryable: false }]
    });
    const forbiddenResult = await createBranchMonitorQueryAdapter(dependencies({ page: forbidden }))
      .queryPage(await fixture("branch-monitor-query-v1-current.json"));
    expect(forbiddenResult.ok && forbiddenResult.value.page_state).toBe("forbidden");

    const serializedBundle = bundle("run_01");
    const partial = sourcePage([serializedBundle], {
      page_state: "partial_failure",
      failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }]
    });
    const partialResult = await createBranchMonitorQueryAdapter(dependencies({ page: partial }))
      .queryPage(await fixture("branch-monitor-query-v1-current.json"));
    expect(partialResult.ok && partialResult.value.page_state).toBe("partial_failure");
  });
});
