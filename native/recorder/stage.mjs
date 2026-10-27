import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const dest = path.resolve(
  import.meta.dirname,
  "../../src-tauri/resources/recorder",
);
mkdirSync(dest, { recursive: true });
if (
  !existsSync(
    path.join(
      dest,
      "shader-recorder" + (process.platform === "win32" ? ".exe" : ""),
    ),
  )
) {
  throw Error(
    "Build Recorder Studio with npm run build:recorder before building the app.",
  );
}
writeFileSync(
  path.join(dest, "NOTICE.txt"),
  "Recorder Studio uses GStreamer and its Rust bindings. The application includes dynamically linked runtime libraries and plugin license notices. GStreamer source and dependency build recipes: https://gstreamer.freedesktop.org/src/ and https://gitlab.freedesktop.org/gstreamer/cerbero/-/tree/1.28.8 . See RUNTIME.json for the bundled version. Eight-input hardware qualification remains required.\n",
);
