import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  CreateProjectHttpResponseSchema,
  ProjectDetailHttpResponseSchema,
  PublishChangeHttpResponseSchema,
  RequirementRevisionHttpResponseSchema,
  type CreateProjectHttpRequest,
  type CreateRequirementHttpRequest,
  type ApproveRequirementHttpRequest,
  type PublishChangeHttpRequest,
} from "@hunter/api-contracts";
import {
  AgentProfileIdSchema,
  DeviceBindingIdSchema,
  DeviceIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RouteIdSchema,
  StepIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  createChangeRevision,
  createProject,
  createRequirementRevision,
  createWorkflowRevision,
  type ChangeId,
  type ChangeRevisionId,
  type ExecutionPlanId,
  type ProjectId,
  type RequirementRevisionId,
} from "@hunter/domain";
import type { ActorContext } from "@hunter/storage";

import type { createApplicationComposition } from "./composition-root.js";

type CompositionServices = ReturnType<
  typeof createApplicationComposition
>["services"];

interface RequirementEventRow {
  readonly aggregate_version: number;
  readonly event_data: string;
}

function suffix(value: unknown): string {
  return canonicalSha256(value).slice(0, 24);
}

function projectDefaults(projectId: ProjectId) {
  const projectSuffix = suffix({ projectId, kind: "desktop-defaults" });
  return {
    repositoryId: RepositoryIdSchema.parse(`rep_${projectSuffix}`),
    deviceBindingId: DeviceBindingIdSchema.parse(`dev_${projectSuffix}`),
    deviceId: DeviceIdSchema.parse(`dvc_${projectSuffix}`),
    workflowId: WorkflowIdSchema.parse(`wfl_${projectSuffix}`),
    workflowRevisionId: WorkflowRevisionIdSchema.parse(
      `wfr_${projectSuffix}`,
    ),
    agentProfileId: AgentProfileIdSchema.parse(`apr_${projectSuffix}`),
    stepId: StepIdSchema.parse(`stp_${projectSuffix}`),
  };
}

function defaultWorkflow(projectId: ProjectId, publishedAt: string) {
  const ids = projectDefaults(projectId);
  const route = (
    label: string,
    outcome: "passed" | "failed" | "canceled" | "timed_out",
  ) => ({
    routeId: RouteIdSchema.parse(
      `rte_${suffix({ projectId, label })}`,
    ),
    fromStepId: ids.stepId,
    outcome,
    priority: 0,
    toStepId: null,
  });
  return createWorkflowRevision({
    workflowId: ids.workflowId,
    workflowRevisionId: ids.workflowRevisionId,
    title: "Hunter provider-neutral delivery",
    status: "published",
    entryStepId: ids.stepId,
    steps: [{
      stepId: ids.stepId,
      kind: "agent",
      executor: {
        kind: "runtime_agent",
        selector: "capability_match",
      },
      agentProfileSelector: {
        strategy: "fixed",
        agentProfileIds: [ids.agentProfileId],
      },
      inputContract: { schemaId: "hunter.step.input", version: 1 },
      outputContract: { schemaId: "hunter.step.output", version: 1 },
      requiredCapabilities: ["launch", "observe"],
      permissionPolicy: {
        decision: "allow",
        permissions: ["repository.read", "repository.write"],
      },
      verifier: {
        kind: "automated",
        verifierId: "hunter.default.verifier",
        outputContract: { schemaId: "hunter.step.output", version: 1 },
      },
      retryPolicy: {
        maxAttempts: 2,
        retryableErrorClasses: ["transient"],
        backoff: {
          kind: "exponential",
          initialDelayMs: 1_000,
          maxDelayMs: 30_000,
          multiplier: 2,
        },
        jitter: "none",
        waitingBudgetCost: 1,
      },
      timeoutPolicy: { timeoutMs: 30 * 60_000, onTimeout: "failed" },
      budgetCost: { units: 1, elapsedMs: 30 * 60_000, cost: 0 },
      sessionPolicy: "new",
      workspacePolicy: {
        mode: "write",
        isolation: "worktree",
        reuse: false,
      },
    }],
    routes: [
      route("passed", "passed"),
      route("failed", "failed"),
      route("canceled", "canceled"),
      route("timed-out", "timed_out"),
    ],
    loops: [],
    publishedAt,
  });
}

export function createDesktopDefinitionServices(input: {
  readonly database: DatabaseSync;
  readonly services: CompositionServices;
  readonly dataDirectory: string;
  readonly now?: (() => Date) | undefined;
}) {
  const now = input.now ?? (() => new Date());

  const requirementView = (
    revisionId: RequirementRevisionId,
  ): ReturnType<typeof RequirementRevisionHttpResponseSchema.parse> | null => {
    const rows = input.database.prepare(
      `SELECT aggregate_version, event_data
         FROM events
        WHERE event_type IN (
          'RequirementRevisionDrafted',
          'RequirementRevisionApproved'
        )
        ORDER BY position DESC`,
    ).all() as unknown as RequirementEventRow[];
    for (const row of rows) {
      const event = JSON.parse(row.event_data) as {
        readonly requirementRevision?: unknown;
      };
      try {
        const revision = createRequirementRevision(
          event.requirementRevision,
        );
        if (revision.revisionId !== revisionId) continue;
        return RequirementRevisionHttpResponseSchema.parse({
          ...revision,
          aggregateVersion: row.aggregate_version,
        });
      } catch {
        continue;
      }
    }
    return null;
  };

  const projectRequirementViews = (projectId: ProjectId) => {
    const rows = input.database.prepare(
      `SELECT aggregate_version, event_data
         FROM events
        WHERE project_id = ?
          AND event_type IN (
            'RequirementRevisionDrafted',
            'RequirementRevisionApproved'
          )
        ORDER BY position DESC`,
    ).all(projectId) as unknown as RequirementEventRow[];
    const views = new Map<
      RequirementRevisionId,
      ReturnType<typeof RequirementRevisionHttpResponseSchema.parse>
    >();
    for (const row of rows) {
      const event = JSON.parse(row.event_data) as {
        readonly requirementRevision?: unknown;
      };
      try {
        const revision = createRequirementRevision(
          event.requirementRevision,
        );
        if (
          revision.projectId !== projectId
          || views.has(revision.revisionId)
        ) {
          continue;
        }
        views.set(
          revision.revisionId,
          RequirementRevisionHttpResponseSchema.parse({
            ...revision,
            aggregateVersion: row.aggregate_version,
          }),
        );
      } catch {
        continue;
      }
    }
    return [...views.values()].sort((left, right) =>
      left.revisionId.localeCompare(right.revisionId)
    );
  };

  const listProjectIds = (): readonly ProjectId[] => {
    const rows = input.database.prepare(
      `SELECT event_data
         FROM events
        WHERE event_type = 'ProjectCreated'
        ORDER BY position`,
    ).all() as unknown as Array<{ readonly event_data: string }>;
    return ProjectIdSchema.array().parse(rows.map(({ event_data }) => {
      const event = JSON.parse(event_data) as { readonly project?: unknown };
      return createProject(event.project).projectId;
    }));
  };

  const createProjectCommand = (
    command: CreateProjectHttpRequest,
    actor: ActorContext,
  ) => {
    const ids = projectDefaults(command.projectId);
    const workspacePath = join(
      input.dataDirectory,
      "project-workspaces",
      command.projectId,
    );
    mkdirSync(workspacePath, { recursive: true });
    const project = createProject({
      projectId: command.projectId,
      name: command.name,
      repositoryBindings: [{
        repositoryId: ids.repositoryId,
        role: "primary",
      }],
      deviceBindings: [{
        deviceBindingId: ids.deviceBindingId,
        deviceId: ids.deviceId,
        repositoryId: ids.repositoryId,
        localPath: workspacePath,
        availability: "unknown",
      }],
    });
    const occurredAt = now().toISOString();
    const workflow = defaultWorkflow(project.projectId, occurredAt);
    const response = CreateProjectHttpResponseSchema.parse({
      projectId: project.projectId,
      name: project.name,
      authorization: "host_session_reissue_required",
    });
    const eventSuffix = suffix(command.idempotencyKey);
    const receipt = input.services.journal.commitCommand({
      commandId: `desktop-project:${command.idempotencyKey}`,
      requestFingerprint: canonicalSha256(command),
      projectId: project.projectId,
      aggregateId: `project:${project.projectId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [
        {
          eventId: `evt_desktop_project_${eventSuffix}`,
          eventType: "ProjectCreated",
          eventData: { projectId: project.projectId, project },
          schemaVersion: 1,
          occurredAt,
        },
        {
          eventId: `evt_desktop_workflow_${eventSuffix}`,
          eventType: "WorkflowRevisionPublished",
          eventData: {
            workflowRevisionId: workflow.workflowRevisionId,
            workflowRevision: workflow,
          },
          schemaVersion: 1,
          occurredAt,
        },
        {
          eventId: `evt_desktop_profile_${eventSuffix}`,
          eventType: "AgentProfileDefined",
          eventData: {
            agentProfileId: ids.agentProfileId,
            agentProfile: {
              agentProfileId: ids.agentProfileId,
              projectId: project.projectId,
              status: "active",
            },
          },
          schemaVersion: 1,
          occurredAt,
        },
        {
          eventId: `evt_desktop_policy_${eventSuffix}`,
          eventType: "ProjectRunPolicyDefined",
          eventData: {
            projectId: project.projectId,
            policySnapshot: {
              snapshotHash: canonicalSha256({
                projectId: project.projectId,
                purpose: "desktop-default-policy",
              }),
              policyVersion: 1,
            },
            budgetLimit: {
              maxAttempts: 10,
              maxElapsedMs: 8 * 60 * 60_000,
              maxCost: 100,
              maxTokens: 1_000_000,
              maxLoopIterations: 10,
            },
          },
          schemaVersion: 1,
          occurredAt,
        },
      ],
      operations: [],
      response,
    });
    return CreateProjectHttpResponseSchema.parse(receipt.response);
  };

  const createRequirement = (
    projectId: ProjectId,
    command: CreateRequirementHttpRequest,
    actor: ActorContext,
  ) => {
    if (input.services.repositories.getProject(projectId) === null) {
      throw new Error("PROJECT_NOT_FOUND");
    }
    const revision = createRequirementRevision({
      requirementId: command.requirementId,
      revisionId: command.revisionId,
      projectId,
      title: command.title,
      body: command.body,
      acceptanceCriteria: command.acceptanceCriteria,
      constraints: command.constraints,
      status: "draft",
    });
    const response = RequirementRevisionHttpResponseSchema.parse({
      ...revision,
      aggregateVersion: command.expectedVersion + 1,
    });
    const receipt = input.services.journal.commitCommand({
      commandId: `desktop-requirement-draft:${command.idempotencyKey}`,
      requestFingerprint: canonicalSha256({ projectId, command }),
      projectId,
      aggregateId: `requirement:${revision.revisionId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [{
        eventId: `evt_desktop_requirement_draft_${suffix(command.idempotencyKey)}`,
        eventType: "RequirementRevisionDrafted",
        eventData: {
          requirementRevisionId: revision.revisionId,
          requirementRevision: revision,
        },
        schemaVersion: 1,
        occurredAt: now().toISOString(),
      }],
      operations: [],
      response,
    });
    return RequirementRevisionHttpResponseSchema.parse(receipt.response);
  };

  const approveRequirement = (
    projectId: ProjectId,
    revisionId: RequirementRevisionId,
    command: ApproveRequirementHttpRequest,
    actor: ActorContext,
  ) => {
    const draft = requirementView(revisionId);
    if (
      draft === null
      || draft.projectId !== projectId
      || !["draft", "in_review"].includes(draft.status)
    ) {
      throw new Error("REQUIREMENT_REVISION_NOT_APPROVABLE");
    }
    const approved = createRequirementRevision({
      requirementId: draft.requirementId,
      revisionId: draft.revisionId,
      projectId: draft.projectId,
      title: draft.title,
      body: draft.body,
      acceptanceCriteria: draft.acceptanceCriteria,
      constraints: draft.constraints,
      status: "approved",
      approvedAt: now().toISOString(),
    });
    const response = RequirementRevisionHttpResponseSchema.parse({
      ...approved,
      aggregateVersion: command.expectedVersion + 1,
    });
    if (approved.approvedAt === undefined) {
      throw new Error("APPROVED_REQUIREMENT_TIMESTAMP_MISSING");
    }
    const receipt = input.services.journal.commitCommand({
      commandId: `desktop-requirement-approve:${command.idempotencyKey}`,
      requestFingerprint: canonicalSha256({
        projectId,
        revisionId,
        command,
      }),
      projectId,
      aggregateId: `requirement:${revisionId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [{
        eventId: `evt_desktop_requirement_approved_${suffix(command.idempotencyKey)}`,
        eventType: "RequirementRevisionApproved",
        eventData: {
          requirementRevisionId: approved.revisionId,
          requirementRevision: approved,
        },
        schemaVersion: 1,
        occurredAt: approved.approvedAt,
      }],
      operations: [],
      response,
    });
    return RequirementRevisionHttpResponseSchema.parse(receipt.response);
  };

  const publishChange = (
    projectId: ProjectId,
    command: PublishChangeHttpRequest,
    actor: ActorContext,
  ) => {
    const draft = createChangeRevision({
      changeId: command.changeId,
      revisionId: command.changeRevisionId,
      projectId,
      title: command.title,
      goal: command.goal,
      nonGoals: command.nonGoals,
      requirementRevisionIds: command.requirementRevisionIds,
      repositoryIds: command.repositoryIds,
      acceptanceCriteria: command.acceptanceCriteria,
      constraints: command.constraints,
      risks: command.risks,
      dependsOnChangeRevisionIds: command.dependsOnChangeRevisionIds,
      status: "draft",
    });
    input.services.journal.commitCommand({
      commandId: `desktop-change-draft:${command.idempotencyKey}`,
      requestFingerprint: canonicalSha256({ projectId, command }),
      projectId,
      aggregateId: `change-draft:${draft.revisionId}`,
      expectedVersion: 0,
      actor,
      events: [{
        eventId: `evt_desktop_change_draft_${suffix(command.idempotencyKey)}`,
        eventType: "ChangeRevisionDefined",
        eventData: {
          changeRevisionId: draft.revisionId,
          changeRevision: draft,
        },
        schemaVersion: 1,
        occurredAt: now().toISOString(),
      }],
      operations: [],
      response: { changeRevisionId: draft.revisionId },
    });
    const published = input.services.publishChange.execute({
      changeRevisionId: command.changeRevisionId,
      executionPlanId: command.executionPlanId,
      tasks: command.tasks,
      expectedVersion: command.expectedVersion,
      idempotencyKey: command.idempotencyKey,
    }, actor);
    return PublishChangeHttpResponseSchema.parse({
      projectId,
      changeId: published.changeRevision.changeId,
      changeRevisionId: published.changeRevision.revisionId,
      executionPlanId: published.executionPlan.executionPlanId,
      status: "published",
      taskGraphFingerprint: published.executionPlan.taskGraphFingerprint,
    });
  };

  return {
    listProjectIds,
    createProject: createProjectCommand,
    getProject: (projectId: ProjectId) => {
      const project = input.services.repositories.getProject(projectId);
      if (project === null) return null;
      const defaults = projectDefaults(projectId);
      return ProjectDetailHttpResponseSchema.parse({
        projectId: project.projectId,
        name: project.name,
        requirements: projectRequirementViews(projectId),
        planningDefaults: {
          repositoryIds: project.repositoryBindings.map(
            ({ repositoryId }) => repositoryId,
          ),
          workflowRevisionId: defaults.workflowRevisionId,
          defaultAgentProfileId: defaults.agentProfileId,
          sessionPolicy: "new",
          workspacePolicy: {
            mode: "write",
            isolation: "worktree",
            reuse: false,
          },
        },
      });
    },
    requirements: {
      createRequirement,
      getRequirementRevision: (revisionId: RequirementRevisionId) => {
        const revision = requirementView(revisionId);
        return revision === null
          ? null
          : {
              projectId: revision.projectId,
              revisionId: revision.revisionId,
              status: revision.status,
            };
      },
      approveRequirement,
    },
    changes: {
      getChangeExecutionPlanRelation: (
        changeId: ChangeId,
        changeRevisionId: ChangeRevisionId,
        executionPlanId: ExecutionPlanId,
      ) => {
        const change = input.services.repositories.getChangeRevision(
          changeRevisionId,
        );
        const plan = input.services.repositories.getExecutionPlan(
          executionPlanId,
        );
        if (change === null && plan === null) return null;
        return {
          projectId: change?.projectId ?? plan!.projectId,
          changeId: change?.changeId ?? changeId,
          changeRevisionId:
            change?.revisionId ?? plan!.changeRevisionId,
          executionPlanId: plan?.executionPlanId ?? executionPlanId,
        };
      },
      getRequirementRevision: (revisionId: RequirementRevisionId) => {
        const revision = requirementView(revisionId);
        return revision === null
          ? null
          : {
              projectId: revision.projectId,
              revisionId: revision.revisionId,
              status: revision.status,
            };
      },
      publishChange,
    },
  };
}
