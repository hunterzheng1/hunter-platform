import { afterEach, describe, expect, it } from "vitest";

import config from "../next.config.js";

const originalInternalApi = process.env.HUNTER_HARNESS_INTERNAL_API_URL;

afterEach(() => {
  if (originalInternalApi === undefined) delete process.env.HUNTER_HARNESS_INTERNAL_API_URL;
  else process.env.HUNTER_HARNESS_INTERNAL_API_URL = originalInternalApi;
});

describe("Next.js internal service rewrites", () => {
  it("proxies both REST API and MCP without exposing the Server host port", async () => {
    process.env.HUNTER_HARNESS_INTERNAL_API_URL = "http://server:3001/";
    const rules = await config.rewrites?.();

    expect(rules).toEqual([
      {
        source: "/api/v1/:path*",
        destination: "http://server:3001/api/v1/:path*"
      },
      {
        source: "/mcp",
        destination: "http://server:3001/mcp"
      }
    ]);
  });

  it("does not add internal rewrites without an internal endpoint", async () => {
    delete process.env.HUNTER_HARNESS_INTERNAL_API_URL;
    expect(await config.rewrites?.()).toEqual([]);
  });
});
