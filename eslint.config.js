import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/dist-installers/**", "**/dist-types/**", "**/*.d.ts", "docs/validation/**/*.json"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
