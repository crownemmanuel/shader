import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Engine } from "../engine.js";
import { startServer } from "../server.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("real MCP stdio client initializes, lists tools, queries and updates the same engine", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shader-mcp-")),
    engine = new Engine(directory);
  await engine.init();
  await engine.connect({ vendor: "demo", host: "local" });
  const running = await startServer(engine);
  const client = new Client({
    name: "shader-integration-test",
    version: "1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "engine/main.ts", "--mcp"],
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      SHADER_DATA_DIR: directory,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "control_set"));
    assert.ok(tools.tools.some((t) => t.name === "capture_frame"));
    for (const name of [
      "preset_save",
      "preset_recall",
      "lighting_state",
      "lighting_configure",
      "lighting_rule_save",
    ])
      assert.ok(tools.tools.some((t) => t.name === name));
    const saved: any = await client.callTool({
      name: "camera_preset_save",
      arguments: { cameraId: "demo-studio", name: "MCP saved look" },
    });
    assert.ok(!saved.isError);
    assert.equal(engine.presets.list()[0].name, "MCP saved look");
    const lighting: any = await client.callTool({
      name: "lighting_state",
      arguments: {},
    });
    assert.ok(!lighting.isError);
    assert.match(lighting.content[0].text, /untrusted/);
    const result: any = await client.callTool({
      name: "control_set",
      arguments: {
        cameraId: "demo-studio",
        controlId: "tint",
        value: 7,
        expectedRevision: 0,
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      engine.camera("demo-studio").controls.find((c) => c.id === "tint")?.value,
      7,
    );
    const resources = await client.readResource({ uri: "shader://cameras" });
    assert.match(
      String("text" in resources.contents[0] ? resources.contents[0].text : ""),
      /demo-studio/,
    );
    const rejected: any = await client.callTool({
      name: "control_set",
      arguments: {
        cameraId: "demo-studio",
        controlId: "tint",
        value: 9,
        expectedRevision: 0,
      },
    });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});
