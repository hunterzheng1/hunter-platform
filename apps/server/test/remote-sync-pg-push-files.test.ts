import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { materializeRemoteSyncPushFiles } from "../src/remote-sync-pg/push-files.js";

function hash(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("Remote Sync PG push content refs", () => {
  it("resolves each upload ref into bounded UTF-8 producer content", async () => {
    const bytes = new TextEncoder().encode("abc");
    const contentHash = hash(bytes);
    const ref = { ref_id: `bounded_upload:${"A".repeat(43)}`, sha256: contentHash, size_bytes: bytes.byteLength };
    const result = await materializeRemoteSyncPushFiles({
      files: [{ path: ".harness/rules/a.md", content_kind: "rule", content_hash: contentHash, size: bytes.byteLength, upload_ref: ref }],
      operations: [{ path: ".harness/rules/a.md", content_kind: "rule", action: "modify" }],
      resolveUpload: async (input) => {
        expect(input).toEqual(ref);
        return (async function* () { yield bytes; })();
      }
    });
    expect(result).toEqual([{
      path: ".harness/rules/a.md", content_kind: "rule", size: 3, content_hash: contentHash,
      media_type: "text/markdown", action: "modify", content: "abc"
    }]);
  });

  it("fails closed when a non-empty file has no upload ref", async () => {
    await expect(materializeRemoteSyncPushFiles({
      files: [{ path: ".harness/rules/a.md", content_kind: "rule", content_hash: `sha256:${"a".repeat(64)}`, size: 1 }],
      operations: [], resolveUpload: async () => (async function* () {})()
    })).rejects.toThrow("SYNC_STREAM_INVALID");
  });

  it("infers classified content kind and marks unchanged final files explicitly", async () => {
    const bytes = new TextEncoder().encode("rule");
    const contentHash = hash(bytes);
    const ref = { ref_id: `bounded_upload:${"B".repeat(43)}`, sha256: contentHash, size_bytes: bytes.length };
    const result = await materializeRemoteSyncPushFiles({
      files: [{ path: ".harness/rules/a.md", content_hash: contentHash, size: bytes.length, upload_ref: ref }],
      operations: [],
      resolveUpload: async () => (async function* () { yield bytes; })(),
    });
    expect(result[0]).toMatchObject({ content_kind: "rule", action: "no_change" });
  });

  it("copies resolver chunks before a producer can mutate their shared backing bytes", async () => {
    const bytes = new TextEncoder().encode("abc");
    const contentHash = hash(bytes);
    const ref = { ref_id: `bounded_upload:${"C".repeat(43)}`, sha256: contentHash, size_bytes: bytes.length };
    const result = await materializeRemoteSyncPushFiles({
      files: [{ path: "README.md", content_kind: "branch_file", content_hash: contentHash, size: bytes.length, upload_ref: ref }],
      operations: [],
      resolveUpload: async () => (async function* () {
        yield bytes;
        bytes.fill(0x78);
      })(),
    });
    expect(result[0]?.content).toBe("abc");
  });

  it("rejects content-kind drift and files above the durable 10 MiB bound before resolving bytes", async () => {
    let resolverCalls = 0;
    const resolveUpload = async () => { resolverCalls += 1; return (async function* () {})(); };
    await expect(materializeRemoteSyncPushFiles({
      files: [{ path: ".harness/rules/a.md", content_kind: "rule", content_hash: `sha256:${"a".repeat(64)}`, size: 1,
        upload_ref: { ref_id: `bounded_upload:${"D".repeat(43)}`, sha256: `sha256:${"a".repeat(64)}`, size_bytes: 1 } }],
      operations: [{ path: ".harness/rules/a.md", content_kind: "config", action: "modify" }],
      resolveUpload,
    })).rejects.toThrow("SYNC_STREAM_INVALID");
    await expect(materializeRemoteSyncPushFiles({
      files: [{ path: "large.txt", content_kind: "branch_file", content_hash: `sha256:${"b".repeat(64)}`,
        size: 10 * 1024 * 1024 + 1,
        upload_ref: { ref_id: `bounded_upload:${"E".repeat(43)}`, sha256: `sha256:${"b".repeat(64)}`, size_bytes: 10 * 1024 * 1024 + 1 } }],
      operations: [],
      resolveUpload,
    })).rejects.toThrow("SYNC_STREAM_INVALID");
    expect(resolverCalls).toBe(0);
  });
});
