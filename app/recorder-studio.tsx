import React, { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  FolderOpen,
  Grid2X2,
  List,
  MoreHorizontal,
  Video,
  Circle,
  Square,
  RefreshCw,
  X,
} from "lucide-react";
import type { Camera, CaptureSource } from "../engine/types";
import { command } from "./api";
import "./recorder-studio.css";

export const diskBytes = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(2)} TB` : `${(n / 1e9).toFixed(1)} GB`;
export const recordingRate = (profile: string, channels: number[]) =>
  channels.reduce(
    (n, c) => n + (profile === "prores-lt" ? 103e6 : 148e6) / 8 + c * 48000 * 4,
    0,
  );
const duration = (s: number) =>
  `${Math.floor(Math.max(0, s) / 3600)}h ${Math.floor((Math.max(0, s) % 3600) / 60)}m`;
const rememberedFolder = () => {
  try {
    return localStorage.getItem("shader.recording-folder") || "";
  } catch {
    return "";
  }
};

function InputPreview({
  id,
  monitored,
  ready,
}: {
  id: string;
  monitored: boolean;
  ready: boolean;
}) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>,
      sequence = 0;
    setImage("");
    setError("");
    async function poll() {
      try {
        const p = await command("recorder_preview", {
          sourceId: id,
          afterSequence: sequence,
        });
        if (!alive) return;
        sequence = p.sequence;
        if (p.status !== "live") setImage("");
        else if (p.data) setImage(`data:image/jpeg;base64,${p.data}`);
        setError("");
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setImage("");
        }
      }
      if (alive) timer = setTimeout(poll, 170);
    }
    if (monitored) void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, monitored]);
  return (
    <div className="rec-preview">
      {image && ready ? (
        <img src={image} alt="Live input preview" />
      ) : (
        <span>
          <Video size={25} />
          {error ||
            (monitored
              ? ready
                ? "Loading preview…"
                : "Waiting for signal"
              : "Start monitoring to preview")}
        </span>
      )}
    </div>
  );
}

export function RecorderStudio({
  sources,
  cameras,
  refresh,
}: {
  sources: CaptureSource[];
  cameras: Camera[];
  refresh: () => Promise<unknown>;
}) {
  const [state, setState] = useState<any>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [card, setCard] = useState("all");
  const [table, setTable] = useState(false);
  const [editing, setEditing] = useState<CaptureSource>();
  const [folder, setFolder] = useState(rememberedFolder);
  const [storage, setStorage] = useState<any>();
  const [storageError, setStorageError] = useState("");
  const [name, setName] = useState("Sunday service");
  const [profile, setProfile] = useState("prores-lt");
  const [minutes, setMinutes] = useState("");
  const [marker, setMarker] = useState("");
  const [pairing, setPairing] = useState("");
  const [sender, setSender] = useState("");
  const [networkHost, setNetworkHost] = useState("127.0.0.1");
  const request = useRef<{ id: string; payload: string } | null>(null);
  const active = state?.active;
  const inputs = sources.filter((s) => s.kind === "decklink");
  const cards = [
    ...new Set(inputs.map((s) => s.cardId).filter(Boolean)),
  ] as string[];
  const visible = inputs.filter((s) => card === "all" || s.cardId === card);
  const inputState = (id: string) =>
    state?.inputs?.find((i: any) => i.source.id === id)?.state;
  const chosen = inputs.filter((s) => selected.includes(s.id));
  const activeSources = active?.tracks?.map((t: any) => t.source) || chosen;
  const rate = recordingRate(
    active?.profile || profile,
    activeSources.map((s: any) => s.audioChannels || 16),
  );
  const free = storage ? Number(storage.freeBytes) : 0;
  const usable = Math.max(
    0,
    free - Number(storage?.reserveBytes || 2147483648),
  );
  const seconds = rate ? usable / rate : 0;
  const enough =
    !!storage && !storageError && usable > rate * (Number(minutes) * 60 || 60);
  const ready =
    chosen.length > 0 && chosen.every((s) => inputState(s.id)?.ready);
  const diskPath = active?.directory || folder;
  async function update() {
    const s = await command("recorder_status");
    setState(s);
    return s;
  }
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const s = await command("recorder_status");
        if (alive) setState(s);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    setStorage(undefined);
    setStorageError("");
    async function check() {
      try {
        const v = await command("recorder_storage", { path: diskPath });
        if (alive) {
          setStorage(v);
          setStorageError("");
        }
      } catch (e) {
        if (alive) {
          setStorage(undefined);
          setStorageError((e as Error).message);
        }
      }
      if (alive) timer = setTimeout(check, 5000);
    }
    if (diskPath) void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [diskPath]);
  useEffect(() => {
    try {
      localStorage.setItem("shader.recording-folder", folder);
    } catch {
      /* Session still works. */
    }
  }, [folder]);
  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
      await update();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function chooseFolder() {
    if (!isTauri()) {
      setNotice(
        "In the browser preview, enter a local folder path below. The desktop app opens the folder picker.",
      );
      return;
    }
    await run("folder", async () => {
      const path = await invoke<string | null>("choose_recording_directory", {
        current: folder || null,
      });
      if (path) setFolder(path);
    });
  }
  function toggle(id: string) {
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(0, 8),
    );
  }
  const start = () =>
    run("start", async () => {
      const args = {
        name,
        directory: folder,
        profile,
        sourceIds: selected,
        ...(minutes
          ? { durationSeconds: Math.round(Number(minutes) * 60) }
          : {}),
      };
      const previous = state?.history?.find(
        (t: any) => t.id === request.current?.id,
      );
      if (
        previous &&
        !["preparing", "recording", "degraded", "finalizing"].includes(
          previous.status,
        )
      )
        request.current = null;
      const payload = JSON.stringify(args);
      if (!request.current || request.current.payload !== payload)
        request.current = { id: crypto.randomUUID(), payload };
      await command("recorder_start", {
        ...args,
        requestId: request.current.id,
      });
    });
  return (
    <section className="recorder-studio" aria-label="Recorder Studio">
      <header className="rec-heading">
        <div>
          <h1>Recorder Studio</h1>
          <p>
            One recording per camera. Embedded audio and scene markers stay with
            the take.
          </p>
        </div>
        <span className={`rec-state ${active ? "recording" : ""}`}>
          <Circle size={10} fill="currentColor" />
          {active ? `${active.name} · ${active.status}` : "Ready to set up"}
        </span>
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner" role="status">
          {notice}
        </div>
      )}
      {active?.errors?.map((e: string, i: number) => (
        <div className="banner error" role="alert" key={i}>
          {e}
        </div>
      ))}
      {Object.entries(state?.exportErrors || {}).map(([id, message]) => (
        <div className="banner error" role="alert" key={id}>
          Marker files for{" "}
          {state?.history?.find((t: any) => t.id === id)?.name || id} could not
          be updated: {String(message)}. Reconnect the recording drive and use
          Refresh marker files in Recent takes. The local marker journal is
          retained.
        </div>
      ))}
      <div className="rec-main">
        <div className="rec-inputs">
          <div className="rec-input-toolbar">
            <label className="rec-card-label">
              Capture card
              <select
                value={card}
                disabled={!!active}
                onChange={(e) => {
                  setCard(e.target.value);
                }}
              >
                <option value="all">All DeckLink inputs</option>
                {cards.map((id, i) => (
                  <option key={id} value={id}>
                    {inputs.find((s) => s.cardId === id)?.model || "DeckLink"} ·
                    card {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!!busy || !!active}
              onClick={() =>
                run("scan", async () => {
                  const result = await command("capture_sources");
                  if (result?.diagnostics?.length)
                    setNotice(result.diagnostics.join(" "));
                  await refresh();
                })
              }
            >
              <RefreshCw size={14} />
              Find inputs
            </button>
            <div className="rec-view-toggle" aria-label="Input view">
              <button
                aria-label="Multiview"
                aria-pressed={!table}
                onClick={() => setTable(false)}
              >
                <Grid2X2 size={16} />
              </button>
              <button
                aria-label="Input table"
                aria-pressed={table}
                onClick={() => setTable(true)}
              >
                <List size={16} />
              </button>
            </div>
          </div>
          <div className="rec-selection">
            <label>
              <input
                type="checkbox"
                disabled={!!active || !visible.length}
                checked={
                  !!visible.length &&
                  visible.every((s) => selected.includes(s.id))
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? visible.slice(0, 8).map((s) => s.id)
                      : [],
                  )
                }
              />
              Select all
            </label>
            <span>
              {active ? active.tracks.length : chosen.length} inputs selected
            </span>
            <button
              disabled={!!busy || !!active || !visible.length}
              onClick={() =>
                run("monitor", () =>
                  command("recorder_monitor", {
                    sourceIds: visible.slice(0, 8).map((s) => s.id),
                  }),
                )
              }
            >
              Monitor inputs
            </button>
            <button
              className="quiet"
              disabled={!!busy || !!active || !state?.inputs?.length}
              onClick={() =>
                run("release", () =>
                  command("recorder_release", {
                    sourceIds: state.inputs.map((i: any) => i.source.id),
                  }),
                )
              }
            >
              Stop monitoring
            </button>
          </div>
          {!inputs.length && (
            <div className="rec-empty">
              <Video size={32} />
              <h2>Find your capture inputs</h2>
              <p>
                Connect the DeckLink card, close vMix, then select Find inputs.
                Set the Quad 2 connectors to input in Desktop Video Setup.
              </p>
            </div>
          )}
          {table ? (
            <div className="rec-table-scroll">
              <table className="rec-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Input name</th>
                    <th>SDI</th>
                    <th>Camera button</th>
                    <th>Format / audio</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => {
                    const st = inputState(s.id);
                    return (
                      <tr key={s.id}>
                        <td>
                          <input
                            aria-label={`Record ${s.alias || s.name}`}
                            type="checkbox"
                            checked={
                              active
                                ? active.tracks.some(
                                    (t: any) => t.source.id === s.id,
                                  )
                                : selected.includes(s.id)
                            }
                            disabled={!!active}
                            onChange={() => toggle(s.id)}
                          />
                        </td>
                        <td>{s.alias || s.name}</td>
                        <td>{s.connector || "—"}</td>
                        <td>
                          {cameras
                            .filter((c) => c.sourceId === s.id)
                            .map((c) => c.name)
                            .join(", ") || "Unmapped"}
                        </td>
                        <td>
                          {s.recorderMode === "1080p2997"
                            ? "1080p29.97"
                            : "1080p30"}{" "}
                          / {s.audioChannels || 16} ch
                        </td>
                        <td>
                          {st?.recordError ||
                            st?.error ||
                            (st?.recording
                              ? "Recording"
                              : st?.ready
                                ? "Live"
                                : st
                                  ? "Waiting for signal"
                                  : "Off")}
                        </td>
                        <td>
                          <button
                            aria-label={`Edit ${s.alias || s.name}`}
                            disabled={!!active}
                            onClick={() => setEditing(s)}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rec-grid">
              {visible.map((s) => {
                const st = inputState(s.id);
                const isSelected = active
                  ? active.tracks.some((t: any) => t.source.id === s.id)
                  : selected.includes(s.id);
                return (
                  <article
                    key={s.id}
                    className={`rec-tile ${isSelected ? "selected" : ""} ${st?.recording ? "recording" : ""}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!active) setEditing(s);
                    }}
                  >
                    <div className="rec-tile-top">
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`Record ${s.alias || s.name}`}
                          disabled={!!active}
                          checked={isSelected}
                          onChange={() => toggle(s.id)}
                        />
                        <span>SDI {s.connector || "?"}</span>
                      </label>
                      <span className={st?.ready ? "rec-live" : ""}>
                        {st?.recording
                          ? "● Recording"
                          : st?.ready
                            ? "Live"
                            : st
                              ? "Waiting"
                              : "Off"}
                      </span>
                    </div>
                    <InputPreview
                      id={s.id}
                      monitored={!!st}
                      ready={!!st?.ready}
                    />
                    <div className="rec-tile-name">
                      <div>
                        <strong title={s.alias || s.name}>
                          {s.alias || s.name}
                        </strong>
                        <small>
                          {cameras
                            .filter((c) => c.sourceId === s.id)
                            .map((c) => c.name)
                            .join(", ") || "No camera button mapped"}
                        </small>
                      </div>
                      <button
                        aria-label={`Edit ${s.alias || s.name}`}
                        disabled={!!active}
                        onClick={() => setEditing(s)}
                      >
                        <MoreHorizontal size={17} />
                      </button>
                    </div>
                    {st?.meters?.length > 0 && (
                      <div
                        className="rec-audio"
                        aria-label={`${st.meters.length} embedded audio channels`}
                      >
                        {st.meters.map((n: number, i: number) => (
                          <meter
                            key={i}
                            min={0}
                            max={1}
                            value={n}
                            title={`Audio ${i + 1}`}
                          />
                        ))}
                      </div>
                    )}
                    {(st?.recordError || st?.error) && (
                      <p className="rec-input-error" role="alert">
                        {st.recordError || st.error}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {!!state?.inputs?.length && (
            <p className="rec-note">
              Inputs stay live when you return to shading. Right-click a preview
              or use its menu to name and map it.
            </p>
          )}
          <section className="rec-markers">
            <div>
              <h2>Scene markers</h2>
              <span>
                {state?.network?.enabled
                  ? "StageMics receiver on"
                  : "StageMics receiver off"}
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run("marker", async () => {
                  await command("recorder_marker", { label: marker });
                  setMarker("");
                });
              }}
            >
              <input
                aria-label="Marker label"
                placeholder="e.g. Choir starts"
                value={marker}
                onChange={(e) => setMarker(e.target.value)}
                maxLength={200}
                disabled={!active}
              />
              <button disabled={!active || !!busy || !marker.trim()}>
                Add marker
              </button>
            </form>
            <ol>
              {state?.markers?.slice(0, 8).map((m: any) => (
                <li key={m.event.eventId}>
                  <span>{m.event.label || m.event.scene?.name}</span>
                  <small>{m.event.type}</small>
                </li>
              ))}
            </ol>
            {!state?.markers?.length && (
              <p>
                Scene entries, exits, and operator markers will appear here
                during a take.
              </p>
            )}
          </section>
        </div>
        <aside className="rec-setup" aria-label="Recording setup">
          <h2>Recording destination</h2>
          <button
            className="rec-folder-button"
            disabled={!!active || !!busy}
            onClick={chooseFolder}
          >
            <FolderOpen size={18} />
            Choose folder
          </button>
          <label>
            Save recordings to
            <input
              aria-label="Recording folder"
              placeholder="Select a recording drive…"
              value={active?.directory || folder}
              disabled={!!active}
              onChange={(e) => setFolder(e.target.value)}
            />
          </label>
          <div
            className={`rec-storage ${storageError || (storage && !enough && !active) ? "low" : ""}`}
            aria-live="polite"
          >
            <strong>
              {storage
                ? `${diskBytes(free)} free`
                : diskPath
                  ? storageError
                    ? "Drive unavailable"
                    : "Checking drive…"
                  : "Choose a folder to check space"}
            </strong>
            {storage && (
              <>
                <meter
                  aria-label="Disk space used"
                  min={0}
                  max={Number(storage.totalBytes)}
                  value={Number(storage.totalBytes) - free}
                />
                <span>
                  of {diskBytes(Number(storage.totalBytes))} · updates every 5
                  seconds
                </span>
                <b>
                  {rate
                    ? `About ${duration(seconds)} remaining`
                    : "Select inputs for a time estimate"}
                </b>
                <small>
                  {rate
                    ? `${Math.round(rate / 1e6)} MB/s estimated · 2 GB reserved to finish files`
                    : "Based on selected inputs, audio, and quality"}
                </small>
              </>
            )}
            {storageError && <small role="alert">{storageError}</small>}
          </div>
          <label>
            Take name
            <input
              value={active?.name || name}
              disabled={!!active}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Quality
            <select
              value={active?.profile || profile}
              disabled={!!active}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="prores-lt">ProRes 422 LT · smaller files</option>
              <option value="prores">ProRes 422 · higher quality</option>
            </select>
          </label>
          <label>
            Stop after (minutes)
            <input
              type="number"
              min="1"
              max="1440"
              placeholder="Until I press Stop"
              value={
                active?.durationSeconds ? active.durationSeconds / 60 : minutes
              }
              disabled={!!active}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <p className="rec-note">
            Separate MOV files with embedded SDI audio. Camera names become
            folder and file names. New parts are created every five minutes.
          </p>
          {active ? (
            <button
              className="rec-stop"
              disabled={!!busy || active.status === "finalizing"}
              onClick={() =>
                run("stop", async () => {
                  const result = await command("recorder_stop");
                  request.current = null;
                  setNotice(
                    result.status === "complete"
                      ? "Recording finalized. Camera files and marker sidecars are saved."
                      : "Recording ended with issues. Review the take report before using these files.",
                  );
                })
              }
            >
              <Square size={15} fill="currentColor" />
              {busy === "stop" || active.status === "finalizing"
                ? "Finishing files…"
                : "Stop recording"}
            </button>
          ) : (
            <button
              className="rec-record"
              disabled={
                !!busy ||
                !ready ||
                !enough ||
                !name.trim() ||
                (!!minutes && (Number(minutes) < 1 || Number(minutes) > 1440))
              }
              onClick={start}
            >
              <Circle size={15} fill="currentColor" />
              {busy === "start"
                ? "Starting…"
                : `Record ${chosen.length || "selected"} input${chosen.length === 1 ? "" : "s"}`}
            </button>
          )}
          {!active && (
            <small className="rec-note">
              {!chosen.length
                ? "Select the cameras you want to record."
                : !ready
                  ? "Monitor selected inputs and wait for video and audio."
                  : !folder
                    ? "Choose a recording folder."
                    : !enough
                      ? "Choose a drive with enough space for this take."
                      : "Ready. Space and signal are checked again before starting."}
            </small>
          )}
          <details className="rec-network">
            <summary>StageMics connection</summary>
            <p>
              Enter this endpoint and pairing key in StageMics. Markers are
              saved with each take.
            </p>
            <label>
              Receive from
              <select
                value={networkHost}
                onChange={(e) => setNetworkHost(e.target.value)}
              >
                <option value="127.0.0.1">This computer</option>
                <option value="0.0.0.0">
                  Another computer on the show network
                </option>
              </select>
            </label>
            {networkHost === "0.0.0.0" && (
              <label>
                StageMics IPv4 address
                <input
                  value={sender}
                  onChange={(e) => setSender(e.target.value)}
                  placeholder="192.168.1.20"
                />
              </label>
            )}
            <button
              disabled={!!busy}
              onClick={() =>
                run("network", () =>
                  command("recorder_network", {
                    enabled: true,
                    host: networkHost,
                    port: 9202,
                    allowedSenders:
                      networkHost === "0.0.0.0" ? [sender.trim()] : [],
                  }),
                )
              }
            >
              Enable receiver
            </button>
            <button
              className="quiet"
              disabled={!!busy || !state?.network?.enabled}
              onClick={() =>
                run("network", () =>
                  command("recorder_network", {
                    enabled: false,
                    host: "127.0.0.1",
                    port: 9202,
                    allowedSenders: [],
                  }),
                )
              }
            >
              Disable
            </button>
            <code>
              {state?.network?.host === "0.0.0.0"
                ? "http://<this PC’s IP>:9202"
                : "http://127.0.0.1:9202"}
            </code>
            {pairing ? (
              <label>
                Pairing key
                <input
                  readOnly
                  value={pairing}
                  onFocus={(e) => e.target.select()}
                />
                <button className="quiet" onClick={() => setPairing("")}>
                  Hide key
                </button>
              </label>
            ) : (
              <button
                className="quiet"
                onClick={() =>
                  run("key", async () => {
                    setPairing(
                      (await command("recorder_pairing_key")).pairingKey,
                    );
                  })
                }
              >
                Show pairing key
              </button>
            )}
          </details>
          <details className="rec-history">
            <summary>Recent takes</summary>
            {state?.history?.map((t: any) => (
              <div key={t.id}>
                <strong>{t.name}</strong>
                <span>
                  {t.status} · {t.tracks.length} inputs
                </span>
                <small title={t.directory}>{t.directory}</small>
                {!!t.errors?.length && <p>{t.errors.join("; ")}</p>}
                <button
                  disabled={!!busy || !!active}
                  onClick={() =>
                    run("export", () =>
                      command("recorder_export", { sessionId: t.id }),
                    )
                  }
                >
                  Refresh marker files
                </button>
                {!["recording", "preparing", "finalizing", "complete"].includes(
                  t.status,
                ) && (
                  <button
                    disabled={!!busy || !!active}
                    onClick={() =>
                      run("recover", async () => {
                        const result = await command("recorder_recover", {
                          sessionId: t.id,
                        });
                        setNotice(
                          `${result.results.filter((r: any) => r.status === "recovered-checkpoint").length} partial files recovered. Review recovery-report.json and check the media before editing. Originals were preserved.`,
                        );
                      })
                    }
                  >
                    Recover partial files
                  </button>
                )}
              </div>
            ))}
          </details>
          <p className="rec-qualification">
            Test on your recording PC before a production session. Eight-input
            throughput and power-loss recovery still require hardware
            qualification.
          </p>
        </aside>
      </div>
      {editing && (
        <InputEditor
          source={editing}
          cameras={cameras}
          monitored={!!inputState(editing.id)}
          close={() => setEditing(undefined)}
          save={async (args) => {
            await command("recorder_input_update", args);
            await refresh();
            await update();
            setEditing(undefined);
          }}
        />
      )}
    </section>
  );
}
function InputEditor({
  source,
  cameras,
  monitored,
  close,
  save,
}: {
  source: CaptureSource;
  cameras: Camera[];
  monitored: boolean;
  close: () => void;
  save: (a: unknown) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(source.alias || source.name),
    [camera, setCamera] = useState(
      cameras.find((c) => c.sourceId === source.id)?.id || "",
    ),
    [mode, setMode] = useState(source.recorderMode || "1080p30"),
    [audio, setAudio] = useState(source.audioChannels || 16),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} className="rec-input-editor">
      <header>
        <h2>SDI {source.connector || "input"} · name and mapping</h2>
        <button
          className="icon"
          aria-label="Close input editor"
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save({
              sourceId: source.id,
              name,
              mode,
              audioChannels: audio,
              cameraId: camera || null,
            });
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          Input name
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Camera button
          <select
            aria-label="Camera button"
            value={camera}
            onChange={(e) => setCamera(e.target.value)}
          >
            <option value="">No camera button</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Video format
          <select
            value={mode}
            disabled={monitored}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="1080p30">1080p30</option>
            <option value="1080p2997">1080p29.97</option>
          </select>
        </label>
        <label>
          Embedded audio channels
          <select
            value={audio}
            disabled={monitored}
            onChange={(e) => setAudio(Number(e.target.value) as typeof audio)}
          >
            {[2, 8, 16].map((n) => (
              <option key={n} value={n}>
                {n} channels
              </option>
            ))}
          </select>
        </label>
        {monitored && (
          <p>Stop monitoring to change signal format or audio channels.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            Save input
          </button>
        </footer>
      </form>
    </dialog>
  );
}
