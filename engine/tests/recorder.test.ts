import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Engine } from "../engine.js";
import { commands } from "../commands.js";
import { CaptureService } from "../capture.js";
import { updateInstallBlocker } from "../update-safety.js";
import type { Camera } from "../types.js";

test("recorder preview sharing keeps input ownership out of the short-lived capture process", async () => {
  const service = new CaptureService();
  const source = {
    id: "input1",
    name: "Choir",
    kind: "decklink" as const,
    device: "pid:12:sub:0",
  };
  service.register(source);
  let sequence = 0;
  service.external = {
    owns: (id) => id === source.id,
    preview: async () => ({
      sequence: ++sequence,
      status: "live",
      data: Buffer.from("fixture-jpeg").toString("base64"),
      capturedAt: Date.now().toString(),
    }),
  };
  const camera = { id: "cam1", sourceId: source.id, revision: 4 } as Camera;
  try {
    const lease = service.open(camera);
    const p = await service.poll(camera, lease.leaseId);
    assert.equal(p.frame?.revision, 4);
    assert.equal(p.frame?.sourceId, source.id);
    const frame = await service.capture(camera);
    assert.ok(service.frames.has(frame.id));
    await assert.rejects(
      service.setFormat(source.id, "Hp30"),
      /Stop monitoring/,
    );
    assert.throws(() => service.register(source), /Stop monitoring/);
    service.release(lease.leaseId);
    assert.equal(service.external.owns(source.id), true);
  } finally {
    service.close();
  }
});

test("recorder aliases persist and pairing secrets are restricted to the operator UI", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "shader-recorder-node-"),
  );
  const engine = new Engine(directory);
  try {
    await engine.init();
    engine.capture.register({
      id: "input1",
      name: "DeckLink (1)",
      kind: "decklink",
      device: "pid:12:sub:0",
    });
    const registry = commands(engine);
    await registry.recorder_input_update.run(
      {
        sourceId: "input1",
        name: "Choir wide",
        mode: "1080p30",
        audioChannels: 16,
      },
      "ui",
    );
    assert.equal(engine.capture.sources.get("input1")?.alias, "Choir wide");
    assert.throws(
      () => registry.recorder_pairing_key.run({}, "mcp"),
      /Recorder Studio/,
    );
    engine.recorder.cached.active = { id: "take" };
    await assert.rejects(
      Promise.resolve().then(() =>
        registry.recorder_input_update.run(
          { sourceId: "input1", name: "Changed" },
          "ui",
        ),
      ),
      /Stop recording/,
    );
    assert.match(
      updateInstallBlocker({
        cameras: [],
        presetJobs: [],
        recorder: { active: { id: "take" } },
      })!,
      /finalize/,
    );
    engine.recorder.cached.active = null;
    const restored = new Engine(directory);
    await restored.init();
    assert.equal(restored.capture.sources.get("input1")?.alias, "Choir wide");
    await restored.close();
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
