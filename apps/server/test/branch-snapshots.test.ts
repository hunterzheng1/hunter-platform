import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { platformInformationPageSchema, platformInformationQuerySchema, validateBranchFilesPullConfirmation } from "@hunter-harness/contracts";
import { describe, expect, it } from "vitest";
import { createBranchSnapshotModule, MemoryBranchSnapshotPort, readBranchSnapshot, type BranchSnapshotSeed, type SnapshotIdentity } from "../src/branch-snapshots/index.js";

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function seed(overrides: Partial<BranchSnapshotSeed> = {}): BranchSnapshotSeed {
  const content = "# agent\n";
  const value: BranchSnapshotSeed = { schema_version: 1, project_id: "prj_stage02", branch_name: "main", commit_sha: "a".repeat(40), project_version: "pv_0002", artifact_id: "art_main_0002", manifest_hash: "", file_count: 1, changed_file_count: 1, uploaded_at: "2026-08-13T08:00:00.000Z", diff_ref: "diff_main_0002", files: [{ path: "AGENTS.md", content_kind: "instruction", size: Buffer.byteLength(content), content_hash: digest(content), media_type: "text/markdown", content }], changed_paths: ["AGENTS.md"], ...overrides };
  const refs = value.files.map((file) => ({ path: file.path, content_kind: file.content_kind, size: file.size, content_hash: file.content_hash, media_type: file.media_type, ...(file.action === undefined ? {} : { action: file.action }) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { ...value, manifest_hash: overrides.manifest_hash ?? digest(JSON.stringify(refs)) };
}
const identity = (value: BranchSnapshotSeed): SnapshotIdentity => ({ project_id: value.project_id, branch_name: value.branch_name, commit_sha: value.commit_sha, project_version: value.project_version, artifact_id: value.artifact_id, manifest_hash: value.manifest_hash });
const base = { schema_version: 1 as const, actor_id: "actor_owner", project_id: "prj_stage02", accessible_project_ids: ["prj_stage02"] };
const moduleFor = (port: MemoryBranchSnapshotPort) => createBranchSnapshotModule({ repository_port: port, blob_read_port: port, cursor_verifier_port: port, restore_conflict_port: port });

describe("BranchSnapshotModule", () => {
  it("lists latest branch snapshots with stable unique ordering", async () => {
    const port = MemoryBranchSnapshotPort.fromSnapshots([seed({ project_version: "pv_0001", artifact_id: "art_1", uploaded_at: "2026-08-12T00:00:00.000Z" }), seed(), seed({ branch_name: "feature/a", project_version: "pv_0003", artifact_id: "art_3", commit_sha: "c".repeat(40) })]);
    const page = await moduleFor(port).listBranches({ ...base, cursor: null, limit: 10 });
    expect(page.items.map((v) => [v.branch_name, v.project_version])).toEqual([["main", "pv_0002"], ["feature/a", "pv_0003"]]);
  });

  it("uses scoped server-signed opaque cursors and rejects forged or cross-scope tokens", async () => {
    const port = MemoryBranchSnapshotPort.fromSnapshots([seed(), seed({ project_version: "pv_0001", artifact_id: "art_1", uploaded_at: "2026-08-12T00:00:00.000Z" })]); const module = moduleFor(port);
    const first = await module.listSnapshotVersions({ ...base, branch_name: "main", cursor: null, limit: 1 });
    expect(first.next_cursor).toEqual(expect.stringMatching(/^[A-Za-z0-9_.-]{16,512}$/u));
    await expect(module.listSnapshotVersions({ ...base, branch_name: "other", cursor: first.next_cursor, limit: 1 })).rejects.toThrow("BRANCH_SNAPSHOT_CURSOR_INVALID");
    await expect(module.listBranches({ ...base, cursor: "eyJvZmZzZXQiOjF9.forged", limit: 1 })).rejects.toThrow();
  });

  it("stores no body in repository records and deduplicates blobs by hash", () => {
    const port = MemoryBranchSnapshotPort.fromSnapshots([seed(), seed({ branch_name: "copy", project_version: "pv_copy", artifact_id: "art_copy" })]);
    expect(JSON.stringify(port.repositoryRecords())).not.toContain("# agent"); expect(port.blobCount()).toBe(1);
  });

  it("lists refs without content and reads detail through exact identity plus verified blob", async () => {
    const source = seed(); const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots([source]));
    const page = await module.listSnapshotFiles({ ...base, identity: identity(source), cursor: null, limit: 10 });
    expect(page.items).toHaveLength(1); expect(JSON.stringify(page)).not.toContain("# agent");
    await expect(module.getSnapshotFile({ ...base, identity: identity(source), path: "AGENTS.md" })).resolves.toMatchObject({ ...identity(source), content: "# agent\n", content_hash: digest("# agent\n") });
    await expect(module.getSnapshotFile({ ...base, identity: { ...identity(source), artifact_id: "art_wrong" }, path: "AGENTS.md" })).rejects.toThrow();
  });

  it("binds both sides of diff to full immutable identities", async () => {
    const from = seed({ project_version: "pv_0001", artifact_id: "art_1", uploaded_at: "2026-08-12T00:00:00.000Z" }); const to = seed(); const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots([from, to]));
    await expect(module.getSnapshotDiff({ ...base, from: identity(from), to: identity(to) })).resolves.toMatchObject({ project_id: "prj_stage02", from: identity(from), to: identity(to), diff_ref: "diff_main_0002" });
    await expect(module.getSnapshotDiff({ ...base, from: { ...identity(from), manifest_hash: digest("wrong") }, to: identity(to) })).rejects.toThrow("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
  });

  it("rejects mismatched or hostile repository response identities without executing accessors", async () => {
    const source = seed();
    class WrongIdentityPort extends MemoryBranchSnapshotPort {
      override async listFiles(input: Parameters<MemoryBranchSnapshotPort["listFiles"]>[0]) {
        const result = await super.listFiles(input);
        return { ...result, identity: { ...result.identity, artifact_id: "art_wrong" } };
      }
    }
    await expect(moduleFor(new WrongIdentityPort([source])).listSnapshotFiles({ ...base, identity: identity(source), cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
    let reads = 0;
    class HostileDiffPort extends MemoryBranchSnapshotPort {
      override async getSnapshot() {
        return Object.defineProperty({}, "project_id", { enumerable: true, get() { reads += 1; return "prj_stage02"; } }) as never;
      }
    }
    await expect(moduleFor(new HostileDiffPort([source])).getSnapshotDiff({ ...base, from: null, to: identity(source) })).rejects.toThrow("BRANCH_SNAPSHOT_INPUT_INVALID");
    expect(reads).toBe(0);
  });

  it("fails closed outside actor allowlist before repository access", async () => { const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots([seed()])); await expect(module.listBranches({ ...base, accessible_project_ids: ["prj_other"], cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_FORBIDDEN"); });

  it("creates only a validator-compatible restore preview bound to client, scope and conflicts", async () => {
    const source = seed(); const port = MemoryBranchSnapshotPort.fromSnapshots([source], [{ project_id: source.project_id, artifact_id: source.artifact_id, path: "AGENTS.md", reason_code: "SYNC_CONTENT_CONFLICT" }]); const preview = await moduleFor(port).previewRestore({ ...base, client_id: "cli_stage13", intent: { schema_version: 1, contract_kind: "branch_files_pull_preview_intent", project_id: source.project_id, source_branch_name: source.branch_name, source_commit_sha: source.commit_sha, source_artifact_id: source.artifact_id, source_project_version: source.project_version, scopes: ["branch_files"], selected_paths: ["AGENTS.md"], preview_only: true } });
    const confirmation = { schema_version: 1, contract_kind: "branch_files_pull_confirmation_intent", project_id: preview.project_id, source_ref: preview.source_ref, source_version: preview.source_version, scopes: preview.scopes, preview_hash: preview.preview_hash, action: "continue", idempotency_key: "restore_stage13", conflict_decisions: [{ path: "AGENTS.md", resolution: "accept_remote", expected_preview_hash: preview.preview_hash, source_artifact_id: preview.source_version.artifact_id, source_project_version: preview.source_version.project_version }] };
    expect(validateBranchFilesPullConfirmation(JSON.stringify(preview), JSON.stringify(confirmation))).toMatchObject({ ok: true }); expect(JSON.stringify(preview)).not.toContain("content");
  });

  it("rejects duplicate branch version identity and duplicate paths", () => { expect(() => MemoryBranchSnapshotPort.fromSnapshots([seed(), seed()])).toThrow("BRANCH_SNAPSHOT_IDENTITY_CONFLICT"); const file = seed().files.at(0); if (file === undefined) throw new Error("fixture missing"); expect(() => MemoryBranchSnapshotPort.fromSnapshots([seed({ files: [file, file], file_count: 2 })])).toThrow(); });

  it("rejects blob hash, byte size and canonical manifest mismatches", () => { const file = seed().files.at(0); if (file === undefined) throw new Error("fixture missing"); expect(() => MemoryBranchSnapshotPort.fromSnapshots([seed({ files: [{ ...file, content: "tampered" }] })])).toThrow(); expect(() => MemoryBranchSnapshotPort.fromSnapshots([seed({ files: [{ ...file, size: 999 }] })])).toThrow("BRANCH_SNAPSHOT_BLOB_SIZE_MISMATCH"); expect(() => MemoryBranchSnapshotPort.fromSnapshots([seed({ manifest_hash: digest("wrong") })])).toThrow("BRANCH_SNAPSHOT_MANIFEST_HASH_MISMATCH"); });

  it("rejects getters and array extra descriptors without execution", async () => { let reads = 0; const hostile = Object.defineProperty({}, "project_id", { enumerable: true, get() { reads += 1; return "prj_stage02"; } }); const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots([seed()])); await expect(module.listBranches(hostile as never)).rejects.toThrow("BRANCH_SNAPSHOT_INPUT_INVALID"); expect(reads).toBe(0); const ids = ["prj_stage02"]; Object.defineProperty(ids, "extra", { enumerable: true, value: true }); await expect(module.listBranches({ ...base, accessible_project_ids: ids, cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_INPUT_INVALID"); });

  it("rejects unknown camel and snake versions", () => { expect(readBranchSnapshot(JSON.stringify({ schemaVersion: 2 }))).toEqual({ ok: false, reason_code: "BRANCH_SNAPSHOT_VERSION_UNSUPPORTED" }); expect(readBranchSnapshot(JSON.stringify({ schema_version: 2 }))).toEqual({ ok: false, reason_code: "BRANCH_SNAPSHOT_VERSION_UNSUPPORTED" }); });

  it("reads exact v1 and explicit unmarked legacy v0 fixtures", async () => { const current = await readFile(new URL("./fixtures/branch-snapshot-v1-current.json", import.meta.url), "utf8"); const legacy = await readFile(new URL("./fixtures/branch-snapshot-v0-legacy.json", import.meta.url), "utf8"); expect(readBranchSnapshot(current)).toMatchObject({ ok: true, mode: "current" }); expect(readBranchSnapshot(legacy)).toMatchObject({ ok: true, mode: "legacy_read_only", value: { branch_name: "unmarked" } }); });

  it("passes actor allowlist scope to every repository request and rejects response scope drift", async () => {
    const source = seed();
    class DriftPort extends MemoryBranchSnapshotPort {
      override async listLatestBranches(input: Parameters<MemoryBranchSnapshotPort["listLatestBranches"]>[0]) {
        const result = await super.listLatestBranches(input);
        return { ...result, actor_id: "actor_other" } as never;
      }
    }
    await expect(moduleFor(new DriftPort([source])).listBranches({ ...base, cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
  });

  it("finds restore source across pages and binds actor into preview hash", async () => {
    const seeds = Array.from({ length: 102 }, (_, index) => seed({ project_version: `pv_${String(index).padStart(4, "0")}`, artifact_id: `art_${index}`, uploaded_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));
    const target = seeds.at(0); if (target === undefined) throw new Error("fixture missing");
    const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots(seeds));
    const intent = { schema_version: 1 as const, contract_kind: "branch_files_pull_preview_intent" as const, project_id: target.project_id, source_branch_name: target.branch_name, source_commit_sha: target.commit_sha, source_artifact_id: target.artifact_id, source_project_version: target.project_version, scopes: ["branch_files"] as ["branch_files"], selected_paths: ["AGENTS.md"], preview_only: true as const };
    const owner = await module.previewRestore({ ...base, client_id: "cli_stage13", intent });
    const other = await module.previewRestore({ ...base, actor_id: "actor_other", client_id: "cli_stage13", intent });
    expect(owner.preview_hash).not.toBe(other.preview_hash);
  });

  it("rejects v1 readers whose canonical file refs do not match manifest hash", () => {
    const source = seed(); const record = MemoryBranchSnapshotPort.fromSnapshots([source]).repositoryRecords()[0];
    expect(record).toBeDefined();
    expect(readBranchSnapshot(JSON.stringify({ ...record, manifest_hash: digest("wrong") }))).toEqual({ ok: false, reason_code: "BRANCH_SNAPSHOT_INVALID" });
  });

  it("rejects unpaired surrogate content and preserves scalar UTF-8 roundtrip", async () => {
    const invalid = "bad\ud800"; const file = seed().files[0]; if (file === undefined) throw new Error("fixture missing");
    expect(() => MemoryBranchSnapshotPort.fromSnapshots([seed({ files: [{ ...file, content: invalid, content_hash: digest(invalid), size: Buffer.byteLength(invalid) }] })])).toThrow("BRANCH_SNAPSHOT_BLOB_UTF8_INVALID");
    const scalar = "你好😀\n"; const good = seed({ files: [{ ...file, content: scalar, content_hash: digest(scalar), size: Buffer.byteLength(scalar) }] });
    await expect(moduleFor(MemoryBranchSnapshotPort.fromSnapshots([good])).getSnapshotFile({ ...base, identity: identity(good), path: "AGENTS.md" })).resolves.toMatchObject({ content: scalar });
  });

  it("uses complete codepoint identity tie-breakers and rejects exact duplicate records", async () => {
    const time = "2026-08-13T08:00:00.000Z";
    const left = seed({ branch_name: "a", project_version: "pv_same", artifact_id: "art_a", commit_sha: "a".repeat(40), uploaded_at: time });
    const right = seed({ branch_name: "b", project_version: "pv_same", artifact_id: "art_b", commit_sha: "b".repeat(40), uploaded_at: time });
    const page = await moduleFor(MemoryBranchSnapshotPort.fromSnapshots([right, left])).listBranches({ ...base, cursor: null, limit: 10 });
    expect(page.items.map((item) => item.branch_name)).toEqual(["a", "b"]);
    expect(() => MemoryBranchSnapshotPort.fromSnapshots([left, left])).toThrow("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
  });

  it("rejects non-progressing empty pages and cursor cycles", async () => {
    class EmptyProgressPort extends MemoryBranchSnapshotPort {
      override async listLatestBranches(input: Parameters<MemoryBranchSnapshotPort["listLatestBranches"]>[0]) {
        const result = await super.listLatestBranches(input);
        return { ...result, items: [], next_offset: input.cursor_offset };
      }
    }
    await expect(moduleFor(new EmptyProgressPort([seed()])).listBranches({ ...base, cursor: null, limit: 1 })).rejects.toThrow("BRANCH_SNAPSHOT_PORT_PAGE_INVALID");
    class RestoreCyclePort extends MemoryBranchSnapshotPort {
      override async listVersions(input: Parameters<MemoryBranchSnapshotPort["listVersions"]>[0]) {
        const result = await super.listVersions(input);
        return { ...result, items: [], next_offset: input.cursor_offset };
      }
    }
    const missing = seed({ project_version: "pv_missing", artifact_id: "art_missing" });
    await expect(moduleFor(new RestoreCyclePort([seed()])).previewRestore({ ...base, client_id: "cli_stage13", intent: { schema_version: 1, contract_kind: "branch_files_pull_preview_intent", project_id: missing.project_id, source_branch_name: missing.branch_name, source_commit_sha: missing.commit_sha, source_artifact_id: missing.artifact_id, source_project_version: missing.project_version, scopes: ["branch_files"], selected_paths: ["AGENTS.md"], preview_only: true } })).rejects.toThrow("BRANCH_SNAPSHOT_PORT_PAGE_INVALID");
  });

  it("rejects schema-valid repository records whose manifest does not match file refs in list, diff and restore", async () => {
    const source = seed();
    const poison = (record: ReturnType<MemoryBranchSnapshotPort["repositoryRecords"]>[number]) => ({ ...record, files: record.files.map((file) => ({ ...file, content_hash: digest("poison") })) });
    class PoisonPort extends MemoryBranchSnapshotPort {
      override async listLatestBranches(input: Parameters<MemoryBranchSnapshotPort["listLatestBranches"]>[0]) { const result = await super.listLatestBranches(input); return { ...result, items: result.items.map(poison) }; }
      override async listVersions(input: Parameters<MemoryBranchSnapshotPort["listVersions"]>[0]) { const result = await super.listVersions(input); return { ...result, items: result.items.map(poison) }; }
      override async getSnapshot(input: Parameters<MemoryBranchSnapshotPort["getSnapshot"]>[0]) { const result = await super.getSnapshot(input); return result === null ? null : { ...result, record: poison(result.record) }; }
    }
    const module = moduleFor(new PoisonPort([source]));
    await expect(module.listBranches({ ...base, cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_MANIFEST_HASH_MISMATCH");
    await expect(module.getSnapshotDiff({ ...base, from: null, to: identity(source) })).rejects.toThrow("BRANCH_SNAPSHOT_MANIFEST_HASH_MISMATCH");
    await expect(module.previewRestore({ ...base, client_id: "cli_stage13", intent: { schema_version: 1, contract_kind: "branch_files_pull_preview_intent", project_id: source.project_id, source_branch_name: source.branch_name, source_commit_sha: source.commit_sha, source_artifact_id: source.artifact_id, source_project_version: source.project_version, scopes: ["branch_files"], selected_paths: ["AGENTS.md"], preview_only: true } })).rejects.toThrow("BRANCH_SNAPSHOT_MANIFEST_HASH_MISMATCH");
  });

  it("paginates all project versions across branches with one stable cursor", async () => {
    const time = "2026-08-13T08:00:00.000Z";
    const seeds = [
      seed({ branch_name: "z", project_version: "pv_aaa", artifact_id: "art_z", commit_sha: "f".repeat(40), uploaded_at: time }),
      ...["c", "a", "b"].map((branch) => seed({ branch_name: branch, project_version: "pv_same", artifact_id: `art_${branch}`, commit_sha: branch.repeat(40), uploaded_at: time }))
    ];
    const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots(seeds));
    const first = await module.listProjectSnapshotVersions({ ...base, cursor: null, limit: 2 });
    const second = await module.listProjectSnapshotVersions({ ...base, cursor: first.next_cursor, limit: 2 });
    expect([...first.items, ...second.items].map((item) => item.branch_name)).toEqual(["z", "a", "b", "c"]);
    expect(first.next_cursor).toEqual(expect.any(String)); expect(second.next_cursor).toBeNull();
  });

  it("rejects forged and cross-scope project-version cursors", async () => {
    const seeds = [seed(), seed({ branch_name: "other", artifact_id: "art_other", project_version: "pv_other" })]; const module = moduleFor(MemoryBranchSnapshotPort.fromSnapshots(seeds));
    const first = await module.listProjectSnapshotVersions({ ...base, cursor: null, limit: 1 });
    await expect(module.listBranches({ ...base, cursor: first.next_cursor, limit: 1 })).rejects.toThrow("BRANCH_SNAPSHOT_CURSOR_INVALID");
    await expect(module.listProjectSnapshotVersions({ ...base, cursor: `${first.next_cursor}x`, limit: 1 })).rejects.toThrow("BRANCH_SNAPSHOT_CURSOR_INVALID");
  });

  it("emits a single base64url cursor accepted by the public query and page contracts", async () => {
    const port = MemoryBranchSnapshotPort.fromSnapshots([seed(), seed({ branch_name: "other", artifact_id: "art_other", project_version: "pv_other" })]);
    const module = moduleFor(port);
    const first = await module.listProjectSnapshotVersions({ ...base, cursor: null, limit: 1 });
    const cursor = first.next_cursor; const item = first.items[0];
    expect(cursor).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{16,512}$/u));
    expect(platformInformationQuerySchema.safeParse({ schema_version: 1, contract_kind: "query", view: "version_records", project_id: base.project_id, query_scope: { actor_id: base.actor_id, accessible_project_ids: base.accessible_project_ids, content_types: ["branch_file"] }, limit: 1, cursor, cursor_verification: "server_port_required", sort: "uploaded_at_desc_snapshot_version_asc" }).success).toBe(true);
    expect(platformInformationPageSchema.safeParse({ schema_version: 1, contract_kind: "page", view: "version_records", project_id: base.project_id, page_state: "ready", sort: "uploaded_at_desc_snapshot_version_asc", items: item === undefined ? [] : [{ item_kind: "version_record", snapshot_version: item.project_version, branch_name: item.branch_name, commit_sha: item.commit_sha, uploaded_at: item.uploaded_at, file_count: item.file_count, changed_file_count: item.changed_file_count, diff_ref: item.diff_ref, sort_key: `${item.uploaded_at}\0${item.project_version}` }], next_cursor: cursor, failures: [] }).success).toBe(true);
    await expect(port.verify(`${Buffer.from(JSON.stringify({ actor_id: base.actor_id, project_id: base.project_id, query_kind: "project_versions", offset: 1 })).toString("base64url")}.legacy`, { actor_id: base.actor_id, project_id: base.project_id, query_kind: "project_versions" })).rejects.toThrow("BRANCH_SNAPSHOT_CURSOR_INVALID");
  });

  it("stores fixed opaque cursors server-side and uniquely reuses canonical capabilities", async () => {
    const port = MemoryBranchSnapshotPort.fromSnapshots([seed()]);
    const actor_id = "a".repeat(160); const project_id = `prj_${"p".repeat(156)}`;
    const capability = { actor_id, project_id, query_kind: "files" as const, identity: { project_id, branch_name: "b".repeat(160), commit_sha: "a".repeat(64), project_version: "v".repeat(160), artifact_id: "r".repeat(160), manifest_hash: `sha256:${"f".repeat(64)}` }, offset: 9 };
    const first = await port.issue(capability); const second = await port.issue({ ...capability, identity: { ...capability.identity } });
    expect(first).toBe(second); expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(port.verify(first, { actor_id, project_id, query_kind: "files", identity: capability.identity })).resolves.toBe(9);
    for (const invalid of [{ ...capability, offset: -1 }, { ...capability, offset: Number.MAX_SAFE_INTEGER + 1 }, { ...capability, extra: true }, { ...capability, actor_id: "" }, { ...capability, query_kind: "versions" }]) await expect(port.issue(invalid as never)).rejects.toThrow("BRANCH_SNAPSHOT_CURSOR_INVALID");
  });

  it("fails closed on project-version ACL and hostile manifest drift", async () => {
    const source = seed();
    await expect(moduleFor(MemoryBranchSnapshotPort.fromSnapshots([source])).listProjectSnapshotVersions({ ...base, accessible_project_ids: ["prj_other"], cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_FORBIDDEN");
    class PoisonVersionPort extends MemoryBranchSnapshotPort { override async listProjectVersions(input: Parameters<MemoryBranchSnapshotPort["listProjectVersions"]>[0]) { const result = await super.listProjectVersions(input); return { ...result, items: result.items.map((item) => ({ ...item, files: item.files.map((file) => ({ ...file, content_hash: digest("poison") })) })) }; } }
    await expect(moduleFor(new PoisonVersionPort([source])).listProjectSnapshotVersions({ ...base, cursor: null, limit: 10 })).rejects.toThrow("BRANCH_SNAPSHOT_MANIFEST_HASH_MISMATCH");
  });

  it("requires exact safe project-version page progress from hostile repositories", async () => {
    const source = seed();
    for (const next_offset of [2, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      class InvalidProgressPort extends MemoryBranchSnapshotPort {
        override async listProjectVersions(input: Parameters<MemoryBranchSnapshotPort["listProjectVersions"]>[0]) {
          const result = await super.listProjectVersions(input);
          return { ...result, next_offset };
        }
      }
      await expect(moduleFor(new InvalidProgressPort([source])).listProjectSnapshotVersions({ ...base, cursor: null, limit: 1 })).rejects.toThrow("BRANCH_SNAPSHOT_PORT_PAGE_INVALID");
    }
  });
});
