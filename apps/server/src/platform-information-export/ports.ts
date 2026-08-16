import type {
  PlatformInformationExportArtifactReceipt,
  PlatformInformationExportChunkReaderPort,
  PlatformInformationExportHashPort,
  PlatformInformationQuery,
} from "@hunter-harness/contracts";

import type {
  PlatformInformationExportRecord,
  PlatformInformationExportRecordAckResult,
  PlatformInformationExportRecordClaimResult,
  PlatformInformationExportRecordDownloadResult,
  PlatformInformationExportRecordFindResult,
  PlatformInformationExportRecordPublishResult,
} from "./types.js";

export interface PlatformInformationExportPageSourcePort {
  read_page(query: PlatformInformationQuery): unknown | Promise<unknown>;
}

export type PlatformInformationExportArtifactSection = "manifest" | "items" | "footer";

export interface PlatformInformationExportArtifactBeginResult {
  readonly attempt_id: string;
  readonly export_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  /** Reads the sealed staging artifact. It is not a public download reference. */
  readonly staged_reader: PlatformInformationExportChunkReaderPort;
}

export interface PlatformInformationExportArtifactAppendResult {
  readonly sealed: boolean;
  readonly content_sha: string | null;
  readonly byte_count: number | null;
}

export type PlatformInformationExportArtifactCommitResult =
  | { readonly ok: true; readonly receipt: PlatformInformationExportArtifactReceipt }
  | { readonly ok: false; readonly reason_code: "different_output" };

export interface PlatformInformationExportArtifactPort {
  begin(input: {
    readonly query_key: string;
    readonly query: PlatformInformationQuery;
  }): PlatformInformationExportArtifactBeginResult | Promise<PlatformInformationExportArtifactBeginResult>;

  append(input: {
    readonly attempt_id: string;
    readonly section: PlatformInformationExportArtifactSection;
    readonly chunk: Uint8Array;
    readonly seal: boolean;
  }): PlatformInformationExportArtifactAppendResult | Promise<PlatformInformationExportArtifactAppendResult>;

  commit(input: {
    readonly attempt_id: string;
    readonly query_key: string;
    readonly serialized_receipt: string;
  }): PlatformInformationExportArtifactCommitResult | Promise<PlatformInformationExportArtifactCommitResult>;

  abort(input: { readonly attempt_id: string }): void | Promise<void>;
}

/** Read-only stream seam used by the HTTP download route. */
export interface PlatformInformationExportDownloadPort {
  open(input: {
    readonly export_id: string;
    readonly project_id: string;
    readonly content_sha: string;
  }): Promise<AsyncIterable<Uint8Array>>;
}

export interface PlatformInformationExportPorts {
  readonly page_source: PlatformInformationExportPageSourcePort;
  readonly artifact_port: PlatformInformationExportArtifactPort;
  readonly hash_port: PlatformInformationExportHashPort;
}

export interface PlatformInformationExportRecordPort {
  findReadyByIdempotency(input: {
    readonly actor_id: string;
    readonly project_id: string;
    readonly idempotency_key: string;
    readonly query_hash: string;
    readonly now: string;
  }): Promise<PlatformInformationExportRecordFindResult>;

  publishReady(record: PlatformInformationExportRecord):
    Promise<PlatformInformationExportRecordPublishResult>;

  getReadyForDownload(input: {
    readonly actor_id: string;
    readonly project_id: string;
    readonly export_id: string;
    readonly now: string;
  }): Promise<PlatformInformationExportRecordDownloadResult>;

  claimExpired(input: {
    readonly now: string;
    readonly limit: number;
    readonly cursor?: string | null;
    readonly worker_id: string;
    readonly lease_until: string;
  }): Promise<PlatformInformationExportRecordClaimResult>;

  ackExpired(input: {
    readonly batch_id: string;
    readonly worker_id: string;
  }): Promise<PlatformInformationExportRecordAckResult>;

  hasLiveReference(input: {
    readonly content_hash: string;
    readonly now: string;
  }): Promise<boolean>;
}
