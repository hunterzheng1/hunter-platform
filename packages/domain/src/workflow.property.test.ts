import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createWorkflowRevision } from "./index.js";
import { validWorkflowInput } from "./workflow-test-fixtures.js";

describe("Workflow graph canonicalization", () => {
  it("has the same verdict and fingerprint for every Step/Route order", () => {
    const canonical = createWorkflowRevision(validWorkflowInput());
    const input = validWorkflowInput();
    const stepIndexes = input.steps.map((_step, index) => index);
    const routeIndexes = input.routes.map((_route, index) => index);

    fc.assert(
      fc.property(
        fc.shuffledSubarray(stepIndexes, { minLength: stepIndexes.length, maxLength: stepIndexes.length }),
        fc.shuffledSubarray(routeIndexes, { minLength: routeIndexes.length, maxLength: routeIndexes.length }),
        (stepOrder, routeOrder) => {
          const permutation = validWorkflowInput();
          permutation.steps = stepOrder.map((index) => permutation.steps[index]!);
          permutation.routes = routeOrder.map((index) => permutation.routes[index]!);
          expect(createWorkflowRevision(permutation).workflowFingerprint).toBe(canonical.workflowFingerprint);
        },
      ),
    );
  });
});
