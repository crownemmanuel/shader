import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import type { Camera, CaptureSource, Frame } from "./types.js";
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
export class CaptureService {
  sources = new Map<string, CaptureSource>();
  frames = new Map<string, Frame>();
  private streams = new Map<
    string,
    {
      process: ReturnType<typeof spawn>;
      parser: JpegParser;
      sequence: number;
      latest?: { data: Buffer; at: string };
      error?: string;
    }
  >();
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
    const format =
      process.platform === "darwin"
        ? "avfoundation"
        : process.platform === "win32"
          ? "dshow"
          : "v4l2";
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
      const r = await runFfmpeg([
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
        if (match) {
          const device = format === "avfoundation" ? match[1] : match[1],
            name = format === "avfoundation" ? match[2] : match[1];
          sources.push({
            id: `${format}:${device}`,
            name,
            kind: format,
            device,
          });
        }
      }
    }
    const devices = await runFfmpeg(["-hide_banner", "-devices"]);
    if (/\bdecklink\b/.test(devices.stdout.toString() + devices.stderr)) {
      const result = await runFfmpeg(["-hide_banner", "-sources", "decklink"]);
      for (const line of (result.stdout.toString() + result.stderr).split(
        "\n",
      )) {
        const m = line.match(/'([^']+)'/);
        if (m)
          sources.push({
            id: `decklink:${m[1]}`,
            name: m[1],
            kind: "decklink",
            device: m[1],
          });
      }
    } else
      diagnostics.push(
        "This FFmpeg build has no DeckLink input. UVC/AVFoundation capture is available; native DeckLink requires a DeckLink-enabled FFmpeg build and Blackmagic Desktop Video.",
      );
    for (const s of sources)
      if (
        ![...this.sources.values()].some(
          (x) => x.kind === s.kind && x.device === s.device,
        )
      )
        this.sources.set(s.id, s);
    return { sources: [...this.sources.values()], diagnostics };
  }
  register(source: CaptureSource) {
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
  open(camera: Camera) {
    if (!camera.sourceId)
      throw new Error(
        "Assign a capture input to this camera in Settings first.",
      );
    const source = this.sources.get(camera.sourceId);
    if (!source) throw new Error("Mapped capture input no longer exists.");
    if (!this.streams.has(source.id)) {
      const p = spawn(ffmpeg(), captureArgs(source), {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const stream: {
        process: ReturnType<typeof spawn>;
        parser: JpegParser;
        sequence: number;
        latest?: { data: Buffer; at: string };
        error?: string;
      } = { process: p, sequence: 0, parser: new JpegParser() };
      this.streams.set(source.id, stream);
      p.stdout!.on("data", (b: Buffer) => {
        try {
          for (const data of stream.parser.push(b)) {
            stream.latest = { data, at: new Date().toISOString() };
            stream.sequence++;
          }
        } catch (e) {
          stream.error = (e as Error).message;
          p.kill("SIGKILL");
        }
      });
      // Device stderr can contain local paths; expose only actionable diagnostics.
      p.stderr!.on("data", () => {});
      p.on("error", () => {
        stream.error =
          "FFmpeg could not start. Install FFmpeg or configure SHADER_FFMPEG.";
      });
      p.on("close", () => {
        stream.error ||=
          "Capture stopped. Check signal, input format, device permissions, and DeckLink-enabled FFmpeg with Desktop Video.";
      });
    }
    const leaseId = randomUUID();
    this.leases.set(leaseId, {
      cameraId: camera.id,
      sourceId: source.id,
      until: Date.now() + 15000,
    });
    return { leaseId, sourceId: source.id, cameraId: camera.id };
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
      this.streams.delete(lease.sourceId);
      if (s) {
        s.process.kill("SIGTERM");
        const t = setTimeout(() => s.process.kill("SIGKILL"), 1500).unref();
        s.process.once("close", () => clearTimeout(t));
      }
    }
    return { closed: true };
  }
  releaseCamera(cameraId: string) {
    for (const [id, l] of this.leases)
      if (l.cameraId === cameraId) this.release(id);
  }
  async capture(camera: Camera) {
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
  close() {
    clearInterval(this.timer);
    for (const id of [...this.leases.keys()]) this.release(id);
  }
}
export function captureArgs(source: CaptureSource) {
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
    "-an",
    "-vf",
    "fps=8,scale=960:-2",
    "-c:v",
    "mjpeg",
    "-q:v",
    "4",
    "-f",
    "image2pipe",
    "pipe:1",
  );
  return args;
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
