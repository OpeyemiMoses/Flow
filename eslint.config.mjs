import { defineConfig, globalIgnores } from "eslint/config";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([".next/**", "next-env.d.ts", "work/**", "outputs/**"]),
  ...tseslint.configs.recommended,
  {
    files: ["src/app/**/*.{ts,tsx}"],
    extends: [
      next.configs["core-web-vitals"],
      reactHooks.configs.flat.recommended,
    ],
  },
]);
