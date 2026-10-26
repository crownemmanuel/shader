import { z } from "zod";
export const vendorSchema = z.enum([
  "atem",
  "ptzoptics",
  "sony",
  "blackmagic-rest",
  "demo",
]);
export type Vendor = z.infer<typeof vendorSchema>;
export type Value =
  | number
  | string
  | boolean
  | number[]
  | string[]
  | boolean[]
  | Record<string, unknown>;
export interface Control {
  id: string;
  label: string;
  group: string;
  type: "number" | "enum" | "boolean" | "vector" | "string" | "action" | "json";
  value?: Value;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number }[];
  components?: string[];
  writable: boolean;
  readable: boolean;
  unit?: string;
  note?: string;
  native?: Record<string, unknown>;
  freshness: "reported" | "requested" | "unknown" | "simulated";
  updatedAt?: string;
}
export interface Camera {
  id: string;
  name: string;
  vendor: Vendor;
  model: string;
  address: string;
  status: "connected" | "disconnected" | "connecting" | "error" | "demo";
  controls: Control[];
  revision: number;
  tally: "program" | "preview" | "off" | "unknown";
  error?: string;
  sourceId?: string;
  tallyRoute?: { host: string; input: number; me: number };
}
export interface Connection {
  vendor: Vendor;
  host: string;
  name?: string;
  port?: number;
  cameraIndex?: number;
  profile?: string;
  username?: string;
  password?: string;
  fingerprint?: string;
}
export interface Discovery {
  id: string;
  name: string;
  vendor: Vendor | "unknown";
  address: string;
  port?: number;
  protocol: string;
  note?: string;
}
export interface CaptureSource {
  id: string;
  name: string;
  // rtsp sources are derived from a connected camera's address, never registered by hand.
  kind: "avfoundation" | "decklink" | "dshow" | "v4l2" | "rtsp";
  device: string;
  format?: string;
  backend?: "decklink-sdk";
  available?: boolean;
  nativeName?: string;
  model?: string;
  connector?: number;
  subdeviceIndex?: number;
  profile?: string;
  supportsAutoDetection?: boolean;
  modes?: { code: string; name: string; width: number; height: number; fps: number }[];
}
export interface Frame {
  id: string;
  cameraId: string;
  sourceId: string;
  capturedAt: string;
  revision: number;
  mimeType: "image/jpeg";
  data: string;
  sha256: string;
}
export interface Audit {
  id: string;
  at: string;
  actor: string;
  cameraId?: string;
  operation: string;
  status: "ok" | "error";
  detail: string;
}
export interface Adapter {
  connect(input: Connection): Promise<Camera[]>;
  refresh(camera: Camera): Promise<Control[]>;
  set(
    camera: Camera,
    control: Control,
    value: Value,
  ): Promise<{ verified: boolean; value?: Value }>;
  close(): Promise<void>;
}
export const connectionSchema = z
  .object({
    vendor: vendorSchema,
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(
        /^[a-zA-Z0-9.:[\]-]+$/,
        "Use a hostname or IP address, without a URL or path",
      ),
    name: z.string().max(80).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    cameraIndex: z.number().int().min(1).max(255).optional(),
    profile: z.string().max(80).optional(),
    username: z.string().max(128).optional(),
    password: z.string().max(256).optional(),
    fingerprint: z.string().max(255).optional(),
  })
  .strict();
export function validateValue(control: Control, value: unknown): Value {
  if (!control.writable) throw new Error(`${control.label} is read-only`);
  if (control.type === "number" || control.type === "vector") {
    const a = control.type === "vector" ? value : [value];
    if (
      !Array.isArray(a) ||
      a.length !== (control.type === "vector" ? control.components?.length : 1)
    )
      throw new Error("Incorrect number of components");
    for (const n of a) {
      if (typeof n !== "number" || !Number.isFinite(n))
        throw new Error("Expected finite numeric values");
      if (
        (control.min !== undefined && n < control.min) ||
        (control.max !== undefined && n > control.max)
      )
        throw new Error(
          `${control.label} must be between ${control.min} and ${control.max}`,
        );
      if (control.step === 1 && !Number.isInteger(n))
        throw new Error("Expected an integer");
    }
  } else if (
    control.type === "enum" &&
    !control.options?.some((o) => o.value === value)
  )
    throw new Error("Unsupported option");
  else if (control.type === "boolean" && typeof value !== "boolean")
    throw new Error("Expected a boolean");
  else if (
    control.type === "string" &&
    (typeof value !== "string" || value.length > 1024)
  )
    throw new Error("Expected a string (max 1024 characters)");
  else if (control.type === "action" && value !== true)
    throw new Error("Actions require true");
  else if (
    control.type === "json" &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  )
    throw new Error("Expected an object");
  return value as Value;
}
