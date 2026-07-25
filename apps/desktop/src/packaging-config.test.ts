import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface DesktopPackage {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly build?: {
    readonly electronDist?: string;
    readonly files?: readonly string[];
    readonly nsis?: {
      readonly deleteAppDataOnUninstall?: boolean;
    };
  };
}

describe("desktop packaging configuration", () => {
  it("lets electron-builder resolve Electron without assuming a hoisted node_modules layout", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as DesktopPackage;

    expect(packageJson.build?.electronDist).toBeUndefined();
  });

  it("preserves user data on uninstall and runs the temporary-root lifecycle smoke after packaging", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as DesktopPackage;

    expect(packageJson.build?.nsis?.deleteAppDataOnUninstall).toBe(false);
    expect(packageJson.scripts?.["smoke:install-lifecycle"]).toBe(
      "node scripts/verify-install-lifecycle.mjs",
    );
    expect(packageJson.scripts?.["pack:win"]).toMatch(
      /electron-builder --win nsis --x64 && npm run smoke:install-lifecycle$/u,
    );
    expect(packageJson.build?.files).not.toContain("src/install-lifecycle.test.ts");
  });
});
