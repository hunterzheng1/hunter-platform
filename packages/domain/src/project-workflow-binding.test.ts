import { describe, expect, it } from "vitest";

import {
  ProjectIdSchema,
  WorkflowRevisionIdSchema,
} from "./ids.js";

const ids = {
  project: ProjectIdSchema.parse("prj_workflowbinding"),
  current: WorkflowRevisionIdSchema.parse("wfr_workflowcurrent"),
  candidate: WorkflowRevisionIdSchema.parse("wfr_workflowcandidate"),
};

describe("Project WorkflowRevision binding", () => {
  it("migrates an immutable binding only from its exact current revision and version", async () => {
    const domain = await import("./index.js") as Record<string, unknown>;
    expect(domain.createProjectWorkflowBinding).toEqual(expect.any(Function));
    expect(domain.migrateProjectWorkflowBinding).toEqual(expect.any(Function));
    const create = domain.createProjectWorkflowBinding as (
      input: unknown,
    ) => {
      readonly projectId: typeof ids.project;
      readonly currentWorkflowRevisionId: typeof ids.current;
      readonly version: number;
    };
    const migrate = domain.migrateProjectWorkflowBinding as (
      current: ReturnType<typeof create>,
      input: unknown,
    ) => ReturnType<typeof create>;
    const original = create({
      projectId: ids.project,
      currentWorkflowRevisionId: ids.current,
      version: 0,
    });

    const migrated = migrate(original, {
      fromWorkflowRevisionId: ids.current,
      toWorkflowRevisionId: ids.candidate,
      expectedVersion: 0,
    });

    expect(migrated).toEqual({
      projectId: ids.project,
      currentWorkflowRevisionId: ids.candidate,
      version: 1,
    });
    expect(original.currentWorkflowRevisionId).toBe(ids.current);
    expect(Object.isFrozen(migrated)).toBe(true);
  });

  it("rejects stale, mismatched, and no-op migrations", async () => {
    const domain = await import("./index.js") as Record<string, unknown>;
    expect(domain.createProjectWorkflowBinding).toEqual(expect.any(Function));
    expect(domain.migrateProjectWorkflowBinding).toEqual(expect.any(Function));
    const create = domain.createProjectWorkflowBinding as (
      input: unknown,
    ) => {
      readonly projectId: typeof ids.project;
      readonly currentWorkflowRevisionId: typeof ids.current;
      readonly version: number;
    };
    const migrate = domain.migrateProjectWorkflowBinding as (
      current: ReturnType<typeof create>,
      input: unknown,
    ) => ReturnType<typeof create>;
    const binding = create({
      projectId: ids.project,
      currentWorkflowRevisionId: ids.current,
      version: 2,
    });

    expect(() =>
      migrate(binding, {
        fromWorkflowRevisionId: ids.current,
        toWorkflowRevisionId: ids.candidate,
        expectedVersion: 1,
      }),
    ).toThrowError("PROJECT_WORKFLOW_BINDING_VERSION_CONFLICT");
    expect(() =>
      migrate(binding, {
        fromWorkflowRevisionId: ids.candidate,
        toWorkflowRevisionId: ids.current,
        expectedVersion: 2,
      }),
    ).toThrowError("PROJECT_WORKFLOW_BINDING_SOURCE_MISMATCH");
    expect(() =>
      migrate(binding, {
        fromWorkflowRevisionId: ids.current,
        toWorkflowRevisionId: ids.current,
        expectedVersion: 2,
      }),
    ).toThrowError("PROJECT_WORKFLOW_BINDING_NO_CHANGE");
  });
});
