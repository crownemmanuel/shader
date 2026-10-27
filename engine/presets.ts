import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Engine } from "./engine.js";
import {
  sameValue,
  presetEligible,
  defaultPresetControls,
  presetValue,
} from "./preset-values.js";
export {
  sameValue,
  presetEligible,
  defaultPresetControls,
  presetValue,
} from "./preset-values.js";
import {
  validateValue,
  type Camera,
  type Control,
  type Value,
} from "./types.js";

const id = z.string().min(1).max(200);
export const presetSaveSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    cameras: z
      .array(
        z
          .object({
            cameraId: id,
            controlIds: z.array(id).min(1).max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    attachLighting: z.boolean().default(true),
  })
  .strict();
export interface PresetCamera {
  cameraId: string;
  name: string;
  vendor: Camera["vendor"];
  model: string;
  controls: Pick<Control, "id" | "label" | "type" | "value" | "freshness">[];
}
export interface Preset {
  id: string;
  slot?: number;
  name: string;
  description: string;
  kind: "camera" | "scene";
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  cameras: PresetCamera[];
  lighting?: unknown;
}
export interface RecallJob {
  id: string;
  presetId: string;
  name: string;
  cameraIds: string[];
  actor: string;
  status: "queued" | "running" | "applied" | "failed" | "cancelled";
  progress: number;
  completedWrites: number;
  verifiedWrites: number;
  summary: string;
  createdAt: string;
  finishedAt?: string;
}
export interface PresetFrame {
  cameraId: string;
  expected: Record<string, unknown>;
  values: { controlId: string; value: Value }[];
}

export class PresetService {
  private items: Preset[] = [];
  private slotLabels: string[] = ["", "", "", ""];
  jobs: RecallJob[] = [];
  private pending = new Map<string, Promise<void>>();
  private saveQueue = Promise.resolve();
  constructor(private engine: Engine) {}
  async init() {
    try {
      const data = JSON.parse(
        await readFile(
          path.join(this.engine.directory, "presets.json"),
          "utf8",
        ),
      );
      if (data.version !== 1 || !Array.isArray(data.presets))
        throw new Error("Unsupported preset library");
      const labels = z
        .array(z.string().max(60))
        .min(4)
        .max(64)
        .parse(data.slotLabels ?? ["", "", "", ""]);
      this.items = data.presets;
      this.slotLabels = labels;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.engine.record(
          "system",
          "presets_load",
          "error",
          "Preset library could not be loaded; original file retained.",
        );
    }
  }
  private async persist() {
    const data = JSON.stringify(
      { version: 1, presets: this.items, slotLabels: this.slotLabels },
      null,
      2,
    );
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.engine.directory, "presets.json");
        await writeFile(file + ".tmp", data, { mode: 0o600 });
        await rename(file + ".tmp", file);
      });
    await this.saveQueue;
  }
  list(includeArchived = false) {
    return this.items
      .filter((p) => includeArchived || !p.archived)
      .map((p) => ({
        id: p.id,
        ...(p.slot ? { slot: p.slot } : {}),
        name: p.name,
        description: p.description,
        kind: p.kind,
        archived: p.archived,
        cameras: p.cameras.map((c) => ({
          cameraId: c.cameraId,
          name: c.name,
          controls: c.controls.length,
        })),
        updatedAt: p.updatedAt,
        hasLighting: !!p.lighting,
      }));
  }
  catalogue() {
    return this.list().map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));
  }
  get(reference: string) {
    const active = this.items.filter((p) => !p.archived);
    const key = reference.toLowerCase();
    const found = active.find((p) => p.id.toLowerCase() === key);
    if (found) return structuredClone(found);
    const matches = active.filter((p) => p.name.toLowerCase() === key);
    if (matches.length > 1)
      throw new Error("Ambiguous preset name; use its stable ID");
    if (!matches.length) throw new Error(`Unknown preset ${reference}`);
    return structuredClone(matches[0]);
  }
  async save(input: z.infer<typeof presetSaveSchema>, actor: string) {
    const a = presetSaveSchema.parse(input);
    if (new Set(a.cameras.map((c) => c.cameraId)).size !== a.cameras.length)
      throw new Error("Select each camera once");
    const old = a.id ? this.get(a.id) : undefined;
    if (!old && this.items.length >= 500)
      throw new Error("Preset library limit reached (500)");
    if (old?.slot)
      throw new Error(
        "Use numbered preset commands to update this slot without replacing other cameras.",
      );
    const cameras = a.cameras.map((selection) => this.snapshot(selection));
    const now = new Date().toISOString();
    const preset: Preset = {
      id: old?.id || `look-${randomUUID()}`,
      name: a.name,
      description: a.description,
      kind: cameras.length > 1 ? "scene" : "camera",
      createdAt: old?.createdAt || now,
      updatedAt: now,
      archived: false,
      cameras,
      ...(a.attachLighting
        ? { lighting: this.engine.lighting.context(true) }
        : {}),
    };
    this.items = [...this.items.filter((p) => p.id !== preset.id), preset];
    await this.persist();
    this.engine.record(
      actor,
      "preset_save",
      "ok",
      `Saved ${preset.kind}: ${preset.name}`,
    );
    return structuredClone(preset);
  }
  private snapshot(selection: {
    cameraId: string;
    controlIds?: string[];
  }): PresetCamera {
    const c = this.engine.camera(selection.cameraId);
    const controls = selection.controlIds
      ? selection.controlIds.map((id) => {
          const control = c.controls.find((p) => p.id === id);
          if (!control || !presetEligible(control))
            throw new Error(`Cannot save unavailable control ${id}`);
          return control;
        })
      : defaultPresetControls(c);
    if (!controls.length)
      throw new Error(`No known shading values to save for ${c.name}`);
    for (const control of controls) validateValue(control, control.value);
    return {
      cameraId: c.id,
      name: c.name,
      vendor: c.vendor,
      model: c.model,
      controls: controls.map(({ id, label, type, value, freshness }) => ({
        id,
        label,
        type,
        value: structuredClone(value),
        freshness,
      })),
    };
  }
  private slot(number: number) {
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > this.slotLabels.length
    )
      throw new Error("Unknown preset number");
    return this.items.find((p) => p.slot === number && !p.archived);
  }
  private slotName(number: number) {
    return `Preset ${number}${this.slotLabels[number - 1] ? ` · ${this.slotLabels[number - 1]}` : ""}`;
  }
  slots() {
    return this.slotLabels.map((label, i) => {
      const preset = this.slot(i + 1);
      return {
        number: i + 1,
        label,
        presetId: preset?.id,
        cameras:
          preset?.cameras.map((c) => ({
            cameraId: c.cameraId,
            name: c.name,
          })) || [],
      };
    });
  }
  async addSlot(actor = "ui") {
    if (this.slotLabels.length >= 64)
      throw new Error("Maximum of 64 numbered presets reached");
    this.slotLabels.push("");
    await this.persist();
    this.engine.record(
      actor,
      "preset_slot_add",
      "ok",
      `Added preset ${this.slotLabels.length}`,
    );
    return this.slots();
  }
  async renameSlot(number: number, label: string, actor = "ui") {
    const preset = this.slot(number);
    this.slotLabels[number - 1] = z.string().trim().max(60).parse(label);
    if (preset) {
      preset.name = this.slotName(number);
      preset.updatedAt = new Date().toISOString();
    }
    await this.persist();
    this.engine.record(
      actor,
      "preset_slot_rename",
      "ok",
      this.slotName(number),
    );
    return this.slots();
  }
  async saveSlot(number: number, cameraIds: string[], actor: string) {
    const old = this.slot(number);
    if (
      !cameraIds.length ||
      cameraIds.length > 32 ||
      new Set(cameraIds).size !== cameraIds.length
    )
      throw new Error("Choose between 1 and 32 different cameras");
    // Capture every selected camera before replacing anything. Other cameras retain their saved values.
    const snapshots = cameraIds.map((cameraId) => this.snapshot({ cameraId }));
    const cameras = [
      ...(old?.cameras || []).filter((c) => !cameraIds.includes(c.cameraId)),
      ...snapshots,
    ];
    if (cameras.length > 32)
      throw new Error("A preset supports up to 32 cameras");
    if (!old && this.items.length >= 500)
      throw new Error("Preset library limit reached (500)");
    const now = new Date().toISOString();
    const preset: Preset = {
      id: old?.id || `look-${randomUUID()}`,
      slot: number,
      name: this.slotName(number),
      description: "Numbered camera preset",
      kind: cameras.length > 1 ? "scene" : "camera",
      createdAt: old?.createdAt || now,
      updatedAt: now,
      archived: false,
      cameras,
    };
    this.items = [...this.items.filter((p) => p.id !== preset.id), preset];
    await this.persist();
    this.engine.record(
      actor,
      "preset_slot_save",
      "ok",
      `Saved ${snapshots.map((c) => c.name).join(", ")} to ${preset.name}`,
    );
    return this.slots();
  }
  async removeSlotCamera(number: number, cameraId: string, actor: string) {
    const preset = this.slot(number);
    if (!preset) throw new Error("Preset is empty");
    preset.cameras = preset.cameras.filter((c) => c.cameraId !== cameraId);
    if (!preset.cameras.length)
      this.items = this.items.filter((p) => p.id !== preset.id);
    else {
      preset.kind = preset.cameras.length > 1 ? "scene" : "camera";
      preset.updatedAt = new Date().toISOString();
    }
    await this.persist();
    this.engine.record(
      actor,
      "preset_slot_remove",
      "ok",
      `Removed camera from ${this.slotName(number)}`,
    );
    return this.slots();
  }
  slotReference(number: number) {
    const preset = this.slot(number);
    if (!preset) throw new Error(`Preset ${number} is empty`);
    return preset.id;
  }
  private forCamera(reference: string, cameraId?: string) {
    const preset = this.get(reference);
    if (cameraId) {
      preset.cameras = preset.cameras.filter((c) => c.cameraId === cameraId);
      if (!preset.cameras.length)
        throw new Error("This camera has no look saved in this preset");
    }
    return preset;
  }
  async archive(id: string, archived: boolean) {
    const p = this.items.find((p) => p.id === id);
    if (!p) throw new Error("Unknown preset");
    p.archived = archived;
    p.updatedAt = new Date().toISOString();
    await this.persist();
    return this.list(true);
  }
  preview(reference: string, cameraId?: string) {
    const preset = this.forCamera(reference, cameraId),
      blockers: string[] = [],
      revisions: Record<string, number> = {};
    const changes: {
      cameraId: string;
      camera: string;
      controlId: string;
      label: string;
      from: unknown;
      to: unknown;
    }[] = [];
    for (const snapshot of preset.cameras) {
      try {
        const c = this.engine.camera(snapshot.cameraId);
        revisions[c.id] = c.revision;
        if (c.vendor !== snapshot.vendor || c.model !== snapshot.model)
          throw new Error("Camera model changed; save a new preset");
        this.engine.guard(c);
        for (const stored of snapshot.controls) {
          const control = c.controls.find((p) => p.id === stored.id);
          if (
            !control ||
            !presetEligible(control) ||
            control.type !== stored.type
          )
            throw new Error(`Control unavailable: ${stored.label}`);
          validateValue(control, stored.value);
          if (!sameValue(control.value, stored.value))
            changes.push({
              cameraId: c.id,
              camera: c.name,
              controlId: control.id,
              label: control.label,
              from: control.value,
              to: stored.value,
            });
        }
      } catch (e) {
        blockers.push(`${snapshot.name}: ${(e as Error).message}`);
      }
    }
    return {
      presetId: preset.id,
      name: preset.name,
      revisions,
      changes,
      blockers,
      note: "Scene recalls are preflighted together; hardware writes are sequential. A failure stops remaining writes without rollback. Shutter and other discrete controls change at the end of a fade.",
    };
  }
  recall(
    reference: string,
    fade: number,
    expectedRevisions: Record<string, number>,
    actor: string,
    cameraId?: string,
  ) {
    const preset = this.forCamera(reference, cameraId),
      preview = this.preview(reference, cameraId);
    if (preview.blockers.length) throw new Error(preview.blockers.join("; "));
    for (const [id, revision] of Object.entries(preview.revisions))
      if (expectedRevisions[id] !== revision)
        throw new Error("Camera state changed; preview the preset again");
    for (const c of preset.cameras)
      this.cancelCamera(c.cameraId, "Superseded by another preset");
    const baseline = preset.cameras.map((p) =>
      structuredClone(this.engine.camera(p.cameraId)),
    );
    const job: RecallJob = {
      id: randomUUID(),
      presetId: preset.id,
      name: preset.name,
      cameraIds: baseline.map((c) => c.id),
      actor,
      status: "queued",
      progress: 0,
      completedWrites: 0,
      verifiedWrites: 0,
      summary: "Preset queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs = [job, ...this.jobs].slice(0, 100);
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        let expected: Record<string, unknown>[] = baseline.map((c) =>
          Object.fromEntries(
            preset.cameras
              .find((p) => p.cameraId === c.id)!
              .controls.map((p) => [
                p.id,
                structuredClone(c.controls.find((x) => x.id === p.id)!.value),
              ]),
          ),
        );
        const started = performance.now();
        do {
          if (job.status === "cancelled") break;
          job.status = "running";
          const fraction =
            fade > 0
              ? Math.min(1, (performance.now() - started) / (fade * 1000))
              : 1;
          const frames: PresetFrame[] = baseline.map((c, i) => ({
            cameraId: c.id,
            expected: expected[i],
            values: preset.cameras[i].controls.map((p) => ({
              controlId: p.id,
              value: presetValue(
                c,
                c.controls.find((x) => x.id === p.id)!,
                p.value!,
                fraction,
              ),
            })),
          }));
          expected = await this.engine.presetFrame(frames, job);
          job.progress = fraction;
          if (fraction >= 1) {
            job.status = "applied";
            job.summary = `Sent ${job.completedWrites} changes; ${job.verifiedWrites} verified by readback`;
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        } while (true);
      })
      .catch((e) => {
        if (job.status !== "cancelled") {
          job.status = "failed";
          job.summary = `${job.completedWrites} changes sent before stopping: ${e.message}`;
        }
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.pending.delete(job.id);
        this.engine.record(
          actor,
          "preset_recall",
          job.status === "applied" ? "ok" : "error",
          `${job.name}: ${job.summary}`,
        );
      });
    this.pending.set(job.id, run);
    return structuredClone(job);
  }
  cancel(id: string, reason = "Stopped by operator") {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Unknown preset recall");
    if (["queued", "running"].includes(job.status)) {
      job.status = "cancelled";
      job.summary = `${reason}; ${job.completedWrites} changes already sent`;
    }
    return structuredClone(job);
  }
  cancelCamera(cameraId: string, reason = "Manual adjustment took over") {
    for (const job of this.jobs)
      if (
        job.cameraIds.includes(cameraId) &&
        ["queued", "running"].includes(job.status)
      )
        this.cancel(job.id, reason);
  }
  async wait(id: string) {
    await this.pending.get(id);
    return structuredClone(this.jobs.find((j) => j.id === id)!);
  }
  async close() {
    for (const j of this.jobs) this.cancel(j.id, "Engine stopping");
    await Promise.allSettled([...this.pending.values(), this.saveQueue]);
  }
}
