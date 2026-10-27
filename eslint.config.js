// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "bot/node_modules/**",
      "bot/dist/**",
      "public/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The React Compiler lint set flags Date.now()/Math.random() during
      // render and setState inside effects. Both patterns are used
      // deliberately here (live countdowns, session restore) and reworking
      // them is a UI refactor, not a correctness fix. Surface, do not block.
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",

      // The codebase legitimately uses `any` at a few untyped boundaries
      // (Telegram WebApp globals, Firebase payloads). Flag them, do not fail.
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow deliberately unused parameters when prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // Empty catch blocks hid real failures before the audit; require intent.
      "no-empty": ["error", { allowEmptyCatch: false }],

      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // Node scripts run outside the bundler and use console freely.
  {
    // apk/scripts/ builds the Android bundle and runs under Node just the
    // same, so it needs the same globals.
    files: ["scripts/**/*.{js,mjs}", "apk/scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        URL: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },

  // Disables stylistic rules that would fight Prettier.
  prettier
);
