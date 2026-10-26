import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Engine } from "../engine.js";
import { commands, execute } from "../commands.js";
import { validateValue } from "../types.js";
import {
  CameraControlUpdateCommand,
  CameraControlCommand,
} from "atem-connection/dist/commands/CameraControlCommand.js";
import { AtemAdapter, fromAtem, nativeCommand } from "../adapters/atem.js";
import { ViscaTransport, nibbles, parseReply } from "../adapters/ptzoptics.js";
import { startServer } from "../server.js";
import { toMcpResult } from "../mcp.js";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-test-"));
  const engine = new Engine(dir);
  await engine.init();
  await engine.connect({ vendor: "demo", host: "local" });
  return {
    engine,
    close: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("UI and MCP registry share validation, revision guard and write result", async () => {
  const f = await fixture();
  try {
    const registry = commands(f.engine),
      c = f.engine.camera("demo-studio");
    const result: any = await execute(
      registry,
      "control_set",
      {
        cameraId: c.id,
        controlId: "white_balance",
        value: 6000,
        expectedRevision: 0,
      },
      "mcp",
    );
    assert.equal(result.camera.controls[0].value, 6000);
    assert.equal(result.verified, true);
    await assert.rejects(
      execute(
        registry,
        "control_set",
        {
          cameraId: c.id,
          controlId: "white_balance",
          value: 6100,
          expectedRevision: 0,
        },
        "ui",
      ),
      /state changed/,
    );
    await assert.rejects(
      execute(
        registry,
        "control_set",
        {
          cameraId: c.id,
          controlId: "white_balance",
          value: 20000,
          expectedRevision: 1,
        },
        "ui",
      ),
      /between/,
    );
    assert.equal(c.revision, 1);
  } finally {
    await f.close();
  }
});
test("concurrent writes using the same revision cannot silently overwrite each other", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.engine.set("demo-studio", "tint", 1, 0, "ui"),
      f.engine.set("demo-studio", "tint", 2, 0, "mcp"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    await f.close();
  }
});
test("cameras are writable until locked, including live and unknown tally; locks persist", async () => {
  const f = await fixture();
  try {
    const c = f.engine.camera("demo-studio");
    c.vendor = "ptzoptics";
    c.status = "connected";
    c.tally = "unknown";
    assert.doesNotThrow(() => f.engine.guard(c));
    c.tally = "program";
    assert.doesNotThrow(() => f.engine.guard(c));
    await f.engine.lock(c.id, true, "ui");
    assert.throws(() => f.engine.guard(c), /locked/);
    assert.equal(f.engine.list().find((x) => x.id === c.id)!.locked, true);
    const restarted = new Engine(f.engine.directory);
    await restarted.init();
    assert.ok(restarted.locks.has(c.id));
    await f.engine.lock(c.id, false, "ui");
    assert.doesNotThrow(() => f.engine.guard(c));
  } finally {
    await f.close();
  }
});
test("vector writes validate every component and reject NaN", async () => {
  const f = await fixture();
  try {
    const c = f.engine
      .camera("demo-studio")
      .controls.find((x) => x.id === "lift")!;
    assert.throws(() => validateValue(c, [0, 0, 0]), /components/);
    assert.throws(() => validateValue(c, [0, 0, 0, NaN]), /finite/);
    assert.throws(() => validateValue(c, [0, 0, 0, 2]), /between/);
  } finally {
    await f.close();
  }
});
test("ATEM CCdP fixture decodes correctly and CCmd preserves native vector ordering", () => {
  const p = Buffer.alloc(24);
  p[0] = 4;
  p[1] = 8;
  p[2] = 0;
  p[3] = 128;
  p.writeUInt16BE(4, 6);
  p.writeInt16BE(-1024, 16);
  p.writeInt16BE(256, 18);
  p.writeInt16BE(0, 20);
  p.writeInt16BE(2048, 22);
  const c = fromAtem(CameraControlUpdateCommand.deserialize(p));
  assert.deepEqual(c.value, [-0.5, 0.125, 0, 1]);
  assert.equal(c.id, "8.0");
  const packet = new CameraControlCommand(4, 8, 0, {
    type: 128,
    numberData: c.value as number[],
    boolData: [],
    bigintData: [],
    stringData: "",
    relative: false,
  }).serialize();
  assert.equal(packet[4], 128);
  assert.equal(packet.readInt16BE(16), -1024);
  assert.equal(packet.readUInt16BE(8), 4);
});
test("ATEM cameras return to connected when the switcher reconnects on its own", () => {
  const changed: string[] = [];
  const atem = new AtemAdapter((c) => changed.push(c.status));
  atem.cameras.set(4, {
    id: "atem-test-4",
    name: "Cam4",
    vendor: "atem",
    model: "Blackmagic via ATEM",
    address: "test",
    status: "connected",
    revision: 0,
    tally: "program",
    controls: [],
  });
  atem.client.emit("disconnected");
  assert.equal(atem.cameras.get(4)!.status, "disconnected");
  atem.client.emit("connected");
  assert.equal(atem.cameras.get(4)!.status, "connected");
  assert.deepEqual(changed, ["disconnected", "connected"]);
});
test("VISCA handles split frames, ACK then completion, and camera error replies", async () => {
  const requests: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (data) => {
      requests.push(data);
      if (data[1] === 9) {
        socket.write(Buffer.from([0x90, 0x50, 0, 0]));
        setTimeout(() => socket.write(Buffer.from([8, 0, 255])), 10);
      } else socket.write(Buffer.from([0x90, 0x41, 255, 0x90, 0x51, 255]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const transport = new ViscaTransport(
    "127.0.0.1",
    (server.address() as net.AddressInfo).port,
  );
  try {
    const reply = await transport.request([0x81, 9, 4, 0x43, 255]);
    assert.deepEqual([...reply], [0, 0, 8, 0]);
    await transport.request([0x81, 1, 4, 0x43, 0, 0, 8, 0, 255]);
    assert.equal(requests.length, 2);
    assert.throws(
      () => parseReply(Buffer.from([0x90, 0x60, 2, 255])),
      /rejected/,
    );
    assert.deepEqual(nibbles(255), [0, 0, 15, 15]);
  } finally {
    transport.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("HTTP engine rejects absent bearer tokens and browser origins", async () => {
  const f = await fixture(),
    running = await startServer(f.engine);
  try {
    const base = running.session.url;
    assert.equal((await fetch(base + "/health")).status, 401);
    assert.equal(
      (
        await fetch(base + "/health", {
          headers: {
            Authorization: `Bearer ${running.session.token}`,
            Origin: "https://evil.invalid",
          },
        })
      ).status,
      403,
    );
    const result = await fetch(base + "/rpc", {
      method: "POST",
      headers: { Authorization: `Bearer ${running.session.token}` },
      body: JSON.stringify({
        name: "camera_get",
        args: { cameraId: "demo-studio" },
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as any).result.id, "demo-studio");
  } finally {
    await running.close();
    await f.close();
  }
});
test("MCP capture result includes actual image content, not only JSON", () => {
  const result = toMcpResult({
    id: "frame",
    mimeType: "image/jpeg",
    data: "YWJj",
    cameraId: "cam",
  });
  assert.equal(result.content[1].type, "image");
  assert.ok(!result.content[0].text?.includes("YWJj"));
});
test("provider credentials are omitted from persisted settings and cannot carry to another provider", async () => {
  const f = await fixture();
  try {
    f.engine.assistant.configure({
      provider: "openai",
      model: "fixture-model",
      vision: false,
      apiKey: "test-secret-not-real",
    });
    assert.equal(f.engine.assistant.settings().configured, true);
    f.engine.assistant.configure({
      provider: "groq",
      model: "fixture",
      vision: false,
    });
    assert.equal(f.engine.assistant.settings().configured, false);
    await f.engine.save();
    const { readFile } = await import("node:fs/promises");
    assert.ok(
      !(
        await readFile(path.join(f.engine.directory, "settings.json"), "utf8")
      ).includes("test-secret"),
    );
  } finally {
    await f.close();
  }
});
test("capture requires explicit camera-to-source mapping", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.engine.capture.capture(f.engine.camera("demo-studio")),
      /Assign a capture input/,
    );
    assert.throws(
      () =>
        f.engine.capture.register({
          id: "bad",
          name: "bad",
          kind: "v4l2",
          device: "/etc/passwd",
        }),
      /videoN/,
    );
  } finally {
    await f.close();
  }
});

test("ATEM native commands preserve 64-bit values and count UTF-8 bytes", () => {
  const int64 = nativeCommand(1, {
    category: 9,
    parameter: 1,
    type: 4,
    values: ["9223372036854775807"],
  }).serialize();
  assert.equal(int64.readBigInt64BE(16), 9223372036854775807n);
  const text = nativeCommand(1, {
    category: 9,
    parameter: 2,
    type: 5,
    values: ["Café 🎥"],
  }).serialize();
  assert.equal(text.readUInt16BE(6), 10);
  assert.equal(text.subarray(16, 26).toString(), "Café 🎥");
  assert.throws(
    () =>
      nativeCommand(1, {
        category: 9,
        parameter: 1,
        type: 4,
        values: ["9223372036854775808"],
      }),
    /range/,
  );
});
test("change feed wakes waiters and Simple sessions detect outside edits with fixed-point tolerance", async () => {
  const f = await fixture();
  try {
    const now = f.engine.changeVersion;
    assert.deepEqual(await f.engine.waitForChange(now - 1, 1000), {
      version: now,
    });
    const waiting = f.engine.waitForChange(now, 5000);
    f.engine.emit("change");
    assert.equal((await waiting).version, now + 1);
    assert.equal((await f.engine.waitForChange(now + 1, 100)).version, now + 1);

    const session = f.engine.beginShade("demo-studio");
    const shade = () =>
      (f.engine.list().find((c) => c.id === "demo-studio") as any).shade;
    assert.deepEqual(shade(), { sessionId: session.sessionId, synced: true });
    const gain = f.engine
      .camera("demo-studio")
      .controls.find((c) => c.id === "gain_db")!;
    gain.value = Number(gain.value) + 1 / 4096;
    assert.equal(shade().synced, true);
    gain.value = Number(gain.value) + 3;
    assert.equal(shade().synced, false);
    assert.throws(
      () =>
        f.engine.planShade("demo-studio", session.sessionId, {
          brightness: 0,
          warmth: 0,
          tint: 0,
        }),
      /settings changed/,
    );
  } finally {
    await f.close();
  }
});
test("live control writes skip the revision check and the activity log; final writes are logged", async () => {
  const f = await fixture();
  try {
    const run = (args: Record<string, unknown>) =>
      execute(
        commands(f.engine),
        "control_set",
        { cameraId: "demo-studio", controlId: "gain_db", ...args },
        "ui",
      );
    const logged = () =>
      f.engine.audit.filter((a) => a.operation === "control_set").length;
    const before = logged();
    for (const value of [1, 2, 3]) await run({ value, live: true });
    assert.equal(logged(), before);
    await run({ value: 4 });
    assert.equal(logged(), before + 1);
    assert.equal(
      f.engine.camera("demo-studio").controls.find((c) => c.id === "gain_db")!
        .value,
      4,
    );
    await assert.rejects(
      run({ value: 5, expectedRevision: 0 }),
      /Camera state changed/,
    );
  } finally {
    await f.close();
  }
});
test("hidden cameras persist, stay connected and can be set before an input reports", async () => {
  const f = await fixture();
  try {
    await execute(
      commands(f.engine),
      "cameras_hide",
      { cameraIds: ["demo-studio", "atem-172.16.10.10-15"], hidden: true },
      "ui",
    );
    const listed = f.engine.list().find((c) => c.id === "demo-studio")!;
    assert.equal(listed.hidden, true);
    assert.doesNotThrow(() => f.engine.camera("demo-studio"));
    const restarted = new Engine(f.engine.directory);
    await restarted.init();
    assert.deepEqual([...restarted.hidden].sort(), [
      "atem-172.16.10.10-15",
      "demo-studio",
    ]);
    await f.engine.hide(["demo-studio"], false, "ui");
    assert.equal(
      f.engine.list().find((c) => c.id === "demo-studio")!.hidden,
      false,
    );
  } finally {
    await f.close();
  }
});
