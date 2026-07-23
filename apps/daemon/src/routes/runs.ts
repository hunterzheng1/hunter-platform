import { StartRunHttpRequestSchema, type StartRunHttpRequest } from "@hunter/api-contracts";
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
}
