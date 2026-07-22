import { ExecutionPlanIdSchema, RunIdSchema, WorkflowRevisionIdSchema } from "@hunter/domain";
import { z } from "zod";

export const CommandMetadataSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const StartRunHttpRequestSchema = z.strictObject({
  runId: RunIdSchema,
  executionPlanId: ExecutionPlanIdSchema,
  workflowRevisionId: WorkflowRevisionIdSchema,
  expectedVersion: CommandMetadataSchema.shape.expectedVersion,
  idempotencyKey: CommandMetadataSchema.shape.idempotencyKey,
});
export type StartRunHttpRequest = z.infer<typeof StartRunHttpRequestSchema>;
