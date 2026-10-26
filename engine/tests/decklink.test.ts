import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { CaptureService, parseDeckLinkSources } from "../capture.js";
import { DeckLinkBridge, DeckLinkEvents } from "../decklink.js";
import { DemoAdapter } from "../adapters/demo.js";
import { Engine } from "../engine.js";
import { commands, execute } from "../commands.js";

const sources = Array.from({ length: 8 }, (_, index) => ({
  device: `pid:deadbeef:sub:${index}`,
  name: `DeckLink Quad 2 (${index + 1}) · SDI ${[1, 3, 5, 7, 2, 4, 6, 8][index]}`,
  nativeName: `DeckLink Quad 2 (${index + 1})`,
  model: "DeckLink Quad 2",
  subdeviceIndex: index,
  connector: [1, 3, 5, 7, 2, 4, 6, 8][index],
  profile: "2dhd",
  supportsAutoDetection: true,
  modes: [
    { code: "Hp30", name: "1080p30", width: 1920, height: 1080, fps: 30 },
    {
      code: "Hp59",
      name: "1080p59.94",
      width: 1920,
      height: 1080,
      fps: 60000 / 1001,
    },
  ],
}));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(25);
  }
  throw new Error("Fixture did not reach expected state");
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shader-decklink-"));
  const configFile = path.join(directory, "config.json");
  let config: any = { list: { protocol: 1, sources, diagnostics: [] } };
  await writeFile(configFile, JSON.stringify(config));
  const bridge = new DeckLinkBridge(process.execPath, [
    path.resolve("engine/tests/fixtures/decklink-bridge.mjs"),
    configFile,
  ]);
  const probe = async () => {
    throw new Error("FFmpeg is unavailable in this fixture");
  };
  const service = new CaptureService(bridge, probe);
  const camera = (await new DemoAdapter().connect())[0];
  return {
    directory,
    bridge,
    service,
    camera,
    async update(patch: any) {
      config = { ...config, ...patch };
      await writeFile(configFile + ".tmp", JSON.stringify(config));
      await rename(configFile + ".tmp", configFile);
    },
    async events() {
      try {
        return (await readFile(path.join(directory, "events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
      } catch {
        return [];
      }
    },
    async close() {
      service.close();
      await until(
        () => readdir(directory),
        (files) => !files.some((file) => file.endsWith(".lock")),
      );
      await delay(100);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("DeckLink source parser handles current identifiers, legacy lists and diagnostics without inventing devices", () => {
  const parsed = parseDeckLinkSources(
    "Auto-detected sources for decklink:\n  abc:123 [DeckLink Quad 2 (1)] (none)\n* abc:124 [DeckLink Quad 2 (2)] (video)\nCannot list sources: 'driver failed'\nError [driver not installed]\n",
  );
  assert.deepEqual(
    parsed.map((s) => [s.device, s.name]),
    [
      ["abc:123", "DeckLink Quad 2 (1)"],
      ["abc:124", "DeckLink Quad 2 (2)"],
    ],
  );
  assert.equal(
    parseDeckLinkSources("[decklink @ 0x123] 'DeckLink Quad 2 (3)'\n")[0]
      .device,
    "DeckLink Quad 2 (3)",
  );
});

test("native discovery returns eight distinct channels even when FFmpeg fails, preserves mappings, and marks removed inputs unavailable", async () => {
  const f = await fixture();
  try {
    f.service.register({
      id: "old-mapping",
      kind: "decklink",
      name: "Stage",
      device: "DeckLink Quad 2 (1)",
      format: "Hp30",
    });
    const found = await f.service.list();
    assert.equal(found.sources.length, 8);
    assert.equal(new Set(found.sources.map((s) => s.device)).size, 8);
    assert.deepEqual(
      found.sources.map((s) => s.connector),
      [1, 3, 5, 7, 2, 4, 6, 8],
    );
    const preserved = f.service.sources.get("old-mapping")!;
    assert.equal(preserved.device, "pid:deadbeef:sub:0");
    assert.equal(preserved.format, "Hp30");
    assert.equal(preserved.backend, "decklink-sdk");
    assert.match(found.diagnostics.join(" "), /FFmpeg is unavailable/);
    await f.update({ list: { protocol: 1, sources: sources.slice(1) } });
    await f.service.list();
    assert.equal(f.service.sources.get("old-mapping")!.available, false);
    f.camera.sourceId = "old-mapping";
    assert.throws(() => f.service.open(f.camera), /unavailable/);
  } finally {
    await f.close();
  }
});

test("native discovery rejects incompatible protocol and reports missing Desktop Video", async () => {
  const f = await fixture();
  try {
    await f.update({
      list: { protocol: 1, sources: [], error: "driver_unavailable" },
    });
    await assert.rejects(f.bridge.list(), /Install Desktop Video/);
    await f.update({ list: { protocol: 8, sources: [] } });
    await assert.rejects(f.bridge.list(), /invalid device list/);
  } finally {
    await f.close();
  }
});

test("native preview and fresh snapshots share one handle and recover after signal loss", async () => {
  const f = await fixture();
  try {
    f.camera.sourceId = (await f.service.list()).sources[0].id;
    const lease = f.service.open(f.camera);
    const frame = await f.service.capture(f.camera);
    assert.equal(frame.sourceId, f.camera.sourceId);
    assert.equal(
      (await f.events()).filter((e) => e.event === "start").length,
      1,
    );
    await f.update({ noSignal: true });
    const lost = await until(
      () => f.service.poll(f.camera, lease.leaseId),
      (r) => r.status === "waiting",
    );
    assert.equal(lost.frame, undefined);
    await f.update({ noSignal: false });
    const restored = await until(
      () => f.service.poll(f.camera, lease.leaseId, lost.sequence),
      (r) => !!r.frame,
    );
    assert.equal(restored.status, "live");
    assert.ok(restored.sequence > lost.sequence);
    f.service.release(lease.leaseId);
    await until(f.events, (events) => events.some((e) => e.event === "stop"));
  } finally {
    await f.close();
  }
});

test("format changes preserve leases and increasing sequence numbers, reject unsupported modes, and reopen only after release", async () => {
  const f = await fixture();
  try {
    f.camera.sourceId = (await f.service.list()).sources[0].id;
    const lease = f.service.open(f.camera);
    await f.service.capture(f.camera);
    const before = f.service.poll(f.camera, lease.leaseId);
    await assert.rejects(
      f.service.setFormat(f.camera.sourceId, "xxxx"),
      /does not support/,
    );
    await f.service.setFormat(f.camera.sourceId, "Hp59");
    const after = await until(
      () => f.service.poll(f.camera, lease.leaseId, before.sequence),
      (r) => !!r.frame,
    );
    assert.ok(after.sequence > before.sequence);
    const events = await f.events();
    assert.deepEqual(
      events.map((e) => e.event),
      ["start", "stop", "start"],
    );
    assert.deepEqual(events[2].args.slice(-2), ["--format", "Hp59"]);
    assert.equal(f.service.sources.get(f.camera.sourceId)!.format, "Hp59");
  } finally {
    await f.close();
  }
});

test("rapid close and reopen waits for the native handle to be released", async () => {
  const f = await fixture();
  try {
    f.camera.sourceId = (await f.service.list()).sources[0].id;
    const first = f.service.open(f.camera);
    await f.service.capture(f.camera);
    f.service.release(first.leaseId);
    const second = f.service.open(f.camera);
    await until(
      () => f.service.poll(f.camera, second.leaseId),
      (r) => !!r.frame,
    );
    const events = await f.events();
    assert.deepEqual(
      events.map((e) => e.event),
      ["start", "stop", "start"],
    );
  } finally {
    await f.close();
  }
});

test("eight mapped inputs use independent workers and snapshots do not add competing workers", async () => {
  const f = await fixture();
  try {
    const found = await f.service.list();
    const cameras = found.sources.map((source, i) => ({
      ...f.camera,
      id: `camera-${i}`,
      sourceId: source.id,
    }));
    const leases = cameras.map((camera) => f.service.open(camera));
    const frames = await Promise.all(
      cameras.map((camera) => f.service.capture(camera)),
    );
    assert.equal(new Set(frames.map((frame) => frame.sourceId)).size, 8);
    assert.equal(
      (await f.events()).filter((e) => e.event === "start").length,
      8,
    );
    leases.forEach((lease) => f.service.release(lease.leaseId));
  } finally {
    await f.close();
  }
});

test("busy input errors are actionable and untrusted native stderr is not exposed", async () => {
  const received: any[] = [];
  const parser = new DeckLinkEvents((event) => received.push(event));
  parser.push(
    Buffer.from('secret driver path\n{"event":"error","code":"input_'),
  );
  parser.push(Buffer.from('busy"}\n{"event":"error","code":"C:\\\\secret"}\n'));
  assert.match(received[0].error, /vMix/);
  assert.doesNotMatch(received[1].error, /secret/);
  const f = await fixture();
  try {
    f.camera.sourceId = (await f.service.list()).sources[0].id;
    await f.update({ error: "input_busy" });
    await assert.rejects(f.service.capture(f.camera), /Release it in vMix/);
  } finally {
    await f.close();
  }
});

test("capture_format persists native identity and settings through the shared UI/MCP command", async () => {
  const f = await fixture();
  const engine = new Engine(path.join(f.directory, "settings"));
  try {
    await engine.init();
    const source = (await f.bridge.list()).sources[0];
    engine.capture.register(source);
    await execute(
      commands(engine),
      "capture_format",
      { sourceId: source.id, format: "Hp30" },
      "ui",
    );
    const saved = JSON.parse(
      await readFile(path.join(engine.directory, "settings.json"), "utf8"),
    );
    assert.equal(saved.sources[0].format, "Hp30");
    assert.equal(saved.sources[0].backend, "decklink-sdk");
    await execute(
      commands(engine),
      "capture_format",
      { sourceId: source.id },
      "mcp",
    );
    assert.equal(engine.capture.sources.get(source.id)!.format, undefined);
  } finally {
    await engine.close();
    await f.close();
  }
});

const native = path.resolve("native/decklink/build/shader-decklink.exe");
test(
  "Windows native helper encodes a real JPEG without requiring DeckLink hardware",
  {
    skip: process.platform !== "win32" || !existsSync(native),
  },
  async () => {
    const result = JSON.parse(
      (await promisify(execFile)(native, ["--self-test"])).stdout,
    );
    assert.equal(result.ok, true);
    assert.equal(result.hardwareTested, false);
    assert.ok(result.jpegBytes > 1000);
    assert.equal(result.width, 960);
    assert.equal(result.height, 540);
  },
);
