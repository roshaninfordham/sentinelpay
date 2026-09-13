import { defineConfig } from "tsup";

// One build for every public subpath. `removeNodeProtocol: false` keeps `node:test` / `node:assert/strict`
// intact in the testing entry (tsup strips the prefix by default, which breaks the import at runtime).
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/tools/index.ts",
    "src/http/index.ts",
    "src/http/client.ts",
    "src/testing/index.ts",
    "src/adapters/*.ts",
  ],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
  outDir: "dist",
  external: ["@libsql/client"],
  removeNodeProtocol: false,
});
