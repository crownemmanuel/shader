#!/usr/bin/env node
// Fetches the static ffmpeg the app bundles as a Tauri sidecar, so media optimising works on a
// show computer with nothing installed (docs/RELEASES.md, "Media formats").
//
//   node scripts/fetch-ffmpeg.ts                 # the build host's target (or $TAURI_ENV_TARGET_TRIPLE)
//   node scripts/fetch-ffmpeg.ts --all           # every target below
//   node scripts/fetch-ffmpeg.ts --target x86_64-pc-windows-msvc --force
//
// Writes src-tauri/binaries/ffmpeg-<target-triple>[.exe] (Tauri's sidecar naming; the bundler
// strips the triple, so the app finds `ffmpeg` next to its own executable). Verified against the
// SHA-256 pinned here, which matched the hash the source published when the version was pinned.
// Nothing is re-downloaded while the pinned version is already there. The binaries are not in git.
//
// `tauri build` and `tauri dev` run this first (build.beforeBuildCommand / beforeDevCommand), since
// tauri-build refuses to compile when an externalBin is missing. Node only, no dependencies: the
// file is a .ts that Node runs with type stripping, like mcp/server.ts, so keep it to erasable types.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

type Source = {
  version: string;
  url: string;
  sha256: string;
  /** The file to take out of the archive (matched by base name). */
  entry: string;
  licence: string;
  build: string;
};

// Both are GPL v3 builds (they carry x264, the software H.264 encoder the optimiser falls back to
// when there is no hardware encoder). ffmpeg runs as a separate program the app starts, so the
// app's own licence is not affected, but a copy of the ffmpeg source for the version shipped must
// stay available: https://github.com/FFmpeg/FFmpeg/tree/n<version>.
const SOURCES: Record<string, Source> = {
  "aarch64-apple-darwin": {
    version: "9.0.2",
    url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
    entry: "ffmpeg",
    licence: "GPL v3",
    build: "Martin Riedl static build (ffmpeg.martin-riedl.de), macOS arm64, VideoToolbox + x264",
  },
  "x86_64-pc-windows-msvc": {
    version: "9.0.2",
    url: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip",
    sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
    entry: "ffmpeg.exe",
    licence: "GPL v3",
    build: "gyan.dev essentials build, Windows x64, NVENC / QSV / AMF + x264",
  },
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");

function hostTriple(): string {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  return `${arch}-${platform}`;
}

function parseArgs(argv: string[]): { targets: string[]; force: boolean } {
  const targets: string[] = [];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") targets.push(...Object.keys(SOURCES));
    else if (a === "--force") force = true;
    else if (a === "--target") targets.push(argv[++i] ?? "");
    else if (a.startsWith("--target=")) targets.push(a.slice("--target=".length));
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/fetch-ffmpeg.ts [--all | --target <triple>]... [--force]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (targets.length === 0) targets.push(process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple());
  return { targets: [...new Set(targets)], force };
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Pulls one file out of a zip held in memory (stored or deflated entries, no zip64). */
function unzipEntry(zip: Buffer, baseName: string): Buffer {
  // End of central directory record: the last 22 bytes when there is no comment, up to 64 KiB back.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    names.push(name);
    if (name.split("/").pop() !== baseName || name.endsWith("/")) continue;
    if (compressed === 0xffffffff || size === 0xffffffff) throw new Error("zip64 archive: not supported");
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("zip: bad local header");
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + compressed);
    const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    if (!out) throw new Error(`zip: entry ${name} uses compression method ${method}`);
    if (out.length !== size) throw new Error(`zip: ${name} inflated to ${out.length} bytes, expected ${size}`);
    return out;
  }
  throw new Error(`zip: no entry named ${baseName}; it holds ${names.slice(0, 20).join(", ")}`);
}

async function fetchOne(triple: string, force: boolean): Promise<void> {
  const src = SOURCES[triple];
  if (!src) {
    const known = Object.keys(SOURCES).join(", ");
    throw new Error(`no ffmpeg source pinned for ${triple} (known: ${known}); add one to scripts/fetch-ffmpeg.ts`);
  }
  const ext = triple.includes("windows") ? ".exe" : "";
  const bin = join(outDir, `ffmpeg-${triple}${ext}`);
  const stamp = `${bin}.version`;
  const want = `${src.version} ${src.url}\n`;
  if (!force && existsSync(bin) && existsSync(stamp) && readFileSync(stamp, "utf8") === want) {
    console.log(`ffmpeg ${src.version} for ${triple} is already in src-tauri/binaries/`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  console.log(`fetching ffmpeg ${src.version} for ${triple}\n  ${src.url}`);
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = sha256(zip);
  if (got !== src.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${src.url}\n  expected ${src.sha256}\n  got      ${got}\n` +
        "The file changed since it was pinned. Check the source's published checksum before updating the pin.",
    );
  }
  console.log(`  ${(zip.length / 1e6).toFixed(1)} MB, checksum verified`);
  const file = unzipEntry(zip, src.entry);
  rmSync(bin, { force: true });
  writeFileSync(bin, file);
  if (!ext) chmodSync(bin, 0o755);
  writeFileSync(stamp, want);
  writeFileSync(
    join(outDir, "README.txt"),
    [
      "Static ffmpeg builds bundled with the app as a Tauri sidecar (bundle.externalBin). Fetched by",
      "scripts/fetch-ffmpeg.ts, which pins each version and its SHA-256. Not in git: run",
      "`npm run fetch:ffmpeg` (tauri build / dev do it for you).",
      "",
      ...Object.entries(SOURCES).map(([t, s]) => `${t}: ffmpeg ${s.version}, ${s.licence}, ${s.build}\n  ${s.url}`),
      "",
      "ffmpeg is GPL v3 in these builds; its source for the version shipped is at",
      "https://github.com/FFmpeg/FFmpeg (tag n<version>). See docs/RELEASES.md, Media formats.",
      "",
    ].join("\n"),
  );
  console.log(`  wrote ${bin.replace(root + "/", "")} (${(file.length / 1e6).toFixed(1)} MB, ${src.licence})`);
}

const { targets, force } = parseArgs(process.argv.slice(2));
for (const t of targets) {
  await fetchOne(t, force);
}
