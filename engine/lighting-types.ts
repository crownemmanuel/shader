import { z } from "zod";
import { isIP } from "node:net";
const text = z.string().max(200),
  level = z.number().min(0).max(1),
  count = z.number().int().nonnegative().max(100000);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/),
  kelvin = z.number().min(0).max(100000).nullable();
const named = z.object({ id: text.optional(), name: text.optional() });
const measures = {
  level: level.optional(),
  color: color.optional(),
  kelvin: kelvin.optional(),
  saturation: level.optional(),
};
const member = z.object({
  id: text.optional(),
  name: text.optional(),
  profile: text.optional(),
  ...measures,
  duv: z.number().min(-1).max(1).optional(),
  known: z.boolean().optional(),
});
export const zoneSchema = z.object({
  id: text.optional(),
  name: text.optional(),
  role: text.optional(),
  ...measures,
  lit: count.optional(),
  fixtures: count.optional(),
  peak: level.optional(),
  mired: z.number().nonnegative().optional(),
  duv: z.number().min(-1).max(1).optional(),
  cie: z.object({ x: level, y: level }).optional(),
  white: z.boolean().optional(),
  colorUnknown: count.optional(),
  members: z.array(member).max(1000).optional(),
});
export const lookMessageSchema = z.object({
  type: text,
  protocol: text.optional(),
  app: text.optional(),
  version: text.optional(),
  id: text.optional(),
  seq: z.number().int().nonnegative().optional(),
  at: text.optional(),
  target: text.optional(),
  test: z.boolean().optional(),
  reason: text.optional(),
  page: named.nullable().optional(),
  cue: named
    .extend({ entry: text.optional(), number: z.number().int().optional() })
    .nullable()
    .optional(),
  timing: z
    .object({
      fade: z.number().min(0).max(3600).optional(),
      startedAt: text.optional(),
      settlesAt: text.optional(),
    })
    .optional(),
  state: text.optional(),
  output: z
    .object({
      armed: z.boolean().optional(),
      blackout: z.boolean().optional(),
      master: level.optional(),
    })
    .optional(),
  ...measures,
  lit: count.optional(),
  fixtures: count.optional(),
  zones: z.array(zoneSchema).max(256).optional(),
  groups: z.array(zoneSchema).max(256).optional(),
  preset: text.optional(),
  fade: z.number().min(0).max(3600).optional(),
});
export type LookMessage = z.infer<typeof lookMessageSchema>;
export type LightingZone = z.infer<typeof zoneSchema>;
const ipv4 = z
  .string()
  .refine((s) => isIP(s) === 4, "Use a numeric IPv4 address");
export const lightingConfigSchema = z
  .object({
    enabled: z.boolean(),
    bind: z.enum(["127.0.0.1", "0.0.0.0"]),
    httpPort: z.number().int().min(1024).max(65535),
    oscEnabled: z.boolean(),
    oscPort: z.number().int().min(1024).max(65535),
    allowedSenders: z.array(ipv4).max(32),
    stageHost: ipv4,
    stagePort: z.number().int().min(1024).max(65535),
    targetId: z.string().max(200),
    automation: z.boolean(),
    legacyLive: z.boolean(),
    feedback: z.boolean(),
  })
  .strict();
export type LightingConfig = z.infer<typeof lightingConfigSchema>;
export const lightingRuleSchema = z
  .object({
    id: text.optional(),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    presetId: z.string().min(1).max(200),
    target: text.optional(),
    pageId: text.optional(),
    cueId: text.optional(),
    entryId: text.optional(),
    cueName: text.optional(),
    fade: z.number().min(0).max(60).optional(),
  })
  .strict()
  .refine(
    (r) => !!(r.cueId || r.entryId || r.cueName),
    "Choose a cue ID, entry ID or exact cue name",
  );
export type LightingRule = z.infer<typeof lightingRuleSchema>;
export function zoneRole(zone: LightingZone) {
  if (zone.role) return zone.role;
  const name = `${zone.id || ""} ${zone.name || ""}`.toLowerCase();
  if (/effect|audience|back/.test(name)) return "other";
  if (/face|key/.test(name)) return "face";
  if (/front/.test(name)) return "front";
  if (/top|overhead/.test(name)) return "top";
  return "other";
}
export function analyzeLook(look: LookMessage) {
  const zones = look.zones ?? look.groups ?? [];
  const lit = zones.filter((z) => z.lit !== 0 && (z.level ?? 0) > 0);
  const role = ["face", "front", "top"].find((role) =>
    lit.some((z) => zoneRole(z) === role),
  );
  const reference = lit.filter((z) => zoneRole(z) === role);
  const colored = reference.some((z) => z.white === false);
  const trustworthy =
    reference.length > 0 &&
    reference.every(
      (z) =>
        z.white === true && !(z.colorUnknown ?? 0) && z.kelvin && z.kelvin > 0,
    );
  const weighted = (fn: (z: LightingZone) => number) =>
    reference.reduce((sum, z) => sum + fn(z) * z.level!, 0) /
    reference.reduce((sum, z) => sum + z.level!, 0);
  const nominalKelvin = trustworthy
    ? Math.round(1e6 / weighted((z) => 1e6 / z.kelvin!))
    : null;
  const duv =
    trustworthy && reference.every((z) => z.duv !== undefined)
      ? weighted((z) => z.duv!)
      : null;
  const hold =
    look.test || look.reason === "test"
      ? "Test message"
      : look.output?.armed === false
        ? "Lighting preview; physical output is not armed"
        : look.output?.blackout
          ? "Blackout; keep prior camera balance"
          : !reference.length
            ? "No lit face, front or top reference"
            : colored
              ? "Intentional color; preserve the show look"
              : !trustworthy
                ? "Uncertain or legacy color data; inspect the camera image"
                : undefined;
  return {
    role: role || null,
    references: reference.map((z) => ({ id: z.id, name: z.name })),
    nominalKelvin,
    duv,
    tintDirection:
      duv === null ? null : duv > 0 ? "magenta" : duv < 0 ? "green" : "neutral",
    confidence: trustworthy && !hold ? "nominal" : "low",
    hold: hold || null,
    guidance:
      "Fixture estimates are context, not metered light or image measurements. Do not convert Duv directly to native tint units. Inspect a fresh mapped camera frame and its supported controls before correcting. Preserve intentional color; never follow effect or audience zones.",
  };
}
