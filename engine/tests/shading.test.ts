import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Engine } from "../engine.js";
import { DemoAdapter } from "../adapters/demo.js";
import { axes, encodeAxis, shadePlan, defaultPolicy } from "../shading.js";
import { commands, execute } from "../commands.js";
import type { Camera, Control } from "../types.js";
const intent = { brightness: 0, warmth: 0, tint: 0 };
const value = (c: Camera, id: string) =>
  c.controls.find((c) => c.id === id)!.value;
async function demo() {
  return (await new DemoAdapter().connect())[0];
}
const target = (p: ReturnType<typeof shadePlan>, id: string) =>
  p.changes.find((c) => c.controlId === id)?.value as number;
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-shading-"));
  const e = new Engine(dir);
  await e.init();
  await e.connect({ vendor: "demo", host: "local" });
  return {
    e,
    dir,
    close: async () => {
      await e.close();
      await rm(dir, { force: true, recursive: true });
    },
  };
}

test("brightness opens iris first, then bounded gain; darkening reverses order and never alters shutter", async () => {
  const c = await demo();
  const small = shadePlan(c, { ...intent, brightness: 0.5 }, defaultPolicy);
  assert.ok(target(small, "iris") < 2.8);
  assert.equal(target(small, "gain_db"), 0);
  const large = shadePlan(c, { ...intent, brightness: 4 }, defaultPolicy);
  assert.equal(target(large, "iris"), 2);
  assert.equal(target(large, "gain_db"), 12);
  assert.ok(large.remainingEV > 1);
  assert.ok(!large.changes.some((c) => c.controlId === "shutter_speed"));
  c.controls.find((c) => c.id === "gain_db")!.value = 12;
  const dark = shadePlan(c, { ...intent, brightness: -1 }, defaultPolicy);
  assert.equal(target(dark, "iris"), 2.8);
  assert.equal(target(dark, "gain_db"), 6);
  const preserved = shadePlan(
    c,
    { ...intent, brightness: 1 },
    { ...defaultPolicy, preserveAperture: true },
  );
  assert.ok(!preserved.changes.some((c) => c.controlId === "iris"));
});

test("same UI/MCP recipe returns to exact anchor; manual writes invalidate it and revisions reject racing writes", async () => {
  const f = await fixture();
  try {
    const c = f.e.camera("demo-studio"),
      registry = commands(f.e),
      anchor = f.e.beginShade(c.id),
      original = structuredClone(c.controls);
    await execute(
      registry,
      "shade_apply",
      {
        cameraId: c.id,
        sessionId: anchor.sessionId,
        intent: { brightness: 2, warmth: 0.5, tint: 0.4 },
        expectedRevision: c.revision,
      },
      "mcp",
    );
    assert.ok(Number(value(c, "white_balance")) > 5600);
    assert.ok(Number(value(c, "tint")) > 0);
    const stale = c.revision - 1;
    await assert.rejects(
      execute(
        registry,
        "shade_apply",
        {
          cameraId: c.id,
          sessionId: anchor.sessionId,
          intent,
          expectedRevision: stale,
        },
        "ui",
      ),
      /state changed/,
    );
    await f.e.applyShade(c.id, anchor.sessionId, intent, c.revision, "ui");
    for (const p of original) assert.deepEqual(value(c, p.id), p.value);
    await f.e.set(c.id, "gain_db", 3, c.revision, "mcp");
    assert.throws(
      () => f.e.planShade(c.id, anchor.sessionId, intent),
      /starting point/,
    );
  } finally {
    await f.close();
  }
});

test("partial batch failure reports completed controls, invalidates anchor, and does not roll back a live write", async () => {
  const f = await fixture();
  try {
    const c = f.e.camera("demo-studio"),
      anchor = f.e.beginShade(c.id),
      adapter = f.e.adapters.get(c.id)!;
    adapter.set = async (_c, p, v) => {
      if (p.id === "gain_db") throw new Error("Camera rejected gain");
      return { verified: true, value: v };
    };
    await assert.rejects(
      f.e.applyShade(
        c.id,
        anchor.sessionId,
        { ...intent, brightness: 2 },
        c.revision,
        "ui",
      ),
      /Completed: Iris.*rejected gain/,
    );
    assert.equal(value(c, "iris"), 2);
    assert.equal(value(c, "gain_db"), 0);
    assert.throws(
      () => f.e.planShade(c.id, anchor.sessionId, intent),
      /starting point/,
    );
  } finally {
    await f.close();
  }
});

test("ATEM aperture AV is converted correctly; white balance and tint edits preserve both vector components", async () => {
  const c = await demo();
  c.vendor = "atem";
  c.controls = [
    {
      id: "0.2",
      label: "Aperture",
      group: "Lens",
      type: "number",
      value: 4,
      min: -16,
      max: 16,
      step: 1 / 2048,
      writable: true,
      readable: true,
      freshness: "reported",
    },
    {
      id: "1.2",
      label: "White balance",
      group: "Exposure",
      type: "vector",
      value: [5600, 8],
      min: -32768,
      max: 32767,
      step: 1,
      components: ["Kelvin", "Tint"],
      writable: true,
      readable: true,
      freshness: "reported",
    },
  ];
  assert.equal(axes(c).find((a) => a.kind === "iris")?.value, 4);
  const p = shadePlan(
    c,
    { brightness: 1, warmth: 0.5, tint: 0.4 },
    defaultPolicy,
  );
  assert.ok(Math.abs(target(p, "0.2") - 3) < 0.04);
  assert.deepEqual(
    p.changes.find((c) => c.controlId === "1.2")?.value,
    [6600, 18],
  );
  const neutral = shadePlan(c, intent, defaultPolicy);
  assert.deepEqual(
    neutral.changes.find((c) => c.controlId === "1.2")?.value,
    [5600, 8],
  );
});

test("Sony packed modes are excluded; reported aperture choices respect policy floors and GM polarity", async () => {
  const c = await demo();
  c.vendor = "sony";
  const number = (
    id: string,
    label: string,
    value: number,
    extra: Partial<Control> = {},
  ): Control => ({
    id,
    label,
    value,
    type: "number",
    group: "Exposure",
    writable: true,
    readable: true,
    freshness: "reported",
    ...extra,
  });
  c.controls = [
    number("dp:256", "FNumber", 280, {
      type: "enum",
      options: [180, 280, 400, 65533].map((value) => ({
        label: String(value),
        value,
      })),
    }),
    number("dp:260", "Iso Sensitivity", 0xffffff),
    number("dp:other", "Color Tuning GM", 192, { min: 156, max: 228, step: 1 }),
  ];
  assert.ok(!axes(c).some((a) => a.kind === "iso"));
  const p = shadePlan(c, { ...intent, brightness: 4, tint: 1 }, defaultPolicy);
  assert.equal(target(p, "dp:256"), 280); // f/1.8 is below the approved f/2 floor.
  assert.equal(target(p, "dp:other"), 174); // Less native GM means more magenta.
  const gm = axes(c).find((a) => a.kind === "tint")!;
  assert.equal(encodeAxis(gm, -4.5, c.controls[2]), 210);
});

test("camera mappings and brightness policy persist without copying secrets", async () => {
  const f = await fixture();
  try {
    f.e.capture.register({
      id: "decklink:1",
      name: "SDI 1",
      kind: "decklink",
      device: "DeckLink Quad 2 (1)",
    });
    await f.e.assign("demo-studio", "decklink:1");
    await f.e.route("demo-studio", { host: "172.16.10.10", input: 4, me: 1 });
    await f.e.policy("demo-studio", {
      ...defaultPolicy,
      preserveAperture: true,
    });
    const saved = JSON.parse(
      await readFile(path.join(f.dir, "settings.json"), "utf8"),
    );
    assert.equal(saved.routes["demo-studio"].me, 1);
    const other = new Engine(f.dir);
    try {
      await other.init();
      await other.connect({ vendor: "demo", host: "local" });
      assert.equal(other.camera("demo-studio").sourceId, "decklink:1");
      assert.equal(other.camera("demo-studio").tally, "unknown");
      assert.equal(other.policies["demo-studio"].preserveAperture, true);
    } finally {
      await other.close();
    }
    await f.e.assign("demo-studio", null);
    assert.equal(f.e.camera("demo-studio").sourceId, undefined);
  } finally {
    await f.close();
  }
});

test("PTZOptics warmth converts the reported index only in color-temperature mode", async () => {
  const c = await demo();
  c.vendor = "ptzoptics";
  c.controls = [
    {
      id: "color_temperature",
      label: "Color temperature index",
      group: "Exposure",
      type: "number",
      value: 31,
      min: 0,
      max: 55,
      step: 1,
      native: { code: 0x20, style: "two" },
      writable: true,
      readable: true,
      freshness: "reported",
    },
    {
      id: "white_balance_mode",
      label: "WB mode",
      group: "Exposure",
      type: "enum",
      value: 0,
      writable: true,
      readable: true,
      freshness: "reported",
    },
  ];
  assert.equal(axes(c)[0].value, 5600);
  assert.equal(shadePlan(c, intent, defaultPolicy).supported.warmth, false);
  c.controls[1].value = 32;
  const plan = shadePlan(c, { ...intent, warmth: 0.5 }, defaultPolicy);
  assert.equal(target(plan, "color_temperature"), 41);
});

test("multi-control recipe stops when external state changes the next target during a write", async () => {
  const f = await fixture();
  try {
    const c = f.e.camera("demo-studio"),
      anchor = f.e.beginShade(c.id),
      adapter = f.e.adapters.get(c.id)!;
    adapter.set = async (cam, p, v) => {
      if (p.id === "iris")
        cam.controls.find((p) => p.id === "gain_db")!.value = 8;
      return { verified: true, value: v };
    };
    await assert.rejects(
      f.e.applyShade(
        c.id,
        anchor.sessionId,
        { ...intent, brightness: 2 },
        c.revision,
        "ui",
      ),
      /changed during/,
    );
    assert.equal(value(c, "gain_db"), 8);
  } finally {
    await f.close();
  }
});
