import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import { types as utilTypes } from "node:util";

import type { PlatformInformationCursorVerifierPort } from "@hunter-harness/contracts";

const TOKEN_BYTES = 161;
const PAYLOAD_BYTES = 129;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{215}$/u;
const SECRET_BYTES = 32;
const MIN_SECRET_DISTINCT_BYTES = 16;

export interface ProjectMaterialsCurrentIdentity {
  readonly project_id: string;
  readonly branch_name: string;
  readonly commit_sha: string;
  readonly project_version: string;
  readonly artifact_id: string;
  readonly manifest_hash: string;
}

export interface ProjectMaterialsKey {
  readonly category:
    | "config"
    | "rule"
    | "architecture_map"
    | "architecture_constraint"
    | "instruction";
  readonly path: string;
  readonly snapshot_version: string;
}

interface Scope {
  readonly actor_id: string;
  readonly project_id: string;
  readonly view: "project_materials";
  readonly sort: "category_asc_path_asc_version_desc";
}

interface PositionedScope extends Scope {
  readonly current: ProjectMaterialsCurrentIdentity;
  readonly last_key: ProjectMaterialsKey;
}

function canonicalText(value: unknown, maximum = 1024): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff);
    });
}

function canonicalTupleBytes(domain: string, values: readonly string[]): Buffer {
  const fields = [domain, ...values];
  return Buffer.concat(fields.map((value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, "ascii"), bytes]);
  }));
}

function digest(domain: string, values: readonly string[]): Buffer {
  return createHash("sha256").update(canonicalTupleBytes(domain, values)).digest();
}

function scopeDigest(scope: Scope): Buffer {
  return digest("project-materials-scope-v1", [
    scope.actor_id, scope.project_id, scope.view, scope.sort
  ]);
}

function currentDigest(current: ProjectMaterialsCurrentIdentity): Buffer {
  return digest("project-materials-current-v1", [
    current.project_id,
    current.branch_name,
    current.commit_sha,
    current.project_version,
    current.artifact_id,
    current.manifest_hash
  ]);
}

function keyDigest(key: ProjectMaterialsKey): Buffer {
  return digest("project-materials-key-v1", [key.category, key.path, key.snapshot_version]);
}

export function projectMaterialId(
  current: ProjectMaterialsCurrentIdentity,
  key: Pick<ProjectMaterialsKey, "category" | "path">
): string {
  if (!safeCurrent(current) ||
      !["config", "rule", "architecture_map", "architecture_constraint", "instruction"]
        .includes(key.category) || !canonicalText(key.path, 1024)) {
    throw new Error("PROJECT_MATERIALS_IDENTITY_INVALID");
  }
  return `material_${digest("project-material-id-v1", [
    current.project_id,
    current.branch_name,
    current.commit_sha,
    current.project_version,
    current.artifact_id,
    current.manifest_hash,
    key.category,
    key.path
  ]).toString("hex")}`;
}

function locatorDigest(current: ProjectMaterialsCurrentIdentity, key: ProjectMaterialsKey): Buffer {
  return Buffer.from(projectMaterialId(current, key).slice("material_".length), "hex");
}

function safeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !utilTypes.isProxy(value);
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function safeScope(value: unknown): value is Scope {
  if (!safeRecord(value)) return false;
  try {
    return canonicalText(dataValue(value, "actor_id"), 160) &&
      typeof dataValue(value, "project_id") === "string" &&
      /^prj_[A-Za-z0-9_-]{1,156}$/u.test(dataValue(value, "project_id") as string) &&
      dataValue(value, "view") === "project_materials" &&
      dataValue(value, "sort") === "category_asc_path_asc_version_desc";
  } catch {
    return false;
  }
}

function safeCurrent(value: unknown): value is ProjectMaterialsCurrentIdentity {
  if (!safeRecord(value)) return false;
  try {
    const projectId = dataValue(value, "project_id");
    const commit = dataValue(value, "commit_sha");
    const manifest = dataValue(value, "manifest_hash");
    return typeof projectId === "string" && /^prj_[A-Za-z0-9_-]{1,156}$/u.test(projectId) &&
      canonicalText(dataValue(value, "branch_name"), 160) &&
      typeof commit === "string" && /^[a-f0-9]{40,64}$/u.test(commit) &&
      canonicalText(dataValue(value, "project_version"), 160) &&
      canonicalText(dataValue(value, "artifact_id"), 160) &&
      typeof manifest === "string" && /^sha256:[a-f0-9]{64}$/u.test(manifest);
  } catch {
    return false;
  }
}

function safeKey(value: unknown): value is ProjectMaterialsKey {
  if (!safeRecord(value)) return false;
  try {
    return ["config", "rule", "architecture_map", "architecture_constraint", "instruction"]
      .includes(String(dataValue(value, "category"))) &&
      canonicalText(dataValue(value, "path"), 1024) &&
      canonicalText(dataValue(value, "snapshot_version"), 160);
  } catch {
    return false;
  }
}

export class ProjectMaterialsCursorAuthority implements PlatformInformationCursorVerifierPort {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    if (utilTypes.isProxy(secret) || !utilTypes.isUint8Array(secret) ||
        secret.byteLength !== SECRET_BYTES) {
      throw new Error("PROJECT_MATERIALS_CURSOR_SECRET_INVALID");
    }
    const copied = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
    if (new Set(copied).size < MIN_SECRET_DISTINCT_BYTES) {
      throw new Error("PROJECT_MATERIALS_CURSOR_SECRET_INVALID");
    }
    this.#secret = Buffer.from(copied);
  }

  issue(input: PositionedScope): string {
    if (!safeScope(input)) throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    const current = dataValue(input, "current");
    const lastKey = dataValue(input, "last_key");
    if (!safeCurrent(current) || !safeKey(lastKey) || current.project_id !== input.project_id) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    const payload = Buffer.concat([
      Buffer.of(1),
      scopeDigest(input),
      currentDigest(current),
      locatorDigest(current, lastKey),
      keyDigest(lastKey)
    ]);
    const mac = createHmac("sha256", this.#secret).update(payload).digest();
    return Buffer.concat([payload, mac]).toString("base64url");
  }

  async verify(input: Parameters<PlatformInformationCursorVerifierPort["verify"]>[0]): Promise<boolean> {
    if (!safeScope(input)) return false;
    try {
      const cursor = dataValue(input, "cursor");
      if (typeof cursor !== "string") return false;
      const decoded = this.#decode(cursor);
      return timingSafeEqual(decoded.subarray(1, 33), scopeDigest(input));
    } catch {
      return false;
    }
  }

  locate(cursor: string, input: Scope & { readonly current: ProjectMaterialsCurrentIdentity }): string {
    if (!safeScope(input)) throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    const current = dataValue(input, "current");
    if (!safeCurrent(current) || current.project_id !== input.project_id) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    const decoded = this.#decode(cursor);
    if (!timingSafeEqual(decoded.subarray(1, 33), scopeDigest(input)) ||
        !timingSafeEqual(decoded.subarray(33, 65), currentDigest(current))) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    return `material_${decoded.subarray(65, 97).toString("hex")}`;
  }

  assertPosition(cursor: string, input: PositionedScope): void {
    const materialId = this.locate(cursor, input);
    const current = dataValue(input, "current");
    const lastKey = dataValue(input, "last_key");
    if (!safeCurrent(current) || !safeKey(lastKey) ||
        materialId !== projectMaterialId(current, lastKey)) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    const decoded = this.#decode(cursor);
    if (!timingSafeEqual(decoded.subarray(97, 129), keyDigest(lastKey))) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
  }

  #decode(cursor: string): Buffer {
    if (typeof cursor !== "string" || !TOKEN_PATTERN.test(cursor)) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.byteLength !== TOKEN_BYTES || decoded[0] !== 1) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    const expected = createHmac("sha256", this.#secret)
      .update(decoded.subarray(0, PAYLOAD_BYTES)).digest();
    if (!timingSafeEqual(decoded.subarray(PAYLOAD_BYTES), expected)) {
      throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
    }
    return decoded;
  }
}
