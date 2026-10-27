import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Engine } from "../engine.js";
import { PresetService } from "../presets.js";
import { commands, execute } from "../commands.js";
import { orderedCameraIds, moveCameraId } from "../../app/camera-order.js";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-slots-"));
  const engine = new Engine(dir);
  await engine.init();
  await engine.connect({ vendor: "demo", host: "local" });
  const a = engine.camera("demo-studio"),
    b = { ...structuredClone(a), id: "second", name: "Cam2" },
    c = { ...structuredClone(a), id: "third", name: "Cam3" };
  for (const camera of [b, c]) {
    engine.cameras.set(camera.id, camera);
    engine.adapters.set(camera.id, engine.adapters.get(a.id)!);
  }
  const set = (camera: typeof a, value: number) =>
    engine.set(camera.id, "white_balance", value, camera.revision, "test");
  const value = (camera: typeof a) =>
    camera.controls.find((c) => c.id === "white_balance")!.value;
  return {
    dir,
    engine,
    a,
    b,
    c,
    set,
    value,
    close: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("numbered slots merge per-camera looks, scoped recall leaves other cameras untouched, and all recall uses distinct saved values", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      f.engine.presets.slots().map((s) => [s.number, s.cameras.length]),
      [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ],
    );
    await f.set(f.a, 3200);
    await f.engine.presets.saveSlot(1, [f.a.id], "test");
    const stable = f.engine.presets.slotReference(1);
    await f.set(f.a, 5000);
    await f.set(f.b, 6500);
    await f.engine.presets.saveSlot(1, [f.b.id], "test");
    assert.equal(f.engine.presets.slotReference(1), stable);
    const saved = f.engine.presets.get(stable);
    assert.equal(
      saved.cameras
        .find((c) => c.cameraId === f.a.id)!
        .controls.find((c) => c.id === "white_balance")!.value,
      3200,
    );
    await f.set(f.b, 4200);
    await f.set(f.c, 4400);
    const registry = commands(f.engine);
    const preview: any = await execute(
      registry,
      "preset_slot_preview",
      { slot: 1, cameraId: f.a.id },
      "test",
    );
    assert.deepEqual(Object.keys(preview.revisions), [f.a.id]);
    const job: any = await execute(
      registry,
      "preset_slot_recall",
      { slot: 1, cameraId: f.a.id, expectedRevisions: preview.revisions },
      "test",
    );
    assert.equal((await f.engine.presets.wait(job.id)).status, "applied");
    assert.equal(f.value(f.a), 3200);
    assert.equal(f.value(f.b), 4200);
    assert.equal(f.value(f.c), 4400);
    assert.throws(
      () => f.engine.presets.preview(stable, f.c.id),
      /no look saved/,
    );
    await f.set(f.a, 4500);
    const all = f.engine.presets.preview(stable);
    const allJob = f.engine.presets.recall(stable, 0, all.revisions, "test");
    assert.equal((await f.engine.presets.wait(allJob.id)).status, "applied");
    assert.equal(f.value(f.a), 3200);
    assert.equal(f.value(f.b), 6500);
    assert.equal(f.value(f.c), 4400);
    assert.deepEqual(new Set(allJob.cameraIds), new Set([f.a.id, f.b.id]));
  } finally {
    await f.close();
  }
});

test("slot names, added empty slots and camera membership survive restart without migrating or deleting old looks", async () => {
  const f = await fixture();
  try {
    const legacy = await f.engine.presets.save(
      {
        name: "Existing look",
        description: "",
        attachLighting: false,
        cameras: [{ cameraId: f.a.id }],
      },
      "test",
    );
    await f.engine.presets.saveSlot(1, [f.a.id, f.b.id], "test");
    await f.engine.presets.renameSlot(1, "Choir");
    await f.engine.presets.addSlot();
    await f.engine.presets.removeSlotCamera(1, f.a.id, "test");
    const restored = new PresetService(f.engine);
    await restored.init();
    assert.equal(restored.slots().length, 5);
    assert.equal(restored.slots()[0].label, "Choir");
    assert.deepEqual(
      restored.slots()[0].cameras.map((c) => c.cameraId),
      [f.b.id],
    );
    assert.equal(restored.get(legacy.id).name, "Existing look");
    await restored.removeSlotCamera(1, f.b.id, "test");
    assert.equal(restored.slots()[0].cameras.length, 0);
    assert.equal(restored.slots()[0].label, "Choir");
    assert.equal(restored.slots().length, 5);
    const disk = JSON.parse(
      await readFile(path.join(f.dir, "presets.json"), "utf8"),
    );
    // Old v1 libraries gain four empty numbered slots without changing their saved presets.
    delete disk.slotLabels;
    disk.presets = disk.presets.filter((p: any) => !p.slot);
    await writeFile(path.join(f.dir, "presets.json"), JSON.stringify(disk));
    const oldLibrary = new PresetService(f.engine);
    await oldLibrary.init();
    assert.equal(oldLibrary.slots().length, 4);
    assert.equal(oldLibrary.get(legacy.id).name, "Existing look");
  } finally {
    await f.close();
  }
});

test("all-camera preflight blocks locked cameras, camera-only recall remains scoped, and failed batch saves keep existing snapshots", async () => {
  const f = await fixture();
  try {
    for (const c of [f.a, f.b]) {
      c.vendor = "ptzoptics";
      c.status = "connected";
    }
    await f.engine.presets.saveSlot(1, [f.a.id, f.b.id], "test");
    const id = f.engine.presets.slotReference(1),
      before = f.engine.presets.get(id);
    await assert.rejects(
      f.engine.presets.saveSlot(1, [f.a.id, "not-connected"], "test"),
      /not found/,
    );
    assert.deepEqual(f.engine.presets.get(id), before);
    await f.set(f.a, 4000);
    await f.set(f.b, 4300);
    await f.engine.lock(f.b.id, true, "test");
    const all = f.engine.presets.preview(id);
    assert(all.blockers.some((b) => b.includes("locked")));
    assert.throws(
      () => f.engine.presets.recall(id, 0, all.revisions, "test"),
      /locked/,
    );
    assert.equal(f.value(f.a), 4000);
    const one = f.engine.presets.preview(id, f.a.id);
    assert.equal(one.blockers.length, 0);
    assert.throws(
      () => f.engine.presets.recall(id, 0, {}, "test", f.a.id),
      /state changed/,
    );
    const job = f.engine.presets.recall(id, 0, one.revisions, "test", f.a.id);
    assert.equal((await f.engine.presets.wait(job.id)).status, "applied");
    assert.equal(f.value(f.b), 4300);
    await assert.rejects(
      f.engine.presets.saveSlot(1, [f.a.id, f.a.id], "test"),
      /different cameras/,
    );
  } finally {
    await f.close();
  }
});

test("camera ordering preserves hidden/disconnected identities, appends new cameras and supports movement in both directions", () => {
  const saved = ["c", "offline", "b", "a", "b"],
    current = ["a", "b", "c", "new"];
  assert.deepEqual(orderedCameraIds(saved, current), ["c", "b", "a", "new"]);
  const moved = moveCameraId(saved, current, "a", "c");
  assert.deepEqual(moved, ["a", "c", "offline", "b", "new"]);
  assert.deepEqual(orderedCameraIds(moved, [...current, "offline"]), [
    "a",
    "c",
    "offline",
    "b",
    "new",
  ]);
  assert.deepEqual(moveCameraId(moved, current, "a", "new", true), [
    "c",
    "offline",
    "b",
    "new",
    "a",
  ]);
  assert.deepEqual(moveCameraId(moved, current, "a", "invalid"), moved);
});
