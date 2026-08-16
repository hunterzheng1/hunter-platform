import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  type PlatformInformationExportArtifactReceipt,
} from "@hunter-harness/contracts";

import {
  createMemoryPlatformInformationExportRecordPort,
  type PlatformInformationExportRecord,
} from "../src/platform-information-export/index.js";

const hash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function receipt(input: {
  readonly export_id: string;
  readonly project_id?: string;
  readonly actor_id?: string;
  readonly content_sha?: string;
  readonly created_at?: string;
  readonly expires_at?: string;
  readonly limit?: number;
}): PlatformInformationExportRecord {
  const project_id = input.project_id ?? "prj_export_records";
  const actor_id = input.actor_id ?? "actor_export_records";
  const content_sha = input.content_sha ?? hash("c");
  const value: PlatformInformationExportArtifactReceipt = {
    schema_version: 1,
    contract_kind: "platform_information_export_artifact_receipt",
    export_id: input.export_id,
    project_id,
    view: "project_knowledge",
    range: {
      query_scope: {
        actor_id,
        accessible_project_ids: [project_id],
        content_types: ["knowledge_entry"],
      },
      limit: input.limit ?? 10,
      source_cursor: null,
      cursor_verification: "server_port_required",
      sort: "extracted_at_desc_knowledge_id_asc",
    },
    m4_proof: {
      pages: [{ request_cursor: null, response_next_cursor: null, result_count: 0 }],
      exported_count: 0,
      items_sha: hash("i"),
      completed: true,
    },
    proof_sha: hash("p"),
    artifact: {
      format: "canonical_jsonl_v1",
      media_type: "application/x-ndjson",
      content_sha,
      items_sha: hash("i"),
      byte_count: 128,
      item_count: 0,
      page_count: 1,
    },
    download_ref: { export_id: input.export_id, project_id, content_sha },
    status: "ready",
    created_at: input.created_at ?? "2026-08-14T03:00:00Z",
    expires_at: input.expires_at ?? "2026-08-15T03:00:00Z",
  };
  return {
    actor_id,
    idempotency_key: hash("k"),
    query_hash: hash(canonicalJson({
      schema_version: 1,
      contract_kind: "query",
      view: value.view,
      project_id: value.project_id,
      query_scope: value.range.query_scope,
      limit: value.range.limit,
      cursor: value.range.source_cursor,
      cursor_verification: value.range.cursor_verification,
      sort: value.range.sort,
    })),
    receipt: value,
  };
}

describe("memory Platform Information export Record Port", () => {
  it("publishes one immutable receipt for concurrent equal records and finds it by full idempotency identity", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const record = receipt({ export_id: "export_record_1" });
    const [first, second] = await Promise.all([
      port.publishReady(record),
      port.publishReady(structuredClone(record)),
    ]);

    expect([first.status, second.status].sort()).toEqual(["existing", "published"]);
    const found = await port.findReadyByIdempotency({
      actor_id: record.actor_id,
      project_id: record.receipt.project_id,
      idempotency_key: record.idempotency_key,
      query_hash: record.query_hash,
      now: "2026-08-14T03:30:00Z",
    });
    expect(found).toMatchObject({ status: "ready", record });
    expect(Object.isFrozen(found)).toBe(true);
    if (found.status !== "ready") throw new Error("record missing");
    expect(Object.isFrozen(found.record.receipt.range.query_scope.accessible_project_ids)).toBe(true);

    (record.receipt.download_ref as { content_sha: string }).content_sha = hash("d");
    expect(found.record.receipt.download_ref.content_sha).toBe(hash("c"));
    expect(port.metrics.stored_records).toBe(1);
  });

  it("returns a stable different-query conflict without replacing the first record", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const first = receipt({ export_id: "export_record_2" });
    await expect(port.publishReady(first)).resolves.toMatchObject({ status: "published" });

    const conflicting = receipt({ export_id: "export_record_other", limit: 9 });
    await expect(port.publishReady(conflicting)).resolves.toEqual({
      status: "conflict",
      reason_code: "different_query",
    });
    await expect(port.findReadyByIdempotency({
      actor_id: first.actor_id,
      project_id: first.receipt.project_id,
      idempotency_key: first.idempotency_key,
      query_hash: conflicting.query_hash,
      now: "2026-08-14T03:30:00Z",
    })).resolves.toEqual({ status: "conflict", reason_code: "different_query" });
    expect(port.metrics.stored_records).toBe(1);
    await expect(port.publishReady({
      ...structuredClone(first),
      receipt: { ...structuredClone(first.receipt), proof_sha: hash("different-proof") },
    })).resolves.toEqual({ status: "conflict", reason_code: "different_record" });
  });

  it("does not leak foreign records and distinguishes an authorized expired export", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const record = receipt({ export_id: "export_acl", expires_at: "2026-08-14T04:00:00Z" });
    await port.publishReady(record);

    await expect(port.findReadyByIdempotency({
      actor_id: record.actor_id,
      project_id: record.receipt.project_id,
      idempotency_key: record.idempotency_key,
      query_hash: record.query_hash,
      now: "2026-08-14T04:00:00Z",
    })).resolves.toEqual({ status: "expired" });

    await expect(port.getReadyForDownload({
      actor_id: "actor_foreign",
      project_id: record.receipt.project_id,
      export_id: record.receipt.export_id,
      now: "2026-08-14T03:30:00Z",
    })).resolves.toEqual({ status: "not_found" });
    await expect(port.getReadyForDownload({
      actor_id: record.actor_id,
      project_id: "prj_foreign",
      export_id: record.receipt.export_id,
      now: "2026-08-14T05:00:00Z",
    })).resolves.toEqual({ status: "not_found" });
    await expect(port.getReadyForDownload({
      actor_id: record.actor_id,
      project_id: record.receipt.project_id,
      export_id: record.receipt.export_id,
      now: "2026-08-14T04:00:00Z",
    })).resolves.toEqual({ status: "expired" });
  });

  it("claims expired refs in stable pages and keeps a shared CAS hash live until every reference expires", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const shared = hash("a");
    const records = [
      receipt({ export_id: "export_02", content_sha: shared, created_at: "2026-08-13T03:00:00Z", expires_at: "2026-08-14T02:00:00Z" }),
      receipt({ export_id: "export_01", content_sha: shared, created_at: "2026-08-13T03:00:00Z", expires_at: "2026-08-14T02:00:00Z" }),
      receipt({ export_id: "export_03", content_sha: shared, expires_at: "2026-08-16T02:00:00Z" }),
    ].map((value, index) => ({ ...value, idempotency_key: hash(String(index + 1)) }));
    await Promise.all(records.map((value) => port.publishReady(value)));

    expect(await port.hasLiveReference({ content_hash: shared, now: "2026-08-14T03:00:00Z" })).toBe(true);
    await expect(port.claimExpired({
      now: "2026-08-14T03:00:00Z", limit: 1_001,
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    })).rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    const first = await port.claimExpired({
      now: "2026-08-14T03:00:00Z", limit: 1,
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    });
    if (first.status !== "claimed") throw new Error("claim missing");
    expect(first.refs.map((value) => value.export_id)).toEqual(["export_01"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.refs)).toBe(true);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const replay = await port.claimExpired({
      now: "2026-08-14T03:00:00Z", limit: 1,
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    });
    expect(replay).toEqual(first);
    if (replay.status !== "claimed") throw new Error("claim missing");
    expect(replay.next_cursor).toBe(first.next_cursor);
    await expect(port.claimExpired({
      now: "2026-08-14T03:00:01Z", limit: 1, cursor: first.next_cursor,
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    })).rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    const tampered = `${first.next_cursor?.slice(0, -1)}${first.next_cursor?.endsWith("A") ? "B" : "A"}`;
    await expect(port.claimExpired({
      now: "2026-08-14T03:00:00Z", limit: 1, cursor: tampered,
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    })).rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    await expect(port.claimExpired({
      now: "2026-08-14T03:00:00Z", limit: 1, cursor: "A".repeat(43),
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    })).rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    const second = await port.claimExpired({
      now: "2026-08-14T03:00:00Z",
      limit: 1,
      cursor: first.next_cursor,
      worker_id: "worker_1", lease_until: "2026-08-14T04:00:00Z",
    });
    if (second.status !== "claimed") throw new Error("claim missing");
    expect(second.refs.map((value) => value.export_id)).toEqual(["export_02"]);
    expect(second.next_cursor).toBeNull();
    expect(await port.hasLiveReference({ content_hash: shared, now: "2026-08-14T03:00:00Z" })).toBe(true);
    expect(await port.hasLiveReference({ content_hash: shared, now: "2026-08-17T03:00:00Z" })).toBe(false);
  });

  it("redelivers an unacked claim after lease expiry and makes owned ack replay safe", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const record = receipt({
      export_id: "export_redelivery",
      created_at: "2026-08-13T01:00:00Z",
      expires_at: "2026-08-14T01:00:00Z",
    });
    await port.publishReady(record);
    const first = await port.claimExpired({
      now: "2026-08-14T02:00:00Z", limit: 10,
      worker_id: "worker_1", lease_until: "2026-08-14T03:00:00Z",
    });
    if (first.status !== "claimed") throw new Error("claim missing");
    await expect(port.claimExpired({
      now: "2026-08-14T02:30:00Z", limit: 10,
      worker_id: "worker_2", lease_until: "2026-08-14T03:30:00Z",
    })).resolves.toEqual({ status: "empty", refs: [], next_cursor: null });
    const redelivered = await port.claimExpired({
      now: "2026-08-14T03:00:00Z", limit: 10,
      worker_id: "worker_2", lease_until: "2026-08-14T04:00:00Z",
    });
    if (redelivered.status !== "claimed") throw new Error("claim missing");
    expect(redelivered.refs).toEqual(first.refs);
    await expect(port.ackExpired({ batch_id: redelivered.batch_id, worker_id: "worker_1" }))
      .resolves.toEqual({ status: "not_owner" });
    await expect(port.ackExpired({ batch_id: first.batch_id, worker_id: "worker_1" }))
      .resolves.toEqual({ status: "lease_lost" });
    await expect(port.ackExpired({ batch_id: redelivered.batch_id, worker_id: "worker_2" }))
      .resolves.toEqual({ status: "acked" });
    await expect(port.ackExpired({ batch_id: redelivered.batch_id, worker_id: "worker_2" }))
      .resolves.toEqual({ status: "already_acked" });
    await expect(port.claimExpired({
      now: "2026-08-14T05:00:00Z", limit: 10,
      worker_id: "worker_3", lease_until: "2026-08-14T06:00:00Z",
    })).resolves.toEqual({ status: "empty", refs: [], next_cursor: null });
  });

  it("orders Unicode export ids by UTF-8 bytes rather than UTF-16 code units", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const astral = receipt({ export_id: "export_😀", created_at: "2026-08-13T01:00:00Z", expires_at: "2026-08-14T01:00:00Z" });
    const bmp = { ...receipt({ export_id: "export_", created_at: "2026-08-13T01:00:00Z", expires_at: "2026-08-14T01:00:00Z" }), idempotency_key: hash("bmp") };
    await port.publishReady(astral);
    await port.publishReady(bmp);
    const claimed = await port.claimExpired({
      now: "2026-08-14T02:00:00Z", limit: 10,
      worker_id: "worker_unicode", lease_until: "2026-08-14T03:00:00Z",
    });
    if (claimed.status !== "claimed") throw new Error("claim missing");
    expect(claimed.refs.map((value) => value.export_id)).toEqual(["export_", "export_😀"]);
  });

  it("keeps a fixed cursor for maximum multi-byte export ids and reads the second page", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const firstId = `export_${"界".repeat(51)}`;
    const secondId = `export_${"😀".repeat(38)}`;
    await port.publishReady(receipt({ export_id: firstId, created_at: "2026-08-13T01:00:00Z", expires_at: "2026-08-14T01:00:00Z" }));
    await port.publishReady({
      ...receipt({ export_id: secondId, created_at: "2026-08-13T01:00:00Z", expires_at: "2026-08-14T01:00:00Z" }),
      idempotency_key: hash("max-unicode-second"),
    });
    const first = await port.claimExpired({ now: "2026-08-14T02:00:00Z", limit: 1,
      worker_id: "worker_max", lease_until: "2026-08-14T03:00:00Z" });
    if (first.status !== "claimed") throw new Error("claim missing");
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const second = await port.claimExpired({ now: "2026-08-14T02:00:00Z", limit: 1,
      cursor: first.next_cursor, worker_id: "worker_max", lease_until: "2026-08-14T03:00:00Z" });
    if (second.status !== "claimed") throw new Error("claim missing");
    expect([...first.refs, ...second.refs].map((value) => value.export_id)).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
  });

  it("provides an explicit memory-only project cascade seam", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const first = receipt({ export_id: "export_purge_1", project_id: "prj_purge" });
    const second = { ...receipt({ export_id: "export_purge_2", project_id: "prj_keep" }), idempotency_key: hash("2") };
    await port.publishReady(first);
    await port.publishReady(second);
    expect(port.purgeProjectForTest("prj_purge")).toBe(1);
    expect(port.metrics.stored_records).toBe(1);
  });

  it("rejects malformed, accessor, proxy, and extra-key inputs before partial mutation", async () => {
    const port = createMemoryPlatformInformationExportRecordPort();
    const getter = { calls: 0 };
    const accessor = Object.defineProperty({}, "actor_id", {
      enumerable: true,
      get() { getter.calls += 1; return "actor_trap"; },
    });
    const trap = { calls: 0 };
    const proxy = new Proxy({}, {
      ownKeys() { trap.calls += 1; return []; },
      getOwnPropertyDescriptor() { trap.calls += 1; return undefined; },
      getPrototypeOf() { trap.calls += 1; return Object.prototype; },
    });
    const valid = receipt({ export_id: "export_after_hostile" });

    for (const hostile of [accessor, proxy, { ...valid, extra: true }, { ...valid, query_hash: "bad" }]) {
      await expect(port.publishReady(hostile as PlatformInformationExportRecord))
        .rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    }
    expect(getter.calls).toBe(0);
    expect(trap.calls).toBe(0);
    expect(port.metrics.stored_records).toBe(0);
    const loneSurrogate = receipt({ export_id: "export_\uD800" });
    await expect(port.publishReady(loneSurrogate)).rejects
      .toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    expect(port.metrics.stored_records).toBe(0);
    for (const invoke of [
      () => port.findReadyByIdempotency(proxy as never),
      () => port.getReadyForDownload(proxy as never),
      () => port.claimExpired(proxy as never),
      () => port.ackExpired(proxy as never),
      () => port.hasLiveReference(proxy as never),
    ]) {
      await expect(invoke()).rejects.toThrow("PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID");
    }
    expect(trap.calls).toBe(0);
    await expect(port.publishReady(valid)).resolves.toMatchObject({ status: "published" });
  });
});
