import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { RuntimeOperationHandler } from "./runtime-operation-handler.js";

describe("RuntimeOperationHandler", () => {
  it("has no event append or in-memory authority", async () => {
    const source = await readFile(new URL("./runtime-operation-handler.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/append|RunSucceeded|StepSucceeded|new Map/iu);
    expect(RuntimeOperationHandler).toBeTypeOf("function");
  });
});
