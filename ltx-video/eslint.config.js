import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "dist-electron/",
      "release/",
      "node_modules/",
      "backend/",
      "models/",
      "scripts/",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  {
    files: ["electron/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },

  {
    files: ["*.config.{js,ts}", "postcss.config.js", "tailwind.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },

  eslintConfigPrettier,
);
