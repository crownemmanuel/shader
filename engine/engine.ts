import {
  defaultPolicy,
  shadePlan,
  type ExposurePolicy,
  type ShadeIntent,
} from "./shading.js";
import { routedTally, type TallyRoute } from "./routing.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  Adapter,
  Audit,
  Camera,
  Connection,
  Control,
  Value,
} from "./types.js";
import { validateValue } from "./types.js";
import { DemoAdapter } from "./adapters/demo.js";
import { AtemAdapter } from "./adapters/atem.js";
import { PtzOpticsAdapter } from "./adapters/ptzoptics.js";
import { BlackmagicRestAdapter, PtzHttpAdapter } from "./adapters/http.js";
import { SonyAdapter, SonyBridge, sonyBridgePath } from "./adapters/sony.js";
import { CaptureService } from "./capture.js";
import { DiscoveryService } from "./discovery.js";
import { AssistantService } from "./providers.js";
import {
  PresetService,
  sameValue,
  type PresetFrame,
  type RecallJob,
} from "./presets.js";
import { LookLink } from "./look-link.js";
export const dataDirectory = () =>
  process.env.SHADER_DATA_DIR || path.join(os.homedir(), ".shader");
export const DRIVE_DEADMAN_MS = 600;
export class Engine extends EventEmitter {
  cameras = new Map<string, Camera>();
  adapters = new Map<string, Adapter>();
  audit: Audit[] = [];
  discovery = new DiscoveryService((candidate) => {
    if (
      candidate.vendor !== "unknown" &&
      !this.seenAdvertisements.has(candidate.id)
    ) {
      this.seenAdvertisements.add(candidate.id);
      void this.connect(
        {
          vendor: candidate.vendor,
          host: candidate.address,
          port: candidate.port,
          name: candidate.name,
        },
        "discovery",
      ).catch(() => {});
    }
  });
  private seenAdvertisements = new Set<string>();
  capture = new CaptureService();
  assistant = new AssistantService();
  presets = new PresetService(this);
  lighting = new LookLink(this);
  // Cameras are writable unless the operator locks them; locks persist.
  locks = new Set<string>();
  // Hidden cameras stay connected (tally, presets, agents) but are left off the camera buttons.
  hidden = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  // Joystick and zoom are dead-man drives keyed "move:<id>" / "zoom:<id>":
  // each stops unless refreshed.
  private drives = new Map<string, { speeds: string; timer: NodeJS.Timeout }>();
  private connecting = new Set<string>();
  private saved: Connection[] = [];
  private saveQueue = Promise.resolve();
  switchers = new Map<string, AtemAdapter>();
  routes: Record<string, TallyRoute> = {};
  policies: Record<string, ExposurePolicy> = {};
  private shades = new Map<
    string,
    { id: string; baseline: Camera; expected: Camera; policy: ExposurePolicy }
  >();
  private mappings: Record<string, string> = {};
  /** Increments on every "change" event; live UIs wait on it instead of polling. */
  changeVersion = 0;
  constructor(public directory = dataDirectory()) {
    super();
    this.setMaxListeners(100);
    this.on("change", () => this.changeVersion++);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const config = JSON.parse(
        await readFile(path.join(this.directory, "settings.json"), "utf8"),
      );
      this.saved = config.connections || [];
      this.mappings = config.mappings || {};
      this.routes = config.routes || {};
      this.policies = config.policies || {};
      this.locks = new Set(config.locks || []);
      this.hidden = new Set(config.hiddenCameras || []);
      if (config.provider) {
        const { configured, credentialStorage, ...provider } = config.provider;
        this.assistant.configure(provider);
      }
      for (const s of config.sources || []) this.capture.register(s);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.record(
          "system",
          "settings_load",
          "error",
          "Settings could not be loaded; using session defaults.",
        );
    }
    await this.presets.init();
    await this.lighting.init();
  }
  async save() {
    const data = JSON.stringify(
      {
        connections: this.saved,
        mappings: this.mappings,
        routes: this.routes,
        policies: this.policies,
        locks: [...this.locks],
        hiddenCameras: [...this.hidden],
        // Camera RTSP sources are re-derived on connect, never loaded from disk.
        sources: [...this.capture.sources.values()].filter(
          (s) => s.kind !== "rtsp",
        ),
        provider: this.assistant.settings(),
      },
      null,
      2,
    );
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.directory, "settings.json");
        await writeFile(file + ".tmp", data, { mode: 0o600 });
        await rename(file + ".tmp", file);
      });
    await this.saveQueue;
  }
  record(
    actor: string,
    operation: string,
    status: "ok" | "error",
    detail: string,
    cameraId?: string,
  ) {
    const entry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor,
      operation,
      status,
      detail,
      cameraId,
    };
    this.audit.unshift(entry);
    this.audit = this.audit.slice(0, 300);
    this.emit("change");
    return entry;
  }
  list() {
    this.updateTally();
    // Numeric id order keeps ATEM inputs as 1, 2 … 20 regardless of report order.
    return [...this.cameras.values()]
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
      .map((c) => ({
        ...structuredClone(c),
        locked: this.locks.has(c.id),
        hidden: this.hidden.has(c.id),
        writing: this.queues.has(c.id),
        shade: this.shades.has(c.id)
          ? {
              sessionId: this.shades.get(c.id)!.id,
              synced: this.inSync(c, this.shades.get(c.id)!.expected),
            }
          : undefined,
      }));
  }
  camera(id: string) {
    this.updateTally();
    const c = this.cameras.get(id);
    if (!c)
      throw new Error("Camera not found. Discover or connect a camera first.");
    return c;
  }
  async connect(input: Connection, actor = "ui") {
    const key = `${input.vendor}:${input.host}:${input.port ?? 0}:${input.profile ?? ""}`;
    if (this.connecting.has(key))
      throw new Error("This camera connection is already in progress");
    if (
      [...this.cameras.values()].some(
        (c) =>
          c.address === input.host &&
          c.vendor === input.vendor &&
          c.status !== "disconnected" &&
          c.status !== "error",
      )
    )
      throw new Error("This device is already connected");
    if (input.vendor === "atem" && this.switchers.has(input.host)) {
      if (this.switchers.get(input.host)!.info().connected)
        throw new Error("This switcher is already connected");
      await this.switchers.get(input.host)!.close();
      this.switchers.delete(input.host);
    }
    this.connecting.add(key);
    for (const c of [...this.cameras.values()])
      if (c.address === input.host && c.vendor === input.vendor)
        await this.disconnect(c.id);
    let adapter: Adapter;
    if (input.vendor === "demo") adapter = new DemoAdapter();
    else if (input.vendor === "atem")
      adapter = new AtemAdapter(
        (c) => {
          if (this.switchers.get(c.address) === adapter) {
            const isNew = !this.cameras.has(c.id);
            c.sourceId = this.mappings[c.id] || undefined;
            this.cameras.set(c.id, c);
            this.adapters.set(c.id, adapter);
            if (isNew && !this.routes[c.id])
              this.routes[c.id] = {
                host: c.address,
                input: Number(c.id.split("-").at(-1)),
                me: 0,
              };
            this.updateTally();
            this.emit("change");
          }
        },
        () => {
          this.updateTally();
          this.emit("change");
        },
      );
    else if (input.vendor === "ptzoptics")
      adapter =
        input.profile === "http"
          ? new PtzHttpAdapter()
          : new PtzOpticsAdapter();
    else if (input.vendor === "blackmagic-rest")
      adapter = new BlackmagicRestAdapter();
    else adapter = new SonyAdapter();
    try {
      const cameras = await adapter.connect(input);
      if (adapter instanceof AtemAdapter)
        this.switchers.set(input.host, adapter);
      for (const c of cameras) {
        if (c.vendor === "ptzoptics") this.attachStream(c);
        c.sourceId = this.mappings[c.id] || undefined;
        if (input.vendor === "atem" && !this.routes[c.id])
          this.routes[c.id] = {
            host: input.host,
            input: Number(c.id.split("-").at(-1)),
            me: 0,
          };
        this.cameras.set(c.id, c);
        this.adapters.set(c.id, adapter);
      }
      this.updateTally();
      if (input.vendor !== "demo") {
        const { password, username, ...safe } = input;
        this.saved = this.saved.filter(
          (s) => !(s.vendor === safe.vendor && s.host === safe.host),
        );
        this.saved.push(safe);
        await this.save();
      }
      this.record(
        actor,
        "camera_connect",
        "ok",
        `${cameras.length} camera endpoint(s) connected`,
      );
      return cameras;
    } catch (e) {
      await adapter.close().catch(() => {});
      this.record(
        actor,
        "camera_connect",
        "error",
        String((e as Error).message),
      );
      throw e;
    } finally {
      this.connecting.delete(key);
    }
  }
  async autoDiscover() {
    const candidates = await this.discovery.scan();
    const errors: string[] = [];
    const targets = [
      ...this.saved,
      ...candidates
        .filter((c) => c.vendor !== "unknown")
        .map((c) => ({
          vendor: c.vendor as Connection["vendor"],
          host: c.address,
          port: c.port,
          name: c.name,
        })),
    ];
    const known = {
      vendor: "atem" as const,
      host: "172.16.10.10",
      name: "ATEM 2 M/E Production Studio 4K",
    };
    if (!targets.some((t) => t.host === known.host)) targets.push(known);
    await Promise.all(
      targets.slice(0, 16).map(async (t) => {
        if (
          [...this.cameras.values()].some(
            (c) =>
              c.address === t.host &&
              c.vendor === t.vendor &&
              c.status === "connected",
          )
        )
          return;
        try {
          await this.connect(t, "discovery");
        } catch (e) {
          errors.push(`${t.host}: ${(e as Error).message}`);
        }
      }),
    );
    if (sonyBridgePath()) {
      const bridge = new SonyBridge();
      try {
        const cameras = await bridge.call("discover");
        if (Array.isArray(cameras))
          for (const c of cameras.slice(0, 16))
            if (typeof c.address === "string") {
              this.discovery.add({
                id: c.address,
                address: c.address,
                name: c.model || "Sony camera",
                vendor: "sony",
                protocol: "Sony Camera Remote SDK",
                note: c.ssh
                  ? "SSH credentials and fingerprint required"
                  : "Enable PC Remote and complete camera pairing.",
              });
              if (
                !this.list().some(
                  (x) => x.vendor === "sony" && x.address === c.address,
                )
              )
                await this.connect(
                  { vendor: "sony", host: c.address, name: c.model },
                  "discovery",
                ).catch((e) => errors.push(`${c.address}: ${e.message}`));
            }
      } catch (e) {
        errors.push((e as Error).message);
      } finally {
        await bridge.close();
      }
    }
    return {
      candidates: this.discovery.list(),
      connected: this.list(),
      errors,
    };
  }
  async disconnect(id: string) {
    const adapter = this.adapters.get(id);
    for (const [key, a] of this.adapters)
      if (a === adapter) this.presets.cancelCamera(key, "Camera disconnected");
    await adapter?.close();
    if (adapter instanceof AtemAdapter) this.switchers.delete(adapter.host);
    for (const [key, a] of this.adapters)
      if (a === adapter) {
        this.forgetDrives(key);
        this.adapters.delete(key);
        this.cameras.delete(key);
        this.shades.delete(key);
        this.capture.releaseCamera(key);
      }
    this.emit("change");
    return { disconnected: true };
  }
  async lock(id: string, locked: boolean, actor: string) {
    this.camera(id);
    if (locked) {
      this.presets.cancelCamera(id, "Camera locked");
      if (this.drives.has(`move:${id}`) || this.drives.has(`zoom:${id}`))
        await this.stop(id).catch(() => {});
      this.locks.add(id);
    } else this.locks.delete(id);
    this.record(
      actor,
      locked ? "camera_lock" : "camera_unlock",
      "ok",
      locked ? "Camera locked against changes" : "Camera unlocked",
      id,
    );
    await this.save();
    return { locked };
  }
  /** Ids need not be connected yet: ATEM inputs can be hidden by number (atem-<host>-<input>). */
  async hide(ids: string[], hidden: boolean, actor: string) {
    for (const id of ids) {
      if (hidden) this.hidden.add(id);
      else this.hidden.delete(id);
    }
    this.record(
      actor,
      hidden ? "camera_hide" : "camera_show",
      "ok",
      `${hidden ? "Hid" : "Showed"} ${ids.length} camera${ids.length === 1 ? "" : "s"}`,
    );
    await this.save();
    return { hidden: [...this.hidden] };
  }
  guard(c: Camera) {
    if (c.vendor === "demo") return;
    if (c.status !== "connected") throw new Error("Camera is disconnected");
    if (this.locks.has(c.id))
      throw new Error("Camera is locked. Unlock it to make changes.");
  }
  async serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) || Promise.resolve(),
      next = prior.catch(() => {}).then(fn);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  async refresh(id: string) {
    return this.serialized(id, async () => {
      const c = this.camera(id);
      try {
        c.controls = await this.adapters.get(id)!.refresh(c);
        c.revision++;
        c.status = c.vendor === "demo" ? "demo" : "connected";
        delete c.error;
        return c;
      } catch (e) {
        c.error = (e as Error).message;
        c.status = "error";
        throw e;
      } finally {
        this.emit("change");
      }
    });
  }
  /**
   * Without expectedRevision the newest write wins, which is what live dragging needs.
   * Live writes skip the activity log; the operator's final value is logged.
   */
  async set(
    id: string,
    controlId: string,
    value: unknown,
    expectedRevision: number | undefined,
    actor: string,
    live = false,
  ) {
    this.presets.cancelCamera(id);
    return this.serialized(id, async () => {
      this.shades.delete(id);
      return this.setDirect(
        id,
        controlId,
        value,
        expectedRevision,
        actor,
        live,
      );
    });
  }
  private async setDirect(
    id: string,
    controlId: string,
    value: unknown,
    expectedRevision: number | undefined,
    actor: string,
    live = false,
  ) {
    const c = this.camera(id);
    try {
      this.guard(c);
      if (expectedRevision !== undefined && c.revision !== expectedRevision)
        throw new Error(
          "Camera state changed. Read the latest state and retry.",
        );
      const control = c.controls.find((p) => p.id === controlId);
      if (!control) throw new Error("Control is not available on this camera");
      const parsed = validateValue(control, value);
      const result = await this.adapters.get(id)!.set(c, control, parsed);
      control.value = result.value ?? parsed;
      control.freshness =
        c.vendor === "demo"
          ? "simulated"
          : result.verified
            ? "reported"
            : "requested";
      control.updatedAt = new Date().toISOString();
      if (c.vendor === "sony") {
        try {
          c.controls = await this.adapters.get(id)!.refresh(c);
        } catch {
          this.record(
            actor,
            "capability_refresh",
            "error",
            "Write was sent, but the updated Sony capability list could not be read. Read camera before another change.",
            id,
          );
        }
      }
      c.revision++;
      if (live) this.emit("change");
      else
        this.record(
          actor,
          "control_set",
          "ok",
          `${control.label}: ${result.verified ? "read back" : "sent; confirmation pending"}`,
          id,
        );
      return { camera: structuredClone(c), verified: result.verified };
    } catch (e) {
      this.record(actor, "control_set", "error", (e as Error).message, id);
      throw e;
    }
  }
  /** Lock every scene camera in stable order, then validate the complete frame before any write. */
  async presetFrame(frames: PresetFrame[], job: RecallJob) {
    const ids = frames.map((f) => f.cameraId).sort();
    const lock = async (index: number): Promise<Record<string, unknown>[]> =>
      index < ids.length
        ? this.serialized(ids[index], () => lock(index + 1))
        : apply();
    const apply = async () => {
      const checkCancelled = () => {
        if (job.status === "cancelled")
          throw new Error("Preset recall cancelled");
      };
      checkCancelled();
      for (const frame of frames) {
        const c = this.camera(frame.cameraId);
        this.guard(c);
        for (const change of frame.values) {
          const control = c.controls.find((p) => p.id === change.controlId);
          if (
            !control ||
            !sameValue(control.value, frame.expected[change.controlId])
          )
            throw new Error(`${c.name}: a saved control changed during recall`);
          validateValue(control, change.value);
        }
      }
      for (const frame of frames) {
        this.shades.delete(frame.cameraId);
        for (const change of frame.values) {
          checkCancelled();
          const c = this.camera(frame.cameraId),
            current = c.controls.find((p) => p.id === change.controlId);
          if (
            !current ||
            !sameValue(current.value, frame.expected[change.controlId])
          )
            throw new Error(`${c.name}: control changed during recall`);
          if (sameValue(current.value, change.value)) continue;
          const result = await this.setDirect(
            c.id,
            change.controlId,
            change.value,
            c.revision,
            job.actor,
          );
          job.completedWrites++;
          if (result.verified) job.verifiedWrites++;
        }
      }
      return frames.map((frame) =>
        Object.fromEntries(
          frame.values.map((change) => [
            change.controlId,
            structuredClone(
              this.camera(frame.cameraId).controls.find(
                (p) => p.id === change.controlId,
              )?.value,
            ),
          ]),
        ),
      );
    };
    return lock(0);
  }
  async move(
    id: string,
    pan: number,
    tilt: number,
    duration: number,
    actor: string,
  ) {
    return this.serialized(id, async () => {
      const c = this.camera(id);
      this.guard(c);
      const a = this.adapters.get(id);
      if (!(a instanceof PtzOpticsAdapter))
        throw new Error(
          "Bounded movement requires the PTZOptics VISCA connection",
        );
      await a.move(pan, tilt, duration);
      this.record(
        actor,
        "ptz_move",
        "ok",
        "Movement pulse completed and stop acknowledged",
        id,
      );
      return { stopped: true };
    });
  }
  /** Stops pan/tilt and zoom. Always allowed, even on a locked camera. */
  async stop(id: string) {
    this.forgetDrives(id);
    const a = this.adapters.get(id);
    if (!(a instanceof PtzOpticsAdapter)) throw new Error("Not a VISCA camera");
    await a.stop();
    await a.zoom(0);
    return { stopped: true };
  }
  private forgetDrives(id: string) {
    for (const key of [`move:${id}`, `zoom:${id}`]) {
      clearTimeout(this.drives.get(key)?.timer);
      this.drives.delete(key);
    }
  }
  /** Starts or updates joystick movement; it stops unless repeated within DRIVE_DEADMAN_MS. */
  drive(id: string, pan: number, tilt: number, actor: string) {
    return this.hold("move", id, [pan, tilt], actor);
  }
  /** Starts or updates zoom (negative wide, positive tele); same dead-man rule as drive. */
  zoom(id: string, speed: number, actor: string) {
    return this.hold("zoom", id, [speed], actor);
  }
  private async hold(
    axis: "move" | "zoom",
    id: string,
    speeds: number[],
    actor: string,
  ) {
    const c = this.camera(id),
      a = this.adapters.get(id),
      key = `${axis}:${id}`,
      prior = this.drives.get(key),
      operation = axis === "move" ? "ptz_drive" : "ptz_zoom",
      what = axis === "move" ? "Joystick" : "Zoom";
    if (!(a instanceof PtzOpticsAdapter))
      throw new Error(
        `${what} control requires the PTZOptics VISCA connection`,
      );
    const halt = () => (axis === "move" ? a.stop() : a.zoom(0));
    const release = async () => {
      clearTimeout(this.drives.get(key)?.timer);
      this.drives.delete(key);
      await halt();
    };
    if (speeds.every((n) => !n)) {
      await release();
      if (prior)
        this.record(
          actor,
          operation,
          "ok",
          `${what} released; stop acknowledged`,
          id,
        );
      return { stopped: true };
    }
    try {
      this.guard(c);
    } catch (e) {
      if (prior) await release().catch(() => {});
      throw e;
    }
    clearTimeout(prior?.timer);
    const timer = setTimeout(() => {
      if (this.drives.get(key)?.timer !== timer) return;
      this.drives.delete(key);
      halt().catch(() => {});
      this.record(actor, operation, "ok", `${what} signal lost; stop sent`, id);
    }, DRIVE_DEADMAN_MS);
    const signature = speeds.join(",");
    this.drives.set(key, { speeds: signature, timer });
    try {
      if (prior?.speeds !== signature)
        await (axis === "move"
          ? a.drive(speeds[0], speeds[1])
          : a.zoom(speeds[0]));
    } catch (e) {
      await release().catch(() => {});
      throw e;
    }
    if (!prior) this.record(actor, operation, "ok", `${what} started`, id);
    return { moving: true, timeoutMs: DRIVE_DEADMAN_MS };
  }
  /** Offers a PTZ camera's RTSP stream as an input, and uses it unless the operator chose otherwise. */
  private attachStream(c: Camera) {
    const id = `rtsp:${c.id}`;
    try {
      this.capture.addCameraStream(id, `${c.name} · network stream`, c.address);
    } catch {
      return;
    }
    if (!(c.id in this.mappings)) this.mappings[c.id] = id;
  }
  async assign(id: string, sourceId: string | null) {
    const c = this.camera(id);
    if (sourceId && !this.capture.sources.has(sourceId))
      throw new Error("Unknown capture source");
    if (c.sourceId !== (sourceId || undefined)) this.capture.releaseCamera(id);
    c.sourceId = sourceId || undefined;
    // An explicit "none" is kept so a camera's own stream is not re-attached.
    this.mappings[id] = sourceId || "";
    await this.save();
    return { cameraId: id, sourceId };
  }
  updateTally() {
    const switches = [...this.switchers.values()].map((s) => s.info());
    for (const c of this.cameras.values()) {
      c.tallyRoute = this.routes[c.id];
      if (c.vendor !== "demo" || c.tallyRoute)
        c.tally = routedTally(c.tallyRoute, switches);
    }
  }
  async route(id: string, route: TallyRoute | null) {
    this.camera(id);
    if (route) this.routes[id] = route;
    else delete this.routes[id];
    this.updateTally();
    await this.save();
    return this.camera(id);
  }
  async policy(id: string, policy: ExposurePolicy) {
    if (this.queues.has(id))
      throw new Error(
        "Wait for the current camera adjustment before changing limits.",
      );
    this.camera(id);
    if (policy.minF > policy.maxF || policy.minGain > policy.maxGain)
      throw new Error("Minimum must not exceed maximum");
    this.policies[id] = policy;
    this.shades.delete(id);
    await this.save();
    return policy;
  }
  /** Resolves on the next change after `after`, or with the current version on timeout. */
  waitForChange(after: number, timeoutMs: number) {
    return new Promise<{ version: number }>((resolve) => {
      if (this.changeVersion !== after)
        return resolve({ version: this.changeVersion });
      const done = () => {
        clearTimeout(timer);
        this.off("change", done);
        // Let a burst of switcher updates settle into one UI refresh.
        setTimeout(() => resolve({ version: this.changeVersion }), 30);
      };
      const timer = setTimeout(done, timeoutMs);
      this.on("change", done);
    });
  }
  // Switchers echo fixed-point values (1/2048 steps), so compare numbers with a small tolerance.
  private inSync(c: Camera, expected: Camera) {
    const close = (a: unknown, b: unknown): boolean =>
      typeof a === "number" && typeof b === "number"
        ? Math.abs(a - b) <= 1 / 1024
        : Array.isArray(a) && Array.isArray(b)
          ? a.length === b.length && a.every((v, i) => close(v, b[i]))
          : JSON.stringify(a) === JSON.stringify(b);
    return (
      c.controls.length === expected.controls.length &&
      c.controls.every((p) => {
        const e = expected.controls.find((x) => x.id === p.id);
        return !!e && e.writable === p.writable && close(p.value, e.value);
      })
    );
  }
  beginShade(id: string) {
    if (this.queues.has(id))
      throw new Error(
        "Wait for the current camera adjustment before setting a starting point.",
      );
    const c = this.camera(id),
      policy = this.policies[id] || defaultPolicy;
    const session = {
      id: randomUUID(),
      baseline: structuredClone(c),
      expected: structuredClone(c),
      policy: { ...policy },
    };
    this.shades.set(id, session);
    return {
      sessionId: session.id,
      revision: c.revision,
      ...shadePlan(c, { brightness: 0, warmth: 0, tint: 0 }, policy),
    };
  }
  planShade(id: string, sessionId: string, intent: ShadeIntent) {
    const c = this.camera(id),
      s = this.shades.get(id);
    if (!s || s.id !== sessionId || !this.inSync(c, s.expected))
      throw new Error(
        "Camera settings changed. Set a new starting point before using Simple controls.",
      );
    return shadePlan(s.baseline, intent, s.policy);
  }
  async applyShade(
    id: string,
    sessionId: string,
    intent: ShadeIntent,
    expectedRevision: number | undefined,
    actor: string,
    live = false,
  ) {
    this.presets.cancelCamera(id);
    return this.serialized(id, async () => {
      const c = this.camera(id);
      this.guard(c);
      if (expectedRevision !== undefined && c.revision !== expectedRevision)
        throw new Error(
          "Camera state changed. Read the latest state and retry.",
        );
      const plan = this.planShade(id, sessionId, intent),
        completed: string[] = [],
        initial = new Map(
          c.controls.map((p) => [p.id, JSON.stringify(p.value)]),
        );
      for (const key of ["brightness", "warmth", "tint"] as const)
        if (intent[key] !== 0 && !plan.supported[key])
          throw new Error(
            `This camera has no supported Simple ${key} control. Use Advanced.`,
          );
      try {
        for (const change of plan.changes) {
          const current = this.camera(id);
          if (
            JSON.stringify(
              current.controls.find((p) => p.id === change.controlId)?.value,
            ) !== initial.get(change.controlId)
          )
            throw new Error("A control changed during the adjustment.");
          if (
            JSON.stringify(
              current.controls.find((p) => p.id === change.controlId)?.value,
            ) === JSON.stringify(change.value)
          )
            continue;
          await this.setDirect(
            id,
            change.controlId,
            change.value,
            current.revision,
            actor,
            true,
          );
          completed.push(change.label);
        }
        this.shades.get(id)!.expected = structuredClone(this.camera(id));
        if (!live)
          this.record(
            actor,
            "shade_apply",
            "ok",
            `Applied ${completed.length} control changes; shutter held`,
            id,
          );
        else this.emit("change");
        return { ...plan, completed, camera: structuredClone(this.camera(id)) };
      } catch (e) {
        this.shades.delete(id);
        throw new Error(
          `Adjustment stopped. Completed: ${completed.join(", ") || "none"}. ${(e as Error).message} Read camera and set a new starting point; no automatic rollback.`,
        );
      }
    });
  }
  async close() {
    await Promise.allSettled(
      [
        ...new Set(
          [...this.drives.keys()].map((k) => k.split(":").slice(1).join(":")),
        ),
      ].map((id) => this.stop(id)),
    );
    await this.lighting.close();
    await this.presets.close();
    this.discovery.close();
    this.capture.close();
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled(
      [...new Set([...this.adapters.values(), ...this.switchers.values()])].map(
        (a) => a.close(),
      ),
    );
  }
}
