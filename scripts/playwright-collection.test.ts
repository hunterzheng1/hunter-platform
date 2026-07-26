import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import playwrightConfig from "../playwright.config.js";

const repositoryRoot = new URL("../", import.meta.url);
const e2eRoot = new URL("../e2e/", import.meta.url);

function project(name: string) {
  const candidate = playwrightConfig.projects?.find(
    (entry) => entry.name === name,
  );
  expect(candidate, `${name} project`).toBeDefined();
  return candidate!;
}

describe("Playwright collection boundaries", () => {
  it("collects only executable spec files", () => {
    expect(playwrightConfig.testMatch).toEqual("**/*.spec.ts");
  });

  it("keeps desktop and mobile scenarios in separate projects", () => {
    expect(project("chromium")).toMatchObject({
      testIgnore: "**/mobile-security.spec.ts",
    });
    expect(project("mobile")).toMatchObject({
      testMatch: "**/mobile-security.spec.ts",
    });
  });

  it("lets the configured webServer own the complete suite lifecycle", () => {
    expect(playwrightConfig.globalSetup).toBe(
      "./scripts/e2e-suite-lifecycle.ts",
    );
    const offenders = readdirSync(e2eRoot)
      .filter((name) => name.endsWith(".spec.ts"))
      .filter((name) =>
        readFileSync(new URL(name, e2eRoot), "utf8").includes(
          "/__e2e_shutdown",
        )
      );
    expect(offenders).toEqual([]);
  });

  it("runs the complete Chromium suite in the vertical-slice CI job", () => {
    const workflow = readFileSync(
      new URL(".github/workflows/ci.yml", repositoryRoot),
      "utf8",
    );
    expect(workflow).toContain("npx playwright test --project=chromium");
    expect(workflow).not.toContain(
      "npx playwright test e2e/vertical-slice.spec.ts --project=chromium",
    );
  });
});
