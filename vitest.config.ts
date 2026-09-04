import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// packages/core and packages/contracts still expose the shared modules consumed
// by the platform apps, but their copied test trees also contain CLI project
// lifecycle and offline Harness Bundle coverage. Those tests belong to the
// Hunter-Harness repository, which owns the required workflow fixtures.
const platformPackageTestFiles = [
  "packages/contracts/test/knowledge-ingest.test.ts",
  "packages/contracts/test/plan-event-contracts.test.ts",
  "packages/contracts/test/platform-information-export-contracts.test.ts",
  "packages/contracts/test/remote-content-upload-http-contracts.test.ts",
  "packages/contracts/test/remote-sync-http-contracts.test.ts",
  "packages/contracts/test/schemas.test.ts",
  "packages/contracts/test/skill-package.test.ts",
  "packages/core/test/ai-prompt-parser.test.ts",
  "packages/core/test/ai.test.ts",
  "packages/core/test/checker.test.ts",
  "packages/core/test/diff.test.ts",
  "packages/core/test/file-policy.test.ts",
  "packages/core/test/fixer.test.ts",
  "packages/core/test/frontmatter.test.ts",
  "packages/core/test/knowledge.test.ts",
  "packages/core/test/meta.test.ts",
  "packages/core/test/path-safety.test.ts",
  "packages/core/test/registry-governance.test.ts",
  "packages/core/test/security-scanner.test.ts",
  "packages/core/test/skill-agents.test.ts"
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
            ...platformPackageTestFiles,
            "apps/**/*.test.ts",
            "apps/**/*.test.tsx",
            "tests/**/*.test.ts"
          ],
          exclude: [
            // PG 集成测试共享同一数据库，并行 worker 之间 TRUNCATE 会清掉
            // 彼此 fixture。放 integration 项目串行跑。
            "apps/server/test/**/*.integration.test.ts"
          ]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          testTimeout: 120000,
          hookTimeout: 120000,
          include: ["apps/server/test/**/*.integration.test.ts"],
          // 同一 DB 的 PG 集成测试必须串行；并行 worker 的 TRUNCATE 会
          // 在另一文件的 beforeAll 和测试体之间穿插，造成难以复现的失败。
          fileParallelism: false
        }
      }
    ]
  }
});
