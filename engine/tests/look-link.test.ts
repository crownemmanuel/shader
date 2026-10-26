import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import { Engine } from "../engine.js";
import { commands, execute } from "../commands.js";
import { analyzeLook, type LookMessage } from "../lighting-types.js";
import { presetValue } from "../preset-values.js";
import { oscDecode, oscEncode } from "../osc.js";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function port() {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-look-")),
    engine = new Engine(dir);
  await engine.init();
  await engine.connect({ vendor: "demo", host: "local" });
  const c = engine.camera("demo-studio");
  const save = async (name = "Warm face", ids = [c.id]) =>
    engine.presets.save(
      {
        name,
        description: "Test fixture",
        cameras: ids.map((cameraId) => ({ cameraId })),
        attachLighting: true,
      },
      "test",
    );
  return {
    dir,
    engine,
    c,
    save,
    close: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const look = (extras: Partial<LookMessage> = {}): LookMessage => ({
  protocol: "stagelight.look/1",
  type: "look",
  seq: 10,
  target: "camera-control",
  output: { armed: true, blackout: false },
  cue: { id: "sunrise", name: "Sunrise", entry: "entry1" },
  reason: "cue",
  level: 0.7,
  zones: [
    {
      id: "face",
      role: "face",
      name: "Face lights",
      lit: 4,
      fixtures: 4,
      white: true,
      level: 0.7,
      kelvin: 3200,
      duv: 0.004,
      colorUnknown: 0,
      saturation: 0.6,
    },
  ],
  ...extras,
});

test("presets survive restart, keep stable IDs, exclude actions and support archive/catalogue/name matching", async () => {
  const f = await fixture();
  try {
    const p = await f.save();
    assert.equal(
      p.cameras[0].controls.some(
        (c) => c.id === "autofocus" || c.id === "focus",
      ),
      false,
    );
    assert.equal(f.engine.presets.get(p.id.toUpperCase()).id, p.id);
    assert.equal(f.engine.presets.get("warm FACE").id, p.id);
    await assert.rejects(
      f.engine.presets.save(
        {
          name: "Bad",
          description: "",
          attachLighting: false,
          cameras: [{ cameraId: f.c.id, controlIds: ["autofocus"] }],
        },
        "test",
      ),
      /unavailable/,
    );
    await f.engine.presets.save(
      {
        id: p.id,
        name: "Renamed",
        description: "",
        attachLighting: true,
        cameras: [{ cameraId: f.c.id }],
      },
      "test",
    );
    const restored = new Engine(f.dir);
    await restored.init();
    assert.equal(restored.presets.get(p.id).name, "Renamed");
    await restored.presets.archive(p.id, true);
    assert.deepEqual(restored.presets.catalogue(), []);
    await restored.presets.archive(p.id, false);
    assert.equal(restored.presets.catalogue()[0].id, p.id);
    await restored.close();
    const data = await readFile(path.join(f.dir, "presets.json"), "utf8");
    assert.ok(!data.includes("apiKey"));
  } finally {
    await f.close();
  }
});
test("scene preflight prevents partial writes for unavailable cameras; recalls validate revisions and report partial hardware failure", async () => {
  const f = await fixture();
  try {
    const second = {
      ...structuredClone(f.c),
      id: "demo-second",
      name: "Second",
    };
    f.engine.cameras.set(second.id, second);
    f.engine.adapters.set(second.id, f.engine.adapters.get(f.c.id)!);
    const p = await f.save("Scene", [f.c.id, second.id]);
    await f.engine.set(f.c.id, "white_balance", 4000, f.c.revision, "test");
    await f.engine.set(
      second.id,
      "white_balance",
      4000,
      second.revision,
      "test",
    );
    f.engine.cameras.delete(second.id);
    const blocked = f.engine.presets.preview(p.id);
    assert.equal(blocked.blockers.length, 1);
    assert.throws(
      () => f.engine.presets.recall(p.id, 0, blocked.revisions, "test"),
      /not found/,
    );
    assert.equal(f.c.controls[0].value, 4000);
    f.engine.cameras.set(second.id, second);
    const preview = f.engine.presets.preview(p.id);
    assert.throws(
      () => f.engine.presets.recall(p.id, 0, {}, "test"),
      /state changed/,
    );
    const original = f.engine.adapters.get(second.id)!;
    f.engine.adapters.set(second.id, {
      ...original,
      connect: original.connect.bind(original),
      refresh: original.refresh.bind(original),
      close: original.close.bind(original),
      set: async () => {
        throw new Error("Fixture hardware rejection");
      },
    });
    const job = f.engine.presets.recall(p.id, 0, preview.revisions, "test"),
      result = await f.engine.presets.wait(job.id);
    assert.equal(result.status, "failed");
    assert.equal(result.completedWrites, 1);
    assert.equal(f.c.controls[0].value, 5600);
    assert.equal(second.controls[0].value, 4000);
  } finally {
    await f.close();
  }
});
test("white-balance fades interpolate in mired; manual control cancels a fade", async () => {
  const f = await fixture();
  try {
    const control = f.c.controls[0];
    control.value = 3000;
    assert.equal(presetValue(f.c, control, 6000, 0.5), 4000);
    assert.equal(
      presetValue(
        f.c,
        f.c.controls.find((c) => c.id === "shutter_speed")!,
        120,
        0.5,
      ),
      60,
    );
    control.value = 6000;
    const p = await f.save();
    await f.engine.set(f.c.id, "white_balance", 3000, f.c.revision, "test");
    const job = f.engine.presets.recall(
      p.id,
      1.5,
      f.engine.presets.preview(p.id).revisions,
      "test",
    );
    await pause(300);
    await f.engine.set(f.c.id, "white_balance", 4500, f.c.revision, "ui");
    const result = await f.engine.presets.wait(job.id);
    assert.equal(result.status, "cancelled");
    assert.equal(f.c.controls[0].value, 4500);
  } finally {
    await f.close();
  }
});
test("scene recalls stop if saved controls change externally and never bypass camera locks", async () => {
  const f = await fixture();
  try {
    const p = await f.save();
    await f.engine.set(f.c.id, "white_balance", 3000, f.c.revision, "test");
    const job = f.engine.presets.recall(
      p.id,
      1,
      f.engine.presets.preview(p.id).revisions,
      "test",
    );
    await pause(50);
    f.c.controls[0].value = 4500;
    assert.equal((await f.engine.presets.wait(job.id)).status, "failed");
    f.c.vendor = "ptzoptics";
    f.c.status = "connected";
    const physical = await f.save("Physical");
    assert.ok(
      f.engine.presets
        .preview(physical.id)
        .blockers.some((b) => b.includes("locked")),
    );
  } finally {
    await f.close();
  }
});
test("lighting analysis prefers face white, weighs mired, ignores effects, preserves intentional color and treats legacy data cautiously", () => {
  const message = look();
  message.zones!.push({
    id: "face2",
    role: "face",
    lit: 1,
    white: true,
    level: 0.7,
    kelvin: 6400,
    duv: -0.002,
    colorUnknown: 0,
  });
  message.zones!.push({
    id: "effect",
    role: "effect",
    lit: 40,
    white: true,
    level: 1,
    kelvin: 10000,
    duv: 0,
    colorUnknown: 0,
  });
  const result = analyzeLook(message);
  assert.equal(result.nominalKelvin, 4267);
  assert.equal(result.tintDirection, "magenta");
  message.zones![0].white = false;
  assert.match(analyzeLook(message).hold!, /Intentional color/);
  message.zones![0].white = true;
  message.zones![0].colorUnknown = 1;
  assert.equal(analyzeLook(message).confidence, "low");
  assert.equal(
    analyzeLook({
      type: "look",
      groups: [{ name: "Face", level: 1, kelvin: 3200 }],
    }).nominalKelvin,
    null,
  );
});
test("HTTP receiver ACKs quickly, publishes only summaries, rejects malformed/origin requests, deduplicates and ignores future protocols", async () => {
  const f = await fixture();
  try {
    const p = await f.save();
    await f.engine.lighting.configure({
      ...f.engine.lighting.config,
      enabled: true,
      httpPort: await port(),
      feedback: false,
    });
    const endpoint = f.engine.lighting.settings().endpoint;
    const post = (body: unknown, headers = {}) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const start = performance.now(),
      response = await post(look({ id: "one", unexpected: "ignored" } as any));
    assert.equal(response.status, 200);
    assert.ok(performance.now() - start < 1000);
    assert.equal(
      ((await (await post(look({ id: "one", seq: 11 }))).json()) as any)
        .summary,
      "Duplicate message",
    );
    assert.match(
      ((await (await post(look({ seq: 9 }))).json()) as any).summary,
      /Stale/,
    );
    const catalogue: any = await (
      await post({ type: "presets.request" })
    ).json();
    assert.deepEqual(Object.keys(catalogue.presets[0]).sort(), [
      "description",
      "id",
      "name",
    ]);
    assert.equal(catalogue.presets[0].id, p.id);
    assert.equal(
      (await post({ type: "look" }, { origin: "https://example.invalid" }))
        .status,
      403,
    );
    assert.equal(
      (await post({ type: "look", zones: [{ level: -1 }] })).status,
      400,
    );
    assert.equal(
      (
        (await (
          await post({ type: "look", protocol: "stagelight.look/2" })
        ).json()) as any
      ).status,
      "ignored",
    );
    assert.equal(
      ((await (await post({ type: "new-type" })).json()) as any).status,
      "ignored",
    );
    assert.equal(
      (
        (await (
          await post({ type: "preset", preset: "missing" })
        ).json()) as any
      ).ok,
      false,
    );
    assert.equal(f.c.revision, 0);
  } finally {
    await f.close();
  }
});
test("automatic recalls require live context; following preview/test/blackout look cancels preset before camera writes", async () => {
  const f = await fixture();
  try {
    const p = await f.save();
    f.engine.lighting.config.automation = true;
    for (const [index, state] of [
      { output: { armed: false } },
      { test: true },
      { output: { armed: true, blackout: true } },
      { lit: 0 },
    ].entries()) {
      f.engine.lighting.reset();
      f.engine.lighting.receive(look({ seq: 1 }));
      const result: any = f.engine.lighting.receive({
        type: "preset",
        target: "camera-control",
        preset: p.id,
        seq: 2,
        id: `preset${index}`,
      });
      assert.equal(result.status, "queued");
      f.engine.lighting.receive(look({ seq: 3, ...state }));
      await pause(230);
      assert.equal(f.engine.presets.jobs.length, 0);
    }
    f.engine.lighting.reset();
    f.engine.lighting.receive({ type: "preset", preset: p.id });
    await pause(230);
    assert.equal(f.engine.presets.jobs.length, 0);
    await f.engine.set(f.c.id, "white_balance", 3000, f.c.revision, "test");
    f.engine.lighting.receive({
      type: "preset",
      target: "camera-control",
      preset: p.id,
      seq: 10,
    });
    f.engine.lighting.receive(look({ seq: 11 }));
    await pause(260);
    assert.equal(f.engine.presets.jobs[0].status, "applied");
    assert.equal(f.c.controls[0].value, 5600);
  } finally {
    await f.close();
  }
});
test("cue rules persist, explicit preset wins over following look mapping, and fresh cue rules recall through shared engine", async () => {
  const f = await fixture();
  try {
    const p = await f.save();
    await f.engine.set(f.c.id, "white_balance", 3200, f.c.revision, "test");
    const other = await f.save("Other");
    await f.engine.lighting.saveRule({
      name: "Sunrise",
      presetId: other.id,
      enabled: true,
      cueId: "sunrise",
    });
    f.engine.lighting.config.automation = true;
    f.engine.lighting.receive({
      type: "preset",
      target: "camera-control",
      preset: p.id,
      seq: 1,
      cue: { id: "sunrise" },
    });
    f.engine.lighting.receive(look({ seq: 2 }));
    await pause(260);
    assert.equal(f.engine.presets.jobs.length, 1);
    assert.equal(f.engine.presets.jobs[0].presetId, p.id);
    f.engine.lighting.reset();
    f.engine.lighting.receive(look());
    await pause(260);
    assert.equal(f.engine.presets.jobs[0].presetId, other.id);
    assert.equal(f.c.controls[0].value, 3200);
    assert.equal(
      JSON.parse(await readFile(path.join(f.dir, "lighting.json"), "utf8"))
        .rules.length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("OSC codec validates packet boundaries; real UDP bursts commit only complete matching zones", async () => {
  const f = await fixture(),
    sender = dgram.createSocket("udp4");
  try {
    assert.deepEqual(
      oscDecode(oscEncode("/test", "sif", ["Café", 3, 0.5]))[0].args,
      ["Café", 3, 0.5],
    );
    assert.throws(() => oscDecode(Buffer.from([1, 2, 3])), /size/);
    assert.throws(
      () =>
        oscDecode(Buffer.concat([oscEncode("/x", "i", [1]), Buffer.alloc(4)])),
      /trailing/,
    );
    await f.engine.lighting.configure({
      ...f.engine.lighting.config,
      enabled: true,
      oscEnabled: true,
      httpPort: await port(),
      oscPort: await port(),
      feedback: false,
    });
    const send = (address: string, types: string, args: (string | number)[]) =>
      new Promise<void>((r, j) =>
        sender.send(
          oscEncode(address, types, args),
          f.engine.lighting.config.oscPort,
          "127.0.0.1",
          (e) => (e ? j(e) : r()),
        ),
      );
    await send("/stagelight/look/begin", "isssfii", [
      1,
      "cue",
      "Act 1",
      "Warm",
      1,
      1,
      1,
    ]);
    await send("/stagelight/look/end", "i", [1]);
    await pause(20);
    assert.equal(f.engine.lighting.context().states.length, 0);
    await send("/stagelight/look/begin", "isssfii", [
      2,
      "cue",
      "Act 1",
      "Warm",
      1,
      1,
      1,
    ]);
    await send("/stagelight/look", "ssifsf", [
      "Act 1",
      "Warm",
      3200,
      0.7,
      "#ffc58a",
      0.6,
    ]);
    await send("/stagelight/look/zone", "isssiffsfiiii", [
      2,
      "face",
      "face",
      "Face",
      3200,
      0.004,
      0.7,
      "#ffc58a",
      0.6,
      1,
      4,
      4,
      0,
    ]);
    await send("/stagelight/look/end", "i", [2]);
    await pause(30);
    const state = f.engine.lighting.context().states[0];
    assert.equal(state.message.seq, 2);
    assert.equal(state.analysis.nominalKelvin, 3200);
  } finally {
    sender.close();
    await f.close();
  }
});
test("preset/lighting MCP commands share schemas and selected-camera preset scope rejects multi-camera scenes", async () => {
  const f = await fixture();
  try {
    const registry = commands(f.engine),
      second = { ...structuredClone(f.c), id: "second" };
    f.engine.cameras.set(second.id, second);
    f.engine.adapters.set(second.id, f.engine.adapters.get(f.c.id)!);
    const scene = await f.save("Scene", [f.c.id, second.id]);
    await assert.rejects(
      execute(
        registry,
        "preset_recall",
        {
          presetId: scene.id,
          cameraId: f.c.id,
          expectedRevisions: f.engine.presets.preview(scene.id).revisions,
        },
        "assistant",
      ),
      /scope/,
    );
    await assert.rejects(
      execute(
        registry,
        "camera_preset_save",
        { cameraId: f.c.id, id: scene.id, name: "Overwrite" },
        "assistant",
      ),
      /scope/,
    );
    const p: any = await execute(
      registry,
      "camera_preset_save",
      { cameraId: f.c.id, name: "Agent look", attachLighting: true },
      "assistant",
    );
    assert.ok(p.lighting);
    assert.equal(p.cameras.length, 1);
    const settings: any = await execute(
      registry,
      "lighting_settings",
      {},
      "ui",
    );
    assert.ok(settings.endpoint.includes("/stagelight/"));
    assert.ok(
      !JSON.stringify(
        await execute(registry, "lighting_state", {}, "assistant"),
      ).includes(settings.endpoint),
    );
  } finally {
    await f.close();
  }
});

test("OSC pull, correlated feedback and catalogue replies reach the configured local StageLight fixture", async () => {
  const f = await fixture(),
    stage = dgram.createSocket("udp4"),
    received: ReturnType<typeof oscDecode> = [];
  await new Promise<void>((r) => stage.bind(0, "127.0.0.1", r));
  stage.on("message", (bytes) => received.push(...oscDecode(bytes)));
  try {
    const p = await f.save();
    await f.engine.lighting.configure({
      ...f.engine.lighting.config,
      enabled: true,
      oscEnabled: true,
      automation: true,
      httpPort: await port(),
      oscPort: await port(),
      stagePort: stage.address().port,
    });
    await f.engine.lighting.request();
    await f.engine.lighting.feedback(
      "message-123",
      "applied",
      "Saved a camera look",
    );
    await new Promise<void>((r, j) =>
      stage.send(
        oscEncode("/stagelight/presets/request", "i", [stage.address().port]),
        f.engine.lighting.config.oscPort,
        "127.0.0.1",
        (e) => (e ? j(e) : r()),
      ),
    );
    await pause(40);
    assert.deepEqual(
      received
        .find((m) => m.address === "/stagelight/look/get")
        ?.args.slice(0, 2),
      ["camera-control", f.engine.lighting.config.oscPort],
    );
    assert.deepEqual(
      received.find((m) => m.address === "/stagelight/feedback")?.args,
      ["message-123", "applied", "Saved a camera look"],
    );
    assert.equal(
      received.find((m) => m.address === "/stagelight/presets/item")?.args[0],
      p.id,
    );
    assert.ok(received.some((m) => m.address === "/stagelight/presets/end"));
    // Failed reconfiguration restores the original listener and never broadens access.
    await assert.rejects(
      f.engine.lighting.configure({
        ...f.engine.lighting.config,
        bind: "0.0.0.0",
        allowedSenders: [],
      }),
      /IPv4/,
    );
    const occupied = net.createServer();
    await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r));
    await assert.rejects(
      f.engine.lighting.configure({
        ...f.engine.lighting.config,
        httpPort: (occupied.address() as net.AddressInfo).port,
      }),
      /EADDRINUSE/,
    );
    await new Promise<void>((r) => occupied.close(() => r()));
    assert.equal(f.engine.lighting.settings().listening, true);
    const response = await fetch(f.engine.lighting.settings().endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "hello" }),
    });
    assert.equal(response.status, 200);
  } finally {
    stage.close();
    await f.close();
  }
});
