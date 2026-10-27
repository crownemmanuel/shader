import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

// Bundle only the plugins used by capture, preview, recording and synthetic checks,
// then recursively relocate their non-system dependencies. No Homebrew paths may
// remain in the staged Mach-O load commands.
export function bundleMacRuntime(destination) {
  const run = (name, args) =>
    execFileSync(name, args, { encoding: "utf8" }).trim();
  const lib = run("pkg-config", ["--variable=libdir", "gstreamer-1.0"]);
  const prefix = run("pkg-config", ["--variable=prefix", "gstreamer-1.0"]);
  const runtime = path.join(destination, "runtime");
  const sources = new Map(),
    destinations = new Map(),
    queue = [];
  function add(source, target) {
    source = realpathSync(source);
    if (sources.has(source)) return sources.get(source);
    target ||= path.join(runtime, "lib", path.basename(source));
    if (destinations.has(target) && destinations.get(target) !== source)
      throw Error("Conflicting runtime libraries: " + target);
    sources.set(source, target);
    destinations.set(target, source);
    mkdirSync(path.dirname(target), { recursive: true });
    if (source !== target) cpSync(source, target);
    queue.push({ source, target });
    return target;
  }
  add(
    path.join(destination, "shader-recorder"),
    path.join(destination, "shader-recorder"),
  );
  add(
    path.join(prefix, "libexec/gstreamer-1.0/gst-plugin-scanner"),
    path.join(runtime, "libexec/gstreamer-1.0/gst-plugin-scanner"),
  );
  for (const plugin of [
    "coreelements",
    "app",
    "videoconvertscale",
    "videorate",
    "jpeg",
    "audioconvert",
    "audioresample",
    "videotestsrc",
    "audiotestsrc",
    "libav",
    "multifile",
    "isomp4",
    "typefindfunctions",
    "playback",
  ]) {
    const file = `libgst${plugin}.dylib`;
    add(
      path.join(lib, "gstreamer-1.0", file),
      path.join(runtime, "lib/gstreamer-1.0", file),
    );
  }
  const decklink = path.join(lib, "gstreamer-1.0/libgstdecklink.dylib");
  if (existsSync(decklink))
    add(decklink, path.join(runtime, "lib/gstreamer-1.0/libgstdecklink.dylib"));
  const dependencies = (file) =>
    run("otool", ["-L", file])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (compatibility")[0]);
  for (let i = 0; i < queue.length; i++) {
    const { source, target } = queue[i];
    const changes = [];
    for (const dependency of dependencies(target)) {
      if (
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/")
      )
        continue;
      let resolved = dependency;
      if (dependency.startsWith("@loader_path/"))
        resolved = path.resolve(path.dirname(source), dependency.slice(13));
      if (!path.isAbsolute(resolved) || !existsSync(resolved))
        throw Error(
          `Unresolved recorder dependency ${dependency} in ${source}`,
        );
      const bundled = add(resolved);
      changes.push(
        "-change",
        dependency,
        "@loader_path/" + path.relative(path.dirname(target), bundled),
      );
    }
    if (target.endsWith(".dylib"))
      changes.push("-id", "@loader_path/" + path.basename(target));
    if (changes.length) run("install_name_tool", [...changes, target]);
  }
  for (const { target } of queue) {
    for (const dependency of dependencies(target)) {
      if (
        !dependency.startsWith("@loader_path/") &&
        !dependency.startsWith("/usr/lib/") &&
        !dependency.startsWith("/System/Library/")
      )
        throw Error("Nonportable dependency remains: " + dependency);
    }
    run("codesign", ["--force", "--sign", "-", target]);
  }
  // Preserve license texts, source/build metadata and SBOMs for every Homebrew
  // dependency, not just the GStreamer plugins at the top of the graph.
  const packages = new Set(
    queue
      .map(({ source }) => source.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//)?.[1])
      .filter(Boolean),
  );
  for (const owner of packages) {
    const notices = path.join(
      runtime,
      "share/licenses",
      path.basename(path.dirname(owner)),
      path.basename(owner),
    );
    mkdirSync(notices, { recursive: true });
    for (const entry of readdirSync(owner)) {
      if (
        /^(COPYING|LICENSE|NOTICE|AUTHORS|INSTALL_RECEIPT|sbom\.|\.brew$)/i.test(
          entry,
        )
      )
        cpSync(path.join(owner, entry), path.join(notices, entry), {
          recursive: true,
        });
    }
    if (existsSync(path.join(owner, "share/licenses")))
      cpSync(
        path.join(owner, "share/licenses"),
        path.join(notices, "licenses"),
        { recursive: true },
      );
  }
  console.log(`Relocated ${queue.length} recorder runtime binaries for macOS.`);
}
