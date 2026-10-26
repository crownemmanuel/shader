import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import type { Camera, CaptureSource, Frame } from "./types.js";
import { DeckLinkBridge, DeckLinkEvents } from "./decklink.js";
export function ffmpeg() {
  return (
    process.env.SHADER_FFMPEG ||
    ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync) ||
    "ffmpeg"
  );
}
export function runFfmpeg(
  args: string[],
  timeout = 10000,
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let size = 0;
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(
        new Error(
          "Capture timed out. Check the input signal, device permissions, and format.",
        ),
      );
    }, timeout);
    p.on("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          "FFmpeg is not installed. Configure SHADER_FFMPEG or install FFmpeg.",
        ),
      );
    });
    p.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 8 * 1024 * 1024) {
        p.kill("SIGKILL");
        reject(new Error("Frame exceeded capture size limit"));
      } else stdout.push(b);
    });
    p.stderr.on("data", (b: Buffer) => {
      if (stderr.reduce((a, x) => a + x.length, 0) < 65536) stderr.push(b);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString(),
        code,
      });
    });
  });
}
interface CaptureStream {
  process: ChildProcess;
  native: boolean;
  parser: JpegParser;
  sequence: number;
  latest?: { data: Buffer; at: string };
  error?: string;
  noSignal?: boolean;
  restarting?: boolean;
  stopping?: Promise<void>;
}

export function parseDeckLinkSources(output: string): CaptureSource[] {
  const sources: CaptureSource[] = [];
  for (const line of output.split("\n")) {
    // -sources uses an identifier [description]; older -list_devices uses quoted names.
    const modern = line.match(
      /^(?:\s{2}|\*\s)(.+?)\s+\[([^\]]+)\]\s*(?:\([^)]*\))?\s*$/,
    );
    const legacy = line.match(/^\s*(?:\[decklink[^\]]*\]\s*)?'([^']+)'\s*$/);
    const device = modern?.[1] || legacy?.[1];
    if (device && !sources.some((s) => s.device === device))
      sources.push({
        id: `decklink:${device}`,
        name: modern?.[2] || device,
        kind: "decklink",
        device,
      });
  }
  return sources;
}

function stopStream(stream: CaptureStream): Promise<void> {
  if (stream.stopping) return stream.stopping;
  const child = stream.process;
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return (stream.stopping = new Promise((resolve, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    const deadline = setTimeout(() => {
      child.removeListener("close", closed);
      reject(
        new Error(
          "Capture did not stop. Restart Shader before reopening this input.",
        ),
      );
    }, 5000).unref();
    function closed() {
      clearTimeout(force);
      clearTimeout(deadline);
      resolve();
    }
    child.once("close", closed);
    if (stream.native && child.stdin?.writable) child.stdin.end("stop\n");
    else child.kill("SIGTERM");
  }));
}
export class CaptureService {
  sources = new Map<string, CaptureSource>();
  frames = new Map<string, Frame>();
  private streams = new Map<string, CaptureStream>();
  constructor(
    private decklink = new DeckLinkBridge(),
    private probe = runFfmpeg,
  ) {}
  private leases = new Map<
    string,
    { cameraId: string; sourceId: string; until: number }
  >();
  private timer = setInterval(() => {
    for (const [id, l] of this.leases)
      if (l.until < Date.now()) this.release(id);
  }, 5000).unref();
  async list() {
    const diagnostics: string[] = [];
    const sources: CaptureSource[] = [];
    let nativeReady = false;
    // Native enumeration is independent of FFmpeg/DirectShow, which may be unavailable.
    for (const source of this.sources.values())
      if (source.backend === "decklink-sdk") source.available = false;
    if (this.decklink.available()) {
      try {
        const result = await this.decklink.list();
        sources.push(...result.sources);
        diagnostics.push(...result.diagnostics);
        nativeReady = true;
        if (!result.sources.length)
          diagnostics.push(
            "No active DeckLink capture inputs found. Check the card and connector profiles in Desktop Video Setup.",
          );
      } catch (e) {
        diagnostics.push((e as Error).message);
      }
    } else if (
      process.platform === "win32" ||
      process.env.SHADER_DECKLINK_BRIDGE
    ) {
      diagnostics.push(
        "Native DeckLink helper is missing. Reinstall the Windows app or run npm run build:decklink.",
      );
    }
    const format =
      process.platform === "darwin"
        ? "avfoundation"
        : process.platform === "win32"
          ? "dshow"
          : "v4l2";
    try {
      if (format === "v4l2") {
        for (const n of await readdir("/dev"))
          if (/^video\d+$/.test(n))
            sources.push({
              id: `v4l2:${n}`,
              name: n,
              kind: "v4l2",
              device: `/dev/${n}`,
            });
      } else {
        const r = await this.probe([
          "-hide_banner",
          "-f",
          format,
          "-list_devices",
          "true",
          "-i",
          format === "dshow" ? "dummy" : "",
        ]);
        let video = format === "dshow";
        for (const line of r.stderr.split("\n")) {
          if (line.includes("video devices")) video = true;
          if (line.includes("audio devices")) video = false;
          if (!video || /Capture screen/i.test(line)) continue;
          const match =
            format === "avfoundation"
              ? line.match(/\[(\d+)\] (.+)$/)
              : line.match(/"(.+)" \(video\)/);
          if (match)
            sources.push({
              id: `${format}:${match[1]}`,
              name: format === "avfoundation" ? match[2] : match[1],
              kind: format,
              device: match[1],
            });
        }
      }
    } catch (e) {
      diagnostics.push((e as Error).message);
    }
    if (!nativeReady) {
      try {
        const devices = await this.probe(["-hide_banner", "-devices"]);
        if (
          /^\s*D[E ]*\s+decklink\b/m.test(
            devices.stdout.toString() + devices.stderr,
          )
        ) {
          const result = await this.probe([
            "-hide_banner",
            "-sources",
            "decklink",
          ]);
          const found = parseDeckLinkSources(
            result.stdout.toString() + result.stderr,
          );
          sources.push(...found);
          if (!found.length)
            diagnostics.push(
              "FFmpeg supports DeckLink but returned no capture inputs. Check Desktop Video and the card's connector profiles.",
            );
        } else
          diagnostics.push(
            "This FFmpeg build has no DeckLink input. Windows uses Shader's native DeckLink helper; other platforms need a DeckLink-enabled FFmpeg build and Desktop Video.",
          );
      } catch (e) {
        diagnostics.push((e as Error).message);
      }
    }
    for (const source of sources) {
      const existing = [...this.sources.values()].find(
        (s) =>
          s.kind === source.kind &&
          (s.device === source.device ||
            (source.backend === "decklink-sdk" &&
              s.device === source.nativeName &&
              sources.filter(
                (candidate) => candidate.nativeName === source.nativeName,
              ).length === 1)),
      );
      const id = existing?.id || source.id;
      this.sources.set(id, {
        ...existing,
        ...source,
        id,
        ...(existing?.format ? { format: existing.format } : {}),
      });
    }
    return {
      sources: [...this.sources.values()],
      diagnostics: [...new Set(diagnostics)],
    };
  }
  register(source: CaptureSource) {
    if (source.kind === "rtsp")
      throw new Error("Network streams come only from connected cameras");
    if (
      !source.device ||
      source.device.length > 300 ||
      source.device.startsWith("-") ||
      /\r|\n/.test(source.device)
    )
      throw new Error("Invalid capture device");
    if (source.kind === "v4l2" && !/^\/dev\/video\d+$/.test(source.device))
      throw new Error("Expected /dev/videoN");
    if (this.streams.has(source.id))
      throw new Error("Stop preview before changing this input");
    const same = [...this.sources.values()].find(
      (s) =>
        s.id !== source.id &&
        s.kind === source.kind &&
        s.device === source.device,
    );
    if (same)
      throw new Error(
        `This physical input is already registered as ${same.name}`,
      );
    this.sources.set(source.id, source);
    return source;
  }
  /** Registers the RTSP stream of a connected camera; the URL is built from its address only. */
  addCameraStream(id: string, name: string, host: string) {
    if (!isHost(host)) throw new Error("Invalid camera address");
    const prior = this.sources.get(id);
    if (prior?.kind === "rtsp" && prior.device === host) return prior;
    if (this.streams.has(id))
      throw new Error("Stop preview before changing this input");
    const source: CaptureSource = { id, name, kind: "rtsp", device: host };
    this.sources.set(id, source);
    return source;
  }
  open(camera: Camera) {
    if (!camera.sourceId)
      throw new Error(
        "Assign a capture input to this camera in Settings first.",
      );
    const source = this.sources.get(camera.sourceId);
    if (!source) throw new Error("Mapped capture input no longer exists.");
    if (source.available === false)
      throw new Error(
        "This DeckLink input is unavailable. Find video inputs again and check Desktop Video Setup.",
      );
    if (!this.streams.has(source.id)) this.startStream(source);
    const leaseId = randomUUID();
    this.leases.set(leaseId, {
      cameraId: camera.id,
      sourceId: source.id,
      until: Date.now() + 15000,
    });
    return { leaseId, sourceId: source.id, cameraId: camera.id };
  }
  private startStream(source: CaptureSource, sequence = 0) {
    const native =
      source.kind === "decklink" &&
      (source.backend === "decklink-sdk" || this.decklink.available());
    const p = native
      ? this.decklink.start(source)
      : spawn(ffmpeg(), captureArgs(source), {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
    const stream: CaptureStream = {
      process: p,
      native,
      sequence,
      parser: new JpegParser(),
    };
    this.streams.set(source.id, stream);
    p.stdin?.on("error", () => {}); // A failed child may close its stop-command pipe first.
    p.stdout!.on("data", (b: Buffer) => {
      try {
        for (const data of stream.parser.push(b)) {
          if (stream.noSignal || stream.restarting) continue;
          stream.latest = { data, at: new Date().toISOString() };
          stream.sequence++;
        }
      } catch (e) {
        stream.error = (e as Error).message;
        p.kill("SIGKILL");
      }
    });
    const events = new DeckLinkEvents((event) => {
      if (event.error) stream.error = event.error;
      if (event.signal) {
        stream.noSignal = event.signal !== "live";
        if (stream.noSignal) {
          stream.latest = undefined;
          stream.parser = new JpegParser();
        }
      }
    });
    p.stderr!.on("data", (b: Buffer) => {
      if (native) events.push(b);
    });
    p.on("error", () => {
      stream.error = native
        ? "Native DeckLink helper could not start. Reinstall the Windows app."
        : "FFmpeg could not start. Install FFmpeg or configure SHADER_FFMPEG.";
    });
    p.on("close", () => {
      if (!stream.restarting)
        stream.error ||= native
          ? "DeckLink capture stopped. Check Desktop Video and retry preview."
          : "Capture stopped. Check signal, input format, and device permissions.";
    });
  }
  async setFormat(sourceId: string, format?: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.kind !== "decklink")
      throw new Error("Select a DeckLink input first.");
    if (format && !/^[a-zA-Z0-9]{3,4}$/.test(format))
      throw new Error("Invalid DeckLink format code.");
    if (
      format &&
      source.modes?.length &&
      !source.modes.some((m) => m.code === format)
    )
      throw new Error("This input does not support the selected format.");
    if (!format && source.supportsAutoDetection === false)
      throw new Error("This input requires a manual video format.");
    if (source.format === format) return source;
    const stream = this.streams.get(sourceId);
    if (stream?.restarting)
      throw new Error("The input is restarting. Try again in a moment.");
    if (stream) {
      stream.restarting = true;
      stream.latest = undefined;
      try {
        await stopStream(stream);
      } catch (e) {
        stream.error = (e as Error).message;
        stream.restarting = false;
        throw e;
      }
    }
    const updated = { ...(this.sources.get(sourceId) || source), format };
    this.sources.set(sourceId, updated);
    if (stream && this.streams.get(sourceId) === stream) {
      this.streams.delete(sourceId);
      if ([...this.leases.values()].some((l) => l.sourceId === sourceId))
        this.startStream(updated, stream.sequence + 1);
    }
    return updated;
  }
  poll(camera: Camera, leaseId: string, after = 0) {
    const l = this.leases.get(leaseId);
    if (!l || l.cameraId !== camera.id || l.sourceId !== camera.sourceId)
      throw new Error(
        "Preview expired or camera input changed. Reopen preview.",
      );
    l.until = Date.now() + 15000;
    const s = this.streams.get(l.sourceId)!;
    if (s.error) throw new Error(s.error);
    const fresh = s.latest && Date.now() - Date.parse(s.latest.at) < 2500;
    return {
      sequence: s.sequence,
      status: fresh ? "live" : "waiting",
      frame:
        fresh && s.sequence > after
          ? this.frame(camera, s.latest!, false)
          : undefined,
    };
  }
  private frame(
    camera: Camera,
    latest: { data: Buffer; at: string },
    retain: boolean,
  ): Frame {
    const frame: Frame = {
      id: randomUUID(),
      cameraId: camera.id,
      sourceId: camera.sourceId!,
      capturedAt: latest.at,
      revision: camera.revision,
      mimeType: "image/jpeg",
      data: latest.data.toString("base64"),
      sha256: createHash("sha256").update(latest.data).digest("hex"),
    };
    if (retain) {
      this.frames.set(frame.id, frame);
      while (this.frames.size > 20)
        this.frames.delete(this.frames.keys().next().value!);
    }
    return frame;
  }
  release(leaseId: string) {
    const lease = this.leases.get(leaseId);
    this.leases.delete(leaseId);
    if (
      lease &&
      ![...this.leases.values()].some((l) => l.sourceId === lease.sourceId)
    ) {
      const s = this.streams.get(lease.sourceId);
      if (s) {
        s.restarting = true;
        s.latest = undefined;
        void stopStream(s)
          .then(() => {
            if (this.streams.get(lease.sourceId) !== s) return;
            this.streams.delete(lease.sourceId);
            const source = this.sources.get(lease.sourceId);
            if (
              source &&
              [...this.leases.values()].some(
                (l) => l.sourceId === lease.sourceId,
              )
            )
              this.startStream(source, s.sequence + 1);
          })
          .catch((e) => {
            s.error = (e as Error).message;
            s.restarting = false;
          });
      }
    }
    return { closed: true };
  }
  releaseCamera(cameraId: string) {
    for (const [id, l] of this.leases)
      if (l.cameraId === cameraId) this.release(id);
  }
  async capture(camera: Camera) {
    const source = camera.sourceId && this.sources.get(camera.sourceId);
    if (source && source.kind === "rtsp") return this.still(camera, source);
    const lease = this.open(camera),
      start = this.streams.get(lease.sourceId)!.sequence,
      deadline = Date.now() + 10000;
    try {
      while (Date.now() < deadline) {
        const result = this.poll(camera, lease.leaseId, start);
        if (result.frame) {
          this.frames.set(result.frame.id, result.frame);
          while (this.frames.size > 20)
            this.frames.delete(this.frames.keys().next().value!);
          return result.frame;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(
        "No fresh frame received within 10 seconds. Check the SDI signal and capture format.",
      );
    } finally {
      this.release(lease.leaseId);
    }
  }
  // Network cameras serve a full-resolution main stream; grab stills from it
  // rather than the low-resolution preview substream.
  private async still(camera: Camera, source: CaptureSource) {
    const r = await runFfmpeg(stillArgs(source), 15000);
    const [data] = new JpegParser().push(r.stdout);
    if (!data)
      throw new Error(
        "No frame from the camera's main RTSP stream. Check that RTSP streaming is enabled on the camera.",
      );
    return this.frame(camera, { data, at: new Date().toISOString() }, true);
  }
  close() {
    clearInterval(this.timer);
    for (const id of [...this.leases.keys()]) this.release(id);
  }
}
// PTZOptics-style RTSP paths: /1 is the main stream, /2 the substream.
export const RTSP_PREVIEW_PATH = "/2",
  RTSP_STILL_PATH = "/1";
const isHost = (host: string) =>
  host.length <= 253 &&
  /^[a-zA-Z0-9.:[\]-]+$/.test(host) &&
  !host.startsWith("-");
export function rtspUrl(host: string, path: string) {
  if (!isHost(host)) throw new Error("Invalid camera address");
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `rtsp://${h}:554${path}`;
}
function inputArgs(source: CaptureSource, rtspPath: string) {
  if (source.kind === "rtsp")
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "5000000",
      "-fflags",
      "nobuffer",
      "-i",
      rtspUrl(source.device, rtspPath),
    ];
  const args = ["-hide_banner", "-loglevel", "error", "-f", source.kind];
  if (source.kind === "avfoundation") args.push("-framerate", "30");
  if (source.kind === "decklink" && source.format)
    args.push("-format_code", source.format);
  args.push(
    "-i",
    source.kind === "avfoundation"
      ? `${source.device}:none`
      : source.kind === "dshow"
        ? `video=${source.device}`
        : source.device,
  );
  return args;
}
// Camera substreams are often anamorphic (720×480 shown as 16:9).
const SQUARE_PIXELS = "scale=iw*sar:ih,setsar=1";
export function stillArgs(source: CaptureSource) {
  return [
    ...inputArgs(source, RTSP_STILL_PATH),
    "-an",
    "-frames:v",
    "1",
    // A 4K still would exceed what assistants accept; 1920 wide keeps detail.
    "-vf",
    `${SQUARE_PIXELS},scale=w='min(1920,iw)':h=-2`,
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}
export function captureArgs(source: CaptureSource) {
  return [
    ...inputArgs(source, RTSP_PREVIEW_PATH),
    "-an",
    "-vf",
    source.kind === "rtsp"
      ? `fps=8,${SQUARE_PIXELS},scale=960:-2`
      : "fps=8,scale=960:-2",
    "-c:v",
    "mjpeg",
    "-q:v",
    "4",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}
export class JpegParser {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024)
      throw new Error("Video frame exceeded the 8 MB limit");
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([255, 216]));
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(Buffer.from([255, 217]), 2);
      if (end < 0) break;
      frames.push(Buffer.from(this.buffer.subarray(0, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
    return frames;
  }
}
