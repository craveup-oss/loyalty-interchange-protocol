import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**", "**/dist/**", "coverage/**", ".worktrees/**",
      "packages/sdk/src/generated/**", "packages/mcp/assets/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      // Retaining a raw provider/credential exception changes diagnostic data
      // exposure. Audit those boundaries deliberately, not as a lint autofix.
      "preserve-caught-error": "off"
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser },
    rules: {
      // TypeScript owns symbol/type checks; the JS rules misread interfaces,
      // overloads and JSX. Keep the other correctness rules, not style churn.
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      "no-dupe-class-members": "off"
    }
  },
  {
    files: ["apps/admin/**/*.{js,ts,tsx}", "apps/wallet/public/**/*.js"],
    languageOptions: { globals: globals.browser }
  }
];
