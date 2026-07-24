import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface DesktopPackage {
  readonly build?: {
    readonly electronDist?: string;
  };
}

describe("desktop packaging configuration", () => {
  it("lets electron-builder resolve Electron without assuming a hoisted node_modules layout", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as DesktopPackage;

    expect(packageJson.build?.electronDist).toBeUndefined();
  });
});
