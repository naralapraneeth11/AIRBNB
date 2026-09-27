import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

// ESLint 9 is pinned deliberately: eslint-plugin-react, bundled by
// eslint-config-next 16, does not yet declare support for ESLint 10.
export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      // Calendar and security code must not silently swallow typed values.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Advisory React Compiler rule. The flagged effects are data fetches that
      // PERF 01 (Phase 3) replaces with bounded domain queries and a shared
      // client cache; rewriting them earlier would be churn outside Phases 0-1.
      // Kept visible as warnings so the debt stays in view.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "ops/clock/.wrangler/**",
  ]),
]);
