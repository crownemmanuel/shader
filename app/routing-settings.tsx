import React, { useState } from "react";
import { Video, Radio, SlidersHorizontal } from "lucide-react";
import type { Camera, CaptureSource } from "../engine/types";
import { defaultPolicy, type ExposurePolicy } from "../engine/shading";
import type { SwitcherInfo } from "../engine/routing";
export function RoutingSettings({
  status,
  perform,
}: {
  status: any;
  perform: Function;
}) {
  const [selected, setSelected] = useState(status?.cameras?.[0]?.id || "");
  const cameras: Camera[] = status?.cameras || [],
    camera = cameras.find((c) => c.id === selected);
  return (
    <section className="routing-settings">
      <h3>
        <Video size={18} />
        Camera inputs & live status
      </h3>
      <p className="form-note">
        Match each camera to its physical SDI input and the ATEM bus feeding
        your audience. The monitor and agents use this same map.
      </p>
      {cameras.length ? (
        <>
          <label>
            Camera
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {camera && (
            <RouteForm
              key={camera.id}
              camera={camera}
              status={status}
              perform={perform}
            />
          )}
        </>
      ) : (
        <p className="form-note">
          Connect a camera or start the simulator to configure inputs.
        </p>
      )}
    </section>
  );
}
function RouteForm({
  camera,
  status,
  perform,
}: {
  camera: Camera;
  status: any;
  perform: Function;
}) {
  const [host, setHost] = useState(camera.tallyRoute?.host || ""),
    [input, setInput] = useState(camera.tallyRoute?.input ?? 1),
    [me, setMe] = useState(camera.tallyRoute?.me ?? 0),
    [source, setSource] = useState(camera.sourceId || ""),
    [sources, setSources] = useState<CaptureSource[]>(
      status.captureSources || [],
    ),
    [policy, setPolicy] = useState<ExposurePolicy>(
      status.exposurePolicies?.[camera.id] || defaultPolicy,
    ),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false);
  const switchers: SwitcherInfo[] = status.switchers || [],
    sw = switchers.find((s) => s.host === host);
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
    <div className="routing-form">
      <div className="form-row">
        <label>
          ATEM switcher
          <select value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">Tally not mapped</option>
            {switchers.map((s) => (
              <option key={s.host} value={s.host}>
                {s.name} · {s.host}
                {s.connected ? "" : " · offline"}
              </option>
            ))}
            {host && !sw && <option value={host}>{host} · offline</option>}
          </select>
        </label>
        <label>
          Audience program bus
          <select value={me} onChange={(e) => setMe(Number(e.target.value))}>
            {(sw?.buses.length ? sw.buses : [{ me: 0 }, { me: 1 }]).map((b) => (
              <option key={b.me} value={b.me}>
                M/E {b.me + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      {host && (
        <label>
          Camera’s ATEM input
          <select
            value={input}
            onChange={(e) => setInput(Number(e.target.value))}
          >
            {sw?.inputs.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} · {i.name}
              </option>
            ))}
            {!sw?.inputs.some((i) => i.id === input) && (
              <option value={input}>Input {input} · unavailable</option>
            )}
          </select>
        </label>
      )}
      <label>
        Camera’s video capture input
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">No capture input</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.kind}
            </option>
          ))}
          {source && !sources.some((s) => s.id === source) && (
            <option value={source}>{source}</option>
          )}
        </select>
      </label>
      <div className="form-row">
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const r = await perform("capture_sources");
              setSources(r.sources);
              setNote(r.diagnostics.join(" "));
            })
          }
        >
          Find video inputs
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await perform("camera_route", {
                cameraId: camera.id,
                route: host ? { host, input, me } : null,
              });
              await perform("capture_assign", {
                cameraId: camera.id,
                sourceId: source || null,
              });
              setNote("Camera routing saved.");
            })
          }
        >
          Save camera mapping
        </button>
      </div>
      <details>
        <summary>Register a DeckLink / SDI input</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget),
              device = String(f.get("device")),
              format = String(f.get("format"));
            void act(async () => {
              const s = await perform("capture_register", {
                id: `decklink:${device}`,
                name: String(f.get("name")) || device,
                device,
                kind: "decklink",
                ...(format ? { format } : {}),
              });
              setSources((prev) => [...prev.filter((p) => p.id !== s.id), s]);
              setSource(s.id);
              setNote("Input registered. Save camera mapping to assign it.");
            });
          }}
        >
          <label>
            Device / subdevice name
            <input name="device" required placeholder="DeckLink Quad 2 (1)" />
          </label>
          <div className="form-row">
            <label>
              Friendly label
              <input name="name" placeholder="SDI 1 · stage left" />
            </label>
            <label>
              Format code (optional)
              <input name="format" placeholder="Hp30" />
            </label>
          </div>
          <button disabled={busy}>Register input</button>
        </form>
        <p className="form-note">
          Register each of your card’s capture subdevices separately. Use the
          names reported by Desktop Video / FFmpeg on the capture computer.
        </p>
      </details>
      <details className="policy-settings">
        <summary>Simple brightness limits</summary>
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
