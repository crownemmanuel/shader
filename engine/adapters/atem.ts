import { BasicAtem, AtemConnectionStatus } from "atem-connection";
import {
  CameraControlCommand,
  CameraControlUpdateCommand,
  CameraControlDataType,
} from "atem-connection/dist/commands/CameraControlCommand.js";
import { switcherInfo } from "../routing.js";
import type { Adapter, Camera, Connection, Control, Value } from "../types.js";
const labels: Record<string, [string, string, string[]?]> = {
  "0.0": ["Focus", "Lens"],
  "0.1": ["Auto focus", "Lens"],
  "0.2": ["Aperture", "Lens"],
  "0.3": ["Aperture normalized", "Lens"],
  "0.4": ["Aperture step", "Lens"],
  "0.5": ["Auto aperture", "Lens"],
  "0.6": ["Optical stabilization", "Lens"],
  "0.7": ["Zoom (mm)", "Lens"],
  "0.8": ["Zoom", "Lens"],
  "0.9": ["Zoom speed", "Lens"],
  "1.1": ["Sensor gain (legacy)", "Exposure"],
  "1.2": ["White balance / tint", "Exposure", ["Kelvin", "Tint"]],
  "1.3": ["Auto white balance", "Exposure"],
  "1.5": ["Exposure", "Exposure"],
  "1.8": ["Detail", "Image"],
  "1.11": ["Shutter angle", "Exposure"],
  "1.12": ["Shutter speed", "Exposure"],
  "1.13": ["Sensor gain", "Exposure"],
  "1.14": ["ISO", "Exposure"],
  "1.16": ["ND filter", "Exposure"],
  "4.4": ["Color bars", "Image"],
  "8.0": ["Lift", "Color", ["Red", "Green", "Blue", "Master"]],
  "8.1": ["Gamma", "Color", ["Red", "Green", "Blue", "Master"]],
  "8.2": ["Gain", "Color", ["Red", "Green", "Blue", "Master"]],
  "8.3": ["Offset", "Color", ["Red", "Green", "Blue", "Master"]],
  "8.4": ["Contrast", "Color", ["Pivot", "Contrast"]],
  "8.5": ["Luma mix", "Color"],
  "8.6": ["Hue / saturation", "Color", ["Hue", "Saturation"]],
  "8.7": ["Reset color correction", "Color"],
};
export function fromAtem(cmd: CameraControlUpdateCommand): Control {
  const p = cmd.properties,
    k = `${cmd.category}.${cmd.parameter}`,
    meta = labels[k];
  const value: Value =
    p.type === 0
      ? p.boolData
      : p.type === 5
        ? p.stringData
        : p.type === 4
          ? p.bigintData.map(String)
          : p.numberData;
  const isArray = Array.isArray(value),
    len = isArray ? value.length : 1;
  const type: Control["type"] =
    p.type === 5
      ? "string"
      : p.type === 4 || (p.type === 0 && len > 1)
        ? "json"
        : len === 0
          ? "action"
          : p.type === 0 && len === 1
            ? "boolean"
            : len > 1
              ? "vector"
              : "number";
  return {
    id: k,
    label: meta?.[0] ?? `Parameter ${k}`,
    group: meta?.[1] ?? "Vendor",
    type,
    value:
      p.type === 4 || (p.type === 0 && len > 1)
        ? { values: value }
        : isArray && len === 1
          ? value[0]
          : value,
    writable: true,
    readable: len > 0,
    components:
      len > 1
        ? meta?.[2]?.length === len
          ? meta[2]
          : Array.from({ length: len }, (_, i) => `Value ${i + 1}`)
        : undefined,
    min:
      (
        { "8.0": -2, "8.1": -4, "8.2": 0, "8.3": -8, "8.5": 0 } as Record<
          string,
          number
        >
      )[k] ??
      (p.type === 128
        ? -16
        : p.type === 1
          ? -128
          : p.type === 2
            ? -32768
            : p.type === 3
              ? -2147483648
              : undefined),
    max:
      (
        {
          "8.0": 2,
          "8.1": 4,
          "8.2": 32767 / 2048,
          "8.3": 8,
          "8.5": 1,
        } as Record<string, number>
      )[k] ??
      (p.type === 128
        ? 15.99951171875
        : p.type === 1
          ? 127
          : p.type === 2
            ? 32767
            : p.type === 3
              ? 2147483647
              : undefined),
    step: p.type === 128 ? 1 / 2048 : 1,
    freshness: len > 0 ? "reported" : "unknown",
    updatedAt: new Date().toISOString(),
    native: { category: cmd.category, parameter: cmd.parameter, type: p.type },
    note: "Reported by ATEM; this is switcher state, not confirmation from the camera. Numeric bounds are wire-format bounds; consult camera limits.",
  };
}
export class AtemAdapter implements Adapter {
  client = new BasicAtem({ disableMultithreaded: true });
  cameras = new Map<number, Camera>();
  host = "";
  constructor(
    private changed: (camera: Camera) => void = () => {},
    private routingChanged: () => void = () => {},
  ) {
    this.client.on("error", () => {});
    this.client.on("receivedCommands", (commands) => {
      for (const cmd of commands)
        if (cmd instanceof CameraControlUpdateCommand) {
          let cam = this.cameras.get(cmd.source);
          if (!cam) {
            cam = {
              id: `atem-${this.host}-${cmd.source}`,
              name: this.inputName(cmd.source),
              vendor: "atem",
              address: this.host,
              model: "Blackmagic via ATEM",
              status: "connected",
              revision: 0,
              tally: "unknown",
              controls: [],
            };
            this.cameras.set(cmd.source, cam);
          }
          const c = fromAtem(cmd),
            old = cam.controls.findIndex((v) => v.id === c.id);
          if (old < 0) cam.controls.push(c);
          else cam.controls[old] = c;
          cam.revision++;
          this.changed(cam);
        }
    });
    this.client.on("stateChanged", (state) => {
      for (const [id, c] of this.cameras) {
        c.name = this.inputName(id);
        this.changed(c);
      }
      this.routingChanged();
    });
    this.client.on("disconnected", () => {
      for (const c of this.cameras.values()) {
        c.status = "disconnected";
        c.tally = "unknown";
        this.changed(c);
      }
      this.routingChanged();
    });
    // atem-connection reconnects by itself; without this, cameras stay
    // "disconnected" and refuse writes although the switcher is back.
    this.client.on("connected", () => {
      for (const [id, c] of this.cameras) {
        c.status = "connected";
        c.name = this.inputName(id);
        this.changed(c);
      }
      this.routingChanged();
    });
  }
  inputName(source: number) {
    return this.client.state?.inputs[source]?.longName || `Camera ${source}`;
  }
  info() {
    return switcherInfo(
      this.host,
      this.client.state,
      this.client.status === AtemConnectionStatus.CONNECTED,
    );
  }
  async connect(input: Connection) {
    this.host = input.host;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.client.disconnect();
        reject(new Error("ATEM did not connect within 10 seconds"));
      }, 10000);
      this.client.once("connected", () => {
        clearTimeout(timer);
        resolve();
      });
      this.client.connect(input.host, input.port ?? 9910).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    for (const [id, c] of this.cameras) {
      c.status = "connected";
      c.name = this.inputName(id);
    }
    for (const c of this.cameras.values())
      if (!c.controls.some((x) => x.id === "native"))
        c.controls.push({
          id: "native",
          label: "Advanced ATEM camera command",
          group: "Vendor",
          type: "json",
          writable: true,
          readable: false,
          freshness: "unknown",
          note: 'Any camera-control category/parameter: {"category":8,"parameter":0,"type":128,"values":[0,0,0,0]}. Uses absolute CCmd. Supported wire types: 0, 1, 2, 3, 4, 5, 128. Consult Blackmagic camera protocol and camera capabilities.',
        });
    return [...this.cameras.values()];
  }
  async refresh(c: Camera) {
    return structuredClone(
      this.cameras.get(Number(c.id.split("-").at(-1)))?.controls ?? [],
    );
  }
  async set(c: Camera, control: Control, value: Value) {
    const native =
      control.id === "native"
        ? (value as Record<string, unknown>)
        : {
            ...control.native,
            values:
              control.type === "json"
                ? (value as Record<string, unknown>).values
                : control.type === "action"
                  ? []
                  : Array.isArray(value)
                    ? value
                    : [value],
          };
    const cmd = nativeCommand(Number(c.id.split("-").at(-1)), native);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.sendCommand(cmd),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("ATEM command timed out; outcome unknown")),
            8000,
          );
        }),
      ]);
      if (this.client.status !== AtemConnectionStatus.CONNECTED)
        throw new Error("ATEM disconnected during the write; outcome unknown");
    } finally {
      clearTimeout(timer);
    }
    return { verified: false };
  }
  async close() {
    await this.client.disconnect();
    await this.client.destroy();
  }
}

export function nativeCommand(source: number, input: Record<string, unknown>) {
  const category = input.category,
    parameter = input.parameter,
    type = input.type as CameraControlDataType;
  if (
    !Number.isInteger(category) ||
    Number(category) < 0 ||
    Number(category) > 255 ||
    !Number.isInteger(parameter) ||
    Number(parameter) < 0 ||
    Number(parameter) > 255 ||
    ![0, 1, 2, 3, 4, 5, 128].includes(type)
  )
    throw new Error("Invalid ATEM category, parameter or data type");
  const values = input.values;
  if (!Array.isArray(values) || values.length > 128)
    throw new Error("Expected up to 128 native values");
  if (type === 0 && values.some((v) => typeof v !== "boolean"))
    throw new Error("BOOL values must be booleans");
  if (
    type === 5 &&
    (values.length !== 1 ||
      typeof values[0] !== "string" ||
      Buffer.byteLength(values[0]) > 255)
  )
    throw new Error("STRING requires one UTF-8 string (max 255 bytes)");
  if ([1, 2, 3, 128].includes(type)) {
    const [min, max] =
      type === 128
        ? [-16, 32767 / 2048]
        : type === 1
          ? [-128, 127]
          : type === 2
            ? [-32768, 32767]
            : [-2147483648, 2147483647];
    if (
      values.some(
        (v) =>
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          v < min ||
          v > max ||
          (type !== 128 && !Number.isInteger(v)),
      )
    )
      throw new Error("Native value outside ATEM wire-format range");
  }
  const bigintData =
    type === 4
      ? values.map((v) => {
          if (typeof v !== "string" || !/^-?\d+$/.test(v))
            throw new Error("SINT64 values must be decimal strings");
          const n = BigInt(v);
          if (n < -(1n << 63n) || n > (1n << 63n) - 1n)
            throw new Error("SINT64 value out of range");
          return n;
        })
      : [];
  const command = new CameraControlCommand(
    source,
    Number(category),
    Number(parameter),
    {
      type,
      relative: false,
      boolData: type === 0 ? values : [],
      numberData: [1, 2, 3, 128].includes(type) ? values : [],
      bigintData,
      stringData: type === 5 ? values[0] : "",
    },
  );
  // The dependency counts JS code units for STRING. CCmd requires UTF-8 bytes.
  if (type === 5)
    command.serialize = () => {
      const bytes = Buffer.from(values[0], "utf8"),
        packet = Buffer.alloc(16 + Math.ceil(bytes.length / 8) * 8);
      packet[0] = source;
      packet[1] = Number(category);
      packet[2] = Number(parameter);
      packet[4] = type;
      packet.writeUInt16BE(bytes.length, 6);
      bytes.copy(packet, 16);
      return packet;
    };
  return command;
}
