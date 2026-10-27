import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeEnvironment } from "../runtime-env.mjs";

test("bundled runtime preserves Windows-style Path without duplicate environment keys", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recorder-env-"));
  try {
    mkdirSync(path.join(dir, "runtime"));
    const base = {
      Path: ["compiler", "node", "system"].join(path.delimiter),
      KEEP: "yes",
    };
    const env = runtimeEnvironment(path.join(dir, "shader-recorder"), base);
    assert.equal(
      env.PATH,
      [path.join(dir, "runtime/bin"), base.Path].join(path.delimiter),
    );
    assert.deepEqual(
      Object.keys(env).filter((k) => k.toUpperCase() === "PATH"),
      ["PATH"],
    );
    assert.equal(env.KEEP, "yes");
    assert.equal(
      base.Path,
      ["compiler", "node", "system"].join(path.delimiter),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
