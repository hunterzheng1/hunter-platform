import type { BranchSnapshotRecord, SnapshotFileRef, SnapshotIdentity } from "./types.js";

export interface RepositoryPageRequest { actor_id: string; allowed_project_ids: readonly string[]; project_id: string; cursor_offset: number; limit: number; }
export interface BranchRepositoryPageRequest extends RepositoryPageRequest { branch_name: string; }
export interface SnapshotRepositoryPageRequest extends RepositoryPageRequest { identity: SnapshotIdentity; }
export interface RepositoryPageEnvelope<T> { actor_id: string; project_id: string; query_kind: "branches" | "project_versions" | "versions" | "files"; cursor_offset: number; next_offset: number | null; items: T[]; }
export interface BranchSnapshotRepositoryPort {
  listLatestBranches(input: RepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>>;
  listProjectVersions(input: RepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>>;
  listVersions(input: BranchRepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>>;
  listFiles(input: SnapshotRepositoryPageRequest): Promise<RepositoryPageEnvelope<SnapshotFileRef> & { identity: SnapshotIdentity }>;
  getSnapshot(input: { actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity }): Promise<{ actor_id: string; identity: SnapshotIdentity; record: BranchSnapshotRecord } | null>;
  getFile(input: { actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity; path: string }): Promise<{ actor_id: string; identity: SnapshotIdentity; file: SnapshotFileRef } | null>;
}
export interface BlobReadPort { readBlob(content_hash: string): Promise<Uint8Array | null>; }
export interface CursorCapability { actor_id: string; project_id: string; query_kind: "branches" | "project_versions" | "versions" | "files"; branch_name?: string; identity?: SnapshotIdentity; offset: number; }
export interface CursorVerifierPort { verify(cursor: string, expected: Omit<CursorCapability, "offset">): Promise<number>; issue(capability: CursorCapability): Promise<string>; }
export interface RestoreConflictReadPort { listConflicts(input: { actor_id: string; identity: SnapshotIdentity; selected_paths: readonly string[] }): Promise<{ actor_id: string; identity: SnapshotIdentity; conflicts: Array<{ path: string; reason_code: "SYNC_CONTENT_CONFLICT" | "SYNC_RENAME_TARGET_CONFLICT" }> }>; }
