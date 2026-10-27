import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CaptureSource } from "./types.js";

export const decklinkErrors: Record<string, string> = {
  driver_unavailable:
    "Blackmagic Desktop Video is unavailable. Install Desktop Video on this Windows computer, then restart Shader.",
  driver_incompatible:
    "The installed Desktop Video runtime could not provide the required DeckLink interface. Update Desktop Video and restart Shader.",
  input_busy:
    "This DeckLink input is in use. Release it in vMix, Media Express, or other capture software, then retry preview.",
  input_inactive:
    "This DeckLink input is inactive or configured for output. Check its connector profile in Desktop Video Setup.",
  device_missing:
    "The mapped DeckLink input was not found. Find video inputs again and check the card in Desktop Video Setup.",
  ambiguous_device:
    "Several DeckLink inputs share this name. Find video inputs and select the input by its unique identity.",
  format_required:
    "This input requires a manual video format. Select its resolution and frame rate in capture settings.",
  unsupported_format:
    "The DeckLink input does not support this signal format. Choose a supported format or use automatic detection.",
  conversion_failed:
    "DeckLink could not convert the captured video. Check the input's signal format and Desktop Video version.",
  encoding_failed: "Windows could not encode the DeckLink preview frame.",
  encoder_unavailable:
    "Windows Imaging Component is unavailable; DeckLink previews cannot be encoded.",
  enumeration_failed:
    "DeckLink could not list video formats. Check Desktop Video and scan again.",
  device_identity_unavailable:
    "DeckLink did not report a stable device identity. Check Desktop Video and scan again.",
  capture_failed:
    "DeckLink capture stopped. Check the card and signal in Desktop Video Setup, then retry preview.",
};
export const decklinkError = (code: string) =>
  decklinkErrors[code] || decklinkErrors.capture_failed;

export function decklinkBridgePath(): string | undefined {
  const override = process.env.SHADER_DECKLINK_BRIDGE;
  if (override)
    return path.isAbsolute(override) && existsSync(override)
      ? override
      : undefined;
  if (process.platform !== "win32") return undefined;
  return [
    path.resolve("native/decklink/build/shader-decklink.exe"),
    path.resolve(
      path.dirname(process.execPath),
      "decklink/shader-decklink.exe",
    ),
  ].find(existsSync);
}
const modeSchema = z.object({
  code: z.string().regex(/^[a-zA-Z0-9]{3,4}$/),
  name: z.string().max(200),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(4320),
  fps: z.number().nonnegative().max(1000),
});
const responseSchema = z.object({
  protocol: z.literal(1),
  error: z.string().optional(),
  diagnostics: z.array(z.string().max(500)).max(256).default([]),
  sources: z
    .array(
      z.object({
        device: z.string().regex(/^pid:[a-f0-9]+:sub:\d+$/),
        name: z.string().max(200),
        nativeName: z.string().max(200),
        model: z.string().max(200),
        supportsAutoDetection: z.boolean(),
        modes: z.array(modeSchema).max(256),
        connector: z.number().int().min(1).max(8).optional(),
        subdeviceIndex: z.number().int().nonnegative().optional(),
        profile: z.string().max(4).optional(),
        cardId: z.string().max(40).optional(),
      }),
    )
    .max(128),
});

/** One short-lived enumeration process; one long-lived process per leased input. */
export class DeckLinkBridge {
  constructor(
    readonly executable = decklinkBridgePath(),
    private prefixArgs: string[] = [],
  ) {}
  available() {
    return !!this.executable;
  }
  async list(): Promise<{ sources: CaptureSource[]; diagnostics: string[] }> {
    if (!this.executable)
      throw new Error(
        "Native DeckLink helper is missing. Reinstall the Windows app or build it with npm run build:decklink.",
      );
    const child = spawn(this.executable, [...this.prefixArgs, "--list"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            "DeckLink discovery timed out. Check Desktop Video Setup and try again.",
          ),
        );
      }, 15000).unref();
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          child.kill();
          reject(new Error("DeckLink returned an oversized device list."));
        } else chunks.push(chunk);
      });
      child.stderr.on("data", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        reject(
          new Error(
            "Native DeckLink helper could not start. Reinstall the Windows app.",
          ),
        );
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    let result: z.infer<typeof responseSchema>;
    try {
      result = responseSchema.parse(JSON.parse(output));
    } catch {
      throw new Error(
        "Native DeckLink helper returned an invalid device list. Reinstall the Windows app.",
      );
    }
    if (result.error) throw new Error(decklinkError(result.error));
    return {
      sources: result.sources.map((s) => ({
        ...s,
        id: `decklink:${s.device}`,
        kind: "decklink",
        backend: "decklink-sdk",
        available: true,
      })),
      diagnostics: result.diagnostics,
    };
  }
  start(source: CaptureSource): ChildProcess {
    if (!this.executable)
      throw new Error(
        "Native DeckLink helper is missing. Reinstall the Windows app or build it with npm run build:decklink.",
      );
    return spawn(
      this.executable,
      [
        ...this.prefixArgs,
        "--capture",
        source.device,
        ...(source.format ? ["--format", source.format] : []),
      ],
      { shell: false, windowsHide: true, stdio: "pipe" },
    );
  }
}

/** Only recognized codes cross the process boundary; arbitrary driver stderr stays private. */
export class DeckLinkEvents {
  private pending = "";
  constructor(
    private receive: (event: {
      error?: string;
      signal?: "live" | "no_signal" | "format_changed";
    }) => void,
  ) {}
  push(chunk: Buffer) {
    this.pending += chunk.toString("utf8");
    if (this.pending.length > 65536) {
      this.pending = "";
      return;
    }
    let at: number;
    while ((at = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      try {
        const event = JSON.parse(line);
        if (event.event === "error" && typeof event.code === "string")
          this.receive({ error: decklinkError(event.code) });
        if (
          event.event === "status" &&
          ["live", "no_signal", "format_changed"].includes(event.status)
        )
          this.receive({ signal: event.status });
      } catch {
        /* non-protocol vendor output */
      }
    }
  }
}
