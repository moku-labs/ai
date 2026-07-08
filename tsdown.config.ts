import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: false,
    tsconfig: "tsconfig.build.json"
  },
  {
    // bin entry is ESM-only: it uses top-level await (unsupported in cjs)
    // and package.json "bin" points at dist/bin.mjs.
    entry: {
      bin: "src/bin.ts"
    },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: false,
    tsconfig: "tsconfig.build.json"
  }
]);
