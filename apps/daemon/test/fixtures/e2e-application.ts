import type { DatabaseSync } from "node:sqlite";

import type {
  CreateProjectHttpRequest,
  CreateRequirementHttpRequest,
  PublishChangeHttpRequest,
  RequirementRevisionHttpResponse,
} from "@hunter/api-contracts";
import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  ChangeIdSchema,
  DeviceBindingIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  LoopIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RouteIdSchema,
  StepIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  createChangeRevision,
  createProject,
  createRequirementRevision,
  createWorkflowRevision,
  type ProjectId,
  type RequirementRevisionId,
  type RunId,
} from "@hunter/domain";
import {
  CanonicalWorkspaceKeySchema,
  CapabilityProbeReceiptSchema,
  ControllerLeaseSchema,
  ExternalOperationReceiptSchema,
  LeaseSchema,
  WorkspaceLeaseSchema,
  WriterLeaseSchema,
  createExternalOperation,
  createWorkspacePathBoundary,
} from "@hunter/runtime-contracts";
import { buildApp } from "../../src/app.js";
import {
  rebuildKnowledge,
  type ArchiveJobFaultPoint,
  type LeasedArchiveJob,
} from "@hunter/knowledge";
import type { VerticalSliceRuntimeFixture } from "../../src/services/application-services.js";
import { createApplicationComposition } from "../../src/services/composition-root.js";

const FIXED_TIME = "2026-07-23T00:00:00.000Z";
const repositoryId = RepositoryIdSchema.parse("rep_e2econtract01");
const workflowRevisionId =
  WorkflowRevisionIdSchema.parse("wfr_e2econtract01");
const rootWorkflowRevisionId =
  WorkflowRevisionIdSchema.parse("wfr_e2eroot000001");
const agentProfileId = AgentProfileIdSchema.parse("apr_e2econtract01");
const stepId = StepIdSchema.parse("stp_e2econtract01");
const rootStepId = StepIdSchema.parse("stp_e2eroot000001");

// Task 13A presentation-only state: the approved revision is canonical in the
// SQLite ledger; Task 19 replaces this transient draft/view shell with the full
// ApplicationServices composition before the E2E story may become GREEN.
type StoredRequirementView = RequirementRevisionHttpResponse;

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
        routeId: RouteIdSchema.parse("rte_e2eloop0001"),
        fromStepId: stepId,
        outcome: "failed",
        priority: 0,
        toStepId: stepId,
      },
    ],
    loops: [{
      loopId: LoopIdSchema.parse("lop_e2econtract01"),
      routeId: RouteIdSchema.parse("rte_e2eloop0001"),
      fromStepId: stepId,
      toStepId: stepId,
      maxIterations: 2,
      maxElapsedMs: 30_000,
      maxCost: 10,
      progressPredicate: { kind: "diff_present", source: "workspace.diff" },
      stagnation: {
        maxSameFailureFingerprint: 2,
        maxNoDiffIterations: 1,
        maxVerifierErrors: 1,
      },
      reuse: { profile: true, session: false, workspace: false },
      exhaustion: { target: "needs_attention", notify: true },
    }],
    publishedAt: FIXED_TIME,
  });
}

function e2eRootWorkflow() {
  return createWorkflowRevision({
    workflowRevisionId: rootWorkflowRevisionId,
    title: "E2E root Task dispatch",
    status: "published",
    entryStepId: rootStepId,
    steps: [{
      stepId: rootStepId,
      kind: "subflow",
      executor: { kind: "subflow", selector: workflowRevisionId },
      inputContract: { schemaId: "hunter.execution-plan", version: 1 },
      outputContract: { schemaId: "hunter.task-run-summary", version: 1 },
      requiredCapabilities: ["workspace_isolation"],
      permissionPolicy: {
        decision: "allow",
        permissions: ["workflow.dispatch-task"],
      },
      verifier: {
        kind: "automated",
        verifierId: "e2e-task-run-verdicts",
        outputContract: { schemaId: "hunter.task-run-summary", version: 1 },
      },
      retryPolicy: {
        maxAttempts: 1,
        retryableErrorClasses: [],
        backoff: {
          kind: "fixed",
          initialDelayMs: 1,
          maxDelayMs: 1,
        },
        jitter: "none",
        waitingBudgetCost: 1,
      },
      timeoutPolicy: { timeoutMs: 30_000, onTimeout: "needs_attention" },
      budgetCost: { units: 1, elapsedMs: 30_000, cost: 0 },
      sessionPolicy: "new",
      workspacePolicy: {
        mode: "write",
        isolation: "worktree",
        reuse: false,
      },
    }],
    routes: [{
      routeId: RouteIdSchema.parse("rte_e2erootpass01"),
      fromStepId: rootStepId,
      outcome: "passed",
      priority: 0,
      toStepId: null,
    }],
    loops: [],
    publishedAt: FIXED_TIME,
  });
}

function e2eCapability() {
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_e2econtract01"),
    subject: {
      kind: "provider",
      providerId: "rtp_e2econtract01",
      implementationVersion: "deterministic-contract-fixture-v1",
    },
    platform: process.platform === "win32" ? "windows" : "linux",
    executable: { status: "available" },
    loginState: "not_required",
    productVersion: {
      observed: "fixture-1",
      supported: ["fixture-1"],
    },
    protocol: {
      kind: "fake",
      observedVersion: "1",
      supportedVersions: ["1"],
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      schemaDigest: "c".repeat(64),
    },
    probedAt: "2026-07-23T00:00:00.000Z",
    validUntil: "2027-07-23T00:00:00.000Z",
    results: [
      {
        capability: "launch",
        status: "supported",
        evidenceId: EvidenceIdSchema.parse("evd_e2ecapability01"),
        evidence: {
          source: "local_probe",
          digest: "a".repeat(64),
        },
        probedAt: "2026-07-23T00:00:00.000Z",
      },
      {
        capability: "observe",
        status: "supported",
        evidenceId: EvidenceIdSchema.parse("evd_e2eobserve0001"),
        evidence: {
          source: "local_probe",
          digest: "b".repeat(64),
        },
        probedAt: "2026-07-23T00:00:00.000Z",
      },
    ],
  });
}

function archiveInputFor(
  job: LeasedArchiveJob,
  services: ReturnType<typeof createApplicationComposition>["services"],
  database: DatabaseSync,
  workspaceGitHead: string,
) {
  const root = services.flowStore.loadRun(job.runId);
  if (root === null) throw new Error("E2E_ARCHIVE_RUN_MISSING");
  const runStates = root.binding.subjectKind === "change"
    ? [root, ...services.flowStore.childRuns(job.runId)]
    : [root];
  const leases = (database.prepare(
    "SELECT receipt_json FROM lease_records ORDER BY lease_id",
  ).all() as unknown as Array<{ readonly receipt_json: string }>)
    .map(({ receipt_json }) => LeaseSchema.parse(JSON.parse(receipt_json) as unknown))
    .filter((lease) => lease.projectId === job.projectId);
  const leaseReceiptBase = (lease: (typeof leases)[number]) => ({
    repositoryId: lease.repositoryId,
    deviceBindingId: lease.deviceBindingId,
    gitHead: lease.gitHead,
    receiptHash: canonicalSha256(lease),
  });
  const workspace = leases.filter(
    (lease): lease is ReturnType<typeof WorkspaceLeaseSchema.parse> =>
      lease.kind === "workspace",
  ).map((lease) => ({ ...leaseReceiptBase(lease), leaseId: lease.leaseId }));
  const writer = leases.filter(
    (lease): lease is ReturnType<typeof WriterLeaseSchema.parse> =>
      lease.kind === "writer",
  ).map((lease) => ({ ...leaseReceiptBase(lease), leaseId: lease.leaseId }));
  const controller = leases.filter(
    (lease): lease is ReturnType<typeof ControllerLeaseSchema.parse> =>
      lease.kind === "controller",
  ).map((lease) => ({ ...leaseReceiptBase(lease), leaseId: lease.leaseId }));
  if (workspace.length === 0 || writer.length === 0 || controller.length === 0) {
    throw new Error("E2E_ARCHIVE_LEASE_PROVENANCE_MISSING");
  }
  const change = services.repositories.getChangeRevision(
    root.binding.changeRevisionId,
  );
  if (change === null) throw new Error("E2E_ARCHIVE_CHANGE_MISSING");
  return {
    schemaVersion: 1 as const,
    projectId: job.projectId,
    repositories: [{
      repositoryId,
      deviceBindingId: DeviceBindingIdSchema.parse("dev_e2econtract01"),
      gitHead: workspaceGitHead,
    }],
    requirementRevisionIds: [...root.binding.requirementRevisionIds],
    change: {
      changeId: ChangeIdSchema.parse(change.changeId),
      changeRevisionId: root.binding.changeRevisionId,
    },
    executionPlanId: root.binding.executionPlanId,
    workflowRevisionId: root.binding.workflowRevisionId,
    runGraph: {
      rootRunId: job.runId,
      runs: runStates.map((state) => ({
        runId: state.binding.runId,
        parentRunId: state.binding.parentRunId,
        taskId: state.binding.subjectKind === "task"
          ? state.binding.taskId
          : null,
        outcome: state.status as "succeeded" | "failed" | "canceled",
        steps: state.steps.map((step) => ({
          stepRunId: step.stepRunId,
          stepId: step.stepId,
          attempts: step.attempts.map((attempt) => {
            const hash = canonicalSha256({
              runId: state.binding.runId,
              attemptId: attempt.attemptId,
            });
            return {
              attemptId: attempt.attemptId,
              agentProfileId,
              capabilityProbeDigest: canonicalSha256(e2eCapability()),
              nativeSessionReferenceHash: canonicalSha256(
                attempt.assignment?.operationId ?? attempt.attemptId,
              ),
              artifacts: [],
              evidence: [{
                evidenceId: EvidenceIdSchema.parse(`evd_${hash.slice(0, 24)}`),
                contentRef: `cas:sha256:${hash}` as const,
                contentHash: hash,
              }],
            };
          }),
        })),
      })),
    },
    leases: { workspace, writer, controller },
    ledger: {
      firstPosition: job.firstPosition,
      lastPosition: job.lastPosition,
    },
    actor: {
      actorId: job.actorId,
      correlationId: job.correlationId,
    },
    timestamps: {
      occurredAt: job.occurredAt,
      archivedAt: FIXED_TIME,
    },
    outcome: job.outcome,
  };
}

export function createE2eDaemonComposition(input: {
  readonly database: DatabaseSync;
  readonly fixture: VerticalSliceRuntimeFixture;
  readonly installSecret: string;
  readonly dataDirectory: string;
  readonly allowedHosts: string[];
  readonly allowedOrigins: readonly string[];
  readonly now?: (() => Date) | undefined;
  readonly archiveFault?: ((point: ArchiveJobFaultPoint) => void) | undefined;
  readonly workspaceIdentity?: {
    readonly path: string;
    readonly gitHead: string;
  } | undefined;
}) {
  const workspacePath = input.workspaceIdentity?.path ?? input.dataDirectory;
  const workspaceGitHead = input.workspaceIdentity?.gitHead ?? "1".repeat(40);
  const workspaceBoundary = createWorkspacePathBoundary(
    new Map([[repositoryId, workspacePath]]),
  );
  const verifiedWorkspacePath = workspaceBoundary.verify(
    repositoryId,
    workspacePath,
  );
  const serviceReference: {
    current?: ReturnType<typeof createApplicationComposition>["services"];
  } = {};
  const composition = createApplicationComposition({
    database: input.database,
    externalHandler: input.fixture.runtime,
    verifier: input.fixture.verifier,
    installSecret: input.installSecret,
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
    contentDirectory: input.dataDirectory,
    now: input.now ?? (() => new Date(FIXED_TIME)),
    capabilityReceiptFor: () => e2eCapability(),
    leaseRecoveryObservationFor: (lease) =>
      lease.kind === "writer"
        ? { worktreeId: lease.scope.worktreeId ?? undefined }
        : lease.kind === "controller"
          ? {
              worktreeId: lease.scope.worktreeId,
              nativeSessionId: lease.scope.nativeSessionId,
            }
          : null,
    verifiedWorkspacePathForLease: () => verifiedWorkspacePath,
    archive: {
      root: input.dataDirectory,
      source: {
        build: (job) => {
          if (serviceReference.current === undefined) {
            throw new Error("E2E_COMPOSITION_NOT_READY");
          }
          return archiveInputFor(
            job,
            serviceReference.current,
            input.database,
            workspaceGitHead,
          );
        },
      },
      ownerId: LeaseOwnerIdSchema.parse("own_e2earchive001"),
      leaseDurationMs: 30_000,
      ...(input.archiveFault === undefined
        ? {}
        : { fault: input.archiveFault }),
    },
  });
  serviceReference.current = composition.services;
  const { services, attemptSettlement } = composition;
  const requirementViews = new Map<
    RequirementRevisionId,
    StoredRequirementView
  >();
  const daemonCsrf = canonicalSha256({
    purpose: "e2e-daemon-csrf",
    fixture: input.fixture.proofScope,
  });
  const workflow = e2eWorkflow();
  const rootWorkflow = e2eRootWorkflow();

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
          localPath: workspacePath,
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
          eventId: `evt_e2e_root_workflow_${suffix}`,
          eventType: "WorkflowRevisionPublished",
          eventData: {
            workflowRevisionId: rootWorkflow.workflowRevisionId,
            workflowRevision: rootWorkflow,
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
              maxAttempts: 10,
              maxElapsedMs: 300_000,
              maxCost: 10,
              maxTokens: 10_000,
              maxLoopIterations: 10,
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
        getChangeExecutionPlanRelation: (
          changeId,
          changeRevisionId,
          executionPlanId,
        ) => {
          const change = services.repositories.getChangeRevision(
            changeRevisionId,
          );
          const plan =
            services.repositories.getExecutionPlan(executionPlanId);
          if (change === null && plan === null) return null;
          return {
            projectId: change?.projectId ?? plan!.projectId,
            changeId: change?.changeId ?? changeId,
            changeRevisionId:
              change?.revisionId ?? plan!.changeRevisionId,
            executionPlanId: plan?.executionPlanId ?? executionPlanId,
          };
        },
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
      projectForRun: (runId) => {
        const run = services.flowStore.loadRun(runId);
        return run === null
          ? null
          : {
              projectId: run.binding.projectId,
              runId: run.binding.runId,
            };
      },
      startRun: async (command, actor) => {
        const plan = services.repositories.getExecutionPlan(
          command.executionPlanId,
        );
        if (
          plan === null
          || command.workflowRevisionId !== rootWorkflowRevisionId
          || services.repositories.getProject(plan.projectId) === null
        ) {
          throw new Error("E2E_RUN_BINDING_INVALID");
        }
        return composition.startRun.execute(command, actor);
      },
      knowledge: composition.knowledge === undefined
        ? undefined
        : {
            resolve: async (query) => await composition.knowledge!.resolve(query),
          },
    },
  });
  app.setErrorHandler(async (error, _request, reply) => {
    void error;
    return await reply.code(500).send({ code: "E2E_APPLICATION_ERROR" });
  });

  const requireActiveRoot = () => {
    const root = services.flowStore.allRuns().find(
      (state) =>
        state.binding.subjectKind === "change" &&
        !["succeeded", "failed", "canceled"].includes(state.status),
    );
    if (root === undefined) throw new Error("E2E_ACTIVE_ROOT_RUN_REQUIRED");
    return root;
  };

  const ensureAttemptLaunched = async (childRunId: RunId) => {
    const child = services.flowStore.loadRun(childRunId);
    const attempt = child?.steps.find(({ conclusion }) => conclusion === "active")
      ?.attempts.at(-1);
    if (child === null || child === undefined || attempt === undefined) {
      throw new Error(
        `E2E_ACTIVE_ATTEMPT_REQUIRED:${child?.status ?? "missing"}:${
          child?.steps.map(({ conclusion }) => conclusion).join(",") ?? "missing"
        }`,
      );
    }
    const identity = canonicalSha256({
      childRunId,
      attemptId: attempt.attemptId,
    }).slice(0, 12);
    const workspaceId = WorkspaceIdSchema.parse(`wsp_e2e${identity}`);
    const ownerId = LeaseOwnerIdSchema.parse(`own_e2e${identity}`);
    const workspaceLeaseId = WorkspaceLeaseIdSchema.parse(`wsl_e2e${identity}`);
    const writerLeaseId = WriterLeaseIdSchema.parse(`wrl_e2e${identity}`);
    const nextPathLeaseGeneration = (
      kind: "workspace" | "writer",
    ): number => {
      const rows = input.database.prepare(
        "SELECT generation, receipt_json FROM lease_records WHERE lease_kind = ?",
      ).all(kind) as unknown as Array<{
        readonly generation: number;
        readonly receipt_json: string;
      }>;
      const existing = rows.find(({ receipt_json }) => {
        const lease = LeaseSchema.parse(JSON.parse(receipt_json) as unknown);
        return lease.kind === kind
          && lease.canonicalWorkspaceKey
            === workspaceBoundary.canonicalKey(verifiedWorkspacePath);
      });
      return (existing?.generation ?? 0) + 1;
    };
    const common = {
      schemaVersion: 2 as const,
      projectId: child.binding.projectId,
      repositoryId,
      deviceBindingId: DeviceBindingIdSchema.parse("dev_e2econtract01"),
      canonicalWorkspaceKey: CanonicalWorkspaceKeySchema.parse(
        workspaceBoundary.canonicalKey(verifiedWorkspacePath),
      ),
      gitHead: workspaceGitHead,
      branch: "e2e-contract",
      ownerRunId: childRunId,
      ownerAttemptId: AttemptIdSchema.parse(attempt.attemptId),
      ownerId,
      mode: "write" as const,
      acquiredAt: FIXED_TIME,
      expiresAt: "2027-07-23T00:00:00.000Z",
      revokedAt: null,
      revocationReason: null,
    };
    const workspaceLease = WorkspaceLeaseSchema.parse({
      ...common,
      kind: "workspace",
      leaseId: workspaceLeaseId,
      generation: nextPathLeaseGeneration("workspace"),
      scope: { workspaceId },
    });
    const writerLease = WriterLeaseSchema.parse({
      ...common,
      kind: "writer",
      leaseId: writerLeaseId,
      generation: nextPathLeaseGeneration("writer"),
      scope: {
        workspaceId,
        worktreeId: WorktreeIdSchema.parse(`wtr_e2e${identity}`),
      },
    });
    const operation = createExternalOperation({
      schemaVersion: 1,
      operationId: OperationIdSchema.parse(`opn_e2e${identity}`),
      projectId: child.binding.projectId,
      runId: childRunId,
      attemptId: attempt.attemptId,
      operationVersion: 1,
      operationType: "session.launch",
      requestedCapabilities: ["launch"],
      payload: { agentProfileId, workspaceId },
    });
    if (attempt.assignment === undefined) {
      if (attempt.executionStatus !== "assigned") {
        throw new Error(
          `E2E_ATTEMPT_NOT_ASSIGNABLE:${child.status}:${attempt.executionStatus}:${attempt.attemptNumber}`,
        );
      }
      await services.leaseService.acquire(workspaceLease);
      await services.leaseService.acquire(writerLease);
      services.runtimeManager.requestAssignment({
        commandId: `e2e-assign:${attempt.attemptId}`,
        expectedVersion: child.version,
        operation,
      });
    } else if (attempt.assignment.operationId !== operation.operationId) {
      throw new Error("E2E_ASSIGNMENT_OPERATION_MISMATCH");
    }
    const receiptRow = input.database.prepare(
      "SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ? AND observed_status = 'completed'",
    ).get(operation.operationId) as { readonly provider_receipt_json: string } | undefined;
    if (receiptRow === undefined) {
      if (await services.operationWorker.runOnce() !== "completed") {
        throw new Error("E2E_RUNTIME_OPERATION_NOT_COMPLETED");
      }
    } else {
      const receipt = ExternalOperationReceiptSchema.parse(
        JSON.parse(receiptRow.provider_receipt_json) as unknown,
      );
      if (
        receipt.operationId !== operation.operationId
        || receipt.fingerprint !== operation.fingerprint
      ) {
        throw new Error("E2E_RUNTIME_RECEIPT_IDENTITY_MISMATCH");
      }
    }
    return { attempt, workspaceLease, writerLease, operation };
  };

  const runUntilLaunchReceipt = async () => {
    const root = requireActiveRoot();
    const currentRoot = services.flowStore.loadRun(root.binding.runId);
    if (currentRoot === null) throw new Error("E2E_ROOT_RUN_MISSING");
    const actor = {
      actorId: "e2e-composition",
      correlationId: `e2e:${root.binding.runId}`,
    };
    const existing = services.flowStore.allRuns().filter(
      ({ binding, status }) =>
        binding.parentRunId === root.binding.runId
        && !["succeeded", "failed", "canceled"].includes(status),
    );
    const childRunIds = existing.length > 0
      ? existing.map(({ binding }) => binding.runId)
      : services.runCoordinator.dispatch({
        parentRunId: root.binding.runId,
        expectedVersion: currentRoot.version,
        idempotencyKey: `e2e-launch-checkpoint:${root.binding.runId}`,
        actor,
      }).children.map(({ childRunId }) => childRunId);
    if (childRunIds.length === 0) throw new Error("E2E_CHILD_RUN_REQUIRED");
    const launched = [];
    for (const childRunId of childRunIds) {
      launched.push({
        childRunId,
        ...(await ensureAttemptLaunched(childRunId)),
      });
    }
    const first = launched[0];
    if (first === undefined) throw new Error("E2E_CHILD_RUN_REQUIRED");
    return {
      childRunId: first.childRunId,
      attemptId: first.attempt.attemptId,
      operationId: first.operation.operationId,
      operationIds: launched.map(({ operation }) => operation.operationId),
    };
  };

  const drainArchiveAndKnowledge = async (): Promise<void> => {
    if (services.archiveWorker === undefined) {
      throw new Error("E2E_ARCHIVE_WORKER_NOT_WIRED");
    }
    let idle = false;
    for (let index = 0; index < 100; index += 1) {
      const result = await services.archiveWorker.runOnce();
      if (result === "idle") {
        idle = true;
        break;
      }
      if (result !== "completed") {
        const row = input.database.prepare(
          "SELECT last_error FROM archive_jobs WHERE status = 'needs_attention' ORDER BY updated_at DESC LIMIT 1",
        ).get() as { readonly last_error?: string } | undefined;
        throw new Error(`E2E_ARCHIVE_NOT_COMPLETED:${row?.last_error ?? "unknown"}`);
      }
    }
    if (!idle) throw new Error("E2E_ARCHIVE_DRAIN_LIMIT");
    services.projectionRunner.runIncremental();
    const projectRows = input.database.prepare(
      "SELECT DISTINCT project_id FROM archive_jobs WHERE status = 'completed' ORDER BY project_id",
    ).all() as unknown as Array<{ readonly project_id: string }>;
    for (const row of projectRows) {
      await rebuildKnowledge({
        database: input.database,
        projectId: ProjectIdSchema.parse(row.project_id),
        now: input.now ?? (() => new Date(FIXED_TIME)),
      });
    }
  };

  const releaseCurrentLease = async (leaseId: string): Promise<void> => {
    const row = input.database.prepare(
      "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(leaseId) as { readonly receipt_json: string } | undefined;
    if (row === undefined) throw new Error("E2E_LEASE_RECORD_MISSING");
    const lease = LeaseSchema.parse(JSON.parse(row.receipt_json) as unknown);
    if (lease.revokedAt !== null) return;
    await services.leaseService.release({
      leaseId: lease.leaseId,
      ownerId: lease.ownerId,
      generation: lease.generation,
    });
  };

  const runUntilSettled = async (): Promise<void> => {
    const root = requireActiveRoot();
    const actor = {
      actorId: "e2e-composition",
      correlationId: `e2e:${root.binding.runId}`,
    };
    const executeAttempt = async (childRunId: RunId) => {
      const { workspaceLease, writerLease } =
        await ensureAttemptLaunched(childRunId);
      await attemptSettlement.settle(childRunId);
      return { workspaceLease, writerLease };
    };

    let currentRoot = services.flowStore.loadRun(root.binding.runId);
    if (currentRoot === null) throw new Error("E2E_ROOT_RUN_MISSING");

    for (let fanOutIndex = 0; fanOutIndex < 100; fanOutIndex += 1) {
      currentRoot = services.flowStore.loadRun(root.binding.runId);
      if (currentRoot === null) throw new Error("E2E_ROOT_RUN_MISSING");
      if (["succeeded", "failed", "canceled"].includes(currentRoot.status)) break;
      const existingChildren = services.flowStore.allRuns().filter(
        ({ binding }) => binding.parentRunId === root.binding.runId,
      );
      const unacceptedTerminal = existingChildren.filter(
        (child) =>
          ["succeeded", "failed", "canceled"].includes(child.status)
          && !currentRoot!.acceptedChildRunIds.includes(child.binding.runId),
      );
      if (unacceptedTerminal.length > 0) {
        services.flowEngine.handle({
          type: "ReconcileTaskChildren",
          runId: currentRoot.binding.runId,
          expectedVersion: currentRoot.version,
          idempotencyKey: `e2e-root-reconcile:${currentRoot.binding.runId}:${fanOutIndex}`,
          actor,
        });
        continue;
      }
      let childRunIds = existingChildren
        .filter((child) => !["succeeded", "failed", "canceled"].includes(child.status))
        .map(({ binding }) => binding.runId);
      if (childRunIds.length === 0) {
        const fanout = services.runCoordinator.dispatch({
          parentRunId: root.binding.runId,
          expectedVersion: currentRoot.version,
          idempotencyKey: `e2e-fanout:${root.binding.runId}:${fanOutIndex}`,
          actor,
        });
        childRunIds = fanout.children.map(({ childRunId }) => childRunId);
      }
      if (childRunIds.length === 0) throw new Error("E2E_CHILD_RUN_REQUIRED");
      for (const childRunId of childRunIds) {
        for (let attemptIndex = 0; attemptIndex < 10; attemptIndex += 1) {
          const child = services.flowStore.loadRun(childRunId);
          if (child === null) throw new Error("E2E_CHILD_RUN_MISSING");
          if (["succeeded", "failed", "canceled"].includes(child.status)) break;
          const leases = await executeAttempt(childRunId);
          const afterAttempt = services.flowStore.loadRun(childRunId);
          if (afterAttempt === null) throw new Error("E2E_CHILD_RUN_MISSING");
          await releaseCurrentLease(leases.workspaceLease.leaseId);
          await releaseCurrentLease(leases.writerLease.leaseId);
          if (attemptIndex === 9) throw new Error("E2E_ATTEMPT_DRAIN_LIMIT");
        }
      }
      if (fanOutIndex === 99) throw new Error("E2E_FANOUT_DRAIN_LIMIT");
    }

    await drainArchiveAndKnowledge();
  };

  return {
    app,
    services,
    daemonCsrf,
    catalog: {
      repositoryId,
      workflowRevisionId,
      rootWorkflowRevisionId,
      agentProfileId,
    },
    drainArchiveAndKnowledge,
    runUntilLaunchReceipt,
    runUntilSettled,
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
