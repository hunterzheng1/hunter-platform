import { z } from "zod";

import {
  platformInformationPageSchema,
  platformInformationQuerySchema,
  type PlatformInformationExportArtifactReceipt,
  type PlatformInformationPage,
  type PlatformInformationQuery,
} from "@hunter-harness/contracts";

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const platformInformationExportSourcePageSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("platform_information_export_page"),
  request: platformInformationQuerySchema,
  page: platformInformationPageSchema,
  items_sha: hashSchema,
  proof_sha: hashSchema,
}).strict();

export type PlatformInformationExportSourcePage = z.infer<
  typeof platformInformationExportSourcePageSchema
>;

export interface PlatformInformationExportSourceProofPayload {
  readonly schema_version: 1;
  readonly source_kind: "platform_information_export_page";
  readonly request: PlatformInformationQuery;
  readonly page: PlatformInformationPage;
  readonly items_sha: string;
}

export type PlatformInformationExportFailureCode =
  | "PLATFORM_INFORMATION_EXPORT_QUERY_INVALID"
  | "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_SOURCE_FAILURE"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_SERIALIZED_JSON_REQUIRED"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_SERIALIZED_JSON_TOO_LARGE"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_INVALID"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_IDENTITY_MISMATCH"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_ITEMS_HASH_MISMATCH"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_PROOF_HASH_MISMATCH"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_STATE_NOT_EXPORTABLE"
  | "PLATFORM_INFORMATION_EXPORT_CURSOR_NONPROGRESS"
  | "PLATFORM_INFORMATION_EXPORT_CURSOR_LOOP"
  | "PLATFORM_INFORMATION_EXPORT_PAGE_LIMIT_EXCEEDED"
  | "PLATFORM_INFORMATION_EXPORT_ITEM_LIMIT_EXCEEDED"
  | "PLATFORM_INFORMATION_EXPORT_ARTIFACT_TOO_LARGE"
  | "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE"
  | "PLATFORM_INFORMATION_EXPORT_M4_SELF_VERIFICATION_FAILED"
  | "PLATFORM_INFORMATION_EXPORT_ARTIFACT_SELF_VERIFICATION_FAILED"
  | "PLATFORM_INFORMATION_EXPORT_ARTIFACT_COMMIT_CONFLICT";

export type PlatformInformationExportModuleResult =
  | { readonly ok: true; readonly value: PlatformInformationExportArtifactReceipt }
  | { readonly ok: false; readonly reason_code: PlatformInformationExportFailureCode };

/** Durable metadata only. The M6A receipt remains the single owner of artifact fields. */
export interface PlatformInformationExportRecord {
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly query_hash: string;
  readonly receipt: PlatformInformationExportArtifactReceipt;
}

export type PlatformInformationExportRecordConflictReason =
  | "different_query"
  | "different_record";

export type PlatformInformationExportRecordFindResult =
  | { readonly status: "ready"; readonly record: PlatformInformationExportRecord }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "conflict"; readonly reason_code: "different_query" };

export type PlatformInformationExportRecordPublishResult =
  | {
      readonly status: "published" | "existing";
      readonly record: PlatformInformationExportRecord;
    }
  | {
      readonly status: "conflict";
      readonly reason_code: PlatformInformationExportRecordConflictReason;
    };

export type PlatformInformationExportRecordDownloadResult =
  | { readonly status: "ready"; readonly record: PlatformInformationExportRecord }
  | { readonly status: "not_found" }
  | { readonly status: "expired" };

export type PlatformInformationExportRecordClaimResult =
  | { readonly status: "empty"; readonly refs: readonly []; readonly next_cursor: null }
  | {
      readonly status: "claimed";
      readonly batch_id: string;
      readonly refs: readonly PlatformInformationExportArtifactReceipt["download_ref"][];
      readonly next_cursor: string | null;
    };

export type PlatformInformationExportRecordAckResult =
  | { readonly status: "acked" }
  | { readonly status: "already_acked" }
  | { readonly status: "not_found" }
  | { readonly status: "not_owner" }
  | { readonly status: "lease_lost" };
