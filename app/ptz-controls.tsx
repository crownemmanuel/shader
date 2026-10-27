import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Camera } from "../engine/types";
import { command } from "./api";

type View = "joystick" | "arrows";
type Speed = "slow" | "normal" | "fast";
const speedScale: Record<Speed, number> = { slow: 0.35, normal: 0.65, fast: 1 };
// VISCA pan/tilt speed limits; the engine schema enforces the same bounds.
const PAN_MAX = 24,
  TILT_MAX = 20,
  ZOOM_MAX = 8,
  DEAD_ZONE = 0.12,
  // The engine stops movement after 600 ms of silence; refresh well inside it.
  KEEPALIVE_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function stored<T extends string>(key: string, allowed: T[], fallback: T) {
  try {
    const v = localStorage.getItem(key) as T;
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preference resets to the default without storage. */
  }
}
// Squared response gives fine control near the centre and full speed at the rim.
function speed(v: number, max: number, scale: number) {
  const a = Math.abs(v);
  if (a < DEAD_ZONE) return 0;
  const n = ((a - DEAD_ZONE) / (1 - DEAD_ZONE)) ** 2;
  return Math.sign(v) * Math.max(1, Math.round(n * max * scale));
}

export function PtzControls({
  camera,
  writable,
  busy,
  perform,
  onError,
}: {
  camera: Camera;
  writable: boolean;
  busy: boolean;
  perform: (name: string, args: unknown) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [view, setView] = useState<View>(() =>
    stored("shader.ptz-view", ["joystick", "arrows"], "joystick"),
  );
  const [pace, setPace] = useState<Speed>(() =>
    stored("shader.ptz-speed", ["slow", "normal", "fast"], "normal"),
  );
  useEffect(() => remember("shader.ptz-view", view), [view]);
  useEffect(() => remember("shader.ptz-speed", pace), [pace]);
  const safe = (p: Promise<unknown>) => void p.catch(() => {});
  return (
    <div className="ptz-controls">
      <div className="ptz-header">
        <span>
          Pan / tilt{" "}
          <small>
            {view === "joystick" ? "Drag or hold arrow keys" : "250 ms pulse"}
          </small>
        </span>
        <div
          className="view-switch ptz-switch"
          role="group"
          aria-label="Pan / tilt view"
        >
          {(["joystick", "arrows"] as View[]).map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              className={view === v ? "selected" : ""}
              onClick={() => setView(v)}
            >
              {v === "joystick" ? "Joystick" : "Arrows"}
            </button>
          ))}
        </div>
      </div>
      {view === "joystick" ? (
        <div className="ptz-joystick-row">
          <Joystick
            key={camera.id}
            cameraId={camera.id}
            disabled={!writable}
            scale={speedScale[pace]}
            onError={onError}
          />
          <ZoomRocker
            key={`zoom:${camera.id}`}
            cameraId={camera.id}
            disabled={!writable}
            scale={speedScale[pace]}
            onError={onError}
          />
          <div className="ptz-side">
            <div
              className="view-switch ptz-switch"
              role="group"
              aria-label="Joystick and zoom speed"
            >
              {(["slow", "normal", "fast"] as Speed[]).map((s) => (
                <button
                  key={s}
                  aria-pressed={pace === s}
                  className={pace === s ? "selected" : ""}
                  onClick={() => setPace(s)}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <StopButton cameraId={camera.id} perform={perform} safe={safe} />
          </div>
        </div>
      ) : (
        <div className="ptz-arrows">
          {(
            [
              [-8, 0, ArrowLeft, "Pan left"],
              [0, -8, ArrowUp, "Tilt up"],
              [0, 8, ArrowDown, "Tilt down"],
              [8, 0, ArrowRight, "Pan right"],
            ] as const
          ).map(([pan, tilt, Icon, label]) => (
            <button
              className="icon"
              key={label}
              disabled={busy || !writable}
              aria-label={label}
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
              <Icon size={17} />
            </button>
          ))}
          <StopButton cameraId={camera.id} perform={perform} safe={safe} />
        </div>
      )}
    </div>
  );
}

function StopButton({
  cameraId,
  perform,
  safe,
}: {
  cameraId: string;
  perform: (name: string, args: unknown) => Promise<unknown>;
  safe: (p: Promise<unknown>) => void;
}) {
  return (
    <button onClick={() => safe(perform("ptz_stop", { cameraId }))}>
      <Square size={13} />
      Stop
    </button>
  );
}

function Joystick({
  cameraId,
  disabled,
  scale,
  onError,
}: {
  cameraId: string;
  disabled: boolean;
  scale: number;
  onError: (message: string) => void;
}) {
  const base = useRef<HTMLDivElement>(null),
    [knob, setKnob] = useState({ x: 0, y: 0 }),
    [held, setHeld] = useState(false),
    keys = useRef(new Set<string>()),
    scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [shown, setShown] = useState({ pan: 0, tilt: 0 });
  const drive = useHeldDrive(
    cameraId,
    "ptz_drive",
    { pan: 0, tilt: 0 },
    onError,
    () => {
      setKnob({ x: 0, y: 0 });
      setShown({ pan: 0, tilt: 0 });
    },
  );
  function aim(x: number, y: number) {
    const s = scaleRef.current,
      next = { pan: speed(x, PAN_MAX, s), tilt: speed(y, TILT_MAX, s) };
    if (!drive.set(next)) return;
    setKnob({ x, y });
    setShown(next);
  }
  function release() {
    keys.current.clear();
    setHeld(false);
    drive.reset();
    aim(0, 0);
  }
  function point(e: React.PointerEvent) {
    const r = base.current!.getBoundingClientRect(),
      radius = r.width / 2;
    let x = (e.clientX - r.left - radius) / radius,
      y = (e.clientY - r.top - radius) / radius;
    const d = Math.hypot(x, y);
    if (d > 1) {
      x /= d;
      y /= d;
    }
    aim(x, y);
  }
  function fromKeys() {
    const k = keys.current,
      x = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0),
      y = (k.has("ArrowDown") ? 1 : 0) - (k.has("ArrowUp") ? 1 : 0),
      d = Math.hypot(x, y) || 1;
    // Keys drive at roughly two-thirds deflection for a steady, usable pace.
    aim((x / d) * 0.8, (y / d) * 0.8);
  }
  useReleaseWhen(drive, disabled, release);
  const travel = 36; // Knob travel from centre, in % of the base width.
  return (
    <div className="ptz-joystick-wrap">
      <div
        ref={base}
        className={`ptz-joystick ${held ? "held" : ""} ${disabled ? "disabled" : ""}`}
        tabIndex={disabled ? -1 : 0}
        role="application"
        aria-label="Pan and tilt joystick. Drag the knob, or hold arrow keys. Release to stop."
        aria-disabled={disabled}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drive.reset();
          setHeld(true);
          point(e);
        }}
        onPointerMove={(e) => {
          if (held) point(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={() => held && release()}
        onKeyDown={(e) => {
          if (disabled || !e.key.startsWith("Arrow")) return;
          e.preventDefault();
          if (keys.current.has(e.key)) return;
          if (!keys.current.size) drive.reset();
          keys.current.add(e.key);
          setHeld(true);
          fromKeys();
        }}
        onKeyUp={(e) => {
          if (!keys.current.delete(e.key)) return;
          if (keys.current.size) fromKeys();
          else release();
        }}
        onBlur={() => keys.current.size && release()}
      >
        <span className="ptz-joystick-cross" aria-hidden="true" />
        <span
          className="ptz-joystick-knob"
          aria-hidden="true"
          style={{
            transform: `translate(calc(-50% + ${knob.x * travel}cqw), calc(-50% + ${knob.y * travel}cqw))`,
          }}
        />
      </div>
      <span className="ptz-readout" aria-live="off">
        Pan {shown.pan > 0 ? "+" : ""}
        {shown.pan} · Tilt {shown.tilt < 0 ? "+" : ""}
        {-shown.tilt || 0}
      </span>
    </div>
  );
}

type Speeds = Record<string, number>;
const moving = (t: Speeds) => Object.values(t).some(Boolean);
const same = (a: Speeds, b: Speeds) =>
  Object.keys(a).every((k) => a[k] === b[k]);
/**
 * Streams held-control speeds to a dead-man engine command. One request in
 * flight at a time keeps drive and stop in order; unchanged speeds are
 * re-sent as a keepalive, and zero speeds send one final stop.
 */
export function useHeldDrive(
  cameraId: string,
  name: string,
  zero: Speeds,
  onError: (message: string) => void,
  onFail: () => void,
) {
  const target = useRef(zero),
    running = useRef(false),
    failed = useRef(false);
  async function pump() {
    if (running.current) return;
    running.current = true;
    let sent = zero,
      sentAt = 0;
    try {
      for (;;) {
        const t = target.current;
        if (!moving(t)) {
          if (moving(sent)) await command(name, { cameraId, ...zero });
          break;
        }
        if (!same(t, sent) || Date.now() - sentAt >= KEEPALIVE_MS) {
          await command(name, { cameraId, ...t });
          sent = t;
          sentAt = Date.now();
        } else await sleep(30);
      }
    } catch (e) {
      failed.current = true;
      target.current = zero;
      onFail();
      onError((e as Error).message);
      await command("ptz_stop", { cameraId }).catch(() => {});
    } finally {
      running.current = false;
      if (moving(target.current) && !failed.current) void pump();
    }
  }
  return {
    target,
    /** Returns false while a failure is latched (until reset on the next press). */
    set(next: Speeds) {
      if (failed.current) return false;
      target.current = next;
      void pump();
      return true;
    },
    reset() {
      failed.current = false;
    },
    zero,
  };
}
// Losing focus, locking or switching cameras must never leave the head moving.
export function useReleaseWhen(
  drive: ReturnType<typeof useHeldDrive>,
  disabled: boolean,
  release: () => void,
) {
  useEffect(() => {
    const blur = () => moving(drive.target.current) && release();
    const hidden = () => document.hidden && blur();
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
      // A running pump sees the zero target and sends the stop itself.
      drive.target.current = drive.zero;
    };
  }, []);
  useEffect(() => {
    if (disabled && moving(drive.target.current)) release();
  }, [disabled]);
}

function ZoomRocker({
  cameraId,
  disabled,
  scale,
  onError,
}: {
  cameraId: string;
  disabled: boolean;
  scale: number;
  onError: (message: string) => void;
}) {
  const track = useRef<HTMLDivElement>(null),
    [level, setLevel] = useState(0),
    [held, setHeld] = useState(false),
    [shown, setShown] = useState(0),
    key = useRef<string | undefined>(undefined),
    scaleRef = useRef(scale);
  scaleRef.current = scale;
  const drive = useHeldDrive(
    cameraId,
    "ptz_zoom",
    { speed: 0 },
    onError,
    () => {
      setLevel(0);
      setShown(0);
    },
  );
  // v is -1 (full wide) … 1 (full tele).
  function aim(v: number) {
    const next = speed(v, ZOOM_MAX, scaleRef.current);
    if (!drive.set({ speed: next })) return;
    setLevel(v);
    setShown(next);
  }
  function release() {
    key.current = undefined;
    setHeld(false);
    drive.reset();
    aim(0);
  }
  function point(e: React.PointerEvent) {
    const r = track.current!.getBoundingClientRect(),
      half = r.height / 2;
    aim(Math.max(-1, Math.min(1, (r.top + half - e.clientY) / half)));
  }
  useReleaseWhen(drive, disabled, release);
  const travel = 36; // Knob travel from centre, in % of the track height.
  return (
    <div className="ptz-joystick-wrap">
      <div
        ref={track}
        className={`ptz-zoom ${held ? "held" : ""} ${disabled ? "disabled" : ""}`}
        tabIndex={disabled ? -1 : 0}
        role="application"
        aria-label="Zoom rocker. Drag up to zoom in, down to zoom out, or hold the up and down arrow keys. Release to stop."
        aria-disabled={disabled}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drive.reset();
          setHeld(true);
          point(e);
        }}
        onPointerMove={(e) => {
          if (held) point(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={() => held && release()}
        onKeyDown={(e) => {
          if (disabled || (e.key !== "ArrowUp" && e.key !== "ArrowDown"))
            return;
          e.preventDefault();
          if (key.current === e.key) return;
          if (!key.current) drive.reset();
          key.current = e.key;
          setHeld(true);
          aim(e.key === "ArrowUp" ? 0.8 : -0.8);
        }}
        onKeyUp={(e) => {
          if (e.key === key.current) release();
        }}
        onBlur={() => key.current && release()}
      >
        <ZoomIn className="ptz-zoom-end tele" size={15} aria-hidden="true" />
        <ZoomOut className="ptz-zoom-end wide" size={15} aria-hidden="true" />
        <span
          className="ptz-zoom-knob"
          aria-hidden="true"
          style={{
            transform: `translate(-50%, calc(-50% + ${-level * travel}cqh))`,
          }}
        />
      </div>
      <span className="ptz-readout" aria-live="off">
        {shown > 0 ? `In ${shown}` : shown < 0 ? `Out ${-shown}` : "Zoom"}
      </span>
    </div>
  );
}
