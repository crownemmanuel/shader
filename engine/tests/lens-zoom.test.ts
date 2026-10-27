import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CameraControlUpdateCommand } from "atem-connection/dist/commands/CameraControlCommand.js";
import { AtemAdapter, fromAtem } from "../adapters/atem.js";
import { Engine, DRIVE_DEADMAN_MS } from "../engine.js";
import { commands, execute } from "../commands.js";
import { validateValue, type Camera } from "../types.js";

function zoomControl() {
  const packet = Buffer.alloc(24);
  packet[0] = 1;
  packet[1] = 0;
  packet[2] = 9;
  packet[3] = 128;
  packet.writeUInt16BE(1, 6);
  return fromAtem(CameraControlUpdateCommand.deserialize(packet));
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-lens-zoom-"));
  const engine = new Engine(dir);
  await engine.init();
  const writes: { id: string; speed: number }[] = [];
  const adapter = new AtemAdapter();
  adapter.set = async (c, control, value) => {
    assert.equal(control.id, "0.9");
    writes.push({ id: c.id, speed: Number(value) });
    return { verified: false };
  };
  // No physical camera or switcher connection is opened by this fixture.
  const camera: Camera = {
    id: "atem-test-1",
    name: "Cam 1",
    vendor: "atem",
    model: "ATEM",
    address: "test",
    status: "connected",
    revision: 0,
    tally: "off",
    controls: [zoomControl()],
  };
  engine.cameras.set(camera.id, camera);
  engine.adapters.set(camera.id, adapter);
  const registry = commands(engine);
  const zoom = (speed: number) =>
    execute(registry, "lens_zoom", { cameraId: camera.id, speed }, "ui");
  return {
    engine,
    camera,
    adapter,
    writes,
    zoom,
    close: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("ATEM continuous zoom uses normalized speed bounds, not fixed16 wire bounds", () => {
  const control = zoomControl();
  assert.equal(control.type, "number");
  assert.equal(control.min, -1);
  assert.equal(control.max, 1);
  for (const speed of [-1, -0.5, 0, 0.5, 1]) validateValue(control, speed);
  assert.throws(() => validateValue(control, 1.01));
  assert.throws(() => validateValue(control, -1.01));
});

test("lens zoom changes direction, deduplicates keepalives and stops if they lapse", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.zoom(1.01));
    await assert.rejects(f.zoom(-1.01));
    assert.equal(f.writes.length, 0);
    await f.zoom(0.5);
    await sleep(350);
    await f.zoom(0.5);
    await sleep(350);
    assert.deepEqual(
      f.writes.map((w) => w.speed),
      [0.5],
    );
    await f.zoom(-0.25);
    await sleep(DRIVE_DEADMAN_MS + 100);
    assert.deepEqual(
      f.writes.map((w) => w.speed),
      [0.5, -0.25, 0],
    );
    assert.ok(
      f.engine.audit.some(
        (entry) =>
          entry.operation === "lens_zoom" && /signal lost/.test(entry.detail),
      ),
    );
  } finally {
    await f.close();
  }
});

test("release and camera lock stop lens zoom; a locked camera still accepts zero", async () => {
  const f = await fixture();
  try {
    await f.zoom(1);
    await f.zoom(0);
    await f.zoom(-1);
    await f.engine.lock(f.camera.id, true, "ui");
    await assert.rejects(f.zoom(0.5), /locked/);
    await f.zoom(0);
    assert.deepEqual(
      f.writes.map((w) => w.speed),
      [1, 0, -1, 0, 0],
    );
  } finally {
    await f.close();
  }
});

test("disconnect stops all moving cameras on a shared ATEM before closing it", async () => {
  const f = await fixture();
  try {
    const second = { ...f.camera, id: "atem-test-2" };
    f.engine.cameras.set(second.id, second);
    f.engine.adapters.set(second.id, f.adapter);
    await f.zoom(0.5);
    await f.engine.lensZoom(second.id, -0.5, "ui");
    let closed = false;
    f.adapter.close = async () => {
      assert.deepEqual(f.writes.slice(-2), [
        { id: f.camera.id, speed: 0 },
        { id: second.id, speed: 0 },
      ]);
      closed = true;
    };
    await f.engine.disconnect(f.camera.id);
    assert.equal(closed, true);
    assert.equal(f.engine.cameras.size, 0);
  } finally {
    await f.close();
  }
});

test("a delayed acknowledgement cannot block the dead-man stop", async () => {
  const f = await fixture();
  try {
    const send = f.adapter.set.bind(f.adapter);
    let acknowledge!: () => void;
    f.adapter.set = async (c, control, value) => {
      const result = await send(c, control, value);
      if (value !== 0)
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      return result;
    };
    const pending = f.zoom(0.5);
    await sleep(DRIVE_DEADMAN_MS + 100);
    assert.deepEqual(
      f.writes.map((w) => w.speed),
      [0.5, 0],
    );
    acknowledge();
    await pending;
    await sleep(50);
    assert.equal(f.writes.at(-1)?.speed, 0);
  } finally {
    await f.close();
  }
});

test("engine shutdown stops a held ATEM zoom", async () => {
  const f = await fixture();
  try {
    await f.zoom(0.75);
  } finally {
    await f.close();
  }
  assert.deepEqual(
    f.writes.map((w) => w.speed),
    [0.75, 0],
  );
});
