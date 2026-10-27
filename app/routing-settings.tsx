import React, { useRef, useState, useEffect } from "react";
import { RefreshCw, Search } from "lucide-react";
import { CaptureFormatSelect } from "./capture-format";
import type { Camera, CaptureSource } from "../engine/types";
import type { SwitcherInfo } from "../engine/routing";
import { defaultPolicy, type ExposurePolicy } from "../engine/shading";

type SettingsProps = { status: any; perform: Function };

/** One shared source inventory, with independently saved camera rows. */
export function RoutingSettings({ status, perform }: SettingsProps) {
  const cameras: Camera[] = status?.cameras || [];
  const switchers: SwitcherInfo[] = status?.switchers || [];
  const [sources, setSources] = useState<CaptureSource[]>(
    status?.captureSources || [],
  );
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [scanResult, setScanResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setSources(status?.captureSources || []);
  }, [status?.captureSources]);
  const hidden = new Set<string>(status?.hiddenCameras || []);
  const filtered = cameras.filter((c) =>
    `${c.name} ${c.address} ${c.model}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const updateSource = (source: CaptureSource) =>
    setSources((items) => [...items.filter((s) => s.id !== source.id), source]);
  async function scan() {
    setScanning(true);
    setError("");
    setDiagnostics([]);
    setScanResult("");
    try {
      const result = await perform("capture_sources");
      setSources(result.sources);
      setDiagnostics(result.diagnostics);
      const available = result.sources.filter(
        (s: CaptureSource) => s.available !== false,
      ).length;
      setScanResult(
        available
          ? `Found ${available} video input${available === 1 ? "" : "s"}. Select an input in each camera’s row.`
          : "No video inputs found. Check that your capture device is connected and its driver is installed, then scan again.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }
  return (
    <section className="mapping-settings">
      <div className="settings-page-heading">
        <div>
          <h3>Camera mapping</h3>
          <p>
            See every camera and its connections in one place. Changes save
            automatically.
          </p>
        </div>
        <button
          className="primary"
          disabled={scanning}
          onClick={() => void scan()}
        >
          <RefreshCw size={15} className={scanning ? "spin" : ""} />
          {scanning ? "Finding video inputs…" : "Find video inputs"}
        </button>
      </div>
      <div className="mapping-guide">
        <span>
          <strong>Video input</strong> supplies Shader’s preview.
        </span>
        <span>
          <strong>ATEM input + program bus</strong> determine the camera’s
          on-air tally.
        </span>
      </div>
      {(scanResult || diagnostics.length > 0 || error) && (
        <div className="mapping-discovery" aria-live="polite">
          {scanResult && <p>{scanResult}</p>}
          {diagnostics.length > 0 && (
            <ul>
              {diagnostics.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {cameras.length > 0 ? (
        <>
          <div className="mapping-toolbar">
            <label className="mapping-search">
              <Search size={15} />
              <input
                type="search"
                aria-label="Filter cameras"
                placeholder="Find a camera by name or address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <span>
              {filtered.length} of {cameras.length} cameras
            </span>
          </div>
          <p className="mapping-scroll-hint">
            Scroll sideways to see all mapping columns.
          </p>
          {!sources.length && !scanResult && (
            <p className="mapping-empty-hint">
              No video inputs listed yet. Use <strong>Find video inputs</strong>{" "}
              to discover your DeckLink, SDI or USB inputs.
            </p>
          )}
          <div
            className="mapping-table-scroll"
            role="region"
            aria-label="Camera mapping table"
            tabIndex={0}
          >
            <table className="mapping-table">
              <caption className="sr-only">
                Camera visibility, video capture inputs and ATEM tally mapping.
                Changes save automatically.
              </caption>
              <colgroup>
                <col className="map-show" />
                <col className="map-camera" />
                <col className="map-video" />
                <col className="map-format" />
                <col className="map-switcher" />
                <col className="map-input" />
                <col className="map-bus" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Show</th>
                  <th scope="col">Camera</th>
                  <th scope="col">Video input</th>
                  <th scope="col">Video format</th>
                  <th scope="col">ATEM switcher</th>
                  <th scope="col">ATEM input</th>
                  <th scope="col">Program bus</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((camera) => (
                  <MappingRow
                    key={camera.id}
                    camera={camera}
                    cameras={cameras}
                    hidden={hidden.has(camera.id)}
                    sources={sources}
                    switchers={switchers}
                    perform={perform}
                    updateSource={updateSource}
                  />
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={7} className="mapping-no-results">
                      No cameras match “{query}”.{" "}
                      <button className="quiet" onClick={() => setQuery("")}>
                        Clear search
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mapping-footnote">
            Show controls visibility in the camera button bank. Hidden cameras
            keep their connections and mappings. Mapping does not reroute your
            ATEM’s outputs.
          </p>
        </>
      ) : (
        <div className="settings-empty">
          <h4>No cameras connected</h4>
          <p>
            Close Settings and use Discover cameras or Connect by address. Each
            connected camera will appear here as a row.
          </p>
        </div>
      )}
      <ManualInput perform={perform} onRegistered={updateSource} />
    </section>
  );
}

function MappingRow({
  camera,
  cameras,
  hidden,
  sources,
  switchers,
  perform,
  updateSource,
}: {
  camera: Camera;
  cameras: Camera[];
  hidden: boolean;
  sources: CaptureSource[];
  switchers: SwitcherInfo[];
  perform: Function;
  updateSource: (s: CaptureSource) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const route = camera.tallyRoute;
  const sw = switchers.find((s) => s.host === route?.host);
  const source = sources.find((s) => s.id === camera.sourceId);
  const shared = camera.sourceId
    ? cameras.filter(
        (c) => c.id !== camera.id && c.sourceId === camera.sourceId,
      )
    : [];
  async function change(name: string, args: object) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await perform(
        name,
        name === "cameras_hide" ? args : { cameraId: camera.id, ...args },
      );
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <tr className={hidden ? "mapping-hidden" : ""} aria-busy={busy}>
      <td>
        <input
          type="checkbox"
          aria-label={`Show ${camera.name} in camera bank`}
          checked={!hidden}
          disabled={busy}
          onChange={(e) =>
            void change("cameras_hide", {
              cameraIds: [camera.id],
              hidden: !e.target.checked,
            })
          }
        />
      </td>
      <th scope="row">
        <strong title={`${camera.model} · ${camera.address}`}>
          {camera.name}
        </strong>
        <span className={`mapping-connection ${camera.status}`}>
          <span
            className={`status-dot ${camera.status === "connected" || camera.status === "demo" ? "online" : ""}`}
          />
          {camera.status === "demo" ? "Simulated" : camera.status}
          {hidden ? " · hidden" : ""}
        </span>
        <span className="mapping-save-state" role="status">
          {busy ? (
            "Saving…"
          ) : error ? (
            <span className="error-text">{error}</span>
          ) : saved ? (
            "Saved"
          ) : null}
        </span>
      </th>
      <td>
        <select
          aria-label={`${camera.name} video input`}
          value={camera.sourceId || ""}
          disabled={busy}
          onChange={(e) =>
            void change("capture_assign", { sourceId: e.target.value || null })
          }
        >
          <option value="">No video input</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id} disabled={s.available === false}>
              {s.connector
                ? `SDI ${s.connector} · ${s.nativeName || s.name}`
                : s.name}
              {s.available === false ? " · unavailable" : ""}
            </option>
          ))}
          {camera.sourceId && !source && (
            <option value={camera.sourceId}>Saved input · unavailable</option>
          )}
        </select>
        {source?.available === false && <small>Input unavailable</small>}
        {shared.length > 0 && (
          <small>Shared with {shared.map((c) => c.name).join(", ")}</small>
        )}
      </td>
      <td>
        {source?.kind === "decklink" && source.modes?.length ? (
          <CaptureFormatSelect
            key={source.id}
            source={source}
            perform={perform}
            onChange={updateSource}
            compact
            label={`${camera.name} video format`}
          />
        ) : (
          <span className="mapping-na">
            {source?.format || (source ? "From source" : "—")}
          </span>
        )}
      </td>
      <td>
        <select
          aria-label={`${camera.name} ATEM switcher`}
          title={sw ? `${sw.name} · ${sw.host}` : route?.host}
          disabled={busy}
          value={route?.host || ""}
          onChange={(e) => {
            const next = switchers.find((s) => s.host === e.target.value);
            void change("camera_route", {
              route: next
                ? {
                    host: next.host,
                    input: next.inputs[0]?.id ?? 1,
                    me: next.buses[0]?.me ?? 0,
                  }
                : null,
            });
          }}
        >
          <option value="">No tally mapping</option>
          {switchers.map((s) => (
            <option key={s.host} value={s.host}>
              {s.name}
              {s.connected ? "" : " · offline"}
            </option>
          ))}
          {route && !sw && (
            <option value={route.host}>{route.host} · offline</option>
          )}
        </select>
      </td>
      <td>
        <select
          aria-label={`${camera.name} ATEM input`}
          value={route?.input ?? ""}
          disabled={busy || !route}
          onChange={(e) =>
            void change("camera_route", {
              route: { ...route, input: Number(e.target.value) },
            })
          }
        >
          {!route && <option value="">—</option>}
          {sw?.inputs.map((i) => (
            <option key={i.id} value={i.id}>
              {i.id} · {i.name}
            </option>
          ))}
          {route && !sw?.inputs.some((i) => i.id === route.input) && (
            <option value={route.input}>{route.input} · unavailable</option>
          )}
        </select>
      </td>
      <td>
        <select
          aria-label={`${camera.name} program bus`}
          value={route?.me ?? ""}
          disabled={busy || !route}
          onChange={(e) =>
            void change("camera_route", {
              route: { ...route, me: Number(e.target.value) },
            })
          }
        >
          {!route && <option value="">—</option>}
          {sw?.buses.map((b) => (
            <option key={b.me} value={b.me}>
              M/E {b.me + 1}
            </option>
          ))}
          {route && !sw?.buses.some((b) => b.me === route.me) && (
            <option value={route.me}>M/E {route.me + 1} · unavailable</option>
          )}
        </select>
      </td>
    </tr>
  );
}

function ManualInput({
  perform,
  onRegistered,
}: {
  perform: Function;
  onRegistered: (s: CaptureSource) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  return (
    <details className="mapping-advanced">
      <summary>Advanced: manually register a video input</summary>
      <p className="form-note">
        DeckLink inputs normally appear after a scan. Use this only when you
        know the device’s exact subdevice name.
      </p>
      <form
        className="manual-input-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          setError("");
          setNote("");
          try {
            const device = String(data.get("device")).trim(),
              format = String(data.get("format")).trim();
            const source = await perform("capture_register", {
              id: `decklink:${device}`,
              name: String(data.get("name")).trim() || device,
              device,
              kind: "decklink",
              ...(format ? { format } : {}),
            });
            onRegistered(source);
            setNote("Input added. Choose it in the Video input column above.");
            form.reset();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Device / subdevice name
          <input name="device" required placeholder="DeckLink Quad 2 (1)" />
        </label>
        <label>
          Friendly name
          <input name="name" placeholder="SDI 1 · stage left" />
        </label>
        <label>
          Format code (optional)
          <input name="format" placeholder="Hp30" />
        </label>
        <button disabled={busy}>{busy ? "Adding…" : "Add input"}</button>
      </form>
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
    </details>
  );
}

export function BrightnessSettings({ status, perform }: SettingsProps) {
  const cameras: Camera[] = status?.cameras || [];
  return (
    <section className="brightness-settings">
      <div className="settings-page-heading">
        <div>
          <h3>Brightness limits</h3>
          <p>
            Set each camera’s limits for Simple controls. Shutter and ND stay
            fixed.
          </p>
        </div>
      </div>
      {cameras.map((camera) => (
        <BrightnessRow
          key={camera.id}
          camera={camera}
          initialPolicy={status.exposurePolicies?.[camera.id] || defaultPolicy}
          perform={perform}
        />
      ))}
      {!cameras.length && (
        <p className="form-note">
          Connect a camera to set its brightness limits.
        </p>
      )}
    </section>
  );
}
function BrightnessRow({
  camera,
  initialPolicy,
  perform,
}: {
  camera: Camera;
  initialPolicy: ExposurePolicy;
  perform: Function;
}) {
  const [policy, setPolicy] = useState(initialPolicy),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const act = async (fn: () => Promise<void>) => {
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
  };
  return (
    <div className="brightness-row">
      <details className="policy-settings">
        <summary>
          {camera.name} <span>{camera.model}</span>
        </summary>
        <p className="form-note">
          Iris first, then gain or ISO. Shutter and ND stay fixed. These are
          starting limits; set them for each lens and camera after testing.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={policy.preserveAperture}
            onChange={(e) =>
              setPolicy({ ...policy, preserveAperture: e.target.checked })
            }
          />
          Preserve aperture / depth of field
        </label>
        <div className="policy-grid">
          {(
            [
              ["minF", "Widest iris (f-number)", 0.7, 64, 0.1],
              ["maxF", "Smallest iris (f-number)", 0.7, 64, 0.1],
              ["minGain", "Minimum gain (dB)", -12, 36, 1],
              ["maxGain", "Maximum gain (dB)", -12, 36, 1],
              ["maxIso", "Maximum ISO", 50, 102400, 50],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <label key={key}>
              {label}
              <input
                aria-label={label}
                type="number"
                min={min}
                max={max}
                step={step}
                value={policy[key]}
                onChange={(e) =>
                  setPolicy({ ...policy, [key]: e.target.valueAsNumber })
                }
              />
            </label>
          ))}
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await perform("exposure_policy", { cameraId: camera.id, policy });
              setNote(
                "Brightness limits saved. Set a new starting point in Simple view.",
              );
            })
          }
        >
          Save brightness limits
        </button>
      </details>
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
    </div>
  );
}
