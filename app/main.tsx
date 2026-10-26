/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Camera as CameraIcon,
  Plus,
  Radio,
  Settings,
  RefreshCw,
  ChevronRight,
  SlidersHorizontal,
  MessageSquare,
  ArrowUp,
  Lock,
  Unlock,
  Scan,
  Image as ImageIcon,
  X,
  Network,
  Terminal,
  Check,
  Square,
  ArrowLeft,
  ArrowRight,
  ArrowDown,
  Plug,
  Activity,
  Video,
  Info,
  Bookmark,
  Lightbulb,
} from "lucide-react";
import type {
  Camera,
  Control,
  CaptureSource,
  Frame,
  Discovery,
  Audit,
} from "../engine/types";
import { command } from "./api";
import "./style.css";
import {
  LiveMonitor,
  SimpleControls,
  AxisEditor,
  ColorWheel,
} from "./visual-controls";
import { RoutingSettings } from "./routing-settings";
import { axes } from "../engine/shading";
import { PresetLibrary } from "./preset-library";
import { LightingPanel } from "./lighting-panel";
type Cam = Camera & { writeAccess: number; allowLive: boolean };
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <header>
        <h2>{title}</h2>
        <button className="icon" aria-label="Close dialog" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
function App() {
  const [cameras, setCameras] = useState<Cam[]>([]),
    [selected, setSelected] = useState(""),
    [status, setStatus] = useState<any>(),
    [engineError, setEngineError] = useState(""),
    [notice, setNotice] = useState(""),
    [modal, setModal] = useState<
      | "connect"
      | "settings"
      | "capture"
      | "activity"
      | "presets"
      | "lighting"
      | null
    >(null),
    [busy, setBusy] = useState(""),
    [group, setGroup] = useState("Color"),
    [mode, setMode] = useState<"simple" | "advanced">("simple"),
    [showAssistant, setShowAssistant] = useState(false),
    [frames, setFrames] = useState<Record<string, Frame>>({}),
    [candidates, setCandidates] = useState<Discovery[]>([]);
  const camera = cameras.find((c) => c.id === selected),
    frame =
      frames[selected]?.sourceId === camera?.sourceId
        ? frames[selected]
        : undefined;
  const refresh = async () => {
    try {
      const data = await command("system_status");
      setStatus(data);
      setCameras(data.cameras);
      setCandidates(data.discovered || []);
      setSelected((s) =>
        data.cameras.some((c: Cam) => c.id === s)
          ? s
          : data.cameras[0]?.id || "",
      );
      setEngineError("");
    } catch (e) {
      setEngineError(String(e instanceof Error ? e.message : e));
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 9000);
    return () => clearTimeout(t);
  }, [notice]);
  async function perform(name: string, args: unknown = {}, success?: string) {
    setBusy(name);
    try {
      const result = await command(name, args);
      if (success) setNotice(success);
      await refresh();
      return result;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy("");
    }
  }
  const safe = (p: Promise<unknown>) => void p.catch(() => {});
  async function discover() {
    const result = await perform("cameras_discover");
    setCandidates(result.candidates);
    setNotice(
      result.connected.length
        ? `Found ${result.connected.length} camera endpoint(s).`
        : result.errors.length
          ? "No verified camera connection yet. Check the production network or add an address."
          : "No cameras advertised on this network. Add an address to connect.",
    );
  }
  async function capture() {
    if (!camera) return;
    const result = await perform(
      "capture_frame",
      { cameraId: camera.id },
      "Frame captured for this camera. Available to the assistant.",
    );
    setFrames((f) => ({ ...f, [camera.id]: result }));
  }
  const connected = cameras.filter((c) => c.status === "connected").length;
  return (
    <div className="app-shell">
      <header className="app-toolbar">
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>Shader</strong>
          <span className="version">Studio</span>
        </div>
        <div className="toolbar-center">
          <span className={`status-dot ${status ? "online" : ""}`} />
          {status ? "Camera engine connected" : "Starting camera engine"}
        </div>
        <div className="toolbar-actions">
          <button onClick={() => setModal("presets")}>
            <Bookmark size={15} />
            Presets
          </button>
          <button onClick={() => setModal("lighting")}>
            <Lightbulb size={15} />
            Lighting
            {status?.lighting?.listening && (
              <span className="status-dot online" />
            )}
          </button>
          <button onClick={() => safe(discover())} disabled={!!busy}>
            <RefreshCw
              size={15}
              className={busy === "cameras_discover" ? "spin" : ""}
            />
            Discover
          </button>
          <button
            className={showAssistant ? "icon active" : "icon"}
            aria-label="Toggle assistant"
            onClick={() => setShowAssistant(!showAssistant)}
          >
            <MessageSquare size={18} />
          </button>
          <button
            className="icon"
            aria-label="Settings"
            onClick={() => setModal("settings")}
          >
            <Settings size={18} />
          </button>
        </div>
      </header>
      <div className={`workspace ${showAssistant ? "with-assistant" : ""}`}>
        <aside className="camera-sidebar">
          <div className="pane-heading">
            <h2>Cameras</h2>
            <button
              className="icon"
              aria-label="Add camera"
              onClick={() => setModal("connect")}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="camera-summary">
            {connected} connected <span>/ {cameras.length} endpoints</span>
          </div>
          <nav aria-label="Cameras">
            {cameras.map((c, index) => (
              <button
                key={c.id}
                className={`camera-item ${c.id === selected ? "selected" : ""} ${c.tally === "program" ? "camera-on-air" : ""}`}
                onClick={() => setSelected(c.id)}
              >
                <span className="camera-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="camera-item-text">
                  <strong>{c.name}</strong>
                  <small>
                    {c.tally === "program"
                      ? "● On Air"
                      : c.tally === "preview"
                        ? "● Preview"
                        : c.vendor === "demo"
                          ? "Simulation"
                          : c.vendor === "atem"
                            ? "Blackmagic / ATEM"
                            : c.vendor === "ptzoptics"
                              ? "PTZOptics"
                              : c.vendor === "sony"
                                ? "Sony"
                                : "Blackmagic"}
                  </small>
                </span>
                <span
                  className={`status-dot ${c.status === "connected" ? "online" : c.status === "demo" ? "demo" : ""}`}
                />
              </button>
            ))}
          </nav>
          {!cameras.length && (
            <div className="sidebar-empty">
              <CameraIcon size={24} />
              <p>
                Your camera lineup
                <br />
                will appear here.
              </p>
            </div>
          )}
          <button className="add-camera" onClick={() => setModal("connect")}>
            <Plus size={16} />
            Add camera
          </button>
          <div className="sidebar-bottom">
            <div className="connection-note">
              <Network size={17} />
              <span>
                Production network<small>Automatic discovery on startup</small>
              </span>
            </div>
            <button className="quiet" onClick={() => setModal("activity")}>
              <Activity size={15} />
              Activity log
            </button>
            <div className="mcp-note">
              <Terminal size={14} />
              <span>{status ? "MCP available" : "MCP waiting for engine"}</span>
              <span className={`status-dot ${status ? "online" : ""}`} />
            </div>
          </div>
        </aside>
        <main className="console">
          {engineError && (
            <div className="banner error" role="alert">
              {engineError}
            </div>
          )}
          {camera ? (
            <>
              <div className="camera-heading">
                <div>
                  <div className="breadcrumb">
                    Camera control <ChevronRight size={13} />
                    {camera.vendor === "demo" ? "Simulator" : camera.model}
                  </div>
                  <h1>
                    {camera.name}
                    <span
                      className={`state-label ${camera.tally === "program" ? "program" : ""}`}
                    >
                      {camera.status === "demo"
                        ? "Demo camera"
                        : camera.tally === "program"
                          ? "On Air"
                          : camera.tally === "preview"
                            ? "Preview"
                            : camera.tally === "unknown"
                              ? "Tally unknown"
                              : camera.status}
                    </span>
                  </h1>
                </div>
                <button
                  className="quiet"
                  onClick={() =>
                    safe(
                      perform(
                        "camera_get",
                        { cameraId: camera.id, refresh: true },
                        "Camera state refreshed",
                      ),
                    )
                  }
                  disabled={!!busy}
                >
                  <RefreshCw size={15} />
                  Read camera
                </button>
              </div>
              <LiveMonitor
                key={`preview:${camera.id}`}
                camera={camera}
                onAssign={() => setModal("settings")}
              />
              <div className="monitor-controls">
                <button className="quiet" onClick={() => setModal("settings")}>
                  <Video size={15} />
                  {camera.sourceId || "No capture input"}
                  <ChevronRight size={13} />
                </button>
                <button
                  disabled={!camera.sourceId || !!busy}
                  onClick={() => safe(capture())}
                >
                  <Scan size={15} />
                  {busy === "capture_frame" ? "Capturing…" : "Capture frame"}
                </button>
              </div>
              <div className="mode-bar">
                <div
                  className="view-switch"
                  role="group"
                  aria-label="Control view"
                >
                  <button
                    aria-pressed={mode === "simple"}
                    className={mode === "simple" ? "selected" : ""}
                    onClick={() => setMode("simple")}
                  >
                    Simple
                  </button>
                  <button
                    aria-pressed={mode === "advanced"}
                    className={mode === "advanced" ? "selected" : ""}
                    onClick={() => setMode("advanced")}
                  >
                    Advanced
                  </button>
                </div>
                <span>
                  {mode === "simple"
                    ? "A better picture, one adjustment at a time."
                    : "Manual control · release, then apply to camera"}
                </span>
              </div>
              {mode === "advanced" && (
                <div className="controls-heading">
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Control groups"
                  >
                    {[
                      "Color",
                      "Exposure",
                      "Lens",
                      "Image",
                      "Vendor",
                      "All",
                    ].map((g) => (
                      <button
                        key={g}
                        role="tab"
                        aria-selected={group === g}
                        className={group === g ? "active" : ""}
                        onClick={() => setGroup(g)}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <span className="control-count">
                    {camera.controls.length} controls
                  </span>
                </div>
              )}
              <div className="write-bar">
                <span>
                  <span
                    className={`status-dot ${camera.writeAccess > Date.now() || camera.vendor === "demo" ? "online" : ""}`}
                  />
                  {camera.vendor === "demo"
                    ? "Simulation controls active"
                    : camera.writeAccess > Date.now()
                      ? `Writes enabled · ${Math.ceil((camera.writeAccess - Date.now()) / 1000)}s remaining`
                      : "Camera writes locked"}
                </span>
                {camera.vendor !== "demo" && (
                  <button
                    className="quiet"
                    onClick={() =>
                      safe(
                        perform(
                          camera.writeAccess > Date.now()
                            ? "camera_lock"
                            : "camera_arm",
                          {
                            cameraId: camera.id,
                            ...(camera.writeAccess > Date.now()
                              ? {}
                              : { seconds: 60, allowLive: true }),
                          },
                        ),
                      )
                    }
                  >
                    {camera.writeAccess > Date.now() ? (
                      <Lock size={14} />
                    ) : (
                      <Unlock size={14} />
                    )}{" "}
                    {camera.writeAccess > Date.now()
                      ? "Lock"
                      : "Enable writes for 60s"}
                  </button>
                )}
              </div>
              {camera.vendor !== "demo" &&
                camera.writeAccess > Date.now() &&
                camera.tally !== "off" && (
                  <p className="live-note">
                    Writes can affect the live output. Tally: {camera.tally}.
                  </p>
                )}
              {mode === "simple" ? (
                <SimpleControls
                  key={`simple:${camera.id}`}
                  camera={camera}
                  disabled={
                    !!busy ||
                    (camera.vendor !== "demo" &&
                      camera.writeAccess < Date.now())
                  }
                  perform={perform}
                  advanced={() => {
                    setMode("advanced");
                    setGroup("Exposure");
                  }}
                />
              ) : (
                <section className="controls-grid">
                  {camera.controls
                    .filter(
                      (c) =>
                        group === "All" ||
                        c.group === group ||
                        (group === "Color" &&
                          axes(camera).some(
                            (a) =>
                              a.controlId === c.id &&
                              ["warmth", "tint"].includes(a.kind),
                          )) ||
                        (group === "Exposure" &&
                          axes(camera).some(
                            (a) =>
                              a.controlId === c.id &&
                              ["iris", "shutter", "gain", "iso"].includes(
                                a.kind,
                              ),
                          )),
                    )
                    .sort((a, b) =>
                      group === "Color"
                        ? Number(b.components?.[0] === "Red") -
                          Number(a.components?.[0] === "Red")
                        : 0,
                    )
                    .flatMap((c) => {
                      const disabled =
                        !!busy ||
                        (camera.vendor !== "demo" &&
                          camera.writeAccess < Date.now()) ||
                        !c.writable;
                      const onSet = (
                        value: unknown,
                        expectedRevision: number,
                      ) =>
                        perform("control_set", {
                          cameraId: camera.id,
                          controlId: c.id,
                          value,
                          expectedRevision,
                        });
                      const visual = axes(camera).filter(
                        (a) => a.controlId === c.id,
                      );
                      if (visual.length)
                        return visual.map((a) => (
                          <AxisEditor
                            key={`${camera.id}:${a.id}`}
                            axis={a}
                            control={c}
                            revision={camera.revision}
                            disabled={disabled || !a.writable}
                            onSet={onSet}
                          />
                        ));
                      if (
                        c.type === "vector" &&
                        c.components?.join(",") === "Red,Green,Blue,Master" &&
                        Array.isArray(c.value) &&
                        (camera.vendor === "demo" || camera.vendor === "atem")
                      )
                        return (
                          <ColorWheel
                            key={`${camera.id}:${c.id}`}
                            control={c}
                            revision={camera.revision}
                            disabled={disabled}
                            onSet={onSet}
                          />
                        );
                      return (
                        <ControlEditor
                          key={`${camera.id}:${c.id}`}
                          control={c}
                          revision={camera.revision}
                          disabled={disabled}
                          onSet={onSet}
                        />
                      );
                    })}
                  {group === "Exposure" &&
                    !axes(camera).some((a) => a.kind === "shutter") && (
                      <div className="control">
                        <h3>Shutter speed</h3>
                        <p className="helper">
                          No supported shutter-speed value reported. Check the
                          camera’s manual exposure mode. Native shutter
                          controls, when reported, remain available under All.
                        </p>
                      </div>
                    )}
                  {!camera.controls.some(
                    (c) => group === "All" || c.group === group,
                  ) && (
                    <p className="controls-empty">
                      No {group.toLowerCase()} controls reported.{" "}
                      <button onClick={() => setGroup("All")}>
                        View all controls
                      </button>
                    </p>
                  )}
                </section>
              )}
              {camera.vendor === "ptzoptics" && (
                <div className="ptz-controls">
                  <span>
                    Pan / tilt <small>250 ms pulse</small>
                  </span>
                  {[
                    [-8, 0, ArrowLeft],
                    [0, -8, ArrowUp],
                    [0, 8, ArrowDown],
                    [8, 0, ArrowRight],
                  ].map(([pan, tilt, Icon], i) => {
                    const C = Icon as typeof ArrowUp;
                    return (
                      <button
                        className="icon"
                        key={i}
                        disabled={!!busy || camera.writeAccess < Date.now()}
                        aria-label={
                          ["Pan left", "Tilt up", "Tilt down", "Pan right"][i]
                        }
                        onClick={() =>
                          safe(
                            perform("ptz_move", {
                              cameraId: camera.id,
                              pan,
                              tilt,
                              durationMs: 250,
                            }),
                          )
                        }
                      >
                        <C size={17} />
                      </button>
                    );
                  })}
                  <button
                    onClick={() =>
                      safe(perform("ptz_stop", { cameraId: camera.id }))
                    }
                  >
                    <Square size={13} />
                    Stop
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-workspace">
              <div className="empty-camera-icon">
                <CameraIcon size={42} strokeWidth={1.3} />
                <span className="small-plus">+</span>
              </div>
              <h1>
                Your cameras.
                <br />
                One control surface.
              </h1>
              <p>
                Connect Blackmagic, Sony, and PTZOptics cameras.
                <br />
                Shade with the controls, or work alongside an agent.
              </p>
              <div className="empty-actions">
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() => safe(discover())}
                >
                  <Radio size={17} />
                  {busy === "cameras_discover"
                    ? "Looking for cameras…"
                    : "Discover cameras"}
                </button>
                <button onClick={() => setModal("connect")}>
                  <Plus size={17} />
                  Connect by address
                </button>
              </div>
              <div className="setup-info">
                <Network size={17} />
                <span>
                  Join the same network as your cameras.
                  <br />
                  <small>Known setup: ATEM 2 M/E Production Studio 4K</small>
                </span>
              </div>
              <button
                className="quiet demo-button"
                onClick={() =>
                  safe(
                    perform("camera_connect", {
                      vendor: "demo",
                      host: "local",
                    }),
                  )
                }
              >
                Explore with a simulated camera <ChevronRight size={14} />
              </button>
            </div>
          )}
        </main>
        {showAssistant && (
          <Assistant
            key={camera?.id}
            camera={camera}
            frame={frame}
            onSettings={() => setModal("settings")}
            provider={status?.provider}
            onChange={refresh}
            onError={setNotice}
          />
        )}
      </div>
      <footer className="statusbar">
        <span>
          <span className={`status-dot ${status ? "online" : ""}`} />
          {status ? "Engine ready" : "Connecting"}
          <i />
          {connected} hardware cameras
        </span>
        <span>
          {camera?.address || "No camera selected"}
          <i />
          Shader 0.1
        </span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Info size={17} />
          <span>{notice}</span>
          <button
            className="icon"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {modal === "connect" && (
        <ConnectModal
          close={() => setModal(null)}
          candidates={candidates}
          perform={perform}
          busy={!!busy}
        />
      )}
      {modal === "settings" && (
        <SettingsModal
          close={() => setModal(null)}
          status={status}
          perform={perform}
          onLighting={() => setModal("lighting")}
        />
      )}
      {modal === "presets" && (
        <Modal title="Camera looks & scenes" close={() => setModal(null)}>
          <PresetLibrary
            cameras={cameras}
            selected={selected}
            jobs={status?.presetJobs || []}
            perform={perform}
          />
        </Modal>
      )}
      {modal === "lighting" && (
        <Modal title="StageLight · Look Link" close={() => setModal(null)}>
          <LightingPanel
            state={status?.lighting}
            presets={status?.presets || []}
            perform={perform}
          />
        </Modal>
      )}
      {modal === "capture" && (
        <CaptureModal
          close={() => setModal(null)}
          camera={camera}
          perform={perform}
        />
      )}
      {modal === "activity" && (
        <Modal title="Activity log" close={() => setModal(null)}>
          <div className="activity-list">
            {status?.audit?.length ? (
              status.audit.map((a: Audit) => (
                <div key={a.id} className="activity-row">
                  <span
                    className={a.status === "error" ? "error-text" : "muted"}
                  >
                    {a.status === "ok" ? <Check size={15} /> : <X size={15} />}
                  </span>
                  <div>
                    <strong>{a.operation.replaceAll("_", " ")}</strong>
                    <p>{a.detail}</p>
                    <small>
                      {a.actor} · {new Date(a.at).toLocaleTimeString()}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">Camera actions will appear here.</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function ControlEditor({
  control: c,
  revision,
  disabled,
  onSet,
}: {
  control: Control;
  revision: number;
  disabled: boolean;
  onSet: (value: unknown, revision: number) => Promise<unknown>;
}) {
  const [baseRevision, setBaseRevision] = useState<number>(),
    [draft, setDraft] = useState<any>(c.value),
    [text, setText] = useState(JSON.stringify(c.value ?? {}, null, 2)),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!dirty) {
      setDraft(c.value);
      setText(JSON.stringify(c.value ?? {}, null, 2));
    }
  }, [JSON.stringify(c.value), dirty]);
  const set = (v: any) => {
    if (!dirty) setBaseRevision(revision);
    setDraft(v);
    setDirty(true);
  };
  async function apply() {
    try {
      await onSet(
        c.type === "json"
          ? JSON.parse(text)
          : c.type === "action"
            ? true
            : draft,
        baseRevision ?? revision,
      );
      setDirty(false);
      setBaseRevision(undefined);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const numeric = (
    v: number | undefined,
    change: (v: number) => void,
    label: string,
  ) => (
    <div className="numeric">
      <input
        aria-label={label}
        type="number"
        value={v ?? ""}
        min={c.min}
        max={c.max}
        step={c.step || "any"}
        disabled={disabled}
        placeholder="Unknown"
        onChange={(e) => change(e.target.valueAsNumber)}
      />
      {c.unit && <span>{c.unit}</span>}
    </div>
  );
  return (
    <div
      className={`control ${c.type === "vector" ? "vector-control" : ""} ${c.type === "json" ? "json-control" : ""}`}
    >
      <div className="control-title">
        <label>{c.label}</label>
        <span className={`freshness ${c.freshness}`}>
          {c.freshness === "reported"
            ? "Read back"
            : c.freshness === "requested"
              ? "Sent"
              : c.freshness === "simulated"
                ? "Demo"
                : "Unknown"}
        </span>
      </div>
      {c.type === "vector" ? (
        <div className="vector-fields">
          {c.components?.map((component, i) => (
            <div key={component}>
              <span
                className={["red", "green", "blue", "master"][i] || "master"}
              >
                {component}
              </span>
              {numeric(
                draft?.[i],
                (v) => {
                  const next = [...(draft || c.components?.map(() => 0) || [])];
                  next[i] = v;
                  set(next);
                },
                `${c.label} ${component}`,
              )}
            </div>
          ))}
        </div>
      ) : c.type === "number" ? (
        numeric(draft, (v) => set(v), c.label)
      ) : c.type === "enum" ? (
        <select
          aria-label={c.label}
          value={draft ?? ""}
          disabled={disabled}
          onChange={(e) =>
            set(
              c.options?.find((o) => String(o.value) === e.target.value)?.value,
            )
          }
        >
          <option value="" disabled>
            Unknown
          </option>
          {c.options?.map((o) => (
            <option key={String(o.value)} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : c.type === "boolean" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft === true}
            disabled={disabled}
            onChange={(e) => set(e.target.checked)}
          />
          Enabled
        </label>
      ) : c.type === "string" ? (
        <input
          aria-label={c.label}
          value={draft || ""}
          disabled={disabled}
          onChange={(e) => set(e.target.value)}
        />
      ) : c.type === "json" ? (
        <textarea
          aria-label={c.label}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            if (!dirty) setBaseRevision(revision);
            setText(e.target.value);
            setDirty(true);
          }}
          rows={4}
        />
      ) : null}
      {c.note && <p className="control-note">{c.note}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="control-bottom">
        <small>{c.id}</small>
        {dirty && (
          <button
            className="quiet apply"
            onClick={() => {
              setDirty(false);
              setBaseRevision(undefined);
              setError("");
            }}
          >
            Revert
          </button>
        )}
        {c.writable && (
          <button
            className={dirty ? "apply dirty" : "apply"}
            disabled={disabled || (!dirty && c.type !== "action")}
            onClick={() => void apply()}
          >
            {c.type === "action" ? "Run" : dirty ? "Apply change" : "Apply"}
          </button>
        )}
      </div>
    </div>
  );
}
function ConnectModal({
  close,
  candidates,
  perform,
  busy,
}: {
  close: () => void;
  candidates: Discovery[];
  perform: Function;
  busy: boolean;
}) {
  const [vendor, setVendor] = useState("atem"),
    [host, setHost] = useState("172.16.10.10"),
    [name, setName] = useState(""),
    [profile, setProfile] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [fingerprint, setFingerprint] = useState(""),
    [error, setError] = useState("");
  return (
    <Modal title="Connect a camera" close={close}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await perform("camera_connect", {
              vendor,
              host,
              ...(name ? { name } : {}),
              ...(profile ? { profile } : {}),
              ...(username || password
                ? { username: username || "admin", password }
                : {}),
              ...(fingerprint ? { fingerprint } : {}),
            });
            close();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        {candidates.length > 0 && (
          <div className="discovered-list">
            <h3>Discovered on the network</h3>
            {candidates.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => {
                  setHost(c.address);
                  setVendor(c.vendor === "unknown" ? "ptzoptics" : c.vendor);
                  setName(c.name);
                }}
              >
                <Radio size={15} />
                {c.name}
                <small>{c.address}</small>
              </button>
            ))}
          </div>
        )}
        <label>
          Camera connection
          <select
            value={vendor}
            onChange={(e) => {
              setVendor(e.target.value);
              setProfile("");
            }}
          >
            <option value="atem">Blackmagic through ATEM</option>
            <option value="blackmagic-rest">Blackmagic camera REST API</option>
            <option value="ptzoptics">PTZOptics</option>
            <option value="sony">Sony Camera Remote SDK</option>
          </select>
        </label>
        <div className="form-row">
          <label>
            IP address or hostname
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
              placeholder="192.168.1.100"
            />
          </label>
          <label>
            Camera name <small>optional</small>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Stage left"
            />
          </label>
        </div>
        {vendor === "ptzoptics" && (
          <label>
            Protocol
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="">VISCA over TCP · port 5678</option>
              <option value="http">HTTP CGI · newer camera models</option>
            </select>
          </label>
        )}
        {vendor === "blackmagic-rest" && (
          <label>
            Connection
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="">HTTP</option>
              <option value="https">
                HTTPS · trusted certificate required
              </option>
            </select>
          </label>
        )}
        {(profile === "http" ||
          vendor === "blackmagic-rest" ||
          vendor === "sony") && (
          <div className="form-row">
            <label>
              Username
              <input
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
        )}
        {vendor === "sony" && (
          <label>
            SSH fingerprint <small>if requested on connection</small>
            <input
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
              placeholder="Verified fingerprint for this camera"
            />
          </label>
        )}
        <p className="form-note">
          {vendor === "atem"
            ? "The switcher supplies camera IDs and control state. Cameras need compatible SDI/HDMI return control routing."
            : vendor === "sony"
              ? "Enable PC Remote on the Sony camera. The native SDK discovers its model and available Wi-Fi controls. SSH models may require credentials and fingerprint confirmation."
              : vendor === "ptzoptics"
                ? "VISCA probes the controls your camera answers. HTTP support varies by model and firmware."
                : "Enable the camera’s Web Media Manager. Supported controls are read from the camera."}
        </p>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-footer">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Connecting…" : "Connect camera"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SettingsModal({
  close,
  status,
  perform,
  onLighting,
}: {
  close: () => void;
  status: any;
  perform: Function;
  onLighting: () => void;
}) {
  const [provider, setProvider] = useState(
      status?.provider?.provider || "openai",
    ),
    [model, setModel] = useState(status?.provider?.model || ""),
    [baseUrl, setBaseUrl] = useState(status?.provider?.baseUrl || ""),
    [key, setKey] = useState(""),
    [vision, setVision] = useState(status?.provider?.vision || false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="Settings" close={close}>
      <div className="form">
        <RoutingSettings status={status} perform={perform} />
        <div className="settings-intro">
          <Lightbulb size={21} />
          <div>
            <h3>StageLight connection</h3>
            <p>Lighting reports, camera looks and cue-triggered scenes.</p>
          </div>
          <button onClick={onLighting}>Configure lighting link</button>
        </div>
        <div className="settings-intro">
          <MessageSquare size={21} />
          <div>
            <h3>Camera assistant</h3>
            <p>Choose the model that works alongside you.</p>
          </div>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await perform("provider_configure", {
                provider,
                model,
                vision,
                ...(provider === "compatible" ? { baseUrl } : {}),
                ...(key ? { apiKey: key } : {}),
              });
              setKey("");
              setSaved(true);
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <div className="form-row">
            <label>
              Provider
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setSaved(false);
                  setKey("");
                }}
              >
                <option value="openai">OpenAI · GPT</option>
                <option value="anthropic">Anthropic · Claude</option>
                <option value="groq">Groq</option>
                <option value="compatible">OpenAI-compatible endpoint</option>
              </select>
            </label>
            <label>
              Model ID
              <input
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setSaved(false);
                }}
                placeholder="Enter a model you have access to"
                required
              />
            </label>
          </div>
          {provider === "compatible" && (
            <label>
              Base URL
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:1234/v1"
                required
              />
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setSaved(false);
              }}
              placeholder={
                status?.provider?.configured
                  ? "Key configured for this session"
                  : "Add a key when ready"
              }
            />
          </label>
          <p className="form-note">
            Keys stay in engine memory for this session. Provider and model
            choices are saved. No key is sent to the camera or returned through
            MCP.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={vision}
              onChange={(e) => setVision(e.target.checked)}
            />
            This model supports image input
          </label>
          <p className="form-note">
            Frames are sent only when you select “Share camera frames” in the
            assistant.
          </p>
          {error && <p className="error-text">{error}</p>}
          <button className="primary">
            {saved ? (
              <>
                <Check size={15} />
                Saved
              </>
            ) : (
              "Save assistant settings"
            )}
          </button>
        </form>
        <div className="settings-section">
          <Terminal size={20} />
          <div>
            <h3>Connect an external agent</h3>
            <p>
              Use this stdio MCP configuration while Shader is running. The
              agent uses the same camera state, controls, locks, and frame
              capture.
            </p>
            <pre>
              {JSON.stringify(
                status?.mcpConfig || {
                  mcpServers: {
                    shader: { command: "shader-engine", args: ["--mcp"] },
                  },
                },
                null,
                2,
              )}
            </pre>
          </div>
        </div>
        <div className="settings-section">
          <Plug size={20} />
          <div>
            <h3>Integration status</h3>
            {Object.entries(status?.integrations || {}).map(([k, v]) => (
              <p key={k}>
                <strong>{k}</strong>
                <br />
                {String(v)}
              </p>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
function CaptureModal({
  close,
  camera,
  perform,
}: {
  close: () => void;
  camera: Cam | undefined;
  perform: Function;
}) {
  const [sources, setSources] = useState<CaptureSource[]>([]),
    [selected, setSelected] = useState(camera?.sourceId || ""),
    [diagnostics, setDiagnostics] = useState<string[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const scan = async () => {
    setLoading(true);
    try {
      const result = await perform("capture_sources");
      setSources(result.sources);
      setDiagnostics(result.diagnostics);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal title="Assign capture input" close={close}>
      <div className="form">
        <p className="form-note">
          Choose the SDI capture device or video input carrying{" "}
          <strong>{camera?.name || "the camera"}</strong>. Shader does not
          change your switcher routing.
        </p>
        <button onClick={() => void scan()} disabled={loading}>
          <RefreshCw size={15} />
          {loading ? "Looking for inputs…" : "Find capture devices"}
        </button>
        {sources.map((s) => (
          <label className="source-choice" key={s.id}>
            <input
              type="radio"
              name="capture-source"
              value={s.id}
              checked={selected === s.id}
              onChange={() => setSelected(s.id)}
            />
            <Video size={20} />
            <span>
              {s.name}
              <small>{s.kind}</small>
            </span>
          </label>
        ))}
        {diagnostics.map((d) => (
          <p className="form-note" key={d}>
            {d}
          </p>
        ))}
        {error && <p className="error-text">{error}</p>}
        <details>
          <summary>Register a DeckLink input manually</summary>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                device = String(f.get("device")),
                format = String(f.get("format"));
              try {
                const source = await perform("capture_register", {
                  id: `decklink:${device}`,
                  name: device,
                  kind: "decklink",
                  device,
                  ...(format ? { format } : {}),
                });
                setSources((s) => [
                  ...s.filter((x) => x.id !== source.id),
                  source,
                ]);
                setSelected(source.id);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <label>
              Device name
              <input
                name="device"
                placeholder="DeckLink Mini Recorder"
                required
              />
            </label>
            <label>
              Format code <small>optional</small>
              <input name="format" placeholder="Hp30" />
            </label>
            <button>Register input</button>
          </form>
        </details>
        <div className="modal-footer">
          <button onClick={close}>Cancel</button>
          <button
            className="primary"
            disabled={!camera || !selected}
            onClick={async () => {
              try {
                await perform("capture_assign", {
                  cameraId: camera!.id,
                  sourceId: selected,
                });
                close();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Assign to camera
          </button>
        </div>
      </div>
    </Modal>
  );
}
function Assistant({
  camera,
  frame,
  onSettings,
  provider,
  onChange,
  onError,
}: {
  camera: Cam | undefined;
  frame: Frame | undefined;
  onSettings: () => void;
  provider: any;
  onChange: () => Promise<void>;
  onError: (s: string) => void;
}) {
  const [message, setMessage] = useState(""),
    [history, setHistory] = useState<
      { role: "user" | "assistant"; content: string }[]
    >([]),
    [share, setShare] = useState(false),
    [writes, setWrites] = useState(false),
    [busy, setBusy] = useState(false),
    [trace, setTrace] = useState<any[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setHistory([]);
    setTrace([]);
    setWrites(false);
    setShare(false);
  }, [camera?.id]);
  useEffect(
    () => bottom.current?.scrollIntoView({ block: "nearest" }),
    [history, busy],
  );
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!camera || !message.trim() || busy) return;
    const text = message;
    setMessage("");
    setHistory((h) => [...h, { role: "user", content: text }]);
    setBusy(true);
    try {
      const response = await command("assistant_chat", {
        cameraId: camera.id,
        message: text,
        history: history.slice(-20),
        shareFrames: share,
        allowWrites: writes,
        ...(share && frame ? { frameId: frame.id } : {}),
      });
      setHistory((h) => [...h, { role: "assistant", content: response.text }]);
      setTrace(response.trace);
      await onChange();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setHistory((h) => [...h, { role: "assistant", content: error }]);
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="assistant">
      <div className="pane-heading">
        <h2>
          <MessageSquare size={16} />
          Assistant
        </h2>
        <button
          className="icon"
          aria-label="Assistant settings"
          onClick={onSettings}
        >
          <Settings size={16} />
        </button>
      </div>
      <div className="assistant-context">
        <span className="status-dot" />
        {camera ? `Working with ${camera.name}` : "Choose a camera to begin"}
      </div>
      <div className="conversation">
        {!history.length && (
          <div className="assistant-welcome">
            <div className="assistant-symbol">
              <SlidersHorizontal size={23} />
            </div>
            <h3>A second pair of eyes.</h3>
            <p>
              Inspect a frame, compare camera settings, and make a considered
              adjustment.
            </p>
            <button
              className="suggestion"
              onClick={() =>
                setMessage(
                  "Read this camera’s available controls and explain which color adjustments are supported.",
                )
              }
            >
              <span>What can I control?</span>
              <ChevronRight size={14} />
            </button>
            <button
              className="suggestion"
              onClick={() => {
                setMessage(
                  "Inspect the attached camera frame and recommend a small white balance correction. Read the current settings first.",
                );
              }}
            >
              <span>Help me balance this camera</span>
              <ChevronRight size={14} />
            </button>
            <button
              className="suggestion"
              onClick={() =>
                setMessage(
                  "Read the current StageLight lighting context and this camera's controls. Explain whether a correction is appropriate, preserving intentional color and holding for preview, blackout, test or stale data. If frame sharing is enabled, capture a fresh camera frame. After an approved correction, save this camera's look as a preset with its lighting context.",
                )
              }
            >
              <span>Match the current stage lighting</span>
              <ChevronRight size={14} />
            </button>
            <div className="assistant-explanation">
              <Lock size={14} />
              <p>
                You choose when the assistant can change a camera or share its
                frames.
              </p>
            </div>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`chat-message ${m.role}`}>
            <small>{m.role === "user" ? "You" : "Shader"}</small>
            <p>{m.content}</p>
          </div>
        ))}
        {busy && <p className="thinking">Inspecting camera context…</p>}
        {trace.length > 0 && (
          <details className="tool-trace">
            <summary>{trace.length} camera tool calls</summary>
            {trace.map((t, i) => (
              <p key={i}>
                {t.ok ? "✓" : "×"} {t.name} <small>{t.detail}</small>
              </p>
            ))}
          </details>
        )}
        <div ref={bottom} />
      </div>
      <form className="chat-composer" onSubmit={send}>
        {share && frame && (
          <div className="attached-frame">
            <ImageIcon size={14} />
            Frame at {new Date(frame.capturedAt).toLocaleTimeString()}
          </div>
        )}
        <textarea
          aria-label="Message camera assistant"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            provider?.model
              ? "Ask about this camera…"
              : "Configure a model in Settings…"
          }
          disabled={!camera || busy}
          rows={3}
        />
        <div className="composer-options">
          <label>
            <input
              type="checkbox"
              checked={share}
              disabled={!camera || busy}
              onChange={(e) => setShare(e.target.checked)}
            />
            Share camera frames
          </label>
          <label>
            <input
              type="checkbox"
              checked={writes}
              disabled={!camera || busy}
              onChange={(e) => setWrites(e.target.checked)}
            />
            Allow camera changes
          </label>
        </div>
        <div className="composer-bottom">
          <button
            type="button"
            className="quiet model-label"
            onClick={onSettings}
          >
            {provider?.model || "Choose a model"}
            <ChevronRight size={12} />
          </button>
          <button
            className="send"
            type="submit"
            disabled={!camera || !message.trim() || busy || !provider?.model}
            aria-label="Send message"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
      <div className="assistant-footer">
        {writes ? "Camera write locks still apply" : "Read-only assistant"}
        <span>Powered by your model</span>
      </div>
    </aside>
  );
}
// Keep one root when Vite replaces this entry module during UI development.
const appRoot =
  import.meta.hot?.data.root || createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = appRoot;
appRoot.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
