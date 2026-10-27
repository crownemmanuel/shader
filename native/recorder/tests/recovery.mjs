import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { runtimeEnvironment } from "../runtime-env.mjs";
const root = await mkdtemp(path.join(tmpdir(), "shader-recorder-crash-"));
const output = path.join(root, "output");
await mkdir(output);
const binary =
  process.env.SHADER_RECORDER ||
  path.resolve(
    import.meta.dirname,
    "../target/debug/shader-recorder" +
      (process.platform === "win32" ? ".exe" : ""),
  );
const ffmpeg =
  process.env.SHADER_FFMPEG ||
  execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)[0];
const ffprobe = process.env.SHADER_FFPROBE || "ffprobe";
Object.assign(process.env, runtimeEnvironment(binary));
const child = spawn(binary, ["--data-dir", path.join(root, "state")], {
  env: {
    ...process.env,
    SHADER_FFMPEG: ffmpeg,
    SHADER_RECORDER_TEST_INPUTS: "1",
    SHADER_RECORDER_TEST_COMPACT: "1",
    SHADER_RECORDER_SEGMENT_SECONDS: "10",
  },
  stdio: "ignore",
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let descriptor;
for (let i = 0; i < 100; i++) {
  try {
    descriptor = JSON.parse(
      await readFile(path.join(root, "state/service.json"), "utf8"),
    );
    break;
  } catch {}
  await pause(100);
}
async function rpc(name, args = {}) {
  const r = await fetch(descriptor.url + "/rpc", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + descriptor.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const v = await r.json();
  if (!r.ok) throw Error(name + ": " + JSON.stringify(v));
  return v;
}
try {
  await rpc("monitor", {
    sources: [1, 2].map((n) => ({
      id: "test-" + n,
      device: "test-" + n,
      name: "Camera " + n,
      connector: n,
      mode: "1080p30",
      audioChannels: 2,
      simulated: true,
    })),
  });
  for (let i = 0; i < 100; i++) {
    const s = await rpc("status");
    if (s.inputs.length === 2 && s.inputs.every((i) => i.state.ready)) break;
    await pause(100);
  }
  const take = await rpc("start", {
    requestId: randomUUID(),
    name: "Worker fault test",
    directory: output,
    profile: "prores-lt",
    sourceIds: ["test-1", "test-2"],
  });
  let partial;
  for (let i = 0; i < 30 && !partial; i++) {
    await pause(500);
    for (const f of await readdir(take.tracks[0].folder)) {
      if (!f.endsWith(".mov.partial")) continue;
      try {
        const v = JSON.parse(
          execFileSync(
            ffprobe,
            [
              "-v",
              "error",
              "-show_streams",
              "-of",
              "json",
              path.join(take.tracks[0].folder, f),
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ),
        );
        if (Number(v.streams?.[0]?.nb_frames) > 15)
          partial = path.join(take.tracks[0].folder, f);
      } catch {}
    }
  }
  assert.ok(
    partial,
    "live MOV checkpoint is readable before fault: " +
      JSON.stringify(await rpc("status")),
  );
  for (const dir of await readdir(path.join(root, "state/workers"))) {
    const config = JSON.parse(
      await readFile(
        path.join(root, "state/workers", dir, "config.json"),
        "utf8",
      ),
    );
    if (config.source.id === "test-1") {
      const d = JSON.parse(
        await readFile(
          path.join(root, "state/workers", dir, "worker.json"),
          "utf8",
        ),
      );
      process.kill(d.pid, "SIGKILL");
    }
  }
  await pause(2000);
  const live = await rpc("status");
  assert.equal(
    live.inputs.find((i) => i.source.id === "test-2").state.recording,
    true,
    "healthy input continues",
  );
  const stopped = await rpc("stop");
  assert.equal(stopped.status, "partial");
  const report = await rpc("recover", { sessionId: take.id });
  const recovered = report.results.find(
    (r) => r.status === "recovered-checkpoint",
  );
  assert.ok(recovered, JSON.stringify(report));
  assert.ok((await readFile(partial)).length > 0, "original retained");
  const media = JSON.parse(
    execFileSync(
      ffprobe,
      ["-v", "error", "-show_streams", "-of", "json", recovered.recovered],
      { encoding: "utf8" },
    ),
  );
  assert.equal(media.streams[0].codec_name, "prores");
  assert.ok(Number(media.streams[0].nb_frames) > 0);
  await rpc("release", { sourceIds: ["test-1"] });
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        "two-input recording, readable live checkpoint, input-worker crash isolation, partial status, recovery into new playable MOV, original retained, dead input release",
      root,
      recovered,
    }),
  );
} finally {
  try {
    await rpc("stop");
    await rpc("shutdown");
  } catch {}
  child.kill();
  for (const dir of await readdir(path.join(root, "state/workers"))) {
    try {
      const d = JSON.parse(
        await readFile(
          path.join(root, "state/workers", dir, "worker.json"),
          "utf8",
        ),
      );
      process.kill(d.pid, "SIGKILL");
    } catch {}
  }
}
