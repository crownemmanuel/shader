import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const read = (path) => readFileSync(path, "utf8");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  throw new Error(message);
};
const files = [
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const cargo = (text) =>
  text.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
const lockPattern = /(\[\[package\]\]\nname = "shader"\nversion = ")([^"]+)(")/;
const versions = () => [
  JSON.parse(read(files[0])).version,
  JSON.parse(read(files[1])).version,
  JSON.parse(read(files[1])).packages[""].version,
  cargo(read(files[2])),
  read(files[3]).match(lockPattern)?.[2],
];
const args = process.argv.slice(2);
if (args[0] === "--check") {
  const version = (args[1] || "").replace(/^v/, "");
  if (
    !semver.test(version) ||
    versions().some((v) => v !== version) ||
    JSON.parse(read("src-tauri/tauri.conf.json")).version !== "../package.json"
  )
    fail("Tag and app version files disagree.");
  console.log("All version files match " + version);
} else {
  if (git("status", "--porcelain"))
    fail("Commit current work before cutting a release.");
  const current = versions()[0];
  let next = args[0]?.replace(/^v/, "");
  const [major, minor, patch] = current.split(/[.-]/).map(Number);
  if (next === "patch") next = `${major}.${minor}.${patch + 1}`;
  if (next === "minor") next = `${major}.${minor + 1}.0`;
  if (next === "major") next = `${major + 1}.0.0`;
  if (!semver.test(next || ""))
    fail(
      "Usage: npm run release -- <patch|minor|major|version> [--notes 'Release notes'] [--dry-run]",
    );
  const tag = `v${next}`;
  if (git("tag", "--list", tag)) fail(`${tag} already exists.`);
  const notesIndex = args.indexOf("--notes");
  const notes =
    notesIndex >= 0
      ? args[notesIndex + 1]
      : `Shader ${next}: camera control, presets and lighting integration.`;
  console.log(`${current} → ${next}\n${notes}`);
  if (!args.includes("--dry-run")) {
    const pkg = JSON.parse(read(files[0]));
    pkg.version = next;
    writeFileSync(files[0], JSON.stringify(pkg, null, 2) + "\n");
    const lock = JSON.parse(read(files[1]));
    lock.version = next;
    lock.packages[""].version = next;
    writeFileSync(files[1], JSON.stringify(lock, null, 2) + "\n");
    writeFileSync(
      files[2],
      read(files[2]).replace(
        /(\[package\][\s\S]*?\nversion = ")[^"]+"/,
        `$1${next}"`,
      ),
    );
    writeFileSync(files[3], read(files[3]).replace(lockPattern, `$1${next}$3`));
    git("add", "--", ...files);
    git("commit", "-m", `Release ${tag}`, "--", ...files);
    git("tag", "-a", tag, "-m", `Shader ${next}\n\n${notes}`);
    console.log(`To build and publish: git push origin HEAD ${tag}`);
  }
}
