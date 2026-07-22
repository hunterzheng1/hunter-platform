import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  createHunterDefaultPack,
  loadHunterDefaultPack,
  parseWorkflowAsset,
} from "./load-pack.js";

function validWorkflowAsset() {
  const workflow = loadHunterDefaultPack().workflows[0]!;
  const { workflowId, workflowFingerprint, ...revision } = workflow;
  void workflowFingerprint;
  return { workflowId, revision };
}

describe("hunter-default workflow pack", () => {
  it("publishes stable root Change and Task workflow revisions", () => {
    const pack = loadHunterDefaultPack();

    expect(pack.packId).toBe("hunter-default");
    expect(pack.version).toBe("1.0.0");
    expect(
      pack.workflows.map(({ workflowId, workflowRevisionId }) => ({
        workflowId,
        workflowRevisionId,
      })),
    ).toEqual([
      {
        workflowId: "hunter.change-delivery",
        workflowRevisionId: "wfr_hunter_change_delivery_v1",
      },
      {
        workflowId: "hunter.task-delivery",
        workflowRevisionId: "wfr_hunter_task_delivery_v1",
      },
    ]);
  });

  it("routes the root Change workflow through approval, Task dispatch, integration, and knowledge", () => {
    const root = loadHunterDefaultPack().workflows.find(
      ({ workflowId }) => workflowId === "hunter.change-delivery",
    )!;
    const routes = root.routes.map(({ fromStepId, outcome, toStepId }) => ({
      fromStepId,
      outcome,
      toStepId,
    }));

    expect(root.entryStepId).toBe("stp_change_plan_v1");
    expect(Object.fromEntries(root.steps.map(({ stepId, kind }) => [stepId, kind]))).toEqual({
      stp_change_approve_plan_v1: "human_gate",
      stp_change_archive_v1: "command",
      stp_change_dispatch_tasks_v1: "subflow",
      stp_change_ingest_knowledge_v1: "context",
      stp_change_integrate_v1: "verify",
      stp_change_plan_v1: "agent",
    });
    expect(routes).toEqual(
      expect.arrayContaining([
        {
          fromStepId: "stp_change_plan_v1",
          outcome: "passed",
          toStepId: "stp_change_approve_plan_v1",
        },
        {
          fromStepId: "stp_change_approve_plan_v1",
          outcome: "passed",
          toStepId: "stp_change_dispatch_tasks_v1",
        },
        {
          fromStepId: "stp_change_approve_plan_v1",
          outcome: "canceled",
          toStepId: "stp_change_archive_v1",
        },
        {
          fromStepId: "stp_change_dispatch_tasks_v1",
          outcome: "passed",
          toStepId: "stp_change_integrate_v1",
        },
        {
          fromStepId: "stp_change_dispatch_tasks_v1",
          outcome: "failed",
          toStepId: "stp_change_archive_v1",
        },
        {
          fromStepId: "stp_change_integrate_v1",
          outcome: "passed",
          toStepId: "stp_change_archive_v1",
        },
        {
          fromStepId: "stp_change_integrate_v1",
          outcome: "failed",
          toStepId: "stp_change_dispatch_tasks_v1",
        },
        {
          fromStepId: "stp_change_archive_v1",
          outcome: "passed",
          toStepId: "stp_change_ingest_knowledge_v1",
        },
        {
          fromStepId: "stp_change_ingest_knowledge_v1",
          outcome: "passed",
          toStepId: null,
        },
      ]),
    );

    const dispatch = root.steps.find(({ stepId }) => stepId === "stp_change_dispatch_tasks_v1")!;
    expect(dispatch).toMatchObject({
      kind: "subflow",
      executor: { kind: "subflow", selector: "wfr_hunter_task_delivery_v1" },
      budgetCost: { cost: 1 },
    });

    expect(root.loops).toContainEqual(
      expect.objectContaining({
        fromStepId: "stp_change_integrate_v1",
        toStepId: "stp_change_dispatch_tasks_v1",
        maxIterations: 2,
        maxElapsedMs: 7_200_000,
        maxCost: 1,
        progressPredicate: {
          kind: "verifier_improved",
          source: "verification.outcome",
        },
        stagnation: {
          maxSameFailureFingerprint: 2,
          maxNoDiffIterations: 1,
          maxVerifierErrors: 2,
        },
        reuse: { profile: true, session: false, workspace: true },
        exhaustion: { target: "needs_attention", notify: true },
      }),
    );
  });

  it("routes Task delivery through two bounded feedback loops and an independent review session", () => {
    const task = loadHunterDefaultPack().workflows.find(
      ({ workflowId }) => workflowId === "hunter.task-delivery",
    )!;
    const loopsBySource = Object.fromEntries(task.loops.map((loop) => [loop.fromStepId, loop]));

    expect(task.entryStepId).toBe("stp_task_prepare_context_v1");
    expect(Object.fromEntries(task.steps.map(({ stepId, kind }) => [stepId, kind]))).toEqual({
      stp_task_complete_v1: "verify",
      stp_task_implement_v1: "agent",
      stp_task_prepare_context_v1: "context",
      stp_task_review_v1: "agent",
      stp_task_test_v1: "command",
    });
    expect(task.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromStepId: "stp_task_prepare_context_v1",
          outcome: "passed",
          toStepId: "stp_task_implement_v1",
        }),
        expect.objectContaining({
          fromStepId: "stp_task_implement_v1",
          outcome: "passed",
          toStepId: "stp_task_test_v1",
        }),
        expect.objectContaining({
          fromStepId: "stp_task_test_v1",
          outcome: "passed",
          toStepId: "stp_task_review_v1",
        }),
        expect.objectContaining({
          fromStepId: "stp_task_test_v1",
          outcome: "failed",
          toStepId: "stp_task_implement_v1",
        }),
        expect.objectContaining({
          fromStepId: "stp_task_review_v1",
          outcome: "passed",
          toStepId: "stp_task_complete_v1",
        }),
        expect.objectContaining({
          fromStepId: "stp_task_review_v1",
          outcome: "failed",
          toStepId: "stp_task_implement_v1",
        }),
        expect.objectContaining({
          fromStepId: "stp_task_complete_v1",
          outcome: "passed",
          toStepId: null,
        }),
      ]),
    );
    expect(task.steps.find(({ stepId }) => stepId === "stp_task_implement_v1")).toMatchObject({
      budgetCost: { cost: 1 },
    });
    expect(loopsBySource.stp_task_test_v1).toMatchObject({
      maxIterations: 3,
      maxElapsedMs: 7_200_000,
      maxCost: 2,
      progressPredicate: { kind: "fingerprint_changed", source: "verification.evidence" },
      stagnation: {
        maxSameFailureFingerprint: 2,
        maxNoDiffIterations: 1,
        maxVerifierErrors: 2,
      },
      reuse: { profile: true, session: true, workspace: true },
      exhaustion: { target: "needs_attention", notify: true },
    });
    expect(loopsBySource.stp_task_review_v1).toMatchObject({
      maxIterations: 3,
      maxElapsedMs: 7_200_000,
      maxCost: 2,
      progressPredicate: { kind: "diff_present", source: "workspace.diff" },
      stagnation: {
        maxSameFailureFingerprint: 2,
        maxNoDiffIterations: 1,
        maxVerifierErrors: 2,
      },
      reuse: { profile: true, session: false, workspace: true },
      exhaustion: { target: "needs_attention", notify: true },
    });

    const review = task.steps.find(({ stepId }) => stepId === "stp_task_review_v1")!;
    expect(review.sessionPolicy).toBe("new");
  });

  it("returns canonical, deeply immutable domain revisions", () => {
    const pack = loadHunterDefaultPack();
    const root = pack.workflows[0]!;

    expect(root.workflowFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.workflows)).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.steps)).toBe(true);
    expect(Object.isFrozen(root.steps[0]!.inputContract)).toBe(true);
  });

  it("rejects unknown fields in the workflow asset wrapper", () => {
    expect(() =>
      parseWorkflowAsset({
        ...validWorkflowAsset(),
        unexpected: true,
      }),
    ).toThrow(/unrecognized key/iu);
  });

  it("rejects a workflow identity paired with the wrong revision", () => {
    expect(() =>
      parseWorkflowAsset({
        ...validWorkflowAsset(),
        workflowId: "hunter.task-delivery",
      }),
    ).toThrow(/WORKFLOW_ASSET_IDENTITY_MISMATCH/u);
  });

  it("rejects duplicate and missing workflow identities in a pack", () => {
    const [root, task] = loadHunterDefaultPack().workflows;

    expect(() => createHunterDefaultPack([root!, root!])).toThrow(
      /WORKFLOW_PACK_IDENTITIES_INVALID/u,
    );
    expect(() => createHunterDefaultPack([task!])).toThrow(
      /WORKFLOW_PACK_IDENTITIES_INVALID/u,
    );
    expect(() => createHunterDefaultPack([root!, task!, root!])).toThrow(
      /WORKFLOW_PACK_IDENTITIES_INVALID/u,
    );
  });

  it("normalizes accepted workflow permutations to root then task", () => {
    const [root, task] = loadHunterDefaultPack().workflows;

    expect(createHunterDefaultPack([task!, root!]).workflows.map(({ workflowId }) => workflowId)).toEqual([
      "hunter.change-delivery",
      "hunter.task-delivery",
    ]);
  });

  it("rejects legacy revision and inline step contracts through the domain parser", () => {
    const asset = validWorkflowAsset();
    const { workflowRevisionId, ...revisionWithoutId } = asset.revision;
    void workflowRevisionId;

    const parseLegacyRevision = () =>
      parseWorkflowAsset({
        ...asset,
        revision: {
          ...revisionWithoutId,
          revisionId: "wfr_hunter_change_delivery_v1",
        },
      });
    expect(parseLegacyRevision).toThrow(ZodError);
    expect(parseLegacyRevision).toThrow(/workflowRevisionId|revisionId/u);

    const [firstStep, ...remainingSteps] = asset.revision.steps;
    const parseLegacyStep = () =>
      parseWorkflowAsset({
        ...asset,
        revision: {
          ...asset.revision,
          steps: [
            {
              ...firstStep!,
              next: { onPassed: null },
              outputContract: "hunter.legacy-output.v1",
            },
            ...remainingSteps,
          ],
        },
      });
    expect(parseLegacyStep).toThrow(ZodError);
    expect(parseLegacyStep).toThrow(/next|outputContract/u);
  });
});
