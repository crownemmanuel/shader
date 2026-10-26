import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path, { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
export const sonyBridgePath = () =>
  process.env.SHADER_SONY_BRIDGE ||
  [
    path.resolve("native/sony/build/shader-sony"),
    path.resolve(
      path.dirname(process.execPath),
      "../Resources/sony/shader-sony",
    ),
  ].find((p) => existsSync(p));
import { z } from "zod";
import type { Adapter, Camera, Connection, Control, Value } from "../types.js";
/** Process boundary: Sony's separately licensed SDK stays out of the webview and npm bundle. */
export class SonyBridge {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(private executable = sonyBridgePath()) {}
  private start() {
    if (this.child) return;
    if (!this.executable || !isAbsolute(this.executable))
      throw new Error(
        "Sony Camera Remote SDK bridge is not installed. Set SHADER_SONY_BRIDGE to the absolute path of the licensed SDK bridge; see native/sony/README.md.",
      );
    const child = (this.child = spawn(this.executable, [], {
      stdio: "pipe",
      shell: false,
      cwd: path.dirname(this.executable),
    }));
    child.stderr.on("data", () => {}); // Vendor logs can include pairing information; never forward to agents.
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        if (line.length > 8 * 1024 * 1024)
          throw new Error("Oversized Sony reply");
        const reply = JSON.parse(line),
          p = this.pending.get(reply.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(reply.id);
        reply.error
          ? p.reject(new Error(String(reply.error.message || "Sony SDK error")))
          : p.resolve(reply.result);
      } catch {
        this.fail(new Error("Invalid Sony bridge response"));
        child.kill();
      }
    });
    child.on("error", () =>
      this.fail(new Error("Sony bridge could not start")),
    );
    child.on("exit", () => {
      this.child = undefined;
      this.fail(new Error("Sony bridge exited"));
    });
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
  call(method: string, params: unknown = {}): Promise<any> {
    this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Sony SDK request timed out; outcome unknown"));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        },
      );
    });
  }
  async close() {
    const child = this.child;
    if (child) {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.fail(new Error("Sony bridge closed"));
  }
}
const propertySchema = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string(),
  type: z.enum([
    "number",
    "enum",
    "boolean",
    "vector",
    "string",
    "action",
    "json",
  ]),
  value: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  components: z.array(z.string()).optional(),
  options: z
    .array(
      z.object({ label: z.string(), value: z.union([z.string(), z.number()]) }),
    )
    .optional(),
  writable: z.boolean(),
  readable: z.boolean(),
  note: z.string().optional(),
  native: z.record(z.string(), z.unknown()).optional(),
});
export class SonyAdapter implements Adapter {
  constructor(public bridge = new SonyBridge()) {}
  async connect(i: Connection): Promise<Camera[]> {
    const result = await this.bridge.call("connect", {
      address: i.host,
      transport: "network",
      username: i.username,
      password: i.password,
      fingerprint: i.fingerprint,
    });
    if (typeof result?.id !== "string")
      throw new Error("Sony bridge did not return a camera ID");
    const c: Camera = {
      id: `sony-${result.id}`,
      name: i.name || result.model || "Sony camera",
      vendor: "sony",
      model: result.model || "Sony Camera Remote SDK",
      address: i.host,
      status: "connected",
      revision: 0,
      tally: "unknown",
      controls: [],
    };
    c.controls = await this.refresh(c);
    return [c];
  }
  async refresh(c: Camera): Promise<Control[]> {
    const result = await this.bridge.call("properties", {
      cameraId: c.id.slice(5),
    });
    return z
      .array(propertySchema)
      .max(10000)
      .parse(result)
      .map((x) => ({
        ...x,
        value: x.value as Value,
        freshness: x.readable && x.value !== undefined ? "reported" : "unknown",
        updatedAt: new Date().toISOString(),
      }));
  }
  async set(c: Camera, p: Control, value: Value) {
    const result = await this.bridge.call(
      p.type === "action" ? "command" : "set",
      { cameraId: c.id.slice(5), propertyId: p.id, value },
    );
    return { verified: result?.verified === true, value: result?.value };
  }
  async close() {
    await this.bridge.close();
  }
}
