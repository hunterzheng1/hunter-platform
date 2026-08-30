import { Buffer } from "node:buffer";

import {
  canonicalJson,
  fileOperationSchema,
  knowledgeCandidateSchema,
  type FileOperation
} from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";
import type { SensitiveFinding } from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { z } from "zod";

import type {
  ChangeArchivePackageRecord,
  ProposalSessionRecord,
  ServerRepository
} from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import { buildSemanticIndex, isSemanticSourcePath } from "../semantic/indexer.js";
import type { SemanticStore } from "../semantic/store.js";
import { SEMANTIC_INDEX_SCHEMA_VERSION } from "../semantic/store.js";
import type { ArtifactStorage } from "../storage/interface.js";
import { archiveRootPrefix } from "./change-archive.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const archiveChangeKeySchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u);
const archiveRoleSchema = z.enum([
  "summary",
  "spec",
  "plan",
  // Produced by harness/scripts/harness_knowledge_candidates.py from the same
  // summary-data. Optional: archives built before it exists carry no such entry.
  "knowledge_candidates",
  "archive_meta",
  "change_context"
]);

const archiveManifestSchema = z.object({
  schema_version: z.literal(1),
  profile: z.literal("core-v1"),
  change_key: z.string().min(1).max(160),
  created_at: z.iso.datetime(),
  source: z.object({
    commit: z.string().min(7).max(128).nullable(),
    tree: z.string().min(7).max(128).nullable()
  }).strict(),
  files: z.array(z.object({
    path: z.string().min(1).max(500),
    role: archiveRoleSchema,
    media_type: z.enum(["application/json", "text/markdown"]),
    content_sha256: sha256Schema,
    size_bytes: z.number().int().nonnegative()
  }).strict()).min(1)
}).strict();

const archiveSummary22Schema = z.object({
  schemaVersion: z.literal("2.2"),
  changeName: z.string().trim().min(1),
  finalStatus: z.string().trim().min(1),
  finalCommit: z.string(),
  stageStatus: z.record(z.string(), z.string())
    .refine((value) => Object.keys(value).length > 0),
  verification: z.object({
    unitTests: z.record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0),
    apiTests: z.record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0),
    browserE2E: z.record(z.string(), z.unknown()).optional(),
    dbCompatibility: z.string(),
    coverageDisplay: z.string().optional()
  }).passthrough()
}).passthrough();

const archiveSummary23Schema = z.object({
  schemaVersion: z.literal("2.3"),
  changeName: z.string().trim().min(1),
  businessGoal: z.string(),
  finalStatus: z.string().trim().min(1),
  finalCommit: z.string(),
  stageStatus: z.object({
    plan: z.string(),
    run: z.string(),
    test: z.string(),
    review: z.string(),
    submit: z.string(),
    archive: z.string()
  }).passthrough(),
  verification: z.object({
    unitTests: z.record(z.string(), z.unknown()),
    apiTests: z.record(z.string(), z.unknown()),
    browserE2E: z.record(z.string(), z.unknown()).optional(),
    dbCompatibility: z.string(),
    coverageDisplay: z.string()
  }).passthrough(),
  changedFiles: z.array(z.unknown()),
  artifacts: z.array(z.unknown()),
  archiveManifest: z.object({
    movedFiles: z.number().int().nonnegative(),
    generatedFiles: z.number().int().nonnegative(),
    totalArchiveFiles: z.number().int().nonnegative(),
    checksumStatus: z.string().trim().min(1)
  }).passthrough(),
  reportPipeline: z.object({
    schema_version: z.literal(1),
    generated_at: z.string().trim().min(1),
    event_count: z.number().int().nonnegative(),
    sources: z.array(z.string()),
    phases: z.record(z.string(), z.unknown()),
    commands: z.array(z.unknown()),
    verificationChecks: z.array(z.unknown()),
    artifacts: z.array(z.unknown()),
    validationIssues: z.array(z.unknown()),
    sourceConsistency: z.object({
      ok: z.boolean(),
      issues: z.array(z.unknown())
    }).passthrough()
  }).passthrough()
}).passthrough();

const archiveSummarySchema = z.union([archiveSummary22Schema, archiveSummary23Schema]);

type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

export interface ArchivePackageLimits {
  maxFileBytes: number;
  maxUploadFiles: number;
  maxPackageBytes: number;
  maxUncompressedBytes: number;
}

export interface ArchivePackageReceipt {
  schema_version: 1;
  archive_id: string;
  project_id: string;
  change_key: string;
  package_sha256: string;
  manifest_sha256: string;
  artifact_id: string | null;
  archive_status: "durable";
  knowledge_status: "indexing" | "ready" | "failed";
  stored_files: number;
  uploaded_at: string;
}

interface ValidatedArchiveFile {
  path: string;
  content: Uint8Array;
  text: string;
  contentSha256: string;
  sizeBytes: number;
}

interface ValidatedArchivePackage {
  manifest: ArchiveManifest;
  manifestSha256: string;
  packageSha256: string;
  files: ValidatedArchiveFile[];
}

const ALLOWED_PATHS: ReadonlyArray<{
  role: ArchiveManifest["files"][number]["role"];
  pattern: RegExp;
  mediaType: "application/json" | "text/markdown";
}> = [
  { role: "summary", pattern: /^reports\/final\/summary-data\.json$/u, mediaType: "application/json" },
  { role: "spec", pattern: /^spec\/(?:[^/]+\/)*[^/]+\.md$/u, mediaType: "text/markdown" },
  { role: "plan", pattern: /^plans\/(?:[^/]+\/)*[^/]+\.md$/u, mediaType: "text/markdown" },
  {
    role: "knowledge_candidates",
    pattern: /^candidates\/knowledge\.json$/u,
    mediaType: "application/json"
  },
  { role: "archive_meta", pattern: /^archive-meta\.md$/u, mediaType: "text/markdown" },
  { role: "change_context", pattern: /^change-context\.json$/u, mediaType: "application/json" }
];

function archiveSummaryIssues(
  parsed: unknown,
  unionError: z.ZodError
): Array<{path: string; code: string; message: string}> {
  // A union error only says "no variant matched"; the actionable cause lives in
  // the variant whose schemaVersion literal the payload claimed. Report that
  // variant's issues so the CLI can point at the exact field.
  const claimed = typeof parsed === "object" && parsed !== null &&
    "schemaVersion" in parsed
    ? (parsed as Record<string, unknown>).schemaVersion
    : undefined;
  const variant = claimed === "2.2" ? archiveSummary22Schema
    : claimed === "2.3" ? archiveSummary23Schema
    : undefined;
  const error = variant === undefined
    ? unionError
    : (variant.safeParse(parsed).error ?? unionError);
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message
  }));
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new ServerDomainError(422, "ARCHIVE_PACKAGE_INVALID", message, details);
}

function failureCode(error: unknown): string {
  if (error instanceof ServerDomainError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{1,100}$/u.test(error.code)) {
    return error.code;
  }
  return "ARCHIVE_INGEST_FAILED";
}

function normalizeEntryPath(rawPath: string): string {
  if (rawPath.includes("\\") || rawPath.includes("\0") || rawPath.startsWith("/") ||
      /^[A-Za-z]:/u.test(rawPath)) {
    invalid("archive contains an unsafe path", { path: rawPath });
  }
  const normalized = rawPath.normalize("NFC");
  const segments = normalized.split("/");
  if (normalized !== rawPath || segments.some((part) => part === "" || part === "." || part === "..")) {
    invalid("archive contains a non-canonical path", { path: rawPath });
  }
  return normalized;
}

function validateDeclaredPath(file: ArchiveManifest["files"][number]): void {
  const policy = ALLOWED_PATHS.find((candidate) => candidate.pattern.test(file.path));
  if (policy === undefined || policy.role !== file.role || policy.mediaType !== file.media_type) {
    invalid("archive manifest declares a non-core file", {
      path: file.path,
      role: file.role,
      media_type: file.media_type
    });
  }
}

function validateZipEntryType(entry: AdmZip.IZipEntry): void {
  const attributes = Number(entry.header.attr ?? 0);
  const unixMode = (attributes >>> 16) & 0xffff;
  if ((unixMode & 0xf000) === 0xa000) {
    invalid("archive symbolic links are forbidden", { path: entry.entryName });
  }
  if ((Number(entry.header.flags ?? 0) & 0x1) !== 0) {
    invalid("encrypted archive entries are forbidden", { path: entry.entryName });
  }
}

interface RawZipEntry {
  path: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  localHeaderOffset: number;
}

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;

function requireZipRange(bytes: Buffer, offset: number, length: number, section: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset > bytes.byteLength - length) {
    invalid("archive ZIP structure is out of bounds", { section });
  }
}

function zipUInt16(bytes: Buffer, offset: number, section: string): number {
  requireZipRange(bytes, offset, 2, section);
  return bytes.readUInt16LE(offset);
}

function zipUInt32(bytes: Buffer, offset: number, section: string): number {
  requireZipRange(bytes, offset, 4, section);
  return bytes.readUInt32LE(offset);
}

function decodeZipFilename(raw: Buffer, flags: number): string {
  if (raw.byteLength === 0 || raw.byteLength > 1024) {
    invalid("archive ZIP filename length is invalid");
  }
  if (raw.some((value) => value > 0x7f) && (flags & 0x0800) === 0) {
    invalid("archive non-ASCII filenames must use UTF-8");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    invalid("archive ZIP filename is not valid UTF-8");
  }
}

function validateRawZipStructure(bytes: Buffer, maxEntries: number): RawZipEntry[] {
  const endOffset = bytes.byteLength - 22;
  requireZipRange(bytes, endOffset, 22, "end of central directory");
  if (zipUInt32(bytes, endOffset, "end of central directory") !== ZIP_END_SIGNATURE) {
    invalid("archive ZIP end record is missing or has trailing data");
  }
  const diskNumber = zipUInt16(bytes, endOffset + 4, "end of central directory");
  const centralDisk = zipUInt16(bytes, endOffset + 6, "end of central directory");
  const diskEntries = zipUInt16(bytes, endOffset + 8, "end of central directory");
  const totalEntries = zipUInt16(bytes, endOffset + 10, "end of central directory");
  const centralSize = zipUInt32(bytes, endOffset + 12, "end of central directory");
  const centralOffset = zipUInt32(bytes, endOffset + 16, "end of central directory");
  const archiveCommentLength = zipUInt16(bytes, endOffset + 20, "end of central directory");
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    invalid("multi-disk ZIP archives are forbidden");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    invalid("ZIP64 archives are forbidden");
  }
  if (totalEntries === 0 || totalEntries > maxEntries) {
    invalid("archive package file count is outside the allowed range", {
      file_count: totalEntries,
      max_files: maxEntries
    });
  }
  if (archiveCommentLength !== 0) {
    invalid("archive ZIP comments are forbidden");
  }
  requireZipRange(bytes, centralOffset, centralSize, "central directory");
  if (centralOffset + centralSize !== endOffset) {
    invalid("archive ZIP central directory boundaries are invalid");
  }

  const entries: RawZipEntry[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const section = `central directory entry ${index}`;
    requireZipRange(bytes, cursor, 46, section);
    if (zipUInt32(bytes, cursor, section) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      invalid("archive ZIP central directory entry is invalid", { entry_index: index });
    }
    const versionNeeded = zipUInt16(bytes, cursor + 6, section);
    const flags = zipUInt16(bytes, cursor + 8, section);
    const method = zipUInt16(bytes, cursor + 10, section);
    const crc32 = zipUInt32(bytes, cursor + 16, section);
    const compressedSize = zipUInt32(bytes, cursor + 20, section);
    const uncompressedSize = zipUInt32(bytes, cursor + 24, section);
    const filenameLength = zipUInt16(bytes, cursor + 28, section);
    const extraLength = zipUInt16(bytes, cursor + 30, section);
    const commentLength = zipUInt16(bytes, cursor + 32, section);
    const startDisk = zipUInt16(bytes, cursor + 34, section);
    const externalAttributes = zipUInt32(bytes, cursor + 38, section);
    const localHeaderOffset = zipUInt32(bytes, cursor + 42, section);
    if (versionNeeded >= 45 || compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      invalid("ZIP64 archive entries are forbidden", { entry_index: index });
    }
    if ((flags & 0x0001) !== 0) {
      invalid("encrypted archive entries are forbidden", { entry_index: index });
    }
    if ((flags & 0x0008) !== 0) {
      invalid("ZIP data descriptors are forbidden", { entry_index: index });
    }
    if ((flags & ~0x0800) !== 0) {
      invalid("archive ZIP flags are unsupported", { entry_index: index, flags });
    }
    if (method !== 0 && method !== 8) {
      invalid("archive compression method is unsupported", { entry_index: index, method });
    }
    if (extraLength !== 0 || commentLength !== 0) {
      invalid("archive entry extra fields and comments are forbidden", { entry_index: index });
    }
    if (startDisk !== 0) {
      invalid("multi-disk ZIP entries are forbidden", { entry_index: index });
    }
    const centralEntryLength = 46 + filenameLength + extraLength + commentLength;
    requireZipRange(bytes, cursor, centralEntryLength, section);
    const centralRawName = bytes.subarray(cursor + 46, cursor + 46 + filenameLength);
    const path = normalizeEntryPath(decodeZipFilename(centralRawName, flags));
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (path.endsWith("/") || (externalAttributes & 0x10) !== 0 || unixType === 0x4000) {
      invalid("archive directory entries are forbidden", { path });
    }
    if (unixType === 0xa000) {
      invalid("archive symbolic links are forbidden", { path });
    }
    if (unixType !== 0 && unixType !== 0x8000) {
      invalid("archive non-regular entries are forbidden", { path });
    }

    const localSection = `local header for ${path}`;
    requireZipRange(bytes, localHeaderOffset, 30, localSection);
    if (localHeaderOffset >= centralOffset ||
        zipUInt32(bytes, localHeaderOffset, localSection) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      invalid("archive ZIP local header is invalid", { path });
    }
    const localVersionNeeded = zipUInt16(bytes, localHeaderOffset + 4, localSection);
    const localFlags = zipUInt16(bytes, localHeaderOffset + 6, localSection);
    const localMethod = zipUInt16(bytes, localHeaderOffset + 8, localSection);
    const localCrc32 = zipUInt32(bytes, localHeaderOffset + 14, localSection);
    const localCompressedSize = zipUInt32(bytes, localHeaderOffset + 18, localSection);
    const localUncompressedSize = zipUInt32(bytes, localHeaderOffset + 22, localSection);
    const localFilenameLength = zipUInt16(bytes, localHeaderOffset + 26, localSection);
    const localExtraLength = zipUInt16(bytes, localHeaderOffset + 28, localSection);
    if (localVersionNeeded >= 45 || localExtraLength !== 0) {
      invalid("archive ZIP local header uses unsupported extensions", { path });
    }
    const localHeaderLength = 30 + localFilenameLength + localExtraLength;
    requireZipRange(bytes, localHeaderOffset, localHeaderLength, localSection);
    const localRawName = bytes.subarray(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localFilenameLength
    );
    if (!centralRawName.equals(localRawName) || flags !== localFlags || method !== localMethod ||
        crc32 !== localCrc32 || compressedSize !== localCompressedSize ||
        uncompressedSize !== localUncompressedSize) {
      invalid("archive ZIP central and local headers disagree", { path });
    }
    const dataOffset = localHeaderOffset + localHeaderLength;
    requireZipRange(bytes, dataOffset, compressedSize, `compressed data for ${path}`);
    const localEnd = dataOffset + compressedSize;
    if (localEnd > centralOffset) {
      invalid("archive ZIP entry overlaps the central directory", { path });
    }
    localRanges.push({ start: localHeaderOffset, end: localEnd });
    entries.push({
      path,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localHeaderOffset
    });
    cursor += centralEntryLength;
  }
  if (cursor !== centralOffset + centralSize) {
    invalid("archive ZIP central directory entry count is inconsistent");
  }
  localRanges.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const range of localRanges) {
    if (range.start !== expectedOffset) {
      invalid("archive ZIP local entries overlap or contain unrecognized data");
    }
    expectedOffset = range.end;
  }
  if (expectedOffset !== centralOffset) {
    invalid("archive ZIP contains unrecognized data before the central directory");
  }
  return entries;
}

function normalizedJsonScanText(value: unknown, path: string): string {
  let visited = 0;
  const serialize = (current: unknown, depth: number): string => {
    visited += 1;
    if (depth > 64 || visited > 100_000) {
      invalid("archive JSON is too deeply nested", { path });
    }
    if (typeof current === "string") {
      return JSON.stringify(current.normalize("NFKC"));
    }
    if (Array.isArray(current)) {
      return `[${current.map((item) => serialize(item, depth + 1)).join(",")}]`;
    }
    if (current !== null && typeof current === "object") {
      return `{${Object.entries(current).map(([key, item]) =>
        `${JSON.stringify(key.normalize("NFKC"))}:${serialize(item, depth + 1)}`
      ).join(",")}}`;
    }
    return JSON.stringify(current) ?? "null";
  };
  return serialize(value, 0);
}

function isNonEmptyJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length > 0;
}

export interface SensitiveRejectionFinding {
  readonly path: string;
  readonly rule_id: string;
  readonly severity: string;
  readonly line: number;
  readonly column: number;
  readonly overridable: boolean;
}

export interface SensitiveRejectionDetails {
  readonly scanner_version: string;
  readonly findings: readonly SensitiveRejectionFinding[];
  readonly next_action: string;
}

/**
 * Explain a sensitive-content rejection so the caller can act on it.
 *
 * A gate that only says "blocked" forces the caller to guess between two very
 * different remedies: declare a design decision, or actually redact a leaked
 * secret. Guessing wrong in either direction is bad — one leaves a real
 * credential in place, the other rewrites documentation to appease a scanner.
 * So the response names the line and says which of the two applies.
 *
 * `high` findings never get a waiver offer: leaked key material has to go.
 */
export function describeSensitiveRejection(
  findings: readonly SensitiveFinding[],
  scannerVersion: string
): SensitiveRejectionDetails {
  const blocked = findings.filter((finding) => finding.disposition === "blocked");
  const reported = blocked.map((finding) => ({
    path: finding.path,
    rule_id: finding.rule_id,
    severity: finding.severity,
    line: finding.line,
    column: finding.column,
    overridable: finding.overridable
  }));
  const hard = reported.filter((finding) => !finding.overridable);
  const where = (finding: SensitiveRejectionFinding): string =>
    `${finding.path}:${finding.line}:${finding.column} ${finding.rule_id}`;
  const next_action = hard.length > 0
    ? `以下命中不可豁免：${hard.map(where).join("；")}。` +
      "必须真正脱敏后重新打包——泄露的密钥材料不接受申报豁免。"
    : `以下命中可申报豁免：${reported.map(where).join("；")}。` +
      "若确属设计固有内容，在源文件该行附近加行内标注后用 " +
      "`harness_archive.py republish` 重建重传，例如 " +
      `\`hunter-harness-ignore: ${reported[0]?.rule_id ?? "<RULE_ID>"} reason=<简短理由>\`；` +
      "否则请脱敏。不要为了过扫描删改文档的事实内容。";
  return { scanner_version: scannerVersion, findings: reported, next_action };
}

export function validateArchivePackage(
  changeKey: string,
  bytes: Uint8Array,
  limits: ArchivePackageLimits
): ValidatedArchivePackage {
  if (!archiveChangeKeySchema.safeParse(changeKey).success) {
    invalid("archive change key is not portable", { change_key: changeKey });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxPackageBytes) {
    invalid("archive package size is outside the allowed range", {
      size_bytes: bytes.byteLength,
      max_bytes: limits.maxPackageBytes
    });
  }

  const packageBytes = Buffer.from(bytes);
  const rawEntries = validateRawZipStructure(packageBytes, limits.maxUploadFiles + 1);
  let zip: AdmZip;
  try {
    zip = new AdmZip(packageBytes);
  } catch {
    invalid("archive package is not a readable ZIP");
  }

  const files = zip.getEntries();
  if (files.length !== rawEntries.length || files.some((entry, index) =>
    entry.entryName !== rawEntries[index]?.path
  )) {
    invalid("archive ZIP parser views are inconsistent");
  }
  if (files.length === 0 || files.length > limits.maxUploadFiles + 1) {
    invalid("archive package file count is outside the allowed range", {
      file_count: files.length,
      max_files: limits.maxUploadFiles
    });
  }

  const byPath = new Map<string, AdmZip.IZipEntry>();
  const caseFolded = new Set<string>();
  let totalUncompressed = 0;
  for (const entry of files) {
    validateZipEntryType(entry);
    const path = normalizeEntryPath(entry.entryName);
    const folded = path.toLocaleLowerCase("en-US");
    if (byPath.has(path) || caseFolded.has(folded)) {
      invalid("archive contains duplicate or case-colliding paths", { path });
    }
    const size = Number(entry.header.size);
    const compressedSize = Number(entry.header.compressedSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
      invalid("archive entry is too large", { path, size_bytes: size });
    }
    totalUncompressed += size;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      invalid("archive expands beyond the allowed size", {
        max_uncompressed_bytes: limits.maxUncompressedBytes
      });
    }
    if (size > 1024 * 1024 && size / Math.max(1, compressedSize) > 100) {
      invalid("archive entry compression ratio is unsafe", { path });
    }
    byPath.set(path, entry);
    caseFolded.add(folded);
  }

  const manifestEntry = byPath.get("archive-manifest.json");
  if (manifestEntry === undefined) invalid("archive-manifest.json is required");
  let manifestBytes: Buffer;
  let manifestText: string;
  let manifestJson: unknown;
  let manifest: ArchiveManifest;
  try {
    manifestBytes = manifestEntry.getData();
    if (manifestBytes.byteLength > 256 * 1024) invalid("archive manifest is too large");
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    manifestJson = JSON.parse(manifestText) as unknown;
    manifest = archiveManifestSchema.parse(manifestJson);
  } catch (error) {
    if (error instanceof ServerDomainError) throw error;
    invalid("archive manifest is invalid");
  }
  if (manifest.change_key !== changeKey) {
    invalid("archive change key does not match the request path", {
      expected: changeKey,
      actual: manifest.change_key
    });
  }

  const declaredPaths = new Set<string>();
  const validatedFiles: ValidatedArchiveFile[] = [];
  const normalizedJsonFiles: Record<string, string> = {};
  for (const declared of manifest.files) {
    const path = normalizeEntryPath(declared.path);
    validateDeclaredPath({ ...declared, path });
    if (declaredPaths.has(path)) invalid("archive manifest contains duplicate paths", { path });
    declaredPaths.add(path);
    const entry = byPath.get(path);
    if (entry === undefined) invalid("archive manifest references a missing file", { path });
    let content: Buffer;
    let text: string;
    try {
      content = entry.getData();
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      invalid("archive core files must be valid UTF-8", { path });
    }
    const contentSha256 = sha256Bytes(content);
    if (content.byteLength !== declared.size_bytes || contentSha256 !== declared.content_sha256) {
      invalid("archive file does not match its manifest", { path });
    }
    if (declared.media_type === "application/json") {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (declared.role === "summary" && !isNonEmptyJsonObject(parsed)) {
          invalid("archive summary must be a non-empty JSON object", { path });
        }
        if (declared.role === "summary") {
          const summaryResult = archiveSummarySchema.safeParse(parsed);
          if (!summaryResult.success) {
            invalid("archive summary does not match CLI schema 2.2 or 2.3", {
              path,
              issues: archiveSummaryIssues(parsed, summaryResult.error)
            });
          }
        }
        if (declared.role === "change_context" && !isNonEmptyJsonObject(parsed)) {
          invalid("archive change-context must be a non-empty JSON object", { path });
        }
        // Fail closed: the knowledge pipeline consumes these verbatim, so a
        // malformed array must be rejected here rather than half-ingested later.
        // An empty array is valid — a change may yield no knowledge at all.
        if (declared.role === "knowledge_candidates" &&
            !z.array(knowledgeCandidateSchema).max(1_000).safeParse(parsed).success) {
          invalid("archive knowledge candidates do not match the candidate contract", { path });
        }
        normalizedJsonFiles[path] = normalizedJsonScanText(parsed, path);
      } catch (error) {
        if (error instanceof ServerDomainError) throw error;
        invalid("archive JSON file is invalid", { path });
      }
    }
    validatedFiles.push({
      path,
      content,
      text,
      contentSha256,
      sizeBytes: content.byteLength
    });
  }

  const actualDataPaths = [...byPath.keys()].filter((path) => path !== "archive-manifest.json");
  const undeclared = actualDataPaths.filter((path) => !declaredPaths.has(path));
  if (undeclared.length > 0) {
    invalid("archive contains undeclared or diagnostic files", { paths: undeclared.sort() });
  }
  if (!manifest.files.some((file) => file.role === "summary")) {
    invalid("archive must contain the final structured summary");
  }

  return {
    manifest,
    manifestSha256: sha256Bytes(manifestBytes),
    packageSha256: sha256Bytes(bytes),
    files: validatedFiles.sort((left, right) => left.path.localeCompare(right.path))
  };
}

function receipt(record: ChangeArchivePackageRecord): ArchivePackageReceipt {
  return {
    schema_version: 1,
    archive_id: record.archiveId,
    project_id: record.projectId,
    change_key: record.changeKey,
    package_sha256: record.packageSha256,
    manifest_sha256: record.manifestSha256,
    artifact_id: record.artifactId,
    archive_status: record.archiveStatus,
    knowledge_status: record.knowledgeStatus,
    stored_files: record.storedFiles,
    uploaded_at: record.createdAt
  };
}

export async function loadSemanticSnapshotFiles(input: {
  actorId: string;
  projectId: string;
  repository: ServerRepository;
  storage: ArtifactStorage;
}): Promise<Record<string, string>> {
  const currentFiles = await input.repository.listProjectFiles(input.actorId, input.projectId);
  const values = await Promise.all(currentFiles
    .filter((file) => isSemanticSourcePath(file.path))
    .map(async (file): Promise<readonly [string, string]> => {
      let exists: boolean;
      try {
        exists = await input.storage.hasBlob(file.contentSha256);
      } catch {
        throw new ServerDomainError(
          500,
          "SEMANTIC_SNAPSHOT_INCOMPLETE",
          "semantic source blob availability could not be verified",
          { path: file.path }
        );
      }
      if (!exists) {
        throw new ServerDomainError(
          500,
          "SEMANTIC_SNAPSHOT_INCOMPLETE",
          "semantic source blob is missing",
          { path: file.path }
        );
      }
      let content: Uint8Array;
      try {
        content = await input.storage.getBlob(file.contentSha256);
      } catch {
        throw new ServerDomainError(
          500,
          "SEMANTIC_SNAPSHOT_INCOMPLETE",
          "semantic source blob could not be read",
          { path: file.path }
        );
      }
      if (sha256Bytes(content) !== file.contentSha256) {
        throw new ServerDomainError(
          500,
          "SEMANTIC_SNAPSHOT_INCOMPLETE",
          "semantic source blob hash does not match the repository snapshot",
          { path: file.path }
        );
      }
      try {
        return [
          file.path,
          new TextDecoder("utf-8", { fatal: true }).decode(content)
        ] as const;
      } catch {
        throw new ServerDomainError(
          500,
          "SEMANTIC_SNAPSHOT_INCOMPLETE",
          "semantic source blob is not valid UTF-8",
          { path: file.path }
        );
      }
    }));
  return Object.fromEntries(values);
}

export async function rebuildStableSemanticSnapshot(input: {
  actorId: string;
  projectId: string;
  repository: ServerRepository;
  storage: ArtifactStorage;
  semanticStore: SemanticStore;
}): Promise<string> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await input.repository.getLatestArtifact(input.actorId, input.projectId);
    if (before === null) {
      throw new ServerDomainError(
        500,
        "SEMANTIC_SNAPSHOT_INCOMPLETE",
        "project has no artifact for the semantic snapshot"
      );
    }
    const files = await loadSemanticSnapshotFiles(input);
    const afterRead = await input.repository.getLatestArtifact(input.actorId, input.projectId);
    if (afterRead?.artifactId !== before.artifactId) continue;

    const published = await input.semanticStore.rebuild(buildSemanticIndex({
      projectId: input.projectId,
      artifactId: before.artifactId,
      files
    }), {
      expectedArtifactId: before.artifactId,
      isCurrent: async () =>
        (await input.repository.getLatestArtifact(input.actorId, input.projectId))?.artifactId ===
          before.artifactId
    });
    if (!published) continue;
    const afterRebuild = await input.repository.getLatestArtifact(input.actorId, input.projectId);
    if (afterRebuild?.artifactId !== before.artifactId) continue;
    if (await input.semanticStore.latestArtifactId(input.projectId) !== before.artifactId) {
      throw new ServerDomainError(
        500,
        "SEMANTIC_REBUILD_INCONSISTENT",
        "semantic store did not publish the requested project generation"
      );
    }
    return before.artifactId;
  }
  throw new ServerDomainError(
    409,
    "SEMANTIC_SNAPSHOT_UNSTABLE",
    "project changed repeatedly while rebuilding the semantic snapshot"
  );
}

export async function ingestArchivePackage(input: {
  actorId: string;
  projectId: string;
  changeKey: string;
  bytes: Uint8Array;
  repository: ServerRepository;
  storage: ArtifactStorage;
  semanticStore: SemanticStore;
  limits: ArchivePackageLimits;
  sessionTtlMs: number;
  maxChunkBytes: number;
  projectLockHeld?: boolean;
}): Promise<ArchivePackageReceipt> {
  await input.repository.getProject(input.actorId, input.projectId);
  const archive = validateArchivePackage(input.changeKey, input.bytes, input.limits);
  const projectLock = input.projectLockHeld === true
    ? null
    : await input.repository.acquireIdempotencyLock({
      actorId: "internal:archive-package",
      method: "ARCHIVE",
      path: "/internal/archive-package/project",
      key: input.projectId
    });

  try {
    let existingPackage: ChangeArchivePackageRecord | null;
    try {
      existingPackage = await input.repository.getChangeArchivePackage(
        input.actorId,
        input.projectId,
        input.changeKey
      );
    } catch (error) {
      if (error instanceof ServerDomainError && error.code === "ARCHIVE_PACKAGE_NOT_FOUND") {
        existingPackage = null;
      } else {
        throw error;
      }
    }
    if (existingPackage !== null && existingPackage.packageSha256 !== archive.packageSha256) {
      throw new ServerDomainError(
        409,
        "ARCHIVE_ALREADY_EXISTS",
        "a different package is already stored for this change",
        { package_sha256: existingPackage.packageSha256 }
      );
    }
    const rawPackageAlreadyStored = await input.storage.hasBlob(archive.packageSha256);
    try {
      await input.storage.putBlob(archive.packageSha256, input.bytes);
    } catch (error) {
      if (existingPackage === null) throw error;
      const failed = await input.repository.updateChangeArchivePackage({
        actorId: input.actorId,
        projectId: input.projectId,
        changeKey: input.changeKey,
        artifactId: existingPackage.artifactId,
        knowledgeStatus: "failed",
        failureStage: "raw_storage",
        lastErrorCode: failureCode(error),
        incrementAttempt: true
      });
      return receipt(failed);
    }
    let persisted: { record: ChangeArchivePackageRecord; created: boolean };
    if (existingPackage === null) {
      try {
        persisted = await input.repository.putChangeArchivePackage({
          actorId: input.actorId,
          projectId: input.projectId,
          changeKey: input.changeKey,
          packageSha256: archive.packageSha256,
          manifestSha256: archive.manifestSha256,
          coreContentSha256: archive.files.map((file) => file.contentSha256),
          storedFiles: archive.files.length
        });
      } catch (error) {
        if (!rawPackageAlreadyStored) {
          try {
            if (!await input.repository.isBlobReferenced(archive.packageSha256)) {
              await input.storage.quarantineBlob(
                archive.packageSha256,
                new Date().toISOString()
              );
            }
          } catch {
            // Preserve the database error. A later GC pass may recover the unreferenced CAS blob.
          }
        }
        throw error;
      }
    } else {
      persisted = { record: existingPackage, created: false };
    }
    if (!persisted.created && persisted.record.packageSha256 !== archive.packageSha256) {
      throw new ServerDomainError(
        409,
        "ARCHIVE_ALREADY_EXISTS",
        "a different package is already stored for this change",
        { package_sha256: persisted.record.packageSha256 }
      );
    }
    const coreContentSha256 = [...new Set(archive.files.map((file) => file.contentSha256))];
    if (!persisted.created &&
        (persisted.record.coreContentSha256.length !== coreContentSha256.length ||
          coreContentSha256.some((hash) => !persisted.record.coreContentSha256.includes(hash)))) {
      // Migration 015 initializes historic rows with an empty list. Backfill
      // from the freshly revalidated ZIP before writing any core blob so a
      // failed retry cannot recreate an unreferenced CAS object.
      persisted.record = await input.repository.updateChangeArchivePackage({
        actorId: input.actorId,
        projectId: input.projectId,
        changeKey: input.changeKey,
        artifactId: persisted.record.artifactId,
        knowledgeStatus: persisted.record.knowledgeStatus,
        failureStage: persisted.record.failureStage,
        lastErrorCode: persisted.record.lastErrorCode,
        coreContentSha256
      });
    }
    let archiveArtifactId = persisted.record.artifactId;
    let activeSession: ProposalSessionRecord | null = null;
    let failureStage: ChangeArchivePackageRecord["failureStage"] = "core_storage";
    try {
      const wasReady = !persisted.created && persisted.record.knowledgeStatus === "ready";
      if (!persisted.created && !wasReady) {
        persisted.record = await input.repository.updateChangeArchivePackage({
          actorId: input.actorId,
          projectId: input.projectId,
          changeKey: input.changeKey,
          artifactId: archiveArtifactId,
          knowledgeStatus: "indexing",
          failureStage: null,
          lastErrorCode: null,
          incrementAttempt: true
        });
      }

      for (const file of archive.files) {
        await input.storage.putBlob(file.contentSha256, file.content);
      }
      // Even a ready archive rewrites its declared core blobs through CAS so a
      // same-package re-upload can repair disk corruption before the fast path.
      if (wasReady) {
        const latest = await input.repository.getLatestArtifact(input.actorId, input.projectId);
        if (latest !== null &&
            await input.semanticStore.latestArtifactId(input.projectId) === latest.artifactId &&
            await input.semanticStore.indexSchemaVersion(input.projectId) ===
              SEMANTIC_INDEX_SCHEMA_VERSION) {
          return receipt(persisted.record);
        }
        persisted.record = await input.repository.updateChangeArchivePackage({
          actorId: input.actorId,
          projectId: input.projectId,
          changeKey: input.changeKey,
          artifactId: archiveArtifactId,
          knowledgeStatus: "indexing",
          failureStage: null,
          lastErrorCode: null,
          incrementAttempt: true
        });
      }

      failureStage = "finalize";
      const project = await input.repository.getProject(input.actorId, input.projectId);
      const existingFiles = await input.repository.listProjectFiles(input.actorId, input.projectId);
      const byPath = new Map(existingFiles.map((file) => [file.path, file]));
      const operations: FileOperation[] = archive.files.flatMap((file) => {
        const path = archiveRootPrefix(input.changeKey) + file.path;
        const existing = byPath.get(path);
        if (existing?.contentSha256 === file.contentSha256) return [];
        return [fileOperationSchema.parse(existing === undefined ? {
          operation: "add",
          path,
          file_kind: "internal_state",
          content_sha256: file.contentSha256,
          size_bytes: file.sizeBytes
        } : {
          operation: "modify",
          path,
          file_kind: "internal_state",
          base_content_sha256: existing.contentSha256,
          content_sha256: file.contentSha256,
          size_bytes: file.sizeBytes
        })];
      });

      if (operations.length > 0) {
        activeSession = await input.repository.createProposalSession({
          projectId: input.projectId,
          actorId: input.actorId,
          baseProjectVersion: project.latestProjectVersion,
          baseManifestHash: sha256Bytes(canonicalJson(existingFiles.map((file) => ({
            path: file.path,
            content_sha256: file.contentSha256
          })))),
          operations,
          scanOverrides: [],
          status: "open",
          expiresAt: new Date(Date.now() + input.sessionTtlMs).toISOString(),
          maxChunkBytes: input.maxChunkBytes
        });
        const finalized = await input.repository.finalizeSessionAutoApprove(activeSession);
        activeSession = null;
        archiveArtifactId = finalized.review.artifactId;
      } else if (archiveArtifactId === null) {
        archiveArtifactId = project.latestArtifactId;
      }
      if (archiveArtifactId === null) {
        throw new ServerDomainError(
          500,
          "ARCHIVE_FINALIZE_INCOMPLETE",
          "archive files were not bound to a project artifact"
        );
      }

      failureStage = "semantic";
      const semanticGeneration = await rebuildStableSemanticSnapshot(input);
      const latest = await input.repository.getLatestArtifact(input.actorId, input.projectId);
      const semanticLatest = await input.semanticStore.latestArtifactId(input.projectId);
      if (latest?.artifactId !== semanticGeneration || semanticLatest !== semanticGeneration) {
        throw new ServerDomainError(
          500,
          "SEMANTIC_REBUILD_INCONSISTENT",
          "ready archive does not match the latest project semantic generation"
        );
      }
      // 诚实收据（2026-08-30 实测 P0-1）：知识条目由异步 extraction job 产出，
      // semantic 快照重建完成 ≠ 知识可查询。有候选时置 indexing，由知识 job
      // 的 commit/fail 桥（main.ts knowledgeCommitWithIngest）翻转为 ready/failed；
      // 无候选的归档没有后续动作，直接 ready。
      const knowledgeFile = archive.files.find((file) => file.path === "candidates/knowledge.json");
      let hasKnowledgeCandidates = false;
      if (knowledgeFile?.text !== undefined) {
        try {
          const parsedCandidates: unknown = JSON.parse(knowledgeFile.text);
          hasKnowledgeCandidates = Array.isArray(parsedCandidates) && parsedCandidates.length > 0;
        } catch {
          hasKnowledgeCandidates = false;
        }
      }
      const updated = await input.repository.updateChangeArchivePackage({
        actorId: input.actorId,
        projectId: input.projectId,
        changeKey: input.changeKey,
        artifactId: archiveArtifactId,
        knowledgeStatus: hasKnowledgeCandidates ? "indexing" : "ready",
        failureStage: null,
        lastErrorCode: null
      });
      return receipt(updated);
    } catch (error) {
      if (activeSession !== null) {
        try {
          await input.repository.updateProposalSession({
            ...activeSession,
            status: "failed",
            expiresAt: new Date().toISOString()
          });
          await input.storage.deleteSession(activeSession.sessionId);
        } catch {
          // The archive record below remains retryable even if session cleanup fails.
        }
      }
      const failed = await input.repository.updateChangeArchivePackage({
        actorId: input.actorId,
        projectId: input.projectId,
        changeKey: input.changeKey,
        artifactId: archiveArtifactId,
        knowledgeStatus: "failed",
        failureStage,
        lastErrorCode: failureCode(error)
      });
      return receipt(failed);
    }
  } finally {
    await projectLock?.release();
  }
}

export function archivePackageReceipt(record: ChangeArchivePackageRecord): ArchivePackageReceipt {
  return receipt(record);
}
