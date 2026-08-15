import { createHash, randomBytes } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import type { BlobReadPort, BranchRepositoryPageRequest, BranchSnapshotRepositoryPort, CursorCapability, CursorVerifierPort, RepositoryPageEnvelope, RepositoryPageRequest, RestoreConflictReadPort, SnapshotRepositoryPageRequest } from "./ports.js";
import type { BranchSnapshotRecord, BranchSnapshotSeed, SnapshotFileRef, SnapshotIdentity } from "./types.js";
import { branchSnapshotRecordSchema, canonicalSnapshotFileRefs, snapshotPlain, validateSnapshotManifest } from "./module.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const codepoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const identityKey = (v: SnapshotIdentity): string => [v.project_id, v.branch_name, v.commit_sha, v.project_version, v.artifact_id, v.manifest_hash].join("\0");
const branchVersionKey = (v: SnapshotIdentity): string => [v.project_id, v.branch_name, v.project_version].join("\0");
const canonicalFiles = canonicalSnapshotFileRefs;
const compareRecords = (a: BranchSnapshotRecord, b: BranchSnapshotRecord): number => Date.parse(b.uploaded_at) - Date.parse(a.uploaded_at) || codepoint(a.project_version, b.project_version) || codepoint(a.branch_name, b.branch_name) || codepoint(a.artifact_id, b.artifact_id) || codepoint(a.commit_sha, b.commit_sha) || codepoint(a.manifest_hash, b.manifest_hash) || codepoint(canonicalFiles(a.files), canonicalFiles(b.files));
const compareProjectVersions = (a: BranchSnapshotRecord, b: BranchSnapshotRecord): number => Date.parse(b.uploaded_at) - Date.parse(a.uploaded_at) || codepoint(a.project_version, b.project_version) || codepoint(a.branch_name, b.branch_name) || codepoint(a.artifact_id, b.artifact_id) || codepoint(a.commit_sha, b.commit_sha) || codepoint(a.manifest_hash, b.manifest_hash) || codepoint(canonicalFiles(a.files), canonicalFiles(b.files));
const validId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 160 && value === value.trim() && value === value.normalize("NFC") && !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32);
const validProjectId = (value: unknown): value is string => typeof value === "string" && /^prj_[A-Za-z0-9_-]{1,156}$/u.test(value);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
function normalizeCapability(raw: unknown): CursorCapability {
  let value: Record<string, unknown>;
  try { const plain = snapshotPlain(raw); if (plain === null || typeof plain !== "object" || Array.isArray(plain)) throw new Error("invalid"); value = plain as Record<string, unknown>; } catch { throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); }
  const query = value.query_kind;
  const keys = query === "versions" ? ["actor_id", "project_id", "query_kind", "branch_name", "offset"] : query === "files" ? ["actor_id", "project_id", "query_kind", "identity", "offset"] : ["actor_id", "project_id", "query_kind", "offset"];
  if (!exactKeys(value, keys) || !validId(value.actor_id) || !validProjectId(value.project_id) || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || !["branches", "project_versions", "versions", "files"].includes(String(query))) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
  if (query === "versions") { if (!validId(value.branch_name)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); return { actor_id: value.actor_id, project_id: value.project_id, query_kind: query, branch_name: value.branch_name, offset: value.offset as number }; }
  if (query === "files") {
    const rawIdentity = value.identity; if (rawIdentity === null || typeof rawIdentity !== "object" || Array.isArray(rawIdentity)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); const identity = rawIdentity as Record<string, unknown>;
    if (!exactKeys(identity, ["project_id", "branch_name", "commit_sha", "project_version", "artifact_id", "manifest_hash"]) || !validProjectId(identity.project_id) || identity.project_id !== value.project_id || !validId(identity.branch_name) || typeof identity.commit_sha !== "string" || !/^[a-f0-9]{40,64}$/u.test(identity.commit_sha) || !validId(identity.project_version) || !validId(identity.artifact_id) || typeof identity.manifest_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(identity.manifest_hash)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
    return { actor_id: value.actor_id, project_id: value.project_id, query_kind: query, identity: { project_id: identity.project_id, branch_name: identity.branch_name, commit_sha: identity.commit_sha, project_version: identity.project_version, artifact_id: identity.artifact_id, manifest_hash: identity.manifest_hash }, offset: value.offset as number };
  }
  return { actor_id: value.actor_id, project_id: value.project_id, query_kind: query as "branches" | "project_versions", offset: value.offset as number };
}
const capabilityKey = (value: CursorCapability): string => JSON.stringify(value);

export interface MemoryRestoreConflict { project_id: string; artifact_id: string; path: string; reason_code: "SYNC_CONTENT_CONFLICT" | "SYNC_RENAME_TARGET_CONFLICT"; }

export class MemoryBranchSnapshotPort implements BranchSnapshotRepositoryPort, BlobReadPort, CursorVerifierPort, RestoreConflictReadPort {
  readonly records: BranchSnapshotRecord[];
  readonly blobs = new Map<string, Uint8Array>();
  readonly conflicts: MemoryRestoreConflict[];
  private readonly capabilityByToken = new Map<string, Readonly<CursorCapability>>();
  private readonly tokenByCapability = new Map<string, string>();

  constructor(seeds: readonly BranchSnapshotSeed[], conflicts: readonly MemoryRestoreConflict[] = []) {
    this.conflicts = structuredClone([...conflicts]);
    const identities = new Set<string>(); const versions = new Set<string>();
    this.records = seeds.map((raw) => {
      const seed = snapshotPlain(raw) as BranchSnapshotSeed;
      const refs: SnapshotFileRef[] = seed.files.map(({ content, ...ref }) => {
        if (/\p{Surrogate}/u.test(content)) throw new Error("BRANCH_SNAPSHOT_BLOB_UTF8_INVALID");
        const bytes = encoder.encode(content);
        try { if (decoder.decode(bytes) !== content) throw new Error("invalid roundtrip"); } catch { throw new Error("BRANCH_SNAPSHOT_BLOB_UTF8_INVALID"); }
        if (bytes.byteLength !== ref.size) throw new Error("BRANCH_SNAPSHOT_BLOB_SIZE_MISMATCH");
        if (sha(bytes) !== ref.content_hash) throw new Error("BRANCH_SNAPSHOT_BLOB_HASH_MISMATCH");
        const existing = this.blobs.get(ref.content_hash);
        if (existing !== undefined && decoder.decode(existing) !== content) throw new Error("BRANCH_SNAPSHOT_BLOB_HASH_CONFLICT");
        this.blobs.set(ref.content_hash, bytes); return ref;
      });
      const record = validateSnapshotManifest(branchSnapshotRecordSchema.parse({ ...seed, files: refs }));
      if (identities.has(identityKey(record)) || versions.has(branchVersionKey(record))) throw new Error("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
      identities.add(identityKey(record)); versions.add(branchVersionKey(record)); return record;
    });
  }
  static fromSnapshots(seeds: readonly BranchSnapshotSeed[], conflicts: readonly MemoryRestoreConflict[] = []): MemoryBranchSnapshotPort { return new MemoryBranchSnapshotPort(seeds, conflicts); }
  repositoryRecords(): BranchSnapshotRecord[] { return structuredClone(this.records); }
  blobCount(): number { return this.blobs.size; }
  async readBlob(hash: string): Promise<Uint8Array | null> { const value = this.blobs.get(hash); return value === undefined ? null : new Uint8Array(value); }
  async verify(cursor: string, expected: Omit<CursorCapability, "offset">): Promise<number> { if (!/^[A-Za-z0-9_-]{43}$/u.test(cursor)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); const stored = this.capabilityByToken.get(cursor); if (stored === undefined) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); let plainExpected: unknown; try { plainExpected = JSON.parse(JSON.stringify(snapshotPlain(expected))) as unknown; } catch { throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); } if (plainExpected === null || typeof plainExpected !== "object" || Array.isArray(plainExpected)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); const normalizedExpected = normalizeCapability({ ...(plainExpected as Record<string, unknown>), offset: stored.offset }); if (capabilityKey(stored) !== capabilityKey(normalizedExpected)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); return stored.offset; }
  async issue(raw: CursorCapability): Promise<string> { const capability = normalizeCapability(raw); const key = capabilityKey(capability); const existing = this.tokenByCapability.get(key); if (existing !== undefined) return existing; let token = ""; for (let attempt = 0; attempt < 16; attempt += 1) { token = randomBytes(32).toString("base64url"); if (!this.capabilityByToken.has(token)) break; token = ""; } if (token === "") throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); const cloned = structuredClone(capability); if (cloned.query_kind === "files") Object.freeze(cloned.identity); const stored = Object.freeze(cloned); this.capabilityByToken.set(token, stored); this.tokenByCapability.set(key, token); return token; }
  private page<T>(items: T[], input: RepositoryPageRequest, query_kind: "branches" | "project_versions" | "versions" | "files"): RepositoryPageEnvelope<T> { const values = items.slice(input.cursor_offset, input.cursor_offset + input.limit); const next = input.cursor_offset + values.length; return { actor_id: input.actor_id, project_id: input.project_id, query_kind, cursor_offset: input.cursor_offset, next_offset: next < items.length ? next : null, items: structuredClone(values) }; }
  async listLatestBranches(input: RepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>> { const latest = new Map<string, BranchSnapshotRecord>(); for (const item of this.records.filter((v) => v.project_id === input.project_id).sort(compareRecords)) if (!latest.has(item.branch_name)) latest.set(item.branch_name, item); return this.page([...latest.values()].sort(compareRecords), input, "branches"); }
  async listProjectVersions(input: RepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>> { return this.page(this.records.filter((v) => v.project_id === input.project_id).sort(compareProjectVersions), input, "project_versions"); }
  async listVersions(input: BranchRepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>> { return this.page(this.records.filter((v) => v.project_id === input.project_id && v.branch_name === input.branch_name).sort(compareRecords), input, "versions"); }
  async listFiles(input: SnapshotRepositoryPageRequest): Promise<RepositoryPageEnvelope<SnapshotFileRef> & { identity: SnapshotIdentity }> { const record = this.records.find((v) => identityKey(v) === identityKey(input.identity)); if (record === undefined) throw new Error("BRANCH_SNAPSHOT_NOT_FOUND"); return { identity: structuredClone(input.identity), ...this.page([...record.files].sort((a, b) => codepoint(a.path, b.path)), input, "files") }; }
  async getSnapshot(input: { actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity }): Promise<{ actor_id: string; identity: SnapshotIdentity; record: BranchSnapshotRecord } | null> { const record = this.records.find((v) => identityKey(v) === identityKey(input.identity)); return record === undefined ? null : structuredClone({ actor_id: input.actor_id, identity: input.identity, record }); }
  async getFile(input: { actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity; path: string }): Promise<{ actor_id: string; identity: SnapshotIdentity; file: SnapshotFileRef } | null> { const record = this.records.find((v) => identityKey(v) === identityKey(input.identity)); const file = record?.files.find((v) => v.path === input.path); return file === undefined ? null : structuredClone({ actor_id: input.actor_id, identity: input.identity, file }); }
  async listConflicts(input: { actor_id: string; identity: SnapshotIdentity; selected_paths: readonly string[] }): Promise<{ actor_id: string; identity: SnapshotIdentity; conflicts: Array<{ path: string; reason_code: "SYNC_CONTENT_CONFLICT" | "SYNC_RENAME_TARGET_CONFLICT" }> }> { const selected = new Set(input.selected_paths); const conflicts = this.conflicts.filter((v) => v.project_id === input.identity.project_id && v.artifact_id === input.identity.artifact_id && selected.has(v.path)).map(({ path, reason_code }) => ({ path, reason_code })).sort((a, b) => codepoint(a.path, b.path)); return { actor_id: input.actor_id, identity: structuredClone(input.identity), conflicts }; }
}
