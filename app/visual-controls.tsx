import React, { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  Thermometer,
  Droplets,
  RotateCcw,
  Lock,
  SlidersHorizontal,
} from "lucide-react";
import type { Camera, Control, Frame } from "../engine/types";
import {
  axes,
  encodeAxis,
  type Axis,
  type ShadeIntent,
} from "../engine/shading";
import { command } from "./api";

export function LiveMonitor({
  camera,
  onAssign,
}: {
  camera: Camera;
  onAssign: () => void;
}) {
  const [frame, setFrame] = useState<Frame>(),
    [state, setState] = useState("waiting"),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false,
      lease = "",
      timer: ReturnType<typeof setTimeout>,
      sequence = 0;
    setFrame(undefined);
    setState("waiting");
    setError("");
    if (!camera.sourceId) return;
    const poll = async () => {
      try {
        const r = await command("preview_frame", {
          cameraId: camera.id,
          leaseId: lease,
          afterSequence: sequence,
        });
        if (cancelled) return;
        sequence = r.sequence;
        setState(r.status);
        if (r.frame) setFrame(r.frame);
        timer = setTimeout(poll, 125);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setState("error");
        }
        if (lease)
          void command("preview_close", { leaseId: lease }).catch(() => {});
      }
    };
    void command("preview_open", { cameraId: camera.id })
      .then((r) => {
        lease = r.leaseId;
        if (cancelled)
          void command("preview_close", { leaseId: lease }).catch(() => {});
        else void poll();
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (lease)
        void command("preview_close", { leaseId: lease }).catch(() => {});
    };
  }, [camera.id, camera.sourceId, retry]);
  const live = state === "live" && frame;
  return (
    <section
      className={`monitor ${camera.tally === "program" ? "on-air-monitor" : ""}`}
      aria-label="Live camera monitor"
    >
      {frame && (
        <img
          src={`data:image/jpeg;base64,${frame.data}`}
          alt={`Live input for ${camera.name}`}
          className={live ? "" : "stale-frame"}
        />
      )}
      {!live && (
        <div className="monitor-empty">
          <div className="framing">
            <span />
            <span />
            <span />
            <span />
            <SlidersHorizontal size={30} />
          </div>
          <strong>
            {error
              ? "Preview unavailable"
              : camera.sourceId
                ? "Waiting for video signal"
                : camera.vendor === "demo"
                  ? "Camera simulator"
                  : "Connect the picture"}
          </strong>
          <p>
            {error ||
              (camera.sourceId
                ? "The mapped input will appear here as soon as frames arrive."
                : camera.vendor === "demo"
                  ? "Controls are simulated. Assign a real capture input to see video."
                  : "Map this camera to its DeckLink / SDI input in Settings.")}
          </p>
          <button onClick={error ? () => setRetry((v) => v + 1) : onAssign}>
            {error ? "Retry preview" : "Assign video input"}
          </button>
        </div>
      )}
      <div className={`monitor-tag ${live ? "live-preview" : ""}`}>
        <span className={`status-dot ${live ? "online" : ""}`} />
        {live
          ? "Live preview · 8 fps"
          : frame
            ? "Signal lost · last frame"
            : "No video signal"}
      </div>
      {camera.tally === "program" && (
        <div className="on-air-badge">● ON AIR</div>
      )}
      {live && (
        <span className="monitor-timestamp">
          {new Date(frame.capturedAt).toLocaleTimeString()} · {camera.sourceId}
        </span>
      )}
    </section>
  );
}
export function VisualSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  theme = "",
  left,
  right,
  unit = "",
  disabled = false,
  onCommit,
  precise = true,
  choices,
  logarithmic = false,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  theme?: string;
  left?: string;
  right?: string;
  unit?: string;
  disabled?: boolean;
  onCommit?: (n: number) => void;
  precise?: boolean;
  choices?: number[];
  logarithmic?: boolean;
}) {
  const fromPosition = (n: number) =>
    choices?.length
      ? choices[Math.round(n)]
      : logarithmic
        ? Math.round(2 ** n / step) * step
        : n;
  const position = choices?.length
    ? choices.reduce(
        (best, n, i) =>
          Math.abs(n - value) < Math.abs(choices[best] - value) ? i : best,
        0,
      )
    : logarithmic
      ? Math.log2(value)
      : value;
  const spoken =
    unit === "ƒ"
      ? `ƒ/${value.toFixed(1)}`
      : unit === "1/s"
        ? `1/${Number(value.toFixed(2))} s`
        : `${Number(value.toFixed(2))} ${unit}`;
  return (
    <div className={`visual-slider ${theme}`}>
      <div className="slider-label">
        <span>{label}</span>
        <output>
          {unit === "ƒ"
            ? `ƒ/${value.toFixed(1)}`
            : unit === "1/s"
              ? `1/${Number(value.toFixed(2))} s`
              : `${Number(value.toFixed(2))}${unit ? " " + unit : ""}`}
        </output>
      </div>
      <input
        aria-label={label}
        type="range"
        min={choices?.length ? 0 : logarithmic ? Math.log2(min) : min}
        max={
          choices?.length
            ? choices.length - 1
            : logarithmic
              ? Math.log2(max)
              : max
        }
        step={choices?.length ? 1 : logarithmic ? 0.025 : step}
        value={position}
        aria-valuetext={spoken}
        disabled={disabled}
        onChange={(e) => onChange(fromPosition(e.target.valueAsNumber))}
        onPointerUp={(e) =>
          onCommit?.(fromPosition(e.currentTarget.valueAsNumber))
        }
        onKeyUp={(e) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(e.key)
          )
            onCommit?.(fromPosition(e.currentTarget.valueAsNumber));
        }}
      />
      {(left || right) && (
        <div className="slider-endpoints">
          <span>{left}</span>
          <span>{right}</span>
        </div>
      )}
      {precise && (
        <details className="fine-tune">
          <summary>Fine-tune number</summary>
          <NumberField
            label={`${label} precise value`}
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onLive={onChange}
            onCommit={(n) => (onCommit ? onCommit(n) : onChange(n))}
          />
        </details>
      )}
    </div>
  );
}
const zero: ShadeIntent = { brightness: 0, warmth: 0, tint: 0 };
export function SimpleControls({
  camera,
  disabled,
  perform,
  advanced,
}: {
  camera: Camera & { shade?: { sessionId: string; synced: boolean } };
  disabled: boolean;
  perform: Function;
  advanced: () => void;
}) {
  const [session, setSession] = useState<any>(),
    [intent, setIntent] = useState(zero),
    [applied, setApplied] = useState(zero),
    [problem, setProblem] = useState("blue"),
    [strength, setStrength] = useState(0),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [note, setNote] = useState("");
  const mounted = useRef(true),
    rebasing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function begin(reason = "") {
    rebasing.current = true;
    try {
      const r = await command("shade_begin", { cameraId: camera.id });
      if (!mounted.current) return;
      setSession(r);
      setIntent(zero);
      setApplied(zero);
      setStrength(0);
      setError("");
      setNote(reason);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      rebasing.current = false;
    }
  }
  const external =
    "Updated from another console. Sliders now start from the live values.";
  // Another console changed this camera: re-anchor so the sliders stay relative to what is live.
  // A different session id means another window or agent owns the anchor; don't fight it.
  // Wait briefly so a late switcher echo of our own write isn't mistaken for another console.
  const shadeNow = useRef(camera.shade);
  shadeNow.current = camera.shade;
  useEffect(() => {
    if (!session || sending) return;
    const stale = () => {
      const shade = shadeNow.current;
      return !!shade && shade.sessionId === session.sessionId && !shade.synced;
    };
    if (!stale()) return;
    const timer = setTimeout(() => {
      if (stale() && !running.current && !rebasing.current) void begin(external);
    }, 400);
    return () => clearTimeout(timer);
  }, [camera.shade?.sessionId, camera.shade?.synced, session, sending]);
  useEffect(() => {
    void begin();
  }, [camera.id]);
  // Stream the recipe while dragging: the newest intent goes out as soon as the previous one lands.
  // Sent with command(), not perform(), so the app-wide busy state never freezes a slider mid-drag.
  const pending = useRef<{ intent: ShadeIntent; final: boolean } | undefined>(
      undefined,
    ),
    running = useRef(false);
  async function pump() {
    if (running.current) return;
    running.current = true;
    setSending(true);
    setError("");
    try {
      while (pending.current && session) {
        const next = pending.current;
        pending.current = undefined;
        const r = await command("shade_apply", {
          cameraId: camera.id,
          sessionId: session.sessionId,
          intent: next.intent,
          live: !next.final,
        });
        if (!mounted.current) return;
        setApplied(next.intent);
        setNote(
          Math.abs(r.remainingEV) > 0.05
            ? "Brightness limit reached. Shutter is still held."
            : r.completed.length
              ? `Adjusted ${r.completed.join(" + ")}.`
              : "",
        );
      }
    } catch (e) {
      pending.current = undefined;
      const message = (e as Error).message;
      setSession(undefined);
      if (/settings changed|changed during|state changed/i.test(message))
        void begin(`${external} Adjust again.`);
      else setError(message);
    } finally {
      running.current = false;
      setSending(false);
    }
  }
  function apply(next: ShadeIntent, final = true) {
    if (!session) return;
    setIntent(next);
    pending.current = { intent: next, final: final || !!pending.current?.final };
    void pump();
  }
  const cast = (v: number): ShadeIntent => ({
    ...intent,
    ...(["blue", "amber"].includes(problem)
      ? { warmth: (v / 100) * (problem === "blue" ? 1 : -1) }
      : { tint: (v / 100) * (problem === "green" ? 1 : -1) }),
  });
  const locked = disabled || !session,
    supports = session?.supported || {},
    a = axes(camera),
    shutter = a.find((a) => a.kind === "shutter");
  return (
    <section className="simple-controls" aria-label="Simple camera controls">
      <div className="simple-card brightness-card">
        <div className="simple-title">
          <Sun size={21} />
          <div>
            <h2>Fix brightness</h2>
            <p>A little darker. A little brighter.</p>
          </div>
        </div>
        <VisualSlider
          label="Brightness"
          value={intent.brightness}
          onChange={(v) => apply({ ...intent, brightness: v }, false)}
          min={-4}
          max={4}
          step={0.1}
          unit="stops"
          theme="brightness"
          left="Darker"
          right="Brighter"
          disabled={locked || !supports.brightness}
          precise={false}
          onCommit={(v) => apply({ ...intent, brightness: v })}
        />
        <div className="exposure-path">
          {session?.path ? (
            session.path.map((label: string, i: number) => (
              <React.Fragment key={label}>
                {i > 0 && <span>→</span>}
                <span>
                  {i + 1} · {label}
                </span>
              </React.Fragment>
            ))
          ) : (
            <>
              <span
                className={!session?.policy?.preserveAperture ? "" : "muted"}
              >
                1 · Iris {session?.policy?.preserveAperture ? "held" : ""}
              </span>
              <span>→</span>
              <span>2 · Gain / ISO</span>
            </>
          )}
          <span className="shutter-held">
            <Lock size={12} /> Shutter{" "}
            {shutter ? `1/${shutter.value} s` : "held"}
          </span>
        </div>
        <p className={supports.brightness ? "helper hint" : "helper"}>
          {session?.path
            ? supports.brightness
              ? "Walks native VISCA steps (about ½ stop each) on the control your exposure mode obeys. Gain stops at the camera’s gain limit."
              : "This exposure mode has no adjustable position. Choose Manual, Bright, Auto or a priority mode under Advanced › Exposure."
            : supports.brightness
              ? `Stops at your Settings limits. ${session?.policy?.preserveAperture ? "Aperture stays fixed." : "Iris changes depth of field; gain may add noise."}`
              : "No supported exposure recipe reported. Use Advanced until this camera’s control units are known."}
        </p>
      </div>
      <div className="simple-card color-card">
        <div className="simple-title">
          <Droplets size={21} />
          <div>
            <h2>Fix color</h2>
            <p>Bring whites back to neutral.</p>
          </div>
        </div>
        <VisualSlider
          label="Warmth"
          value={intent.warmth}
          onChange={(v) => apply({ ...intent, warmth: v }, false)}
          min={-1}
          max={1}
          step={0.02}
          theme="warmth"
          left="Cooler · blue"
          right="Warmer · amber"
          disabled={locked || !supports.warmth}
          precise={false}
          onCommit={(v) => apply({ ...intent, warmth: v })}
        />
        <VisualSlider
          label="Tint"
          value={intent.tint}
          onChange={(v) => apply({ ...intent, tint: v }, false)}
          min={-1}
          max={1}
          step={0.02}
          theme="tint"
          left="Greener"
          right="More magenta"
          disabled={locked || !supports.tint}
          precise={false}
          onCommit={(v) => apply({ ...intent, tint: v })}
        />
        {!supports.warmth && (
          <p className="helper">
            Manual white balance has not been reported in a supported unit.
          </p>
        )}
        {!supports.tint && (
          <p className="helper">
            A calibrated tint control is not available on this camera.
          </p>
        )}
        <details className="color-cast">
          <summary>What looks wrong?</summary>
          <div
            className="cast-options"
            role="group"
            aria-label="Unwanted color cast"
          >
            {["blue", "amber", "green", "magenta"].map((p) => (
              <button
                key={p}
                aria-pressed={problem === p}
                className={problem === p ? "selected" : ""}
                onClick={() => {
                  setProblem(p);
                  setStrength(0);
                }}
              >
                <i
                  style={{
                    background: {
                      blue: "#66aaff",
                      amber: "#efb461",
                      green: "#70cb97",
                      magenta: "#d982d0",
                    }[p],
                  }}
                />
                Too {p}
              </button>
            ))}
          </div>
          <VisualSlider
            label="Correction strength"
            min={0}
            max={100}
            value={strength}
            onChange={(v) => {
              setStrength(v);
              apply(cast(v), false);
            }}
            left="None"
            right="Stronger correction"
            precise={false}
            disabled={
              locked ||
              (["blue", "amber"].includes(problem)
                ? !supports.warmth
                : !supports.tint)
            }
            onCommit={(v) => apply(cast(v))}
          />
          <p className="helper hint">
            Adds the opposing correction from your starting point. Judge the
            result in the live preview.
          </p>
        </details>
      </div>
      <div className="simple-footer">
        <button
          className="quiet"
          disabled={sending}
          title="Use the current picture as the starting point"
          onClick={() => void begin()}
        >
          <RotateCcw size={14} />
          Reset start point
        </button>
        <button onClick={advanced}>
          Manual controls <SlidersHorizontal size={14} />
        </button>
      </div>
      {note && (
        <p className="helper" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Number box that keeps what the operator types; in-range values stream live, Enter or blur commits. */
export function NumberField({
  value,
  min,
  max,
  step,
  label,
  disabled,
  placeholder,
  onLive,
  onCommit,
}: {
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number | "any";
  label: string;
  disabled?: boolean;
  placeholder?: string;
  onLive: (n: number) => void;
  onCommit: (n: number) => void;
}) {
  const shown = value === undefined || Number.isNaN(value) ? "" : String(value);
  const [text, setText] = useState(shown),
    [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const parse = (t: string) => {
    const n = Number(t);
    return t.trim() !== "" &&
      Number.isFinite(n) &&
      n >= (min ?? -Infinity) &&
      n <= (max ?? Infinity)
      ? n
      : undefined;
  };
  return (
    <input
      type="number"
      aria-label={label}
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n !== undefined) onLive(n);
      }}
      onBlur={(e) => {
        setFocused(false);
        const n = parse(e.target.value);
        if (n !== undefined) onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/**
 * Streams an edited value to the camera. The newest value goes out as soon as the
 * previous write settles, so a drag gives live feedback without queueing stale writes.
 * Camera-reported values are ignored while editing, then adopted once writes settle.
 */
export function useLiveValue<T>(
  reported: T,
  send: (value: T, live: boolean) => Promise<unknown>,
) {
  const [value, setValue] = useState(reported),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false);
  const pending = useRef<{ value: T; final: boolean } | undefined>(undefined),
    running = useRef(false),
    settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const key = JSON.stringify(reported);
  useEffect(() => {
    if (!editing) setValue(reported);
  }, [key, editing]);
  useEffect(() => () => clearTimeout(settle.current), []);
  async function pump() {
    if (running.current) return;
    running.current = true;
    while (pending.current) {
      const next = pending.current;
      pending.current = undefined;
      try {
        await send(next.value, !next.final);
        setError("");
      } catch (e) {
        setError((e as Error).message);
      }
    }
    running.current = false;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setEditing(false), 400);
  }
  function change(next: T, final = false) {
    clearTimeout(settle.current);
    setEditing(true);
    setValue(next);
    pending.current = {
      value: next,
      final: final || !!pending.current?.final,
    };
    void pump();
  }
  return { value, change, error, editing };
}

export function AxisEditor({
  axis,
  control,
  disabled,
  onSet,
}: {
  axis: Axis;
  control: Control;
  disabled: boolean;
  onSet: (value: unknown, live: boolean) => Promise<unknown>;
}) {
  const { value, change, error, editing } = useLiveValue(axis.value, (v, live) =>
    onSet(encodeAxis(axis, v, control), live),
  );
  return (
    <div className="control visual-control">
      <VisualSlider
        label={axis.label}
        value={value}
        onChange={(v) => change(v)}
        onCommit={(v) => change(v, true)}
        min={axis.min}
        max={axis.max}
        step={axis.step}
        unit={axis.unit}
        choices={axis.choices?.map((c) => c.value)}
        logarithmic={
          ["shutter", "iris", "iso"].includes(axis.kind) && axis.min > 0
        }
        disabled={disabled}
        theme={
          axis.kind === "warmth"
            ? "warmth"
            : axis.kind === "tint"
              ? "tint"
              : axis.kind === "iris" ||
                  axis.kind === "gain" ||
                  axis.kind === "iso"
                ? "brightness"
                : ""
        }
        left={
          axis.kind === "warmth"
            ? "Cooler"
            : axis.kind === "tint"
              ? "Green"
              : axis.kind === "shutter"
                ? "Longer exposure"
                : undefined
        }
        right={
          axis.kind === "warmth"
            ? "Warmer"
            : axis.kind === "tint"
              ? "Magenta"
              : axis.kind === "shutter"
                ? "Shorter exposure"
                : undefined
        }
      />
      {control.note && (
        <p className="helper hint">
          {axis.encoding === "ptzKelvin"
            ? "Requires color-temperature white balance mode."
            : control.native?.category !== undefined
              ? "ATEM reports switcher values. Check the change in the picture."
              : control.note}
        </p>
      )}
      {axis.kind === "shutter" && (
        <p className="helper hint">
          Manual override. Match frame rate and lighting to avoid unwanted blur
          or flicker.
        </p>
      )}
      <div className="control-bottom">
        <small>
          {editing
            ? "Live"
            : control.freshness === "simulated"
              ? "Demo"
              : control.freshness === "requested"
                ? "Sent · awaiting readback"
                : "Camera value"}
        </small>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// Opponent-plane wheel: edits chroma around the current mean and preserves luma.
export function ColorWheel({
  control: c,
  disabled,
  onSet,
}: {
  control: Control;
  disabled: boolean;
  onSet: (v: unknown, live: boolean) => Promise<unknown>;
}) {
  const {
    value: v,
    change,
    error,
    editing,
  } = useLiveValue(c.value as number[], (n, live) => onSet(n, live));
  const mean = (v[0] + v[1] + v[2]) / 3,
    x = v[0] - mean,
    y = (v[1] - v[2]) / Math.sqrt(3),
    radius = 0.25;
  function move(nx: number, ny: number, final = false) {
    if (disabled) return;
    const l = Math.hypot(nx, ny);
    if (l > radius) {
      nx *= radius / l;
      ny *= radius / l;
    }
    const changes = [
      nx,
      -nx / 2 + (ny * Math.sqrt(3)) / 2,
      -nx / 2 - (ny * Math.sqrt(3)) / 2,
    ];
    const min = c.min ?? -2,
      max = c.max ?? 2;
    const n = [...v];
    changes.forEach(
      (d, i) =>
        (n[i] = Math.max(min, Math.min(max, Number((mean + d).toFixed(4))))),
    );
    change(n, final);
  }
  function pointer(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    move(
      ((e.clientX - r.left - r.width / 2) / (r.width * 0.4)) * radius,
      (-(e.clientY - r.top - r.height / 2) / (r.height * 0.4)) * radius,
    );
  }
  return (
    <div className="control wheel-card">
      <div className="control-title">
        <h3>{c.label}</h3>
        <small>
          {c.label === "Lift"
            ? "Shadows"
            : c.label === "Gamma"
              ? "Midtones"
              : c.label === "Gain"
                ? "Highlights"
                : "Balance"}
        </small>
      </div>
      <div
        className="color-wheel"
        role="group"
        aria-label={`${c.label} color wheel`}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) pointer(e);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            change(v, true);
        }}
        onKeyDown={(e) => {
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            move(
              x +
                (e.key === "ArrowRight"
                  ? 0.01
                  : e.key === "ArrowLeft"
                    ? -0.01
                    : 0),
              y +
                (e.key === "ArrowUp"
                  ? 0.01
                  : e.key === "ArrowDown"
                    ? -0.01
                    : 0),
              true,
            );
          }
        }}
      >
        <div className="wheel-face">
          <i />
          <b />
        </div>
        <span
          className="wheel-puck"
          style={{
            left: `${50 + Math.max(-1, Math.min(1, x / radius)) * 40}%`,
            top: `${50 - Math.max(-1, Math.min(1, y / radius)) * 40}%`,
          }}
        />
      </div>
      <div className="wheel-caption hint">
        Drag toward a color · arrow keys to refine
      </div>
      <VisualSlider
        label={`${c.label} master`}
        value={v[3]}
        onChange={(n) => change([v[0], v[1], v[2], n])}
        onCommit={(n) => change([v[0], v[1], v[2], n], true)}
        min={c.label === "Gain" ? 0 : -0.5}
        max={c.label === "Gain" ? 2 : 0.5}
        step={0.01}
        disabled={disabled}
        theme="brightness"
        precise={false}
      />
      <details className="fine-tune">
        <summary>Fine-tune R / G / B / master</summary>
        <div className="vector-fields">
          {v.map((n, i) => (
            <label key={i}>
              {["R", "G", "B", "Y"][i]}
              <NumberField
                label={`${c.label} ${["red", "green", "blue", "master"][i]}`}
                value={n}
                step={0.01}
                min={c.min}
                max={c.max}
                disabled={disabled}
                onLive={(x) => change(v.map((y, j) => (i === j ? x : y)))}
                onCommit={(x) =>
                  change(
                    v.map((y, j) => (i === j ? x : y)),
                    true,
                  )
                }
              />
            </label>
          ))}
        </div>
      </details>
      <div className="control-bottom">
        <small>
          {editing ? "Live" : c.freshness === "simulated" ? "Demo" : c.freshness}
        </small>
        <button
          className="quiet"
          disabled={disabled}
          onClick={() => {
            const neutral = c.label === "Gain" ? 1 : 0;
            change([neutral, neutral, neutral, v[3]], true);
          }}
        >
          Neutral color
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
