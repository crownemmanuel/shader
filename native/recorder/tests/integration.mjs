import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { runtimeEnvironment } from "../runtime-env.mjs";
const root = await mkdtemp(path.join(tmpdir(), "shader-recorder-test-"));
const output = path.join(root, "output");
await mkdir(output);
const binary =
  globalThis.process.env.SHADER_RECORDER ||
  path.resolve(
    import.meta.dirname,
    "../target/debug/shader-recorder" +
      (globalThis.process.platform === "win32" ? ".exe" : ""),
  );
const ffprobe = globalThis.process.env.SHADER_FFPROBE || "ffprobe";
Object.assign(globalThis.process.env, runtimeEnvironment(binary));
let process = spawn(binary, ["--data-dir", path.join(root, "state")], {
  env: {
    ...globalThis.process.env,
    SHADER_RECORDER_TEST_INPUTS: "1",
    SHADER_RECORDER_SEGMENT_SECONDS: "2",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
process.stderr.on("data", (b) => {
  logs += b;
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
  if (process.exitCode !== null) throw Error(logs);
  await pause(100);
}
assert.ok(descriptor, "service descriptor");
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
  console.log(JSON.stringify({ root, runtime: (await rpc("status")).runtime }));
  await rpc("monitor", {
    sources: [
      {
        id: "test-1",
        device: "test-1",
        name: "Choir wide",
        connector: 1,
        mode: "1080p30",
        audioChannels: 16,
        simulated: true,
      },
    ],
  });
  let state;
  for (let i = 0; i < 80; i++) {
    state = await rpc("status");
    if (state.inputs[0]?.state.ready) break;
    await pause(100);
  }
  assert.equal(
    state.inputs[0]?.state.ready,
    true,
    JSON.stringify(state.inputs),
  );
  assert.equal((await rpc("preview", { sourceId: "test-1" })).status, "live");
  await assert.rejects(
    rpc("storage", { path: path.join(root, "missing") }),
    /existing/,
  );
  const disk = await rpc("storage", { path: output });
  assert.ok(BigInt(disk.freeBytes) > 0n);
  assert.ok(BigInt(disk.totalBytes) >= BigInt(disk.freeBytes));
  await rpc("network_configure", {
    enabled: true,
    host: "127.0.0.1",
    port: 19202,
    allowedSenders: [],
  });
  const key = (await rpc("pairing_key")).pairingKey;
  async function publicCall(url, body, token = key) {
    const r = await fetch("http://127.0.0.1:19202/recorder/v1/" + url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, value: await r.json() };
  }
  assert.equal((await publicCall("session")).value.recording, false);
  assert.equal((await publicCall("session", null, "bad")).status, 401);
  const take = await rpc("start", {
    requestId: randomUUID(),
    name: "Integration take",
    directory: output,
    profile: "prores-lt",
    sourceIds: ["test-1"],
  });
  await assert.rejects(rpc("shutdown"), /Stop and finalize/);
  await pause(3500);
  const session = (await publicCall("session")).value;
  assert.equal(session.recordingSessionId, take.id);
  const t1 = Date.now().toString();
  const probe = (await publicCall("clock/probe", { t1 })).value;
  const t4 = BigInt(Date.now());
  const offset =
    (BigInt(probe.t2) -
      BigInt(t1) * 1000000n +
      (BigInt(probe.t3) - t4 * 1000000n)) /
    2n;
  const event = {
    protocol: "shader.recorder/1",
    eventId: randomUUID(),
    senderId: "stagemics-12345678",
    senderRunId: randomUUID(),
    sequence: "1",
    recordingSessionId: take.id,
    type: "scene.enter",
    label: "Choir",
    scene: { id: "choir", code: "2.1", name: "Choir" },
    alreadyLive: true,
    time: {
      domain: "utc",
      utc: (BigInt(take.startedUtc) - 1000n).toString(),
      clockSource: "stagemics-host",
      clock: {
        sessionClockId: probe.sessionClockId,
        ticksPerSecond: probe.ticksPerSecond,
        offsetTicks: offset.toString(),
        uncertaintyTicks: "1000000",
        probedUtc: t1,
      },
    },
    audio: {
      recordingId: "audio-1",
      recordingName: "Sunday choir",
      sample: "48000",
      sampleRate: 48000,
      edited: false,
    },
    scope: "all-recorded-inputs",
  };
  assert.equal(
    (await publicCall("sessions/" + take.id + "/events", event)).status,
    201,
  );
  assert.equal(
    (await publicCall("sessions/" + take.id + "/events", event)).value.status,
    "duplicate",
  );
  assert.equal(
    (
      await publicCall("sessions/" + take.id + "/events", {
        ...event,
        label: "changed",
      })
    ).status,
    409,
  );
  const originalProcess = process;
  originalProcess.kill("SIGKILL");
  await new Promise((r) => originalProcess.once("exit", r));
  process = spawn(binary, ["--data-dir", path.join(root, "state")], {
    env: {
      ...globalThis.process.env,
      SHADER_RECORDER_TEST_INPUTS: "1",
      SHADER_RECORDER_SEGMENT_SECONDS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stderr.on("data", (b) => {
    logs += b;
  });
  for (let i = 0; i < 100; i++) {
    try {
      const d = JSON.parse(
        await readFile(path.join(root, "state/service.json"), "utf8"),
      );
      if (d.pid === process.pid) {
        descriptor = d;
        break;
      }
    } catch {}
    await pause(100);
  }
  assert.equal(descriptor.pid, process.pid, "reattached recorder service");
  assert.equal(
    (await publicCall("sessions/" + take.id + "/events", event)).value.status,
    "duplicate",
    "durable retry after restart",
  );
  await pause(3000);

  state = await rpc("status");
  console.log(
    JSON.stringify({ recording: state.active, inputs: state.inputs }),
  );
  await rpc("marker", { label: "Choir started" });
  const stopped = await rpc("stop");
  assert.ok(
    ["complete", "partial"].includes(stopped.status),
    JSON.stringify(stopped),
  );
  assert.ok(
    stopped.errors.every((e) => e.includes("reconnected")),
    JSON.stringify(stopped.errors),
  );
  const files = await readdir(take.tracks[0].folder);
  console.log(JSON.stringify({ files, stopped }));
  const mov = files.filter((f) => f.endsWith(".mov"));
  assert.ok(mov.length >= 2, "segment rollover");
  for (const file of mov) {
    const v = JSON.parse(
      execFileSync(
        ffprobe,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          path.join(take.tracks[0].folder, file),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(v.streams[0].codec_name, "prores");
    assert.equal(v.streams[1].sample_rate, "48000");
    assert.equal(v.streams[1].channels, 16);
    console.log(
      JSON.stringify({
        file,
        seconds: v.format.duration,
        frames: v.streams[0].nb_frames,
        audio: v.streams[1].codec_name,
      }),
    );
  }
  assert.match(
    await readFile(path.join(take.directory, "markers.jsonl"), "utf8"),
    /Choir started/,
  );
  const late = {
    ...event,
    eventId: randomUUID(),
    sequence: "2",
    type: "scene.exit",
    alreadyLive: false,
    enterEventId: event.eventId,
    time: { ...event.time, utc: (BigInt(take.startedUtc) + 3000n).toString() },
  };
  assert.equal(
    (await publicCall("sessions/" + take.id + "/events", late)).status,
    201,
    "late exit belongs to original take",
  );
  const scenes = JSON.parse(
    await readFile(path.join(take.directory, "scenes.json"), "utf8"),
  );
  assert.equal(scenes.intervals[0].startTicks, "0");
  assert.ok(scenes.intervals[0].endTicks);
  assert.equal((await publicCall("session")).value.recording, false);
  const parts = JSON.parse(
    await readFile(path.join(take.tracks[0].folder, "segments.json"), "utf8"),
  );
  for (let i = 1; i < parts.length; i++)
    assert.equal(
      parts[i - 1].endSessionTicks,
      parts[i].startSessionTicks,
      "continuous segments",
    );
  console.log(
    "PASS: MOV/16-channel PCM, segment rollover, free space, shutdown guard, StageMics auth/clock/dedup/late events, recorder service crash survival",
  );
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  try {
    await rpc("shutdown");
  } catch {}
  process.kill();
}
