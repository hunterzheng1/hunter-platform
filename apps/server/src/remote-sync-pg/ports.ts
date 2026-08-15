import type { Pool } from "pg";

import type {
  BranchSnapshotCommitPort,
  BranchSnapshotDurableCommitResult,
} from "../branch-snapshots/producer.js";
import type { PgBranchSnapshotPort } from "../branch-snapshots/pg.js";

export interface PgRemoteSyncCommitOptions {
  readonly pool: Pool;
  /** Tests may provide the same transaction-bound snapshot writer. */
  readonly branchSnapshots?: Pick<PgBranchSnapshotPort, "persistSnapshotWithClient">;
  readonly now?: () => Date;
}

export type PgRemoteSyncCommitResult = BranchSnapshotDurableCommitResult;

export interface PgRemoteSyncCommitPort extends BranchSnapshotCommitPort {
  commitSnapshot(input: Parameters<BranchSnapshotCommitPort["commitSnapshot"]>[0]): Promise<PgRemoteSyncCommitResult>;
}
