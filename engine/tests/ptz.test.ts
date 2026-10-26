import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Engine, DRIVE_DEADMAN_MS } from "../engine.js";
import { shadePlan, defaultPolicy } from "../shading.js";
import { CaptureService, captureArgs, stillArgs, rtspUrl } from "../capture.js";
import type { Camera, Control } from "../types.js";

const intent = { brightness: 0, warmth: 0, tint: 0 };
const control = (id: string, value: number, max: number): Control => ({
  id,
  label: id,
  group: "Exposure",
  type: "number",
  value,
  min: 0,
  max,
  step: 1,
  writable: true,
  readable: true,
  freshness: "reported",
});
function ptz(values: Record<string, number>): Camera {
  const max: Record<string, number> = {
    exposure_mode: 13,
    iris: 0x11,
    gain: 0x0f,
    gain_limit: 0x0f,
    bright: 0x1f,
    exposure_compensation_mode: 3,
    exposure_compensation: 0x0e,
  };
  return {
    id: "ptz-test",
    name: "PTZ",
    vendor: "ptzoptics",
    model: "VISCA",
    address: "127.0.0.1",
    status: "connected",
    revision: 0,
    tally: "unknown",
    controls: Object.entries(values).map(([id, v]) => control(id, v, max[id])),
  };
}
const target = (p: ReturnType<typeof shadePlan>, id: string) =>
  p.changes.find((c) => c.controlId === id)?.value;

test("VISCA manual exposure opens iris, then gain up to the camera gain limit; darkening lowers gain first", () => {
  const c = ptz({ exposure_mode: 3, iris: 7, gain: 2, gain_limit: 4 });
  const begin = shadePlan(c, intent, defaultPolicy);
  assert.equal(begin.supported.brightness, true);
  assert.deepEqual(begin.path, ["Iris", "Gain"]);
  assert.equal(target(begin, "iris"), 7);
  assert.equal(target(begin, "gain"), 2);

  const brighter = shadePlan(c, { ...intent, brightness: 2 }, defaultPolicy);
  assert.equal(target(brighter, "iris"), 11);
  assert.equal(target(brighter, "gain"), 2);

  const nearOpen = ptz({ exposure_mode: 3, iris: 16, gain: 2, gain_limit: 4 });
  const capped = shadePlan(
    nearOpen,
    { ...intent, brightness: 2 },
    defaultPolicy,
  );
  assert.equal(target(capped, "iris"), 17);
  assert.equal(target(capped, "gain"), 4);
  assert.equal(capped.remainingEV, 0.5);

  const darker = shadePlan(c, { ...intent, brightness: -1.5 }, defaultPolicy);
  assert.equal(target(darker, "gain"), 0);
  assert.equal(target(darker, "iris"), 6);
});

test("VISCA auto exposure uses compensation and switches it on only when offsetting", () => {
  const c = ptz({
    exposure_mode: 0,
    exposure_compensation_mode: 3,
    exposure_compensation: 4,
  });
  const neutral = shadePlan(c, intent, defaultPolicy);
  assert.equal(target(neutral, "exposure_compensation_mode"), undefined);
  assert.equal(target(neutral, "exposure_compensation"), 7);
  const brighter = shadePlan(c, { ...intent, brightness: 1 }, defaultPolicy);
  assert.equal(target(brighter, "exposure_compensation_mode"), 2);
  assert.equal(target(brighter, "exposure_compensation"), 9);
  assert.equal(brighter.changes[0].controlId, "exposure_compensation_mode");

  const bright = ptz({ exposure_mode: 13, bright: 10 });
  assert.equal(
    target(
      shadePlan(bright, { ...intent, brightness: -1 }, defaultPolicy),
      "bright",
    ),
    8,
  );
  const unsupported = ptz({ exposure_mode: 5 });
  assert.equal(
    shadePlan(unsupported, intent, defaultPolicy).supported.brightness,
    false,
  );
});

test("joystick drive sends one move per speed change and stops when the signal lapses", async () => {
  const f = await fakePtz();
  try {
    const [cam] = await f.connect();
    const moves = () => f.packets.filter((p) => p[1] === 1 && p[2] === 6);
    await f.e.drive(cam.id, 5, -3, "ui");
    await f.e.drive(cam.id, 5, -3, "ui");
    assert.deepEqual(moves(), [[0x81, 1, 6, 1, 5, 3, 2, 1, 255]]);
    await f.e.drive(cam.id, -2, 0, "ui");
    assert.deepEqual(moves().at(-1), [0x81, 1, 6, 1, 2, 1, 1, 3, 255]);
    await new Promise((r) => setTimeout(r, DRIVE_DEADMAN_MS + 150));
    assert.deepEqual(moves().at(-1), [0x81, 1, 6, 1, 1, 1, 3, 3, 255]);
    assert.ok(f.e.audit.some((a) => /signal lost/.test(a.detail)));

    await f.e.lock(cam.id, true, "ui");
    await assert.rejects(f.e.drive(cam.id, 4, 0, "ui"), /locked/);
    assert.deepEqual(moves().at(-1), [0x81, 1, 6, 1, 1, 1, 3, 3, 255]);
  } finally {
    await f.close();
  }
});

test("zoom rocker drives tele/wide at a signed speed, stops on silence, and Stop halts zoom too", async () => {
  const f = await fakePtz();
  try {
    const [cam] = await f.connect();
    const zooms = () => f.packets.filter((p) => p[2] === 4 && p[3] === 7);
    await f.e.zoom(cam.id, 3, "ui");
    await f.e.zoom(cam.id, 3, "ui");
    assert.deepEqual(zooms(), [[0x81, 1, 4, 7, 0x22, 255]]);
    await f.e.zoom(cam.id, -8, "ui");
    assert.deepEqual(zooms().at(-1), [0x81, 1, 4, 7, 0x37, 255]);
    await new Promise((r) => setTimeout(r, DRIVE_DEADMAN_MS + 150));
    assert.deepEqual(zooms().at(-1), [0x81, 1, 4, 7, 0, 255]);
    assert.ok(f.e.audit.some((a) => /Zoom signal lost/.test(a.detail)));

    await f.e.zoom(cam.id, 1, "ui");
    assert.deepEqual(zooms().at(-1), [0x81, 1, 4, 7, 0x20, 255]);
    await f.e.stop(cam.id);
    assert.deepEqual(zooms().at(-1), [0x81, 1, 4, 7, 0, 255]);
    assert.deepEqual(f.packets.at(-2), [0x81, 1, 6, 1, 1, 1, 3, 3, 255]);
  } finally {
    await f.close();
  }
});

test("PTZ RTSP stream is derived from the camera address: substream previews, main stream stills", async () => {
  const source = {
    id: "rtsp:ptz-172.16.10.94",
    name: "PTZ",
    kind: "rtsp" as const,
    device: "172.16.10.94",
  };
  const preview = captureArgs(source),
    still = stillArgs(source);
  assert.equal(preview[preview.indexOf("-i") + 1], "rtsp://172.16.10.94:554/2");
  assert.equal(still[still.indexOf("-i") + 1], "rtsp://172.16.10.94:554/1");
  assert.ok(preview.includes("tcp") && still.includes("-frames:v"));
  assert.equal(rtspUrl("fe80::1", "/2"), "rtsp://[fe80::1]:554/2");
  assert.throws(() => rtspUrl("cam/evil?x=1", "/1"), /Invalid/);
  assert.throws(() => rtspUrl("-i", "/1"), /Invalid/);
  assert.throws(
    () => new CaptureService().register(source),
    /only from connected cameras/,
  );
});

test("connecting a PTZ camera assigns its stream once; an operator's 'none' and saved settings survive reconnect", async () => {
  const f = await fakePtz();
  try {
    const [cam] = await f.connect();
    assert.equal(cam.sourceId, "rtsp:ptz-127.0.0.1");
    assert.equal(f.e.capture.sources.get(cam.sourceId!)?.device, "127.0.0.1");
    const saved = JSON.parse(
      await readFile(path.join(f.dir, "settings.json"), "utf8"),
    );
    assert.equal(saved.mappings[cam.id], "rtsp:ptz-127.0.0.1");
    assert.ok(!saved.sources.some((s: { kind: string }) => s.kind === "rtsp"));

    await f.e.assign(cam.id, null);
    await f.e.disconnect(cam.id);
    const [again] = await f.connect();
    assert.equal(again.sourceId, undefined);
    assert.ok(f.e.capture.sources.has("rtsp:ptz-127.0.0.1"));
  } finally {
    await f.close();
  }
});

// A VISCA endpoint that answers every inquiry with 1 and acknowledges commands.
async function fakePtz() {
  const packets: number[][] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (data) => {
      for (const frame of splitFrames(data)) {
        packets.push(frame);
        socket.write(
          Buffer.from(
            frame[1] === 9
              ? [0x90, 0x50, 0, 0, 0, 1, 255]
              : [0x90, 0x41, 255, 0x90, 0x51, 255],
          ),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-ptz-"));
  const e = new Engine(dir);
  await e.init();
  return {
    e,
    dir,
    packets,
    connect: () =>
      e.connect({
        vendor: "ptzoptics",
        host: "127.0.0.1",
        port: (server.address() as net.AddressInfo).port,
      }),
    close: async () => {
      await e.close();
      await rm(dir, { force: true, recursive: true });
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function splitFrames(data: Buffer) {
  const frames: number[][] = [];
  let start = 0;
  data.forEach((b, i) => {
    if (b === 0xff) {
      frames.push([...data.subarray(start, i + 1)]);
      start = i + 1;
    }
  });
  return frames;
}
