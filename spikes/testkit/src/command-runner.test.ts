import { describe, expect, it } from "vitest";
import { NodeCommandRunner } from "./index.js";

describe("node command runner", () => {
  it("records a synchronous spawn denial instead of aborting the inventory", async () => {
    const runner = new NodeCommandRunner(() => {
      const error = new Error("spawn EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    await expect(
      runner.run({
        executable: "blocked-tool",
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      exitCode: null,
      spawnError: "EPERM",
      timedOut: false,
    });
  });
});
