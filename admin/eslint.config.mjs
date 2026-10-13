import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", ".next/", ".next-e2e/", ".next-http/", "screenshots/", "test-results/", "playwright-report/", "next-env.d.ts", "scripts/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
