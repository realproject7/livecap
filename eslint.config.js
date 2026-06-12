import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "crates/", "design/", "node_modules/", "**/node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
