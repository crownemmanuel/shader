import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.join(root, "sdk");
const out = path.join(root, "build");
const resource = path.resolve(root, "../../src-tauri/resources/decklink");
const manifest = JSON.parse(await readFile(path.join(sdk, "manifest.json"), "utf8"));
for (const entry of manifest.files) {
  const bytes = await readFile(path.join(sdk, entry.file));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    throw new Error(`DeckLink SDK checksum mismatch: ${entry.file}`);
}
await mkdir(out, { recursive: true });
await mkdir(resource, { recursive: true });
await cp(path.join(root, "NOTICE.txt"), path.join(resource, "THIRD_PARTY.txt"));
const cross = process.env.SHADER_WINDOWS_TOOLCHAIN;
if (process.platform !== "win32" && !cross) {
  await rm(path.join(resource, "shader-decklink.exe"), { force: true });
  console.log("DeckLink native capture is Windows-only; staged its notice for this platform.");
  process.exit(0);
}
const source = path.join(root, "src/main.cpp");
const jsonIncludes = path.resolve(root, "../sony/third_party");
if (cross) {
  // Optional portable LLVM MinGW cross-build, useful for compile checks from macOS/Linux.
  const tool = name => path.join(cross, "bin", `x86_64-w64-mingw32-${name}`);
  for (const [flag, file] of [["-h", "DeckLinkAPI_h.h"], ["-u", "DeckLinkAPI_i.c"]])
    execFileSync(tool("widl"), ["-m64", "-I", sdk, flag, "-o", path.join(out, file), path.join(sdk, "DeckLinkAPI.idl")], { stdio: "inherit" });
  execFileSync(tool("clang++"), ["-std=c++17", "-O2", "-Wall", "-Wextra", "-DNOMINMAX", "-DUNICODE", "-D_UNICODE",
    "-I" + out, "-I" + jsonIncludes, source, "-x", "c++", path.join(out, "DeckLinkAPI_i.c"),
    "-municode", "-static", "-lole32", "-loleaut32", "-lwindowscodecs", "-luuid", "-o", path.join(out, "shader-decklink.exe")], { stdio: "inherit" });
} else {
  execFileSync("midl.exe", ["/nologo", "/env", "x64", "/I", sdk, "/out", out,
    "/h", "DeckLinkAPI_h.h", "/iid", "DeckLinkAPI_i.c", "/tlb", "DeckLinkAPI.tlb", path.join(sdk, "DeckLinkAPI.idl")], { stdio: "inherit" });
  execFileSync("cl.exe", ["/nologo", "/std:c++17", "/EHsc", "/O2", "/MT", "/W4", "/utf-8",
    "/DUNICODE", "/D_UNICODE", "/DNOMINMAX", "/I" + out, "/I" + jsonIncludes,
    source, path.join(out, "DeckLinkAPI_i.c"), "/Fo" + out + path.sep, "/Fe" + path.join(out, "shader-decklink.exe"),
    "/link", "ole32.lib", "oleaut32.lib", "windowscodecs.lib", "uuid.lib"], { stdio: "inherit" });
  execFileSync(path.join(out, "shader-decklink.exe"), ["--self-test"], { stdio: "inherit" });
}
await cp(path.join(out, "shader-decklink.exe"), path.join(resource, "shader-decklink.exe"));
console.log("Built and staged Windows DeckLink capture helper.");
