// Cross-compile conduct into standalone single-file executables with Bun.
//
// Run with Bun:  bun run scripts/build.ts [target ...]
// With no args it builds every target below; pass one or more target keys
// (e.g. `bun run scripts/build.ts linux-x64`) to build a subset, which is how
// the release CI builds one binary per runner.
//
// ink lazily imports `react-devtools-core` only when DEV=true. It is not a
// dependency here, so we replace it with an empty module at build time to keep
// the bundle self-contained.

const TARGETS: Record<string, string> = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
};

const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(build: any) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const requested = Bun.argv.slice(2);
const selected = requested.length
  ? requested
  : Object.keys(TARGETS);

for (const key of selected) {
  const target = TARGETS[key];
  if (!target) {
    console.error(`Unknown target "${key}". Known: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
  const ext = key.startsWith("windows") ? ".exe" : "";
  const outfile = `dist/conduct-${key}${ext}`;
  console.log(`Building ${outfile} (${target})...`);
  const result = await Bun.build({
    entrypoints: ["src/index.tsx"],
    compile: { target, outfile },
    plugins: [stubDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

console.log("Done.");
