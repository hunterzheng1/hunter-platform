import { createHash } from "node:crypto";

import type { PlanEventBundleReadResult } from "@hunter-harness/contracts";
import { z } from "zod";

import type { Stage12MonitorVerifierPort } from "../branch-monitor-query/index.js";
import type { RunStore } from "./store.js";

const timestamp = z.iso.datetime({ offset: true });
const eventSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1).max(160),
  lifecycle_kind: z.literal("change"),
  run_id: z.string().min(1).max(160),
  change_key: z.string().min(1).max(160),
  phase: z.enum(["plan", "run", "test", "review", "package", "apidoc", "submit", "merge", "archive"]),
  attempt: z.number().int().positive(),
  type: z.enum(["phase_started", "decision_recorded", "risk_found", "artifact_published", "validation_failed", "phase_ended"]),
  producer_seq: z.number().int().positive(),
  occurred_at: timestamp,
  idempotency_key: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  summary_zh: z.string().min(1).max(2048).optional(),
  detail_ref: z.string().min(1).max(512).optional(),
  receipt_ref: z.string().min(1).max(512).optional()
}).strict();
const trustedReadSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["current", "terminal"]),
  source_schema_version: z.literal(1),
  value: z.object({
    schema_version: z.literal(1),
    lifecycle_kind: z.literal("change"),
    run_id: z.string().min(1).max(160),
    change_key: z.string().min(1).max(160),
    events: z.array(eventSchema).min(1).max(4096),
    bundle_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  }).strict()
}).strict();

export interface PlanQualityEventBundleReaderPort {
  /** Must delegate to Harness createPlanQualityModule().readEventBundle. */
  readEventBundle(serialized: unknown): Promise<PlanEventBundleReadResult>;
}

export interface Stage12MonitorVerifierDependencies {
  readonly eventBundleReader: PlanQualityEventBundleReaderPort;
  readonly runStore: RunStore;
}

const defaultSummary: Record<z.infer<typeof eventSchema>["type"], string> = {
  phase_started: "阶段已开始",
  decision_recorded: "已记录重要决策",
  risk_found: "发现风险或阻塞项",
  artifact_published: "规划产物已发布",
  validation_failed: "规划质量校验未通过",
  phase_ended: "阶段已结束"
};

function sha256(serialized: string): string {
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

export function createStage12MonitorVerifierAdapter(
  dependencies: Stage12MonitorVerifierDependencies
): Stage12MonitorVerifierPort {
  return {
    async verify(input) {
      if (sha256(input.serialized_bundle) !== input.bundle_sha256) {
        throw new Error("STAGE12_MONITOR_BUNDLE_HASH_INVALID");
      }
      const trusted = trustedReadSchema.safeParse(
        await dependencies.eventBundleReader.readEventBundle(input.serialized_bundle)
      );
      if (!trusted.success) throw new Error("STAGE12_MONITOR_BUNDLE_UNTRUSTED");
      const bundle = trusted.data.value;
      const run = await dependencies.runStore.getRun(input.project_id, bundle.run_id);
      if (run === null || run.projectId !== input.project_id || run.lifecycleKind !== "change" ||
          run.sourceVersion !== "plan-event-bundle/v1" || run.branchName === null ||
          run.changeKey !== bundle.change_key) {
        throw new Error("STAGE12_MONITOR_RUN_IDENTITY_INVALID");
      }
      const first = bundle.events[0];
      const last = bundle.events.at(-1);
      if (first === undefined || last === undefined) throw new Error("STAGE12_MONITOR_EVENTS_INVALID");
      const startedAt = first.occurred_at;
      const endedAt = last.type === "phase_ended" ? last.occurred_at : null;
      const duration = endedAt === null ? null : Date.parse(endedAt) - Date.parse(startedAt);
      return JSON.stringify({
        schema_version: 1,
        anchor_kind: "stage12_monitor_projection",
        bundle_sha256: input.bundle_sha256,
        project_id: input.project_id,
        lifecycle_kind: "change",
        run_id: run.runId,
        branch_name: run.branchName,
        change_key: run.changeKey,
        run_status: run.runStatus,
        current_phase: last.phase,
        started_at: startedAt,
        ended_at: endedAt,
        duration_ms: duration === null || !Number.isSafeInteger(duration) || duration < 0 ? null : duration,
        last_event_at: last.occurred_at,
        events: bundle.events.slice(-100).map((event) => ({
          event_id: event.event_id,
          idempotency_key: event.idempotency_key,
          type: event.type,
          phase: event.phase,
          attempt: event.attempt,
          producer_seq: event.producer_seq,
          occurred_at: event.occurred_at,
          display_summary_zh: event.summary_zh ?? defaultSummary[event.type],
          technical_code: `PLAN_${event.type.toUpperCase()}`,
          detail_ref: event.detail_ref ?? null,
          receipt_ref: event.receipt_ref ?? null
        }))
      });
    }
  };
}
