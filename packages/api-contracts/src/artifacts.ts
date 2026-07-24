import {
  ArtifactIdSchema,
  AttemptIdSchema,
  ProjectIdSchema,
} from "@hunter/domain/ids";
import { z } from "zod";

export const ARTIFACT_HTTP_LIMITS = Object.freeze({
  defaultPageItems: 20,
  maxPageItems: 32,
  maxChunkBytes: 64 * 1_024,
  maxPageBytes: 256 * 1_024,
  maxSummaryCharacters: 500,
});

const SafeByteCountSchema = z.number().int().nonnegative().safe();
const CursorSchema = z.number().int().nonnegative().safe();
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const utf8Encoder = new TextEncoder();

export const ArtifactIdParamsSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
});

export const ArtifactPageHttpQuerySchema = z.strictObject({
  cursor: z.coerce.number().int().nonnegative().safe().default(0),
  limit: z.coerce.number().int().positive()
    .max(ARTIFACT_HTTP_LIMITS.maxPageItems)
    .default(ARTIFACT_HTTP_LIMITS.defaultPageItems),
});
export type ArtifactPageHttpQuery = z.infer<
  typeof ArtifactPageHttpQuerySchema
>;

export const ArtifactSummaryHttpSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  projectId: ProjectIdSchema,
  attemptId: AttemptIdSchema.nullable(),
  kind: z.enum(["log", "report", "receipt"]),
  retentionClass: z.enum([
    "ephemeral",
    "standard",
    "evidence",
    "archive",
    "core_receipt",
  ]),
  summary: z.string().trim().min(1)
    .max(ARTIFACT_HTTP_LIMITS.maxSummaryCharacters),
  byteLength: SafeByteCountSchema,
  entryCount: CursorSchema,
});
export type ArtifactSummaryHttp = z.infer<
  typeof ArtifactSummaryHttpSchema
>;

export const ArtifactPageEntryHttpSchema = z.strictObject({
  cursor: z.number().int().positive().safe(),
  stream: z.enum(["stdout", "stderr", "system"]),
  content: z.string().min(1),
  contentHash: DigestSchema,
  byteLength: z.number().int().positive().safe()
    .max(ARTIFACT_HTTP_LIMITS.maxChunkBytes),
  occurredAt: z.string().datetime({ offset: true }),
}).superRefine((entry, context) => {
  const actualBytes = utf8Encoder.encode(entry.content).byteLength;
  if (actualBytes !== entry.byteLength) {
    context.addIssue({
      code: "custom",
      path: ["byteLength"],
      message: "byteLength must equal the UTF-8 content size",
    });
  }
  if (actualBytes > ARTIFACT_HTTP_LIMITS.maxChunkBytes) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "artifact page entry exceeds the byte budget",
    });
  }
});
export type ArtifactPageEntryHttp = z.infer<
  typeof ArtifactPageEntryHttpSchema
>;

const ArtifactPageOkHttpResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("ok"),
  artifact: ArtifactSummaryHttpSchema,
  cursor: CursorSchema,
  nextCursor: CursorSchema,
  retentionFloor: CursorSchema,
  highWaterCursor: CursorSchema,
  complete: z.boolean(),
  responseBytes: SafeByteCountSchema.max(
    ARTIFACT_HTTP_LIMITS.maxPageBytes,
  ),
  entries: z.array(ArtifactPageEntryHttpSchema)
    .max(ARTIFACT_HTTP_LIMITS.maxPageItems),
}).superRefine((page, context) => {
  if (
    page.retentionFloor > page.cursor
    || page.cursor > page.nextCursor
    || page.nextCursor > page.highWaterCursor
    || page.highWaterCursor !== page.artifact.entryCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["cursor"],
      message: "artifact page cursors are inconsistent",
    });
  }
  const cursors = page.entries.map(({ cursor }) => cursor);
  if (
    cursors.some((cursor, index) =>
      cursor <= page.cursor
      || (index > 0 && cursor <= (cursors[index - 1] ?? 0))
    )
    || page.nextCursor !== (cursors.at(-1) ?? page.cursor)
  ) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "artifact page entries must be strictly ordered after cursor",
    });
  }
  const responseBytes = page.entries.reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (responseBytes !== page.responseBytes) {
    context.addIssue({
      code: "custom",
      path: ["responseBytes"],
      message: "responseBytes must equal the bounded entry payload size",
    });
  }
  if (
    page.complete !== (page.nextCursor >= page.highWaterCursor)
  ) {
    context.addIssue({
      code: "custom",
      path: ["complete"],
      message: "complete must reflect the durable high-water cursor",
    });
  }
});

const ArtifactPageResyncHttpResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("resync_required"),
  artifactId: ArtifactIdSchema,
  code: z.literal("ARTIFACT_CURSOR_RESYNC_REQUIRED"),
  retentionFloor: CursorSchema,
  highWaterCursor: CursorSchema,
  instructions: z.strictObject({
    snapshot: z.literal("reload_artifact_summary"),
    resume: z.literal("read_after_retention_floor"),
  }),
}).refine(
  ({ retentionFloor, highWaterCursor }) =>
    retentionFloor <= highWaterCursor,
  {
    path: ["retentionFloor"],
    message: "retentionFloor cannot exceed highWaterCursor",
  },
);

export const ArtifactPageHttpResponseSchema = z.discriminatedUnion(
  "status",
  [
    ArtifactPageOkHttpResponseSchema,
    ArtifactPageResyncHttpResponseSchema,
  ],
);
export type ArtifactPageHttpResponse = z.infer<
  typeof ArtifactPageHttpResponseSchema
>;

export const ArtifactQuotaHttpReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  level: z.enum(["normal", "soft_limit", "hard_limit"]),
  usedBytes: SafeByteCountSchema,
  projectedBytes: SafeByteCountSchema,
  softLimitBytes: z.number().int().positive().safe(),
  hardLimitBytes: z.number().int().positive().safe(),
  criticalReserveBytes: z.number().int().positive().safe(),
  usedCriticalReserveBytes: SafeByteCountSchema,
  nonCriticalWrites: z.enum(["accepted", "warned", "rejected"]),
  coreReceipts: z.literal("reserved"),
}).superRefine((receipt, context) => {
  if (
    receipt.softLimitBytes >= receipt.hardLimitBytes
    || receipt.projectedBytes < receipt.usedBytes
    || receipt.usedCriticalReserveBytes > receipt.criticalReserveBytes
  ) {
    context.addIssue({
      code: "custom",
      path: ["hardLimitBytes"],
      message: "artifact quota watermarks are inconsistent",
    });
  }
  const expectedLevel = receipt.projectedBytes >= receipt.hardLimitBytes
    ? "hard_limit"
    : receipt.projectedBytes >= receipt.softLimitBytes
    ? "soft_limit"
    : "normal";
  if (receipt.level !== expectedLevel) {
    context.addIssue({
      code: "custom",
      path: ["level"],
      message: "quota level must be derived from byte watermarks",
    });
  }
  const expectedWrites = expectedLevel === "hard_limit"
    ? "rejected"
    : expectedLevel === "soft_limit"
    ? "warned"
    : "accepted";
  if (receipt.nonCriticalWrites !== expectedWrites) {
    context.addIssue({
      code: "custom",
      path: ["nonCriticalWrites"],
      message: "non-critical write policy must match the quota level",
    });
  }
});
export type ArtifactQuotaHttpReceipt = z.infer<
  typeof ArtifactQuotaHttpReceiptSchema
>;

export const ArtifactBackpressureHttpReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  code: z.literal("ARTIFACT_CLIENT_BACKPRESSURE"),
  artifactId: ArtifactIdSchema,
  action: z.literal("disconnect_and_replay"),
  resumeAfterCursor: CursorSchema,
  highWaterCursor: CursorSchema,
  droppedNotifications: z.number().int().positive().safe(),
}).refine(
  ({ resumeAfterCursor, highWaterCursor }) =>
    resumeAfterCursor < highWaterCursor,
  {
    path: ["resumeAfterCursor"],
    message: "backpressure replay cursor must precede high water",
  },
);
export type ArtifactBackpressureHttpReceipt = z.infer<
  typeof ArtifactBackpressureHttpReceiptSchema
>;
