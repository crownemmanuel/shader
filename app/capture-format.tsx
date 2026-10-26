import React, { useState } from "react";
import type { CaptureSource } from "../engine/types";

export function CaptureFormatSelect({
  source,
  perform,
  onChange,
}: {
  source?: CaptureSource;
  perform: Function;
  onChange: (source: CaptureSource) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (source?.kind !== "decklink" || !source.modes?.length) return null;
  return (
    <div>
      <label>
        Input video format
        <select
          value={source.format || ""}
          disabled={busy || source.available === false}
          onChange={async (event) => {
            const format = event.target.value;
            setBusy(true);
            setError("");
            try {
              onChange(
                await perform("capture_format", {
                  sourceId: source.id,
                  ...(format ? { format } : {}),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="" disabled={source.supportsAutoDetection === false}>
            {source.supportsAutoDetection === false
              ? "Choose a video format"
              : "Detect automatically"}
          </option>
          {source.modes.map((mode) => (
            <option key={mode.code} value={mode.code}>
              {mode.name}
            </option>
          ))}
        </select>
      </label>
      <p className="form-note">
        {busy
          ? "Applying video format…"
          : "Match the camera’s SDI output. Changing the format briefly restarts its preview."}
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
