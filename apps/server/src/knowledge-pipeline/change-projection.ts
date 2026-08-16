import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { KnowledgePipelineError } from "./errors.js";

const identityKeys = ["project_id", "change_key", "document_type", "source_path"] as const;
const archiveIdentityKeys = [
  "schema_version", "project_id", "change_key", "archive_id", "package_sha256",
  "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version"
] as const;
const documentKeys = [
  "schema_version", "document_id", "document_version", "project_id", "change_key",
  "archive_id", "package_sha256", "project_version", "document_type", "source_path",
  "content_hash", "content", "generation", "created_at", "updated_at"
] as const;

function invalid(reasonCode: string): never {
  throw new KnowledgePipelineError(reasonCode, false);
}

function ownRecord(
  value: unknown,
  exactKeys: readonly string[],
  reasonCode: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) invalid(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<string, PropertyDescriptor>;
  const keys = Object.keys(descriptors).sort();
  const expected = [...exactKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid(reasonCode);
  }
  const result: Record<string, unknown> = {};
  for (const key of exactKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(reasonCode);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedString(value: unknown, reasonCode: string, max = 1_048_576): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) invalid(reasonCode);
  return value;
}

function ownDenseArray(value: unknown, reasonCode: string): unknown[] {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) invalid(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > 16) invalid(reasonCode);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(reasonCode);
    }
    result.push(descriptor.value);
  }
  const expectedKeys = new Set([
    "length",
    ...result.map((_, index) => String(index))
  ]);
  if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) invalid(reasonCode);
  return result;
}

export function changeDocumentIdentity(input: unknown): string {
  const record = ownRecord(input, identityKeys, "CHANGE_DOCUMENT_IDENTITY_INVALID");
  const projectId = boundedString(record.project_id, "CHANGE_DOCUMENT_IDENTITY_INVALID", 512);
  const changeKey = boundedString(record.change_key, "CHANGE_DOCUMENT_IDENTITY_INVALID", 160);
  const documentType = boundedString(record.document_type, "CHANGE_DOCUMENT_IDENTITY_INVALID", 32);
  if (!["design", "plan", "test_scenarios", "change_summary"].includes(documentType)) {
    invalid("CHANGE_DOCUMENT_IDENTITY_INVALID");
  }
  const sourcePath = boundedString(record.source_path, "CHANGE_DOCUMENT_IDENTITY_INVALID", 240);
  const digest = createHash("sha256")
    .update([projectId, changeKey, documentType, sourcePath].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `doc_${digest}`;
}

/** A document version is its immutable content identity. */
export function changeDocumentVersion(content_hash: string): string {
  return content_hash;
}

export function changeProjectionInputHash(input: unknown): string {
  const record = ownRecord(input, archiveIdentityKeys, "CHANGE_PROJECTION_INPUT_INVALID");
  const canonical: Record<string, string | number> = {};
  for (const key of archiveIdentityKeys) {
    const value = record[key];
    if (key === "schema_version" || key === "package_schema_version" ||
        key === "archive_schema_version") {
      if (!Number.isSafeInteger(value) || Number(value) < 1) {
        invalid("CHANGE_PROJECTION_INPUT_INVALID");
      }
      canonical[key] = Number(value);
    } else {
      canonical[key] = boundedString(value, "CHANGE_PROJECTION_INPUT_INVALID", 512);
    }
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function changeProjectionOutputHash(value: unknown): string {
  const documents = ownDenseArray(value, "CHANGE_PROJECTION_OUTPUT_INPUT_INVALID").map(
    (candidate) => ownRecord(candidate, documentKeys, "CHANGE_PROJECTION_OUTPUT_INPUT_INVALID")
  );
  const canonical = documents.map((document) => {
    const result: Record<string, string | number> = {};
    for (const key of documentKeys) {
      const value = document[key];
      if (key === "schema_version" || key === "generation") {
        if (!Number.isSafeInteger(value) || Number(value) < 1) {
          invalid("CHANGE_PROJECTION_OUTPUT_INPUT_INVALID");
        }
        result[key] = Number(value);
      } else {
        result[key] = boundedString(value, "CHANGE_PROJECTION_OUTPUT_INPUT_INVALID");
      }
    }
    return result;
  }).sort((left, right) => String(left.document_id) < String(right.document_id)
    ? -1 : String(left.document_id) > String(right.document_id) ? 1 : 0);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
