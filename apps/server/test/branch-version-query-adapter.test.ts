import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createBranchSnapshotModule,
  MemoryBranchSnapshotPort,
  type BranchSnapshotModule,
  type BranchSnapshotSeed,
  type BranchSnapshotSummary
} from "../src/branch-snapshots/index.js";
import { createBranchVersionQueryAdapter } from "../src/branch-version-query/index.js";

const identity = {
  project_id: "prj_stage13",
  branch_name: "main",
  commit_sha: "a".repeat(40),
  project_version: "pv_0002",
  artifact_id: "art_0002",
  manifest_hash: `sha256:${"b".repeat(64)}`
};
const digest = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function snapshotSeed(overrides: Partial<BranchSnapshotSeed> = {}): BranchSnapshotSeed {
  const content = "# agent\n";
  const value: BranchSnapshotSeed = {
    schema_version: 1, project_id: "prj_stage13", branch_name: "main",
    commit_sha: "a".repeat(40), project_version: "pv_0002", artifact_id: "art_0002",
    manifest_hash: "", file_count: 1, changed_file_count: 1,
    uploaded_at: "2026-08-13T08:00:00.000Z", diff_ref: "diff_main_0002",
    files: [{ path: "AGENTS.md", content_kind: "instruction", size: Buffer.byteLength(content),
      content_hash: digest(content), media_type: "text/markdown", content }],
    changed_paths: ["AGENTS.md"], ...overrides
  };
  const refs = value.files.map((file) => ({
    path: file.path, content_kind: file.content_kind, size: file.size,
    content_hash: file.content_hash, media_type: file.media_type,
    ...(file.action === undefined ? {} : { action: file.action })
  }));
  return { ...value, manifest_hash: overrides.manifest_hash ?? digest(JSON.stringify(refs)) };
}

function realSnapshotModule(seeds: readonly BranchSnapshotSeed[]): BranchSnapshotModule {
  const port = MemoryBranchSnapshotPort.fromSnapshots(seeds);
  return createBranchSnapshotModule({
    repository_port: port, blob_read_port: port,
    cursor_verifier_port: port, restore_conflict_port: port
  });
}

const branch: BranchSnapshotSummary = {
  schema_version: 1,
  ...identity,
  file_count: 3,
  changed_file_count: 1,
  uploaded_at: "2026-08-13T08:00:00.000Z",
  diff_ref: "diff_main_0002"
};

function fakeModule(overrides: Partial<BranchSnapshotModule> = {}): BranchSnapshotModule {
  return {
    async listBranches() { return { items: [branch], next_cursor: null }; },
    async listProjectSnapshotVersions() { return { items: [branch], next_cursor: null }; },
    async listSnapshotVersions() { return { items: [branch], next_cursor: null }; },
    async listSnapshotFiles() { return { items: [], next_cursor: null }; },
    async getSnapshotFile() { throw new Error("unused"); },
    async getSnapshotDiff() { throw new Error("unused"); },
    async getSnapshotByVersionRef() { return null; },
    async getSnapshotPredecessor() { return null; },
    async previewRestore() { throw new Error("unused"); },
    ...overrides
  };
}

const branchQuery = JSON.stringify({
  schema_version: 1,
  contract_kind: "query",
  view: "branch_files",
  project_id: "prj_stage13",
  query_scope: {
    actor_id: "actor_owner",
    accessible_project_ids: ["prj_stage13"],
    content_types: ["branch_file"]
  },
  limit: 20,
  cursor: null,
  cursor_verification: "server_port_required",
  sort: "uploaded_at_desc_snapshot_version_asc"
});

const scope = {
  actor_id: "actor_owner",
  accessible_project_ids: ["prj_stage13"],
  content_types: ["branch_file"]
};

function detailRequest(view: "branch_files", detailId: string): string {
  return JSON.stringify({ schema_version: 1, contract_kind: "detail_request", view,
    project_id: "prj_stage13", query_scope: scope, detail_id: detailId });
}

describe("BranchVersionQueryAdapter", () => {
  it("projects a bounded branch list through the formal BranchSnapshotModule without body content", async () => {
    let received: unknown;
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async listBranches(input) {
        received = input;
        return { items: [branch], next_cursor: null };
      }
    }));

    const result = await adapter.query(branchQuery);

    expect(result).toEqual({
      ok: true,
      mode: "current",
      value: {
        schema_version: 1,
        contract_kind: "page",
        view: "branch_files",
        project_id: "prj_stage13",
        page_state: "ready",
        sort: "uploaded_at_desc_snapshot_version_asc",
        items: [{
          item_kind: "branch_snapshot",
          branch_name: "main",
          snapshot_version: "pv_0002",
          commit_sha: "a".repeat(40),
          uploaded_at: "2026-08-13T08:00:00.000Z",
          file_count: 3,
          changed_file_count: 1,
          detail_id: "bf_main~pv_0002",
          sort_key: "2026-08-13T08:00:00.000Z|pv_0002|main|art_0002"
        }],
        next_cursor: null,
        failures: []
      }
    });
    expect(received).toEqual({
      schema_version: 1,
      actor_id: "actor_owner",
      project_id: "prj_stage13",
      accessible_project_ids: ["prj_stage13"],
      limit: 20,
      cursor: null
    });
    expect(JSON.stringify(result)).not.toContain("content");
  });

  it("lists exact snapshot file refs without body content", async () => {
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async listSnapshotFiles(input) {
        expect(input.identity).toEqual(identity);
        return { items: [{ path: "AGENTS.md", content_kind: "branch_file", size: 8,
          content_hash: `sha256:${"c".repeat(64)}`, action: "modify" }], next_cursor: null };
      }
    }));
    const result = await adapter.listFiles(branchQuery, JSON.stringify(identity));
    expect(result).toMatchObject({ ok: true, value: { identity,
      items: [{ path: "AGENTS.md", action: "modify" }] } });
    expect(JSON.stringify(result)).not.toContain("content\":");
  });

  it("loads branch file content only by full immutable identity and an exactly bound detail id", async () => {
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async getSnapshotFile(input) {
        expect(input.identity).toEqual(identity);
        return { ...identity, path: "AGENTS.md", content_kind: "branch_file", size: 8,
          content_hash: digest("# Agent\n"), media_type: "text/markdown", content: "# Agent\n" };
      }
    }));
    const locator = { detail_id: "file_main_agents", identity, path: "AGENTS.md" };
    await expect(adapter.detail(detailRequest("branch_files", locator.detail_id), JSON.stringify(locator)))
      .resolves.toMatchObject({ ok: true, mode: "current", value: { detail: {
        detail_kind: "branch_file", content: "# Agent\n"
      } } });
    await expect(adapter.detail(detailRequest("branch_files", "other"), JSON.stringify(locator)))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_DETAIL_INVALID" });
  });

  it("turns preview plus exact 13.1 confirmation into a request-only intent and never writes", async () => {
    const preview = {
      schema_version: 1 as const,
      contract_kind: "branch_files_pull_preview_receipt" as const,
      project_id: identity.project_id,
      source_ref: { project_id: identity.project_id, branch_name: identity.branch_name,
        commit_sha: identity.commit_sha, client_id: "cli_stage13" },
      source_version: { branch_name: identity.branch_name, commit_sha: identity.commit_sha,
        artifact_id: identity.artifact_id, project_version: identity.project_version },
      scopes: ["branch_files"] as ["branch_files"],
      selected_paths: ["AGENTS.md", "B.md"],
      preview_hash: `sha256:${"e".repeat(64)}`,
      conflicts: [{ path: "AGENTS.md", reason_code: "SYNC_CONTENT_CONFLICT" as const }]
    };
    let previews = 0;
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async previewRestore() { previews += 1; return preview; }
    }));
    const previewEnvelope = JSON.stringify({ actor_id: "actor_owner",
      accessible_project_ids: [identity.project_id], client_id: "cli_stage13", intent: {
        schema_version: 1, contract_kind: "branch_files_pull_preview_intent",
        project_id: identity.project_id, source_branch_name: identity.branch_name,
        source_commit_sha: identity.commit_sha, source_artifact_id: identity.artifact_id,
        source_project_version: identity.project_version, scopes: ["branch_files"],
        selected_paths: ["AGENTS.md", "B.md"], preview_only: true
      } });
    expect(await adapter.previewRestore(previewEnvelope)).toEqual({ ok: true, value: preview });
    const confirmation = { schema_version: 1, contract_kind: "branch_files_pull_confirmation_intent",
      project_id: identity.project_id, source_ref: preview.source_ref,
      source_version: preview.source_version, scopes: preview.scopes,
      preview_hash: preview.preview_hash, action: "continue", idempotency_key: "restore_stage13",
      conflict_decisions: [{ path: "AGENTS.md", resolution: "accept_remote",
        expected_preview_hash: preview.preview_hash, source_artifact_id: identity.artifact_id,
        source_project_version: identity.project_version }] };
    const confirmed = adapter.confirmRestore(JSON.stringify(preview), JSON.stringify(confirmation));
    expect(confirmed).toMatchObject({ ok: true, value: {
      contract_kind: "branch_files_pull_confirmed_intent", request_only: true,
      project_id: identity.project_id, preview_hash: preview.preview_hash,
      selected_paths: ["AGENTS.md", "B.md"]
    } });
    expect(JSON.stringify(confirmed)).not.toContain("content");
    expect(JSON.stringify(confirmed)).not.toContain("write");
    expect(previews).toBe(1);
  });

  it("rejects a valid restore receipt whose source identity drifts from the input intent", async () => {
    const intent = {
      schema_version: 1, contract_kind: "branch_files_pull_preview_intent",
      project_id: identity.project_id, source_branch_name: identity.branch_name,
      source_commit_sha: identity.commit_sha, source_artifact_id: identity.artifact_id,
      source_project_version: identity.project_version, scopes: ["branch_files"],
      selected_paths: ["AGENTS.md"], preview_only: true
    } as const;
    type Receipt = Awaited<ReturnType<BranchSnapshotModule["previewRestore"]>>;
    const receipt: Receipt = {
      schema_version: 1, contract_kind: "branch_files_pull_preview_receipt",
      project_id: identity.project_id,
      source_ref: { project_id: identity.project_id, branch_name: identity.branch_name,
        commit_sha: identity.commit_sha, client_id: "cli_stage13" },
      source_version: { branch_name: identity.branch_name, commit_sha: identity.commit_sha,
        artifact_id: identity.artifact_id, project_version: identity.project_version },
      scopes: ["branch_files"], selected_paths: ["AGENTS.md"],
      preview_hash: `sha256:${"e".repeat(64)}`, conflicts: []
    };
    const driftedReceipts: Receipt[] = [
      { ...receipt, project_id: "prj_foreign",
        source_ref: { ...receipt.source_ref, project_id: "prj_foreign" } },
      { ...receipt, source_ref: { ...receipt.source_ref, client_id: "cli_foreign" } },
      { ...receipt, source_ref: { ...receipt.source_ref, branch_name: "release" },
        source_version: { ...receipt.source_version, branch_name: "release" } },
      { ...receipt, source_ref: { ...receipt.source_ref, commit_sha: "b".repeat(40) },
        source_version: { ...receipt.source_version, commit_sha: "b".repeat(40) } },
      { ...receipt, source_version: { ...receipt.source_version, artifact_id: "art_foreign" } },
      { ...receipt, source_version: { ...receipt.source_version, project_version: "pv_foreign" } },
      { ...receipt, selected_paths: ["README.md"] },
      { ...receipt, selected_paths: ["README.md"],
        conflicts: [{ path: "README.md", reason_code: "SYNC_CONTENT_CONFLICT" }] },
      { ...receipt, conflicts: [{ path: "README.md", reason_code: "SYNC_CONTENT_CONFLICT" }] }
    ];
    const envelope = JSON.stringify({ actor_id: "actor_owner",
      accessible_project_ids: [identity.project_id], client_id: "cli_stage13", intent });
    for (const drifted of driftedReceipts) {
      const adapter = createBranchVersionQueryAdapter(fakeModule({
        async previewRestore() { return drifted; }
      }));
      await expect(adapter.previewRestore(envelope)).resolves.toEqual({
        ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID"
      });
    }
  });

  it("round-trips a real non-terminal single-segment base64url cursor through 13.1 query and page", async () => {
    const source = realSnapshotModule([
      snapshotSeed(),
      snapshotSeed({ branch_name: "release", project_version: "pv_0001", artifact_id: "art_0001",
        commit_sha: "b".repeat(40), uploaded_at: "2026-08-12T08:00:00.000Z",
        diff_ref: "diff_release_0001" })
    ]);
    const adapter = createBranchVersionQueryAdapter(source);
    const firstRequest = { ...JSON.parse(branchQuery) as Record<string, unknown>, limit: 1 };
    const first = await adapter.query(JSON.stringify(firstRequest));
    expect(first).toMatchObject({ ok: true, mode: "current", value: {
      items: [{ snapshot_version: "pv_0002" }]
    } });
    if (!first.ok || first.mode !== "current") throw new Error("expected current first page");
    const cursor = first.value.next_cursor;
    expect(cursor).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{16,512}$/u));
    expect(cursor).not.toContain(".");

    const second = await adapter.query(JSON.stringify({ ...firstRequest, cursor }));
    expect(second).toMatchObject({ ok: true, mode: "current", value: {
      items: [{ snapshot_version: "pv_0001" }], next_cursor: null
    } });
  });

  it("fails closed on hostile source accessors, identity drift and malformed legacy writes", async () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "items", { enumerable: true, get() {
      reads += 1; return [branch];
    } });
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async listBranches() { return hostile as never; },
      async getSnapshotFile() { return { ...identity, artifact_id: "art_wrong", path: "AGENTS.md",
        content_kind: "branch_file", size: 1, content_hash: `sha256:${"c".repeat(64)}`,
        media_type: "text/markdown", content: "x" }; }
    }));
    await expect(adapter.query(branchQuery)).resolves.toEqual({ ok: false,
      reason_code: "BRANCH_VERSION_SOURCE_INVALID" });
    expect(reads).toBe(0);
    const locator = { detail_id: "file_main_agents", identity, path: "AGENTS.md" };
    await expect(adapter.detail(detailRequest("branch_files", locator.detail_id), JSON.stringify(locator)))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID" });
    expect(adapter.confirmRestore(JSON.stringify({ schemaVersion: 0 }), JSON.stringify({})))
      .toEqual({ ok: false, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" });
  });

  it("rejects project identity drift, over-limit pages and unstable source ordering", async () => {
    const older = { ...branch, project_version: "pv_0001", artifact_id: "art_0001",
      uploaded_at: "2026-08-12T08:00:00.000Z" };
    for (const items of [
      [{ ...branch, project_id: "prj_other" }],
      Array.from({ length: 21 }, (_, index) => ({ ...branch, project_version: `pv_${index}`,
        artifact_id: `art_${index}` })),
      [older, branch]
    ]) {
      const adapter = createBranchVersionQueryAdapter(fakeModule({
        async listBranches() { return { items, next_cursor: null } as never; }
      }));
      await expect(adapter.query(branchQuery)).resolves.toEqual({ ok: false,
        reason_code: "BRANCH_VERSION_SOURCE_INVALID" });
    }
  });

  it("rejects duplicate or unstable file refs and content hash/size drift", async () => {
    const ref = { path: "AGENTS.md", content_kind: "branch_file" as const, size: 8,
      content_hash: digest("# Agent\n") };
    for (const items of [[ref, ref], [{ ...ref, path: "z.md" }, ref]]) {
      const adapter = createBranchVersionQueryAdapter(fakeModule({
        async listSnapshotFiles() { return { items, next_cursor: null }; }
      }));
      await expect(adapter.listFiles(branchQuery, JSON.stringify(identity))).resolves.toEqual({
        ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID"
      });
    }
    const locator = { detail_id: "file_main_agents", identity, path: "AGENTS.md" };
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async getSnapshotFile() { return { ...identity, ...ref, media_type: "text/markdown",
        content: "tampered" }; }
    }));
    await expect(adapter.detail(detailRequest("branch_files", locator.detail_id), JSON.stringify(locator)))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID" });
  });

  it("reads exact current and legacy fixtures but never turns legacy data into restore capability", async () => {
    const current = await readFile(new URL("./fixtures/branch-version-query-v1-current.json", import.meta.url), "utf8");
    const legacy = await readFile(new URL("./fixtures/branch-version-query-v0-legacy.json", import.meta.url), "utf8");
    let sourceReads = 0;
    const adapter = createBranchVersionQueryAdapter(fakeModule({
      async listBranches() { sourceReads += 1; return { items: [branch], next_cursor: null }; }
    }));
    await expect(adapter.query(current)).resolves.toMatchObject({ ok: true, mode: "current" });
    await expect(adapter.query(legacy)).resolves.toMatchObject({ ok: true, mode: "legacy_read_only" });
    expect(sourceReads).toBe(1);
    expect(adapter.confirmRestore(legacy, legacy)).toEqual({ ok: false,
      reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" });
  });

  it("lists snapshot files by bf_ locator with per-file bff_ content locators", async () => {
    const adapter = createBranchVersionQueryAdapter(realSnapshotModule([snapshotSeed()]));

    const result = await adapter.listFilesByDetailId(branchQuery, "bf_main~pv_0002");
    expect(result).toEqual({
      ok: true,
      value: {
        schema_version: 1,
        contract_kind: "branch_files_page",
        project_id: "prj_stage13",
        detail_id: "bf_main~pv_0002",
        items: [{
          path: "AGENTS.md",
          size: Buffer.byteLength("# agent\n"),
          content_hash: digest("# agent\n"),
          detail_id: `bf_main~pv_0002~${"AGENTS.md"}`.replace("bf_main", "bff_main")
        }],
        next_cursor: null
      }
    });

    await expect(adapter.listFilesByDetailId(branchQuery, "bf_main~pv_9999"))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_NOT_FOUND" });
    await expect(adapter.listFilesByDetailId(branchQuery, "garbage"))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_FILES_QUERY_INVALID" });
  });

  it("resolves bff_ locators to exact file content and rejects drift", async () => {
    const adapter = createBranchVersionQueryAdapter(realSnapshotModule([snapshotSeed()]));

    const detail = await adapter.queryDetail(detailRequest("branch_files", "bff_main~pv_0002~AGENTS.md"));
    expect(detail).toMatchObject({
      ok: true,
      value: {
        view: "branch_files",
        detail_id: "bff_main~pv_0002~AGENTS.md",
        detail: { detail_kind: "branch_file", content: "# agent\n", content_hash: digest("# agent\n"), media_type: "text/markdown" }
      }
    });

    await expect(adapter.queryDetail(detailRequest("branch_files", "bff_main~pv_0002~missing.md")))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_NOT_FOUND" });
    await expect(adapter.queryDetail(detailRequest("branch_files", "bff_main~pv_9999~AGENTS.md")))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_NOT_FOUND" });
    await expect(adapter.queryDetail(detailRequest("branch_files", "bf_main~pv_0002")))
      .resolves.toEqual({ ok: false, reason_code: "BRANCH_VERSION_DETAIL_INVALID" });
  });
});
