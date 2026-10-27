import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { Engine, dataDirectory } from "./engine.js";
import { commands, execute } from "./commands.js";
export interface Session {
  url: string;
  token: string;
  pid: number;
}
export async function readSession(
  directory = dataDirectory(),
): Promise<Session> {
  const s = JSON.parse(
    await readFile(path.join(directory, "session.json"), "utf8"),
  );
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(s.url) ||
    typeof s.token !== "string" ||
    s.token.length !== 64
  )
    throw new Error("Invalid engine session descriptor");
  return s;
}
export async function callEngine(
  name: string,
  args: unknown,
  actor = "mcp",
  directory?: string,
) {
  const s = await readSession(directory);
  const response = await fetch(s.url + "/rpc", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${s.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args, actor }),
    signal: AbortSignal.timeout(name === "assistant_chat" ? 300000 : 90000),
  });
  const result: any = await response.json();
  if (!response.ok || result.error)
    throw new Error(result.error || `Engine HTTP ${response.status}`);
  return result.result;
}
export async function startServer(engine: Engine, onShutdown?: () => void) {
  const registry = commands(engine),
    token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const auth = req.headers.authorization || "",
      expected = `Bearer ${token}`;
    if (req.headers.origin) {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: "Browser origins are not accepted; use the desktop IPC bridge",
        }),
      );
      return;
    }
    if (
      Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown" && onShutdown) {
      try {
        await engine.close();
      } catch (e) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
      setImmediate(onShutdown);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "Request too large" }));
          return;
        }
      }
      const request = JSON.parse(body);
      if (typeof request.name !== "string")
        throw new Error("Command name required");
      const actor = ["ui", "mcp", "cli"].includes(request.actor)
        ? request.actor
        : "api";
      const result = await execute(registry, request.name, request.args, actor);
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  const session = {
    url: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
  };
  const file = path.join(engine.directory, "session.json");
  await writeFile(file, JSON.stringify(session), { mode: 0o600 });
  return {
    server,
    session,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await engine.close();
      try {
        const current = await readSession(engine.directory);
        if (current.token === token) await unlink(file);
      } catch {}
    },
  };
}
