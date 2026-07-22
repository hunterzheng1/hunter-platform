import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { externalObservationCanSucceed } from "./transition-table.js";

describe("Flow safety properties", () => {
  it("no sequence of external observations is sufficient for Step success", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "agent_returned" as const,
            "process_exited" as const,
            "terminal_idle" as const,
            "native_surface_opened" as const,
          ),
          { maxLength: 100 },
        ),
        (facts) => {
          expect(facts.some(externalObservationCanSucceed)).toBe(false);
        },
      ),
    );
  });
});
