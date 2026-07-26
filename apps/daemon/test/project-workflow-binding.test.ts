import type {
  ConfirmProjectWorkflowMigrationHttpResponse,
  ProjectWorkflowBindingHttpResponse,
  ProjectWorkflowMigrationPreviewHttpResponse,
} from "@hunter/api-contracts";
import {
  WorkflowRevisionIdSchema,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import {
  buildTestApp,
  projectA,
  projectB,
} from "./support/build-test-app.js";

const currentWorkflowRevisionId = WorkflowRevisionIdSchema.parse(
  "wfr_task2workflowcurrent",
);
const candidateWorkflowRevisionId = WorkflowRevisionIdSchema.parse(
  "wfr_task2workflowcandidate",
);

describe("project WorkflowRevision binding routes", () => {
  it("previews and confirms an exact authorized migration without private fields", async () => {
    const getProjectWorkflowBinding = vi.fn(
      async (): Promise<ProjectWorkflowBindingHttpResponse> => ({
        projectId: projectA,
        currentWorkflowRevisionId,
        workflowBindingVersion: 0,
      }),
    );
    const previewProjectWorkflowMigration = vi.fn(
      async (): Promise<ProjectWorkflowMigrationPreviewHttpResponse> => ({
        projectId: projectA,
        workflowBindingVersion: 0,
        fromWorkflowRevisionId: currentWorkflowRevisionId,
        toWorkflowRevisionId: candidateWorkflowRevisionId,
        fromWorkflowFingerprint: "a".repeat(64),
        toWorkflowFingerprint: "b".repeat(64),
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
        previewFingerprint: "c".repeat(64),
      }),
    );
    const confirmProjectWorkflowMigration = vi.fn(
      async (): Promise<ConfirmProjectWorkflowMigrationHttpResponse> => ({
        projectId: projectA,
        previousWorkflowRevisionId: currentWorkflowRevisionId,
        currentWorkflowRevisionId: candidateWorkflowRevisionId,
        workflowBindingVersion: 1,
        status: "migrated",
      }),
    );
    const { app, headers } = buildTestApp({
      getProjectWorkflowBinding,
      previewProjectWorkflowMigration,
      confirmProjectWorkflowMigration,
    });

    const current = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectA}/workflow-binding`,
      headers,
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      currentWorkflowRevisionId,
      workflowBindingVersion: 0,
    });

    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/workflow-migrations/preview`,
      headers,
      payload: { toWorkflowRevisionId: candidateWorkflowRevisionId },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      fromWorkflowRevisionId: currentWorkflowRevisionId,
      toWorkflowRevisionId: candidateWorkflowRevisionId,
      previewFingerprint: "c".repeat(64),
    });

    const confirmPayload = {
      fromWorkflowRevisionId: currentWorkflowRevisionId,
      toWorkflowRevisionId: candidateWorkflowRevisionId,
      previewFingerprint: "c".repeat(64),
      expectedVersion: 0,
      idempotencyKey: "confirm-project-workflow-task2",
    };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/workflow-migrations/confirm`,
      headers,
      payload: confirmPayload,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      currentWorkflowRevisionId: candidateWorkflowRevisionId,
      workflowBindingVersion: 1,
      status: "migrated",
    });
    expect(confirmProjectWorkflowMigration).toHaveBeenCalledWith(
      projectA,
      confirmPayload,
      expect.objectContaining({ actorId: "desktop-owner" }),
    );

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectB}/workflow-binding`,
      headers,
    });
    const privateField = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/workflow-migrations/preview`,
      headers,
      payload: {
        toWorkflowRevisionId: candidateWorkflowRevisionId,
        providerSessionId: "private",
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(privateField.statusCode).toBe(400);
    await app.close();
  });
});
