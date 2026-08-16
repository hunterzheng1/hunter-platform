import { createHash } from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";

import { classifyContentPath, type RemoteSyncOperation, type RemoteSyncPushFileMetadataHttp } from "@hunter-harness/contracts";

import type { BranchSnapshotSeed } from "../branch-snapshots/types.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArraySet = Uint8Array.prototype.set;

function fail(): never {
  throw new Error("SYNC_STREAM_INVALID");
}

function mediaType(path: string): BranchSnapshotSeed["files"][number]["media_type"] {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function copiedChunk(value: unknown): Uint8Array | null {
  if (!isUint8Array(value) || isProxy(value) || byteLengthGetter === undefined) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return null;
    const length = Reflect.apply(byteLengthGetter, value, []) as number;
    if (!Number.isSafeInteger(length) || length <= 0 || length > 1024 * 1024) return null;
    const copy = new Uint8Array(length);
    Reflect.apply(typedArraySet, copy, [value]);
    return copy;
  } catch {
    return null;
  }
}

export async function materializeRemoteSyncPushFiles(input: {
  readonly files: readonly RemoteSyncPushFileMetadataHttp[];
  readonly operations: readonly RemoteSyncOperation[];
  readonly resolveUpload: (ref: RemoteSyncPushFileMetadataHttp["upload_ref"]) => Promise<AsyncIterable<Uint8Array>>;
}): Promise<BranchSnapshotSeed["files"]> {
  const operationByPath = new Map(input.operations.map((operation) => [operation.path, operation]));
  const output: BranchSnapshotSeed["files"] = [];
  for (const file of input.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) fail();
    const operation = operationByPath.get(file.path);
    const classified = classifyContentPath({ schema_version: 1, path: file.path });
    const inferredKind = "reason_code" in classified ? undefined : classified.content_kind;
    const contentKind = file.content_kind ?? inferredKind;
    if (contentKind === undefined || (operation !== undefined && operation.content_kind !== contentKind)) fail();
    const ref = file.upload_ref;
    const bytes = new Uint8Array(file.size);
    if (file.size > 0) {
      if (ref === undefined) fail();
      const stream = await input.resolveUpload(ref);
      let offset = 0;
      for await (const raw of stream) {
        const chunk = copiedChunk(raw);
        if (chunk === null || offset + chunk.byteLength > file.size) fail();
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== file.size || hashBytes(bytes) !== file.content_hash) fail();
    } else if (hashBytes(bytes) !== file.content_hash) {
      fail();
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail();
    }
    output.push({
      path: file.path,
      content_kind: contentKind,
      size: file.size,
      content_hash: file.content_hash,
      media_type: mediaType(file.path),
      action: operation?.action ?? "no_change",
      content,
    });
  }
  return output;
}
