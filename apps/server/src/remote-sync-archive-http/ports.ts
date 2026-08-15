import type {
  RemoteArchiveV2,
  RemoteArchiveV2CommitResult,
  RemoteArchiveV2PrepareResult,
  RemoteArchiveV2Receipt,
  RemoteArchiveV2Status,
} from "@hunter-harness/core";

/** Production/archive HTTP adapter seam. Memory implementations remain test-only. */
export type RemoteSyncArchiveHttpServicePort = RemoteArchiveV2;
export type { RemoteArchiveV2CommitResult, RemoteArchiveV2PrepareResult, RemoteArchiveV2Receipt, RemoteArchiveV2Status };
