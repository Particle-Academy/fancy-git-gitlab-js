import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts"], format: ["esm", "cjs"], dts: true, clean: true, sourcemap: true, external: ["@gitbeaker/rest", "@particle-academy/fancy-git"] });
