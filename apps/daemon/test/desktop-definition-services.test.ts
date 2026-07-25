import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AppendProjectRepositoryHttpRequestSchema,
  ConfirmProjectWorkflowMigrationHttpRequestSchema,
  CreateProjectHttpRequestSchema,
  CreateRequirementHttpRequestSchema,
  PublishChangeHttpRequestSchema,
  type AppendProjectRepositoryHttpRequest,
  type AppendProjectRepositoryHttpResponse,
  type ConfirmProjectWorkflowMigrationHttpRequest,
  type ConfirmProjectWorkflowMigrationHttpResponse,
  type ProjectWorkflowBindingHttpResponse,
  type ProjectWorkflowMigrationPreviewHttpResponse,
} from "@hunter/api-contracts";
import {
  RunIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  createWorkflowRevision,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import { createApplicationComposition } from "../src/services/composition-root.js";
import { createDesktopDefinitionServices } from "../src/services/desktop-definition-services.js";

describe("desktop definition services", () => {
  it("persists the provider-neutral Project, Requirement, and Change chain", async () => {
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "hunter-desktop-definitions-"),
    );
    const database = new DatabaseSync(":memory:");
    try {
      const composition = createApplicationComposition({
        database,
        externalHandler: {
          execute: async () => {
            throw new Error("PRODUCTION_RUNTIME_NOT_CONFIGURED");
          },
        },
        verifier: {
          verify: async () => {
            throw new Error("PRODUCTION_VERIFIER_NOT_CONFIGURED");
          },
        },
        installSecret: "desktop-definition-test-secret",
        allowedHosts: ["hunter-test.localhost"],
        allowedOrigins: ["app://hunter"],
        contentDirectory: dataDirectory,
        now: () => new Date("2026-07-24T03:00:00.000Z"),
      });
      const definitions = createDesktopDefinitionServices({
        database,
        services: composition.services,
        dataDirectory,
        now: () => new Date("2026-07-24T03:00:00.000Z"),
      });
      const actor = {
        actorId: "desktop",
        correlationId: "desktop-definitions",
      };
      const projectCommand = CreateProjectHttpRequestSchema.parse({
        projectId: "prj_desktopdefs1",
        name: "Desktop definitions",
        expectedVersion: 0,
        idempotencyKey: "desktop-project-create-1",
      });

      const created = definitions.createProject(projectCommand, actor);
      expect(
        definitions.createProject(projectCommand, actor),
      ).toEqual(created);
      expect(definitions.listProjectIds()).toEqual([
        projectCommand.projectId,
      ]);
      const project = definitions.getProject(projectCommand.projectId);
      if (project?.planningDefaults === undefined) {
        throw new Error("PLANNING_DEFAULTS_MISSING");
      }
      const createdEvent = database.prepare(
        `SELECT event_data
           FROM events
          WHERE aggregate_id = ?
            AND event_type = 'ProjectCreated'`,
      ).get(`project:${projectCommand.projectId}`) as {
        readonly event_data: string;
      };
      expect(
        JSON.parse(createdEvent.event_data),
      ).toMatchObject({
        projectWorkflowBinding: {
          projectId: projectCommand.projectId,
          currentWorkflowRevisionId:
            project.planningDefaults.workflowRevisionId,
          version: 0,
        },
      });
      expect("appendProjectRepository" in definitions).toBe(true);
      const appendProjectRepository = (
        definitions as unknown as {
          appendProjectRepository(
            projectId: typeof projectCommand.projectId,
            command: AppendProjectRepositoryHttpRequest,
            actor: {
              readonly actorId: string;
              readonly correlationId: string;
            },
          ): AppendProjectRepositoryHttpResponse;
        }
      ).appendProjectRepository.bind(definitions);
      const appendCommand = AppendProjectRepositoryHttpRequestSchema.parse({
        repositoryId: "rep_desktopdefs2",
        expectedVersion: project.repositoryBindingVersion,
        idempotencyKey: "desktop-repository-append-1",
      });
      const appended = appendProjectRepository(
        projectCommand.projectId,
        appendCommand,
        actor,
      );
      expect(appended).toEqual({
        projectId: projectCommand.projectId,
        repositoryBindingVersion: 1,
        repositoryBinding: {
          repositoryId: appendCommand.repositoryId,
          role: "secondary",
        },
      });
      expect(
        appendProjectRepository(projectCommand.projectId, appendCommand, actor),
      ).toEqual(appended);
      const expandedProject = definitions.getProject(
        projectCommand.projectId,
      );
      expect(expandedProject?.repositoryBindingVersion).toBe(1);
      expect(expandedProject?.repositoryBindings).toEqual([
        project.repositoryBindings[0],
        appended.repositoryBinding,
      ]);
      expect(expandedProject?.planningDefaults?.repositoryIds).toEqual(
        expandedProject?.repositoryBindings.map(
          ({ repositoryId }) => repositoryId,
        ),
      );
      composition.services.journal.commitCommand({
        commandId: "desktop-unrelated-repository-event",
        requestFingerprint: "f".repeat(64),
        projectId: projectCommand.projectId,
        aggregateId: `unrelated:${projectCommand.projectId}`,
        expectedVersion: 0,
        actor,
        events: [{
          eventId: "evt_desktop_unrelated_repository",
          eventType: "RepositoryBound",
          eventData: {
            projectId: projectCommand.projectId,
            repositoryBinding: {
              repositoryId: "rep_unrelatedbinding",
              role: "secondary",
            },
            deviceBinding: {
              deviceBindingId: "dev_unrelatedbinding",
              deviceId: "dvc_unrelatedbinding",
              repositoryId: "rep_unrelatedbinding",
              localPath: "C:\\fixtures\\unrelated",
              availability: "unknown",
            },
          },
          schemaVersion: 1,
          occurredAt: "2026-07-24T03:05:00.000Z",
        }],
        operations: [],
        response: {},
      });
      expect(
        definitions.getProject(projectCommand.projectId)
          ?.repositoryBindings,
      ).toEqual(expandedProject?.repositoryBindings);

      const draft = definitions.requirements.createRequirement(
        projectCommand.projectId,
        CreateRequirementHttpRequestSchema.parse({
          requirementId: "req_desktopdefs1",
          revisionId: "rrv_desktopdefs1",
          title: "Persist definitions",
          body: "Keep the product chain in Hunter-owned storage.",
          acceptanceCriteria: ["Restart returns the approved revision"],
          constraints: ["Provider-neutral"],
          expectedVersion: 0,
          idempotencyKey: "desktop-requirement-create-1",
        }),
        actor,
      );
      expect(draft.aggregateVersion).toBe(1);
      const approved = definitions.requirements.approveRequirement(
        projectCommand.projectId,
        draft.revisionId,
        {
          expectedVersion: draft.aggregateVersion,
          idempotencyKey: "desktop-requirement-approve-1",
        },
        actor,
      );
      expect(approved).toMatchObject({
        status: "approved",
        aggregateVersion: 2,
      });

      const publishCommand = PublishChangeHttpRequestSchema.parse({
        changeId: "chg_desktopdefs1",
        changeRevisionId: "crv_desktopdefs1",
        executionPlanId: "epl_desktopdefs1",
        title: "Ship desktop composition",
        goal: "Wire the desktop product chain.",
        nonGoals: ["Select a production Provider"],
        requirementRevisionIds: [approved.revisionId],
        repositoryIds: project.planningDefaults.repositoryIds,
        acceptanceCriteria: ["Published plan is persisted"],
        constraints: ["Runtime remains fail-closed"],
        risks: ["Provider unavailable"],
        dependsOnChangeRevisionIds: [],
        tasks: [{
          taskId: "tsk_desktopdefs1",
          title: "Compose",
          objective: "Compose the Hunter-owned application services.",
          acceptanceCriteria: ["Contract suite passes"],
          repositoryIds: project.planningDefaults.repositoryIds,
          moduleScopes: ["apps"],
          dependsOn: [],
          readSet: ["apps"],
          writeSet: ["apps"],
          access: "write",
          workflowRevisionId:
            project.planningDefaults.workflowRevisionId,
          defaultAgentProfileId:
            project.planningDefaults.defaultAgentProfileId,
          sessionPolicy: project.planningDefaults.sessionPolicy,
          workspacePolicy: project.planningDefaults.workspacePolicy,
        }],
        expectedVersion: 0,
        idempotencyKey: "desktop-change-publish-1",
      });
      expect(definitions.changes.publishChange(
        projectCommand.projectId,
        publishCommand,
        actor,
      )).toMatchObject({
        projectId: projectCommand.projectId,
        status: "published",
      });
      const publishedPlan = composition.services.repositories
        .getExecutionPlan(publishCommand.executionPlanId);
      expect(
        publishedPlan?.tasks.map(({ workflowRevisionId }) =>
          workflowRevisionId),
      ).toEqual([project.planningDefaults.workflowRevisionId]);
      const pinnedRunId = RunIdSchema.parse("run_desktopdefs1");
      await composition.startRun.execute({
        runId: pinnedRunId,
        executionPlanId: publishCommand.executionPlanId,
        workflowRevisionId: project.planningDefaults.workflowRevisionId,
        expectedVersion: 0,
        idempotencyKey: "desktop-run-start-before-migration",
      }, actor);
      expect(
        composition.services.flowStore.loadRun(pinnedRunId)?.binding
          .workflowRevisionId,
      ).toBe(project.planningDefaults.workflowRevisionId);
      const currentWorkflow = composition.services.repositories
        .getWorkflowRevision(project.planningDefaults.workflowRevisionId);
      if (currentWorkflow === null) {
        throw new Error("CURRENT_WORKFLOW_MISSING");
      }
      const candidateWorkflow = createWorkflowRevision({
        workflowId: currentWorkflow.workflowId,
        workflowRevisionId: WorkflowRevisionIdSchema.parse(
          "wfr_desktopdefs2",
        ),
        title: "Hunter provider-neutral delivery v2",
        status: currentWorkflow.status,
        entryStepId: currentWorkflow.entryStepId,
        steps: currentWorkflow.steps,
        routes: currentWorkflow.routes.map((route, index) =>
          index === 0
            ? { ...route, priority: route.priority + 1 }
            : route),
        loops: currentWorkflow.loops,
        publishedAt: "2026-07-24T03:30:00.000Z",
      });
      composition.services.journal.commitCommand({
        commandId: "desktop-workflow-candidate-seed",
        requestFingerprint: canonicalSha256(candidateWorkflow),
        projectId: projectCommand.projectId,
        aggregateId: `workflow:${candidateWorkflow.workflowRevisionId}`,
        expectedVersion: 0,
        actor,
        events: [{
          eventId: "evt_desktop_workflow_candidate",
          eventType: "WorkflowRevisionPublished",
          eventData: {
            workflowRevisionId: candidateWorkflow.workflowRevisionId,
            workflowRevision: candidateWorkflow,
          },
          schemaVersion: 1,
          occurredAt: candidateWorkflow.publishedAt,
        }],
        operations: [],
        response: {},
      });
      expect("getProjectWorkflowBinding" in definitions).toBe(true);
      expect("previewProjectWorkflowMigration" in definitions).toBe(true);
      expect("confirmProjectWorkflowMigration" in definitions).toBe(true);
      const workflowServices = definitions as unknown as {
        getProjectWorkflowBinding(
          projectId: typeof projectCommand.projectId,
        ): ProjectWorkflowBindingHttpResponse;
        previewProjectWorkflowMigration(
          projectId: typeof projectCommand.projectId,
          request: { readonly toWorkflowRevisionId: string },
        ): ProjectWorkflowMigrationPreviewHttpResponse;
        confirmProjectWorkflowMigration(
          projectId: typeof projectCommand.projectId,
          command: ConfirmProjectWorkflowMigrationHttpRequest,
          actor: {
            readonly actorId: string;
            readonly correlationId: string;
          },
        ): ConfirmProjectWorkflowMigrationHttpResponse;
      };
      const initialBinding = workflowServices.getProjectWorkflowBinding(
        projectCommand.projectId,
      );
      expect(initialBinding).toEqual({
        projectId: projectCommand.projectId,
        currentWorkflowRevisionId:
          project.planningDefaults.workflowRevisionId,
        workflowBindingVersion: 0,
      });
      const preview = workflowServices.previewProjectWorkflowMigration(
        projectCommand.projectId,
        { toWorkflowRevisionId: candidateWorkflow.workflowRevisionId },
      );
      expect(preview).toMatchObject({
        projectId: projectCommand.projectId,
        workflowBindingVersion: 0,
        fromWorkflowRevisionId:
          project.planningDefaults.workflowRevisionId,
        toWorkflowRevisionId: candidateWorkflow.workflowRevisionId,
        changes: {
          titleChanged: true,
          entryStepChanged: false,
          addedStepIds: [],
          removedStepIds: [],
          changedStepIds: [],
          routesChanged: true,
          loopsChanged: false,
          routeCountChanged: false,
          loopCountChanged: false,
        },
        compatibility: {
          status: "review_required",
          reasonCodes: ["routes_changed"],
        },
      });
      const confirmCommand =
        ConfirmProjectWorkflowMigrationHttpRequestSchema.parse({
          fromWorkflowRevisionId: preview.fromWorkflowRevisionId,
          toWorkflowRevisionId: preview.toWorkflowRevisionId,
          previewFingerprint: preview.previewFingerprint,
          expectedVersion: preview.workflowBindingVersion,
          idempotencyKey: "desktop-workflow-migration-confirm-1",
        });
      const migrated = workflowServices.confirmProjectWorkflowMigration(
        projectCommand.projectId,
        confirmCommand,
        actor,
      );
      expect(migrated).toEqual({
        projectId: projectCommand.projectId,
        previousWorkflowRevisionId:
          project.planningDefaults.workflowRevisionId,
        currentWorkflowRevisionId: candidateWorkflow.workflowRevisionId,
        workflowBindingVersion: 1,
        status: "migrated",
      });
      expect(
        workflowServices.confirmProjectWorkflowMigration(
          projectCommand.projectId,
          confirmCommand,
          actor,
        ),
      ).toEqual(migrated);
      expect(
        definitions.getProject(projectCommand.projectId)
          ?.planningDefaults?.workflowRevisionId,
      ).toBe(candidateWorkflow.workflowRevisionId);
      const staleWorkflowPublish =
        PublishChangeHttpRequestSchema.parse({
          ...publishCommand,
          changeId: "chg_desktopdefs2",
          changeRevisionId: "crv_desktopdefs2",
          executionPlanId: "epl_desktopdefs2",
          tasks: publishCommand.tasks.map((task) => ({
            ...task,
            taskId: "tsk_desktopdefs2",
            workflowRevisionId: task.workflowRevisionId,
          })),
          idempotencyKey: "desktop-stale-workflow-publish",
        });
      expect(() =>
        definitions.changes.publishChange(
          projectCommand.projectId,
          staleWorkflowPublish,
          actor,
        ),
      ).toThrow("PROJECT_WORKFLOW_BINDING_MISMATCH");
      expect(
        composition.services.repositories
          .getExecutionPlan(publishCommand.executionPlanId)
          ?.tasks.map(({ workflowRevisionId }) => workflowRevisionId),
      ).toEqual([project.planningDefaults.workflowRevisionId]);
      expect(
        composition.services.flowStore.loadRun(pinnedRunId)?.binding
          .workflowRevisionId,
      ).toBe(project.planningDefaults.workflowRevisionId);
      const grandfatheredRunId = RunIdSchema.parse(
        "run_desktopdefs2",
      );
      await composition.startRun.execute({
        runId: grandfatheredRunId,
        executionPlanId: publishCommand.executionPlanId,
        workflowRevisionId: project.planningDefaults.workflowRevisionId,
        expectedVersion: 0,
        idempotencyKey: "desktop-run-start-after-migration",
      }, actor);
      expect(
        composition.services.flowStore.loadRun(grandfatheredRunId)?.binding
          .workflowRevisionId,
      ).toBe(project.planningDefaults.workflowRevisionId);
      await expect(
        composition.startRun.execute({
          runId: RunIdSchema.parse("run_desktopdefs3"),
          executionPlanId: publishCommand.executionPlanId,
          workflowRevisionId: candidateWorkflow.workflowRevisionId,
          expectedVersion: 0,
          idempotencyKey: "desktop-run-unrelated-after-migration",
        }, actor),
      ).rejects.toThrow(
        "EXECUTION_PLAN_WORKFLOW_REVISION_MISMATCH",
      );

      const reconstructed = createDesktopDefinitionServices({
        database,
        services: composition.services,
        dataDirectory,
        now: () => new Date("2026-07-24T04:00:00.000Z"),
      }).getProject(projectCommand.projectId);
      expect(reconstructed?.requirements).toEqual([approved]);
      expect(reconstructed?.repositoryBindings).toEqual(
        expandedProject?.repositoryBindings,
      );
      expect(reconstructed?.repositoryBindingVersion).toBe(1);
      expect(
        reconstructed?.planningDefaults?.workflowRevisionId,
      ).toBe(candidateWorkflow.workflowRevisionId);
    } finally {
      database.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
