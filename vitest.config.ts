import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const integrationTestFiles = [
  "packages/core/test/refresh.test.ts",
  "packages/core/test/initialize.test.ts",
  "packages/core/test/freshness.test.ts",
  "packages/core/test/bundle-content-projection.test.ts",
  "packages/core/test/agent-adapters.test.ts"
];

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  },
  resolve: {
    alias: {
      "@hunter-harness/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url)
      ),
      "@hunter-harness/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    env: {
      NEXT_PUBLIC_HUNTER_HARNESS_DEMO: ""
    },
    globalSetup: ["./tests/setup/global-temp.ts"],
    maxWorkers: 2,
    coverage: {
      reporter: ["text", "json", "html"]
    },
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          testTimeout: 30000,
          hookTimeout: 30000,
          include: [
            "packages/**/*.test.ts",
            "apps/**/*.test.ts",
            "apps/**/*.test.tsx",
            "tests/**/*.test.ts"
          ],
          exclude: integrationTestFiles
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          testTimeout: 120000,
          hookTimeout: 120000,
          include: integrationTestFiles
        }
      }
    ]
  }
});
