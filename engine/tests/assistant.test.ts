import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Engine } from "../engine.js";
import { commands, execute } from "../commands.js";
test("assistant receives selected camera context and blocks tools or camera IDs outside its scope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shader-assistant-"));
  const engine = new Engine(dir);
  await engine.init();
  await engine.connect({ vendor: "demo", host: "local" });
  let calls = 0;
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const data = JSON.parse(body);
    requests.push(data);
    res.setHeader("content-type", "application/json");
    const tool = (id: string, name: string, args: unknown) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    res.end(
      JSON.stringify({
        choices: [
          {
            message:
              calls++ === 0
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      tool("a", "camera_get", { cameraId: "other-camera" }),
                      tool("b", "camera_arm", { cameraId: "demo-studio" }),
                      tool("c", "camera_get", { cameraId: "demo-studio" }),
                    ],
                  }
                : { role: "assistant", content: "Read the selected camera." },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    engine.assistant.configure({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "test-fixture",
      vision: false,
    });
    const result: any = await execute(
      commands(engine),
      "assistant_chat",
      { cameraId: "demo-studio", message: "Read available controls." },
      "ui",
    );
    assert.deepEqual(
      result.trace.map((t: any) => t.ok),
      [false, false, true],
    );
    assert.match(requests[0].messages[0].content, /demo-studio/);
    assert.equal(engine.arms.size, 0);
    assert.equal(
      requests[1].messages.filter((m: any) => m.role === "tool").length,
      3,
    );
    assert.equal(engine.camera("demo-studio").revision, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
