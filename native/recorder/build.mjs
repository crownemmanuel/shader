import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundleMacRuntime } from "./bundle-macos.mjs";
import { runtimeEnvironment } from "./runtime-env.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const windows = process.platform === "win32";
const name = "shader-recorder" + (windows ? ".exe" : "");
const destination = path.join(root, "src-tauri/resources/recorder");
const gst =
  process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64 || process.env.GSTREAMER_ROOT;
const env = { ...process.env };
if (windows) {
  if (!gst || !existsSync(path.join(gst, "lib/pkgconfig/gstreamer-1.0.pc")))
    throw Error(
      "Install official GStreamer MSVC x64 with development files (1.28.8), including libav and DeckLink, and set GSTREAMER_1_0_ROOT_MSVC_X86_64. See docs/recorder-studio-plan.md.",
    );
  // Windows environment keys are case-insensitive, but spreading process.env
  // into an ordinary JS object is not. Preserve the runner's existing Path.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const inheritedPath = pathKey ? env[pathKey] : "";
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = path.join(gst, "bin") + path.delimiter + inheritedPath;
  env.PKG_CONFIG_PATH = path.join(gst, "lib/pkgconfig");
}
const build = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    path.join(root, "native/recorder/Cargo.toml"),
  ],
  { env, stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const binary = path.join(root, "native/recorder/target/release", name);
const check = spawnSync(binary, ["--capabilities"], { env, encoding: "utf8" });
if (check.error) throw check.error;
if (check.status !== 0)
  throw Error("Recorder runtime failed its capability check: " + check.stderr);
const caps = JSON.parse(check.stdout);
if (!caps.available || (windows && !caps.decklink))
  throw Error("Missing required GStreamer plugins: " + JSON.stringify(caps));
mkdirSync(destination, { recursive: true });
cpSync(binary, path.join(destination, name));
if (windows) {
  // Keep plugins and their DLL dependencies together. Validate licensing before distribution.
  for (const dir of [
    "bin",
    "lib/gstreamer-1.0",
    "libexec/gstreamer-1.0",
    "share",
  ]) {
    const source = path.join(gst, dir);
    if (existsSync(source))
      cpSync(source, path.join(destination, "runtime", dir), {
        recursive: true,
      });
  }
}
if (process.platform === "darwin") bundleMacRuntime(destination);
const staged = spawnSync(path.join(destination, name), ["--capabilities"], {
  env: runtimeEnvironment(path.join(destination, name), env),
  encoding: "utf8",
});
if (staged.status !== 0)
  throw Error("Staged recorder could not start: " + staged.stderr);
const stagedCaps = JSON.parse(staged.stdout);
if (!stagedCaps.available || (windows && !stagedCaps.decklink))
  throw Error("Staged recorder runtime is incomplete: " + staged.stdout);
writeFileSync(
  path.join(destination, "RUNTIME.json"),
  JSON.stringify(
    {
      version: caps.version,
      platform: process.platform,
      bundled: windows || process.platform === "darwin",
      qualification: "Hardware qualification pending",
    },
    null,
    2,
  ),
);
console.log("Recorder staged. No release was created.");
