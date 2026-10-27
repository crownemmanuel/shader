import React, { useState } from "react";
import { Plus, Save, Play, Trash2, Users } from "lucide-react";
import type { Camera } from "../engine/types";
import {
  emptyPresetSlots,
  recallSlot,
  type PresetSlot,
  type PresetJob,
} from "./preset-strip";
import { PresetLibrary } from "./preset-library";

export function NumberedPresets({
  cameras,
  selected,
  slots = emptyPresetSlots,
  jobs,
  perform,
}: {
  cameras: Camera[];
  selected?: string;
  slots?: PresetSlot[];
  jobs: PresetJob[];
  perform: Function;
}) {
  const [active, setActive] = useState(1),
    [legacy, setLegacy] = useState(false);
  const slot = slots.find((s) => s.number === active) || slots[0];
  return (
    <div className="numbered-preset-panel">
      <p className="form-note">
        One preset number, a separate look for each camera. Save cameras
        individually or select several below. In the workspace, pressing a
        number applies only that camera’s look.
      </p>
      <nav className="preset-picker" aria-label="Choose preset to manage">
        {slots.map((s) => (
          <button
            key={s.number}
            className={s.number === slot.number ? "active" : ""}
            aria-pressed={s.number === slot.number}
            onClick={() => setActive(s.number)}
          >
            <strong>{s.number}</strong>
            <span>{s.label || `Preset ${s.number}`}</span>
            <small>{s.cameras.length} saved</small>
          </button>
        ))}
        <button
          disabled={slots.length >= 64}
          onClick={() => {
            void perform("preset_slot_add")
              .then((next: PresetSlot[]) => setActive(next.length))
              .catch(() => {});
          }}
        >
          <Plus size={16} />
          Add preset
        </button>
      </nav>
      <SlotEditor
        key={slot.number}
        slot={slot}
        cameras={cameras}
        selected={selected}
        jobs={jobs}
        perform={perform}
      />
      <details
        className="legacy-presets"
        onToggle={(e) => setLegacy(e.currentTarget.open)}
      >
        <summary>Older looks & scenes</summary>
        <p className="form-note">
          Your existing named looks are kept here. Numbered presets do not
          replace or delete them.
        </p>
        {legacy && (
          <PresetLibrary
            cameras={cameras}
            selected={selected}
            jobs={jobs as any}
            perform={perform}
          />
        )}
      </details>
    </div>
  );
}
function SlotEditor({
  slot,
  cameras,
  selected,
  jobs,
  perform,
}: {
  slot: PresetSlot;
  cameras: Camera[];
  selected?: string;
  jobs: PresetJob[];
  perform: Function;
}) {
  const [label, setLabel] = useState(slot.label),
    [checked, setChecked] = useState<string[]>(selected ? [selected] : []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const saved = new Map(slot.cameras.map((c) => [c.cameraId, c]));
  const connected = new Map(cameras.map((c) => [c.id, c]));
  const rows = [
    ...cameras.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    ...slot.cameras
      .filter((c) => !connected.has(c.cameraId))
      .map((c) => ({ id: c.cameraId, name: c.name, status: "disconnected" })),
  ];
  const pending = jobs.some(
    (j) =>
      j.presetId === slot.presetId && ["queued", "running"].includes(j.status),
  );
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="preset-slot-editor">
      <div className="slot-editor-heading">
        <h3>Preset {slot.number}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await perform("preset_slot_rename", { slot: slot.number, label });
              setNote("Preset name saved.");
            });
          }}
        >
          <label>
            Name (optional)
            <input
              value={label}
              maxLength={60}
              placeholder="Choir, sermon, worship…"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button disabled={busy || label.trim() === slot.label}>
            Save name
          </button>
        </form>
      </div>
      <div className="slot-actions">
        <button
          className="primary"
          disabled={busy || pending || !checked.length}
          onClick={() =>
            void act(async () => {
              await perform("preset_slot_save", {
                slot: slot.number,
                cameraIds: checked,
              });
              setNote(
                `Saved ${checked.length} camera${checked.length === 1 ? "" : "s"} to preset ${slot.number}.`,
              );
            })
          }
        >
          <Save size={15} />
          Save selected cameras ({checked.length})
        </button>
        <button
          disabled={busy || pending || !saved.size}
          onClick={() =>
            void act(() => recallSlot(slot.number, undefined, perform, setNote))
          }
        >
          <Users size={15} />
          Apply to all saved cameras ({saved.size})
        </button>
      </div>
      <p className="form-note">
        Saving updates only the checked cameras. Apply to all uses each camera’s
        own saved values; cameras with no saved look are left alone.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="form-note" role="status">
          {note}
        </p>
      )}
      <div className="slot-camera-table-scroll">
        <table className="slot-camera-table">
          <thead>
            <tr>
              <th scope="col">Save</th>
              <th scope="col">Camera</th>
              <th scope="col">Preset {slot.number}</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.name} to save`}
                    checked={checked.includes(c.id)}
                    disabled={busy || !["connected", "demo"].includes(c.status)}
                    onChange={(e) =>
                      setChecked((ids) =>
                        e.target.checked
                          ? [...ids, c.id]
                          : ids.filter((id) => id !== c.id),
                      )
                    }
                  />
                </td>
                <th scope="row">
                  {c.name}
                  <small>{c.status}</small>
                </th>
                <td>{saved.has(c.id) ? "Look saved" : "No look saved"}</td>
                <td>
                  <button
                    disabled={
                      busy ||
                      pending ||
                      !saved.has(c.id) ||
                      !["connected", "demo"].includes(c.status)
                    }
                    onClick={() =>
                      void act(() =>
                        recallSlot(slot.number, c.id, perform, setNote),
                      )
                    }
                    aria-label={`Apply preset ${slot.number} to ${c.name}`}
                  >
                    <Play size={13} />
                    Apply
                  </button>
                  <button
                    className="quiet"
                    disabled={busy || pending || !saved.has(c.id)}
                    aria-label={`Remove ${c.name} from preset ${slot.number}`}
                    onClick={() =>
                      void act(async () => {
                        await perform("preset_slot_remove_camera", {
                          slot: slot.number,
                          cameraId: c.id,
                        });
                        setNote(
                          `${c.name} removed from preset ${slot.number}.`,
                        );
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="form-note">Connect a camera to save its first look.</p>
      )}
    </section>
  );
}
