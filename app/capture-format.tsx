import React, { useState } from "react";
import type { CaptureSource } from "../engine/types";

export function CaptureFormatSelect({
  source,
  perform,
  onChange,
  compact = false,
  label = "Input video format",
}: {
  source?: CaptureSource;
  perform: Function;
  onChange: (source: CaptureSource) => void;
  compact?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (source?.kind !== "decklink" || !source.modes?.length) return null;
  return (
    <div className={compact ? "capture-format-compact" : undefined}>
      <label>
        {!compact && label}
        <select
          aria-label={label}
          title="Match the camera’s SDI output. Changes apply to all cameras sharing this input and briefly restart its preview."
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
          {source.format &&
            !source.modes.some((mode) => mode.code === source.format) && (
              <option value={source.format}>
                {source.format} · unavailable
              </option>
            )}
        </select>
      </label>
      {(!compact || busy) && (
        <p className="form-note" role="status">
          {busy
            ? "Applying video format…"
            : "Match the camera’s SDI output. Changing the format briefly restarts its preview."}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
