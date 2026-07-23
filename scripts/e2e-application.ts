import type { DatabaseSync } from "node:sqlite";

import type {
  CreateProjectHttpRequest,
  CreateRequirementHttpRequest,
  PublishChangeHttpRequest,
  RequirementRevisionHttpResponse,
} from "@hunter/api-contracts";
import {
  AgentProfileIdSchema,
  DeviceBindingIdSchema,
  DeviceIdSchema,
  RepositoryIdSchema,
  RouteIdSchema,
  StepIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  createChangeRevision,
  createProject,
  createRequirementRevision,
  createWorkflowRevision,
  type ProjectId,
  type RequirementRevisionId,
} from "@hunter/domain";
import { buildApp } from "../apps/daemon/src/app.js";
import { createSqliteApplicationServices } from "../apps/daemon/src/services/sqlite-application-services.js";
import type { VerticalSliceFixture } from "../e2e/fixtures/fake-runtime-scenario.js";

const FIXED_TIME = "2026-07-23T00:00:00.000Z";
const repositoryId = RepositoryIdSchema.parse("rep_e2econtract01");
const workflowRevisionId =
  WorkflowRevisionIdSchema.parse("wfr_e2econtract01");
const agentProfileId = AgentProfileIdSchema.parse("apr_e2econtract01");
const stepId = StepIdSchema.parse("stp_e2econtract01");

// Task 13A presentation-only state: the approved revision is canonical in the
// SQLite ledger; Task 19 replaces this transient draft/view shell with the full
// ApplicationServices composition before the E2E story may become GREEN.
type StoredRequirementView = RequirementRevisionHttpResponse;

export class RunCompositionNotWiredError extends Error {
  public constructor(
    public readonly positions: {
      readonly ProjectCreated: number;
      readonly RequirementRevisionApproved: number;
    },
  ) {
    super("RUN_COMPOSITION_NOT_WIRED");
  }
}

function e2eWorkflow() {
  return createWorkflowRevision({
    workflowRevisionId,
    title: "E2E contract workflow",
    status: "published",
    entryStepId: stepId,
    steps: [
      {
        stepId,
        kind: "agent",
        executor: { kind: "runtime_agent", selector: "capability_match" },
        agentProfileSelector: {
          strategy: "fixed",
          agentProfileIds: [agentProfileId],
        },
        inputContract: { schemaId: "hunter.e2e.input", version: 1 },
        outputContract: { schemaId: "hunter.e2e.output", version: 1 },
        requiredCapabilities: ["launch"],
        permissionPolicy: {
          decision: "allow",
          permissions: ["repository.read", "repository.write"],
        },
        verifier: {
          kind: "automated",
          verifierId: "e2e.failure-then-pass",
          outputContract: { schemaId: "hunter.e2e.output", version: 1 },
        },
        retryPolicy: {
          maxAttempts: 2,
          retryableErrorClasses: ["transient"],
          backoff: {
            kind: "fixed",
            initialDelayMs: 1,
            maxDelayMs: 1,
          },
          jitter: "none",
          waitingBudgetCost: 1,
        },
        timeoutPolicy: { timeoutMs: 30_000, onTimeout: "failed" },
        budgetCost: { units: 1, elapsedMs: 30_000, cost: 0 },
        sessionPolicy: "new",
        workspacePolicy: {
          mode: "write",
          isolation: "worktree",
          reuse: false,
        },
      },
    ],
    routes: [
      {
        routeId: RouteIdSchema.parse("rte_e2epassed001"),
        fromStepId: stepId,
        outcome: "passed",
        priority: 0,
        toStepId: null,
      },
      {
        routeId: RouteIdSchema.parse("rte_e2efailed001"),
        fromStepId: stepId,
        outcome: "failed",
        priority: 0,
        toStepId: null,
      },
    ],
    loops: [],
    publishedAt: FIXED_TIME,
  });
}

export function createE2eDaemonComposition(input: {
  readonly database: DatabaseSync;
  readonly fixture: VerticalSliceFixture;
  readonly installSecret: string;
  readonly dataDirectory: string;
  readonly allowedHosts: string[];
  readonly allowedOrigins: readonly string[];
}) {
  // This module is imported only by the isolated E2E launcher. It exercises the
  // production routes, authentication, journal and definition repository, but
  // deliberately stops before composing Flow -> Runtime -> Verifier.
  const services = createSqliteApplicationServices({
    database: input.database,
    externalHandler: input.fixture.runtime,
    installSecret: input.installSecret,
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
    contentDirectory: input.dataDirectory,
    now: () => new Date(FIXED_TIME),
  });
  const requirementViews = new Map<
    RequirementRevisionId,
    StoredRequirementView
  >();
  const daemonCsrf = canonicalSha256({
    purpose: "e2e-daemon-csrf",
    fixture: input.fixture.proofScope,
  });
  const workflow = e2eWorkflow();

  const commitProject = (
    command: CreateProjectHttpRequest,
    actor: { readonly actorId: string; readonly correlationId: string },
  ) => {
    const project = createProject({
      projectId: command.projectId,
      name: command.name,
      repositoryBindings: [{ repositoryId, role: "primary" }],
      deviceBindings: [
        {
          deviceBindingId: DeviceBindingIdSchema.parse(
            "dev_e2econtract01",
          ),
          deviceId: DeviceIdSchema.parse("dvc_e2econtract01"),
          repositoryId,
          localPath: input.dataDirectory,
          availability: "available",
        },
      ],
    });
    const suffix = canonicalSha256(command.idempotencyKey).slice(0, 24);
    services.journal.commitCommand({
      commandId: `e2e-project:${command.idempotencyKey}`,
      requestFingerprint: canonicalSha256(project),
      projectId: project.projectId,
      aggregateId: `project:${project.projectId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [
        {
          eventId: `evt_e2e_project_${suffix}`,
          eventType: "ProjectCreated",
          eventData: { projectId: project.projectId, project },
          schemaVersion: 1,
          occurredAt: FIXED_TIME,
        },
        {
          eventId: `evt_e2e_workflow_${suffix}`,
          eventType: "WorkflowRevisionPublished",
          eventData: {
            workflowRevisionId: workflow.workflowRevisionId,
            workflowRevision: workflow,
          },
          schemaVersion: 1,
          occurredAt: FIXED_TIME,
        },
        {
          eventId: `evt_e2e_profile_${suffix}`,
          eventType: "AgentProfileDefined",
          eventData: {
            agentProfileId,
            agentProfile: {
              agentProfileId,
              projectId: project.projectId,
              status: "active",
            },
          },
          schemaVersion: 1,
          occurredAt: FIXED_TIME,
        },
        {
          eventId: `evt_e2e_policy_${suffix}`,
          eventType: "ProjectRunPolicyDefined",
          eventData: {
            projectId: project.projectId,
            policySnapshot: {
              snapshotHash: canonicalSha256({
                projectId: project.projectId,
                purpose: "e2e-policy",
              }),
              policyVersion: 1,
            },
            budgetLimit: {
              maxAttempts: 2,
              maxElapsedMs: 120_000,
              maxCost: 10,
              maxTokens: 10_000,
              maxLoopIterations: 2,
            },
          },
          schemaVersion: 1,
          occurredAt: FIXED_TIME,
        },
      ],
      operations: [],
      response: {
        projectId: project.projectId,
        name: project.name,
        authorization: "host_session_reissue_required",
      },
    });
    return {
      projectId: project.projectId,
      name: project.name,
      authorization: "host_session_reissue_required" as const,
    };
  };

  const app = buildApp({
    authenticator: services.authenticator,
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
    eventStream: services.eventStream,
    services: {
      listProjects: async (authorizedProjectIds) =>
        authorizedProjectIds.flatMap((projectId) => {
          const project = services.repositories.getProject(projectId);
          return project === null
            ? []
            : [{ projectId: project.projectId, name: project.name }];
        }),
      createProject: async (command, actor) => commitProject(command, actor),
      getProject: async (projectId) => {
        const project = services.repositories.getProject(projectId);
        if (project === null) return null;
        return {
          projectId: project.projectId,
          name: project.name,
          requirements: [...requirementViews.values()].filter(
            (revision) => revision.projectId === project.projectId,
          ),
          planningDefaults: {
            repositoryIds: [repositoryId],
            workflowRevisionId,
            defaultAgentProfileId: agentProfileId,
            sessionPolicy: "new",
            workspacePolicy: {
              mode: "write",
              isolation: "worktree",
              reuse: false,
            },
          },
        };
      },
      requirements: {
        createRequirement: async (
          projectId: ProjectId,
          command: CreateRequirementHttpRequest,
          actor,
        ) => {
          if (services.repositories.getProject(projectId) === null) {
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
          services.journal.commitCommand({
            commandId: `e2e-requirement-draft:${command.idempotencyKey}`,
            requestFingerprint: canonicalSha256(revision),
            projectId,
            aggregateId: `requirement-draft:${revision.revisionId}`,
            expectedVersion: command.expectedVersion,
            actor,
            events: [
              {
                eventId: `evt_e2e_requirement_draft_${canonicalSha256(command.idempotencyKey).slice(0, 24)}`,
                eventType: "RequirementRevisionDrafted",
                eventData: {
                  requirementRevisionId: revision.revisionId,
                  requirementRevision: revision,
                },
                schemaVersion: 1,
                occurredAt: FIXED_TIME,
              },
            ],
            operations: [],
            response: { revisionId: revision.revisionId },
          });
          const view: StoredRequirementView = {
            ...revision,
            acceptanceCriteria: [...revision.acceptanceCriteria],
            constraints: [...revision.constraints],
            aggregateVersion: 0,
          };
          requirementViews.set(revision.revisionId, view);
          return view;
        },
        getRequirementRevision: (revisionId) => {
          const view = requirementViews.get(revisionId);
          return view === undefined
            ? null
            : {
                projectId: view.projectId,
                revisionId: view.revisionId,
                status: view.status,
              };
        },
        approveRequirement: async (
          projectId,
          revisionId,
          command,
          actor,
        ) => {
          const draft = requirementViews.get(revisionId);
          if (
            draft === undefined
            || draft.projectId !== projectId
            || draft.aggregateVersion !== command.expectedVersion
          ) {
            throw new Error("REQUIREMENT_REVISION_VERSION_CONFLICT");
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
            approvedAt: FIXED_TIME,
          });
          services.journal.commitCommand({
            commandId: `e2e-requirement-approve:${command.idempotencyKey}`,
            requestFingerprint: canonicalSha256(approved),
            projectId,
            aggregateId: `requirement:${revisionId}`,
            expectedVersion: command.expectedVersion,
            actor,
            events: [
              {
                eventId: `evt_e2e_requirement_approved_${canonicalSha256(command.idempotencyKey).slice(0, 24)}`,
                eventType: "RequirementRevisionApproved",
                eventData: {
                  requirementRevisionId: approved.revisionId,
                  requirementRevision: approved,
                },
                schemaVersion: 1,
                occurredAt: FIXED_TIME,
              },
            ],
            operations: [],
            response: { revisionId },
          });
          const view: StoredRequirementView = {
            ...approved,
            acceptanceCriteria: [...approved.acceptanceCriteria],
            constraints: [...approved.constraints],
            aggregateVersion: 1,
          };
          requirementViews.set(revisionId, view);
          return view;
        },
      },
      changes: {
        getRequirementRevision: (revisionId) => {
          const revision = requirementViews.get(revisionId);
          return revision === undefined
            ? null
            : {
                projectId: revision.projectId,
                revisionId: revision.revisionId,
                status: revision.status,
              };
        },
        publishChange: async (
          projectId: ProjectId,
          command: PublishChangeHttpRequest,
          actor,
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
          services.journal.commitCommand({
            commandId: `e2e-change-draft:${command.idempotencyKey}`,
            requestFingerprint: canonicalSha256(draft),
            projectId,
            aggregateId: `change-draft:${draft.revisionId}`,
            expectedVersion: 0,
            actor,
            events: [
              {
                eventId: `evt_e2e_change_draft_${canonicalSha256(command.idempotencyKey).slice(0, 24)}`,
                eventType: "ChangeRevisionDefined",
                eventData: {
                  changeRevisionId: draft.revisionId,
                  changeRevision: draft,
                },
                schemaVersion: 1,
                occurredAt: FIXED_TIME,
              },
            ],
            operations: [],
            response: { changeRevisionId: draft.revisionId },
          });
          const published = services.publishChange.execute(
            {
              changeRevisionId: command.changeRevisionId,
              executionPlanId: command.executionPlanId,
              tasks: command.tasks,
              expectedVersion: command.expectedVersion,
              idempotencyKey: command.idempotencyKey,
            },
            actor,
          );
          return {
            projectId,
            changeId: published.changeRevision.changeId,
            changeRevisionId: published.changeRevision.revisionId,
            executionPlanId: published.executionPlan.executionPlanId,
            status: "published" as const,
            taskGraphFingerprint:
              published.executionPlan.taskGraphFingerprint,
          };
        },
      },
      projectForExecutionPlan: (executionPlanId) => {
        const plan = services.repositories.getExecutionPlan(executionPlanId);
        return plan === null
          ? null
          : {
              projectId: plan.projectId,
              executionPlanId: plan.executionPlanId,
            };
      },
      startRun: async (command) => {
        const plan = services.repositories.getExecutionPlan(
          command.executionPlanId,
        );
        if (
          plan === null
          || command.workflowRevisionId !== workflowRevisionId
          || services.repositories.getProject(plan.projectId) === null
        ) {
          throw new Error("E2E_RUN_BINDING_INVALID");
        }
        const projectPosition = (
          input.database
            .prepare(
              "SELECT position FROM events WHERE event_type = 'ProjectCreated' AND project_id = ? ORDER BY position DESC LIMIT 1",
            )
            .get(plan.projectId) as { readonly position: number } | undefined
        )?.position;
        const approvalPositions = plan.requirementRevisionIds.map(
          (revisionId) => {
            const approved =
              services.repositories.getRequirementRevision(revisionId);
            if (
              approved === null
              || approved.status !== "approved"
              || approved.projectId !== plan.projectId
            ) {
              throw new Error("E2E_REQUIREMENT_BINDING_INVALID");
            }
            const rows = input.database
              .prepare(
                "SELECT position, event_data FROM events WHERE event_type = 'RequirementRevisionApproved' AND project_id = ? ORDER BY position",
              )
              .all(plan.projectId) as unknown as Array<{
              readonly position: number;
              readonly event_data: string;
            }>;
            const row = rows.find(
              ({ event_data }) =>
                (
                  JSON.parse(event_data) as {
                    readonly requirementRevisionId?: string;
                  }
                ).requirementRevisionId === revisionId,
            );
            if (row === undefined) {
              throw new Error("E2E_REQUIREMENT_LEDGER_POSITION_MISSING");
            }
            return row.position;
          },
        );
        if (projectPosition === undefined || approvalPositions.length === 0) {
          throw new Error("E2E_REQUIRED_LEDGER_POSITION_MISSING");
        }
        throw new RunCompositionNotWiredError({
          ProjectCreated: projectPosition,
          RequirementRevisionApproved: Math.max(...approvalPositions),
        });
      },
    },
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof RunCompositionNotWiredError) {
      return await reply.code(501).send({
        code: error.message,
        positions: error.positions,
      });
    }
    return await reply.code(500).send({ code: "E2E_APPLICATION_ERROR" });
  });

  return {
    app,
    services,
    daemonCsrf,
    catalog: { repositoryId, workflowRevisionId, agentProfileId },
    issueSession: (projectIds: readonly ProjectId[]) => {
      services.setPrincipalProjectAuthorization("e2e-owner", projectIds);
      return services.authenticator.issueSession({
        principalId: "e2e-owner",
        authorizedProjectIds: projectIds,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        csrf: daemonCsrf,
      });
    },
  };
}
