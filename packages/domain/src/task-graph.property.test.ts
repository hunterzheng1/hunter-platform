import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  AgentProfileIdSchema,
  RepositoryIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  validateTaskGraph,
} from "./index.js";

const repositoryId = RepositoryIdSchema.parse("rep_primary01");
const workflowRevisionId = WorkflowRevisionIdSchema.parse("wfr_workflow01");
const agentProfileId = AgentProfileIdSchema.parse("apr_profile01");

function task(index: number) {
  return {
    taskId: TaskIdSchema.parse(`tsk_task${String(index).padStart(4, "0")}`),
    title: `Task ${index}`,
    objective: `Objective ${index}`,
    acceptanceCriteria: [`Criterion ${index}`],
    repositoryIds: [repositoryId],
    moduleScopes: [`module-${index}`],
    dependsOn: index === 0 ? [] : [TaskIdSchema.parse(`tsk_task${String(index - 1).padStart(4, "0")}`)],
    readSet: [],
    writeSet: [`module-${index}`],
    access: "write" as const,
    workflowRevisionId,
    defaultAgentProfileId: agentProfileId,
    sessionPolicy: "new" as const,
    workspacePolicy: { mode: "write" as const, isolation: "worktree" as const, reuse: false },
  };
}

describe("TaskGraph canonicalization", () => {
  it("has the same validity and fingerprint for every Task serialization order", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }), (order) => {
        const result = validateTaskGraph(order.map(task));
        expect(result.taskGraphFingerprint).toBe(validateTaskGraph([0, 1, 2, 3].map(task)).taskGraphFingerprint);
      }),
    );
  });
});
