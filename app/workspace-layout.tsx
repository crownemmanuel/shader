import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  PanelsTopLeft,
  ArrowLeftRight,
  Maximize2,
  Minimize2,
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

export function CameraStrip({
  cameras,
  selected,
  onSelect,
  onAdd,
  inert,
}: {
  cameras: Camera[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  inert: boolean;
}) {
  const nav = useRef<HTMLElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const element = nav.current;
    if (!element) return;
    const update = () =>
      setEdges({
        left: element.scrollLeft > 1,
        right:
          element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [cameras.length]);
  useEffect(() => {
    selectedButton.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  }, [selected]);
  return (
    <div className="camera-strip" inert={inert}>
      <span className="camera-strip-label">
        Cameras <small>{cameras.length}</small>
      </span>
      <button
        className="icon strip-scroll"
        aria-label="Scroll cameras left"
        disabled={!edges.left}
        onClick={() =>
          nav.current?.scrollBy({ left: -320, behavior: "instant" })
        }
      >
        <ChevronLeft size={16} />
      </button>
      <nav ref={nav} aria-label="Cameras" className="camera-strip-items">
        {cameras.map((c, index) => (
          <button
            key={c.id}
            ref={c.id === selected ? selectedButton : undefined}
            aria-current={c.id === selected ? "true" : undefined}
            title={`${c.name} · ${c.model}`}
            className={`camera-chip ${c.id === selected ? "selected" : ""} ${c.tally === "program" ? "on-air" : ""}`}
            onClick={() => onSelect(c.id)}
          >
            <span className="camera-chip-number">{index + 1}</span>
            <span className="camera-chip-text">
              <strong>{c.name}</strong>
              <small>
                <span
                  className={`status-dot ${c.status === "connected" ? "online" : c.vendor === "demo" ? "demo" : ""}`}
                />
                {c.tally === "program"
                  ? "On Air"
                  : c.tally === "preview"
                    ? "Preview"
                    : c.vendor === "demo"
                      ? "Simulator"
                      : c.status !== "connected"
                        ? c.status
                        : c.vendor === "atem"
                          ? "Blackmagic / ATEM"
                          : c.vendor === "sony"
                            ? "Sony"
                            : c.vendor === "ptzoptics"
                              ? "PTZOptics"
                              : "Blackmagic"}
              </small>
            </span>
          </button>
        ))}
        {!cameras.length && (
          <span className="camera-strip-empty">Connect a camera to begin.</span>
        )}
      </nav>
      <button
        className="icon strip-scroll"
        aria-label="Scroll cameras right"
        disabled={!edges.right}
        onClick={() =>
          nav.current?.scrollBy({ left: 320, behavior: "instant" })
        }
      >
        <ChevronRight size={16} />
      </button>
      <button
        className="icon add-camera-chip"
        aria-label="Add camera"
        title="Add camera…"
        onClick={onAdd}
      >
        <Plus size={18} />
      </button>
    </div>
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
        <PanelsTopLeft size={16} />
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
          Show camera strip
        </label>
        <p>The preview stays visible while controls scroll.</p>
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
}: {
  expanded: boolean;
  onExpanded: (value: boolean) => void;
  children: React.ReactNode;
  cameraName: string;
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
        <span>{expanded ? cameraName : "Live picture"}</span>
        <button
          ref={button}
          className="quiet"
          onClick={() => onExpanded(!expanded)}
          aria-label={expanded ? "Return to controls" : "Expand camera preview"}
          title={
            expanded ? "Return to controls (Esc)" : "Expand camera preview"
          }
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          <span>{expanded ? "Return to controls" : "Expand"}</span>
        </button>
      </div>
      {children}
    </div>
  );
  return (
    <>
      <section className="preview-dock" aria-label="Camera preview">
        <div ref={inlineHost} className="preview-portal-host" />
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
