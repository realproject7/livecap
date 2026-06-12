import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/", "src-tauri/", "target/", "crates/", "design/", "node_modules/", "**/node_modules/",
      "**/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "packages/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
