import type { Camera, Control, Value } from "./types.js";

// UI and deterministic automation share these unit conversions. Unknown native
// encodings remain available in Advanced but never enter an exposure recipe.
export type AxisKind =
  "iris" | "gain" | "iso" | "warmth" | "tint" | "shutter" | "other";
export interface Axis {
  id: string;
  controlId: string;
  component?: number;
  label: string;
  kind: AxisKind;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  encoding?: "av" | "f100" | "sonyShutter" | "sonyGM" | "ptzKelvin";
  choices?: { value: number; native: number; label: string }[];
  writable: boolean;
}
export interface ExposurePolicy {
  preserveAperture: boolean;
  minF: number;
  maxF: number;
  minGain: number;
  maxGain: number;
  maxIso: number;
}
export const defaultPolicy: ExposurePolicy = {
  preserveAperture: false,
  minF: 2,
  maxF: 8,
  minGain: 0,
  maxGain: 12,
  maxIso: 3200,
};
const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
export function axes(camera: Camera): Axis[] {
  const result: Axis[] = [];
  for (const c of camera.controls) {
    const add = (
      kind: AxisKind,
      min: number,
      max: number,
      step: number,
      unit = "",
      component?: number,
      encoding?: Axis["encoding"],
      label = c.label,
    ) => {
      const raw =
        component === undefined ? c.value : (c.value as number[])?.[component];
      if (typeof raw !== "number" || !Number.isFinite(raw)) return;
      const decode = (v: number) =>
        encoding === "av"
          ? 2 ** (v / 2)
          : encoding === "f100"
            ? v / 100
            : encoding === "ptzKelvin"
              ? 2500 + v * 100
              : encoding === "sonyGM"
                ? (192 - v) / 4
                : encoding === "sonyShutter"
                  ? (v & 65535) / (v >>> 16)
                  : v;
      let value = decode(raw);
      if (!Number.isFinite(value) || value < min || value > max) return;
      const choices = c.options
        ?.filter((o) => typeof o.value === "number")
        .map((o) => ({
          value: decode(Number(o.value)),
          native: Number(o.value),
          label: o.label,
        }))
        .filter(
          (o) => Number.isFinite(o.value) && o.value >= min && o.value <= max,
        )
        .sort((a, b) => a.value - b.value);
      if ((c.type === "enum" || encoding === "sonyShutter") && !choices?.length)
        return;
      result.push({
        id: `${c.id}:${component ?? ""}`,
        controlId: c.id,
        component,
        label,
        kind,
        value,
        min: choices?.[0]?.value ?? min,
        max: choices?.at(-1)?.value ?? max,
        step,
        unit,
        encoding,
        choices,
        writable: c.writable,
      });
    };
    if (camera.vendor === "atem") {
      if (c.id === "0.2")
        add("iris", 0.7, 64, 0.1, "ƒ", undefined, "av", "Iris");
      else if (c.id === "1.13") add("gain", -12, 36, 1, "dB");
      else if (c.id === "1.14") add("iso", 50, 25600, 50, "ISO");
      else if (
        c.id === "1.2" &&
        c.type === "vector" &&
        c.components?.length === 2
      ) {
        add("warmth", 2500, 10000, 50, "K", 0, undefined, "White balance");
        add("tint", -50, 50, 1, "", 1, undefined, "Tint");
      } else if (c.id === "1.12")
        add(
          "shutter",
          Number(
            (
              camera.controls.find((c) => c.id === "1.0")?.value as number[]
            )?.[0],
          ) || 1,
          5000,
          1,
          "1/s",
        );
      else if (
        c.id === "0.0" ||
        c.id === "0.3" ||
        c.id === "0.8" ||
        c.id === "8.5"
      )
        add("other", 0, 1, 0.01);
      // Remaining ATEM numeric limits describe wire storage, not camera ranges.
      continue;
    }
    if (
      camera.vendor === "ptzoptics" &&
      c.id === "color_temperature" &&
      c.native?.code === 0x20
    ) {
      add(
        "warmth",
        2500,
        8000,
        100,
        "K",
        undefined,
        "ptzKelvin",
        "White balance",
      );
      const axis = result.at(-1);
      if (axis?.controlId === c.id)
        axis.writable =
          c.writable &&
          camera.controls.find((p) => p.id === "white_balance_mode")?.value ===
            32;
      continue;
    }
    if (camera.vendor === "sony") {
      const name = c.label.replace(/\s/g, "").toLowerCase();
      if (c.id === "dp:256")
        add("iris", 0.7, 64, 0.1, "ƒ", undefined, "f100", "Iris");
      else if (c.id === "dp:260")
        add("iso", 50, 102400, 50, "ISO", undefined, undefined, "ISO"); // Excludes AUTO and packed mode/extension flags.
      else if (c.id === "dp:259")
        add(
          "shutter",
          0.001,
          32000,
          0.01,
          "1/s",
          undefined,
          "sonyShutter",
          "Shutter speed",
        );
      else if (
        name === "colortemp" ||
        name === "colortemperature" ||
        name === "whitebalancepresetcolortemperature"
      )
        add(
          "warmth",
          Math.max(2000, c.min ?? 2000),
          Math.min(15000, c.max ?? 15000),
          c.step ?? 100,
          "K",
          undefined,
          undefined,
          "White balance",
        );
      else if (
        name === "colortuninggm" &&
        c.min !== undefined &&
        c.max !== undefined &&
        c.min >= 156 &&
        c.max <= 228
      )
        add(
          "tint",
          (192 - c.max) / 4,
          (192 - c.min) / 4,
          0.25,
          "",
          undefined,
          "sonyGM",
          "Tint",
        );
      else if (
        c.type === "number" &&
        c.min !== undefined &&
        c.max !== undefined
      )
        add("other", c.min, c.max, c.step ?? 1, c.unit);
      continue;
    }
    if (c.type === "number" && c.min !== undefined && c.max !== undefined) {
      const kind: AxisKind =
        camera.vendor !== "demo"
          ? "other"
          : (
              {
                iris: "iris",
                gain_db: "gain",
                white_balance: "warmth",
                tint: "tint",
                shutter_speed: "shutter",
              } as Record<string, AxisKind>
            )[c.id] || "other";
      add(kind, c.min, c.max, c.step ?? 0.01, c.unit);
    }
  }
  return result;
}
export function encodeAxis(
  axis: Axis,
  desired: number,
  control: Control,
): Value {
  let n = clamp(desired, axis.min, axis.max);
  if (axis.choices?.length)
    n = axis.choices.reduce((a, b) =>
      Math.abs(b.value - n) < Math.abs(a.value - n) ? b : a,
    ).native;
  else {
    n = Math.round(n / axis.step) * axis.step;
    n = clamp(n, axis.min, axis.max);
    n =
      axis.encoding === "av"
        ? Math.round(2 * Math.log2(n) * 2048) / 2048
        : axis.encoding === "f100"
          ? Math.round(n * 100)
          : axis.encoding === "ptzKelvin"
            ? Math.round((n - 2500) / 100)
            : axis.encoding === "sonyGM"
              ? Math.round(192 - n * 4)
              : n;
  }
  if (axis.component === undefined)
    return axis.encoding === "av" ? n : Number(n.toFixed(6));
  const values = [...(control.value as number[])];
  values[axis.component] = Number(n.toFixed(6));
  return values;
}
export interface ShadeIntent {
  brightness: number;
  warmth: number;
  tint: number;
}
export interface ShadeChange {
  controlId: string;
  label: string;
  value: Value;
}
export function shadePlan(
  baseline: Camera,
  intent: ShadeIntent,
  policy: ExposurePolicy,
) {
  const available = axes(baseline).filter((a) => a.writable),
    changes = new Map<string, ShadeChange>();
  const set = (a: Axis, n: number) => {
    const c = baseline.controls.find((c) => c.id === a.controlId)!;
    const prev = changes.get(c.id);
    changes.set(c.id, {
      controlId: c.id,
      label: c.label,
      value:
        n === a.value && !prev
          ? structuredClone(c.value!)
          : encodeAxis(a, n, prev ? { ...c, value: prev.value } : c),
    });
  };
  const iris = available.find((a) => a.kind === "iris"),
    gain =
      available.find((a) => a.kind === "gain") ||
      available.find((a) => a.kind === "iso");
  let remaining = intent.brightness;
  const visca =
    baseline.vendor === "ptzoptics" ? viscaExposure(baseline) : undefined;
  if (visca) remaining = visca.plan(remaining, changes);
  // Targets always derive from the anchor. Reversing the slider unwinds the same recipe.
  const adjustIris = () => {
    if (!iris || policy.preserveAperture) return;
    const low = Math.max(iris.min, policy.minF),
      high = Math.min(iris.max, policy.maxF);
    if (iris.value < low || iris.value > high || high < low) return;
    const target = clamp(iris.value / 2 ** (remaining / 2), low, high);
    const bounded = {
      ...iris,
      min: low,
      max: high,
      choices: iris.choices?.filter((o) => o.value >= low && o.value <= high),
    };
    if (bounded.choices && !bounded.choices.length) return;
    set(bounded, intent.brightness === 0 ? iris.value : target);
    const native = changes.get(iris.controlId)!.value as number;
    const actual =
      iris.encoding === "av"
        ? 2 ** (native / 2)
        : iris.encoding === "f100"
          ? native / 100
          : native;
    remaining -= 2 * Math.log2(iris.value / actual);
  };
  const adjustGain = () => {
    if (!gain) return;
    const low =
        gain.kind === "iso" ? gain.min : Math.max(gain.min, policy.minGain),
      high =
        gain.kind === "iso"
          ? Math.min(gain.max, policy.maxIso)
          : Math.min(gain.max, policy.maxGain);
    if (gain.value < low || gain.value > high || high < low) return;
    const target = clamp(
      gain.kind === "iso"
        ? gain.value * 2 ** remaining
        : gain.value + remaining * 6.0206,
      low,
      high,
    );
    const bounded = {
      ...gain,
      min: low,
      max: high,
      choices: gain.choices?.filter((o) => o.value >= low && o.value <= high),
    };
    if (bounded.choices && !bounded.choices.length) return;
    set(bounded, target);
    const actual = changes.get(gain.controlId)!.value as number;
    remaining -=
      gain.kind === "iso"
        ? Math.log2(actual / gain.value)
        : (actual - gain.value) / 6.0206;
  };
  if (!visca) {
    if (remaining >= 0) {
      adjustIris();
      adjustGain();
    } else {
      adjustGain();
      adjustIris();
    }
  }
  const warmth = available.find((a) => a.kind === "warmth"),
    tint = available.find((a) => a.kind === "tint");
  if (warmth) set(warmth, warmth.value + intent.warmth * 2000);
  if (tint)
    set(
      tint,
      tint.value + intent.tint * Math.min(25, (tint.max - tint.min) / 4),
    );
  return {
    changes: [...changes.values()],
    requested: intent,
    remainingEV: Math.round(remaining * 100) / 100,
    supported: {
      brightness: visca
        ? visca.steps.length > 0
        : !!((iris && !policy.preserveAperture) || gain),
      warmth: !!warmth,
      tint: !!tint,
    },
    policy,
    path: visca?.steps.map((s) => s.label),
    note: visca
      ? `VISCA ${visca.mode} exposure: ${visca.steps.map((s) => s.label).join(", then ") || "no adjustable position"}. About ${VISCA_EV_PER_STEP} stop per native step; the exact amount varies by model. Shutter stays fixed. This is a requested adjustment, not a measurement of picture brightness.`
      : "Iris first, then bounded gain/ISO. Darkening reduces gain first. Shutter and ND stay fixed. This is a requested adjustment, not a measurement of picture brightness.",
  };
}

// VISCA reports exposure as native indexes, not f-stops or dB. Sony-derived
// tables step iris, gain and bright in roughly half-stop increments, so Simple
// brightness walks whole native steps on whichever control the AE mode obeys.
export const VISCA_EV_PER_STEP = 0.5;
const VISCA_COMP_NEUTRAL = 7;
interface ViscaStep {
  control: Control;
  label: string;
  value: number;
  min: number;
  max: number;
}
export function viscaExposure(camera: Camera) {
  const get = (id: string) => {
    const c = camera.controls.find((c) => c.id === id);
    return c?.writable && typeof c.value === "number" ? c : undefined;
  };
  const step = (id: string, label: string, min = 0, max?: number) => {
    const c = get(id);
    if (!c) return [];
    const value = c.value as number,
      hi = Math.min(max ?? Infinity, c.max ?? value);
    return value >= min && value <= hi
      ? [{ control: c, label, value, min, max: hi }]
      : [];
  };
  const mode = get("exposure_mode")?.value,
    compOn = get("exposure_compensation_mode"),
    gainLimit = get("gain_limit")?.value as number | undefined;
  let name = "unknown",
    steps: ViscaStep[] = [],
    extra: ShadeChange[] = [];
  if (mode === 3) {
    name = "Manual";
    // Iris index 0 closes the lens; never walk into it.
    steps = [...step("iris", "Iris", 1), ...step("gain", "Gain", 0, gainLimit)];
  } else if (mode === 13) {
    name = "Bright";
    steps = step("bright", "Bright level");
  } else if (mode === 0 || mode === 10 || mode === 11) {
    name =
      mode === 0 ? "Auto" : mode === 10 ? "Shutter priority" : "Iris priority";
    steps = step("exposure_compensation", "Exposure compensation");
    // Compensation that is switched off contributes nothing, so treat its
    // stored level as neutral and switch it on before the first offset.
    if (steps.length && compOn && compOn.value !== 2) {
      steps[0].value = VISCA_COMP_NEUTRAL;
      extra = [{ controlId: compOn.id, label: compOn.label, value: 2 }];
    }
  }
  return {
    mode: name,
    steps,
    plan(ev: number, changes: Map<string, ShadeChange>) {
      let remaining = Math.round(ev / VISCA_EV_PER_STEP);
      if (remaining && extra.length)
        for (const e of extra) changes.set(e.controlId, e);
      const order = remaining >= 0 ? steps : [...steps].reverse();
      const targets = new Map<ViscaStep, number>();
      for (const s of order) {
        const target = clamp(s.value + remaining, s.min, s.max);
        remaining -= target - s.value;
        targets.set(s, target);
      }
      for (const s of steps)
        changes.set(s.control.id, {
          controlId: s.control.id,
          label: s.control.label,
          value: targets.get(s)!,
        });
      return remaining * VISCA_EV_PER_STEP;
    },
  };
}
