import {
  MobileRunProjectionSchema,
  type MobileCommandEnvelope,
  type MobileRunProjection,
} from "@hunter/device-gateway";
import {
  canonicalSha256,
  type Project,
  type ProjectId,
  type WorkflowRevision,
} from "@hunter/domain";
import {
  deriveHumanGateId,
  type WorkflowRunState,
} from "@hunter/flow-engine";

export interface MobileProjectionFlowStore {
  allRuns(): readonly WorkflowRunState[];
}

export interface MobileProjectionRepositories {
  getProject(projectId: ProjectId): Readonly<Pick<Project, "projectId" | "name">> | null;
  getWorkflowRevision(workflowRevisionId: string): Readonly<WorkflowRevision> | null;
}

export interface MobileProjectionProvider {
  list(authorizedProjectIds: readonly ProjectId[]): readonly MobileRunProjection[];
}

function idempotencyKey(
  run: WorkflowRunState,
  action: MobileCommandEnvelope["action"],
  target: string,
): string {
  return `mobile-${canonicalSha256({
    projectId: run.binding.projectId,
    runId: run.binding.runId,
    version: run.version,
    action,
    target,
  }).slice(0, 32)}`;
}

function commandsFor(
  run: WorkflowRunState,
  humanGate: boolean,
): readonly MobileCommandEnvelope[] {
  const step = [...run.steps].reverse().find(({ conclusion }) => conclusion === "active");
  if (step === undefined) return [];
  const common = {
    projectId: run.binding.projectId,
    runId: run.binding.runId,
    expectedVersion: run.version,
  };
  if (
    humanGate
    && step.executionStatus === "returned"
    && step.verificationStatus === "pending"
  ) {
    const gateId = deriveHumanGateId(run.binding.runId, step.stepRunId);
    return [
      {
        ...common,
        gateId,
        idempotencyKey: idempotencyKey(run, "approve_gate", gateId),
        action: "approve_gate",
        payload: {},
      },
      {
        ...common,
        gateId,
        idempotencyKey: idempotencyKey(run, "reject_gate", gateId),
        action: "reject_gate",
        payload: {},
      },
    ];
  }
  const controls: MobileCommandEnvelope[] = [];
  if (run.status === "paused") {
    controls.push({
      ...common,
      stepRunId: step.stepRunId,
      idempotencyKey: idempotencyKey(run, "resume_run", step.stepRunId),
      action: "resume_run",
      payload: {},
    });
  } else {
    controls.push({
      ...common,
      stepRunId: step.stepRunId,
      idempotencyKey: idempotencyKey(run, "pause_run", step.stepRunId),
      action: "pause_run",
      payload: {},
    });
  }
  controls.push({
    ...common,
    stepRunId: step.stepRunId,
    idempotencyKey: idempotencyKey(run, "terminate_run", step.stepRunId),
    action: "terminate_run",
    payload: {},
  });
  return controls;
}

export function createMobileProjectionProvider(input: {
  readonly flowStore: MobileProjectionFlowStore;
  readonly repositories: MobileProjectionRepositories;
}): MobileProjectionProvider {
  return {
    list(authorizedProjectIds) {
      const allowed = new Set<ProjectId>(authorizedProjectIds);
      return input.flowStore
        .allRuns()
        .filter(({ binding }) => allowed.has(binding.projectId))
        .filter(({ status }) => !["succeeded", "failed", "canceled"].includes(status))
        .sort((left, right) => left.binding.runId.localeCompare(right.binding.runId))
        .flatMap((run) => {
          const project = input.repositories.getProject(run.binding.projectId);
          const workflow = input.repositories.getWorkflowRevision(
            run.binding.workflowRevisionId,
          );
          const step = [...run.steps]
            .reverse()
            .find(({ conclusion }) => conclusion === "active");
          const definition = workflow?.steps.find(({ stepId }) => stepId === step?.stepId);
          if (project === null || workflow === null || step === undefined || definition === undefined) {
            return [];
          }
          return [MobileRunProjectionSchema.parse({
            projectId: run.binding.projectId,
            runId: run.binding.runId,
            projectName: project.name,
            currentStep: `${definition.kind}:${definition.executor.selector}`,
            attention: run.status === "waiting_approval"
              ? "Approval required"
              : run.status === "needs_attention"
                ? "Run needs attention"
                : `Run is ${run.status}`,
            connection: "online",
            commands: commandsFor(run, definition.verifier.kind === "human_receipt"),
          })];
        });
    },
  };
}
