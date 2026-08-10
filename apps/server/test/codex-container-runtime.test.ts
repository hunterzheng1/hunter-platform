import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Codex container runtime", () => {
  it("installs the operating-system CA bundle required by Codex device login", async () => {
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toMatch(/apt-get\s+install[^\n]*ca-certificates/);
  });
});
