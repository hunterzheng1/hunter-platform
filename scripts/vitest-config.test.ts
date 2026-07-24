import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import config from "../vitest.config.js";

describe("Vitest workspace source resolution", () => {
  it("resolves Knowledge from source without requiring a prior build", () => {
    expect(config).toMatchObject({
      resolve: {
        alias: {
          "@hunter/knowledge": fileURLToPath(
            new URL("../packages/knowledge/src/index.ts", import.meta.url),
          ),
        },
      },
    });
  });
});
