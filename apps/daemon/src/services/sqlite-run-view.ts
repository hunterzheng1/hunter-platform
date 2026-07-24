import type { DatabaseSync } from "node:sqlite";

import {
  RunViewHttpResponseSchema,
  type RunViewHttpResponse,
} from "@hunter/api-contracts";
import { ArtifactIdSchema, type RunId } from "@hunter/domain";
import {
  currentRecoveryStep,
  type
  FlowDefinitions,
  type FlowStore,
  type WorkflowRunState,
} from "@hunter/flow-engine";
import type {
  CapabilityProbeReceipt,
  ExternalOperation,
} from "@hunter/runtime-contracts";
import type { SqliteOperationJournal } from "@hunter/storage";

import {
  attentionEvidenceForAttempt,
  projectAttentionItem,
} from "./sqlite-attention-actions.js";

function requiresAttention(
  attempt: WorkflowRunState["steps"][number]["attempts"][number],
): boolean {
  return [
    "waiting_input",
    "failed",
    "stale",
    "needs_attention",
  ].includes(attempt.executionStatus)
    || ["failed", "error", "needs_human"].includes(
      attempt.verificationStatus,
    );
}

function waitingReason(
  attempt: WorkflowRunState["steps"][number]["attempts"][number],
) {
  if (attempt.executionStatus === "waiting_input") {
    return { code: "input_required" as const };
  }
  if (attempt.verificationStatus === "needs_human") {
    return { code: "human_verification_required" as const };
  }
  if (attempt.executionStatus === "needs_attention") {
    return { code: "recovery_attention_required" as const };
  }
  return undefined;
}

export interface SqliteRunViewService {
  get(runId: RunId): RunViewHttpResponse | null;
}

export function createSqliteRunViewService(input: {
  readonly database: DatabaseSync;
  readonly flowStore: FlowStore;
  readonly definitions: FlowDefinitions;
  readonly journal: SqliteOperationJournal;
  readonly capabilityReceiptFor:
    | ((operation: ExternalOperation) => CapabilityProbeReceipt | null)
    | undefined;
  readonly now: () => Date;
}): SqliteRunViewService {
  return {
    get: (runId) => {
      const run = input.flowStore.loadRun(runId);
      if (run === null) return null;
      const workflow = input.definitions.getWorkflowRevision(
        run.binding.workflowRevisionId,
      );
      if (workflow === null) throw new Error("WORKFLOW_REVISION_NOT_FOUND");
      const currentStep = currentRecoveryStep(run);
      const currentAttemptId = currentStep?.attempts.at(-1)?.attemptId;
      const position = input.database.prepare(
        `SELECT COALESCE(MAX(position), 0) AS position
           FROM events
          WHERE aggregate_id = ?`,
      ).get(`run:${runId}`) as { readonly position: number };
      return RunViewHttpResponseSchema.parse({
        runId,
        projectionPosition: position.position,
        aggregateVersion: run.version,
        status: run.status,
        steps: run.steps.map((step) => {
          const definition = workflow.steps.find(
            ({ stepId }) => stepId === step.stepId,
          );
          if (definition === undefined) {
            throw new Error("WORKFLOW_STEP_NOT_FOUND");
          }
          return {
            stepRunId: step.stepRunId,
            title: definition.stepId,
            conclusion: step.conclusion,
            attempts: step.attempts.map((attempt) => {
              const evidence = attentionEvidenceForAttempt({
                database: input.database,
                run,
                step,
                attempt,
              });
              const reason = waitingReason(attempt);
              const artifactIds = ArtifactIdSchema.array().parse(
                (input.database.prepare(
                  `SELECT artifact_id
                     FROM artifact_catalog
                    WHERE attempt_id = ?
                    ORDER BY created_at, artifact_id`,
                ).all(attempt.attemptId) as unknown as readonly {
                  readonly artifact_id: string;
                }[]).map(({ artifact_id }) => artifact_id),
              );
              return {
                attemptId: attempt.attemptId,
                attemptNumber: attempt.attemptNumber,
                isCurrent:
                  step.stepRunId === currentStep?.stepRunId
                  && attempt.attemptId === currentAttemptId,
                executionStatus: attempt.executionStatus,
                verificationStatus: attempt.verificationStatus,
                artifactIds,
                evidenceIds: evidence.flatMap((reference) =>
                  "evidenceId" in reference ? [reference.evidenceId] : []
                ),
                ...(reason === undefined ? {} : { waitingReason: reason }),
                ...(requiresAttention(attempt)
                  ? {
                      attention: projectAttentionItem({
                        database: input.database,
                        run,
                        step,
                        attempt,
                        definitions: input.definitions,
                        journal: input.journal,
                        capabilityReceiptFor: input.capabilityReceiptFor,
                        now: input.now,
                        current:
                          step.stepRunId === currentStep?.stepRunId
                          && attempt.attemptId === currentAttemptId,
                      }),
                    }
                  : {}),
              };
            }),
          };
        }),
      });
    },
  };
}
