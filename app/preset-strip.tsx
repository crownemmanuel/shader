import React, { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  Plus,
  Save,
  Settings2,
  Users,
} from "lucide-react";
import { command } from "./api";

export interface PresetSlot {
  number: number;
  label: string;
  presetId?: string;
  cameras: { cameraId: string; name: string }[];
}
export const emptyPresetSlots: PresetSlot[] = [1, 2, 3, 4].map((number) => ({
  number,
  label: "",
  cameras: [],
}));
export interface PresetJob {
  presetId: string;
  cameraIds: string[];
  status: string;
  summary?: string;
}
export async function recallSlot(
  slot: number,
  cameraId: string | undefined,
  perform: Function,
  notify: (message: string) => void,
) {
  const scope = { slot, ...(cameraId ? { cameraId } : {}) };
  const preview = await command("preset_slot_preview", scope);
  if (preview.blockers.length) throw new Error(preview.blockers.join(" · "));
  if (!preview.changes.length) {
    notify(
      `Already at preset ${slot}${cameraId ? " for this camera" : " on all saved cameras"}.`,
    );
    return;
  }
  await perform("preset_slot_recall", {
    ...scope,
    expectedRevisions: preview.revisions,
  });
}

/** Numbered hardware-style slots: a normal recall is always scoped to the selected camera. */
export function PresetStrip({
  cameraId,
  cameraName,
  slots = emptyPresetSlots,
  jobs,
  perform,
  notify,
  onManage,
  disabled,
}: {
  cameraId: string;
  cameraName: string;
  slots?: PresetSlot[];
  jobs: PresetJob[];
  perform: Function;
  notify: (message: string) => void;
  onManage: () => void;
  disabled: boolean;
}) {
  const [storing, setStoring] = useState(false),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState<{ number: number; x: number; y: number }>();
  const pending = useRef(false);
  const running = jobs.find(
    (j) =>
      j.cameraIds.includes(cameraId) &&
      ["queued", "running"].includes(j.status),
  );
  const latest = jobs.find((j) => j.cameraIds.includes(cameraId));
  const target = slots.find((s) => s.number === menu?.number);
  async function act(fn: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMenu(undefined);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save(slot: number) {
    await perform("preset_slot_save", { slot, cameraIds: [cameraId] });
    setStoring(false);
    notify(`${cameraName} saved to preset ${slot}.`);
  }
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".preset-slot-menu"))
        setMenu(undefined);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setStoring(false);
        return;
      }
      if (
        e.repeat ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        busy ||
        running ||
        menu ||
        !/^[1-9]$/.test(e.key) ||
        (e.target as HTMLElement).closest(
          "input, textarea, select, [contenteditable], dialog",
        ) ||
        document.querySelector(".camera-bank-grid.editing")
      )
        return;
      const slot = slots.find((s) => s.number === Number(e.key));
      if (
        !slot ||
        (!storing &&
          (disabled || !slot.cameras.some((c) => c.cameraId === cameraId)))
      )
        return;
      e.preventDefault();
      void act(() =>
        storing
          ? save(slot.number)
          : recallSlot(slot.number, cameraId, perform, notify),
      );
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [
    cameraId,
    slots,
    disabled,
    storing,
    busy,
    running,
    menu,
    perform,
    notify,
  ]);
  return (
    <section
      className={`preset-strip numbered-presets ${storing ? "storing" : ""}`}
      aria-label="Numbered camera presets"
    >
      <div className="preset-slot-toolbar">
        <span className="preset-strip-label">
          <Bookmark size={12} />
          Presets
        </span>
        <button
          className={storing ? "quiet active" : "quiet"}
          aria-pressed={storing}
          disabled={busy || !!running}
          onClick={() => setStoring(!storing)}
        >
          <Save size={13} />
          {storing ? "Cancel save" : "Save…"}
        </button>
        <button
          className="quiet"
          onClick={onManage}
          title="Name presets and choose which cameras to save"
        >
          <Settings2 size={13} />
          Manage
        </button>
      </div>
      <div className="preset-strip-items">
        {slots.map((slot) => {
          const saved = slot.cameras.some((c) => c.cameraId === cameraId);
          const open = (button: HTMLElement) => {
            const r = button.getBoundingClientRect();
            setMenu({ number: slot.number, x: r.left, y: r.bottom + 4 });
          };
          return (
            <div
              key={slot.number}
              className={`preset-slot ${saved ? "filled" : "empty"} ${running && running.presetId === slot.presetId ? "running" : ""}`}
              onContextMenu={(e) => {
                e.preventDefault();
                open(e.currentTarget);
              }}
            >
              <button
                className="preset-slot-recall"
                aria-label={`${storing ? "Save" : "Recall"} preset ${slot.number} for ${cameraName}${slot.label ? `: ${slot.label}` : ""}`}
                disabled={
                  busy || !!running || (!storing && (!saved || disabled))
                }
                title={
                  storing
                    ? `Save ${cameraName}’s current look to preset ${slot.number}`
                    : !saved
                      ? `No look saved for ${cameraName}. Choose Save…, then ${slot.number}.`
                      : `${slot.label || `Preset ${slot.number}`} for ${cameraName}${slot.number <= 9 ? ` · press ${slot.number}` : ""}`
                }
                onClick={() =>
                  void act(() =>
                    storing
                      ? save(slot.number)
                      : recallSlot(slot.number, cameraId, perform, notify),
                  )
                }
              >
                <strong>{slot.number}</strong>
                {slot.label && <span>{slot.label}</span>}
              </button>
              <button
                className="preset-slot-options"
                aria-label={`Preset ${slot.number} options`}
                aria-haspopup="menu"
                aria-expanded={target?.number === slot.number}
                disabled={busy}
                onClick={(e) => open(e.currentTarget)}
              >
                <ChevronDown size={12} />
              </button>
            </div>
          );
        })}
        <button
          className="preset-slot-add"
          aria-label="Add preset slot"
          title="Add another numbered preset"
          disabled={busy || slots.length >= 64}
          onClick={() => void act(() => perform("preset_slot_add"))}
        >
          <Plus size={15} />
        </button>
      </div>
      {storing && (
        <p className="preset-strip-message" role="status">
          Choose a number to save {cameraName}’s current look. Other cameras’
          saved looks stay unchanged.
        </p>
      )}
      {latest?.status === "failed" && (
        <p className="preset-strip-message error-text" role="alert">
          Preset recall failed: {latest.summary}
        </p>
      )}
      {menu && target && (
        <div
          className="cam-menu preset-slot-menu"
          role="menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 280)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 160)),
          }}
        >
          <button
            role="menuitem"
            autoFocus
            disabled={!!running}
            onClick={() => void act(() => save(target.number))}
          >
            <Save size={13} />
            Save {cameraName} to preset {target.number}
          </button>
          <button
            role="menuitem"
            disabled={!target.cameras.length || !!running}
            onClick={() =>
              void act(() =>
                recallSlot(target.number, undefined, perform, notify),
              )
            }
          >
            <Users size={13} />
            Apply to all saved cameras ({target.cameras.length})
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              onManage();
            }}
          >
            <Settings2 size={13} />
            Name & manage presets
          </button>
        </div>
      )}
    </section>
  );
}
