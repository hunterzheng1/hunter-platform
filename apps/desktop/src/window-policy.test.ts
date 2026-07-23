import { describe, expect, it } from "vitest";

import { isAllowedExternalUrl } from "./window-policy.js";

describe("isAllowedExternalUrl", () => {
  it("allows an HTTPS URL without embedded credentials", () => {
    expect(isAllowedExternalUrl("https://docs.example.test/hunter?q=desktop")).toBe(true);
  });

  it.each([
    "http://example.test",
    "file:///C:/private.txt",
    "javascript:alert(1)",
    "https://user:password@example.test",
    "not a url",
  ])("rejects unsafe external target %s", (target) => {
    expect(isAllowedExternalUrl(target)).toBe(false);
  });
});
