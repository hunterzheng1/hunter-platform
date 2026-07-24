import type { StartRunHttpRequest } from "@hunter/api-contracts";
import type { ProjectId, RunId } from "@hunter/domain";

export interface CanonicalStartRunPort {
  execute(
    command: StartRunHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ): unknown;
}

export interface RunBindingReadPort {
  loadRun(runId: RunId): {
    readonly binding: {
      readonly runId: RunId;
      readonly projectId: ProjectId;
      readonly executionPlanId: string;
      readonly workflowRevisionId: string;
    };
  } | null;
}

/**
 * Route-facing StartRun boundary. A successful response is accepted only when
 * the canonical Flow store contains the frozen binding committed by the
 * application StartRun service.
 */
export class ApplicationStartRunService {
  public constructor(
    private readonly canonical: CanonicalStartRunPort,
    private readonly runs: RunBindingReadPort,
  ) {}

  public async execute(
    command: StartRunHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ): Promise<unknown> {
    const receipt = await this.canonical.execute(command, actor);
    const run = this.runs.loadRun(command.runId);
    if (
      run === null ||
      run.binding.runId !== command.runId ||
      run.binding.executionPlanId !== command.executionPlanId ||
      run.binding.workflowRevisionId !== command.workflowRevisionId
    ) {
      throw new Error("START_RUN_FLOW_COMMIT_NOT_PROVEN");
    }
    return receipt;
  }
}
