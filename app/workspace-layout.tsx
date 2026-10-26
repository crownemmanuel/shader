import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Plus,
  PanelsTopLeft,
  ArrowLeftRight,
  Maximize2,
  Minimize2,
  Pencil,
  Lock,
  EyeOff,
  X,
  Camera as CameraGlyph,
  Video,
  User,
  Users,
  Mic,
  Music,
  Church,
  Presentation,
  Mountain,
  Focus,
  Move,
  BookOpen,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { Camera } from "../engine/types";

interface LayoutPreferences {
  controlsLeft: boolean;
  showCameras: boolean;
}
const defaults: LayoutPreferences = { controlsLeft: false, showCameras: true };
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<LayoutPreferences>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("shader.workspace-layout") || "{}",
      );
      return {
        controlsLeft: saved.controlsLeft === true,
        showCameras: saved.showCameras !== false,
      };
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("shader.workspace-layout", JSON.stringify(layout));
    } catch {
      /* Layout remains usable when storage is unavailable. */
    }
  }, [layout]);
  return [layout, setLayout] as const;
}

/** Operator-chosen face for a camera button; unset fields fall back to position defaults. */
export interface CameraButtonStyle {
  label?: string;
  color?: string;
  icon?: string;
}
// Red is reserved for On Air, so no default camera color is red.
export const cameraColors = [
  "#4f8fe6",
  "#e0a84e",
  "#3fb8a9",
  "#9a7bea",
  "#e06fa8",
  "#6cc070",
  "#e5844a",
  "#45b4d8",
  "#c9b458",
  "#8a96a3",
];
const cameraIcons: Record<string, typeof CameraGlyph> = {
  camera: CameraGlyph,
  video: Video,
  user: User,
  users: Users,
  mic: Mic,
  music: Music,
  stage: Church,
  screen: Presentation,
  wide: Mountain,
  close: Focus,
  ptz: Move,
  pulpit: BookOpen,
};
// Short device names (an ATEM input label such as "ROV 6") make the best default.
export function defaultLabel(index: number, name = "") {
  return name.trim() && name.trim().length <= 12
    ? name.trim()
    : `Cam ${index + 1}`;
}
export function cameraLook(
  index: number,
  style: CameraButtonStyle | undefined,
  name?: string,
) {
  return {
    label: style?.label?.trim() || defaultLabel(index, name),
    color: style?.color || cameraColors[index % cameraColors.length],
    Icon: style?.icon ? cameraIcons[style.icon] : undefined,
  };
}
export function useCameraButtons() {
  const [styles, setStyles] = useState<Record<string, CameraButtonStyle>>(
    () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem("shader.camera-buttons") || "{}",
        );
        return saved && typeof saved === "object" ? saved : {};
      } catch {
        return {};
      }
    },
  );
  useEffect(() => {
    try {
      localStorage.setItem("shader.camera-buttons", JSON.stringify(styles));
    } catch {
      /* Buttons fall back to numbered defaults when storage is unavailable. */
    }
  }, [styles]);
  return [styles, setStyles] as const;
}

function cameraState(c: Camera) {
  if (c.tally === "program") return "On Air";
  if (c.tally === "preview") return "Preview";
  if (c.vendor !== "demo" && c.status !== "connected") return c.status;
  return "";
}

export function CameraBank({
  cameras,
  selected,
  onSelect,
  onAdd,
  inert,
  styles,
  onStyle,
  onHide,
  onManageHidden,
}: {
  cameras: (Camera & { locked?: boolean; hidden?: boolean })[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  inert: boolean;
  styles: Record<string, CameraButtonStyle>;
  onStyle: (id: string, style: CameraButtonStyle | undefined) => void;
  onHide: (id: string) => void;
  onManageHidden: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [editor, setEditor] = useState(""),
    [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  // Button defaults (color, "Cam N") follow the full list so hiding one never recolors the rest.
  const visible = cameras.filter((c) => !c.hidden),
    hiddenCount = cameras.length - visible.length;
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
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  // Digits 1–9 switch cameras unless the operator is typing or using a control.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        inert ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        !/^[1-9]$/.test(e.key) ||
        target.closest("input, textarea, select, [contenteditable], dialog")
      )
        return;
      const camera = visible[Number(e.key) - 1];
      if (camera) onSelect(camera.id);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [visible.map((c) => c.id).join(), onSelect, inert]);
  const editIndex = cameras.findIndex((c) => c.id === editor);
  return (
    <section className="camera-bank" aria-label="Cameras" inert={inert}>
      <div className="camera-bank-heading">
        <span>
          Cameras <small>{visible.length}</small>
          {hiddenCount > 0 && (
            <button
              className="quiet camera-bank-hidden"
              title="Choose which inputs appear as camera buttons"
              onClick={onManageHidden}
            >
              <EyeOff size={12} />
              {hiddenCount} hidden
            </button>
          )}
        </span>
        <span className="camera-bank-actions">
          {editing && <small>Click a button to rename or recolor it</small>}
          <button
            className={editing ? "quiet active" : "quiet"}
            aria-pressed={editing}
            title="Rename, recolor or add an icon to camera buttons"
            onClick={() => setEditing(!editing)}
          >
            <Pencil size={13} />
            {editing ? "Done" : "Edit"}
          </button>
          <button
            className="icon"
            aria-label="Add camera"
            title="Add camera…"
            onClick={onAdd}
          >
            <Plus size={16} />
          </button>
        </span>
      </div>
      <nav
        className={`camera-bank-grid ${editing ? "editing" : ""}`}
        aria-label="Camera selection"
      >
        {visible.map((c, position) => {
          const index = cameras.indexOf(c),
            look = cameraLook(index, styles[c.id], c.name),
            state = cameraState(c);
          return (
            <button
              key={c.id}
              aria-current={c.id === selected ? "true" : undefined}
              title={`${c.name} · ${c.model}${c.locked ? " · locked" : ""}${position < 9 ? ` · press ${position + 1}` : ""} · right-click for options`}
              className={`cam-button ${c.id === selected ? "selected" : ""} ${c.tally === "program" ? "on-air" : c.tally === "preview" ? "preview" : ""} ${c.vendor !== "demo" && c.status !== "connected" ? "offline" : ""}`}
              style={{ "--cam": look.color } as React.CSSProperties}
              onClick={() => (editing ? setEditor(c.id) : onSelect(c.id))}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: c.id, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="cam-button-top">
                {look.Icon ? <look.Icon size={14} /> : <span />}
                <span className="cam-button-flags">
                  {c.locked && <Lock size={11} aria-label="Locked" />}
                  <i className="cam-led" aria-hidden="true" />
                </span>
              </span>
              <strong>{look.label}</strong>
              <small>{state || " "}</small>
              {editing && <Pencil className="cam-edit-mark" size={11} />}
            </button>
          );
        })}
        {!visible.length && (
          <span className="camera-bank-empty">
            {cameras.length
              ? "All cameras are hidden."
              : "Connect a camera to begin."}
          </span>
        )}
      </nav>
      {menu && (
        <div
          className="cam-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 100),
          }}
        >
          <button
            role="menuitem"
            autoFocus
            onClick={() => {
              setEditor(menu.id);
              setMenu(undefined);
            }}
          >
            <Pencil size={13} />
            Edit button…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onHide(menu.id);
              setMenu(undefined);
            }}
          >
            <EyeOff size={13} />
            Hide camera
          </button>
        </div>
      )}
      {editIndex >= 0 && (
        <CameraButtonEditor
          camera={cameras[editIndex]}
          index={editIndex}
          style={styles[editor]}
          onSave={(style) => {
            onStyle(editor, style);
            setEditor("");
          }}
          onClose={() => setEditor("")}
        />
      )}
    </section>
  );
}

function CameraButtonEditor({
  camera,
  index,
  style,
  onSave,
  onClose,
}: {
  camera: Camera;
  index: number;
  style: CameraButtonStyle | undefined;
  onSave: (style: CameraButtonStyle | undefined) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState(style?.label || ""),
    [color, setColor] = useState(style?.color || ""),
    [icon, setIcon] = useState(style?.icon || "");
  useEffect(() => {
    ref.current?.showModal();
    input.current?.select();
  }, []);
  const look = cameraLook(index, { label, color, icon }, camera.name);
  return (
    <dialog ref={ref} className="camera-button-editor" onCancel={onClose}>
      <header>
        <h2>Camera button</h2>
        <button className="icon" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const next = {
            ...(label.trim() ? { label: label.trim() } : {}),
            ...(color ? { color } : {}),
            ...(icon ? { icon } : {}),
          };
          onSave(Object.keys(next).length ? next : undefined);
        }}
      >
        <div className="cam-editor-row">
          <span
            className="cam-button selected cam-editor-preview"
            style={{ "--cam": look.color } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className="cam-button-top">
              {look.Icon ? <look.Icon size={14} /> : <span />}
              <i className="cam-led" />
            </span>
            <strong>{look.label}</strong>
            <small>&nbsp;</small>
          </span>
          <label>
            Button label
            <input
              ref={input}
              maxLength={12}
              value={label}
              placeholder={defaultLabel(index, camera.name)}
              onChange={(e) => setLabel(e.target.value)}
            />
            <small>
              {camera.name} · {camera.model}
            </small>
          </label>
        </div>
        <fieldset className="cam-swatches">
          <legend>Color</legend>
          {cameraColors.map((c) => (
            <button
              type="button"
              key={c}
              aria-label={`Color ${c}`}
              aria-pressed={look.color === c}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <label className="cam-custom-color" title="Custom color">
            <input
              type="color"
              aria-label="Custom color"
              value={look.color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
        </fieldset>
        <fieldset className="cam-icons">
          <legend>Icon (optional)</legend>
          <button
            type="button"
            aria-pressed={!icon}
            onClick={() => setIcon("")}
          >
            None
          </button>
          {Object.entries(cameraIcons).map(([name, Icon]) => (
            <button
              type="button"
              key={name}
              aria-label={name}
              title={name}
              aria-pressed={icon === name}
              onClick={() => setIcon(name)}
            >
              <Icon size={16} />
            </button>
          ))}
        </fieldset>
        <div className="modal-footer">
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setLabel("");
              setColor("");
              setIcon("");
            }}
          >
            Reset to default
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function WorkspaceLayoutMenu({
  layout,
  onChange,
}: {
  layout: LayoutPreferences;
  onChange: (layout: LayoutPreferences) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!details.current?.contains(e.target as Node))
        details.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return (
    <details
      className="workspace-layout-menu"
      ref={details}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          details.current?.removeAttribute("open");
          details.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary title="Arrange the workspace">
        <PanelsTopLeft size={15} />
        <span>Layout</span>
      </summary>
      <div className="layout-popover">
        <span className="layout-label">Controls position</span>
        <div
          className="layout-choices"
          role="group"
          aria-label="Controls position"
        >
          <button
            aria-pressed={layout.controlsLeft}
            onClick={() => onChange({ ...layout, controlsLeft: true })}
          >
            <ArrowLeftRight size={14} />
            Left
          </button>
          <button
            aria-pressed={!layout.controlsLeft}
            onClick={() => onChange({ ...layout, controlsLeft: false })}
          >
            Right
          </button>
        </div>
        <label>
          <input
            type="checkbox"
            checked={layout.showCameras}
            onChange={(e) =>
              onChange({ ...layout, showCameras: e.target.checked })
            }
          />
          Show camera buttons
        </label>
      </div>
    </details>
  );
}

/** Move a stable portal host into the native dialog; the monitor and its lease stay mounted. */
export function PreviewPane({
  expanded,
  onExpanded,
  children,
  cameraName,
  title,
  actions,
  footer,
}: {
  expanded: boolean;
  onExpanded: (value: boolean) => void;
  children: React.ReactNode;
  cameraName: string;
  title: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const inlineHost = useRef<HTMLDivElement>(null),
    modalHost = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    button = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const [portalHost] = useState(() => {
    const node = document.createElement("div");
    node.className = "preview-portal-host";
    return node;
  });
  useLayoutEffect(() => {
    if (expanded) {
      modalHost.current!.appendChild(portalHost);
      if (!dialog.current!.open) dialog.current!.showModal();
      button.current?.focus();
    } else {
      if (dialog.current!.open) dialog.current!.close();
      inlineHost.current!.appendChild(portalHost);
      if (wasExpanded.current) button.current?.focus();
    }
    wasExpanded.current = expanded;
  }, [expanded, portalHost]);
  useEffect(() => () => portalHost.remove(), [portalHost]);
  const content = (
    <div className={`preview-pane ${expanded ? "expanded" : ""}`}>
      <div className="preview-heading">
        <div className="preview-title">{title}</div>
        <div className="preview-actions">
          {!expanded && actions}
          <button
            ref={button}
            className={expanded ? "quiet" : "icon"}
            onClick={() => onExpanded(!expanded)}
            aria-label={
              expanded ? "Return to controls" : "Expand camera preview"
            }
            title={
              expanded ? "Return to controls (Esc)" : "Expand camera preview"
            }
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={15} />}
            {expanded && <span>Return to controls</span>}
          </button>
        </div>
      </div>
      {children}
    </div>
  );
  return (
    <>
      <section className="preview-dock" aria-label="Camera preview">
        <div ref={inlineHost} className="preview-portal-host" />
        {footer}
      </section>
      <dialog
        ref={dialog}
        className="expanded-preview-dialog"
        aria-label={`${cameraName} expanded preview`}
        onCancel={(e) => {
          e.preventDefault();
          onExpanded(false);
        }}
      >
        <div ref={modalHost} className="preview-portal-host" />
      </dialog>
      {createPortal(content, portalHost)}
    </>
  );
}
