import { build } from "esbuild";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = process.cwd();
await mkdir(".shader/build", { recursive: true });
await mkdir("src-tauri/binaries", { recursive: true });
const target = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
  /host: (.+)/,
)[1].trim();
const output = path.resolve(
  "src-tauri/binaries/shader-engine-" +
    target +
    (process.platform === "win32" ? ".exe" : ""),
);
await build({
  entryPoints: ["engine/main.ts"],
  outfile: ".shader/build/engine.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node26",
  alias: {
    threadedclass: path.join(root, "scripts/threadedclass-inline.ts"),
    "@julusian/freetype2": path.join(root, "scripts/freetype-unused.ts"),
  },
  external: ["node-fetch"],
  logLevel: "warning",
});
await writeFile(
  ".shader/build/sea.json",
  JSON.stringify({
    main: path.resolve(".shader/build/engine.cjs"),
    output,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
);
execFileSync(
  path.resolve(process.platform === "win32" ? "node_modules/node/bin/node.exe" : "node_modules/node/bin/node"),
  ["--build-sea=.shader/build/sea.json"],
  { stdio: "inherit" },
);
await chmod(output, 0o755);
if (process.platform === "darwin")
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", output], {
    stdio: "inherit",
  });
console.log("Built Shader engine for " + target);
