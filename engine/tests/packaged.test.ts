import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const binary = path.resolve(
  `src-tauri/binaries/shader-engine-${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`,
);
test(
  "packaged engine boots without node_modules and serves its packaged MCP bridge",
  { skip: !existsSync(binary) },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "shader-sea-")),
      env = {
        ...(process.env as Record<string, string>),
        SHADER_DATA_DIR: directory,
      };
    const child = spawn(binary, ["--no-discovery"], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    const client = new Client({ name: "packaged-test", version: "1.0" });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Packaged engine did not start: " + stderr)),
          15000,
        );
        child.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(stderr));
        });
      });
      await client.connect(
        new StdioClientTransport({
          command: binary,
          args: ["--mcp"],
          cwd: directory,
          env,
          stderr: "pipe",
        }),
      );
      const catalogue = await client.listTools();
      for (const name of [
        "shade_apply",
        "preview_frame",
        "camera_route",
        "preset_save",
        "preset_recall",
        "lighting_state",
        "lighting_rule_save",
      ])
        assert.ok(catalogue.tools.some((t) => t.name === name));
      const result: any = await client.callTool({
        name: "camera_connect",
        arguments: { vendor: "demo", host: "local" },
      });
      assert.ok(!result.isError, JSON.stringify(result));
      const state: any = await client.callTool({
        name: "cameras_list",
        arguments: {},
      });
      assert.match(state.content[0].text, /demo-studio/);
      const anchor: any = await client.callTool({
        name: "shade_begin",
        arguments: { cameraId: "demo-studio" },
      });
      const session = JSON.parse(anchor.content[0].text);
      const applied: any = await client.callTool({
        name: "shade_apply",
        arguments: {
          cameraId: "demo-studio",
          sessionId: session.sessionId,
          intent: { brightness: 2, warmth: 0.25, tint: 0 },
          expectedRevision: 0,
        },
      });
      assert.ok(!applied.isError, JSON.stringify(applied));
      const changed = JSON.parse(applied.content[0].text);
      assert.equal(
        changed.camera.controls.find((c: any) => c.id === "shutter_speed")
          .value,
        60,
      );
      assert.equal(
        changed.camera.controls.find((c: any) => c.id === "iris").value,
        2,
      );
    } finally {
      await client.close();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
