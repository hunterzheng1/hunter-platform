/**
 * Map project_files under `.harness/archive/<changeKey>/` into ChangeArchive shape.
 */

export type ArchiveFileKind = "design" | "plan" | "report" | "evidence" | "meta" | "log" | "knowledge";
export type ArchiveFileTier = "core" | "supporting" | "diagnostic";

export interface ArchiveFileEntry {
  path: string;
  sizeBytes: number;
  kind: ArchiveFileKind;
  tier: ArchiveFileTier;
}

export interface ChangeArchive {
  changeKey: string;
  archivedAt: string | null;
  files: ArchiveFileEntry[];
}

const ARCHIVE_PREFIX = ".harness/archive/";
const ARCHIVE_CHANGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

/** Validate the portable key used to address a change archive. */
export function validateArchiveChangeKey(changeKey: string): string {
  if (!ARCHIVE_CHANGE_KEY_PATTERN.test(changeKey)) {
    throw new Error("ARCHIVE_CHANGE_KEY_INVALID");
  }
  return changeKey;
}

export function archiveRootPrefix(changeKey: string): string {
  return `${ARCHIVE_PREFIX}${changeKey}/`;
}

/** Reject path traversal and ensure the path stays under the change archive root. */
export function resolveArchiveContentPath(changeKey: string, requestedPath: string): string {
  const root = archiveRootPrefix(changeKey);
  const normalized = requestedPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("ARCHIVE_PATH_INVALID");
  }
  if (normalized.startsWith(root)) return normalized;
  if (normalized.startsWith(ARCHIVE_PREFIX)) {
    throw new Error("ARCHIVE_PATH_OUTSIDE");
  }
  return root + normalized;
}

export function deriveArchiveKind(relativePath: string): ArchiveFileKind {
  const path = relativePath.replaceAll("\\", "/").toLowerCase();
  if (path.startsWith("spec/") || path.includes("-design.")) return "design";
  if (path.startsWith("plans/")) return "plan";
  if (path.startsWith("knowledge/")) return "knowledge";
  if (path.startsWith("reports/")) return "report";
  if (path.startsWith("evidence/")) return "evidence";
  if (path.startsWith("meta/")) return "meta";
  if (path === "events.ndjson" || path.startsWith("logs/") || path.endsWith(".ndjson")) return "log";
  return "meta";
}

export function deriveArchiveTier(relativePath: string, kind: ArchiveFileKind): ArchiveFileTier {
  const path = relativePath.replaceAll("\\", "/").toLowerCase();
  if (
    kind === "design" ||
    kind === "plan" ||
    kind === "knowledge" ||
    path === "reports/final/summary-data.json"
  ) {
    return "core";
  }
  if (
    path.startsWith("reports/review/") ||
    path.startsWith("reports/test/") ||
    path === "meta/archive-meta.md" ||
    path === "meta/change-context.json"
  ) {
    return "supporting";
  }
  return "diagnostic";
}

export function buildChangeArchive(input: {
  changeKey: string;
  files: Array<{ path: string; sizeBytes: number; updatedAt?: string | null }>;
}): ChangeArchive {
  const root = archiveRootPrefix(input.changeKey);
  const mapped: ArchiveFileEntry[] = [];
  let archivedAt: string | null = null;
  for (const file of input.files) {
    if (!file.path.startsWith(root)) continue;
    const relative = file.path.slice(root.length);
    if (relative.length === 0 || relative.endsWith("/")) continue;
    const kind = deriveArchiveKind(relative);
    mapped.push({
      path: relative,
      sizeBytes: file.sizeBytes,
      kind,
      tier: deriveArchiveTier(relative, kind)
    });
    if (file.updatedAt !== undefined && file.updatedAt !== null) {
      if (archivedAt === null || file.updatedAt > archivedAt) archivedAt = file.updatedAt;
    }
  }
  mapped.sort((a, b) => a.path.localeCompare(b.path));
  return {
    changeKey: input.changeKey,
    archivedAt,
    files: mapped
  };
}
