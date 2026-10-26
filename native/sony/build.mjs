import { readFile, writeFile, mkdir, cp, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = path.resolve("native/sony"),
  sdk = process.env.SONY_SDK_ROOT || path.join(root, "vendor/RemoteCli");
if (process.platform !== "darwin")
  throw new Error(
    "This build script currently targets macOS. Port the library paths for Windows/Linux.",
  );
const out = path.join(root, "build");
await mkdir(out, { recursive: true });
let generated = "#pragma once\n#include <map>\n#include <string>\n";
for (const [file, prefix, fn] of [
  ["CrDeviceProperty.h", "CrDeviceProperty_", "propertyNames"],
  ["CrControlCode.h", "CrControlCode_", "controlNames"],
  ["CrCommandData.h", "CrCommandId_", "commandNames"],
]) {
  const header = await readFile(path.join(sdk, "app/CRSDK", file), "utf8");
  const names = [
    ...new Set(
      [
        ...header.matchAll(
          new RegExp("\\b(" + prefix + "\\w+)\\s*(?:=|,)", "g"),
        ),
      ].map((m) => m[1]),
    ),
  ];
  generated +=
    `inline const std::map<uint32_t,std::string> ${fn}={\n` +
    names.map((n) => `{SCRSDK::${n},"${n.slice(prefix.length)}"}`).join(",\n") +
    "\n};\n";
}
await writeFile(path.join(out, "names.hpp"), generated);
await cp(path.join(sdk, "external/crsdk"), out, { recursive: true });
await cp(
  path.join(sdk, "external/crsdk/CrAdapter"),
  path.join(out, "Contents/Frameworks/CrAdapter"),
  { recursive: true },
);
execFileSync(
  "clang++",
  [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    "-Wno-deprecated-declarations",
    "-mmacosx-version-min=12.1",
    "-I" + path.join(sdk, "app/CRSDK"),
    "-I" + path.join(root, "third_party"),
    "-I" + out,
    path.join(root, "src/main.cpp"),
    "-L" + out,
    "-lCr_Core",
    "-Wl,-rpath,@executable_path",
    "-o",
    path.join(out, "shader-sony"),
  ],
  { stdio: "inherit" },
);
// Keep Sony's supplied libraries unchanged; sign our bridge for local execution.
execFileSync(
  "codesign",
  ["--force", "--sign", "-", path.join(out, "shader-sony")],
  { stdio: "inherit" },
);
console.log("Built native Sony SDK bridge at " + out);
const resource = path.resolve("src-tauri/resources/sony");
await rm(resource, { recursive: true, force: true });
await mkdir(resource, { recursive: true });
for (const file of await readdir(out)) {
  if (file.endsWith(".dylib") || file === "Contents" || file === "shader-sony")
    await cp(path.join(out, file), path.join(resource, file), {
      recursive: true,
    });
}
await cp(
  path.join(root, "vendor/sdk/Camera_Remote_SDK_Readme_v2.02.00.pdf"),
  path.join(resource, "Sony_SDK_Readme.pdf"),
);
await writeFile(
  path.join(resource, "THIRD_PARTY.txt"),
  "Sony Camera Remote SDK 2.02.00. Copyright Sony Corporation. Used under the Sony Camera Remote SDK license accepted by the developer on 2026-10-26.\nhttps://support.d-imaging.sony.co.jp/app/sdk/licenseagreement_d/en-US.html\n\nJSON for Modern C++ 3.12.0 by Niels Lohmann, MIT license; see embedded copyright notice in third_party/json.hpp.\n",
);

await cp(
  path.join(sdk, "README.md"),
  path.join(resource, "Sony_OSS_NOTICES.md"),
);
await cp(
  path.join(root, "third_party/json.hpp"),
  path.join(resource, "nlohmann_json.hpp"),
);
