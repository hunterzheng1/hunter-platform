import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hunter/spike-testkit": fileURLToPath(
        new URL("./spikes/testkit/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "spikes/**/*.test.ts"],
    passWithNoTests: false,
  },
});
