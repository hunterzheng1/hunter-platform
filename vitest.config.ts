import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hunter/api-contracts": fileURLToPath(
        new URL("./packages/api-contracts/src/index.ts", import.meta.url),
      ),
      "@hunter/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@hunter/flow-engine": fileURLToPath(
        new URL("./packages/flow-engine/src/index.ts", import.meta.url),
      ),
      "@hunter/runtime-contracts": fileURLToPath(
        new URL("./packages/runtime-contracts/src/index.ts", import.meta.url),
      ),
      "@hunter/storage": fileURLToPath(
        new URL("./packages/storage/src/index.ts", import.meta.url),
      ),
      "@hunter/testkit": fileURLToPath(
        new URL("./packages/testkit/src/index.ts", import.meta.url),
      ),
      "@hunter/spike-testkit": fileURLToPath(
        new URL("./spikes/testkit/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "spikes/**/*.test.ts"],
    passWithNoTests: false,
  },
});
