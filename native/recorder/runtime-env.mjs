import { existsSync } from "node:fs";
import path from "node:path";

export function runtimeEnvironment(binary, base = process.env) {
  const env = { ...base };
  const runtime = path.join(path.dirname(binary), "runtime");
  if (existsSync(runtime)) {
    const installed = env.GSTREAMER_1_0_ROOT_MSVC_X86_64 || env.GSTREAMER_ROOT;
    const pathKey = Object.keys(env).find(
      (key) => key.toUpperCase() === "PATH",
    );
    const inheritedPath = pathKey ? env[pathKey] : "";
    for (const key of Object.keys(env))
      if (key.toUpperCase() === "PATH") delete env[key];
    const entries = (inheritedPath || "")
      .split(path.delimiter)
      .filter(
        (p) =>
          !installed || !p.toLowerCase().startsWith(installed.toLowerCase()),
      );
    env.PATH = [path.join(runtime, "bin"), ...entries].join(path.delimiter);
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(runtime, "lib/gstreamer-1.0");
    env.GST_PLUGIN_PATH_1_0 = "";
    env.GST_PLUGIN_SCANNER = path.join(
      runtime,
      "libexec/gstreamer-1.0/gst-plugin-scanner" +
        (process.platform === "win32" ? ".exe" : ""),
    );
  }
  return env;
}
