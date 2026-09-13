// Build for publishing. The workspace runs src through tsx; only `pnpm publish` uses dist.
// A plain object rather than defineConfig: tsup is resolved from the engine package, not this one.
// `removeNodeProtocol: false` keeps `node:path` / `node:url` intact in the bin.
const config = {
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { entry: "src/index.ts" },
  clean: true,
  outDir: "dist",
  external: ["payfirewall", "@modelcontextprotocol/sdk"],
  removeNodeProtocol: false,
};

export default config;
