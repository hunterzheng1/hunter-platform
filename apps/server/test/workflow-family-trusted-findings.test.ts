import { describe, expect, it } from "vitest";

import type { SensitiveFinding } from "@hunter-harness/core";

import { trustedWorkflowFindingAllowed } from "../src/registry/workflow-family-store.js";

function finding(path: string, ruleId: string): SensitiveFinding {
  return {
    path,
    rule_id: ruleId,
    severity: "high",
    overridable: false,
    fingerprint: `fp:${path}`,
    line: 1,
    column: 1
  };
}

describe("trustedWorkflowFindingAllowed", () => {
  it("allowlists known fixture findings for every installable agent including pi", () => {
    for (const agent of ["claude-code", "codebuddy", "codex", "cursor", "pi"] as const) {
      for (const profile of ["general", "java"] as const) {
        expect(trustedWorkflowFindingAllowed(finding(
          `${profile}/${agent}/contracts/fixtures/managed-execution.json`,
          "HH_WINDOWS_ABSOLUTE_PATH"
        ))).toBe(true);
        expect(trustedWorkflowFindingAllowed(finding(
          `${profile}/${agent}/protocols/sensitive-info-protocol.md`,
          "HH_PASSWORD_VALUE"
        ))).toBe(true);
      }
    }
  });

  it("still rejects findings outside the allowlist", () => {
    expect(trustedWorkflowFindingAllowed(finding(
      "general/pi/notes.md",
      "HH_WINDOWS_ABSOLUTE_PATH"
    ))).toBe(false);
    expect(trustedWorkflowFindingAllowed(finding(
      "general/unknown-agent/contracts/fixtures/managed-execution.json",
      "HH_WINDOWS_ABSOLUTE_PATH"
    ))).toBe(false);
    expect(trustedWorkflowFindingAllowed(finding(
      "general/pi/protocols/sensitive-info-protocol.md",
      "HH_UNKNOWN_RULE"
    ))).toBe(false);
  });
});
