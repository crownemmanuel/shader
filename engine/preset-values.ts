import { axes, encodeAxis } from "./shading.js";
import type { Camera, Control, Value } from "./types.js";
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function presetEligible(c: Control) {
  return (
    c.readable &&
    c.writable &&
    c.value !== undefined &&
    c.freshness !== "unknown" &&
    !["action", "json"].includes(c.type)
  );
}
export function defaultPresetControls(camera: Camera) {
  const shadingIds = new Set(
    axes(camera)
      .filter((a) => a.kind !== "other")
      .map((a) => a.controlId),
  );
  return camera.controls.filter(
    (c) =>
      presetEligible(c) &&
      (/^(color|exposure|image|colour)$/i.test(c.group) ||
        shadingIds.has(c.id)),
  );
}

/** Only understood continuous controls fade. Packed/native enums are never interpolated as integers. */
export function presetValue(
  camera: Camera,
  control: Control,
  target: Value,
  fraction: number,
): Value {
  if (fraction >= 1) return structuredClone(target);
  const known = axes(camera).filter(
    (a) =>
      a.controlId === control.id && a.kind !== "shutter" && a.kind !== "other",
  );
  const targetCamera = structuredClone(camera);
  targetCamera.controls.find((c) => c.id === control.id)!.value = target;
  const targetAxes = axes(targetCamera);
  let result = structuredClone(control.value!);
  for (const axis of known) {
    const end = targetAxes.find((a) => a.id === axis.id);
    if (!end) continue;
    const value =
      axis.kind === "warmth" && axis.value > 0 && end.value > 0
        ? 1e6 /
          (1e6 / axis.value + (1e6 / end.value - 1e6 / axis.value) * fraction)
        : axis.value + (end.value - axis.value) * fraction;
    result = encodeAxis(axis, value, { ...control, value: result });
  }
  if (known.length) return result;
  if (
    control.type === "vector" &&
    /^(color|colour)$/i.test(control.group) &&
    Array.isArray(target) &&
    Array.isArray(control.value)
  ) {
    return (target as number[]).map((v, i) => {
      const start = (control.value as number[])[i],
        step = control.step || 0.001;
      return Number(
        (Math.round((start + (v - start) * fraction) / step) * step).toFixed(6),
      );
    });
  }
  return structuredClone(control.value!);
}
