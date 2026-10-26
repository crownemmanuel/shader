import net from "node:net";
import type { Adapter, Camera, Connection, Control, Value } from "../types.js";
export function nibbles(n: number, width = 4) {
  return Array.from(
    { length: width },
    (_, i) => (n >> ((width - i - 1) * 4)) & 15,
  );
}
export function parseReply(buf: Buffer) {
  if (buf.length < 3 || buf[0] !== 0x90 || buf.at(-1) !== 0xff)
    throw new Error("Invalid VISCA reply");
  if ((buf[1] & 0xf0) === 0x60)
    throw new Error(`Camera rejected VISCA command (0x${buf[2].toString(16)})`);
  return buf.subarray(2, -1);
}
export class ViscaTransport {
  private socket?: net.Socket;
  private tail = Promise.resolve<unknown>(undefined);
  constructor(
    private host: string,
    private port = 5678,
  ) {}
  request(bytes: number[]): Promise<Buffer> {
    const result = this.tail.then(() => this.exchange(bytes));
    this.tail = result.catch(() => {});
    return result;
  }
  private async exchange(bytes: number[]): Promise<Buffer> {
    if (!this.socket || this.socket.destroyed) {
      this.socket = net.createConnection({ host: this.host, port: this.port });
      this.socket.on("error", () => {});
      const s = this.socket;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          s.destroy();
          reject(new Error("VISCA connection timed out"));
        }, 3000);
        s.once("connect", () => {
          clearTimeout(t);
          resolve();
        });
        s.once("error", (e) => {
          clearTimeout(t);
          reject(e);
        });
      });
    }
    const s = this.socket;
    return new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      const done = (error?: Error, result?: Buffer) => {
        clearTimeout(timer);
        s.off("data", read);
        s.off("error", fail);
        s.off("close", closed);
        error ? reject(error) : resolve(result!);
      };
      const fail = (e: Error) => done(e),
        closed = () => done(new Error("VISCA connection closed"));
      const read = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 4096) {
          s.destroy();
          return done(new Error("Oversized VISCA reply"));
        }
        let end;
        while ((end = data.indexOf(0xff)) >= 0) {
          const frame = data.subarray(0, end + 1);
          data = data.subarray(end + 1);
          if (frame.length < 3) continue;
          if ((frame[1] & 0xf0) === 0x40) continue;
          try {
            done(undefined, parseReply(frame));
          } catch (e) {
            done(e as Error);
          }
          return;
        }
      };
      const timer = setTimeout(() => {
        done(new Error("VISCA reply timed out; command outcome is unknown"));
        s.destroy();
      }, 3500);
      s.on("data", read);
      s.once("error", fail);
      s.once("close", closed);
      s.write(Buffer.from(bytes));
    });
  }
  close() {
    this.socket?.destroy();
  }
}
const specs: {
  id: string;
  label: string;
  group: string;
  code: number;
  max: number;
  style?: "byte" | "two";
  options?: { label: string; value: number }[];
  note?: string;
}[] = [
  {
    id: "white_balance_mode",
    label: "White balance mode",
    group: "Exposure",
    code: 0x35,
    max: 32,
    style: "byte",
    options: [
      { label: "Auto", value: 0 },
      { label: "Indoor", value: 1 },
      { label: "Outdoor", value: 2 },
      { label: "One push", value: 3 },
      { label: "Manual", value: 5 },
      { label: "Color temperature", value: 32 },
    ],
  },
  {
    id: "red_gain",
    label: "Red gain",
    group: "Color",
    code: 0x43,
    max: 255,
    note: "Requires manual white balance.",
  },
  {
    id: "blue_gain",
    label: "Blue gain",
    group: "Color",
    code: 0x44,
    max: 255,
    note: "Requires manual white balance.",
  },
  {
    id: "color_temperature",
    label: "Color temperature index",
    group: "Exposure",
    code: 0x20,
    max: 55,
    style: "two",
    note: "0 = 2500 K; 55 = 8000 K. Requires color temperature mode.",
  },
  {
    id: "exposure_mode",
    label: "Exposure mode",
    group: "Exposure",
    code: 0x39,
    max: 13,
    style: "byte",
    options: [
      { label: "Auto", value: 0 },
      { label: "Manual", value: 3 },
      { label: "Shutter priority", value: 10 },
      { label: "Iris priority", value: 11 },
      { label: "Bright", value: 13 },
    ],
  },
  // Exposure positions are native VISCA indexes (higher = brighter); the
  // f-stop/dB each index means varies by camera model, so no units are claimed.
  {
    id: "iris",
    label: "Iris position",
    group: "Exposure",
    code: 0x4b,
    max: 0x11,
    note: "Requires Manual or Iris priority exposure. 0 = closed.",
  },
  {
    id: "gain",
    label: "Gain position",
    group: "Exposure",
    code: 0x4c,
    max: 0x0f,
    note: "Requires Manual exposure.",
  },
  {
    id: "gain_limit",
    label: "Gain limit",
    group: "Exposure",
    code: 0x2c,
    max: 0x0f,
    style: "byte",
    note: "Highest gain position auto exposure and Simple brightness may use.",
  },
  {
    id: "shutter",
    label: "Shutter position",
    group: "Exposure",
    code: 0x4a,
    max: 0x15,
    note: "Requires Manual or Shutter priority exposure.",
  },
  {
    id: "bright",
    label: "Bright level",
    group: "Exposure",
    code: 0x4d,
    max: 0x1f,
    note: "Requires Bright exposure mode.",
  },
  {
    id: "exposure_compensation_mode",
    label: "Exposure compensation",
    group: "Exposure",
    code: 0x3e,
    max: 3,
    style: "byte",
    options: [
      { label: "On", value: 2 },
      { label: "Off", value: 3 },
    ],
  },
  {
    id: "exposure_compensation",
    label: "Exposure compensation level",
    group: "Exposure",
    code: 0x4e,
    max: 0x0e,
    note: "7 = neutral. Applies in Auto, Shutter priority and Iris priority when compensation is on.",
  },
  {
    id: "backlight",
    label: "Backlight compensation",
    group: "Exposure",
    code: 0x33,
    max: 3,
    style: "byte",
    options: [
      { label: "On", value: 2 },
      { label: "Off", value: 3 },
    ],
  },
  {
    id: "saturation",
    label: "Color gain",
    group: "Color",
    code: 0x49,
    max: 14,
    note: "Native index: 0 = 60%, 14 = 200%.",
  },
  {
    id: "hue",
    label: "Hue",
    group: "Color",
    code: 0x4f,
    max: 14,
    note: "Native index: 0 = −14°, 14 = +14°.",
  },
  {
    id: "brightness",
    label: "Brightness",
    group: "Image",
    code: 0xa1,
    max: 14,
    note: "Image processing brightness, not exposure. Native index 0–14.",
  },
  {
    id: "contrast",
    label: "Contrast",
    group: "Image",
    code: 0xa2,
    max: 14,
    note: "Native index 0–14.",
  },
  {
    id: "focus_mode",
    label: "Focus mode",
    group: "Lens",
    code: 0x38,
    max: 3,
    style: "byte",
    options: [
      { label: "Auto", value: 2 },
      { label: "Manual", value: 3 },
    ],
  },
  {
    id: "zoom",
    label: "Zoom position",
    group: "Lens",
    code: 0x47,
    max: 0x4000,
  },
  {
    id: "focus",
    label: "Focus position",
    group: "Lens",
    code: 0x48,
    max: 0xffff,
  },
];
export class PtzOpticsAdapter implements Adapter {
  transport!: ViscaTransport;
  async connect(i: Connection): Promise<Camera[]> {
    this.transport = new ViscaTransport(i.host, i.port ?? 5678);
    const version = await this.transport.request([0x81, 9, 0, 2, 0xff]);
    const c: Camera = {
      id: `ptz-${i.host}`,
      name: i.name || "PTZOptics",
      vendor: "ptzoptics",
      model: `VISCA ${version.toString("hex")}`,
      address: i.host,
      status: "connected",
      revision: 0,
      tally: "unknown",
      controls: [],
    };
    c.controls = await this.refresh(c);
    c.controls.push({
      id: "visca",
      label: "Advanced VISCA command",
      group: "Vendor",
      type: "json",
      writable: true,
      readable: false,
      freshness: "unknown",
      note: 'One complete command packet as {"hex":"81 01 … FF"}. Uses the same write guard as every other control. Consult the exact model manual.',
    });
    return [c];
  }
  async refresh(c: Camera) {
    const out: Control[] = [];
    for (const s of specs) {
      try {
        const result = await this.transport.request([0x81, 9, 4, s.code, 0xff]);
        const value = decodeControlReply(result, s.style, s.code);
        if (value === undefined || value > s.max) continue;
        out.push({
          id: s.id,
          label: s.label,
          group: s.group,
          type: s.options ? "enum" : "number",
          options: s.options,
          value,
          min: 0,
          max: s.max,
          step: 1,
          writable: true,
          readable: true,
          freshness: "reported",
          updatedAt: new Date().toISOString(),
          note: s.note,
          native: { code: s.code, style: s.style || "four" },
        });
      } catch (e) {
        if (/timed out|closed|connect/i.test(String(e))) throw e;
      }
    }
    return [...out, ...c.controls.filter((x) => x.id === "visca")];
  }
  async set(_c: Camera, c: Control, v: Value) {
    if (c.id === "visca") {
      const hex = (v as { hex?: string }).hex;
      if (!hex || !/^81(?:\s[0-9a-f]{2}){2,62}\sff$/i.test(hex))
        throw new Error("Expected one VISCA packet: 81 … FF");
      const b = hex.split(" ").map((x) => parseInt(x, 16));
      if (b.slice(0, -1).includes(255))
        throw new Error("Multiple VISCA packets are not allowed");
      await this.transport.request(b);
      return { verified: false };
    }
    const n = Number(v),
      style = c.native!.style,
      encoded = style === "byte" ? [n] : nibbles(n, style === "two" ? 2 : 4);
    await this.transport.request([
      0x81,
      1,
      4,
      c.native!.code as number,
      ...encoded,
      255,
    ]);
    const reply = await this.transport.request([
      0x81,
      9,
      4,
      c.native!.code as number,
      255,
    ]);
    const actual = decodeControlReply(
      reply,
      String(style),
      Number(c.native!.code),
    );
    return { verified: true, value: actual };
  }
  async move(pan: number, tilt: number, duration: number) {
    try {
      await this.transport.request(moveBytes(pan, tilt));
      await new Promise((r) => setTimeout(r, duration));
    } finally {
      await this.stop();
    }
  }
  /** Starts continuous pan/tilt at signed speeds; the caller owns stopping. */
  async drive(pan: number, tilt: number) {
    await this.transport.request(moveBytes(pan, tilt));
  }
  /** Zooms at a signed speed (-8 wide … 8 tele); 0 stops. The caller owns stopping. */
  async zoom(speed: number) {
    await this.transport.request(zoomBytes(speed));
  }
  async stop() {
    await this.transport.request([0x81, 1, 6, 1, 1, 1, 3, 3, 255]);
  }
  async close() {
    this.transport?.close();
  }
}

export function zoomBytes(speed: number) {
  const p = Math.min(7, Math.abs(speed) - 1);
  return [0x81, 1, 4, 7, speed === 0 ? 0 : (speed > 0 ? 0x20 : 0x30) | p, 255];
}
export function moveBytes(pan: number, tilt: number) {
  return [
    0x81,
    1,
    6,
    1,
    Math.max(1, Math.abs(pan)),
    Math.max(1, Math.abs(tilt)),
    pan === 0 ? 3 : pan < 0 ? 1 : 2,
    tilt === 0 ? 3 : tilt < 0 ? 1 : 2,
    255,
  ];
}

// Color-temperature inquiry returns a packed byte (pq), although its Direct
// command sends separate 0p 0q bytes. Some firmware returns split nibbles.
export function decodeControlReply(
  reply: Buffer,
  style: string | undefined,
  code: number,
) {
  return style === "byte" || (code === 0x20 && reply.length === 1)
    ? reply[0]
    : [...reply].reduce((a, b) => (a << 4) | (b & 15), 0);
}
