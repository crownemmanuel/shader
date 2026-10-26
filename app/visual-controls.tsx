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
          <input
            type="number"
            aria-label={`${label} precise value`}
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(e) => {
              if (Number.isFinite(e.target.valueAsNumber))
                onChange(e.target.valueAsNumber);
            }}
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
  camera: Camera;
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function begin() {
    try {
      const r = await command("shade_begin", { cameraId: camera.id });
      if (!mounted.current) return;
      setSession(r);
      setIntent(zero);
      setApplied(zero);
      setStrength(0);
      setError("");
      setNote("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void begin();
  }, [camera.id]);
  async function apply(next: ShadeIntent) {
    if (!session || sending) return;
    setSending(true);
    setError("");
    try {
      const r = await perform("shade_apply", {
        cameraId: camera.id,
        sessionId: session.sessionId,
        intent: next,
        expectedRevision: camera.revision,
      });
      setApplied(next);
      setNote(
        Math.abs(r.remainingEV) > 0.05
          ? "Brightness limit reached. Shutter is still held."
          : r.completed.length
            ? `Adjusted ${r.completed.join(" + ")}.`
            : "At the starting point.",
      );
    } catch (e) {
      setError((e as Error).message);
      setSession(undefined);
    } finally {
      setSending(false);
    }
  }
  const locked = disabled || sending || !session,
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
          onChange={(v) => setIntent({ ...intent, brightness: v })}
          min={-4}
          max={4}
          step={0.1}
          unit="stops"
          theme="brightness"
          left="Darker"
          right="Brighter"
          disabled={locked || !supports.brightness}
          precise={false}
          onCommit={(v) => void apply({ ...intent, brightness: v })}
        />
        <div className="exposure-path">
          <span className={!session?.policy?.preserveAperture ? "" : "muted"}>
            1 · Iris {session?.policy?.preserveAperture ? "held" : ""}
          </span>
          <span>→</span>
          <span>2 · Gain / ISO</span>
          <span className="shutter-held">
            <Lock size={12} /> Shutter{" "}
            {shutter ? `1/${shutter.value} s` : "held"}
          </span>
        </div>
        <p className="helper">
          {supports.brightness
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
          onChange={(v) => setIntent({ ...intent, warmth: v })}
          min={-1}
          max={1}
          step={0.02}
          theme="warmth"
          left="Cooler · blue"
          right="Warmer · amber"
          disabled={locked || !supports.warmth}
          precise={false}
          onCommit={(v) => void apply({ ...intent, warmth: v })}
        />
        <VisualSlider
          label="Tint"
          value={intent.tint}
          onChange={(v) => setIntent({ ...intent, tint: v })}
          min={-1}
          max={1}
          step={0.02}
          theme="tint"
          left="Greener"
          right="More magenta"
          disabled={locked || !supports.tint}
          precise={false}
          onCommit={(v) => void apply({ ...intent, tint: v })}
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
            onChange={setStrength}
            left="None"
            right="Stronger correction"
            precise={false}
            disabled={
              locked ||
              (["blue", "amber"].includes(problem)
                ? !supports.warmth
                : !supports.tint)
            }
            onCommit={(v) => {
              const n = {
                ...intent,
                ...(["blue", "amber"].includes(problem)
                  ? { warmth: (v / 100) * (problem === "blue" ? 1 : -1) }
                  : { tint: (v / 100) * (problem === "green" ? 1 : -1) }),
              };
              setIntent(n);
              void apply(n);
            }}
          />
          <p className="helper">
            Adds the opposing correction from your starting point. Judge the
            result in the live preview.
          </p>
        </details>
      </div>
      <div className="simple-footer">
        <button
          className="quiet"
          disabled={sending}
          onClick={() => void begin()}
        >
          <RotateCcw size={14} />
          Use current picture as starting point
        </button>
        <button onClick={advanced}>
          Show manual controls <SlidersHorizontal size={14} />
        </button>
      </div>
      {JSON.stringify(applied) !== JSON.stringify(intent) &&
        !sending &&
        session && (
          <button disabled={locked} onClick={() => void apply(intent)}>
            Apply adjustment
          </button>
        )}
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

export function AxisEditor({
  axis,
  control,
  revision,
  disabled,
  onSet,
}: {
  axis: Axis;
  control: Control;
  revision: number;
  disabled: boolean;
  onSet: (value: unknown, revision: number) => Promise<unknown>;
}) {
  const [value, setValue] = useState(axis.value),
    [base, setBase] = useState<number>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (base === undefined) setValue(axis.value);
  }, [axis.value, base]);
  const choose = (v: number) => {
    if (base === undefined) setBase(revision);
    setValue(v);
  };
  return (
    <div className="control visual-control">
      <VisualSlider
        label={axis.label}
        value={value}
        onChange={choose}
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
        <p className="helper">
          {axis.encoding === "ptzKelvin"
            ? "Requires color-temperature white balance mode."
            : control.native?.category !== undefined
              ? "ATEM reports switcher values. Check the change in the picture."
              : control.note}
        </p>
      )}
      {axis.kind === "shutter" && (
        <p className="helper">
          Manual override. Match frame rate and lighting to avoid unwanted blur
          or flicker.
        </p>
      )}
      <div className="control-bottom">
        <small>
          {control.freshness === "simulated"
            ? "Demo"
            : control.freshness === "requested"
              ? "Sent · awaiting readback"
              : "Camera value"}
        </small>
        <button
          disabled={disabled || base === undefined}
          onClick={async () => {
            try {
              await onSet(encodeAxis(axis, value, control), base ?? revision);
              setBase(undefined);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Apply
        </button>
        {base !== undefined && (
          <button
            className="quiet"
            onClick={() => {
              setBase(undefined);
              setError("");
            }}
          >
            Revert
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// Opponent-plane wheel: edits chroma around the current mean and preserves luma.
export function ColorWheel({
  control: c,
  revision,
  disabled,
  onSet,
}: {
  control: Control;
  revision: number;
  disabled: boolean;
  onSet: (v: unknown, r: number) => Promise<unknown>;
}) {
  const initial = c.value as number[],
    [v, setV] = useState(initial),
    [base, setBase] = useState<number>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (base === undefined) setV(initial);
  }, [JSON.stringify(initial), base]);
  const mean = (v[0] + v[1] + v[2]) / 3,
    x = v[0] - mean,
    y = (v[1] - v[2]) / Math.sqrt(3),
    radius = 0.25;
  function move(nx: number, ny: number) {
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
    setV(n);
    if (base === undefined) setBase(revision);
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
      <div className="wheel-caption">
        Drag toward a color · arrow keys to refine
      </div>
      <VisualSlider
        label={`${c.label} master`}
        value={v[3]}
        onChange={(n) => {
          if (base === undefined) setBase(revision);
          setV([v[0], v[1], v[2], n]);
        }}
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
              <input
                type="number"
                aria-label={`${c.label} ${["red", "green", "blue", "master"][i]}`}
                value={n}
                step={0.01}
                min={c.min}
                max={c.max}
                disabled={disabled}
                onChange={(e) => {
                  if (!Number.isFinite(e.target.valueAsNumber)) return;
                  if (base === undefined) setBase(revision);
                  setV(v.map((n, j) => (i === j ? e.target.valueAsNumber : n)));
                }}
              />
            </label>
          ))}
        </div>
      </details>
      <div className="control-bottom">
        <small>{c.freshness === "simulated" ? "Demo" : c.freshness}</small>
        <button
          className="quiet"
          disabled={disabled}
          onClick={() => {
            if (base === undefined) setBase(revision);
            const neutral = c.label === "Gain" ? 1 : 0;
            setV([neutral, neutral, neutral, v[3]]);
          }}
        >
          Neutral color
        </button>
        <button
          disabled={disabled || base === undefined}
          onClick={async () => {
            try {
              await onSet(v, base ?? revision);
              setBase(undefined);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Apply
        </button>
        {base !== undefined && (
          <button
            className="quiet"
            onClick={() => {
              setBase(undefined);
              setError("");
            }}
          >
            Revert
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
