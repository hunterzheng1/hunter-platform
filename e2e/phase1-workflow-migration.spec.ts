import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ProjectDetailHttpResponseSchema,
  ProjectWorkflowBindingHttpResponseSchema,
  ProjectWorkflowMigrationPreviewHttpResponseSchema,
} from "@hunter/api-contracts";
import {
  ProjectIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  createWorkflowRevision,
} from "@hunter/domain";
import { expect, test } from "@playwright/test";

import { buildApp } from "../apps/daemon/src/app.js";
import { createApplicationComposition } from "../apps/daemon/src/services/composition-root.js";
import { createDesktopDefinitionServices } from "../apps/daemon/src/services/desktop-definition-services.js";

const host = "hunter-test.localhost";
const origin = "app://hunter";
const installSecret = "phase1-workflow-migration-secret";
const csrf = "phase1-workflow-csrf";
const projectId = ProjectIdSchema.parse("prj_h4workflow01");

function createRuntime(database: DatabaseSync, dataDirectory: string) {
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
    installSecret,
    allowedHosts: [host],
    allowedOrigins: [origin],
    contentDirectory: dataDirectory,
    now: () => new Date("2026-07-25T08:00:00.000Z"),
  });
  const definitions = createDesktopDefinitionServices({
    database,
    services: composition.services,
    dataDirectory,
    now: () => new Date("2026-07-25T08:00:00.000Z"),
  });
  const app = buildApp({
    authenticator: composition.services.authenticator,
    allowedHosts: [host],
    allowedOrigins: [origin],
    services: {
      listProjects: async (authorizedProjectIds) =>
        authorizedProjectIds.flatMap((authorizedProjectId) => {
          const project = definitions.getProject(authorizedProjectId);
          return project === null
            ? []
            : [{ projectId: project.projectId, name: project.name }];
        }),
      createProject: async (command, actor) =>
        definitions.createProject(command, actor),
      getProject: async (requestedProjectId) =>
        definitions.getProject(requestedProjectId),
      appendProjectRepository: async (requestedProjectId, command, actor) =>
        definitions.appendProjectRepository(
          requestedProjectId,
          command,
          actor,
        ),
      getProjectWorkflowBinding: async (requestedProjectId) =>
        definitions.getProjectWorkflowBinding(requestedProjectId),
      previewProjectWorkflowMigration: async (requestedProjectId, request) =>
        definitions.previewProjectWorkflowMigration(
          requestedProjectId,
          request,
        ),
      confirmProjectWorkflowMigration: async (
        requestedProjectId,
        command,
        actor,
      ) =>
        definitions.confirmProjectWorkflowMigration(
          requestedProjectId,
          command,
          actor,
        ),
      projectForExecutionPlan: (executionPlanId) => {
        const plan = composition.services.repositories.getExecutionPlan(
          executionPlanId,
        );
        return plan === null
          ? null
          : {
              projectId: plan.projectId,
              executionPlanId: plan.executionPlanId,
            };
      },
      projectForRun: (runId) => {
        const run = composition.services.flowStore.loadRun(runId);
        return run === null
          ? null
          : { projectId: run.binding.projectId, runId: run.binding.runId };
      },
      startRun: async (command, actor) =>
        composition.startRun.execute(command, actor),
    },
  });
  return { app, composition, definitions };
}

test("appends a secondary Repository without regressing an isolated single-Repository Project", async () => {
  const dataDirectory = mkdtempSync(
    join(tmpdir(), "hunter-h4-project-repositories-"),
  );
  const databasePath = join(dataDirectory, "hunter.sqlite");
  const projectA = ProjectIdSchema.parse("prj_h4projecta01");
  const projectB = ProjectIdSchema.parse("prj_h4projectb01");
  let database = new DatabaseSync(databasePath);
  let runtime = createRuntime(database, dataDirectory);
  runtime.composition.services.setPrincipalProjectAuthorization(
    "h4-owner",
    [projectA, projectB],
  );
  const token = runtime.composition.services.authenticator.issueSession({
    principalId: "h4-owner",
    authorizedProjectIds: [projectA, projectB],
    expiresAt: new Date(Date.now() + 10 * 60_000),
    csrf,
  });
  const headers = {
    host,
    origin,
    authorization: `Bearer ${token}`,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };

  try {
    for (const [createdProjectId, name] of [
      [projectA, "H4 multi-repository Project"],
      [projectB, "H4 single-repository Project"],
    ] as const) {
      const created = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: {
          projectId: createdProjectId,
          name,
          expectedVersion: 0,
          idempotencyKey: `h4-create-${createdProjectId}`,
        },
      });
      expect(created.statusCode).toBe(201);
    }

    const beforeA = ProjectDetailHttpResponseSchema.parse(
      (await runtime.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectA}`,
        headers,
      })).json(),
    );
    const beforeB = ProjectDetailHttpResponseSchema.parse(
      (await runtime.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectB}`,
        headers,
      })).json(),
    );
    expect(beforeA.repositoryBindings).toHaveLength(1);
    expect(beforeB.repositoryBindings).toHaveLength(1);
    expect(beforeA.repositoryBindingVersion).toBe(0);
    expect(beforeB.repositoryBindingVersion).toBe(0);

    const appendPayload = {
      repositoryId: "rep_h4secondary01",
      expectedVersion: beforeA.repositoryBindingVersion,
      idempotencyKey: "h4-project-a-repository-append",
    };
    const appended = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/repositories`,
      headers,
      payload: appendPayload,
    });
    expect(appended.statusCode).toBe(201);
    expect(appended.json()).toMatchObject({
      projectId: projectA,
      repositoryBindingVersion: 1,
      repositoryBinding: {
        repositoryId: appendPayload.repositoryId,
        role: "secondary",
      },
    });

    const replay = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/repositories`,
      headers,
      payload: appendPayload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(appended.json());

    await runtime.app.close();
    database.close();
    database = new DatabaseSync(databasePath);
    runtime = createRuntime(database, dataDirectory);

    const afterA = ProjectDetailHttpResponseSchema.parse(
      (await runtime.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectA}`,
        headers,
      })).json(),
    );
    const afterB = ProjectDetailHttpResponseSchema.parse(
      (await runtime.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectB}`,
        headers,
      })).json(),
    );
    expect(afterA.repositoryBindingVersion).toBe(1);
    expect(afterA.repositoryBindings).toEqual([
      beforeA.repositoryBindings[0],
      {
        repositoryId: appendPayload.repositoryId,
        role: "secondary",
      },
    ]);
    if (afterA.planningDefaults === undefined) {
      throw new Error("H4_PROJECT_A_PLANNING_DEFAULTS_MISSING");
    }
    expect(afterA.planningDefaults.repositoryIds).toEqual(
      afterA.repositoryBindings.map(({ repositoryId }) => repositoryId),
    );
    expect(afterB).toMatchObject({
      repositoryBindingVersion: 0,
      repositoryBindings: beforeB.repositoryBindings,
    });
  } finally {
    await runtime.app.close();
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("explicitly confirms a WorkflowRevision migration and reconstructs it after restart", async () => {
  const dataDirectory = mkdtempSync(
    join(tmpdir(), "hunter-h4-workflow-migration-"),
  );
  const databasePath = join(dataDirectory, "hunter.sqlite");
  let database = new DatabaseSync(databasePath);
  let runtime = createRuntime(database, dataDirectory);
  runtime.composition.services.setPrincipalProjectAuthorization(
    "h4-owner",
    [projectId],
  );
  const token = runtime.composition.services.authenticator.issueSession({
    principalId: "h4-owner",
    authorizedProjectIds: [projectId],
    expiresAt: new Date(Date.now() + 10 * 60_000),
    csrf,
  });
  const headers = {
    host,
    origin,
    authorization: `Bearer ${token}`,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };

  try {
    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: {
        projectId,
        name: "H4 workflow migration",
        expectedVersion: 0,
        idempotencyKey: "h4-workflow-project-create",
      },
    });
    expect(created.statusCode).toBe(201);

    const beforeResponse = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers,
    });
    expect(beforeResponse.statusCode).toBe(200);
    const before = ProjectDetailHttpResponseSchema.parse(
      beforeResponse.json(),
    );
    if (before.planningDefaults === undefined) {
      throw new Error("H4_WORKFLOW_PLANNING_DEFAULTS_MISSING");
    }
    const currentWorkflow =
      runtime.composition.services.repositories.getWorkflowRevision(
        before.planningDefaults.workflowRevisionId,
      );
    if (currentWorkflow === null) {
      throw new Error("H4_CURRENT_WORKFLOW_MISSING");
    }
    const candidateWorkflow = createWorkflowRevision({
      workflowId: currentWorkflow.workflowId,
      workflowRevisionId: WorkflowRevisionIdSchema.parse(
        "wfr_h4workflow02",
      ),
      title: "Hunter provider-neutral delivery H4",
      status: currentWorkflow.status,
      entryStepId: currentWorkflow.entryStepId,
      steps: currentWorkflow.steps,
      routes: currentWorkflow.routes,
      loops: currentWorkflow.loops,
      publishedAt: "2026-07-25T08:30:00.000Z",
    });
    runtime.composition.services.journal.commitCommand({
      commandId: "h4-workflow-candidate-seed",
      requestFingerprint: canonicalSha256(candidateWorkflow),
      projectId,
      aggregateId: `workflow:${candidateWorkflow.workflowRevisionId}`,
      expectedVersion: 0,
      actor: {
        actorId: "h4-fixture",
        correlationId: "h4-workflow-candidate-seed",
      },
      events: [{
        eventId: "evt_h4_workflow_candidate",
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

    const currentResponse = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/workflow-binding`,
      headers,
    });
    expect(currentResponse.statusCode).toBe(200);
    expect(
      ProjectWorkflowBindingHttpResponseSchema.parse(currentResponse.json()),
    ).toEqual({
      projectId,
      currentWorkflowRevisionId:
        before.planningDefaults.workflowRevisionId,
      workflowBindingVersion: 0,
    });

    const previewResponse = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/workflow-migrations/preview`,
      headers,
      payload: {
        toWorkflowRevisionId: candidateWorkflow.workflowRevisionId,
      },
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = ProjectWorkflowMigrationPreviewHttpResponseSchema.parse(
      previewResponse.json(),
    );
    expect(preview).toMatchObject({
      projectId,
      fromWorkflowRevisionId:
        before.planningDefaults.workflowRevisionId,
      toWorkflowRevisionId: candidateWorkflow.workflowRevisionId,
      workflowBindingVersion: 0,
      changes: {
        titleChanged: true,
        entryStepChanged: false,
        addedStepIds: [],
        removedStepIds: [],
        changedStepIds: [],
        routesChanged: false,
        loopsChanged: false,
        routeCountChanged: false,
        loopCountChanged: false,
      },
      compatibility: {
        status: "no_structural_change",
        reasonCodes: [],
      },
    });

    const confirmPayload = {
      fromWorkflowRevisionId: preview.fromWorkflowRevisionId,
      toWorkflowRevisionId: preview.toWorkflowRevisionId,
      previewFingerprint: preview.previewFingerprint,
      expectedVersion: preview.workflowBindingVersion,
      idempotencyKey: "h4-workflow-migration-confirm",
    };
    const confirmed = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/workflow-migrations/confirm`,
      headers,
      payload: confirmPayload,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      projectId,
      previousWorkflowRevisionId:
        before.planningDefaults.workflowRevisionId,
      currentWorkflowRevisionId: candidateWorkflow.workflowRevisionId,
      workflowBindingVersion: 1,
      status: "migrated",
    });

    const replay = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/workflow-migrations/confirm`,
      headers,
      payload: confirmPayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(confirmed.json());

    await runtime.app.close();
    database.close();
    database = new DatabaseSync(databasePath);
    runtime = createRuntime(database, dataDirectory);

    const afterRestart = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers,
    });
    expect(afterRestart.statusCode).toBe(200);
    const reconstructed = ProjectDetailHttpResponseSchema.parse(
      afterRestart.json(),
    );
    if (reconstructed.planningDefaults === undefined) {
      throw new Error("H4_RECONSTRUCTED_PLANNING_DEFAULTS_MISSING");
    }
    expect(reconstructed.planningDefaults.workflowRevisionId).toBe(
      candidateWorkflow.workflowRevisionId,
    );
  } finally {
    await runtime.app.close();
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
