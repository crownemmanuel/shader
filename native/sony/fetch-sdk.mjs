import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = path.resolve("native/sony");
const pin = JSON.parse(await readFile(path.join(root, "sdk.json"), "utf8"));
export async function prepareSdk() {
  if (process.env.SONY_SDK_ROOT) return path.resolve(process.env.SONY_SDK_ROOT);
  const source = pin[process.platform];
  if (
    !source ||
    process.arch !== (process.platform === "darwin" ? "arm64" : "x64")
  )
    throw new Error("Sony builds support macOS arm64 and Windows x64.");
  const destination = path.join(root, "vendor", process.platform);
  const marker = path.join(destination, ".verified-sdk");
  try {
    if ((await readFile(marker, "utf8")).trim() === source.sha256)
      return destination;
  } catch {}
  const archive = path.join(root, "vendor", path.basename(source.url));
  await mkdir(path.dirname(archive), { recursive: true });
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {}
  if (
    !bytes ||
    createHash("sha256").update(bytes).digest("hex") !== source.sha256
  ) {
    console.log(
      `Fetching Sony Camera Remote SDK ${pin.version} for ${process.platform} from Sony…`,
    );
    const response = await fetch(source.url);
    if (!response.ok)
      throw new Error(`Sony SDK download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
      throw new Error(
        "Sony SDK checksum mismatch: inspect the upstream version before updating the pin.",
      );
    await writeFile(archive, bytes);
  }
  await mkdir(destination, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", destination], {
    stdio: "inherit",
  });
  execFileSync(
    "tar",
    ["-xf", path.join(destination, "RemoteCli.zip"), "-C", destination],
    { stdio: "inherit" },
  );
  await access(path.join(destination, "app/CRSDK/CameraRemote_SDK.h"));
  await writeFile(marker, source.sha256 + "\n");
  return destination;
}
