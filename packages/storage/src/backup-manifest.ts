import { createHash } from "node:crypto";

import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const BackupIdSchema = z
  .string()
  .regex(/^bkp_[0-9]{8}t[0-9]{9}z_[a-f0-9]{16}$/u);
const PortableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((path) => {
    if (
      path.startsWith("/")
      || path.includes("\\")
      || /^[a-z]:/iu.test(path)
      || path.includes("\0")
    ) {
      return false;
    }
    const segments = path.split("/");
    return segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    );
  }, "BACKUP_PATH_INVALID");

export const BackupFileScopeSchema = z.enum([
  "database",
  "content",
  "projects",
  "archives",
]);

export const BackupFileEntrySchema = z
  .object({
    scope: BackupFileScopeSchema,
    relativePath: PortableRelativePathSchema,
    sha256: Sha256Schema,
    size: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((entry, context) => {
    const expectedPrefix = entry.scope === "database"
      ? "hunter.sqlite"
      : `${entry.scope}/`;
    const matches = entry.scope === "database"
      ? entry.relativePath === expectedPrefix
      : entry.relativePath.startsWith(expectedPrefix);
    if (!matches) {
      context.addIssue({
        code: "custom",
        path: ["relativePath"],
        message: "BACKUP_SCOPE_PATH_MISMATCH",
      });
    }
    if (
      entry.scope === "content"
      && entry.relativePath.split("/").at(-1) !== entry.sha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["relativePath"],
        message: "BACKUP_CONTENT_PATH_HASH_MISMATCH",
      });
    }
  });
export type BackupFileEntry = z.infer<typeof BackupFileEntrySchema>;

const EventLedgerSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    firstPosition: z.number().int().positive().nullable(),
    lastPosition: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    const empty = summary.count === 0
      && summary.firstPosition === null
      && summary.lastPosition === null;
    const populated = summary.count > 0
      && summary.firstPosition !== null
      && summary.lastPosition !== null
      && summary.lastPosition >= summary.firstPosition
      && summary.count <= summary.lastPosition - summary.firstPosition + 1;
    if (!empty && !populated) {
      context.addIssue({
        code: "custom",
        message: "BACKUP_EVENT_LEDGER_RANGE_INVALID",
      });
    }
  });

export const BackupManifestInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    backupId: BackupIdSchema,
    createdAt: z.iso.datetime(),
    storage: z
      .object({
        schemaVersion: z.number().int().positive(),
        eventLedger: EventLedgerSummarySchema,
      })
      .strict(),
    files: z.array(BackupFileEntrySchema).min(1).max(1_000_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.files.map(({ relativePath }) => relativePath);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "BACKUP_FILE_PATH_DUPLICATE",
      });
    }
    if (
      manifest.files.filter(({ scope }) => scope === "database").length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "BACKUP_DATABASE_ENTRY_REQUIRED",
      });
    }
    const sorted = [...manifest.files].sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
        ? 1
        : 0
    );
    if (JSON.stringify(sorted) !== JSON.stringify(manifest.files)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "BACKUP_FILE_ORDER_INVALID",
      });
    }
  });
export type BackupManifestInput = z.infer<typeof BackupManifestInputSchema>;

export const BackupManifestSchema = BackupManifestInputSchema.safeExtend({
  manifestHash: Sha256Schema,
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

function hashInput(input: BackupManifestInput): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function createBackupManifest(input: unknown): BackupManifest {
  const parsed = BackupManifestInputSchema.parse(input);
  return BackupManifestSchema.parse({
    ...parsed,
    manifestHash: hashInput(parsed),
  });
}

export function verifyBackupManifest(input: unknown): BackupManifest {
  const manifest = BackupManifestSchema.parse(input);
  const { manifestHash, ...payload } = manifest;
  if (hashInput(payload) !== manifestHash) {
    throw new Error("BACKUP_MANIFEST_HASH_MISMATCH");
  }
  return manifest;
}
