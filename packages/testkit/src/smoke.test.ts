import { describe, expect, it } from "vitest";

describe("hunter workspace", () => {
  it("runs tests as native ESM", () => {
    expect(import.meta.url.startsWith("file:")).toBe(true);
  });
});
