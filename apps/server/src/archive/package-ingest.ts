import { Buffer } from "node:buffer";

import {
  canonicalJson,
  fileOperationSchema,
  type FileOperation
} from "@hunter-harness/contracts";
import { scanSensitiveFiles, sha256Bytes } from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { z } from "zod";

import type {
  ChangeArchivePackageRecord,
  ServerRepository
} from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import { buildSemanticIndex, isSemanticSourcePath } from "../semantic/indexer.js";
import type { SemanticStore } from "../semantic/store.js";
import type { ArtifactStorage } from "../storage/interface.js";
import { archiveRootPrefix } from "./change-archive.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const archiveChangeKeySchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u);
const archiveRoleSchema = z.enum([
  "summary",
  "spec",
  "plan",
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
  { role: "archive_meta", pattern: /^archive-meta\.md$/u, mediaType: "text/markdown" },
  { role: "change_context", pattern: /^change-context\.json$/u, mediaType: "application/json" }
];

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new ServerDomainError(422, "ARCHIVE_PACKAGE_INVALID", message, details);
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

  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch {
    invalid("archive package is not a readable ZIP");
  }

  const entries = zip.getEntries();
  const files = entries.filter((entry) => !entry.isDirectory);
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
  let manifest: ArchiveManifest;
  try {
    manifestBytes = manifestEntry.getData();
    if (manifestBytes.byteLength > 256 * 1024) invalid("archive manifest is too large");
    manifest = archiveManifestSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)
    ));
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
        JSON.parse(text);
      } catch {
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

  const scan = scanSensitiveFiles(Object.fromEntries(
    validatedFiles.map((file) => [file.path, file.text])
  ));
  if (scan.blocked) {
    invalid("archive contains sensitive content", {
      findings: scan.findings.filter((finding) => finding.disposition === "blocked").map((finding) => ({
        path: finding.path,
        rule_id: finding.rule_id,
        severity: finding.severity
      }))
    });
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

async function semanticFiles(input: {
  actorId: string;
  projectId: string;
  repository: ServerRepository;
  storage: ArtifactStorage;
}): Promise<Record<string, string>> {
  const currentFiles = await input.repository.listProjectFiles(input.actorId, input.projectId);
  const values = await Promise.all(currentFiles
    .filter((file) => isSemanticSourcePath(file.path))
    .map(async (file): Promise<readonly [string, string] | null> => {
      if (!await input.storage.hasBlob(file.contentSha256)) return null;
      try {
        return [
          file.path,
          new TextDecoder("utf-8", { fatal: true }).decode(
            await input.storage.getBlob(file.contentSha256)
          )
        ] as const;
      } catch {
        return null;
      }
    }));
  return Object.fromEntries(values.filter((value) => value !== null));
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
}): Promise<ArchivePackageReceipt> {
  await input.repository.getProject(input.actorId, input.projectId);
  const archive = validateArchivePackage(input.changeKey, input.bytes, input.limits);

  await input.storage.putBlob(archive.packageSha256, input.bytes);
  const persisted = await input.repository.putChangeArchivePackage({
    actorId: input.actorId,
    projectId: input.projectId,
    changeKey: input.changeKey,
    packageSha256: archive.packageSha256,
    manifestSha256: archive.manifestSha256,
    storedFiles: archive.files.length
  });
  if (!persisted.created && persisted.record.packageSha256 !== archive.packageSha256) {
    throw new ServerDomainError(
      409,
      "ARCHIVE_ALREADY_EXISTS",
      "a different package is already stored for this change",
      { package_sha256: persisted.record.packageSha256 }
    );
  }
  if (!persisted.created && persisted.record.knowledgeStatus === "ready") {
    return receipt(persisted.record);
  }

  for (const file of archive.files) {
    await input.storage.putBlob(file.contentSha256, file.content);
  }

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

  let artifactId = persisted.record.artifactId ?? project.latestArtifactId;
  if (operations.length > 0) {
    const session = await input.repository.createProposalSession({
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
    const finalized = await input.repository.finalizeSessionAutoApprove(session);
    artifactId = finalized.review.artifactId;
  }
  if (artifactId === null) {
    const failed = await input.repository.updateChangeArchivePackage({
      actorId: input.actorId,
      projectId: input.projectId,
      changeKey: input.changeKey,
      artifactId: null,
      knowledgeStatus: "failed"
    });
    return receipt(failed);
  }

  let knowledgeStatus: ChangeArchivePackageRecord["knowledgeStatus"] = "ready";
  try {
    await input.semanticStore.rebuild(buildSemanticIndex({
      projectId: input.projectId,
      artifactId,
      files: await semanticFiles(input)
    }));
  } catch {
    knowledgeStatus = "failed";
  }
  const updated = await input.repository.updateChangeArchivePackage({
    actorId: input.actorId,
    projectId: input.projectId,
    changeKey: input.changeKey,
    artifactId,
    knowledgeStatus
  });
  return receipt(updated);
}

export function archivePackageReceipt(record: ChangeArchivePackageRecord): ArchivePackageReceipt {
  return receipt(record);
}
