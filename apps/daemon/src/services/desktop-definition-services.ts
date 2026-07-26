import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  AppendProjectRepositoryHttpResponseSchema,
  ConfirmProjectWorkflowMigrationHttpResponseSchema,
  CreateProjectHttpResponseSchema,
  ProjectDetailHttpResponseSchema,
  ProjectWorkflowBindingHttpResponseSchema,
  ProjectWorkflowMigrationPreviewHttpResponseSchema,
  PublishChangeHttpResponseSchema,
  RequirementRevisionHttpResponseSchema,
  type AppendProjectRepositoryHttpRequest,
  type ConfirmProjectWorkflowMigrationHttpRequest,
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
  appendRepositoryBinding,
  canonicalSha256,
  createChangeRevision,
  createProject,
  createProjectWorkflowBinding,
  createRequirementRevision,
  createWorkflowRevision,
  migrateProjectWorkflowBinding,
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

  const repositoryBindingVersion = (projectId: ProjectId): number => {
    const row = input.database.prepare(
      `SELECT COALESCE(MAX(aggregate_version), 0) AS version
         FROM events
        WHERE aggregate_id = ?`,
    ).get(`project-repositories:${projectId}`) as {
      readonly version: number;
    };
    return row.version;
  };

  const projectWorkflowBinding = (projectId: ProjectId) => {
    const initialRow = input.database.prepare(
      `SELECT event_data
         FROM events
        WHERE aggregate_id = ?
          AND event_type = 'ProjectCreated'
        ORDER BY aggregate_version
        LIMIT 1`,
    ).get(`project:${projectId}`) as {
      readonly event_data: string;
    } | undefined;
    if (initialRow === undefined) throw new Error("PROJECT_NOT_FOUND");
    const initialEvent = JSON.parse(initialRow.event_data) as {
      readonly projectWorkflowBinding?: unknown;
    };
    let binding = initialEvent.projectWorkflowBinding === undefined
      ? createProjectWorkflowBinding({
          projectId,
          currentWorkflowRevisionId:
            projectDefaults(projectId).workflowRevisionId,
          version: 0,
        })
      : createProjectWorkflowBinding(
          initialEvent.projectWorkflowBinding,
        );
    const rows = input.database.prepare(
      `SELECT aggregate_version, event_data
         FROM events
        WHERE aggregate_id = ?
          AND event_type = 'ProjectWorkflowBindingMigrated'
        ORDER BY aggregate_version`,
    ).all(`project-workflow-binding:${projectId}`) as unknown as Array<{
      readonly aggregate_version: number;
      readonly event_data: string;
    }>;
    for (const row of rows) {
      const event = JSON.parse(row.event_data) as {
        readonly projectId?: unknown;
        readonly fromWorkflowRevisionId?: unknown;
        readonly toWorkflowRevisionId?: unknown;
      };
      if (
        event.projectId !== projectId
        || row.aggregate_version !== binding.version + 1
      ) {
        throw new Error("PROJECT_WORKFLOW_BINDING_EVENT_INVALID");
      }
      binding = migrateProjectWorkflowBinding(binding, {
        fromWorkflowRevisionId: event.fromWorkflowRevisionId,
        toWorkflowRevisionId: event.toWorkflowRevisionId,
        expectedVersion: binding.version,
      });
    }
    return binding;
  };

  const getProjectWorkflowBinding = (projectId: ProjectId) => {
    if (input.services.repositories.getProject(projectId) === null) {
      throw new Error("PROJECT_NOT_FOUND");
    }
    const binding = projectWorkflowBinding(projectId);
    return ProjectWorkflowBindingHttpResponseSchema.parse({
      projectId,
      currentWorkflowRevisionId: binding.currentWorkflowRevisionId,
      workflowBindingVersion: binding.version,
    });
  };

  const previewProjectWorkflowMigration = (
    projectId: ProjectId,
    request: { readonly toWorkflowRevisionId: string },
  ) => {
    const binding = getProjectWorkflowBinding(projectId);
    const from = input.services.repositories.getWorkflowRevision(
      binding.currentWorkflowRevisionId,
    );
    const to = input.services.repositories.getWorkflowRevision(
      request.toWorkflowRevisionId,
    );
    if (from === null || to === null) {
      throw new Error("WORKFLOW_MIGRATION_REVISION_NOT_FOUND");
    }
    if (from.workflowId !== to.workflowId) {
      throw new Error("WORKFLOW_MIGRATION_TEMPLATE_MISMATCH");
    }
    if (from.workflowRevisionId === to.workflowRevisionId) {
      throw new Error("PROJECT_WORKFLOW_BINDING_NO_CHANGE");
    }
    const fromSteps = new Map(
      from.steps.map((step) => [step.stepId, step]),
    );
    const toSteps = new Map(to.steps.map((step) => [step.stepId, step]));
    const addedStepIds = [...toSteps.keys()]
      .filter((stepId) => !fromSteps.has(stepId))
      .sort();
    const removedStepIds = [...fromSteps.keys()]
      .filter((stepId) => !toSteps.has(stepId))
      .sort();
    const changedStepIds = [...fromSteps.keys()]
      .filter((stepId) => {
        const candidate = toSteps.get(stepId);
        return candidate !== undefined
          && canonicalSha256(fromSteps.get(stepId))
            !== canonicalSha256(candidate);
      })
      .sort();
    const entryStepChanged = from.entryStepId !== to.entryStepId;
    const routesChanged =
      canonicalSha256(from.routes) !== canonicalSha256(to.routes);
    const loopsChanged =
      canonicalSha256(from.loops) !== canonicalSha256(to.loops);
    const compatibilityReasonCodes = [
      ...(entryStepChanged ? ["entry_step_changed" as const] : []),
      ...(addedStepIds.length > 0 ? ["steps_added" as const] : []),
      ...(removedStepIds.length > 0 ? ["steps_removed" as const] : []),
      ...(changedStepIds.length > 0 ? ["steps_changed" as const] : []),
      ...(routesChanged ? ["routes_changed" as const] : []),
      ...(loopsChanged ? ["loops_changed" as const] : []),
    ];
    const preview = {
      projectId,
      workflowBindingVersion: binding.workflowBindingVersion,
      fromWorkflowRevisionId: from.workflowRevisionId,
      toWorkflowRevisionId: to.workflowRevisionId,
      fromWorkflowFingerprint: from.workflowFingerprint,
      toWorkflowFingerprint: to.workflowFingerprint,
      changes: {
        titleChanged: from.title !== to.title,
        entryStepChanged,
        addedStepIds,
        removedStepIds,
        changedStepIds,
        routesChanged,
        loopsChanged,
        routeCountChanged: from.routes.length !== to.routes.length,
        loopCountChanged: from.loops.length !== to.loops.length,
      },
      compatibility: compatibilityReasonCodes.length === 0
        ? {
            status: "no_structural_change" as const,
            reasonCodes: [] as const,
          }
        : {
            status: "review_required" as const,
            reasonCodes: compatibilityReasonCodes,
          },
    };
    return ProjectWorkflowMigrationPreviewHttpResponseSchema.parse({
      ...preview,
      previewFingerprint: canonicalSha256(preview),
    });
  };

  const confirmProjectWorkflowMigration = (
    projectId: ProjectId,
    command: ConfirmProjectWorkflowMigrationHttpRequest,
    actor: ActorContext,
  ) => {
    const commandId =
      `desktop-project-workflow:${projectId}:${command.idempotencyKey}`;
    const requestFingerprint = canonicalSha256({ projectId, command });
    const existing = input.database.prepare(
      `SELECT request_fingerprint, response_json
         FROM command_receipts
        WHERE command_id = ?`,
    ).get(commandId) as {
      readonly request_fingerprint: string;
      readonly response_json: string;
    } | undefined;
    if (existing !== undefined) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return ConfirmProjectWorkflowMigrationHttpResponseSchema.parse(
        JSON.parse(existing.response_json) as unknown,
      );
    }
    const preview = previewProjectWorkflowMigration(projectId, {
      toWorkflowRevisionId: command.toWorkflowRevisionId,
    });
    if (
      preview.workflowBindingVersion !== command.expectedVersion
      || preview.fromWorkflowRevisionId
        !== command.fromWorkflowRevisionId
      || preview.toWorkflowRevisionId !== command.toWorkflowRevisionId
      || preview.previewFingerprint !== command.previewFingerprint
    ) {
      throw new Error("WORKFLOW_MIGRATION_PREVIEW_STALE");
    }
    const current = projectWorkflowBinding(projectId);
    const migrated = migrateProjectWorkflowBinding(current, {
      fromWorkflowRevisionId: command.fromWorkflowRevisionId,
      toWorkflowRevisionId: command.toWorkflowRevisionId,
      expectedVersion: command.expectedVersion,
    });
    const response =
      ConfirmProjectWorkflowMigrationHttpResponseSchema.parse({
        projectId,
        previousWorkflowRevisionId: command.fromWorkflowRevisionId,
        currentWorkflowRevisionId: migrated.currentWorkflowRevisionId,
        workflowBindingVersion: migrated.version,
        status: "migrated",
      });
    const receipt = input.services.journal.commitCommand({
      commandId,
      requestFingerprint,
      projectId,
      aggregateId: `project-workflow-binding:${projectId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [{
        eventId:
          `evt_desktop_workflow_binding_${suffix({ projectId, idempotencyKey: command.idempotencyKey })}`,
        eventType: "ProjectWorkflowBindingMigrated",
        eventData: {
          projectId,
          fromWorkflowRevisionId: command.fromWorkflowRevisionId,
          toWorkflowRevisionId: command.toWorkflowRevisionId,
          previewFingerprint: command.previewFingerprint,
        },
        schemaVersion: 1,
        occurredAt: now().toISOString(),
      }],
      operations: [],
      response,
    });
    return ConfirmProjectWorkflowMigrationHttpResponseSchema.parse(
      receipt.response,
    );
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
    const workflowBinding = createProjectWorkflowBinding({
      projectId: project.projectId,
      currentWorkflowRevisionId: workflow.workflowRevisionId,
      version: 0,
    });
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
          eventData: {
            projectId: project.projectId,
            project,
            projectWorkflowBinding: workflowBinding,
          },
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

  const appendProjectRepository = (
    projectId: ProjectId,
    command: AppendProjectRepositoryHttpRequest,
    actor: ActorContext,
  ) => {
    const commandId =
      `desktop-project-repository:${projectId}:${command.idempotencyKey}`;
    const requestFingerprint = canonicalSha256({ projectId, command });
    const existing = input.database.prepare(
      `SELECT request_fingerprint, response_json
         FROM command_receipts
        WHERE command_id = ?`,
    ).get(commandId) as {
      readonly request_fingerprint: string;
      readonly response_json: string;
    } | undefined;
    if (existing !== undefined) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return AppendProjectRepositoryHttpResponseSchema.parse(
        JSON.parse(existing.response_json) as unknown,
      );
    }
    const project = input.services.repositories.getProject(projectId);
    if (project === null) throw new Error("PROJECT_NOT_FOUND");
    const currentVersion = repositoryBindingVersion(projectId);
    if (currentVersion !== command.expectedVersion) {
      throw new Error(
        `EXPECTED_VERSION_CONFLICT expected=${command.expectedVersion} actual=${currentVersion}`,
      );
    }
    const bindingSuffix = suffix({
      projectId,
      repositoryId: command.repositoryId,
      kind: "desktop-repository-binding",
    });
    const workspacePath = join(
      input.dataDirectory,
      "project-workspaces",
      projectId,
      command.repositoryId,
    );
    const repositoryBinding = {
      repositoryId: command.repositoryId,
      role: "secondary" as const,
    };
    const deviceBinding = {
      deviceBindingId: DeviceBindingIdSchema.parse(`dev_${bindingSuffix}`),
      deviceId: projectDefaults(projectId).deviceId,
      repositoryId: command.repositoryId,
      localPath: workspacePath,
      availability: "unknown" as const,
    };
    appendRepositoryBinding(project, {
      repositoryBinding,
      deviceBinding,
    });
    mkdirSync(workspacePath, { recursive: true });
    const response = AppendProjectRepositoryHttpResponseSchema.parse({
      projectId,
      repositoryBindingVersion: command.expectedVersion + 1,
      repositoryBinding,
    });
    const receipt = input.services.journal.commitCommand({
      commandId,
      requestFingerprint,
      projectId,
      aggregateId: `project-repositories:${projectId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [{
        eventId:
          `evt_desktop_repository_${suffix({ projectId, idempotencyKey: command.idempotencyKey })}`,
        eventType: "RepositoryBound",
        eventData: {
          projectId,
          repositoryBinding,
          deviceBinding,
        },
        schemaVersion: 1,
        occurredAt: now().toISOString(),
      }],
      operations: [],
      response,
    });
    return AppendProjectRepositoryHttpResponseSchema.parse(receipt.response);
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
    const workflowBinding = projectWorkflowBinding(projectId);
    if (
      command.tasks.some(
        ({ workflowRevisionId }) =>
          workflowRevisionId
          !== workflowBinding.currentWorkflowRevisionId,
      )
    ) {
      throw new Error("PROJECT_WORKFLOW_BINDING_MISMATCH");
    }
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
      rootWorkflowRevisionId:
        workflowBinding.currentWorkflowRevisionId,
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
    appendProjectRepository,
    getProjectWorkflowBinding,
    previewProjectWorkflowMigration,
    confirmProjectWorkflowMigration,
    getProject: (projectId: ProjectId) => {
      const project = input.services.repositories.getProject(projectId);
      if (project === null) return null;
      const defaults = projectDefaults(projectId);
      const workflowBinding = projectWorkflowBinding(projectId);
      return ProjectDetailHttpResponseSchema.parse({
        projectId: project.projectId,
        name: project.name,
        requirements: projectRequirementViews(projectId),
        repositoryBindingVersion: repositoryBindingVersion(projectId),
        repositoryBindings: project.repositoryBindings,
        planningDefaults: {
          repositoryIds: project.repositoryBindings.map(
            ({ repositoryId }) => repositoryId,
          ),
          workflowRevisionId:
            workflowBinding.currentWorkflowRevisionId,
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
