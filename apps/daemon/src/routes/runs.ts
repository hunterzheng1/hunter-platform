import {
  AttentionActionHttpRequestSchema,
  AttentionActionHttpResponseSchema,
  RunIdParamsSchema,
  RunViewHttpResponseSchema,
  StartRunHttpRequestSchema,
  type AttentionActionHttpRequest,
  type AttentionActionHttpResponse,
  type RunViewHttpResponse,
  type StartRunHttpRequest,
} from "@hunter/api-contracts";
import type { ExecutionPlanId, ProjectId, RunId } from "@hunter/domain";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

export interface RunRoutesServices {
  projectForExecutionPlan(executionPlanId: ExecutionPlanId): { readonly projectId: ProjectId; readonly executionPlanId: ExecutionPlanId } | null;
  projectForRun(runId: RunId): {
    readonly projectId: ProjectId;
    readonly runId: RunId;
  } | null;
  startRun(command: StartRunHttpRequest, actor: { readonly actorId: string; readonly correlationId: string }): Promise<unknown>;
  getRun?: ((runId: RunId) => RunViewHttpResponse | null) | undefined;
  executeAttentionAction?: ((
    runId: RunId,
    command: AttentionActionHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ) => Promise<AttentionActionHttpResponse>) | undefined;
}

export function registerRunRoutes(app: FastifyInstance, services: RunRoutesServices): void {
  app.post("/runs", async (request, reply) => {
    const parsed = StartRunHttpRequestSchema.safeParse(request.body);
    if (!parsed.success) return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
    const principal = requirePrincipal(request);
    const plan = services.projectForExecutionPlan(parsed.data.executionPlanId);
    if (plan === null || !principal.authorizedProjectIds.includes(plan.projectId)) return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    if (plan.executionPlanId !== parsed.data.executionPlanId) {
      return await reply
        .code(409)
        .send({ code: "EXECUTION_PLAN_SCOPE_MISMATCH" });
    }
    const existingRun = services.projectForRun(parsed.data.runId);
    if (
      existingRun !== null &&
      (existingRun.runId !== parsed.data.runId ||
        existingRun.projectId !== plan.projectId)
    ) {
      return await reply
        .code(409)
        .send({ code: "RUN_PROJECT_SCOPE_MISMATCH" });
    }
    return await services.startRun(parsed.data, { actorId: principal.principalId, correlationId: parsed.data.idempotencyKey });
  });

  if (services.getRun !== undefined) {
    const getRun = services.getRun;
    app.get("/api/v1/runs/:runId", async (request, reply) => {
      const params = RunIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return await reply.code(400).send({ code: "REQUEST_SCHEMA_INVALID" });
      }
      const principal = requirePrincipal(request);
      const scope = services.projectForRun(params.data.runId);
      if (scope === null) {
        return await reply.code(404).send({ code: "RUN_NOT_FOUND" });
      }
      if (!principal.authorizedProjectIds.includes(scope.projectId)) {
        return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
      }
      if (scope.runId !== params.data.runId) {
        return await reply
          .code(409)
          .send({ code: "RUN_PROJECT_SCOPE_MISMATCH" });
      }
      const view = getRun(params.data.runId);
      if (view === null) {
        return await reply.code(404).send({ code: "RUN_NOT_FOUND" });
      }
      const response = RunViewHttpResponseSchema.parse(view);
      if (response.runId !== params.data.runId) {
        throw new Error("RUN_RESPONSE_SCOPE_MISMATCH");
      }
      return response;
    });
  }

  if (services.executeAttentionAction !== undefined) {
    const executeAttentionAction = services.executeAttentionAction;
    app.post(
      "/api/v1/runs/:runId/attention-actions",
      async (request, reply) => {
        const params = RunIdParamsSchema.safeParse(request.params);
        const body = AttentionActionHttpRequestSchema.safeParse(request.body);
        if (!params.success || !body.success) {
          return await reply
            .code(400)
            .send({ code: "REQUEST_SCHEMA_INVALID" });
        }
        const principal = requirePrincipal(request);
        const run = services.projectForRun(params.data.runId);
        if (run === null) {
          return await reply.code(404).send({ code: "RUN_NOT_FOUND" });
        }
        if (!principal.authorizedProjectIds.includes(run.projectId)) {
          return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
        }
        if (run.runId !== params.data.runId) {
          return await reply
            .code(409)
            .send({ code: "RUN_PROJECT_SCOPE_MISMATCH" });
        }
        let rawResponse: AttentionActionHttpResponse;
        try {
          rawResponse = await executeAttentionAction(
            params.data.runId,
            body.data,
            {
              actorId: principal.principalId,
              correlationId: body.data.idempotencyKey,
            },
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          const conflictCodes = new Set([
            "ATTENTION_VERSION_CONFLICT",
            "ATTENTION_ATTEMPT_NOT_CURRENT",
            "ATTENTION_ACTION_DISABLED",
            "ATTENTION_EVIDENCE_SCOPE_MISMATCH",
            "ATTENTION_EVIDENCE_HASH_MISMATCH",
            "ATTENTION_INPUT_HASH_MISMATCH",
            "ATTENTION_CAPABILITY_RECEIPT_MISMATCH",
            "ATTENTION_IDEMPOTENCY_CONFLICT",
            "IDEMPOTENCY_KEY_REUSED",
            "EXPECTED_VERSION_CONFLICT",
            "RECOVERY_ATTEMPT_LIMIT_REACHED",
            "RUN_BUDGET_EXHAUSTED",
          ]);
          const safeConflictCode = code.startsWith(
              "EXPECTED_VERSION_CONFLICT",
            )
            ? "EXPECTED_VERSION_CONFLICT"
            : conflictCodes.has(code)
            ? code
            : null;
          if (safeConflictCode !== null) {
            return await reply.code(409).send({ code: safeConflictCode });
          }
          if (code === "ATTENTION_RUN_NOT_FOUND") {
            return await reply.code(404).send({ code: "RUN_NOT_FOUND" });
          }
          throw error;
        }
        const response = AttentionActionHttpResponseSchema.parse(rawResponse);
        if (
          response.runId !== params.data.runId
          || response.attemptId !== body.data.attemptId
          || response.action !== body.data.action
        ) {
          throw new Error("ATTENTION_ACTION_RESPONSE_SCOPE_MISMATCH");
        }
        return response;
      },
    );
  }
}
