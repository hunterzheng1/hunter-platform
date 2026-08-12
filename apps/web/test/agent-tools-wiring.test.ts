import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Agent Tools route wiring", () => {
  it("exposes a peer registry route and navigation item", () => {
    const pagePath = resolve("apps/web/app/agent-tools/page.tsx");
    const centerPath = resolve("apps/web/components/agent-tool-center.tsx");
    const navPath = resolve("apps/web/components/client-layout.tsx");

    expect(existsSync(pagePath)).toBe(true);
    expect(existsSync(centerPath)).toBe(true);
    expect(readFileSync(navPath, "utf8")).toContain('href: "/agent-tools"');
    expect(readFileSync(pagePath, "utf8")).toContain("AgentToolCenter");
  });
});
