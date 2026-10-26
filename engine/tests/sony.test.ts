import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { SonyBridge } from "../adapters/sony.js";
const binary = path.resolve("native/sony/build/shader-sony");
test(
  "native Sony bridge loads the licensed SDK and checks signed, 64-bit, enum and range conversions",
  { skip: !existsSync(binary) },
  async () => {
    const { stdout } = await promisify(execFile)(binary, ["--self-test"]);
    const data = JSON.parse(stdout);
    assert.equal(data.ok, true);
    assert.equal(data.sdkVersion, 0x02020000);
    assert.ok(data.propertyNames > 800);
    assert.ok(data.controlNames > 60);
  },
);
test(
  "native Sony discovery loads macOS adapter plugins and returns SDK candidates",
  { skip: !existsSync(binary) },
  async () => {
    const bridge = new SonyBridge(binary);
    try {
      const info = await bridge.call("info");
      assert.equal(info.sdkVersion, 0x02020000);
      const found = await bridge.call("discover");
      assert.ok(Array.isArray(found));
      for (const c of found) {
        assert.equal(typeof c.address, "string");
        assert.equal(typeof c.model, "string");
      }
      await assert.rejects(
        bridge.call("properties", { cameraId: "not-connected" }),
        /session not found/,
      );
    } finally {
      await bridge.close();
    }
  },
);
