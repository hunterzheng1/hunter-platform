import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPgRemoteSyncCommitPort } from "../src/remote-sync-pg/index.js";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function input() {
  const content = "# remote sync\n";
  const file = {
    path: "AGENTS.md",
    content_kind: "instruction" as const,
    size: Buffer.byteLength(content),
    content_hash: digest(content),
    media_type: "text/markdown" as const,
    action: "modify" as const,
    content,
  };
  const refs = [{
    path: file.path,
    content_kind: file.content_kind,
    size: file.size,
    content_hash: file.content_hash,
    media_type: file.media_type,
    action: file.action,
  }];
  return {
    actor_id: "actor_owner",
    idempotency_key: "remote_sync_commit_0001",
    expected_revision: "0",
    source: {
      project_id: "prj_remote_sync",
      branch_name: "feature/contracts",
      actor_id: "actor_owner",
      commit_sha: "a".repeat(40),
      client_id: "cli_remote_sync",
      change_key: "change_remote_sync",
    },
    seed: {
      schema_version: 1 as const,
      project_id: "prj_remote_sync",
      branch_name: "feature/contracts",
      commit_sha: "a".repeat(40),
      project_version: "pv_remote_sync_1",
      artifact_id: "art_remote_sync_1",
      manifest_hash: digest(JSON.stringify(refs)),
      file_count: 1,
      changed_file_count: 1,
      uploaded_at: "2026-08-15T01:00:00.000Z",
      diff_ref: "diff_remote_sync_1",
      changed_paths: ["AGENTS.md"],
      files: [file],
    },
  };
}

class FakeClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  readonly state = {
    receipt: null as Record<string, unknown> | null,
    pointer: null as Record<string, unknown> | null,
    activeLease: null as Record<string, unknown> | null,
    committed: false,
  };
  failOnFileInsert = false;
  failOnArtifactInsert = false;
  duplicateArtifact = false;
  failOnReceiptInsert = false;
  forceRevisionRace = false;
  private beforeTransaction: typeof this.state | null = null;
  release(): void {}

  async query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }> {
    this.queries.push({ text, values });
    if (/^BEGIN/u.test(text)) {
      this.beforeTransaction = structuredClone(this.state);
      return { rowCount: 0, rows: [] };
    }
    if (/^COMMIT/u.test(text)) { this.state.committed = true; this.beforeTransaction = null; return { rowCount: 0, rows: [] }; }
    if (/^ROLLBACK/u.test(text)) {
      if (this.beforeTransaction !== null) {
        this.state.receipt = this.beforeTransaction.receipt;
        this.state.pointer = this.beforeTransaction.pointer;
        this.state.activeLease = this.beforeTransaction.activeLease;
        this.state.committed = this.beforeTransaction.committed;
        this.beforeTransaction = null;
      }
      return { rowCount: 0, rows: [] };
    }
    if (/FROM remote_sync_commit_receipts/u.test(text)) {
      return this.state.receipt === null || this.state.receipt.idempotency_key !== values?.[2]
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [this.state.receipt] };
    }
    if (/FROM remote_sync_http_active_leases/u.test(text)) {
      return this.state.activeLease === null
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [this.state.activeLease] };
    }
    if (/FROM remote_sync_branch_pointers/u.test(text)) {
      return this.state.pointer === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [this.state.pointer] };
    }
    if (/SELECT 1 FROM projects/u.test(text)) return { rowCount: 1, rows: [{ ok: 1 }] };
    if (/INSERT INTO branch_snapshot_blobs/u.test(text)) return { rowCount: 1, rows: [{ content_hash: values?.[0] }] };
    if (/INSERT INTO branch_snapshots/u.test(text)) {
      const [project_id, branch_name, commit_sha, project_version, artifact_id, manifest_hash] = values ?? [];
      return { rowCount: 1, rows: [{ project_id, branch_name, commit_sha, project_version, artifact_id, manifest_hash,
        schema_version: 1, file_count: 1, changed_file_count: 1,
        uploaded_at: new Date(String(values?.[9])).toISOString(), diff_ref: values?.[10],
        changed_paths: JSON.parse(String(values?.[11])) as string[] }] };
    }
    if (/INSERT INTO branch_snapshot_files/u.test(text)) {
      if (this.failOnFileInsert) throw new Error("injected branch snapshot failure");
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT path, content_kind/u.test(text)) return { rowCount: 1, rows: [{ path: "AGENTS.md", content_kind: "instruction", size_bytes: 14, content_hash: digest("# remote sync\n"), media_type: "text/markdown", action: "modify" }] };
    if (/INSERT INTO remote_sync_artifacts/u.test(text)) {
      if (this.failOnArtifactInsert) throw new Error("injected artifact failure");
      if (this.duplicateArtifact) {
        const duplicate = new Error("duplicate artifact") as Error & { code: string };
        duplicate.code = "23505";
        throw duplicate;
      }
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO remote_sync_versions/u.test(text)) return { rowCount: 1, rows: [] };
    if (/INSERT INTO remote_sync_branch_pointers/u.test(text)) {
      this.state.pointer = { revision: String(values?.[2]), generation: values?.[3], project_version: values?.[4] };
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO remote_sync_commit_receipts/u.test(text)) {
      if (this.failOnReceiptInsert) throw new Error("injected receipt failure");
      this.state.receipt = {
        idempotency_key: values?.[2],
        payload_hash: values?.[3],
        source_json: values?.[4],
        expected_revision: values?.[5],
        project_version: values?.[6],
        artifact_id: values?.[7],
        manifest_hash: values?.[8],
        commit_sha: values?.[9],
        record_json: typeof values?.[10] === "string"
          ? JSON.parse(values[10] as string) as Record<string, unknown>
          : values?.[10],
      };
      return { rowCount: 1, rows: [] };
    }
    if (/UPDATE remote_sync_branch_pointers/u.test(text)) {
      if (this.forceRevisionRace) return { rowCount: 0, rows: [] };
      this.state.pointer = { revision: String(values?.[2]), generation: values?.[3], project_version: values?.[4] };
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
}

function poolFor(client: FakeClient) {
  return { connect: async () => client };
}

describe("PostgreSQL Remote Sync transaction adapter", () => {
  it("commits version, artifact, branch snapshot, pointer, and receipt on one client", async () => {
    const client = new FakeClient();
    const port = createPgRemoteSyncCommitPort({ pool: poolFor(client) as never });

    const result = await port.commitSnapshot(input());

    expect(result.outcome).toBe("new");
    expect(client.queries[0]?.text).toBe("BEGIN");
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
    expect(client.queries.filter((query) => /INSERT INTO (remote_sync_versions|remote_sync_artifacts|branch_snapshots|remote_sync_branch_pointers|remote_sync_commit_receipts)/u.test(query.text)).length).toBe(5);
    expect(client.queries.some((query) => /^ROLLBACK/u.test(query.text))).toBe(false);
  });

  it("rolls back every durable write when snapshot persistence fails", async () => {
    const client = new FakeClient();
    client.failOnFileInsert = true;
    const port = createPgRemoteSyncCommitPort({ pool: poolFor(client) as never });

    await expect(port.commitSnapshot(input())).rejects.toThrow("injected branch snapshot failure");
    expect(client.queries.some((query) => /^COMMIT/u.test(query.text))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("replays the exact receipt and rejects a changed payload without another write", async () => {
    const client = new FakeClient();
    const port = createPgRemoteSyncCommitPort({ pool: poolFor(client) as never });
    const first = await port.commitSnapshot(input());
    const replay = await port.commitSnapshot(input());

    expect(first.outcome).toBe("new");
    expect(replay.outcome).toBe("replay");
    expect(replay.record).toEqual(first.record);
    expect(client.queries.find((query) => /pg_advisory_xact_lock/u.test(query.text))?.values?.[0]).not.toContain("\0");

    const changed = input();
    changed.seed.project_version = "pv_remote_sync_changed";
    const conflict = await port.commitSnapshot(changed);
    expect(conflict).toEqual({ outcome: "conflict", reason_code: "BRANCH_SNAPSHOT_IDENTITY_CONFLICT" });

    const tampered = new FakeClient();
    const tamperedPort = createPgRemoteSyncCommitPort({ pool: poolFor(tampered) as never });
    await tamperedPort.commitSnapshot(input());
    if (tampered.state.receipt === null) throw new Error("receipt fixture missing");
    tampered.state.receipt.source_json = JSON.stringify({ ...input().source, client_id: "cli_tampered" });
    await expect(tamperedPort.commitSnapshot(input())).rejects.toThrow("REMOTE_SYNC_RECEIPT_INVALID");
  });

  it("maps a database uniqueness race to a stable identity conflict after rollback", async () => {
    const client = new FakeClient();
    client.duplicateArtifact = true;
    const port = createPgRemoteSyncCommitPort({ pool: poolFor(client) as never });

    await expect(port.commitSnapshot(input())).resolves.toEqual({
      outcome: "conflict", reason_code: "BRANCH_SNAPSHOT_IDENTITY_CONFLICT"
    });
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("accepts opaque revisions, preserves RFC3339 spelling, and maps wrapped CAS conflicts", async () => {
    const client = new FakeClient();
    const port = createPgRemoteSyncCommitPort({ pool: poolFor(client) as never });
    const first = input();
    first.expected_revision = "revision_0001";
    first.seed.uploaded_at = "2026-08-15T03:00:00+02:00";
    const created = await port.commitSnapshot(first);
    expect(created.outcome).toBe("new");
    if (created.outcome !== "new") throw new Error("expected new result");
    expect(created.record.uploaded_at).toBe("2026-08-15T01:00:00.000Z");
    const highPrecision = input();
    highPrecision.seed.uploaded_at = "2026-08-15T01:00:00.123456Z";
    await expect(port.commitSnapshot(highPrecision)).rejects.toThrow(
      "BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID",
    );

    const next = input();
    next.expected_revision = first.seed.project_version;
    next.idempotency_key = "remote_sync_commit_0002";
    next.seed.project_version = "pv_remote_sync_2";
    next.seed.artifact_id = "art_remote_sync_2";
    client.forceRevisionRace = true;
    await expect(port.commitSnapshot(next)).resolves.toEqual({
      outcome: "conflict", reason_code: "BRANCH_SNAPSHOT_REVISION_CONFLICT"
    });

    const snapshotConflict = createPgRemoteSyncCommitPort({
      pool: poolFor(new FakeClient()) as never,
      branchSnapshots: {
        async persistSnapshotWithClient() {
          throw new Error("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
        },
      } as never,
    });
    await expect(snapshotConflict.commitSnapshot(input())).resolves.toEqual({
      outcome: "conflict", reason_code: "BRANCH_SNAPSHOT_IDENTITY_CONFLICT"
    });
  });

  it("fences a stale prepared lease before any snapshot write after release and reacquire", async () => {
    const client = new FakeClient();
    const stale = input();
    const staleLease = {
      schema_version: 1 as const,
      lease_id: "lease_old",
      lease_token: `lease_${"A".repeat(43)}`,
      generation: 1,
      project_id: stale.source.project_id,
      branch_name: stale.source.branch_name,
      actor_id: stale.source.actor_id,
      expires_at: "2026-08-15T02:00:00.000Z",
    };
    const fenced = { ...stale, lease_fence: staleLease };
    client.state.activeLease = {
      lease_id: "lease_new",
      lease_token: `lease_${"B".repeat(43)}`,
      generation: 2,
      expires_at: "2026-08-15T03:00:00.000Z",
      source_json: JSON.stringify(stale.source),
    };
    const port = createPgRemoteSyncCommitPort({
      pool: poolFor(client) as never,
      now: () => new Date("2026-08-15T01:00:00.000Z"),
    });

    await expect(port.commitSnapshot(fenced)).resolves.toEqual({
      outcome: "conflict",
      reason_code: "BRANCH_SNAPSHOT_LEASE_FENCED",
    });
    expect(client.queries.some((query) => /INSERT INTO (branch_snapshots|remote_sync_artifacts|remote_sync_versions|remote_sync_branch_pointers|remote_sync_commit_receipts)/u.test(query.text))).toBe(false);
    expect(client.queries.findIndex((query) => /remote_sync_http_active_leases/u.test(query.text)))
      .toBeGreaterThan(client.queries.findIndex((query) => /pg_advisory_xact_lock/u.test(query.text)));
  });

  it.each([
    ["artifact", "failOnArtifactInsert", "injected artifact failure"],
    ["receipt", "failOnReceiptInsert", "injected receipt failure"],
  ] as const)("rolls back when the %s phase fails", async (_phase, flag, message) => {
    const client = new FakeClient();
    client[flag] = true;
    const port = createPgRemoteSyncCommitPort({ pool: poolFor(client) as never });

    await expect(port.commitSnapshot(input())).rejects.toThrow(message);
    expect(client.queries.some((query) => /^COMMIT/u.test(query.text))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });
});
