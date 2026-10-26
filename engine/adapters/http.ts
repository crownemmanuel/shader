import DigestClient from "digest-fetch";
import type { Adapter, Camera, Connection, Control, Value } from "../types.js";
export class CameraHttp {
  private digest?: DigestClient;
  constructor(
    private base: string,
    username?: string,
    password?: string,
  ) {
    if (username) this.digest = new DigestClient(username, password ?? "");
  }
  async request(path: string, method = "GET", body?: unknown) {
    if (
      !path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\\") ||
      path.startsWith("//") ||
      /[\r\n#]/.test(path)
    )
      throw new Error("Invalid camera-relative path");
    const url = new URL(path, this.base);
    if (url.origin !== new URL(this.base).origin)
      throw new Error("Camera origin cannot change");
    const options: RequestInit = {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error" as const,
    };
    const response = await (this.digest
      ? this.digest.fetch(url.href, options)
      : fetch(url, options));
    if (!response.ok) throw new Error(`Camera HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Camera response too large");
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
}
export const restPaths = [
  "/colorCorrection/lift",
  "/colorCorrection/gamma",
  "/colorCorrection/gain",
  "/colorCorrection/offset",
  "/colorCorrection/contrast",
  "/colorCorrection/color",
  "/colorCorrection/lumaContribution",
  "/video/whiteBalance",
  "/video/whiteBalanceTint",
  "/video/gain",
  "/video/iso",
  "/video/ndFilter",
  "/video/shutter",
  "/lens/iris",
  "/lens/zoom",
  "/lens/focus",
  "/lens/opticalImageStabilization",
];
export class BlackmagicRestAdapter implements Adapter {
  http!: CameraHttp;
  async connect(i: Connection): Promise<Camera[]> {
    this.http = new CameraHttp(
      `${i.profile === "https" ? "https" : "http"}://${i.host}:${i.port ?? (i.profile === "https" ? 443 : 80)}`,
      i.username,
      i.password,
    );
    const p = await this.http.request("/control/api/v1/system/product");
    if (!p?.productName)
      throw new Error("Endpoint did not identify a Blackmagic camera");
    const c: Camera = {
      id: `bmd-${i.host}`,
      name: i.name || p.deviceName || p.productName,
      vendor: "blackmagic-rest",
      model: p.productName,
      address: i.host,
      status: "connected",
      revision: 0,
      tally: "unknown",
      controls: [],
    };
    c.controls = await this.refresh(c);
    c.controls.push({
      id: "rest",
      label: "Advanced camera API",
      group: "Vendor",
      type: "json",
      writable: true,
      readable: false,
      freshness: "unknown",
      note: 'All camera API operations: {"path":"/…","method":"PUT","body":{…}}. Paths are relative to /control/api/v1. Consult camera-provided documentation.',
    });
    return [c];
  }
  async refresh(c: Camera) {
    const controls: Control[] = [];
    for (const path of restPaths) {
      try {
        const value = await this.http.request("/control/api/v1" + path);
        if (typeof value !== "object" || !value) continue;
        controls.push({
          id: path,
          label: path
            .split("/")
            .at(-1)!
            .replace(/([A-Z])/g, " $1"),
          group: path.includes("colorCorrection")
            ? "Color"
            : path.includes("lens")
              ? "Lens"
              : "Exposure",
          type: "json",
          value,
          writable: true,
          readable: true,
          freshness: "reported",
          updatedAt: new Date().toISOString(),
          native: { path },
        });
      } catch (e) {
        if (!/HTTP (404|501|403)/.test(String(e))) throw e;
      }
    }
    return [...controls, ...c.controls.filter((x) => x.id === "rest")];
  }
  async set(_camera: Camera, c: Control, value: Value) {
    if (c.id === "rest") {
      const v = value as { path: string; method: string; body?: unknown };
      if (
        !/^\/[a-zA-Z0-9/_-]+$/.test(v.path) ||
        !["GET", "PUT", "POST", "DELETE"].includes(v.method)
      )
        throw new Error("Invalid API path or method");
      await this.http.request("/control/api/v1" + v.path, v.method, v.body);
      return { verified: false };
    }
    await this.http.request("/control/api/v1" + c.id, "PUT", value);
    return {
      verified: true,
      value: await this.http.request("/control/api/v1" + c.id),
    };
  }
  async close() {}
}
export class PtzHttpAdapter implements Adapter {
  http!: CameraHttp;
  async connect(i: Connection): Promise<Camera[]> {
    this.http = new CameraHttp(
      `http://${i.host}:${i.port ?? 80}`,
      i.username,
      i.password,
    );
    const info = await this.http.request("/cgi-bin/param.cgi?get_device_conf");
    if (!info?.data?.devname)
      throw new Error(
        "Camera does not support this HTTP profile. Try VISCA TCP for older PTZOptics models.",
      );
    const c: Camera = {
      id: `ptz-http-${i.host}`,
      name: i.name || info.data.devname,
      vendor: "ptzoptics",
      model: info.data.device_model || info.data.devname,
      address: i.host,
      status: "connected",
      revision: 0,
      tally: "unknown",
      controls: [],
    };
    c.controls = await this.refresh(c);
    c.controls.push({
      id: "cgi",
      label: "Advanced PTZOptics HTTP API",
      group: "Vendor",
      type: "json",
      writable: true,
      readable: false,
      freshness: "unknown",
      note: 'Use the vendor CGI request exactly: {"path":"/cgi-bin/ptzctrl.cgi?…","method":"GET"}. HTTP methods do not indicate whether a command changes the camera.',
    });
    return [c];
  }
  async refresh(c: Camera) {
    const raw = await this.http.request("/cgi-bin/param.cgi?get_image_conf"),
      values: Record<string, number> = {};
    if (typeof raw === "string")
      for (const m of raw.matchAll(/([a-zA-Z_]+)\s*=\s*"(-?\d+)"/g))
        values[m[1]] = Number(m[2]);
    const controls: Control[] = [
      {
        id: "image_state",
        label: "Image settings",
        group: "Image",
        type: "json",
        value: typeof raw === "object" ? raw : values,
        writable: false,
        readable: true,
        freshness: "reported",
      },
    ];
    for (const [id, label] of [
      ["rgain", "Red gain"],
      ["bgain", "Blue gain"],
    ] as const)
      controls.push({
        id,
        label,
        group: "Color",
        type: "number",
        min: 0,
        max: 255,
        step: 1,
        value: values[id],
        writable: true,
        readable: false,
        freshness: values[id] === undefined ? "unknown" : "reported",
        note: "Move 4K / Link 4K / Move SE / Studio profile; requires manual white balance. Request acceptance is not readback.",
      });
    return [...controls, ...c.controls.filter((x) => x.id === "cgi")];
  }
  async set(_camera: Camera, c: Control, value: Value) {
    if (c.id === "cgi") {
      const v = value as { path: string; method: string; body?: unknown };
      if (
        !/^\/cgi-bin\/[a-z_]+\.cgi(?:\?[^\r\n]*)?$/.test(v.path) ||
        !["GET", "POST"].includes(v.method)
      )
        throw new Error("Expected a PTZOptics CGI path and GET or POST");
      await this.http.request(v.path, v.method, v.body);
    } else
      await this.http.request(
        `/cgi-bin/ptzctrl.cgi?post_image_value&${c.id}&${value}`,
      );
    return { verified: false };
  }
  async close() {}
}
