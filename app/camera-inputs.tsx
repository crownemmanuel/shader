import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/** Settings tab: choose which ATEM inputs appear as camera buttons. */
export function CameraInputsSettings({
  status,
  perform,
}: {
  status: any;
  perform: Function;
}) {
  const [error, setError] = useState("");
  const switchers: {
    host: string;
    name: string;
    connected: boolean;
    inputs: { id: number; name: string }[];
  }[] = status?.switchers || [];
  const hidden = new Set<string>(status?.hiddenCameras || []);
  const cameras: { id: string; name: string; vendor: string }[] =
    status?.cameras || [];
  const reporting = new Set(cameras.map((c) => c.id));
  const others = cameras.filter((c) => c.vendor !== "atem");
  const set = async (ids: string[], hide: boolean) => {
    try {
      await perform("cameras_hide", { cameraIds: ids, hidden: hide });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!switchers.length && !others.length)
    return (
      <div className="form">
        <p className="form-note">
          Connect a Blackmagic ATEM switcher and its inputs appear here, so you
          can choose which ones show as camera buttons.
        </p>
      </div>
    );
  return (
    <div className="form camera-inputs">
      <p className="form-note">
        Untick inputs that aren't cameras (media, lyrics, ME feeds). Hidden
        inputs stay connected for tally, presets and agents, and stay hidden
        after a restart. You can also right-click a camera button and choose
        Hide.
      </p>
      {switchers.map((sw) => {
        // Physical inputs only; internal sources (bars, media players, ME outputs) start at 1000.
        const inputs = sw.inputs.filter((i) => i.id >= 1 && i.id < 1000);
        const id = (input: number) => `atem-${sw.host}-${input}`;
        const ids = inputs.map((i) => id(i.id));
        const shown = ids.filter((x) => !hidden.has(x)).length;
        return (
          <section key={sw.host} className="camera-inputs-switcher">
            <div className="camera-inputs-heading">
              <h3>
                {sw.name} <small>{sw.host}</small>
              </h3>
              <span>
                {shown} of {inputs.length} shown
              </span>
              <button
                className="quiet"
                disabled={shown === ids.length}
                onClick={() => void set(ids, false)}
              >
                <Eye size={13} />
                Show all
              </button>
              <button
                className="quiet"
                disabled={shown === 0}
                onClick={() => void set(ids, true)}
              >
                <EyeOff size={13} />
                Hide all
              </button>
            </div>
            <div className="camera-inputs-list">
              {inputs.map((input) => {
                const cameraId = id(input.id),
                  visible = !hidden.has(cameraId);
                return (
                  <label
                    key={input.id}
                    className={visible ? "" : "hidden-input"}
                    title={
                      reporting.has(cameraId)
                        ? "Reports camera control"
                        : "No camera control reported yet"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) => void set([cameraId], !e.target.checked)}
                    />
                    <span className="camera-input-number">{input.id}</span>
                    <span className="camera-input-name">{input.name}</span>
                  </label>
                );
              })}
            </div>
          </section>
        );
      })}
      {others.length > 0 && (
        <section className="camera-inputs-switcher">
          <div className="camera-inputs-heading">
            <h3>Other cameras</h3>
          </div>
          <div className="camera-inputs-list">
            {others.map((c) => (
              <label
                key={c.id}
                className={hidden.has(c.id) ? "hidden-input" : ""}
              >
                <input
                  type="checkbox"
                  checked={!hidden.has(c.id)}
                  onChange={(e) => void set([c.id], !e.target.checked)}
                />
                <span className="camera-input-name">{c.name}</span>
              </label>
            ))}
          </div>
        </section>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
