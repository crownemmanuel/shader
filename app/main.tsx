import { CaptureFormatSelect } from "./capture-format";
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
  Plug,
  Activity,
  Video,
  Info,
  Eye,
  EyeOff,
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
import { AppUpdates, useUpdateChecks } from "./updater";
import "./style.css";
import "./workspace-layout.css";
import "./settings.css";
import {
  LiveMonitor,
  SimpleControls,
  AxisEditor,
  ColorWheel,
  NumberField,
  useLiveValue,
} from "./visual-controls";
import { RoutingSettings, BrightnessSettings } from "./routing-settings";
import { CameraInputsSettings } from "./camera-inputs";
import { PresetStrip } from "./preset-strip";
import { NumberedPresets } from "./numbered-presets";
import { axes } from "../engine/shading";
import { LightingPanel } from "./lighting-panel";
import { PtzControls } from "./ptz-controls";
import { LensZoomSlider } from "./lens-controls";
import {
  CameraBank,
  WorkspaceLayoutMenu,
  PreviewPane,
  cameraLook,
  useCameraButtons,
  useWorkspaceLayout,
} from "./workspace-layout";
type Cam = Camera & { locked: boolean; writing: boolean; hidden: boolean };
function Modal({
  title,
  close,
  children,
  className,
}: {
  className?: string;
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} className={className}>
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
  const update = useUpdateChecks();
  const [layout, setLayout] = useWorkspaceLayout();
  const [buttonStyles, setButtonStyles] = useCameraButtons();
  const [settingsTab, setSettingsTab] = useState<"general" | "inputs">(
    "general",
  );
  const [showHints, setShowHints] = useState(() => {
    try {
      return localStorage.getItem("shader.show-hints") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("shader.show-hints", showHints ? "1" : "0");
    } catch {
      /* Hints stay hidden by default without storage. */
    }
  }, [showHints]);
  const [previewExpanded, setPreviewExpanded] = useState(false);
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
  const cameraIndex = cameras.findIndex((c) => c.id === selected),
    camera = cameras[cameraIndex] as Cam | undefined,
    look = cameraLook(
      Math.max(0, cameraIndex),
      buttonStyles[selected],
      cameras[cameraIndex]?.name,
    ),
    writesOpen = !!camera && (camera.vendor === "demo" || !camera.locked),
    frame =
      frames[selected]?.sourceId === camera?.sourceId
        ? frames[selected]
        : undefined;
  useEffect(() => {
    if (!camera) setPreviewExpanded(false);
  }, [camera?.id]);
  const refresh = async () => {
    try {
      const data = await command("system_status");
      setStatus(data);
      setCameras(data.cameras);
      setCandidates(data.discovered || []);
      setSelected((s) =>
        data.cameras.some((c: Cam) => c.id === s && !c.hidden)
          ? s
          : (data.cameras.find((c: Cam) => !c.hidden) || data.cameras[0])?.id ||
            "",
      );
      setEngineError("");
    } catch (e) {
      setEngineError(String(e instanceof Error ? e.message : e));
    }
  };
  // Wait on the engine's change feed so edits from other consoles appear at once;
  // the slow interval only covers a dropped feed.
  useEffect(() => {
    let stopped = false,
      version = -1;
    void (async () => {
      while (!stopped) {
        try {
          const next = await command<{ version: number }>("system_changes", {
            after: version,
            timeoutMs: 20000,
          });
          if (stopped) break;
          if (next.version !== version) {
            version = next.version;
            await refresh();
          }
        } catch {
          await refresh();
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();
    const timer = setInterval(refresh, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
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
      <header className="app-toolbar" inert={previewExpanded}>
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>Shader</strong>
          <span className="version">Studio</span>
        </div>
        <div className="toolbar-actions">
          <WorkspaceLayoutMenu layout={layout} onChange={setLayout} />
          <button onClick={() => setModal("presets")}>
            <Bookmark size={14} />
            Presets
          </button>
          <button onClick={() => setModal("lighting")}>
            <Lightbulb size={14} />
            Lighting
            {status?.lighting?.listening && (
              <span className="status-dot online" />
            )}
          </button>
          <button onClick={() => safe(discover())} disabled={!!busy}>
            <RefreshCw
              size={14}
              className={busy === "cameras_discover" ? "spin" : ""}
            />
            Discover
          </button>
          <button
            className={showAssistant ? "icon active" : "icon"}
            aria-label="Toggle assistant"
            title="Assistant"
            onClick={() => setShowAssistant(!showAssistant)}
          >
            <MessageSquare size={17} />
          </button>
          <button
            className="icon"
            aria-label={
              update.version
                ? `Settings · update ${update.version} available`
                : "Settings"
            }
            title={
              update.version
                ? `Update ${update.version} available in Settings`
                : "Settings"
            }
            onClick={() => setModal("settings")}
          >
            <Settings size={17} />
            {update.version && (
              <span
                aria-hidden="true"
                style={{ color: "var(--accent, #ecc38b)", fontSize: 10 }}
              >
                ↑
              </span>
            )}
          </button>
        </div>
      </header>
      <div className={`workspace ${showAssistant ? "with-assistant" : ""}`}>
        <main className="console">
          {engineError && (
            <div className="banner error" role="alert">
              {engineError}
            </div>
          )}
          {camera ? (
            <>
              <div
                className={`shading-workspace ${layout.controlsLeft ? "controls-left" : ""}`}
                style={{ "--cam": look.color } as React.CSSProperties}
              >
                <PreviewPane
                  expanded={previewExpanded}
                  onExpanded={setPreviewExpanded}
                  cameraName={camera.name}
                  title={
                    <>
                      <span className="cam-tag">
                        {look.Icon && <look.Icon size={12} />}
                        {look.label}
                      </span>
                      {layout.showCameras ? (
                        look.label !== camera.name && (
                          <h1
                            className="selected-camera-name"
                            title={camera.name}
                          >
                            {camera.name}
                          </h1>
                        )
                      ) : (
                        <span className="compact-camera-picker">
                          <select
                            aria-label="Selected camera"
                            value={selected}
                            onChange={(e) => setSelected(e.target.value)}
                          >
                            {cameras
                              .filter((c) => !c.hidden)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                          <button
                            className="icon"
                            aria-label="Add camera"
                            title="Add camera…"
                            onClick={() => setModal("connect")}
                          >
                            <Plus size={16} />
                          </button>
                        </span>
                      )}
                      <span
                        className={`state-label ${camera.tally === "program" ? "program" : ""}`}
                      >
                        {camera.status === "demo"
                          ? "Demo"
                          : camera.tally === "program"
                            ? "On Air"
                            : camera.tally === "preview"
                              ? "Preview"
                              : camera.tally === "unknown"
                                ? "Tally unknown"
                                : camera.status}
                      </span>
                      <span className="camera-model">
                        {camera.vendor === "demo" ? "Simulator" : camera.model}
                      </span>
                    </>
                  }
                  actions={
                    <button
                      className="icon"
                      aria-label="Read camera"
                      title="Read camera state"
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
                      <RefreshCw
                        size={15}
                        className={busy === "camera_get" ? "spin" : ""}
                      />
                    </button>
                  }
                  footer={
                    layout.showCameras && (
                      <>
                        <PresetStrip
                          key={camera.id}
                          cameraId={camera.id}
                          cameraName={look.label}
                          slots={status?.presetSlots}
                          jobs={status?.presetJobs || []}
                          perform={perform}
                          notify={setNotice}
                          onManage={() => setModal("presets")}
                          disabled={!writesOpen}
                        />
                        <CameraBank
                          cameras={cameras}
                          selected={selected}
                          onSelect={setSelected}
                          onAdd={() => setModal("connect")}
                          inert={previewExpanded}
                          styles={buttonStyles}
                          onStyle={(id, style) =>
                            setButtonStyles((all) => {
                              const next = { ...all };
                              if (style) next[id] = style;
                              else delete next[id];
                              return next;
                            })
                          }
                          onHide={(id) =>
                            safe(
                              perform(
                                "cameras_hide",
                                { cameraIds: [id], hidden: true },
                                "Camera hidden. Show it again in Settings › Camera buttons.",
                              ),
                            )
                          }
                          onManageHidden={() => {
                            setSettingsTab("inputs");
                            setModal("settings");
                          }}
                        />
                      </>
                    )
                  }
                >
                  <LiveMonitor
                    key={`preview:${camera.id}`}
                    camera={camera}
                    onAssign={() => {
                      setPreviewExpanded(false);
                      setModal("settings");
                    }}
                  />
                  <div className="monitor-controls">
                    <button
                      className="quiet"
                      onClick={() => {
                        setPreviewExpanded(false);
                        setModal("settings");
                      }}
                    >
                      <Video size={14} />
                      <span
                        className="source-label"
                        title={camera.sourceId || "No capture input"}
                      >
                        {camera.sourceId || "No capture input"}
                      </span>
                      <ChevronRight size={13} />
                    </button>
                    <button
                      disabled={!camera.sourceId || !!busy}
                      onClick={() => safe(capture())}
                    >
                      <Scan size={14} />
                      {busy === "capture_frame" ? "Capturing…" : "Capture"}
                    </button>
                  </div>
                </PreviewPane>
                <section
                  className={`controls-pane ${showHints ? "show-hints" : ""}`}
                  aria-label="Camera controls"
                  inert={previewExpanded}
                >
                  <div className="controls-toolbar">
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
                      <div className="write-bar">
                        <span
                          className={`write-state ${writesOpen ? "open" : ""}`}
                        >
                          <span
                            className={`status-dot ${writesOpen ? "online" : ""}`}
                          />
                          {camera.vendor === "demo"
                            ? "Simulation"
                            : writesOpen
                              ? camera.tally === "program"
                                ? "On air · changes are live"
                                : "Unlocked"
                              : "Locked"}
                        </span>
                        {camera.vendor !== "demo" && (
                          <button
                            className={writesOpen ? "" : "arm"}
                            title={
                              writesOpen
                                ? "Lock this camera so nothing can change it"
                                : "Unlock this camera"
                            }
                            onClick={() =>
                              safe(
                                perform(
                                  writesOpen ? "camera_lock" : "camera_unlock",
                                  { cameraId: camera.id },
                                ),
                              )
                            }
                          >
                            {writesOpen ? (
                              <Lock size={13} />
                            ) : (
                              <Unlock size={13} />
                            )}
                            {writesOpen ? "Lock" : "Unlock"}
                          </button>
                        )}
                        <button
                          className={showHints ? "icon active" : "icon"}
                          aria-pressed={showHints}
                          aria-label={
                            showHints
                              ? "Hide explanations"
                              : "Show explanations"
                          }
                          title={
                            showHints
                              ? "Hide explanations"
                              : "Show explanations"
                          }
                          onClick={() => setShowHints(!showHints)}
                        >
                          {showHints ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
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
                      </div>
                    )}
                  </div>
                  <div
                    className="controls-scroll"
                    tabIndex={0}
                    aria-label="Scrollable camera controls"
                  >
                    {mode === "simple" ? (
                      <SimpleControls
                        key={`simple:${camera.id}`}
                        camera={camera}
                        disabled={!!busy || !writesOpen}
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
                              !!busy || !writesOpen || !c.writable;
                            // Sent straight to the engine (not perform) so the
                            // shared busy state never disables a control mid-drag.
                            const onSet = (value: unknown, live: boolean) =>
                              command("control_set", {
                                cameraId: camera.id,
                                controlId: c.id,
                                value,
                                live,
                              });
                            const visual = axes(camera).filter(
                              (a) => a.controlId === c.id,
                            );
                            if (
                              camera.vendor === "atem" &&
                              c.id === "0.9" &&
                              c.type === "number"
                            )
                              return (
                                <LensZoomSlider
                                  key={`${camera.id}:${c.id}`}
                                  cameraId={camera.id}
                                  disabled={disabled}
                                />
                              );
                            if (visual.length)
                              return visual.map((a) => (
                                <AxisEditor
                                  key={`${camera.id}:${a.id}`}
                                  axis={a}
                                  control={c}
                                  disabled={disabled || !a.writable}
                                  onSet={onSet}
                                />
                              ));
                            if (
                              c.type === "vector" &&
                              c.components?.join(",") ===
                                "Red,Green,Blue,Master" &&
                              Array.isArray(c.value) &&
                              (camera.vendor === "demo" ||
                                camera.vendor === "atem")
                            )
                              return (
                                <ColorWheel
                                  key={`${camera.id}:${c.id}`}
                                  control={c}
                                  disabled={disabled}
                                  onSet={onSet}
                                />
                              );
                            return (
                              <ControlEditor
                                key={`${camera.id}:${c.id}`}
                                control={c}
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
                                No shutter-speed value reported.
                              </p>
                              <p className="helper hint">
                                Check the camera’s manual exposure mode. Native
                                shutter controls, when reported, remain
                                available under All.
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
                      <PtzControls
                        camera={camera}
                        writable={writesOpen}
                        busy={!!busy}
                        perform={perform}
                        onError={setNotice}
                      />
                    )}
                  </div>
                </section>
              </div>
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
          <div className="assistant-host" inert={previewExpanded}>
            <Assistant
              key={camera?.id}
              camera={camera}
              frame={frame}
              onSettings={() => setModal("settings")}
              provider={status?.provider}
              onChange={refresh}
              onError={setNotice}
            />
          </div>
        )}
      </div>
      <footer className="statusbar" inert={previewExpanded}>
        <span>
          <span className={`status-dot ${status ? "online" : ""}`} />
          {status ? "Engine ready" : "Connecting"}
          <i />
          {connected} hardware cameras
          <i />
          <button
            className="quiet status-activity"
            onClick={() => setModal("activity")}
          >
            <Activity size={13} />
            Activity
          </button>
        </span>
        <span>
          {camera?.address || "No camera selected"}
          <i />
          <Terminal size={12} />
          {status ? "MCP ready" : "MCP waiting"}
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
          close={() => {
            setModal(null);
            setSettingsTab("general");
          }}
          initialTab={settingsTab}
          status={status}
          perform={perform}
          onLighting={() => setModal("lighting")}
        />
      )}
      {modal === "presets" && (
        <Modal
          title="Numbered presets"
          close={() => setModal(null)}
          className="numbered-presets-dialog"
        >
          <NumberedPresets
            slots={status?.presetSlots}
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
  disabled,
  onSet,
}: {
  control: Control;
  disabled: boolean;
  onSet: (value: unknown, live: boolean) => Promise<unknown>;
}) {
  // Settings stream to the camera as they change; only raw JSON commands and actions need a button.
  const live = useLiveValue<any>(c.value, (v, isLive) => onSet(v, isLive)),
    [text, setText] = useState(JSON.stringify(c.value ?? {}, null, 2)),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!dirty) setText(JSON.stringify(c.value ?? {}, null, 2));
  }, [JSON.stringify(c.value), dirty]);
  async function send(value: unknown) {
    try {
      await onSet(value, false);
      setDirty(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const numeric = (
    v: number | undefined,
    change: (v: number, final: boolean) => void,
    label: string,
  ) => (
    <div className="numeric">
      <NumberField
        label={label}
        value={v}
        min={c.min}
        max={c.max}
        step={c.step || "any"}
        disabled={disabled}
        placeholder="Unknown"
        onLive={(n) => change(n, false)}
        onCommit={(n) => change(n, true)}
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
        <span className={`freshness ${live.editing ? "" : c.freshness}`}>
          {live.editing
            ? "Live"
            : c.freshness === "reported"
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
                live.value?.[i],
                (v, final) => {
                  const next = [
                    ...(live.value || c.components?.map(() => 0) || []),
                  ];
                  next[i] = v;
                  live.change(next, final);
                },
                `${c.label} ${component}`,
              )}
            </div>
          ))}
        </div>
      ) : c.type === "number" ? (
        numeric(live.value, (v, final) => live.change(v, final), c.label)
      ) : c.type === "enum" ? (
        <select
          aria-label={c.label}
          value={live.value ?? ""}
          disabled={disabled}
          onChange={(e) =>
            live.change(
              c.options?.find((o) => String(o.value) === e.target.value)?.value,
              true,
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
            checked={live.value === true}
            disabled={disabled}
            onChange={(e) => live.change(e.target.checked, true)}
          />
          Enabled
        </label>
      ) : c.type === "string" ? (
        <input
          key={String(c.value ?? "")}
          aria-label={c.label}
          defaultValue={c.value == null ? "" : String(c.value)}
          disabled={disabled}
          onBlur={(e) => {
            if (e.target.value !== (c.value ?? ""))
              live.change(e.target.value, true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      ) : c.type === "json" ? (
        <textarea
          aria-label={c.label}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          rows={4}
        />
      ) : null}
      {c.note && <p className="control-note hint">{c.note}</p>}
      {(live.error || error) && (
        <p className="error-text">{live.error || error}</p>
      )}
      <div className="control-bottom">
        <small>{c.id}</small>
        {c.writable && c.type === "json" && (
          <button
            className={dirty ? "apply dirty" : "apply"}
            disabled={disabled || !dirty}
            onClick={() => {
              try {
                void send(JSON.parse(text));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Send
          </button>
        )}
        {c.writable && c.type === "action" && (
          <button
            className="apply"
            disabled={disabled}
            onClick={() => void send(true)}
          >
            Run
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
  initialTab = "general",
  status,
  perform,
  onLighting,
}: {
  close: () => void;
  initialTab?: "general" | "inputs";
  status: any;
  perform: Function;
  onLighting: () => void;
}) {
  type Tab =
    | "mapping"
    | "inputs"
    | "brightness"
    | "assistant"
    | "integrations"
    | "updates";
  const [tab, setTab] = useState<Tab>(
    initialTab === "inputs" ? "inputs" : "mapping",
  );
  const tabs: { id: Tab; label: string }[] = [
    { id: "mapping", label: "Camera mapping" },
    { id: "inputs", label: "Camera buttons" },
    { id: "brightness", label: "Brightness limits" },
    { id: "assistant", label: "Assistant" },
    { id: "integrations", label: "Integrations" },
    { id: "updates", label: "App updates" },
  ];
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
    <Modal title="Settings" close={close} className="settings-dialog">
      <div className="settings-tabs" role="tablist" aria-label="Settings">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`settings-tab-${item.id}`}
            role="tab"
            aria-controls={`settings-panel-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(e) => {
              const next =
                e.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : e.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                e.preventDefault();
                setTab(tabs[next].id);
                document
                  .getElementById(`settings-tab-${tabs[next].id}`)
                  ?.focus();
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="settings-panels">
        <div
          role="tabpanel"
          id="settings-panel-mapping"
          aria-labelledby="settings-tab-mapping"
          hidden={tab !== "mapping"}
        >
          <RoutingSettings status={status} perform={perform} />
        </div>
        <div
          role="tabpanel"
          id="settings-panel-inputs"
          aria-labelledby="settings-tab-inputs"
          hidden={tab !== "inputs"}
        >
          <div className="settings-page-heading">
            <div>
              <h3>Camera buttons</h3>
              <p>Choose which inputs appear in your workspace.</p>
            </div>
          </div>
          <CameraInputsSettings status={status} perform={perform} />
        </div>
        <div
          role="tabpanel"
          id="settings-panel-brightness"
          aria-labelledby="settings-tab-brightness"
          hidden={tab !== "brightness"}
        >
          <BrightnessSettings status={status} perform={perform} />
        </div>
        <div
          role="tabpanel"
          id="settings-panel-updates"
          aria-labelledby="settings-tab-updates"
          hidden={tab !== "updates"}
        >
          <AppUpdates />
        </div>
        <div
          className="settings-narrow"
          role="tabpanel"
          id="settings-panel-integrations"
          aria-labelledby="settings-tab-integrations"
          hidden={tab !== "integrations"}
        >
          <div className="settings-intro">
            <Lightbulb size={21} />
            <div>
              <h3>StageLight connection</h3>
              <p>Lighting reports, camera looks and cue-triggered scenes.</p>
            </div>
            <button onClick={onLighting}>Configure lighting link</button>
          </div>
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
        <div
          className="settings-narrow form"
          role="tabpanel"
          id="settings-panel-assistant"
          aria-labelledby="settings-tab-assistant"
          hidden={tab !== "assistant"}
        >
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
              choices are saved. No key is sent to the camera or returned
              through MCP.
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
              disabled={s.available === false}
              onChange={() => setSelected(s.id)}
            />
            <Video size={20} />
            <span>
              {s.name}
              <small>
                {s.backend === "decklink-sdk" ? "Blackmagic DeckLink" : s.kind}
                {s.available === false ? " · unavailable" : ""}
              </small>
            </span>
          </label>
        ))}
        <CaptureFormatSelect
          key={selected}
          source={sources.find((s) => s.id === selected)}
          perform={perform}
          onChange={(source) =>
            setSources((items) =>
              items.map((s) => (s.id === source.id ? source : s)),
            )
          }
        />
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
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [history, busy]);
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
