import { Bonjour } from "bonjour-service";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import type { Discovery } from "./types.js";
export class DiscoveryService {
  private bonjour?: Bonjour;
  private found = new Map<string, Discovery>();
  private sockets: dgram.Socket[] = [];
  constructor(private onFound?: (candidate: Discovery) => void) {}
  start() {
    if (this.bonjour) return;
    this.bonjour = new Bonjour({}, () => {});
    for (const type of ["blackmagic", "http", "https", "rtsp", "sony"])
      this.bonjour.find({ type }, (service) => {
        const text = `${service.name} ${service.host} ${JSON.stringify(service.txt)}`;
        const vendor = /atem/i.test(text)
          ? "atem"
          : /blackmagic|ursa|pyxis/i.test(text)
            ? "blackmagic-rest"
            : /ptzoptics/i.test(text)
              ? "ptzoptics"
              : /sony|ilce|ilme|pxw/i.test(text)
                ? "sony"
                : "unknown";
        if (vendor === "unknown") return;
        const address =
          service.addresses?.find((a) => /^\d+\./.test(a)) ||
          service.host.replace(/\.$/, "");
        const candidate: Discovery = {
          id: address,
          name: service.name,
          vendor,
          address,
          port:
            vendor === "atem"
              ? 9910
              : vendor === "ptzoptics"
                ? 5678
                : service.port,
          protocol: "DNS-SD",
          note: "Advertised identity; Connect verifies protocol support.",
        };
        this.found.set(address, candidate);
        this.onFound?.(candidate);
      });
  }
  async scan() {
    this.start();
    const tasks = [this.probe("ssdp"), this.probe("ws")];
    await Promise.allSettled(tasks);
    return this.list();
  }
  private probe(kind: "ssdp" | "ws") {
    return new Promise<void>((resolve) => {
      const socket = dgram.createSocket("udp4");
      this.sockets.push(socket);
      const finish = () => {
        try {
          socket.close();
        } catch {}
        this.sockets = this.sockets.filter((s) => s !== socket);
        resolve();
      };
      const timer = setTimeout(finish, 1800);
      socket.on("error", () => {
        clearTimeout(timer);
        finish();
      });
      socket.on("message", (buf, remote) => {
        if (buf.length > 32768) return;
        const body = buf.toString();
        if (kind === "ssdp" && !/sony|ScalarWebAPI/i.test(body)) return;
        if (kind === "ws" && !/ProbeMatch/.test(body)) return;
        const sony = /sony|ScalarWebAPI/i.test(body),
          ptz = /ptzoptics/i.test(body);
        this.found.set(remote.address, {
          id: remote.address,
          address: remote.address,
          name: sony
            ? "Sony camera"
            : ptz
              ? "PTZOptics camera"
              : "ONVIF camera candidate",
          vendor: sony ? "sony" : ptz ? "ptzoptics" : "unknown",
          protocol: kind === "ssdp" ? "SSDP" : "WS-Discovery",
          note: sony
            ? "Legacy Sony advertisement; modern Camera Remote SDK discovery is also available."
            : "Camera identity and controls will be verified on connection.",
        });
      });
      socket.bind(0, () => {
        const payload =
          kind === "ssdp"
            ? 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-sony-com:service:ScalarWebAPI:1\r\n\r\n'
            : `<?xml version="1.0"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${randomUUID()}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
        socket.send(payload, kind === "ssdp" ? 1900 : 3702, "239.255.255.250");
      });
    });
  }
  add(candidate: Discovery) {
    this.found.set(candidate.id, candidate);
  }
  list() {
    return [...this.found.values()];
  }
  close() {
    this.bonjour?.destroy();
    for (const s of this.sockets)
      try {
        s.close();
      } catch {}
  }
}
