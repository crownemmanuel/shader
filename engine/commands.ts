import { z } from "zod";
import { isSea } from "node:sea";
import path from "node:path";
import { Engine } from "./engine.js";
import { sonyBridgePath } from "./adapters/sony.js";
import { connectionSchema } from "./types.js";
import { providerSchema } from "./providers.js";
import { lookCommands } from "./look-commands.js";
const shadeIntent = z
  .object({
    brightness: z.number().min(-4).max(4),
    warmth: z.number().min(-1).max(1),
    tint: z.number().min(-1).max(1),
  })
  .strict();
const id = z.string().min(1).max(200);
export interface Command {
  description: string;
  schema: z.ZodObject<any>;
  readOnly: boolean;
  run: (args: any, actor: string) => Promise<unknown> | unknown;
}
export function commands(engine: Engine) {
  const registry: Record<string, Command> = {
    ...lookCommands(engine),
    system_status: {
      description:
        "Read engine status, provider configuration without secrets, integrations, and recent operations.",
      schema: z.object({}).strict(),
      readOnly: true,
      run: () => ({
        version: "0.1.0",
        discovered: engine.discovery.list(),
        mcpConfig: {
          mcpServers: {
            shader: {
              command: process.execPath,
              args: isSea()
                ? ["--mcp"]
                : [
                    "--import",
                    path.resolve("node_modules/tsx/dist/loader.mjs"),
                    path.resolve("engine/main.ts"),
                    "--mcp",
                  ],
            },
          },
        },
        cameras: engine.list(),
        switchers: [...engine.switchers.values()].map((s) => s.info()),
        captureSources: [...engine.capture.sources.values()],
        exposurePolicies: engine.policies,
        provider: engine.assistant.settings(),
        presets: engine.presets.list(),
        presetJobs: structuredClone(engine.presets.jobs.slice(0, 20)),
        lighting: engine.lighting.context(),
        audit: engine.audit,
        integrations: {
          atem: "Network adapter",
          ptzoptics: "VISCA TCP + HTTP Digest",
          sony: sonyBridgePath()
            ? "Sony SDK 2.02 native bridge installed; hardware verification pending"
            : "SDK bridge not installed",
          capture: "FFmpeg input adapter",
        },
        historicalSetup: {
          switcher: "ATEM 2 M/E Production Studio 4K",
          host: "172.16.10.10",
          source:
            "Existing atem_state.json and Python scripts; not live status",
        },
      }),
    },
    cameras_discover: {
      description:
        "Discover DNS-SD, SSDP and ONVIF candidates; connect known camera protocols read-only. Includes saved connections and the existing ATEM address.",
      schema: z.object({}).strict(),
      readOnly: true,
      run: () => engine.autoDiscover(),
    },
    cameras_list: {
      description:
        "List connected cameras, current revisions, tally, capabilities and write-lock expiry.",
      schema: z.object({}).strict(),
      readOnly: true,
      run: () => engine.list(),
    },
    camera_connect: {
      description:
        "Connect and identify a camera/switcher. PTZOptics defaults to VISCA TCP 5678; profile http selects newer HTTP CGI. Sony requires the installed native SDK bridge.",
      schema: connectionSchema,
      readOnly: false,
      run: (a, actor) => engine.connect(a, actor),
    },
    camera_disconnect: {
      description:
        "Disconnect a device. All cameras sharing an ATEM session disconnect together.",
      schema: z.object({ cameraId: id }).strict(),
      readOnly: false,
      run: (a) => engine.disconnect(a.cameraId),
    },
    camera_get: {
      description:
        "Read a camera state and the complete exposed vendor control catalogue. Optional refresh queries the device.",
      schema: z
        .object({ cameraId: id, refresh: z.boolean().default(false) })
        .strict(),
      readOnly: true,
      run: (a) =>
        a.refresh
          ? engine.refresh(a.cameraId)
          : structuredClone(engine.camera(a.cameraId)),
    },
    camera_arm: {
      description:
        "Explicitly enable writes for one camera for up to five minutes. allowLive is required for program or unknown tally. Session locks are not persisted.",
      schema: z
        .object({
          cameraId: id,
          seconds: z.number().int().min(1).max(300).default(60),
          allowLive: z.boolean().default(false),
        })
        .strict(),
      readOnly: false,
      run: (a, actor) => engine.arm(a.cameraId, a.seconds, a.allowLive, actor),
    },
    camera_lock: {
      description: "Immediately lock a camera against writes.",
      schema: z.object({ cameraId: id }).strict(),
      readOnly: false,
      run: (a) => {
        engine.presets.cancelCamera(a.cameraId, "Camera locked");
        engine.arms.delete(a.cameraId);
        return { locked: true };
      },
    },
    control_set: {
      description:
        "Set a camera control using its native type and expected revision. Vectors must include every component. The same validation, locking and live guard apply to UI and agents.",
      schema: z
        .object({
          cameraId: id,
          controlId: id,
          value: z.unknown(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict(),
      readOnly: false,
      run: (a, actor) =>
        engine.set(a.cameraId, a.controlId, a.value, a.expectedRevision, actor),
    },
    camera_route: {
      description:
        "Map any camera vendor to a switcher input and zero-based M/E bus for live tally. Null clears mapping. Does not change physical ATEM routing.",
      schema: z
        .object({
          cameraId: id,
          route: z
            .object({
              host: z.string().min(1).max(253),
              input: z.number().int().min(0).max(65535),
              me: z.number().int().min(0).max(3),
            })
            .strict()
            .nullable(),
        })
        .strict(),
      readOnly: false,
      run: (a) => engine.route(a.cameraId, a.route),
    },
    exposure_policy: {
      description:
        "Set camera-specific Simple brightness limits. Shutter and ND are always held. Invalidates the previous Simple starting point.",
      schema: z
        .object({
          cameraId: id,
          policy: z
            .object({
              preserveAperture: z.boolean(),
              minF: z.number().min(0.7).max(64),
              maxF: z.number().min(0.7).max(64),
              minGain: z.number().min(-12).max(36),
              maxGain: z.number().min(-12).max(36),
              maxIso: z.number().int().min(50).max(102400),
            })
            .strict(),
        })
        .strict(),
      readOnly: false,
      run: (a) => engine.policy(a.cameraId, a.policy),
    },
    shade_begin: {
      description:
        "Anchor Simple controls to current camera values. Returns supported axes and a sessionId. Read camera first. Reversing sliders returns toward this starting point.",
      schema: z.object({ cameraId: id }).strict(),
      readOnly: true,
      run: (a) => engine.beginShade(a.cameraId),
    },
    shade_plan: {
      description:
        "Preview deterministic exposure and color targets without writes. Brightness is relative stops; warmth/tint are -1..1. Shutter stays fixed. Targets are not image measurements.",
      schema: z
        .object({ cameraId: id, sessionId: id, intent: shadeIntent })
        .strict(),
      readOnly: true,
      run: (a) => engine.planShade(a.cameraId, a.sessionId, a.intent),
    },
    shade_apply: {
      description:
        "Apply the same Simple brightness/warmth/tint recipe as UI. Requires write access and current revision. Partial failures report completed writes and invalidate the anchor.",
      schema: z
        .object({
          cameraId: id,
          sessionId: id,
          intent: shadeIntent,
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict(),
      readOnly: false,
      run: (a, actor) =>
        engine.applyShade(
          a.cameraId,
          a.sessionId,
          a.intent,
          a.expectedRevision,
          actor,
        ),
    },
    preview_open: {
      description:
        "Start shared live JPEG preview from the camera-assigned input. Poll within 15 seconds to renew the lease. Shares the physical input with capture_frame.",
      schema: z.object({ cameraId: id }).strict(),
      readOnly: true,
      run: (a) => engine.capture.open(engine.camera(a.cameraId)),
    },
    preview_frame: {
      description:
        "Get latest live preview frame only if newer than afterSequence. Waiting indicates no recent signal. Uses the same camera mapping as MCP snapshots.",
      schema: z
        .object({
          cameraId: id,
          leaseId: id,
          afterSequence: z.number().int().nonnegative().default(0),
        })
        .strict(),
      readOnly: true,
      run: (a) =>
        engine.capture.poll(
          engine.camera(a.cameraId),
          a.leaseId,
          a.afterSequence,
        ),
    },
    preview_close: {
      description:
        "Release a preview lease; stop capture when the last client releases the input.",
      schema: z.object({ leaseId: id }).strict(),
      readOnly: true,
      run: (a) => engine.capture.release(a.leaseId),
    },
    ptz_move: {
      description:
        "Move PTZOptics using a bounded pulse and always send stop. Speeds are signed: negative pan left, negative tilt up. Requires write access.",
      schema: z
        .object({
          cameraId: id,
          pan: z.number().int().min(-24).max(24),
          tilt: z.number().int().min(-20).max(20),
          durationMs: z.number().int().min(50).max(2000).default(250),
        })
        .strict(),
      readOnly: false,
      run: (a, actor) =>
        engine.move(a.cameraId, a.pan, a.tilt, a.durationMs, actor),
    },
    ptz_stop: {
      description:
        "Send a PTZ stop command. Always available even when write access has expired.",
      schema: z.object({ cameraId: id }).strict(),
      readOnly: false,
      run: (a) => engine.stop(a.cameraId),
    },
    capture_sources: {
      description:
        "Enumerate video capture inputs (UVC, AVFoundation, DirectShow, V4L2 and DeckLink when supported). OS camera permission may be required.",
      schema: z.object({}).strict(),
      readOnly: true,
      run: () => engine.capture.list(),
    },
    capture_register: {
      description:
        "Register a capture hardware source explicitly, including a DeckLink input format code. No shell commands or network URLs are accepted.",
      schema: z
        .object({
          id,
          name: z.string().min(1).max(200),
          kind: z.enum(["avfoundation", "decklink", "dshow", "v4l2"]),
          device: z.string().max(300),
          format: z
            .string()
            .regex(/^[a-zA-Z0-9]{2,8}$/)
            .optional(),
        })
        .strict(),
      readOnly: false,
      run: async (a) => {
        const s = engine.capture.register(a);
        await engine.save();
        return s;
      },
    },
    capture_assign: {
      description:
        "Map one capture input to one camera. The operator must ensure the SDI feed actually corresponds to that camera; the engine does not reroute an ATEM output.",
      schema: z.object({ cameraId: id, sourceId: id.nullable() }).strict(),
      readOnly: false,
      run: (a) => engine.assign(a.cameraId, a.sourceId),
    },
    capture_frame: {
      description:
        "Take one JPEG frame from the camera-assigned capture input. Returns image pixels plus camera/source identity, timestamp and control revision.",
      schema: z.object({ cameraId: id }).strict(),
      readOnly: true,
      run: (a) => engine.capture.capture(engine.camera(a.cameraId)),
    },
    frame_get: {
      description:
        "Retrieve a recent captured frame by ID. In-memory retention is limited to the most recent 20 frames.",
      schema: z.object({ frameId: id }).strict(),
      readOnly: true,
      run: (a) => {
        const frame = engine.capture.frames.get(a.frameId);
        if (!frame) throw new Error("Frame expired or not found");
        return frame;
      },
    },
    provider_configure: {
      description:
        "Configure OpenAI, Claude, Groq or an OpenAI-compatible model. Credentials remain in session memory and are never returned.",
      schema: providerSchema,
      readOnly: false,
      run: async (a) => {
        const result = engine.assistant.configure(a);
        await engine.save();
        return result;
      },
    },
    assistant_chat: {
      description:
        "Ask the internal model assistant about the selected camera. Writes and image sharing are separately scoped to this request.",
      schema: z
        .object({
          cameraId: id,
          message: z.string().min(1).max(16000),
          history: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string().max(16000),
              }),
            )
            .max(20)
            .default([]),
          frameId: id.optional(),
          shareFrames: z.boolean().default(false),
          allowWrites: z.boolean().default(false),
        })
        .strict(),
      readOnly: false,
      run: async (a) => {
        engine.camera(a.cameraId);
        const frame = a.frameId
          ? engine.capture.frames.get(a.frameId)
          : undefined;
        if (a.frameId && !frame) throw new Error("Attached frame expired");
        if (frame && (!a.shareFrames || frame.cameraId !== a.cameraId))
          throw new Error("Frame sharing must be enabled for this camera");
        const allowed = [
          "camera_get",
          "lighting_state",
          "presets_list",
          "preset_get",
          "preset_preview",
          "preset_jobs",
          "shade_begin",
          "shade_plan",
          ...(a.shareFrames ? ["capture_frame"] : []),
          ...(a.allowWrites
            ? [
                "control_set",
                "shade_apply",
                "ptz_move",
                "ptz_stop",
                "camera_preset_save",
                "preset_recall",
              ]
            : []),
        ];
        return engine.assistant.chat({
          ...a,
          frame,
          lighting: engine.lighting.context(true),
          tools: allowed.map((name) => ({
            name,
            description: registry[name].description,
            inputSchema: z.toJSONSchema(registry[name].schema) as Record<
              string,
              unknown
            >,
          })),
          execute: async (name, args) => {
            const parsed = registry[name].schema.parse(args) as any;
            if (parsed.cameraId !== a.cameraId)
              throw new Error("Camera is outside this assistant request scope");
            return registry[name].run(parsed, "assistant");
          },
        });
      },
    },
  };
  return registry;
}
export async function execute(
  registry: Record<string, Command>,
  name: string,
  args: unknown,
  actor: string,
) {
  const command = registry[name];
  if (!command) throw new Error(`Unknown command: ${name}`);
  return command.run(command.schema.parse(args ?? {}), actor);
}
