import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  classifyContentPath,
  knowledgeCandidateSchema,
  projectContentCandidateSchema,
  type KnowledgeCandidate,
  type ProjectContentCandidate
} from "@hunter-harness/contracts";
import AdmZip from "adm-zip";
import { z } from "zod";

import { KnowledgePipelineError } from "./errors.js";
import type {
  ArchiveValidationEvidencePort,
  ArchiveStore,
  ArchiveStorePutResult,
  ClaimChangeProjectionJobInput,
  ChangeProjectionCommitPort,
  CommitChangeProjectionInput,
  CommitKnowledgeResultsInput,
  EnqueueKnowledgeJobInput,
  FailChangeProjectionJobInput,
  JobRepository,
  KnowledgeCommitPort,
  KnowledgeIndex,
  KnowledgeIndexQuery,
  PlanArchiveTasksInput,
  PlanArchiveTasksResult,
  ProjectContentCandidateQuery,
  ProjectContentCandidateQueryResult,
  ReapChangeProjectionLeaseInput,
  RenewChangeProjectionLeaseInput,
  RetryChangeProjectionJobInput
} from "./ports.js";
import type {
  ArchivePackageValidationLimits,
  ChangeDocument,
  ChangeProjectionJob,
  KnowledgeExtractionJob,
  KnowledgeResult,
  StoredArchive,
  ValidateArchivePackageInput,
  ValidateCoreV1ArchivePackageInput,
  CoreV1ArchiveIdentity,
  ValidatedArchivePackage
} from "./types.js";
import {
  changeDocumentIdentity,
  changeDocumentVersion,
  changeProjectionOutputHash
} from "./change-projection.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const rfc3339MillisSchema = z.string().regex(
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u
);

function strictTimestamp(value: unknown): value is string {
  if (!rfc3339MillisSchema.safeParse(value).success) return false;
  const parsed = new Date(value as string);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectionError(reasonCode: string): never {
  throw new KnowledgePipelineError(reasonCode, false);
}

function exactOwnDataRecord(
  value: unknown,
  exactKeys: readonly string[],
  reasonCode: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) {
    projectionError(reasonCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<string, PropertyDescriptor>;
  const keys = Object.keys(descriptors).sort(codepointCompare);
  const expected = [...exactKeys].sort(codepointCompare);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    projectionError(reasonCode);
  }
  const result: Record<string, unknown> = {};
  for (const key of exactKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      projectionError(reasonCode);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedProjectionText(value: unknown, reasonCode: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value.trim() !== value || Array.from(value).some((character) => character.charCodeAt(0) < 32)) {
    projectionError(reasonCode);
  }
  return value;
}
const manifestFileSchema = z.object({
  path: z.string().min(1).max(240),
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative()
}).strict();
const manifestSchema = z.object({
  schema_version: z.literal(2),
  project_id: z.string().regex(/^prj_/u),
  change_key: z.string().min(1).max(160),
  archive_id: z.string().regex(/^arc_/u),
  project_version: z.string().regex(/^pv_/u),
  package_schema_version: z.number().int().positive(),
  archive_schema_version: z.number().int().positive(),
  file_count: z.number().int().nonnegative(),
  files: z.array(manifestFileSchema)
}).strict();

const manifestPath = "archive-manifest.json";
const knowledgeCandidatesPath = "candidates/knowledge.json";
const projectContentCandidatesPath = "candidates/project-content.json";
const memoryValidatedPackages = new WeakSet<object>();
const coreV2ExactPaths = new Set([
  manifestPath,
  "summary/change-summary.json",
  "attestations/verification.json",
  knowledgeCandidatesPath,
  projectContentCandidatesPath,
  "archive-meta.md",
  "change-context.json"
]);

export const memoryArchiveValidationEvidence = Object.freeze<ArchiveValidationEvidencePort>({
  isValidatedPackage(value: unknown): value is ValidatedArchivePackage {
    return value !== null && typeof value === "object" &&
      memoryValidatedPackages.has(value);
  }
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalidArchive(reason_code: string): never {
  throw new KnowledgePipelineError(reason_code, false);
}

function safeArchivePath(path: string): boolean {
  if (path === "" || path.length > 240 || path !== path.normalize("NFC") ||
      path.includes("\\") || path.includes("\0") || path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path)) {
    return false;
  }
  const segments = path.split("/");
  return !segments.some((segment) =>
    segment === "" || segment === "." || segment === ".."
  );
}

function isCoreV2Path(path: string): boolean {
  if (coreV2ExactPaths.has(path)) return true;
  return /^(?:spec|plans)\/[^/]+(?:\/[^/]+)*\.md$/u.test(path);
}

const coreV2ExcludedPathReasons = new Set([
  "CONTENT_PATH_VCS_EXCLUDED",
  "CONTENT_PATH_CREDENTIALS_EXCLUDED",
  "CONTENT_PATH_ENV_EXCLUDED",
  "CONTENT_PATH_STATE_EXCLUDED",
  "CONTENT_PATH_RUNTIME_EXCLUDED",
  "CONTENT_PATH_NON_SCANNABLE_KIND"
]);

function validateCanonicalCoreV2Path(path: string): void {
  if (!safeArchivePath(path)) invalidArchive("ARCHIVE_PATH_UNSAFE");
  // Stage 01's public classifier owns the cross-platform structural and
  // sensitive-path matrix. source_kind makes a structurally safe ordinary path
  // classifiable; the archive-specific allowlist below remains independently strict.
  const classification = classifyContentPath({
    schema_version: 1,
    path,
    source_kind: "branch_file"
  });
  if ("reason_code" in classification) {
    invalidArchive(coreV2ExcludedPathReasons.has(classification.reason_code)
      ? "ARCHIVE_CORE_PATH_FORBIDDEN"
      : "ARCHIVE_PATH_UNSAFE");
  }
  if (!isCoreV2Path(path)) invalidArchive("ARCHIVE_CORE_PATH_FORBIDDEN");
}

function parseJsonEntry(entry: AdmZip.IZipEntry, reason_code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.getData())) as unknown;
  } catch {
    invalidArchive(reason_code);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Deterministic in-memory validation Adapter used until the production archive
 * validator is wired. The Module only accepts the branded value returned here.
 */
/**
 * Structural safety pass shared by every package profile: ZIP readability, entry
 * type, symlinks, encryption, path duplication/case folding, size and
 * compression-ratio bounds. Only the per-profile path allowlist differs, so it
 * is injected — every other check stays identical across profiles by
 * construction rather than by two copies staying in sync.
 */
function scanArchiveEntries(
  packageBytes: Uint8Array,
  limits: ArchivePackageValidationLimits,
  validatePath: (path: string) => void
): { byPath: Map<string, AdmZip.IZipEntry>; uncompressedBytes: number } {
  if (!Number.isInteger(limits.max_package_bytes) || limits.max_package_bytes < 1 ||
      packageBytes.byteLength === 0 ||
      packageBytes.byteLength > limits.max_package_bytes ||
      !Number.isInteger(limits.max_file_count) || limits.max_file_count < 1 ||
      !Number.isInteger(limits.max_file_bytes) || limits.max_file_bytes < 1 ||
      !Number.isInteger(limits.max_uncompressed_bytes) ||
      limits.max_uncompressed_bytes < 1 ||
      !Number.isFinite(limits.max_compression_ratio) ||
      limits.max_compression_ratio < 1) {
    invalidArchive("ARCHIVE_PACKAGE_LIMIT_INVALID");
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(packageBytes));
  } catch {
    invalidArchive("ARCHIVE_ZIP_INVALID");
  }
  const entries = zip.getEntries();
  if (entries.length === 0 || entries.length > limits.max_file_count + 1) {
    invalidArchive("ARCHIVE_FILE_COUNT_EXCEEDED");
  }

  const byPath = new Map<string, AdmZip.IZipEntry>();
  const caseFolded = new Set<string>();
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const path = entry.entryName;
    const attributes = Number(entry.header.attr ?? 0);
    const unixType = (attributes >>> 16) & 0xf000;
    validatePath(path);
    if (entry.isDirectory || path.endsWith("/") || unixType === 0x4000) {
      invalidArchive("ARCHIVE_ENTRY_TYPE_FORBIDDEN");
    }
    if (unixType === 0xa000) invalidArchive("ARCHIVE_SYMLINK_FORBIDDEN");
    if ((Number(entry.header.flags ?? 0) & 0x1) !== 0) {
      invalidArchive("ARCHIVE_ENCRYPTED_ENTRY_FORBIDDEN");
    }
    const folded = path.toLocaleLowerCase("en-US");
    if (byPath.has(path) || caseFolded.has(folded)) {
      invalidArchive("ARCHIVE_PATH_DUPLICATE");
    }
    const size = Number(entry.header.size);
    const compressedSize = Number(entry.header.compressedSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.max_file_bytes) {
      invalidArchive("ARCHIVE_FILE_SIZE_EXCEEDED");
    }
    if (!Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
        size / Math.max(1, compressedSize) > limits.max_compression_ratio) {
      invalidArchive("ARCHIVE_COMPRESSION_RATIO_EXCEEDED");
    }
    uncompressedBytes += size;
    if (uncompressedBytes > limits.max_uncompressed_bytes) {
      invalidArchive("ARCHIVE_UNCOMPRESSED_SIZE_EXCEEDED");
    }
    byPath.set(path, entry);
    caseFolded.add(folded);
  }
  return { byPath, uncompressedBytes };
}

export function validateArchivePackage(
  input: ValidateArchivePackageInput
): ValidatedArchivePackage {
  const { byPath, uncompressedBytes } = scanArchiveEntries(
    input.package_bytes,
    input.limits,
    validateCanonicalCoreV2Path
  );
  const limits = input.limits;

  const manifestEntry = byPath.get(manifestPath);
  if (manifestEntry === undefined) invalidArchive("ARCHIVE_MANIFEST_MISSING");
  const embeddedManifestBytes = manifestEntry.getData();
  if (!Buffer.from(embeddedManifestBytes).equals(Buffer.from(input.manifest_bytes))) {
    invalidArchive("ARCHIVE_MANIFEST_MISMATCH");
  }
  const manifestResult = manifestSchema.safeParse(
    parseJsonEntry(manifestEntry, "ARCHIVE_MANIFEST_JSON_INVALID")
  );
  if (!manifestResult.success) invalidArchive("ARCHIVE_MANIFEST_SCHEMA_INVALID");
  const manifest = manifestResult.data;
  if (manifest.file_count !== manifest.files.length ||
      manifest.files.length > limits.max_file_count) {
    invalidArchive("ARCHIVE_MANIFEST_FILE_COUNT_MISMATCH");
  }

  const declaredPaths = new Set<string>();
  for (const declared of manifest.files) {
    if (!safeArchivePath(declared.path) || declared.path === manifestPath ||
        declaredPaths.has(declared.path)) {
      invalidArchive("ARCHIVE_MANIFEST_PATH_INVALID");
    }
    declaredPaths.add(declared.path);
    const entry = byPath.get(declared.path);
    if (entry === undefined) invalidArchive("ARCHIVE_MANIFEST_FILE_MISSING");
    const content = entry.getData();
    if (content.byteLength !== declared.size_bytes ||
        sha256(content) !== declared.content_sha256) {
      invalidArchive("ARCHIVE_MANIFEST_CONTENT_MISMATCH");
    }
  }
  const dataPaths = [...byPath.keys()].filter((path) => path !== manifestPath);
  if (dataPaths.some((path) => !declaredPaths.has(path)) ||
      declaredPaths.size !== dataPaths.length) {
    invalidArchive("ARCHIVE_UNDECLARED_FILE");
  }

  const knowledgeEntry = byPath.get(knowledgeCandidatesPath);
  const projectContentEntry = byPath.get(projectContentCandidatesPath);
  if (knowledgeEntry === undefined || projectContentEntry === undefined ||
      !declaredPaths.has(knowledgeCandidatesPath) ||
      !declaredPaths.has(projectContentCandidatesPath)) {
    invalidArchive("ARCHIVE_CANDIDATE_FILE_MISSING");
  }
  const knowledgeResult = z.array(knowledgeCandidateSchema).safeParse(
    parseJsonEntry(knowledgeEntry, "ARCHIVE_KNOWLEDGE_CANDIDATES_JSON_INVALID")
  );
  const projectContentResult = z.array(projectContentCandidateSchema).safeParse(
    parseJsonEntry(projectContentEntry, "ARCHIVE_PROJECT_CANDIDATES_JSON_INVALID")
  );
  if (!knowledgeResult.success || !projectContentResult.success) {
    invalidArchive("ARCHIVE_CANDIDATE_SCHEMA_INVALID");
  }
  const sourcePathExists = (reference: string): boolean =>
    declaredPaths.has(reference.split("#", 1)[0] ?? reference);
  const wrongKnowledgeBinding = knowledgeResult.data.some((candidate) =>
    candidate.source_change_key !== manifest.change_key ||
    candidate.provenance.source_ref !== manifest.archive_id ||
    candidate.source_refs.some((reference) => !sourcePathExists(reference))
  );
  const wrongProjectBinding = projectContentResult.data.some((candidate) =>
    candidate.source_change_key !== manifest.change_key ||
    candidate.provenance.source_ref !== manifest.archive_id ||
    candidate.evidence_refs.some((reference) => !sourcePathExists(reference))
  );
  if (wrongKnowledgeBinding || wrongProjectBinding) {
    invalidArchive("ARCHIVE_CANDIDATE_SOURCE_UNBOUND");
  }

  const packageBytes = input.package_bytes.slice();
  const manifestBytes = input.manifest_bytes.slice();
  const packageSha256 = sha256(packageBytes);
  const manifestSha256 = sha256(manifestBytes);
  const validated: ValidatedArchivePackage = {
    schema_version: 1,
    project_id: manifest.project_id,
    change_key: manifest.change_key,
    archive_id: manifest.archive_id,
    package_sha256: packageSha256,
    manifest_sha256: manifestSha256,
    project_version: manifest.project_version,
    package_schema_version: manifest.package_schema_version,
    archive_schema_version: manifest.archive_schema_version,
    package_bytes: packageBytes,
    manifest_bytes: manifestBytes,
    knowledge_candidates: deepFreeze(structuredClone(knowledgeResult.data)),
    project_content_candidates: deepFreeze(structuredClone(projectContentResult.data)),
    validation_receipt: deepFreeze({
      schema_version: 1,
      package_sha256: packageSha256,
      manifest_sha256: manifestSha256,
      package_schema_version: manifest.package_schema_version,
      archive_schema_version: manifest.archive_schema_version,
      safe_paths: true,
      no_symlinks: true,
      no_encrypted_entries: true,
      declared_files_verified: true,
      content_hashes_verified: true,
      candidate_sources_bound: true,
      file_count: manifest.files.length,
      compressed_bytes: packageBytes.byteLength,
      uncompressed_bytes: uncompressedBytes,
      validated_at: input.validated_at
    })
  };
  Object.freeze(validated);
  memoryValidatedPackages.add(validated);
  return validated;
}

// --- core-v1: the profile the production archiver actually emits -------------
// harness/scripts/harness_archive.py builds this shape, and
// apps/server/src/archive/package-ingest.ts has always validated it. The v2
// profile above was written for a package format that has no producer, so a
// production upload used to fail its first gate and the knowledge queue never
// received a job. Structural safety is identical (shared scanArchiveEntries);
// what differs is the manifest shape, the path allowlist, and where identity
// comes from.

const coreV1SummaryPath = "reports/final/summary-data.json";
const coreV1ExactPaths = new Set([
  manifestPath,
  coreV1SummaryPath,
  knowledgeCandidatesPath,
  "archive-meta.md",
  "change-context.json"
]);

function isCoreV1Path(path: string): boolean {
  if (coreV1ExactPaths.has(path)) return true;
  return /^(?:spec|plans)\/[^/]+(?:\/[^/]+)*\.md$/u.test(path);
}

function validateCanonicalCoreV1Path(path: string): void {
  if (!safeArchivePath(path)) invalidArchive("ARCHIVE_PATH_UNSAFE");
  const classification = classifyContentPath({
    schema_version: 1,
    path,
    source_kind: "branch_file"
  });
  if ("reason_code" in classification) {
    invalidArchive(coreV2ExcludedPathReasons.has(classification.reason_code)
      ? "ARCHIVE_CORE_PATH_FORBIDDEN"
      : "ARCHIVE_PATH_UNSAFE");
  }
  if (!isCoreV1Path(path)) invalidArchive("ARCHIVE_CORE_PATH_FORBIDDEN");
}

const coreV1ManifestSchema = z.object({
  schema_version: z.literal(1),
  profile: z.literal("core-v1"),
  change_key: z.string().min(1).max(160),
  created_at: z.string().min(1).max(64),
  source: z.object({
    commit: z.string().min(7).max(128).nullable(),
    tree: z.string().min(7).max(128).nullable()
  }).strict(),
  files: z.array(z.object({
    path: z.string().min(1).max(240),
    role: z.enum([
      "summary", "spec", "plan", "knowledge_candidates", "archive_meta", "change_context"
    ]),
    media_type: z.enum(["application/json", "text/markdown"]),
    content_sha256: sha256Schema,
    size_bytes: z.number().int().nonnegative()
  }).strict()).min(1)
}).strict();

/**
 * A repository-relative provenance reference, optionally with a `#`-suffixed
 * locator, or an `archive:`-scheme reference. core-v1 candidates cite source
 * files in the repository rather than entries in the package — that is the
 * point of the entry (a finding stays locatable at path:line) — so the package
 * containment check the v2 profile applies cannot be used. What is enforced
 * instead is that the reference cannot escape the repository.
 */
function isBoundCoreV1Reference(reference: string): boolean {
  if (reference.length < 1 || reference.length > 512) return false;
  if (reference.startsWith("archive:")) return reference.length > "archive:".length;
  return safeArchivePath(reference.split("#", 1)[0] ?? reference);
}

function coreV1Identity(value: unknown): CoreV1ArchiveIdentity {
  const record = value as Partial<CoreV1ArchiveIdentity> | null;
  if (record === null || typeof record !== "object") {
    invalidArchive("ARCHIVE_IDENTITY_INVALID");
  }
  const identity = {
    project_id: record.project_id,
    change_key: record.change_key,
    archive_id: record.archive_id,
    project_version: record.project_version
  };
  for (const field of Object.values(identity)) {
    if (typeof field !== "string" || field.length < 1 || field.length > 512 ||
        field.trim() !== field ||
        Array.from(field).some((character) => character.charCodeAt(0) < 32)) {
      invalidArchive("ARCHIVE_IDENTITY_INVALID");
    }
  }
  return identity as CoreV1ArchiveIdentity;
}

export function validateCoreV1ArchivePackage(
  input: ValidateCoreV1ArchivePackageInput
): ValidatedArchivePackage {
  const identity = coreV1Identity(input.identity);
  const { byPath, uncompressedBytes } = scanArchiveEntries(
    input.package_bytes,
    input.limits,
    validateCanonicalCoreV1Path
  );
  const limits = input.limits;

  const manifestEntry = byPath.get(manifestPath);
  if (manifestEntry === undefined) invalidArchive("ARCHIVE_MANIFEST_MISSING");
  if (!Buffer.from(manifestEntry.getData()).equals(Buffer.from(input.manifest_bytes))) {
    invalidArchive("ARCHIVE_MANIFEST_MISMATCH");
  }
  const manifestResult = coreV1ManifestSchema.safeParse(
    parseJsonEntry(manifestEntry, "ARCHIVE_MANIFEST_JSON_INVALID")
  );
  if (!manifestResult.success) invalidArchive("ARCHIVE_MANIFEST_MISMATCH");
  const manifest = manifestResult.data;
  if (manifest.files.length > limits.max_file_count) {
    invalidArchive("ARCHIVE_MANIFEST_FILE_COUNT_MISMATCH");
  }
  // The route owns identity; a manifest claiming a different change must not be
  // filed under this one.
  if (manifest.change_key !== identity.change_key) {
    invalidArchive("ARCHIVE_MANIFEST_IDENTITY_MISMATCH");
  }

  const declaredPaths = new Set<string>();
  for (const declared of manifest.files) {
    if (!safeArchivePath(declared.path) || declared.path === manifestPath ||
        declaredPaths.has(declared.path)) {
      invalidArchive("ARCHIVE_MANIFEST_PATH_INVALID");
    }
    declaredPaths.add(declared.path);
    const entry = byPath.get(declared.path);
    if (entry === undefined) invalidArchive("ARCHIVE_MANIFEST_FILE_MISSING");
    const content = entry.getData();
    if (content.byteLength !== declared.size_bytes ||
        sha256(content) !== declared.content_sha256) {
      invalidArchive("ARCHIVE_MANIFEST_CONTENT_MISMATCH");
    }
  }
  const dataPaths = [...byPath.keys()].filter((path) => path !== manifestPath);
  if (dataPaths.some((path) => !declaredPaths.has(path)) ||
      declaredPaths.size !== dataPaths.length) {
    invalidArchive("ARCHIVE_UNDECLARED_FILE");
  }
  if (!declaredPaths.has(coreV1SummaryPath)) {
    invalidArchive("ARCHIVE_SUMMARY_MISSING");
  }

  // Optional by design: archives built before the candidate generator existed
  // carry none, and a change that yields no knowledge is a valid outcome.
  // core-v1 has no project-content candidate file at all.
  const knowledgeEntry = byPath.get(knowledgeCandidatesPath);
  let knowledgeCandidates: KnowledgeCandidate[] = [];
  if (knowledgeEntry !== undefined) {
    const parsed = z.array(knowledgeCandidateSchema).max(1_000).safeParse(
      parseJsonEntry(knowledgeEntry, "ARCHIVE_KNOWLEDGE_CANDIDATES_JSON_INVALID")
    );
    if (!parsed.success) invalidArchive("ARCHIVE_CANDIDATE_SCHEMA_INVALID");
    knowledgeCandidates = parsed.data;
  }
  const unbound = knowledgeCandidates.some((candidate) =>
    candidate.source_change_key !== identity.change_key ||
    !isBoundCoreV1Reference(candidate.provenance.source_ref) ||
    candidate.source_refs.some((reference) => !isBoundCoreV1Reference(reference))
  );
  if (unbound) invalidArchive("ARCHIVE_CANDIDATE_SOURCE_UNBOUND");

  const packageBytes = input.package_bytes.slice();
  const manifestBytes = input.manifest_bytes.slice();
  const packageSha256 = sha256(packageBytes);
  const manifestSha256 = sha256(manifestBytes);
  const validated: ValidatedArchivePackage = {
    schema_version: 1,
    project_id: identity.project_id,
    change_key: identity.change_key,
    archive_id: identity.archive_id,
    package_sha256: packageSha256,
    manifest_sha256: manifestSha256,
    project_version: identity.project_version,
    package_schema_version: 1,
    archive_schema_version: 1,
    package_bytes: packageBytes,
    manifest_bytes: manifestBytes,
    knowledge_candidates: deepFreeze(structuredClone(knowledgeCandidates)),
    project_content_candidates: deepFreeze([]),
    validation_receipt: deepFreeze({
      schema_version: 1,
      package_sha256: packageSha256,
      manifest_sha256: manifestSha256,
      package_schema_version: 1,
      archive_schema_version: 1,
      safe_paths: true,
      no_symlinks: true,
      no_encrypted_entries: true,
      declared_files_verified: true,
      content_hashes_verified: true,
      candidate_sources_bound: true,
      file_count: manifest.files.length,
      compressed_bytes: packageBytes.byteLength,
      uncompressed_bytes: uncompressedBytes,
      validated_at: input.validated_at
    })
  };
  Object.freeze(validated);
  memoryValidatedPackages.add(validated);
  return validated;
}

function identifier(prefix: string, identity: string): string {
  return `${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function cloneArchive(archive: StoredArchive): StoredArchive {
  return {
    ...structuredClone(archive),
    package_bytes: archive.package_bytes.slice(),
    manifest_bytes: archive.manifest_bytes.slice()
  };
}

function cloneJob(job: KnowledgeExtractionJob): KnowledgeExtractionJob {
  return structuredClone(job);
}

function cloneChangeProjectionJob(job: ChangeProjectionJob): ChangeProjectionJob {
  return structuredClone(job);
}

export class MemoryArchiveStore implements ArchiveStore {
  readonly #archivesById = new Map<string, StoredArchive>();
  readonly #archiveIdByCanonicalIdentity = new Map<string, string>();

  #canonicalIdentity(archive: StoredArchive): string {
    return [
      archive.project_id,
      archive.package_sha256,
      archive.manifest_sha256,
      archive.package_schema_version,
      archive.archive_schema_version
    ].join("\0");
  }

  async putIfAbsent(archive: StoredArchive): Promise<ArchiveStorePutResult> {
    const canonicalIdentity = this.#canonicalIdentity(archive);
    const canonicalArchiveId = this.#archiveIdByCanonicalIdentity.get(canonicalIdentity);
    const existingById = this.#archivesById.get(archive.archive_id);
    const existing = canonicalArchiveId === undefined
      ? existingById
      : this.#archivesById.get(canonicalArchiveId);
    if (existing !== undefined) {
      const exactCanonicalIdentity = existing.project_id === archive.project_id &&
        existing.archive_id === archive.archive_id &&
        existing.change_key === archive.change_key &&
        existing.project_version === archive.project_version &&
        existing.package_sha256 === archive.package_sha256 &&
        existing.manifest_sha256 === archive.manifest_sha256 &&
        existing.package_schema_version === archive.package_schema_version &&
        existing.archive_schema_version === archive.archive_schema_version &&
        bytesEqual(existing.package_bytes, archive.package_bytes) &&
        bytesEqual(existing.manifest_bytes, archive.manifest_bytes);
      if (!exactCanonicalIdentity) {
        throw new KnowledgePipelineError(
          canonicalArchiveId === undefined
            ? "ARCHIVE_IDENTITY_CONFLICT"
            : "ARCHIVE_CANONICAL_IDENTITY_CONFLICT",
          false
        );
      }
      return { disposition: "existing", archive: cloneArchive(existing) };
    }
    const copy = cloneArchive(archive);
    this.#archivesById.set(copy.archive_id, copy);
    this.#archiveIdByCanonicalIdentity.set(canonicalIdentity, copy.archive_id);
    return { disposition: "stored", archive: cloneArchive(copy) };
  }

  async getByArchiveId(archive_id: string): Promise<StoredArchive | null> {
    const archive = this.#archivesById.get(archive_id);
    return archive === undefined ? null : cloneArchive(archive);
  }

  recordCount(): number {
    return this.#archivesById.size;
  }
}

export interface MemoryJobRepositoryOptions {
  max_queued_change_projection_jobs?: number;
  max_queued_knowledge_jobs?: number;
  max_queued_project_content_jobs?: number;
}

interface TaskPlanRecord {
  change_projection_job_id: string;
  knowledge_job_id: string;
  project_content_job_id?: string;
}

interface StoredProjectCandidate {
  project_id: string;
  candidate: ProjectContentCandidate;
}

interface PreparedKnowledgeCommit {
  disposition: "commit" | "existing";
  job: KnowledgeExtractionJob;
}

interface PreparedChangeProjectionCommit {
  disposition: "commit" | "existing";
  job: ChangeProjectionJob;
}

const defaultQueueCapacity = 100;

export class MemoryJobRepository implements JobRepository {
  readonly #maxChangeProjectionJobs: number;
  readonly #maxKnowledgeJobs: number;
  readonly #maxProjectContentJobs: number;
  readonly #changeProjectionJobs = new Map<string, ChangeProjectionJob>();
  readonly #changeProjectionJobByIdentity = new Map<string, string>();
  readonly #knowledgeJobs = new Map<string, KnowledgeExtractionJob>();
  readonly #knowledgeJobByIdentity = new Map<string, string>();
  readonly #projectContentJobs = new Set<string>();
  readonly #taskPlans = new Map<string, TaskPlanRecord>();
  readonly #projectCandidates = new Map<string, StoredProjectCandidate>();
  readonly #latestGeneration = new Map<string, number>();
  readonly #latestChangeProjectionGeneration = new Map<string, number>();
  #lastCandidateQuery: ProjectContentCandidateQuery | undefined;
  #plannedArchiveAttempts = 0;

  constructor(options: MemoryJobRepositoryOptions = {}) {
    this.#maxChangeProjectionJobs = options.max_queued_change_projection_jobs ??
      defaultQueueCapacity;
    this.#maxKnowledgeJobs = options.max_queued_knowledge_jobs ?? defaultQueueCapacity;
    this.#maxProjectContentJobs = options.max_queued_project_content_jobs ??
      defaultQueueCapacity;
    for (const capacity of [
      this.#maxChangeProjectionJobs,
      this.#maxKnowledgeJobs,
      this.#maxProjectContentJobs
    ]) {
      if (!Number.isInteger(capacity) || capacity < 0) {
        throw new KnowledgePipelineError("PIPELINE_QUEUE_CAPACITY_INVALID", false);
      }
    }
  }

  #activeKnowledgeJobCount(): number {
    return [...this.#knowledgeJobs.values()].filter(
      (job) => job.status === "queued" || job.status === "extracting"
    ).length;
  }

  #activeChangeProjectionJobCount(): number {
    return [...this.#changeProjectionJobs.values()].filter(
      (job) => job.status === "queued" || job.status === "projecting"
    ).length;
  }

  #nextGeneration(project_id: string): number {
    const generation = (this.#latestGeneration.get(project_id) ?? 0) + 1;
    this.#latestGeneration.set(project_id, generation);
    return generation;
  }

  #nextChangeProjectionGeneration(project_id: string): number {
    const generation = (this.#latestChangeProjectionGeneration.get(project_id) ?? 0) + 1;
    this.#latestChangeProjectionGeneration.set(project_id, generation);
    return generation;
  }

  #changeProjectionIdentity(input: PlanArchiveTasksInput): string {
    return [
      input.archive.schema_version,
      input.archive.project_id,
      input.archive.change_key,
      input.archive.archive_id,
      input.archive.package_sha256,
      input.archive.manifest_sha256,
      input.archive.project_version,
      input.archive.package_schema_version,
      input.archive.archive_schema_version,
      input.change_projection_input_hash
    ].join("\0");
  }

  #newChangeProjectionJob(input: PlanArchiveTasksInput): ChangeProjectionJob {
    return {
      schema_version: 1,
      job_id: identifier(
        "job_change",
        this.#changeProjectionIdentity(input)
      ),
      project_id: input.archive.project_id,
      change_key: input.archive.change_key,
      archive_id: input.archive.archive_id,
      package_sha256: input.archive.package_sha256,
      manifest_sha256: input.archive.manifest_sha256,
      project_version: input.archive.project_version,
      package_schema_version: input.archive.package_schema_version,
      archive_schema_version: input.archive.archive_schema_version,
      status: "queued",
      attempt: 1,
      project_generation: this.#nextChangeProjectionGeneration(input.archive.project_id),
      generation: 1,
      input_hash: input.change_projection_input_hash,
      retryable: true,
      created_at: input.now,
      updated_at: input.now
    };
  }

  #newKnowledgeJob(input: EnqueueKnowledgeJobInput): KnowledgeExtractionJob {
    return {
      schema_version: 1,
      job_id: identifier(
        "job_knowledge",
        `${input.archive.project_id}\0${input.idempotency_key}`
      ),
      idempotency_key: input.idempotency_key,
      project_id: input.archive.project_id,
      change_key: input.archive.change_key,
      archive_id: input.archive.archive_id,
      package_sha256: input.archive.package_sha256,
      extractor_version: input.extractor_version,
      prompt_version: input.prompt_version,
      index_schema_version: input.index_schema_version,
      status: "queued",
      attempt: 1,
      generation: this.#nextGeneration(input.archive.project_id),
      input_hash: input.input_hash,
      retryable: true,
      knowledge_candidates: structuredClone(input.archive.knowledge_candidates),
      created_at: input.now,
      updated_at: input.now
    };
  }

  async planArchiveTasks(input: PlanArchiveTasksInput): Promise<PlanArchiveTasksResult> {
    this.#plannedArchiveAttempts += 1;
    const scopedIdentity = `${input.archive.project_id}\0${input.idempotency_key}`;
    const existingPlan = this.#taskPlans.get(scopedIdentity);
    if (existingPlan !== undefined) {
      const knowledgeJob = this.#knowledgeJobs.get(existingPlan.knowledge_job_id);
      const changeProjectionJob = this.#changeProjectionJobs.get(
        existingPlan.change_projection_job_id
      );
      if (knowledgeJob === undefined || changeProjectionJob === undefined) {
        throw new KnowledgePipelineError("PIPELINE_TASK_PLAN_CORRUPT", false);
      }
      return {
        change_projection_job_id: existingPlan.change_projection_job_id,
        change_projection_job: cloneChangeProjectionJob(changeProjectionJob),
        knowledge_job: cloneJob(knowledgeJob),
        ...(existingPlan.project_content_job_id === undefined
          ? {}
          : { project_content_job_id: existingPlan.project_content_job_id })
      };
    }

    const needsProjectContentJob = input.archive.project_content_candidates.length > 0;
    const projectContentJobId = needsProjectContentJob
      ? identifier(
          "job_content",
          `${input.archive.project_id}\0${input.archive.package_sha256}`
        )
      : undefined;
    const changeProjectionIdentity = this.#changeProjectionIdentity(input);
    const existingChangeProjectionJobId = this.#changeProjectionJobByIdentity.get(
      changeProjectionIdentity
    );
    const needsNewChangeProjection = existingChangeProjectionJobId === undefined;
    const needsNewProjectContent = projectContentJobId !== undefined &&
      !this.#projectContentJobs.has(projectContentJobId);
    const noCapacity = (needsNewChangeProjection &&
        this.#activeChangeProjectionJobCount() >= this.#maxChangeProjectionJobs) ||
      this.#activeKnowledgeJobCount() >= this.#maxKnowledgeJobs ||
      (needsNewProjectContent &&
        this.#projectContentJobs.size >= this.#maxProjectContentJobs);
    if (noCapacity) {
      throw new KnowledgePipelineError("PIPELINE_QUEUE_CAPACITY_EXCEEDED", true);
    }

    const knowledgeJob = this.#newKnowledgeJob(input);
    const changeProjectionJob = needsNewChangeProjection
      ? this.#newChangeProjectionJob(input)
      : this.#changeProjectionJobs.get(existingChangeProjectionJobId);
    if (changeProjectionJob === undefined) {
      throw new KnowledgePipelineError("PIPELINE_TASK_PLAN_CORRUPT", false);
    }

    // The mutations below are the in-memory Adapter's single atomic commit.
    this.#changeProjectionJobs.set(
      changeProjectionJob.job_id,
      cloneChangeProjectionJob(changeProjectionJob)
    );
    this.#changeProjectionJobByIdentity.set(
      changeProjectionIdentity,
      changeProjectionJob.job_id
    );
    this.#knowledgeJobs.set(knowledgeJob.job_id, cloneJob(knowledgeJob));
    this.#knowledgeJobByIdentity.set(scopedIdentity, knowledgeJob.job_id);
    if (projectContentJobId !== undefined) this.#projectContentJobs.add(projectContentJobId);
    for (const candidate of input.archive.project_content_candidates) {
      const key = [
        input.archive.project_id,
        candidate.candidate_type,
        candidate.content_hash
      ].join("\0");
      if (!this.#projectCandidates.has(key)) {
        this.#projectCandidates.set(key, {
          project_id: input.archive.project_id,
          candidate: structuredClone(candidate)
        });
      }
    }
    this.#taskPlans.set(scopedIdentity, {
      change_projection_job_id: changeProjectionJob.job_id,
      knowledge_job_id: knowledgeJob.job_id,
      ...(projectContentJobId === undefined
        ? {}
        : { project_content_job_id: projectContentJobId })
    });
    return {
      change_projection_job_id: changeProjectionJob.job_id,
      change_projection_job: cloneChangeProjectionJob(changeProjectionJob),
      knowledge_job: cloneJob(knowledgeJob),
      ...(projectContentJobId === undefined
        ? {}
        : { project_content_job_id: projectContentJobId })
    };
  }

  async enqueueKnowledgeJob(input: EnqueueKnowledgeJobInput): Promise<KnowledgeExtractionJob> {
    const scopedIdentity = `${input.archive.project_id}\0${input.idempotency_key}`;
    const existingId = this.#knowledgeJobByIdentity.get(scopedIdentity);
    if (existingId !== undefined) {
      const existing = this.#knowledgeJobs.get(existingId);
      if (existing === undefined) {
        throw new KnowledgePipelineError("KNOWLEDGE_JOB_CORRUPT", false);
      }
      return cloneJob(existing);
    }
    if (this.#activeKnowledgeJobCount() >= this.#maxKnowledgeJobs) {
      throw new KnowledgePipelineError("KNOWLEDGE_QUEUE_CAPACITY_EXCEEDED", true);
    }
    const job = this.#newKnowledgeJob(input);
    this.#knowledgeJobs.set(job.job_id, cloneJob(job));
    this.#knowledgeJobByIdentity.set(scopedIdentity, job.job_id);
    return cloneJob(job);
  }

  async getKnowledgeJob(job_id: string): Promise<KnowledgeExtractionJob | null> {
    const job = this.#knowledgeJobs.get(job_id);
    return job === undefined ? null : cloneJob(job);
  }

  async listQueuedKnowledgeJobs(limit: number): Promise<KnowledgeExtractionJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new KnowledgePipelineError("KNOWLEDGE_DEQUEUE_INVALID", false);
    }
    return [...this.#knowledgeJobs.values()]
      .filter((job) => job.status === "queued" &&
        ![...this.#knowledgeJobs.values()].some((active) =>
          active.project_id === job.project_id && active.status === "extracting") &&
        [...this.#changeProjectionJobs.values()].some((changeJob) =>
          changeJob.status === "ready" &&
          changeJob.project_id === job.project_id &&
          changeJob.change_key === job.change_key &&
          changeJob.archive_id === job.archive_id &&
          changeJob.package_sha256 === job.package_sha256))
      .sort((left, right) => left.updated_at === right.updated_at
        ? (left.job_id < right.job_id ? -1 : 1)
        : left.updated_at.localeCompare(right.updated_at))
      .slice(0, limit)
      .map(cloneJob);
  }

  async listQueuedChangeProjectionJobs(limit: number): Promise<ChangeProjectionJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_DEQUEUE_INVALID", false);
    }
    return [...this.#changeProjectionJobs.values()]
      .filter((job) => job.status === "queued" &&
        ![...this.#changeProjectionJobs.values()].some((active) =>
          active.project_id === job.project_id && active.status === "projecting"))
      .sort((left, right) => left.updated_at === right.updated_at
        ? (left.job_id < right.job_id ? -1 : 1)
        : left.updated_at.localeCompare(right.updated_at))
      .slice(0, limit)
      .map(cloneChangeProjectionJob);
  }

  async getChangeProjectionJob(job_id: string): Promise<ChangeProjectionJob | null> {
    const job = this.#changeProjectionJobs.get(job_id);
    return job === undefined ? null : cloneChangeProjectionJob(job);
  }

  async claimChangeProjectionJob(
    rawInput: ClaimChangeProjectionJobInput
  ): Promise<ChangeProjectionJob> {
    const input = exactOwnDataRecord(rawInput, [
      "job_id", "owner_id", "now", "lease_expires_at"
    ], "CHANGE_PROJECTION_CLAIM_INVALID");
    const jobId = boundedProjectionText(input.job_id, "CHANGE_PROJECTION_CLAIM_INVALID");
    const ownerId = boundedProjectionText(input.owner_id, "CHANGE_PROJECTION_CLAIM_INVALID");
    if (!strictTimestamp(input.now) || !strictTimestamp(input.lease_expires_at) ||
        input.lease_expires_at <= input.now) {
      projectionError("CHANGE_PROJECTION_CLAIM_INVALID");
    }
    const job = this.#requireChangeProjectionJob(jobId);
    if (job.status !== "queued") {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_CLAIM_STATE_INVALID", false);
    }
    const leaseToken = identifier(
      "lease_change",
      [job.job_id, job.generation, ownerId, input.now, input.lease_expires_at].join("\0")
    );
    const updated: ChangeProjectionJob = {
      ...job,
      status: "projecting",
      owner_id: ownerId,
      lease_token: leaseToken,
      lease_expires_at: input.lease_expires_at,
      retryable: true,
      updated_at: input.now
    };
    this.#changeProjectionJobs.set(jobId, updated);
    return cloneChangeProjectionJob(updated);
  }

  #assertActiveChangeProjectionLease(input: {
    job_id: string;
    generation: number;
    owner_id: string;
    lease_token: string;
    now: string;
  }): ChangeProjectionJob {
    const job = this.#requireChangeProjectionJob(input.job_id);
    if (job.generation !== input.generation) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_JOB_GENERATION_STALE", false);
    }
    if (job.status !== "projecting" || job.owner_id !== input.owner_id ||
        job.lease_token !== input.lease_token) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_LEASE_STALE", false);
    }
    if (job.lease_expires_at === undefined || input.now >= job.lease_expires_at) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_LEASE_EXPIRED", false);
    }
    return job;
  }

  async renewChangeProjectionLease(
    rawInput: RenewChangeProjectionLeaseInput
  ): Promise<ChangeProjectionJob> {
    const input = exactOwnDataRecord(rawInput, [
      "job_id", "generation", "owner_id", "lease_token", "now", "lease_expires_at"
    ], "CHANGE_PROJECTION_RENEW_INVALID");
    const normalized = {
      job_id: boundedProjectionText(input.job_id, "CHANGE_PROJECTION_RENEW_INVALID"),
      generation: input.generation,
      owner_id: boundedProjectionText(input.owner_id, "CHANGE_PROJECTION_RENEW_INVALID"),
      lease_token: boundedProjectionText(input.lease_token, "CHANGE_PROJECTION_RENEW_INVALID"),
      now: input.now
    };
    if (!Number.isSafeInteger(normalized.generation) || Number(normalized.generation) < 1 ||
        !strictTimestamp(normalized.now) || !strictTimestamp(input.lease_expires_at) ||
        input.lease_expires_at <= normalized.now) {
      projectionError("CHANGE_PROJECTION_RENEW_INVALID");
    }
    const job = this.#assertActiveChangeProjectionLease({
      ...normalized,
      generation: Number(normalized.generation),
      now: normalized.now as string
    });
    const updated = {
      ...job,
      lease_expires_at: input.lease_expires_at,
      updated_at: normalized.now as string
    };
    this.#changeProjectionJobs.set(job.job_id, updated);
    return cloneChangeProjectionJob(updated);
  }

  prepareChangeProjectionCommit(
    input: CommitChangeProjectionInput
  ): PreparedChangeProjectionCommit {
    const job = this.#requireChangeProjectionJob(input.job_id);
    if (job.generation !== input.generation) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_JOB_GENERATION_STALE", false);
    }
    if (job.project_generation !== this.#latestChangeProjectionGeneration.get(job.project_id)) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_PROJECT_GENERATION_STALE", false);
    }
    if (job.status === "ready") {
      if (job.output_hash === input.output_hash && job.document_count === input.documents.length) {
        return { disposition: "existing", job: cloneChangeProjectionJob(job) };
      }
      throw new KnowledgePipelineError("CHANGE_PROJECTION_COMPLETE_CONFLICT", false);
    }
    this.#assertActiveChangeProjectionLease(input);
    const updated: ChangeProjectionJob = {
      ...job,
      status: "ready",
      output_hash: input.output_hash,
      document_count: input.documents.length,
      retryable: false,
      updated_at: input.now
    };
    delete updated.reason_code;
    delete updated.owner_id;
    delete updated.lease_token;
    delete updated.lease_expires_at;
    return { disposition: "commit", job: cloneChangeProjectionJob(updated) };
  }

  applyPreparedChangeProjectionCommit(job: ChangeProjectionJob): void {
    this.#changeProjectionJobs.set(job.job_id, cloneChangeProjectionJob(job));
  }

  async failChangeProjectionJob(
    rawInput: FailChangeProjectionJobInput
  ): Promise<ChangeProjectionJob> {
    const input = exactOwnDataRecord(rawInput, [
      "job_id", "generation", "owner_id", "lease_token", "reason_code", "retryable", "now"
    ], "CHANGE_PROJECTION_FAIL_INVALID");
    const normalized = {
      job_id: boundedProjectionText(input.job_id, "CHANGE_PROJECTION_FAIL_INVALID"),
      generation: input.generation,
      owner_id: boundedProjectionText(input.owner_id, "CHANGE_PROJECTION_FAIL_INVALID"),
      lease_token: boundedProjectionText(input.lease_token, "CHANGE_PROJECTION_FAIL_INVALID"),
      reason_code: boundedProjectionText(input.reason_code, "CHANGE_PROJECTION_FAIL_INVALID"),
      retryable: input.retryable,
      now: input.now
    };
    if (!Number.isSafeInteger(normalized.generation) || Number(normalized.generation) < 1 ||
        typeof normalized.retryable !== "boolean" || !strictTimestamp(normalized.now)) {
      projectionError("CHANGE_PROJECTION_FAIL_INVALID");
    }
    const job = this.#assertActiveChangeProjectionLease({
      ...normalized,
      generation: Number(normalized.generation),
      now: normalized.now as string
    });
    const updated: ChangeProjectionJob = {
      ...job,
      status: "failed",
      retryable: normalized.retryable,
      reason_code: normalized.reason_code,
      updated_at: normalized.now as string
    };
    delete updated.owner_id;
    delete updated.lease_token;
    delete updated.lease_expires_at;
    this.#changeProjectionJobs.set(job.job_id, updated);
    return cloneChangeProjectionJob(updated);
  }

  async reapExpiredChangeProjectionLease(
    rawInput: ReapChangeProjectionLeaseInput
  ): Promise<ChangeProjectionJob> {
    const input = exactOwnDataRecord(rawInput, ["job_id", "generation", "now"],
      "CHANGE_PROJECTION_REAP_INVALID");
    const jobId = boundedProjectionText(input.job_id, "CHANGE_PROJECTION_REAP_INVALID");
    if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 1 ||
        !strictTimestamp(input.now)) projectionError("CHANGE_PROJECTION_REAP_INVALID");
    const job = this.#requireChangeProjectionJob(jobId);
    if (job.generation !== input.generation) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_JOB_GENERATION_STALE", false);
    }
    if (job.status !== "projecting" || job.lease_expires_at === undefined ||
        input.now < job.lease_expires_at) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_REAP_STATE_INVALID", false);
    }
    const updated: ChangeProjectionJob = {
      ...job,
      status: "failed",
      retryable: true,
      reason_code: "CHANGE_PROJECTION_LEASE_EXPIRED",
      updated_at: input.now
    };
    delete updated.owner_id;
    delete updated.lease_token;
    delete updated.lease_expires_at;
    this.#changeProjectionJobs.set(jobId, updated);
    return cloneChangeProjectionJob(updated);
  }

  async retryChangeProjectionJob(
    rawInput: RetryChangeProjectionJobInput
  ): Promise<ChangeProjectionJob> {
    const input = exactOwnDataRecord(rawInput, [
      "job_id", "expected_generation", "expected_status", "now"
    ], "CHANGE_PROJECTION_RETRY_INVALID");
    const jobId = boundedProjectionText(input.job_id, "CHANGE_PROJECTION_RETRY_INVALID");
    if (!Number.isSafeInteger(input.expected_generation) ||
        Number(input.expected_generation) < 1 || input.expected_status !== "failed" ||
        !strictTimestamp(input.now)) projectionError("CHANGE_PROJECTION_RETRY_INVALID");
    const job = this.#requireChangeProjectionJob(jobId);
    if (job.generation !== input.expected_generation) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_JOB_GENERATION_STALE", false);
    }
    if (job.status !== "failed" || !job.retryable) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_RETRY_STATE_INVALID", false);
    }
    if (this.#activeChangeProjectionJobCount() >= this.#maxChangeProjectionJobs) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_QUEUE_CAPACITY_EXCEEDED", true);
    }
    const updated: ChangeProjectionJob = {
      ...job,
      status: "queued",
      attempt: job.attempt + 1,
      generation: job.generation + 1,
      retryable: true,
      updated_at: input.now
    };
    delete updated.output_hash;
    delete updated.document_count;
    delete updated.reason_code;
    delete updated.owner_id;
    delete updated.lease_token;
    delete updated.lease_expires_at;
    this.#changeProjectionJobs.set(jobId, updated);
    return cloneChangeProjectionJob(updated);
  }

  async startKnowledgeJob(job_id: string, now: string): Promise<KnowledgeExtractionJob> {
    const job = this.#requireJob(job_id);
    if (job.status !== "queued") {
      throw new KnowledgePipelineError("KNOWLEDGE_START_STATE_INVALID", false);
    }
    const updated: KnowledgeExtractionJob = {
      ...job,
      status: "extracting",
      retryable: true,
      updated_at: now
    };
    this.#knowledgeJobs.set(job_id, updated);
    return cloneJob(updated);
  }

  prepareKnowledgeCommit(input: CommitKnowledgeResultsInput): PreparedKnowledgeCommit {
    const job = this.#requireJob(input.job_id);
    if (job.generation !== input.generation) {
      throw new KnowledgePipelineError("KNOWLEDGE_JOB_GENERATION_STALE", false);
    }
    if (job.generation !== this.#latestGeneration.get(job.project_id)) {
      throw new KnowledgePipelineError("KNOWLEDGE_PROJECT_GENERATION_STALE", false);
    }
    if (job.status === "ready") {
      if (job.output_hash === input.output_hash && job.result_count === input.results.length) {
        return { disposition: "existing", job: cloneJob(job) };
      }
      throw new KnowledgePipelineError("KNOWLEDGE_COMPLETE_CONFLICT", false);
    }
    if (job.status !== "extracting") {
      throw new KnowledgePipelineError("KNOWLEDGE_COMPLETE_STATE_INVALID", false);
    }
    const updated: KnowledgeExtractionJob = {
      ...job,
      status: "ready",
      output_hash: input.output_hash,
      result_count: input.results.length,
      retryable: false,
      updated_at: input.now
    };
    delete updated.reason_code;
    return { disposition: "commit", job: cloneJob(updated) };
  }

  applyPreparedKnowledgeCommit(job: KnowledgeExtractionJob): void {
    this.#knowledgeJobs.set(job.job_id, cloneJob(job));
  }

  async failKnowledgeJob(
    job_id: string,
    generation: number,
    reason_code: string,
    retryable: boolean,
    now: string
  ): Promise<KnowledgeExtractionJob> {
    const job = this.#requireJob(job_id);
    if (job.generation !== generation) {
      throw new KnowledgePipelineError("KNOWLEDGE_JOB_GENERATION_STALE", false);
    }
    if (job.status !== "extracting" && job.status !== "queued") {
      throw new KnowledgePipelineError("KNOWLEDGE_FAIL_STATE_INVALID", false);
    }
    const updated: KnowledgeExtractionJob = {
      ...job,
      status: "failed",
      retryable,
      reason_code,
      updated_at: now
    };
    this.#knowledgeJobs.set(job_id, updated);
    return cloneJob(updated);
  }

  async retryKnowledgeJob(job_id: string, now: string): Promise<KnowledgeExtractionJob> {
    const job = this.#requireJob(job_id);
    if (job.status !== "failed" || !job.retryable) {
      throw new KnowledgePipelineError("KNOWLEDGE_RETRY_STATE_INVALID", false);
    }
    if (this.#activeKnowledgeJobCount() >= this.#maxKnowledgeJobs) {
      throw new KnowledgePipelineError("KNOWLEDGE_QUEUE_CAPACITY_EXCEEDED", true);
    }
    const updated: KnowledgeExtractionJob = {
      ...job,
      status: "queued",
      attempt: job.attempt + 1,
      generation: this.#nextGeneration(job.project_id),
      retryable: true,
      updated_at: now
    };
    delete updated.output_hash;
    delete updated.result_count;
    delete updated.reason_code;
    this.#knowledgeJobs.set(job_id, updated);
    return cloneJob(updated);
  }

  async listProjectContentCandidates(
    query: ProjectContentCandidateQuery
  ): Promise<ProjectContentCandidateQueryResult> {
    this.#lastCandidateQuery = structuredClone(query);
    const matches = [...this.#projectCandidates.values()]
      .filter((stored) =>
        stored.project_id === query.project_id &&
        stored.candidate.candidate_type === query.candidate_type &&
        stored.candidate.status === query.status
      )
      .map((stored) => stored.candidate)
      .sort((left, right) =>
        right.provenance.created_at.localeCompare(left.provenance.created_at) ||
        left.candidate_id.localeCompare(right.candidate_id)
      );
    let start = 0;
    if (query.cursor !== undefined) {
      let cursor: { created_at: string; candidate_id: string };
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8")
        );
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("cursor is not an object");
        }
        const record = parsed as Record<string, unknown>;
        if (typeof record.created_at !== "string" ||
            typeof record.candidate_id !== "string" ||
            Object.keys(record).some((key) =>
              key !== "created_at" && key !== "candidate_id"
            )) {
          throw new Error("cursor has invalid fields");
        }
        cursor = {
          created_at: record.created_at,
          candidate_id: record.candidate_id
        };
      } catch {
        throw new KnowledgePipelineError("CANDIDATE_CURSOR_INVALID", false);
      }
      const index = matches.findIndex((candidate) =>
        candidate.provenance.created_at === cursor.created_at &&
        candidate.candidate_id === cursor.candidate_id
      );
      if (index < 0) throw new KnowledgePipelineError("CANDIDATE_CURSOR_INVALID", false);
      start = index + 1;
    }
    const items = matches.slice(start, start + query.limit).map((item) => structuredClone(item));
    const last = items.at(-1);
    const hasMore = start + items.length < matches.length;
    return {
      items,
      ...(hasMore && last !== undefined
        ? {
            next_cursor: Buffer.from(JSON.stringify({
              created_at: last.provenance.created_at,
              candidate_id: last.candidate_id
            })).toString("base64url")
          }
        : {})
    };
  }

  #requireJob(job_id: string): KnowledgeExtractionJob {
    const job = this.#knowledgeJobs.get(job_id);
    if (job === undefined) {
      throw new KnowledgePipelineError("KNOWLEDGE_JOB_NOT_FOUND", false);
    }
    return job;
  }

  #requireChangeProjectionJob(job_id: string): ChangeProjectionJob {
    const job = this.#changeProjectionJobs.get(job_id);
    if (job === undefined) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_JOB_NOT_FOUND", false);
    }
    return job;
  }

  counts() {
    return {
      change_projection: this.#changeProjectionJobs.size,
      knowledge_extraction: this.#knowledgeJobs.size,
      project_content_governance: this.#projectContentJobs.size,
      project_content_candidates: this.#projectCandidates.size
    };
  }

  plannedArchiveAttempts(): number {
    return this.#plannedArchiveAttempts;
  }

  lastCandidateQuery(): ProjectContentCandidateQuery | undefined {
    return this.#lastCandidateQuery === undefined
      ? undefined
      : structuredClone(this.#lastCandidateQuery);
  }
}

function mergeStrings(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b));
}

export class MemoryKnowledgeIndex implements KnowledgeIndex {
  readonly #entries = new Map<string, KnowledgeResult>();
  #lastQuery: KnowledgeIndexQuery | undefined;
  #queryCount = 0;

  prepareKnowledgeCommit(results: readonly KnowledgeResult[]): Map<string, KnowledgeResult> {
    const prepared = new Map(
      [...this.#entries.entries()].map(([key, value]) => [key, structuredClone(value)])
    );
    for (const incoming of results) {
      const key = `${incoming.project_id}\0${incoming.content_hash}`;
      const existing = prepared.get(key);
      if (existing === undefined) {
        prepared.set(key, structuredClone(incoming));
        continue;
      }
      const current = incoming.generation >= existing.generation ? incoming : existing;
      prepared.set(key, {
        ...structuredClone(current),
        source_archive_ids: mergeStrings(
          existing.source_archive_ids,
          incoming.source_archive_ids
        ),
        source_change_keys: mergeStrings(
          existing.source_change_keys,
          incoming.source_change_keys
        ),
        source_candidate_ids: mergeStrings(
          existing.source_candidate_ids,
          incoming.source_candidate_ids
        ),
        source_refs: mergeStrings(existing.source_refs, incoming.source_refs),
        created_at: existing.created_at < incoming.created_at
          ? existing.created_at
          : incoming.created_at,
        updated_at: current.updated_at
      });
    }
    return prepared;
  }

  applyPreparedKnowledgeCommit(prepared: Map<string, KnowledgeResult>): void {
    this.#entries.clear();
    for (const [key, value] of prepared) {
      this.#entries.set(key, structuredClone(value));
    }
  }

  async query(query: KnowledgeIndexQuery): Promise<KnowledgeResult[]> {
    this.#lastQuery = structuredClone(query);
    this.#queryCount += 1;
    const needle = query.query.toLocaleLowerCase();
    return [...this.#entries.values()]
      .filter((entry) =>
        entry.project_id === query.project_id &&
        entry.content_kind === query.content_kind &&
        entry.status === query.status &&
        [entry.summary, entry.reusability_scope, ...entry.source_refs]
          .some((value) => value.toLocaleLowerCase().includes(needle))
      )
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        left.knowledge_id.localeCompare(right.knowledge_id)
      )
      .slice(0, query.limit)
      .map((entry) => structuredClone(entry));
  }

  lastQuery(): KnowledgeIndexQuery | undefined {
    return this.#lastQuery === undefined ? undefined : structuredClone(this.#lastQuery);
  }

  queryCount(): number {
    return this.#queryCount;
  }
}

export interface MemoryKnowledgeCommitOptions {
  fail_next_commit_reason_code?: string;
}

export class MemoryKnowledgeCommitPort implements KnowledgeCommitPort {
  readonly #jobRepository: MemoryJobRepository;
  readonly #knowledgeIndex: MemoryKnowledgeIndex;
  #failNextCommitReasonCode: string | undefined;

  constructor(
    jobRepository: MemoryJobRepository,
    knowledgeIndex: MemoryKnowledgeIndex,
    options: MemoryKnowledgeCommitOptions = {}
  ) {
    this.#jobRepository = jobRepository;
    this.#knowledgeIndex = knowledgeIndex;
    this.#failNextCommitReasonCode = options.fail_next_commit_reason_code;
  }

  async commitKnowledgeResults(
    input: CommitKnowledgeResultsInput
  ): Promise<KnowledgeExtractionJob> {
    const preparedJob = this.#jobRepository.prepareKnowledgeCommit(input);
    if (preparedJob.disposition === "existing") return cloneJob(preparedJob.job);
    const preparedIndex = this.#knowledgeIndex.prepareKnowledgeCommit(input.results);
    if (this.#failNextCommitReasonCode !== undefined) {
      const reasonCode = this.#failNextCommitReasonCode;
      this.#failNextCommitReasonCode = undefined;
      throw new KnowledgePipelineError(reasonCode, true);
    }
    // Both prepared snapshots are applied synchronously with no fallible work
    // between them, modelling the single conditional DB transaction port.
    this.#knowledgeIndex.applyPreparedKnowledgeCommit(preparedIndex);
    this.#jobRepository.applyPreparedKnowledgeCommit(preparedJob.job);
    return cloneJob(preparedJob.job);
  }
}

const changeDocumentKeys = [
  "schema_version",
  "document_id",
  "document_version",
  "project_id",
  "change_key",
  "archive_id",
  "package_sha256",
  "project_version",
  "document_type",
  "source_path",
  "content_hash",
  "content",
  "generation",
  "created_at",
  "updated_at"
] as const;

function invalidChangeDocument(): never {
  throw new KnowledgePipelineError("CHANGE_DOCUMENT_INVALID", false);
}

function ownDataRecord(
  value: unknown,
  exactKeys: readonly string[]
): Record<string, unknown> {
  return exactOwnDataRecord(value, exactKeys, "CHANGE_DOCUMENT_INVALID");
}

function ownDataArray(value: unknown): unknown[] {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidChangeDocument();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) invalidChangeDocument();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number") {
    invalidChangeDocument();
  }
  const items: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalidChangeDocument();
    }
    items.push(descriptor.value);
  }
  const expectedKeys = new Set(["length", ...items.map((_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) invalidChangeDocument();
  return items;
}

function validatedChangeDocuments(value: unknown): ChangeDocument[] {
  const documents = ownDataArray(value);
  const seenIds = new Set<string>();
  const seenFoldedPaths = new Set<string>();
  let previousDocumentId: string | undefined;
  return documents.map((candidate) => {
    const record = ownDataRecord(candidate, changeDocumentKeys);
    const documentType = record.document_type;
    if (record.schema_version !== 1 || typeof record.document_id !== "string" ||
        typeof record.document_version !== "string" || typeof record.project_id !== "string" ||
        typeof record.change_key !== "string" || typeof record.archive_id !== "string" ||
        typeof record.package_sha256 !== "string" || typeof record.project_version !== "string" ||
        !["design", "plan", "test_scenarios", "change_summary"].includes(String(documentType)) ||
        typeof record.source_path !== "string" ||
          !safeChangeDocumentPath(
            record.source_path,
            String(documentType),
            record.change_key
          ) ||
        typeof record.content_hash !== "string" || typeof record.content !== "string" ||
        record.content.length > 1024 * 1024 ||
        !strictTimestamp(record.created_at) || !strictTimestamp(record.updated_at) ||
        record.created_at > record.updated_at ||
        !Number.isInteger(record.generation) || Number(record.generation) < 1 ||
        !sha256Schema.safeParse(record.content_hash).success ||
        !sha256Schema.safeParse(record.package_sha256).success) {
      invalidChangeDocument();
    }
    const document = record as unknown as ChangeDocument;
    const foldedPath = document.source_path.normalize("NFC").toLocaleLowerCase("en-US");
    if (document.document_id !== changeDocumentIdentity({
      project_id: document.project_id,
      change_key: document.change_key,
      document_type: document.document_type,
      source_path: document.source_path
    }) ||
        document.document_version !== changeDocumentVersion(document.content_hash) ||
        sha256(new TextEncoder().encode(document.content)) !== document.content_hash ||
        seenIds.has(document.document_id) || seenFoldedPaths.has(foldedPath) ||
        (previousDocumentId !== undefined &&
          codepointCompare(previousDocumentId, document.document_id) >= 0)) {
      invalidChangeDocument();
    }
    seenIds.add(document.document_id);
    seenFoldedPaths.add(foldedPath);
    previousDocumentId = document.document_id;
    return structuredClone(document);
  });
}

/** @see safeChangeDocumentPath */
export const changeSummaryPaths: ReadonlySet<string> = new Set([
  "summary/change-summary.json",
  "reports/final/summary-data.json"
]);

function safeChangeDocumentPath(
  value: string,
  documentType: string,
  changeKey: unknown
): boolean {
  if (value !== value.normalize("NFC")) return false;
  const classification = classifyContentPath({
    schema_version: 1,
    path: value,
    source_kind: "branch_file"
  });
  if ("reason_code" in classification) return false;
  // change_summary 有两个合法位置：v2 包在 summary/change-summary.json，
  // 生产的 core-v1 包在 reports/final/summary-data.json。
  if (documentType === "change_summary") return changeSummaryPaths.has(value);
  if (documentType === "plan") {
    return /^plans\/(?:[^/]+\/)*[^/]+\.md$/u.test(value) &&
      !/-test-scenarios\.md$/u.test(value);
  }
  if (documentType === "design") {
    return /^spec\/(?:[^/]+\/)*[^/]+\.md$/u.test(value);
  }
  if (documentType === "test_scenarios") {
    return typeof changeKey === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(changeKey) &&
      value === `plans/${changeKey}-test-scenarios.md`;
  }
  return false;
}

export class MemoryChangeDocumentIndex {
  readonly #documents = new Map<string, ChangeDocument>();

  prepareChangeProjectionCommit(
    job: ChangeProjectionJob,
    documents: readonly ChangeDocument[]
  ): Map<string, ChangeDocument> {
    const prepared = new Map(
      [...this.#documents.entries()].map(([key, value]) => [key, structuredClone(value)])
    );
    for (const [key, document] of prepared) {
      if (document.project_id === job.project_id && document.change_key === job.change_key) {
        prepared.delete(key);
      }
    }
    for (const document of documents) {
      if (document.project_id !== job.project_id || document.change_key !== job.change_key ||
          document.archive_id !== job.archive_id ||
          document.package_sha256 !== job.package_sha256 ||
          document.project_version !== job.project_version ||
          document.generation !== job.project_generation) {
        invalidChangeDocument();
      }
      prepared.set(`${document.project_id}\0${document.document_id}`, structuredClone(document));
    }
    return prepared;
  }

  applyPreparedChangeProjectionCommit(prepared: Map<string, ChangeDocument>): void {
    this.#documents.clear();
    for (const [key, value] of prepared) this.#documents.set(key, structuredClone(value));
  }

  snapshot(project_id: string): ChangeDocument[] {
    return [...this.#documents.values()]
      .filter((document) => document.project_id === project_id)
      .sort((left, right) => codepointCompare(left.document_id, right.document_id))
      .map((document) => structuredClone(document));
  }
}

export interface MemoryChangeProjectionCommitOptions {
  fail_next_commit_reason_code?: string;
}

export class MemoryChangeProjectionCommitPort implements ChangeProjectionCommitPort {
  readonly #jobRepository: MemoryJobRepository;
  readonly #documentIndex: MemoryChangeDocumentIndex;
  #failNextCommitReasonCode: string | undefined;

  constructor(
    jobRepository: MemoryJobRepository,
    documentIndex: MemoryChangeDocumentIndex,
    options: MemoryChangeProjectionCommitOptions = {}
  ) {
    this.#jobRepository = jobRepository;
    this.#documentIndex = documentIndex;
    this.#failNextCommitReasonCode = options.fail_next_commit_reason_code;
  }

  async commitChangeProjection(
    rawInput: CommitChangeProjectionInput
  ): Promise<ChangeProjectionJob> {
    const input = exactOwnDataRecord(rawInput, [
      "job_id",
      "generation",
      "owner_id",
      "lease_token",
      "output_hash",
      "documents",
      "now"
    ], "CHANGE_PROJECTION_COMMIT_INVALID");
    const jobId = boundedProjectionText(input.job_id, "CHANGE_PROJECTION_COMMIT_INVALID");
    const ownerId = boundedProjectionText(input.owner_id, "CHANGE_PROJECTION_COMMIT_INVALID");
    const leaseToken = boundedProjectionText(
      input.lease_token,
      "CHANGE_PROJECTION_COMMIT_INVALID"
    );
    if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 1 ||
        !strictTimestamp(input.now)) {
      projectionError("CHANGE_PROJECTION_COMMIT_INVALID");
    }
    const documents = validatedChangeDocuments(input.documents);
    if (!sha256Schema.safeParse(input.output_hash).success ||
        input.output_hash !== changeProjectionOutputHash(documents)) {
      throw new KnowledgePipelineError("CHANGE_PROJECTION_OUTPUT_INVALID", false);
    }
    const normalizedInput: CommitChangeProjectionInput = {
      job_id: jobId,
      generation: Number(input.generation),
      owner_id: ownerId,
      lease_token: leaseToken,
      output_hash: input.output_hash,
      documents,
      now: input.now
    };
    const preparedJob = this.#jobRepository.prepareChangeProjectionCommit(normalizedInput);
    if (preparedJob.disposition === "existing") {
      return cloneChangeProjectionJob(preparedJob.job);
    }
    const preparedIndex = this.#documentIndex.prepareChangeProjectionCommit(
      preparedJob.job,
      documents
    );
    if (this.#failNextCommitReasonCode !== undefined) {
      const reasonCode = this.#failNextCommitReasonCode;
      this.#failNextCommitReasonCode = undefined;
      throw new KnowledgePipelineError(reasonCode, true);
    }
    this.#documentIndex.applyPreparedChangeProjectionCommit(preparedIndex);
    this.#jobRepository.applyPreparedChangeProjectionCommit(preparedJob.job);
    return cloneChangeProjectionJob(preparedJob.job);
  }
}
