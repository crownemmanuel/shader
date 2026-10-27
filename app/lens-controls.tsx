import React, { useId, useRef, useState } from "react";
import { useHeldDrive, useReleaseWhen } from "./ptz-controls";
import "./lens-controls.css";

const sliderKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** A speed control that returns to stop, never a persistent zoom position. */
export function LensZoomSlider({
  cameraId,
  disabled,
}: {
  cameraId: string;
  disabled: boolean;
}) {
  const id = useId(),
    held = useRef(false);
  const [level, setLevel] = useState(0),
    [error, setError] = useState("");
  const drive = useHeldDrive(
    cameraId,
    "lens_zoom",
    { speed: 0 },
    setError,
    () => {
      held.current = false;
      setLevel(0);
    },
  );
  function begin() {
    if (disabled) return;
    if (!held.current) {
      drive.reset();
      setError("");
    }
    held.current = true;
  }
  function release() {
    held.current = false;
    drive.set({ speed: 0 });
    setLevel(0);
  }
  useReleaseWhen(drive, disabled, release);
  const status =
    level === 0
      ? "Stopped"
      : `${level < 0 ? "Out" : "In"} ${Math.round(Math.abs(level) * 100)}%`;
  return (
    <div className="control lens-zoom-control">
      <div className="visual-slider lens-zoom-slider">
        <div className="slider-label">
          <label htmlFor={id}>Zoom</label>
          <output htmlFor={id}>{status}</output>
        </div>
        <input
          id={id}
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={level}
          disabled={disabled}
          aria-valuetext={
            level === 0
              ? "Stop"
              : `Zoom ${level < 0 ? "out" : "in"} at ${Math.round(Math.abs(level) * 100)} percent speed`
          }
          aria-describedby={`${id}-help`}
          onPointerDown={(e) => {
            if (disabled || e.button !== 0 || !e.isPrimary) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            begin();
          }}
          onChange={(e) => {
            if (!held.current || disabled) return;
            const speed = Number(e.target.value);
            if (drive.set({ speed })) setLevel(speed);
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onKeyDown={(e) => {
            if (sliderKeys.has(e.key)) begin();
            if (e.key === "Escape") {
              e.preventDefault();
              release();
            }
          }}
          onKeyUp={(e) => {
            if (sliderKeys.has(e.key)) release();
          }}
          onBlur={release}
        />
        <div className="slider-endpoints" aria-hidden="true">
          <span>Zoom out</span>
          <span>Stop</span>
          <span>Zoom in</span>
        </div>
      </div>
      <p className="helper" id={`${id}-help`}>
        Hold and slide. Release to stop.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
