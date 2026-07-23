import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Run Attempt opaque identifiers", () => {
  it("wraps long code values instead of overflowing the Attempt card", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.attempt-card\s+code\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/su);
  });
});
