import { z } from "zod";

import {
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
} from "./ids.js";
import type {
  ChangeId,
  ChangeRevisionId,
  ProjectId,
  RepositoryId,
  RequirementRevisionId,
} from "./ids.js";
import { assertUnique, deepFreeze } from "./immutable.js";

export interface ChangeRevision {
  readonly changeId: ChangeId;
  readonly revisionId: ChangeRevisionId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string;
  readonly nonGoals: readonly string[];
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly repositoryIds: readonly RepositoryId[];
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly dependsOnChangeRevisionIds: readonly ChangeRevisionId[];
  readonly status: "draft" | "published" | "superseded" | "withdrawn";
  readonly publishedAt?: string | undefined;
}

export const ChangeRevisionSchema = z
  .object({
    changeId: ChangeIdSchema,
    revisionId: ChangeRevisionIdSchema,
    projectId: ProjectIdSchema,
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    nonGoals: z.array(z.string().trim().min(1)),
    requirementRevisionIds: z.array(RequirementRevisionIdSchema).min(1),
    repositoryIds: z.array(RepositoryIdSchema).min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    constraints: z.array(z.string().trim().min(1)),
    risks: z.array(z.string().trim().min(1)),
    dependsOnChangeRevisionIds: z.array(ChangeRevisionIdSchema),
    status: z.enum(["draft", "published", "superseded", "withdrawn"]),
    publishedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((revision, context) => {
    if (revision.status === "published" && revision.publishedAt === undefined) {
      context.addIssue({ code: "custom", message: "publishedAt is required for published revisions" });
    }
    if (revision.status === "draft" && revision.publishedAt !== undefined) {
      context.addIssue({ code: "custom", message: "draft revisions cannot have publishedAt" });
    }
  });

export function createChangeRevision(input: unknown): Readonly<ChangeRevision> {
  const parsed = ChangeRevisionSchema.parse(input);
  assertUnique(parsed.nonGoals, "change_non_goal");
  assertUnique(parsed.requirementRevisionIds, "requirement_revision");
  assertUnique(parsed.repositoryIds, "change_repository");
  assertUnique(parsed.acceptanceCriteria, "change_acceptance_criterion");
  assertUnique(parsed.constraints, "change_constraint");
  assertUnique(parsed.risks, "change_risk");
  assertUnique(parsed.dependsOnChangeRevisionIds, "change_dependency");

  return deepFreeze({
    ...parsed,
    requirementRevisionIds: [...parsed.requirementRevisionIds].sort(),
    repositoryIds: [...parsed.repositoryIds].sort(),
    dependsOnChangeRevisionIds: [...parsed.dependsOnChangeRevisionIds].sort(),
  });
}
