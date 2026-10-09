import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "tools/", "data/", "packages/contracts/src/abis.ts", "**/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Money is integer paisa (bigint); never let floats creep in through implicit coercion.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["**/scripts/**/*.ts", "**/cli.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Tests work in temporary directories they create themselves.
    files: ["**/test/**/*.ts"],
    rules: { "security/detect-non-literal-fs-filename": "off" },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
