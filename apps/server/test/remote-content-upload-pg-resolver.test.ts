import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { remoteContentUploadHttpRecordHash } from "@hunter-harness/contracts";
import { createRemoteContentUploadResolver } from "../src/remote-content-upload-pg/resolver.js";
import type { RemoteContentUploadCas } from "../src/remote-content-upload-pg/ports.js";

function hash(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("remote content upload reference resolver", () => {
  it("requires the stored project/source identity before exposing CAS bytes", async () => {
    const bytes = new TextEncoder().encode("abc");
    const contentHash = hash(bytes);
    const ref = { ref_id: `bounded_upload:${"A".repeat(43)}`, sha256: contentHash, size_bytes: 3 };
    const recordBody = {
      schema_version: 1 as const,
      upload_id: `remote_content_upload:${"A".repeat(43)}`,
      source: { project_id: "prj_upload", branch_name: "main", actor_id: "actor_upload", client_id: "cli_upload" },
      idempotency_key: `sha256:${"b".repeat(64)}`,
      purpose: "remote_sync_file" as const,
      content_sha256: contentHash,
      size_bytes: 3,
      upload_ref: ref,
      state: "stored" as const,
      created_at: "2026-08-15T00:00:00.000Z",
      expires_at: "2026-08-15T00:01:00.000Z",
    };
    const record = { ...recordBody, record_hash: remoteContentUploadHttpRecordHash(recordBody) };
    const query = async () => ({ rows: [{ ...record, source_json: record.source, record_json: record }] });
    const cas: RemoteContentUploadCas = {
      async beginAttempt() { throw new Error("unused"); }, async appendAttempt() { throw new Error("unused"); },
      async abortAttempt() { throw new Error("unused"); }, async sealAttempt() { throw new Error("unused"); },
      async publishAttempt() { throw new Error("unused"); }, async hasObject() { return true; },
      async *readObject() { yield bytes; }, async cleanupStaleAttempts() { return 0; }, async removeObject() {}, async close() {}
    };
    const resolver = createRemoteContentUploadResolver({ pool: { query } as never, cas });
    const stream = await resolver.resolve({
      purpose: "remote_sync_file",
      source: record.source, upload_ref: ref, now: "2026-08-15T00:00:30.000Z"
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("abc");
  });
});
