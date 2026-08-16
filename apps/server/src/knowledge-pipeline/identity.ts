import { createHash } from "node:crypto";

import { canonicalJson } from "@hunter-harness/contracts";

export interface ArchiveUploadIdentityInput {
  project_id: string;
  change_key: string;
  archive_schema_version: number;
  package_sha256: string;
}

/** Must remain byte-for-byte compatible with Harness ArchiveOutbox enqueueIdentity. */
export function archiveUploadIdempotencyKey(input: ArchiveUploadIdentityInput): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson({
    project_id: input.project_id,
    change_key: input.change_key,
    archive_schema_version: input.archive_schema_version,
    package_sha256: input.package_sha256
  })).digest("hex")}`;
}
