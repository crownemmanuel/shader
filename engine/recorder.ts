import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

type Descriptor = { url: string; token: string; pid: number };
export function recorderBinary() {
  const name =
    process.platform === "win32" ? "shader-recorder.exe" : "shader-recorder";
  return [
    process.env.SHADER_RECORDER,
    path.resolve("native/recorder/target/release", name),
    path.resolve("native/recorder/target/debug", name),
  ].find((p): p is string => !!p && path.isAbsolute(p) && existsSync(p));
}

/** Detached capture service: closing a view or losing the Node process never kills a take. */
export class RecorderClient {
  private descriptor?: Descriptor;
  private starting?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private polling = false;
  cached: any = { available: false, active: null, inputs: [] };
  reserved = new Set<string>();
  constructor(
    readonly directory: string,
    private changed: () => void = () => {},
  ) {}
  owns(id: string) {
    return (
      this.reserved.has(id) ||
      this.cached.inputs?.some((i: any) => i.source.id === id)
    );
  }
  async init() {
    try {
      await this.attach();
      this.watch();
    } catch {
      /* Start only when Studio is opened. */
    }
  }
  private async attach() {
    const d = JSON.parse(
      await readFile(path.join(this.directory, "service.json"), "utf8"),
    ) as Descriptor;
    const url = new URL(d.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !/^[a-f0-9]{64}$/.test(d.token)
    )
      throw Error("Invalid recorder session");
    this.descriptor = d;
    try {
      this.cached = await this.request("status", {}, 2000);
    } catch (e) {
      this.descriptor = undefined;
      throw e;
    }
  }
  private watch() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        this.cached = await this.request("status", {}, 3000);
        this.changed();
      } catch {
        this.cached = {
          ...this.cached,
          available: false,
          error:
            "Recorder connection lost. Recording workers may still be running; reopen Studio to reconnect.",
        };
      } finally {
        this.polling = false;
      }
    }, 2000).unref();
  }
  async ensure() {
    if (this.descriptor && this.cached.available) return;
    if (!this.starting)
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    await this.starting;
  }
  private async start() {
    try {
      await this.attach();
      this.watch();
      return;
    } catch {
      /* No healthy service. */
    }
    const binary = recorderBinary();
    if (!binary)
      throw Error(
        "Recorder runtime is not installed. Build the recorder with npm run build:recorder, or install a build that includes Recorder Studio.",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const log = await open(
      path.join(this.directory, "service.log"),
      "a",
      0o600,
    );
    const runtime = path.join(path.dirname(binary), "runtime");
    const env = { ...process.env };
    if (existsSync(runtime)) {
      const pathKey = Object.keys(env).find(
        (key) => key.toUpperCase() === "PATH",
      );
      const inheritedPath = pathKey ? env[pathKey] : "";
      for (const key of Object.keys(env))
        if (key.toUpperCase() === "PATH") delete env[key];
      env.PATH =
        path.join(runtime, "bin") + path.delimiter + (inheritedPath || "");
      env.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(runtime, "lib/gstreamer-1.0");
      env.GST_PLUGIN_PATH_1_0 = "";
      const scanner = path.join(
        runtime,
        "libexec/gstreamer-1.0/gst-plugin-scanner" +
          (process.platform === "win32" ? ".exe" : ""),
      );
      if (existsSync(scanner)) env.GST_PLUGIN_SCANNER = scanner;
    }
    const child = spawn(binary, ["--data-dir", this.directory], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env,
    });
    let failure: Error | undefined;
    child.on("error", (e) => {
      failure = e;
    });
    child.unref();
    await log.close();
    for (let i = 0; i < 100; i++) {
      try {
        await this.attach();
        this.watch();
        return;
      } catch {
        /* Startup/plugin discovery. */
      }
      if (failure || child.exitCode !== null)
        throw Error(
          "Recorder could not start. Check the installed GStreamer runtime and recorder service log.",
        );
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error(
      "Recorder startup timed out. Check the recorder service log before retrying.",
    );
  }
  private async request(
    name: string,
    args: unknown,
    timeout = 90000,
  ): Promise<any> {
    if (!this.descriptor) throw Error("Recorder is not connected");
    const response = await fetch(this.descriptor.url + "/rpc", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.descriptor.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(timeout),
    });
    const value = (await response.json()) as any;
    if (!response.ok) throw Error(value.error || "Recorder command failed");
    return value;
  }
  async call(name: string, args: unknown = {}) {
    await this.ensure();
    const value = await this.request(name, args);
    if (!["preview", "storage", "pairing_key"].includes(name)) {
      this.cached =
        name === "status" ? value : await this.request("status", {});
      this.changed();
    }
    return value;
  }
  async close() {
    if (this.descriptor) {
      // A missing response is not evidence that the recording stopped.
      await this.request("shutdown", {});
      this.descriptor = undefined;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
