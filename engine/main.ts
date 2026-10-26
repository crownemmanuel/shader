import { Engine, dataDirectory } from "./engine.js";
import { startServer, readSession } from "./server.js";
import { startMcp } from "./mcp.js";
import { mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
async function existing() {
  try {
    const s = await readSession();
    const r = await fetch(s.url + "/health", {
      headers: { Authorization: `Bearer ${s.token}` },
      signal: AbortSignal.timeout(700),
    });
    if (r.ok) {
      process.stdout.write(
        JSON.stringify({ ready: true, reused: true, url: s.url }) + "\n",
      );
      return true;
    }
  } catch {}
  return false;
}
async function main() {
  if (process.argv.includes("--mcp")) {
    await startMcp();
    return;
  }
  if (await existing()) return;
  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(dataDirectory(), {
      stale: 10000,
      update: 2000,
      retries: 0,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ELOCKED") throw e;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await existing()) return;
    }
    throw new Error(
      "Another camera engine is starting or the previous lock has not expired. Retry shortly.",
    );
  }
  const engine = new Engine();
  await engine.init();
  let close = async () => {};
  const running = await startServer(engine, () => void close());
  process.stdout.write(
    JSON.stringify({ ready: true, url: running.session.url }) + "\n",
  );
  if (!process.argv.includes("--no-discovery"))
    void engine.autoDiscover().catch(() => {});
  let exiting = false;
  close = async () => {
    if (exiting) return;
    exiting = true;
    await running.close();
    await release();
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
}
void main().catch((e) => {
  process.stderr.write(`Shader engine: ${e.message}\n`);
  process.exitCode = 1;
});
