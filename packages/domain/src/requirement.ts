import { z } from "zod";

import {
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
} from "./ids.js";
import type { ProjectId, RequirementId, RequirementRevisionId } from "./ids.js";
import { assertUnique, deepFreeze } from "./immutable.js";

export interface RequirementRevision {
  readonly requirementId: RequirementId;
  readonly revisionId: RequirementRevisionId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly status: "draft" | "in_review" | "approved" | "superseded" | "withdrawn";
  readonly approvedAt?: string | undefined;
}

export const RequirementRevisionSchema = z
  .object({
    requirementId: RequirementIdSchema,
    revisionId: RequirementRevisionIdSchema,
    projectId: ProjectIdSchema,
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    constraints: z.array(z.string().trim().min(1)),
    status: z.enum(["draft", "in_review", "approved", "superseded", "withdrawn"]),
    approvedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((revision, context) => {
    if (revision.status === "approved" && revision.approvedAt === undefined) {
      context.addIssue({ code: "custom", message: "approvedAt is required for approved revisions" });
    }
    if (revision.status !== "approved" && revision.approvedAt !== undefined) {
      context.addIssue({ code: "custom", message: "approvedAt is only valid for approved revisions" });
    }
  });

export function createRequirementRevision(input: unknown): Readonly<RequirementRevision> {
  const parsed = RequirementRevisionSchema.parse(input);
  assertUnique(parsed.acceptanceCriteria, "requirement_acceptance_criterion");
  assertUnique(parsed.constraints, "requirement_constraint");
  return deepFreeze(parsed);
}
