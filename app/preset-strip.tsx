import React, { useEffect, useRef, useState } from "react";
import { Bookmark, Layers, Plus, RefreshCw, Trash2 } from "lucide-react";
import { command } from "./api";

interface PresetSummary {
  id: string;
  name: string;
  kind: "camera" | "scene";
  cameras: { cameraId: string }[];
}
interface Job {
  presetId: string;
  cameraIds: string[];
  status: string;
}

/** One-click looks for the selected camera, shown above the camera buttons. */
export function PresetStrip({
  cameraId,
  presets,
  jobs,
  perform,
  notify,
  onManage,
  disabled,
}: {
  /** Recall needs write access; saving never changes the camera. */
  cameraId: string;
  presets: PresetSummary[];
  jobs: Job[];
  perform: Function;
  notify: (message: string) => void;
  onManage: () => void;
  disabled: boolean;
}) {
  const [naming, setNaming] = useState(false),
    [name, setName] = useState(""),
    [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const mine = presets.filter((p) =>
    p.cameras.some((c) => c.cameraId === cameraId),
  );
  // Jobs are newest first: the first job for this camera is the active or last recall.
  const latest = jobs.find((j) => j.cameraIds.includes(cameraId));
  const running =
    latest && ["queued", "running"].includes(latest.status)
      ? latest.presetId
      : "";
  const active = latest?.status === "applied" ? latest.presetId : "";
  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);
  useEffect(() => {
    setNaming(false);
    setMenu(undefined);
  }, [cameraId]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".cam-menu")) setMenu(undefined);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  async function recall(p: PresetSummary) {
    try {
      const preview = await command("preset_preview", { presetId: p.id });
      if (preview.blockers.length) return notify(preview.blockers.join(" · "));
      if (!preview.changes.length) return notify(`Already at “${p.name}”.`);
      await perform("preset_recall", {
        presetId: p.id,
        fade: 0,
        expectedRevisions: preview.revisions,
      });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function save() {
    if (saving.current) return;
    const label = name.trim();
    if (!label) return setNaming(false);
    saving.current = true;
    try {
      await perform(
        "camera_preset_save",
        { cameraId, name: label },
        `Saved “${label}”.`,
      );
      setName("");
      setNaming(false);
    } catch {
      /* perform already showed the error; keep the name for a retry. */
    } finally {
      saving.current = false;
    }
  }
  const target = mine.find((p) => p.id === menu?.id);
  return (
    <section className="preset-strip" aria-label="Presets for this camera">
      <span className="preset-strip-label">
        <Bookmark size={12} />
        Looks
      </span>
      <div className="preset-strip-items">
        {mine.map((p) => (
          <button
            key={p.id}
            className={`preset-chip ${p.id === active ? "active" : ""} ${p.id === running ? "running" : ""}`}
            title={`${p.name}${p.kind === "scene" ? ` · scene, ${p.cameras.length} cameras` : ""} · right-click for options`}
            disabled={disabled || !!running}
            onClick={() => void recall(p)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: p.id, x: e.clientX, y: e.clientY });
            }}
          >
            {p.kind === "scene" && <Layers size={12} />}
            <span>{p.name}</span>
          </button>
        ))}
        {naming ? (
          <input
            ref={input}
            className="preset-name"
            aria-label="New look name"
            placeholder="Name this look"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName("");
                setNaming(false);
              }
            }}
          />
        ) : (
          <button
            className="preset-chip add"
            title="Save this camera's current look"
            onClick={() => setNaming(true)}
          >
            <Plus size={13} />
            Save look
          </button>
        )}
      </div>
      {menu && target && (
        <div
          className="cam-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 210),
            top: Math.min(menu.y, window.innerHeight - 130),
          }}
        >
          {target.kind === "camera" && (
            <button
              role="menuitem"
              autoFocus
              onClick={() => {
                setMenu(undefined);
                void perform(
                  "camera_preset_save",
                  { cameraId, id: target.id, name: target.name },
                  `Updated “${target.name}” to the current look.`,
                ).catch(() => {});
              }}
            >
              <RefreshCw size={13} />
              Update to current look
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              void perform(
                "preset_archive",
                { presetId: target.id, archived: true },
                `Removed “${target.name}”. Restore it from Presets.`,
              ).catch(() => {});
            }}
          >
            <Trash2 size={13} />
            Remove
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              onManage();
            }}
          >
            <Bookmark size={13} />
            Manage presets…
          </button>
        </div>
      )}
    </section>
  );
}
