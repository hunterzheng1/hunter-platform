import { z } from "zod";

import {
  ProjectIdSchema,
  WorkflowRevisionIdSchema,
  type ProjectId,
  type WorkflowRevisionId,
} from "./ids.js";
import { deepFreeze } from "./immutable.js";

export interface ProjectWorkflowBinding {
  readonly projectId: ProjectId;
  readonly currentWorkflowRevisionId: WorkflowRevisionId;
  readonly version: number;
}

export const ProjectWorkflowBindingSchema = z
  .object({
    projectId: ProjectIdSchema,
    currentWorkflowRevisionId: WorkflowRevisionIdSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

const ProjectWorkflowMigrationSchema = z
  .object({
    fromWorkflowRevisionId: WorkflowRevisionIdSchema,
    toWorkflowRevisionId: WorkflowRevisionIdSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export function createProjectWorkflowBinding(
  input: unknown,
): Readonly<ProjectWorkflowBinding> {
  return deepFreeze(ProjectWorkflowBindingSchema.parse(input));
}

export function migrateProjectWorkflowBinding(
  currentInput: unknown,
  migrationInput: unknown,
): Readonly<ProjectWorkflowBinding> {
  const current = ProjectWorkflowBindingSchema.parse(currentInput);
  const migration = ProjectWorkflowMigrationSchema.parse(migrationInput);
  if (migration.expectedVersion !== current.version) {
    throw new Error("PROJECT_WORKFLOW_BINDING_VERSION_CONFLICT");
  }
  if (
    migration.fromWorkflowRevisionId
    !== current.currentWorkflowRevisionId
  ) {
    throw new Error("PROJECT_WORKFLOW_BINDING_SOURCE_MISMATCH");
  }
  if (
    migration.toWorkflowRevisionId
    === migration.fromWorkflowRevisionId
  ) {
    throw new Error("PROJECT_WORKFLOW_BINDING_NO_CHANGE");
  }
  return createProjectWorkflowBinding({
    projectId: current.projectId,
    currentWorkflowRevisionId: migration.toWorkflowRevisionId,
    version: current.version + 1,
  });
}
