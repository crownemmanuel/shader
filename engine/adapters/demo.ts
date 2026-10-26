import type { Adapter, Camera, Control, Value } from "../types.js";
export class DemoAdapter implements Adapter {
  async connect(): Promise<Camera[]> {
    return [
      {
        id: "demo-studio",
        name: "Studio camera",
        vendor: "demo",
        model: "Simulated camera",
        address: "Local simulation",
        status: "demo",
        revision: 0,
        tally: "off",
        controls: [
          {
            id: "white_balance",
            label: "White balance",
            group: "Exposure",
            type: "number",
            value: 5600,
            min: 2500,
            max: 10000,
            step: 50,
            unit: "K",
          },
          {
            id: "tint",
            label: "Tint",
            group: "Exposure",
            type: "number",
            value: 0,
            min: -50,
            max: 50,
            step: 1,
          },
          {
            id: "iris",
            label: "Iris",
            group: "Exposure",
            type: "number",
            value: 2.8,
            min: 1.2,
            max: 22,
            step: 0.1,
            unit: "ƒ",
          },
          {
            id: "shutter_speed",
            label: "Shutter speed",
            group: "Exposure",
            type: "number",
            value: 60,
            min: 24,
            max: 5000,
            step: 1,
            unit: "1/s",
          },
          {
            id: "gain_db",
            label: "Sensor gain",
            group: "Exposure",
            type: "number",
            value: 0,
            min: -12,
            max: 36,
            step: 1,
            unit: "dB",
          },
          {
            id: "lift",
            label: "Lift",
            group: "Color",
            type: "vector",
            value: [0, 0, 0, 0],
            min: -1,
            max: 1,
            step: 0.01,
            components: ["Red", "Green", "Blue", "Master"],
          },
          {
            id: "gamma",
            label: "Gamma",
            group: "Color",
            type: "vector",
            value: [0, 0, 0, 0],
            min: -1,
            max: 1,
            step: 0.01,
            components: ["Red", "Green", "Blue", "Master"],
          },
          {
            id: "gain",
            label: "Gain",
            group: "Color",
            type: "vector",
            value: [1, 1, 1, 1],
            min: 0,
            max: 2,
            step: 0.01,
            components: ["Red", "Green", "Blue", "Master"],
          },
          {
            id: "saturation",
            label: "Saturation",
            group: "Color",
            type: "number",
            value: 1,
            min: 0,
            max: 2,
            step: 0.01,
          },
          {
            id: "focus",
            label: "Focus",
            group: "Lens",
            type: "number",
            value: 0.5,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            id: "autofocus",
            label: "Auto focus",
            group: "Lens",
            type: "action",
          },
        ].map(
          (x) =>
            ({
              ...x,
              writable: true,
              readable: x.type !== "action",
              freshness: "simulated",
            }) as Control,
        ),
      },
    ];
  }
  async refresh(c: Camera) {
    return structuredClone(c.controls);
  }
  async set(_c: Camera, _p: Control, value: Value) {
    return { verified: true, value };
  }
  async close() {}
}
