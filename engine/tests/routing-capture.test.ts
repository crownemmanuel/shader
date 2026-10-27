import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtemStateUtil } from "atem-connection";
import { switcherInfo, routedTally } from "../routing.js";
import { CaptureService, JpegParser, captureArgs } from "../capture.js";
import { DemoAdapter } from "../adapters/demo.js";
import { toMcpResult } from "../mcp.js";

test("ATEM tally follows selected M/E, active keys, and transitions; aux-only is not On Air", () => {
  const state = AtemStateUtil.Create();
  const me = AtemStateUtil.getMixEffect(state, 0);
  me.programInput = 1;
  me.previewInput = 2;
  state.video.auxilliaries.push(3);
  for (const id of [1, 2, 3, 4])
    state.inputs[id] = {
      inputId: id,
      longName: `Camera ${id}`,
      shortName: `C${id}`,
      areNamesDefault: false,
      externalPorts: [],
      externalPortType: 0,
      internalPortType: 0,
      sourceAvailability: 0,
      meAvailability: 0,
    };
  let info = switcherInfo("switcher", state, true);
  assert.equal(
    routedTally({ host: "switcher", input: 1, me: 0 }, [info]),
    "program",
  );
  assert.equal(
    routedTally({ host: "switcher", input: 2, me: 0 }, [info]),
    "preview",
  );
  assert.equal(
    routedTally({ host: "switcher", input: 3, me: 0 }, [info]),
    "off",
  );
  Object.assign(me.transitionPosition, { inTransition: true });
  info = switcherInfo("switcher", state, true);
  assert.equal(
    routedTally({ host: "switcher", input: 2, me: 0 }, [info]),
    "program",
  );
  const key = AtemStateUtil.getUpstreamKeyer(me, 0);
  key.onAir = true;
  key.fillSource = 4;
  info = switcherInfo("switcher", state, true);
  assert.equal(
    routedTally({ host: "switcher", input: 4, me: 0 }, [info]),
    "program",
  );
  assert.equal(
    routedTally({ host: "switcher", input: 1, me: 1 }, [info]),
    "unknown",
  );
  info.connected = false;
  assert.equal(
    routedTally({ host: "switcher", input: 1, me: 0 }, [info]),
    "unknown",
  );
});

test("MJPEG parser handles fragmented frames, multiple frames, and oversized input", () => {
  const p = new JpegParser(),
    a = Buffer.from([255, 216, 1, 2, 3, 255, 217]),
    b = Buffer.from([255, 216, 4, 5, 255, 217]);
  assert.equal(p.push(a.subarray(0, 1)).length, 0);
  assert.equal(p.push(a.subarray(1, 4)).length, 0);
  const frames = p.push(Buffer.concat([a.subarray(4), b]));
  assert.deepEqual(frames, [a, b]);
  assert.throws(() => p.push(Buffer.alloc(8 * 1024 * 1024 + 1)), /limit/);
  const args = captureArgs({
    id: "x",
    kind: "decklink",
    name: "SDI 1",
    device: "DeckLink Quad 2 (1)",
    format: "Hp30",
  });
  assert.ok(args.includes("Hp30"));
  assert.ok(args.includes("DeckLink Quad 2 (1)"));
  assert.ok(!args.includes("-frames:v"));
});

test("preview and MCP capture share one input process, retain camera provenance and close on final lease release", { skip: process.platform === "win32" ? "Unix executable fixture uses a shebang; packaged Windows engine is tested separately" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-video-")),
    old = process.env.SHADER_FFMPEG;
  const executable = path.join(dir, "fake-ffmpeg"),
    log = path.join(dir, "starts");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)},'start\\n'); let n=0;setInterval(()=>process.stdout.write(Buffer.from([255,216,++n%255,255,217])),30);`,
    { mode: 0o700 },
  );
  process.env.SHADER_FFMPEG = executable;
  const service = new CaptureService();
  try {
    service.register({
      id: "input1",
      kind: "decklink",
      name: "Input 1",
      device: "Device 1",
    });
    assert.throws(
      () =>
        service.register({
          id: "duplicate",
          kind: "decklink",
          name: "Other",
          device: "Device 1",
        }),
      /already registered/,
    );
    const camera = (await new DemoAdapter().connect())[0];
    camera.sourceId = "input1";
    const lease = service.open(camera),
      second = service.open(camera);
    const frame = await service.capture(camera);
    assert.equal(frame.cameraId, camera.id);
    assert.equal(frame.sourceId, "input1");
    assert.equal((await readFile(log, "utf8")).trim(), "start");
    const preview = await service.poll(camera, lease.leaseId);
    assert.equal(preview.status, "live");
    assert.equal(toMcpResult(preview).content.at(-1).type, "image");
    service.release(lease.leaseId);
    assert.equal((await service.poll(camera, second.leaseId)).status, "live");
    camera.sourceId = "input2";
    assert.throws(() => service.poll(camera, second.leaseId), /changed/);
    service.releaseCamera(camera.id);
    assert.throws(() => service.poll(camera, second.leaseId), /expired/);
  } finally {
    service.close();
    if (old === undefined) delete process.env.SHADER_FFMPEG;
    else process.env.SHADER_FFMPEG = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("PTZOptics color-temperature readback decodes packed bytes independently of two-nibble writes", async () => {
  const { PtzOpticsAdapter, decodeControlReply } =
    await import("../adapters/ptzoptics.js");
  assert.equal(decodeControlReply(Buffer.from([0x1f]), "two", 0x20), 31);
  assert.equal(decodeControlReply(Buffer.from([1, 15]), "two", 0x20), 31);
  const adapter = new PtzOpticsAdapter(),
    packets: number[][] = [];
  adapter.transport = {
    request: async (packet: number[]) => {
      packets.push(packet);
      return packet[1] === 9 ? Buffer.from([0x29]) : Buffer.alloc(0);
    },
  } as any;
  const camera = (await new DemoAdapter().connect())[0];
  const result = await adapter.set(
    camera,
    { id: "color_temperature", native: { code: 0x20, style: "two" } } as any,
    41,
  );
  assert.deepEqual(packets[0], [0x81, 1, 4, 0x20, 2, 9, 255]);
  assert.equal(result.value, 41);
});
