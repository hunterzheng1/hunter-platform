import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  ControllerLeaseIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import {
  createExternalOperation,
  runtimeFactCanCompleteStep,
  type ExternalOperationHandler,
} from "@hunter/runtime-contracts";

export interface ExternalOperationContractResult {
  readonly deterministicReplay: boolean;
  readonly conflictingReuseRejected: boolean;
  readonly falseSuccessRejected: boolean;
  readonly proofScope: "contract_only" | "local_observation" | "human_receipt";
}

export async function verifyExternalOperationHandlerContract(
  createHandler: () => ExternalOperationHandler,
): Promise<ExternalOperationContractResult> {
  const handler = createHandler();
  const base = {
    schemaVersion: 1 as const,
    operationId: OperationIdSchema.parse("opn_00000001"),
    projectId: ProjectIdSchema.parse("prj_00000001"),
    runId: RunIdSchema.parse("run_00000001"),
    attemptId: AttemptIdSchema.parse("att_00000001"),
    operationVersion: 1 as const,
    operationType: "session.launch" as const,
    requestedCapabilities: ["launch", "structured_events"] as const,
  };
  const firstOperation = createExternalOperation({
    ...base,
    payload: {
      agentProfileId: AgentProfileIdSchema.parse("apr_00000001"),
      workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
    },
  });
  const firstReceipt = await handler.execute(firstOperation);
  const replayReceipt = await handler.execute(firstOperation);

  const conflictingOperation = createExternalOperation({
    ...base,
    payload: {
      agentProfileId: AgentProfileIdSchema.parse("apr_00000002"),
      workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
    },
  });
  let conflictingReuseRejected = false;
  try {
    await handler.execute(conflictingOperation);
  } catch (error: unknown) {
    conflictingReuseRejected =
      error instanceof Error &&
      error.message === "OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD";
  }

  const observationOperation = createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse("opn_00000002"),
    projectId: ProjectIdSchema.parse("prj_00000001"),
    runId: RunIdSchema.parse("run_00000001"),
    attemptId: AttemptIdSchema.parse("att_00000001"),
    operationVersion: 2,
    operationType: "session.observe",
    requestedCapabilities: ["observe"],
    payload: {
      nativeSessionId: NativeSessionIdSchema.parse("ses_00000001"),
      controllerLeaseId: ControllerLeaseIdSchema.parse("ctl_00000001"),
      controllerLeaseOwnerId: LeaseOwnerIdSchema.parse("own_00000001"),
      controllerLeaseGeneration: 1,
    },
  });
  const observationReceipt = await handler.execute(observationOperation);

  return {
    deterministicReplay: JSON.stringify(firstReceipt) === JSON.stringify(replayReceipt),
    conflictingReuseRejected,
    falseSuccessRejected: observationReceipt.facts.every(
      (fact) => !runtimeFactCanCompleteStep(fact),
    ),
    proofScope: firstReceipt.evidence.proofScope,
  };
}
