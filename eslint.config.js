import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "experiments/**",
      "node_modules/**",
      "**/dist/**",
      "public/data/**",
      ".stress/**",
      ".preview/**",
      "dist-stress/**",
      "tests/**/artifacts/**",
      // Local caches and the UX-review demo build (gitignored): generated code, never linted.
      "research-cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // The renderer engine must stay framework-agnostic (ARCHITECTURE §4).
    files: ["src/graph/engine/**/*.ts", "src/graph/engine2d/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["react", "react-dom", "react-*"] }],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
