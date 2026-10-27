import { z } from "zod";
import type { Engine } from "./engine.js";
import type { Command } from "./commands.js";
const id = z.string().min(1).max(300);
const ids = z.array(id).min(1).max(8);
export function recorderCommands(engine: Engine): Record<string, Command> {
  const simple = (
    description: string,
    name: string,
    schema: z.ZodObject<any>,
    readOnly = false,
  ): Command => ({
    description,
    schema: schema.strict(),
    readOnly,
    run: (a) => engine.recorder.call(name, a),
  });
  const source = (id: string) => {
    const s = engine.capture.sources.get(id);
    if (!s || s.kind !== "decklink")
      throw Error("Choose a discovered DeckLink input");
    return {
      id: s.id,
      device: s.device,
      name: s.alias || s.name,
      cardId: s.cardId,
      connector: s.connector,
      mode: s.recorderMode || "1080p30",
      audioChannels: s.audioChannels || 16,
    };
  };
  return {
    recorder_status: simple(
      "Read Recorder Studio, take, input, and marker status. Starts the local recorder service when needed.",
      "status",
      z.object({}),
      true,
    ),
    recorder_storage: simple(
      "Read actual free and total space on the selected recording drive.",
      "storage",
      z.object({ path: z.string().min(1).max(2000) }),
      true,
    ),
    recorder_preview: simple(
      "Read a reduced-resolution preview from an already monitored recorder input.",
      "preview",
      z.object({
        sourceId: id,
        afterSequence: z.number().int().nonnegative().optional(),
      }),
      true,
    ),
    recorder_monitor: {
      description:
        "Keep selected physical inputs open for multiview and recording. Shares their previews with shading.",
      schema: z.object({ sourceIds: ids }).strict(),
      readOnly: false,
      run: async (a) => {
        const sources = a.sourceIds.map(source);
        await engine.recorder.ensure();
        for (const s of sources) engine.recorder.reserved.add(s.id);
        try {
          for (const s of sources) await engine.capture.suspendSource(s.id);
          return await engine.recorder.call("monitor", { sources });
        } finally {
          // Reconcile even after a partial failure, so no second process opens a live input.
          try {
            await engine.recorder.call("status");
            for (const s of sources) engine.recorder.reserved.delete(s.id);
          } catch {
            /* Keep ownership reserved until reconnection. */
          }
        }
      },
    },
    recorder_release: simple(
      "Release monitored inputs after recording has stopped.",
      "release",
      z.object({ sourceIds: ids }),
    ),
    recorder_input_update: {
      description:
        "Rename a capture input and configure its recording format/audio. Names appear in dropdowns and new recording filenames.",
      schema: z
        .object({
          sourceId: id,
          name: z.string().trim().min(1).max(120),
          mode: z.enum(["1080p30", "1080p2997"]),
          audioChannels: z.union([z.literal(2), z.literal(8), z.literal(16)]),
          cameraId: id.nullable().optional(),
        })
        .strict(),
      readOnly: false,
      run: async (a) => {
        if (engine.recorder.cached.active)
          throw Error(
            "Stop recording before changing names or camera mappings",
          );
        const s = engine.capture.sources.get(a.sourceId);
        if (!s) throw Error("Input no longer exists");
        if (
          engine.recorder.owns(s.id) &&
          (a.mode !== (s.recorderMode || "1080p30") ||
            a.audioChannels !== (s.audioChannels || 16))
        )
          throw Error(
            "Stop monitoring before changing video format or audio channels",
          );
        if (a.cameraId) engine.camera(a.cameraId);
        s.alias = a.name;
        s.recorderMode = a.mode;
        s.audioChannels = a.audioChannels;
        if (a.cameraId !== undefined) {
          for (const c of engine.list())
            if (c.sourceId === s.id && c.id !== a.cameraId)
              await engine.assign(c.id, null);
          if (a.cameraId) await engine.assign(a.cameraId, s.id);
        }
        await engine.save();
        if (engine.recorder.owns(s.id))
          await engine.recorder.call("monitor", { sources: [source(s.id)] });
        engine.emit("change");
        return s;
      },
    },
    recorder_start: {
      description:
        "Record one file stream per selected physical input with embedded SDI audio. Use a UUID requestId for safe retries.",
      schema: z
        .object({
          requestId: z.uuid(),
          name: z.string().trim().min(1).max(80),
          directory: z.string().min(1).max(2000),
          sourceIds: ids,
          profile: z.enum(["prores", "prores-lt"]),
          durationSeconds: z.number().int().min(1).max(86400).optional(),
        })
        .strict(),
      readOnly: false,
      run: (a) =>
        engine.recorder.call("start", {
          ...a,
          cameraMappings: Object.fromEntries(
            a.sourceIds.map((id: string) => [
              id,
              engine
                .list()
                .filter((c) => c.sourceId === id)
                .map((c) => c.id),
            ]),
          ),
        }),
    },
    recorder_stop: simple(
      "Stop and finalize every active recording track; return complete or partial results.",
      "stop",
      z.object({}),
    ),
    recorder_marker: simple(
      "Save an operator marker on the active take timeline.",
      "marker",
      z.object({ label: z.string().trim().min(1).max(200) }),
    ),
    recorder_markers: simple(
      "Read saved marker events and explicit scene intervals.",
      "markers",
      z.object({ sessionId: z.uuid().optional() }),
      true,
    ),
    recorder_recover: simple(
      "Recover checkpointed partial MOV files into new files, preserving originals. Inspect the recovery report before use.",
      "recover",
      z.object({ sessionId: z.uuid() }),
    ),
    recorder_export: simple(
      "Regenerate editor-neutral marker sidecars for a saved take.",
      "export",
      z.object({ sessionId: z.uuid() }),
    ),
    recorder_network: simple(
      "Enable StageMics HTTP marker delivery on this computer or an allowed show-network sender.",
      "network_configure",
      z.object({
        enabled: z.boolean(),
        host: z.enum(["127.0.0.1", "0.0.0.0"]),
        port: z.number().int().min(1024).max(65535).default(9202),
        allowedSenders: z.array(z.ipv4()).max(32).default([]),
      }),
    ),
    recorder_pairing_key: {
      description:
        "Show the StageMics pairing key in the local operator UI only.",
      schema: z.object({}).strict(),
      readOnly: true,
      run: (_, actor) => {
        if (actor !== "ui")
          throw Error("Pairing keys can only be shown in Recorder Studio");
        return engine.recorder.call("pairing_key");
      },
    },
  };
}
