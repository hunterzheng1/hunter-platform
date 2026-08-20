import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { TextDecoder } from "node:util";

import {
  canonicalJson,
  registrySemverSchema,
  registrySlugSchema,
  workflowFamilySourceInspectionSchema,
  type ImportWorkflowFamilySourceRequest,
  type SourceFile,
  type WorkflowFamily,
  type WorkflowFamilyMutation,
  type WorkflowFamilySource,
  type WorkflowFamilySourceImportResult,
  type WorkflowFamilySourceInspection
} from "@hunter-harness/contracts";
import { compareSemver, sha256Bytes } from "@hunter-harness/core";
import * as tar from "tar";
import { z } from "zod";

import {
  ExternalFetchError,
  normalizeGithubRef,
  normalizeNpmRef,
  readExternalJson,
  type ExternalFetcherDeps
} from "../external/fetchers.js";
import { ServerDomainError, type TransactionRepository } from "../repositories/interfaces.js";
import {
  summarizeWorkflowFamilyDraft,
  validateAndIndexSourceFiles,
  type WorkflowFamilyStore
} from "./workflow-family-store.js";

export interface WorkflowFamilySyncResult {
  updated: boolean;
  version?: string;
}

export interface PreparedWorkflowFamilyImport {
  family: WorkflowFamilyMutation;
  profiles: Array<{ profile: string; files: SourceFile[] }>;
  inspection: WorkflowFamilySourceInspection;
  allowTrustedSourceFindings: boolean;
  draftVersion?: string;
}

export interface PreparedWorkflowFamilySync {
  slug: string;
  familyRevision: number;
  familySource: WorkflowFamilySource;
  profiles: Array<{ profile: string; files: SourceFile[] }>;
  inspection: WorkflowFamilySourceInspection;
  allowTrustedSourceFindings: boolean;
  result: WorkflowFamilySyncResult;
  draftVersion?: string;
}

interface LoadedWorkflowSource {
  inspection: WorkflowFamilySourceInspection;
  profileFiles: Map<string, SourceFile[]>;
  allowTrustedSourceFindings: boolean;
}

interface SourceMetadata {
  name: string;
  description: string;
  version: string | null;
  sourceDigest: string;
  trustedPublisher: boolean;
  canonicalUtf8ReplacementPaths: string[];
  sourceWarnings: string[];
}

interface ExtractedArchive {
  files: SourceFile[];
  canonicalUtf8ReplacementPaths: string[];
}

interface ExtractArchiveOptions {
  allowCanonicalUtf8Replacement?: boolean;
  includeSubpath?: string;
}

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_STREAMED_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_STREAMED_ARCHIVE_ENTRIES = 20_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const NPM_REGISTRY = "https://registry.npmjs.org";

const manifestCapabilitySchema = z.string().trim().min(1).max(120);
const workflowSourceManifestSchema = z.object({
  schema_version: z.literal(1),
  family_slug: registrySlugSchema,
  display_name: z.string().trim().min(1).max(120),
  required_profiles: z.array(registrySlugSchema).min(1).max(32)
    .refine((profiles) => new Set(profiles).size === profiles.length, "profile names must be unique"),
  bundle_version: registrySemverSchema,
  content_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  minimumCliVersion: registrySemverSchema.optional(),
  workflowPackageVersion: registrySemverSchema,
  capabilities: z.array(manifestCapabilitySchema).max(100).optional(),
  requires: z.object({
    minimumCliVersion: registrySemverSchema,
    capabilities: z.array(manifestCapabilitySchema).max(100)
  }).strict().optional()
}).strict();

type WorkflowSourceManifest = z.infer<typeof workflowSourceManifestSchema>;

function sourceTooLarge(message: string): ServerDomainError {
  return new ServerDomainError(422, "WORKFLOW_SOURCE_TOO_LARGE", message);
}

async function readLimitedArchive(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw sourceTooLarge("workflow source archive exceeds the compressed size limit");
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw sourceTooLarge("workflow source archive exceeds the compressed size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function domainFetchError(error: unknown): never {
  if (error instanceof ServerDomainError) throw error;
  if (error instanceof ExternalFetchError) {
    throw new ServerDomainError(error.statusCode, error.code, error.message);
  }
  throw new ServerDomainError(
    502,
    "WORKFLOW_SOURCE_LOAD_FAILED",
    "workflow source could not be loaded",
    { reason: error instanceof Error ? error.message : "unknown external source error" }
  );
}

function deadlineFetch(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const controller = new AbortController();
    const timeoutError = new ExternalFetchError(504, "EXTERNAL_FETCH_TIMEOUT", "workflow source request timed out");
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      bodyController?.error(timeoutError);
      void bodyReader?.cancel(timeoutError).catch(() => undefined);
    }, timeoutMs);
    const clearDeadline = (): void => clearTimeout(timeout);
    let response: Response;
    try {
      response = await fetchFn(input, { ...init, signal: controller.signal });
    } catch (error) {
      clearDeadline();
      if (controller.signal.aborted) {
        throw timeoutError;
      }
      throw new ExternalFetchError(
        502,
        "EXTERNAL_FETCH_FAILED",
        error instanceof Error ? `workflow source request failed: ${error.message}` : "workflow source request failed"
      );
    }
    if (!response.ok || response.body === null) {
      clearDeadline();
      return response;
    }

    bodyReader = response.body.getReader();
    const monitoredBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        bodyController = streamController;
      },
      async pull(streamController) {
        try {
          const next = await bodyReader?.read();
          if (timedOut || next === undefined) return;
          if (next.done) {
            clearDeadline();
            streamController.close();
            return;
          }
          streamController.enqueue(next.value);
        } catch (error) {
          if (timedOut) return;
          clearDeadline();
          streamController.error(new ExternalFetchError(
            502,
            "EXTERNAL_FETCH_FAILED",
            error instanceof Error ? `workflow source response failed: ${error.message}` : "workflow source response failed"
          ));
        }
      },
      async cancel(reason) {
        clearDeadline();
        await bodyReader?.cancel(reason);
      }
    });
    return new Response(monitoredBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }) as typeof fetch;
}

async function fetchNpmTarball(
  packageName: string,
  version: string,
  deps: ExternalFetcherDeps
): Promise<Buffer> {
  const name = normalizeNpmRef(packageName);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const metaUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const metaResponse = await fetchFn(metaUrl, { headers: { accept: "application/json" } });
  if (metaResponse.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm package not found: ${name}`);
  }
  if (!metaResponse.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm registry returned ${metaResponse.status}`);
  }
  const body = await readExternalJson(metaResponse) as {
    dist?: { tarball?: string; integrity?: string; shasum?: string };
  };
  const dist = body?.dist;
  const tarballUrl = dist?.tarball;
  if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm version not found: ${name}@${version}`);
  }
  let parsedTarballUrl: URL;
  try {
    parsedTarballUrl = new URL(tarballUrl);
  } catch {
    throw new ExternalFetchError(502, "WORKFLOW_SOURCE_TARBALL_URL_REJECTED", "npm tarball URL is invalid");
  }
  if (
    parsedTarballUrl.protocol !== "https:" ||
    parsedTarballUrl.hostname.toLowerCase() !== "registry.npmjs.org" ||
    parsedTarballUrl.port !== "" ||
    parsedTarballUrl.username !== "" ||
    parsedTarballUrl.password !== ""
  ) {
    throw new ExternalFetchError(
      502,
      "WORKFLOW_SOURCE_TARBALL_URL_REJECTED",
      "npm tarball URL must use the official HTTPS registry origin"
    );
  }
  const tarballResponse = await fetchFn(parsedTarballUrl, { redirect: "error" });
  if (!tarballResponse.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm tarball returned ${tarballResponse.status}`);
  }
  const archive = await readLimitedArchive(tarballResponse);
  verifyNpmArchiveIntegrity(archive, dist);
  return archive;
}

async function fetchNpmLatestMetadata(
  packageName: string,
  deps: ExternalFetcherDeps
): Promise<{ name: string; description: string; version: string }> {
  const name = normalizeNpmRef(packageName);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const response = await fetchFn(`${NPM_REGISTRY}/${encodeURIComponent(name)}/latest`, {
    headers: { accept: "application/json" }
  });
  if (response.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm package not found: ${name}`);
  }
  if (!response.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm registry returned ${response.status}`);
  }
  const body = await readExternalJson(response) as Record<string, unknown> | null;
  if (body === null || typeof body.version !== "string" || body.version.length === 0) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "npm package has no latest version");
  }
  return {
    name: typeof body.name === "string" ? body.name : name,
    description: typeof body.description === "string" ? body.description : "",
    version: body.version
  };
}

function digestMatches(actual: Buffer, expected: Buffer): boolean {
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function verifyNpmArchiveIntegrity(
  archive: Buffer,
  dist: { integrity?: string; shasum?: string } | undefined
): void {
  const integrity = dist?.integrity?.trim();
  if (integrity !== undefined && integrity !== "") {
    const candidates = integrity.split(/\s+/).flatMap((token) => {
      const value = token.split("?", 1)[0] ?? "";
      const match = value.match(/^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/i);
      const algorithm = match?.[1];
      const expected = match?.[2];
      return algorithm === undefined || expected === undefined
        ? []
        : [{ algorithm: algorithm.toLowerCase(), expected }];
    });
    if (candidates.length === 0) {
      throw new ExternalFetchError(502, "WORKFLOW_SOURCE_INTEGRITY_UNSUPPORTED", "npm tarball integrity uses no supported digest");
    }
    const verified = candidates.some(({ algorithm, expected }) =>
      digestMatches(createHash(algorithm).update(archive).digest(), Buffer.from(expected, "base64"))
    );
    if (!verified) {
      throw new ExternalFetchError(502, "WORKFLOW_SOURCE_INTEGRITY_FAILED", "npm tarball integrity verification failed");
    }
    return;
  }

  const shasum = dist?.shasum?.trim();
  if (shasum !== undefined && /^[a-f0-9]{40}$/i.test(shasum)) {
    const actual = createHash("sha1").update(archive).digest("hex");
    if (actual.toLowerCase() === shasum.toLowerCase()) return;
    throw new ExternalFetchError(502, "WORKFLOW_SOURCE_INTEGRITY_FAILED", "npm tarball shasum verification failed");
  }
  throw new ExternalFetchError(502, "WORKFLOW_SOURCE_INTEGRITY_MISSING", "npm tarball metadata has no integrity digest");
}

function normalizeArchivePath(rawPath: string): string | null {
  let path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("package/")) {
    path = path.slice("package/".length);
  } else {
    const firstSlash = path.indexOf("/");
    const archiveRoot = firstSlash < 0 ? path : path.slice(0, firstSlash);
    if (/^[^/]+-[0-9a-f]{7,40}$/i.test(archiveRoot)) {
      path = firstSlash < 0 ? "" : path.slice(firstSlash + 1);
    }
  }
  const segments = path.split("/");
  if (path.length === 0 || path.startsWith("/") || segments.some((segment) => segment === "..")) return null;
  return path;
}

async function extractTarGz(
  tarball: Buffer,
  options: ExtractArchiveOptions = {}
): Promise<ExtractedArchive> {
  const files: SourceFile[] = [];
  const canonicalUtf8ReplacementPaths: string[] = [];
  const parser = new tar.Parser({ strict: true });
  const includeSubpath = options.includeSubpath?.replace(/^\/+|\/+$/g, "") ?? "";
  const filteringSubpath = includeSubpath !== "";
  const maxStreamedBytes = filteringSubpath ? MAX_STREAMED_ARCHIVE_BYTES : MAX_EXTRACTED_BYTES;
  const maxStreamedEntries = filteringSubpath ? MAX_STREAMED_ARCHIVE_ENTRIES : MAX_ARCHIVE_ENTRIES;
  let source: Readable | null = null;
  let streamedBytes = 0;
  let streamedEntries = 0;
  let selectedBytes = 0;
  let selectedEntries = 0;
  let failed = false;
  const pending = new Promise<void>((resolve, reject) => {
    const fail = (error: Error, abortParser = true): void => {
      if (failed) return;
      failed = true;
      source?.unpipe(parser);
      source?.destroy();
      reject(error);
      if (abortParser) parser.abort(error);
    };

    parser.on("entry", (entry: tar.ReadEntry) => {
      streamedEntries += 1;
      const isFile = entry.type === "File";
      const normalizedPath = normalizeArchivePath(entry.path);
      const includedEntry = normalizedPath !== null && (
        includeSubpath === "" ||
        normalizedPath === includeSubpath ||
        normalizedPath.startsWith(`${includeSubpath}/`)
      );
      const includedFile = isFile && includedEntry;
      if (includedEntry) selectedEntries += 1;
      if (streamedEntries > maxStreamedEntries || selectedEntries > MAX_ARCHIVE_ENTRIES ||
          entry.size > maxStreamedBytes - streamedBytes ||
          (includedEntry && entry.size > MAX_EXTRACTED_BYTES - selectedBytes) ||
          (includedFile && entry.size > MAX_EXTRACTED_FILE_BYTES)) {
        fail(sourceTooLarge(
          streamedEntries > maxStreamedEntries || selectedEntries > MAX_ARCHIVE_ENTRIES
            ? "workflow source archive contains too many entries"
            : (includedFile && entry.size > MAX_EXTRACTED_FILE_BYTES
              ? `workflow source file exceeds the size limit: ${entry.path}`
              : "workflow source archive exceeds the extracted size limit")
        ));
        return;
      }
      const chunks: Buffer[] = [];
      let entryBytes = 0;
      entry.on("data", (chunk: Buffer) => {
        if (failed) return;
        entryBytes += chunk.byteLength;
        streamedBytes += chunk.byteLength;
        if (includedEntry) selectedBytes += chunk.byteLength;
        if ((includedFile && entryBytes > MAX_EXTRACTED_FILE_BYTES) ||
            streamedBytes > maxStreamedBytes || selectedBytes > MAX_EXTRACTED_BYTES) {
          fail(sourceTooLarge(
            includedFile && entryBytes > MAX_EXTRACTED_FILE_BYTES
              ? `workflow source file exceeds the size limit: ${entry.path}`
              : "workflow source archive exceeds the extracted size limit"
          ));
          return;
        }
        if (includedFile) chunks.push(chunk);
      });
      entry.on("end", () => {
        if (failed || !includedFile || normalizedPath === null) return;
        const path = normalizedPath;
        const contentBytes = Buffer.concat(chunks);
        try {
          // Keep the decoder scoped to one archive entry. ignoreBOM preserves
          // U+FEFF as content, matching Node readFile(..., "utf8") and the
          // workflow package's canonical content-hash generator.
          files.push({
            path,
            content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes)
          });
        } catch {
          if (!options.allowCanonicalUtf8Replacement) {
            fail(new ServerDomainError(
              422,
              "WORKFLOW_SOURCE_INVALID_UTF8",
              `workflow source contains a non-UTF-8 file: ${entry.path}`
            ));
            return;
          }
          files.push({ path, content: contentBytes.toString("utf8") });
          canonicalUtf8ReplacementPaths.push(path);
        }
      });
      entry.on("error", (error: unknown) => {
        fail(error instanceof Error ? error : new Error("workflow archive entry failed"));
      });
      if (!isFile) entry.resume();
    });
    parser.on("meta", (metadata: unknown) => {
      if (failed) return;
      const size = typeof metadata === "string"
        ? Buffer.byteLength(metadata, "utf8")
        : (metadata instanceof Uint8Array ? metadata.byteLength : 0);
      streamedEntries += 1;
      streamedBytes += size;
      if (!filteringSubpath) {
        selectedEntries += 1;
        selectedBytes += size;
      }
      if (streamedEntries > maxStreamedEntries || selectedEntries > MAX_ARCHIVE_ENTRIES ||
          streamedBytes > maxStreamedBytes || selectedBytes > MAX_EXTRACTED_BYTES) {
        fail(sourceTooLarge(
          streamedEntries > maxStreamedEntries || selectedEntries > MAX_ARCHIVE_ENTRIES
            ? "workflow source archive contains too many entries"
            : "workflow source archive exceeds the extracted size limit"
        ));
      }
    });
    parser.on("ignoredEntry", (ignored: unknown) => {
      if (failed) return;
      const size = typeof ignored === "object" && ignored !== null && "size" in ignored &&
        typeof ignored.size === "number"
        ? ignored.size
        : 0;
      const ignoredPath = typeof ignored === "object" && ignored !== null && "path" in ignored &&
        typeof ignored.path === "string"
        ? normalizeArchivePath(ignored.path)
        : null;
      const includedIgnored = !filteringSubpath || (ignoredPath !== null && (
        ignoredPath === includeSubpath || ignoredPath.startsWith(`${includeSubpath}/`)
      ));
      streamedEntries += 1;
      streamedBytes += size;
      if (includedIgnored) {
        selectedEntries += 1;
        selectedBytes += size;
      }
      if (streamedEntries > maxStreamedEntries || selectedEntries > MAX_ARCHIVE_ENTRIES ||
          streamedBytes > maxStreamedBytes || selectedBytes > MAX_EXTRACTED_BYTES) {
        fail(sourceTooLarge(
          streamedEntries > maxStreamedEntries || selectedEntries > MAX_ARCHIVE_ENTRIES
            ? "workflow source archive contains too many entries"
            : "workflow source archive exceeds the extracted size limit"
        ));
      }
    });
    parser.on("end", () => resolve());
    parser.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error("workflow archive parser failed"), false);
    });
  });
  source = Readable.from([tarball]);
  source.on("error", (error: unknown) => {
    parser.abort(error instanceof Error ? error : new Error("workflow source stream failed"));
  });
  source.pipe(parser);
  try {
    await pending;
  } catch (error) {
    if (error instanceof ServerDomainError) throw error;
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_INVALID_ARCHIVE", "workflow source archive could not be extracted");
  }
  return { files, canonicalUtf8ReplacementPaths };
}

function parseJsonFile(files: SourceFile[], path: string): Record<string, unknown> | null {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) return null;
  try {
    const value = JSON.parse(file.content) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseWorkflowManifest(files: SourceFile[]): WorkflowSourceManifest | null {
  const file = files.find((entry) => entry.path === "hunter-workflow-family.json");
  if (file === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(file.content) as unknown;
  } catch {
    throw new ServerDomainError(
      422,
      "WORKFLOW_SOURCE_MANIFEST_INVALID",
      "hunter-workflow-family.json contains invalid JSON"
    );
  }
  const parsed = workflowSourceManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const schemaVersion = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).schema_version
    : undefined;
  throw new ServerDomainError(
    422,
    schemaVersion === 1 ? "WORKFLOW_SOURCE_MANIFEST_INVALID" : "WORKFLOW_SOURCE_MANIFEST_UNSUPPORTED",
    schemaVersion === 1
      ? "hunter-workflow-family.json does not match the supported schema"
      : "hunter-workflow-family.json uses an unsupported schema version"
  );
}

function sourceSlug(value: string): string {
  const unscoped = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  const slug = unscoped.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length === 0 ? "imported-workflow" : slug;
}

function sourceDisplayName(value: string): string {
  return value.split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function profileFilesFromPackage(allFiles: SourceFile[], profile: string): SourceFile[] {
  const prefixes: Array<{ source: string; destination: string }> = [
    { source: `harness/bundles/${profile}/`, destination: "" },
    { source: `harness/manifests/${profile}/`, destination: "manifests/" },
    { source: `profiles/${profile}/`, destination: "" },
    { source: `${profile}/`, destination: "" }
  ];
  const out: SourceFile[] = [];
  for (const file of allFiles) {
    for (const prefix of prefixes) {
      if (!file.path.startsWith(prefix.source)) continue;
      const relative = file.path.slice(prefix.source.length);
      if (relative.length > 0) out.push({ path: `${prefix.destination}${relative}`, content: file.content });
      break;
    }
  }
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

function detectedProfileNames(files: SourceFile[], manifest: WorkflowSourceManifest | null): string[] {
  if (manifest !== null) return manifest.required_profiles;
  const discovered = new Set<string>();
  for (const file of files) {
    const match = /^(?:harness\/bundles|profiles)\/([^/]+)\//.exec(file.path);
    if (match?.[1] !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(match[1])) discovered.add(match[1]);
  }
  return [...discovered].sort();
}

function firstSemver(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && registrySemverSchema.safeParse(value.replace(/^v/i, "")).success) {
      return value.replace(/^v/i, "");
    }
  }
  return null;
}

function inspectFiles(
  source: WorkflowFamilySource,
  files: SourceFile[],
  metadata: SourceMetadata
): LoadedWorkflowSource {
  const manifest = parseWorkflowManifest(files);
  if (metadata.canonicalUtf8ReplacementPaths.length > 0) {
    const compatible = metadata.trustedPublisher && manifest !== null &&
      metadata.canonicalUtf8ReplacementPaths.every((path) =>
        path.startsWith("harness/") && path.toLowerCase().endsWith(".md")
      );
    if (!compatible) {
      throw new ServerDomainError(
        422,
        "WORKFLOW_SOURCE_INVALID_UTF8",
        `workflow source contains a non-UTF-8 file: ${metadata.canonicalUtf8ReplacementPaths[0] ?? "unknown"}`
      );
    }
  }
  verifyWorkflowManifestContent(manifest, files);
  const packageJson = parseJsonFile(files, "package.json");
  const manifestSlug = typeof manifest?.family_slug === "string" ? manifest.family_slug : null;
  const packageName = typeof packageJson?.name === "string" ? packageJson.name : metadata.name;
  const slug = sourceSlug(manifestSlug ?? packageName);
  const displayName = typeof manifest?.display_name === "string" && manifest.display_name.trim() !== ""
    ? manifest.display_name.trim()
    : sourceDisplayName(slug);
  const packageDescription = typeof packageJson?.description === "string" ? packageJson.description.trim() : "";
  const description = packageDescription || metadata.description.trim() || `Imported workflow family from ${source.ref}`;
  const remoteVersion = firstSemver(
    manifest?.workflowPackageVersion,
    packageJson?.version,
    metadata.version,
    manifest?.bundle_version
  );

  const profileFiles = new Map<string, SourceFile[]>();
  const warnings: string[] = [...metadata.sourceWarnings];
  if (metadata.canonicalUtf8ReplacementPaths.length > 0) {
    warnings.push(
      `${metadata.canonicalUtf8ReplacementPaths.length} trusted Markdown file(s) used the package's canonical UTF-8 replacement decoding; manifest content integrity was verified.`
    );
  }
  const declaredProfiles = detectedProfileNames(files, manifest);
  for (const profile of declaredProfiles) {
    const contents = profileFilesFromPackage(files, profile);
    if (contents.length === 0) {
      warnings.push(`Profile ${profile} was declared but contains no files.`);
      continue;
    }
    profileFiles.set(profile, contents);
  }
  if (manifest === null) warnings.push("hunter-workflow-family.json was not found; profiles were inferred from directories.");
  if (remoteVersion === null) warnings.push("No semantic workflow package version was detected.");
  if (profileFiles.size === 0) warnings.push("No workflow profiles were found under harness/bundles or profiles.");

  let pathsReady = true;
  for (const [profile, contents] of profileFiles) {
    try {
      validateAndIndexSourceFiles(contents);
    } catch (error) {
      pathsReady = false;
      warnings.push(
        `Profile ${profile} contains invalid file paths: ${error instanceof Error ? error.message : "validation failed"}`
      );
    }
  }

  const sensitiveReady = true;

  const inspection = workflowFamilySourceInspectionSchema.parse({
    source,
    remote_version: remoteVersion,
    source_digest: metadata.sourceDigest,
    manifest_detected: manifest !== null,
    ready: profileFiles.size > 0 && profileFiles.size === declaredProfiles.length && pathsReady && sensitiveReady,
    suggested: {
      slug,
      displayName,
      description,
      tags: manifestSlug === null ? [] : [slug]
    },
    profiles: [...profileFiles.entries()].map(([profile, contents]) => ({
      profile,
      file_count: contents.length
    })),
    warnings
  });
  return {
    inspection,
    profileFiles,
    allowTrustedSourceFindings: metadata.trustedPublisher
  };
}

function verifyWorkflowManifestContent(
  manifest: WorkflowSourceManifest | null,
  files: SourceFile[]
): void {
  if (manifest === null) return;
  const expected = manifest.content_sha256;
  const harnessFiles = files
    .filter((file) => file.path.startsWith("harness/"))
    .filter((file) => !file.path.split("/").includes("__pycache__") && !file.path.endsWith(".pyc"))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ path: file.path, content: file.content }));
  if (harnessFiles.length === 0) {
    throw new ServerDomainError(
      422,
      "WORKFLOW_SOURCE_CONTENT_INTEGRITY_FAILED",
      "workflow manifest declares content integrity but the harness directory is missing"
    );
  }
  const actual = sha256Bytes(canonicalJson(harnessFiles));
  if (actual !== expected) {
    throw new ServerDomainError(
      422,
      "WORKFLOW_SOURCE_CONTENT_INTEGRITY_FAILED",
      "workflow package content does not match hunter-workflow-family.json",
      { expected, actual }
    );
  }
}

function parseGithubWorkflowRef(ref: string): {
  owner: string;
  repo: string;
  treeSegments: string[] | null;
} {
  const trimmed = ref.trim();
  const normalized = normalizeGithubRef(trimmed);
  if (!/^https?:\/\//i.test(trimmed)) {
    return { owner: normalized.owner, repo: normalized.repo, treeSegments: null };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_REF_INVALID", "invalid GitHub workflow source URL");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const suffix = segments.slice(2);
  if (suffix.length === 0) {
    return { owner: normalized.owner, repo: normalized.repo, treeSegments: null };
  }
  if (suffix[0]?.toLowerCase() !== "tree" || suffix.length < 2) {
    throw new ServerDomainError(
      422,
      "WORKFLOW_SOURCE_REF_INVALID",
      "GitHub workflow source must be a repository URL or an exact /tree/<branch>/<subpath> URL"
    );
  }
  let treeSegments: string[];
  try {
    treeSegments = suffix.slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_REF_INVALID", "GitHub workflow source contains invalid encoding");
  }
  if (treeSegments.length > 32 || treeSegments.some((segment) =>
    segment === "" || segment === "." || segment === ".." || segment.includes("\0")
  )) {
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_REF_INVALID", "GitHub workflow source tree path is invalid");
  }
  return {
    owner: normalized.owner,
    repo: normalized.repo,
    treeSegments
  };
}

async function githubCommitSha(
  owner: string,
  repo: string,
  ref: string,
  fetchFn: typeof fetch,
  headers: Record<string, string>
): Promise<string | null> {
  const response = await fetchFn(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers }
  );
  if (response.status === 404 || response.status === 422) return null;
  if (!response.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `GitHub commit API returned ${response.status}`);
  }
  const body = await readExternalJson(response) as { sha?: unknown };
  if (typeof body?.sha !== "string" || !/^[a-f0-9]{7,64}$/i.test(body.sha)) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "GitHub commit API returned an invalid commit");
  }
  return body.sha;
}

async function resolveGithubTree(
  parsed: ReturnType<typeof parseGithubWorkflowRef>,
  defaultBranch: string,
  fetchFn: typeof fetch,
  headers: Record<string, string>
): Promise<{ commitSha: string; subpath: string }> {
  if (parsed.treeSegments === null) {
    const commitSha = await githubCommitSha(parsed.owner, parsed.repo, defaultBranch, fetchFn, headers);
    if (commitSha === null) {
      throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "GitHub default branch could not be resolved");
    }
    return { commitSha, subpath: "" };
  }
  for (let length = parsed.treeSegments.length; length >= 1; length -= 1) {
    const candidate = parsed.treeSegments.slice(0, length).join("/");
    const commitSha = await githubCommitSha(parsed.owner, parsed.repo, candidate, fetchFn, headers);
    if (commitSha !== null) {
      return {
        commitSha,
        subpath: parsed.treeSegments.slice(length).join("/")
      };
    }
  }
  throw new ServerDomainError(
    422,
    "WORKFLOW_SOURCE_REF_NOT_FOUND",
    "GitHub workflow source branch or commit could not be resolved"
  );
}

function filesAtSubpath(files: SourceFile[], subpath: string): SourceFile[] {
  if (subpath === "") return files;
  const prefix = `${subpath}/`;
  return files.flatMap((file) => file.path.startsWith(prefix)
    ? [{ path: file.path.slice(prefix.length), content: file.content }]
    : []);
}

async function loadWorkflowSource(
  inputSource: WorkflowFamilySource,
  deps: ExternalFetcherDeps
): Promise<LoadedWorkflowSource> {
  const source: WorkflowFamilySource = {
    type: inputSource.type,
    ref: inputSource.ref.trim()
  };
  try {
    const fetchDeps: ExternalFetcherDeps = {
      ...deps,
      fetch: deadlineFetch(deps.fetch ?? globalThis.fetch, deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
    };
    if (source.type === "npm") {
      const packageName = normalizeNpmRef(source.ref);
      const trustedPublisher = packageName.toLowerCase() === "@hunter-harness/workflow-harness";
      const snapshot = await fetchNpmLatestMetadata(packageName, fetchDeps);
      const archive = await fetchNpmTarball(packageName, snapshot.version, fetchDeps);
      const extracted = await extractTarGz(archive, {
        allowCanonicalUtf8Replacement: trustedPublisher
      });
      return inspectFiles(
        { type: "npm", ref: packageName },
        extracted.files,
        {
          name: snapshot.name,
          description: snapshot.description,
          version: snapshot.version,
          sourceDigest: sha256Bytes(archive),
          trustedPublisher,
          canonicalUtf8ReplacementPaths: extracted.canonicalUtf8ReplacementPaths,
          sourceWarnings: []
        }
      );
    }

    const parsed = parseGithubWorkflowRef(source.ref);
    const fetchFn = fetchDeps.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "hunter-platform-workflow-import"
    };
    const token = fetchDeps.githubToken?.trim();
    if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
    const repoResponse = await fetchFn(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers });
    if (repoResponse.status === 404) {
      throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `GitHub repository not found: ${parsed.owner}/${parsed.repo}`);
    }
    if (!repoResponse.ok) {
      throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `GitHub API returned ${repoResponse.status}`);
    }
    const repo = await readExternalJson(repoResponse) as {
      default_branch?: string;
      full_name?: string;
      description?: string | null;
    };
    const resolved = await resolveGithubTree(parsed, repo.default_branch ?? "main", fetchFn, headers);
    const archiveResponse = await fetchFn(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${encodeURIComponent(resolved.commitSha)}`,
      { headers }
    );
    if (!archiveResponse.ok) {
      throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `GitHub tarball returned ${archiveResponse.status}`);
    }
    const archive = await readLimitedArchive(archiveResponse);
    const trustedPublisher = parsed.owner.toLowerCase() === "hunterzheng1" &&
      parsed.repo.toLowerCase() === "hunter-harness";
    const extracted = await extractTarGz(archive, {
      allowCanonicalUtf8Replacement: trustedPublisher,
      includeSubpath: resolved.subpath
    });
    const archiveFiles = extracted.files;
    let selectedFiles = filesAtSubpath(archiveFiles, resolved.subpath);
    const subpathPrefix = resolved.subpath === "" ? "" : `${resolved.subpath}/`;
    let selectedReplacementPaths = extracted.canonicalUtf8ReplacementPaths
      .filter((path) => subpathPrefix === "" || path.startsWith(subpathPrefix))
      .map((path) => subpathPrefix === "" ? path : path.slice(subpathPrefix.length));
    if (selectedFiles.length === 0 && resolved.subpath !== "") {
      throw new ServerDomainError(422, "WORKFLOW_SOURCE_SUBPATH_NOT_FOUND", "GitHub source subpath contains no files", {
        subpath: resolved.subpath
      });
    }
    let sourceDigest = sha256Bytes(archive);
    let sourceVersion: string | null = null;
    const sourceWarnings: string[] = [];
    const selectedHasHarness = selectedFiles.some((file) => file.path.startsWith("harness/"));
    if (trustedPublisher && !selectedHasHarness) {
      const githubManifest = parseWorkflowManifest(selectedFiles);
      const githubPackage = parseJsonFile(selectedFiles, "package.json");
      const npmName = typeof githubPackage?.name === "string" ? githubPackage.name : null;
      const npmVersion = typeof githubPackage?.version === "string" &&
        registrySemverSchema.safeParse(githubPackage.version).success
        ? githubPackage.version
        : null;
      if (
        githubManifest !== null &&
        npmName === "@hunter-harness/workflow-harness" &&
        npmVersion !== null &&
        githubManifest.workflowPackageVersion === npmVersion
      ) {
        const npmArchive = await fetchNpmTarball(npmName, npmVersion, fetchDeps);
        const npmExtracted = await extractTarGz(npmArchive, {
          allowCanonicalUtf8Replacement: true
        });
        const npmManifest = parseWorkflowManifest(npmExtracted.files);
        if (npmManifest === null || canonicalJson(npmManifest) !== canonicalJson(githubManifest)) {
          throw new ServerDomainError(
            422,
            "WORKFLOW_SOURCE_DISTRIBUTION_MISMATCH",
            "GitHub workflow manifest does not match its published npm distribution"
          );
        }
        selectedFiles = npmExtracted.files;
        selectedReplacementPaths = npmExtracted.canonicalUtf8ReplacementPaths;
        sourceVersion = npmVersion;
        sourceDigest = sha256Bytes(canonicalJson({
          github_archive_sha256: sha256Bytes(archive),
          npm_archive_sha256: sha256Bytes(npmArchive),
          npm_package: `${npmName}@${npmVersion}`
        }));
        sourceWarnings.push(
          `The exact GitHub tree tracks the workflow manifest but excludes generated harness data; verified ${npmName}@${npmVersion} supplied the matching published artifact.`
        );
      }
    }
    return inspectFiles(source, selectedFiles, {
      name: repo.full_name ?? `${parsed.owner}/${parsed.repo}`,
      description: repo.description ?? "",
      version: sourceVersion,
      sourceDigest,
      trustedPublisher,
      canonicalUtf8ReplacementPaths: selectedReplacementPaths,
      sourceWarnings
    });
  } catch (error) {
    return domainFetchError(error);
  }
}

export async function inspectWorkflowFamilySource(
  source: WorkflowFamilySource,
  deps: ExternalFetcherDeps = {}
): Promise<WorkflowFamilySourceInspection> {
  return (await loadWorkflowSource(source, deps)).inspection;
}

export async function importWorkflowFamilyFromSource(
  store: WorkflowFamilyStore,
  input: ImportWorkflowFamilySourceRequest,
  deps: ExternalFetcherDeps = {},
  tx?: TransactionRepository
): Promise<WorkflowFamilySourceImportResult> {
  return commitPreparedWorkflowFamilyImport(
    store,
    await prepareWorkflowFamilyImport(input, deps),
    tx
  );
}

export async function prepareWorkflowFamilyImport(
  input: ImportWorkflowFamilySourceRequest,
  deps: ExternalFetcherDeps = {}
): Promise<PreparedWorkflowFamilyImport> {
  const loaded = await loadWorkflowSource(input.source, deps);
  if (loaded.inspection.source_digest !== input.source_digest) {
    throw new ServerDomainError(
      409,
      "WORKFLOW_SOURCE_CHANGED",
      "workflow source changed after preflight; inspect the source again before importing"
    );
  }
  if (!loaded.inspection.ready) {
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_NOT_READY", "workflow source did not pass preflight", {
      warnings: loaded.inspection.warnings
    });
  }
  const requiredProfiles = loaded.inspection.profiles.map((entry) => entry.profile);
  return {
    family: {
      slug: input.slug,
      displayName: input.displayName,
      description: input.description,
      tags: input.tags,
      required_profiles: requiredProfiles,
      source: loaded.inspection.source
    },
    profiles: requiredProfiles.map((profile) => ({
      profile,
      files: loaded.profileFiles.get(profile) ?? []
    })),
    inspection: loaded.inspection,
    allowTrustedSourceFindings: loaded.allowTrustedSourceFindings,
    ...(loaded.inspection.remote_version === null
      ? {}
      : { draftVersion: loaded.inspection.remote_version })
  };
}

export async function commitPreparedWorkflowFamilyImport(
  store: WorkflowFamilyStore,
  prepared: PreparedWorkflowFamilyImport,
  tx?: TransactionRepository
): Promise<WorkflowFamilySourceImportResult> {
  const imported = await store.importFamilyDraft({
    family: prepared.family,
    profiles: prepared.profiles,
    sourceDigest: prepared.inspection.source_digest,
    allowTrustedSourceFindings: prepared.allowTrustedSourceFindings,
    ...(tx === undefined ? {} : { tx }),
    ...(prepared.draftVersion === undefined ? {} : { draftVersion: prepared.draftVersion })
  });
  const { family, draft } = imported;
  return {
    family,
    draft: summarizeWorkflowFamilyDraft(draft),
    inspection: prepared.inspection
  };
}

/** Pull the latest source revision for an existing family and stage it as a draft. */
export async function syncWorkflowFamilyFromSource(
  store: WorkflowFamilyStore,
  slug: string,
  deps: ExternalFetcherDeps = {},
  tx?: TransactionRepository
): Promise<WorkflowFamilySyncResult> {
  const family: WorkflowFamily = store.getFamily(slug);
  return commitPreparedWorkflowFamilySync(
    store,
    await prepareWorkflowFamilySync(family, deps, store.latestPublishedSourceDigest(slug)),
    tx
  );
}

export async function prepareWorkflowFamilySync(
  family: WorkflowFamily,
  deps: ExternalFetcherDeps = {},
  latestPublishedSourceDigest: string | null = null
): Promise<PreparedWorkflowFamilySync> {
  if (family.source === undefined) {
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_MISSING", "workflow family has no source; set source.type/ref before sync");
  }
  const loaded = await loadWorkflowSource(family.source, deps);
  if (!loaded.inspection.ready) {
    throw new ServerDomainError(422, "WORKFLOW_SOURCE_NOT_READY", "workflow source did not pass preflight", {
      warnings: loaded.inspection.warnings
    });
  }
  const missing = family.required_profiles.find((profile) => !loaded.profileFiles.has(profile));
  if (missing !== undefined) {
    throw new ServerDomainError(422, "WORKFLOW_PROFILE_MISSING", "workflow source is missing a required profile", {
      profile: missing
    });
  }
  const remoteVersion = loaded.inspection.remote_version;
  let result: WorkflowFamilySyncResult;
  if (remoteVersion !== null && family.latest_version !== null) {
    const comparison = compareSemver(remoteVersion, family.latest_version);
    if (comparison === 0 && latestPublishedSourceDigest !== null &&
      latestPublishedSourceDigest !== loaded.inspection.source_digest) {
      throw new ServerDomainError(
        409,
        "WORKFLOW_SOURCE_VERSION_CONFLICT",
        "workflow source content changed without a version change; publish the source with a new version before syncing",
        {
          version: remoteVersion,
          published_source_digest: latestPublishedSourceDigest,
          current_source_digest: loaded.inspection.source_digest
        }
      );
    }
    result = comparison <= 0
      ? { updated: false, version: family.latest_version }
      : { updated: true, version: remoteVersion };
  } else {
    result = remoteVersion === null ? { updated: true } : { updated: true, version: remoteVersion };
  }
  return {
    slug: family.slug,
    familyRevision: family.revision,
    familySource: family.source,
    profiles: family.required_profiles.map((profile) => ({
      profile,
      files: loaded.profileFiles.get(profile) ?? []
    })),
    inspection: loaded.inspection,
    allowTrustedSourceFindings: loaded.allowTrustedSourceFindings,
    result,
    ...(remoteVersion === null ? {} : { draftVersion: remoteVersion })
  };
}

export async function commitPreparedWorkflowFamilySync(
  store: WorkflowFamilyStore,
  prepared: PreparedWorkflowFamilySync,
  tx?: TransactionRepository
): Promise<WorkflowFamilySyncResult> {
  const family = store.getFamily(prepared.slug);
  if (
    family.revision !== prepared.familyRevision ||
    family.source === undefined ||
    canonicalJson(family.source) !== canonicalJson(prepared.familySource)
  ) {
    throw new ServerDomainError(
      409,
      "WORKFLOW_FAMILY_CHANGED",
      "workflow family changed while its source was being resolved; retry sync"
    );
  }
  if (!prepared.result.updated) return prepared.result;
  await store.replaceFamilyDraftProfiles({
    slug: prepared.slug,
    profiles: prepared.profiles,
    sourceDigest: prepared.inspection.source_digest,
    allowTrustedSourceFindings: prepared.allowTrustedSourceFindings,
    ...(tx === undefined ? {} : { tx }),
    ...(prepared.draftVersion === undefined ? {} : { draftVersion: prepared.draftVersion })
  });
  return prepared.result;
}
