import { describe, expect, it } from "vitest";

describe("Project WorkflowRevision migration HTTP contract", () => {
  it("requires a versioned preview before an idempotent explicit confirmation", async () => {
    const contracts = await import("./index.js") as Record<string, unknown>;
    for (const name of [
      "ProjectWorkflowBindingHttpResponseSchema",
      "ProjectWorkflowMigrationPreviewHttpRequestSchema",
      "ProjectWorkflowMigrationPreviewHttpResponseSchema",
      "ConfirmProjectWorkflowMigrationHttpRequestSchema",
      "ConfirmProjectWorkflowMigrationHttpResponseSchema",
    ]) {
      expect(contracts[name], name).toEqual(expect.any(Object));
    }
    const schema = (name: string) => contracts[name] as {
      parse(input: unknown): unknown;
    };
    const fromWorkflowRevisionId = "wfr_workflowcurrent";
    const toWorkflowRevisionId = "wfr_workflowcandidate";
    const previewFingerprint = "a".repeat(64);
    const current = {
      projectId: "prj_workflowbinding",
      currentWorkflowRevisionId: fromWorkflowRevisionId,
      workflowBindingVersion: 0,
    };
    const previewRequest = { toWorkflowRevisionId };
    const preview = {
      projectId: current.projectId,
      workflowBindingVersion: 0,
      fromWorkflowRevisionId,
      toWorkflowRevisionId,
      fromWorkflowFingerprint: "b".repeat(64),
      toWorkflowFingerprint: "c".repeat(64),
      changes: {
        titleChanged: true,
        entryStepChanged: false,
        addedStepIds: ["stp_workflowadded"],
        removedStepIds: [],
        changedStepIds: ["stp_workflowcurrent"],
        routesChanged: true,
        loopsChanged: false,
        routeCountChanged: false,
        loopCountChanged: false,
      },
      compatibility: {
        status: "review_required",
        reasonCodes: ["steps_added", "steps_changed", "routes_changed"],
      },
      previewFingerprint,
    };
    const confirm = {
      fromWorkflowRevisionId,
      toWorkflowRevisionId,
      previewFingerprint,
      expectedVersion: 0,
      idempotencyKey: "confirm-workflow-migration-1",
    };
    const migrated = {
      projectId: current.projectId,
      previousWorkflowRevisionId: fromWorkflowRevisionId,
      currentWorkflowRevisionId: toWorkflowRevisionId,
      workflowBindingVersion: 1,
      status: "migrated",
    };

    expect(schema("ProjectWorkflowBindingHttpResponseSchema").parse(current))
      .toEqual(current);
    expect(
      schema("ProjectWorkflowMigrationPreviewHttpRequestSchema")
        .parse(previewRequest),
    ).toEqual(previewRequest);
    expect(
      schema("ProjectWorkflowMigrationPreviewHttpResponseSchema")
        .parse(preview),
    ).toEqual(preview);
    expect(
      schema("ConfirmProjectWorkflowMigrationHttpRequestSchema")
        .parse(confirm),
    ).toEqual(confirm);
    expect(
      schema("ConfirmProjectWorkflowMigrationHttpResponseSchema")
        .parse(migrated),
    ).toEqual(migrated);
  });

  it("rejects Provider-private data and confirmation without an exact preview fingerprint", async () => {
    const contracts = await import("./index.js") as Record<string, unknown>;
    expect(contracts.ConfirmProjectWorkflowMigrationHttpRequestSchema)
      .toEqual(expect.any(Object));
    const confirmSchema =
      contracts.ConfirmProjectWorkflowMigrationHttpRequestSchema as {
        parse(input: unknown): unknown;
      };
    const command = {
      fromWorkflowRevisionId: "wfr_workflowcurrent",
      toWorkflowRevisionId: "wfr_workflowcandidate",
      previewFingerprint: "a".repeat(64),
      expectedVersion: 0,
      idempotencyKey: "confirm-workflow-migration-1",
    };
    expect(() =>
      confirmSchema.parse({
        ...command,
        providerSessionId: "private",
      }),
    ).toThrow();
    expect(() =>
      confirmSchema.parse({
        ...command,
        previewFingerprint: "not-a-fingerprint",
      }),
    ).toThrow();
  });
});
