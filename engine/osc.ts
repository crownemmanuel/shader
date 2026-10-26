export interface OscMessage {
  address: string;
  types: string;
  args: (string | number)[];
}
const pad = (n: number) => (n + 3) & ~3;
export function oscEncode(
  address: string,
  types: string,
  args: (string | number)[],
) {
  if (
    !address.startsWith("/") ||
    types.length !== args.length ||
    /[^ifs]/.test(types)
  )
    throw new Error("Invalid OSC message");
  const str = (value: string) => {
    if (value.includes("\0") || Buffer.byteLength(value) > 4096)
      throw new Error("Invalid OSC string");
    const b = Buffer.alloc(pad(Buffer.byteLength(value) + 1));
    b.write(value);
    return b;
  };
  return Buffer.concat([
    str(address),
    str("," + types),
    ...args.map((arg, i) => {
      if (types[i] === "s") {
        if (typeof arg !== "string") throw new Error("Expected OSC string");
        return str(arg);
      }
      if (typeof arg !== "number" || !Number.isFinite(arg))
        throw new Error("Expected OSC number");
      const b = Buffer.alloc(4);
      if (types[i] === "i") b.writeInt32BE(arg);
      else b.writeFloatBE(arg);
      return b;
    }),
  ]);
}
/** Look Link uses immediate packets. Scheduled bundles are rejected, never executed early. */
export function oscDecode(packet: Buffer, depth = 0): OscMessage[] {
  if (
    packet.length > 65507 ||
    packet.length < 4 ||
    packet.length % 4 ||
    depth > 4
  )
    throw new Error("Invalid OSC packet size");
  let offset = 0;
  const str = () => {
    const end = packet.indexOf(0, offset);
    if (end < 0 || end - offset > 4096) throw new Error("Invalid OSC string");
    const value = packet.toString("utf8", offset, end),
      next = pad(end + 1);
    if (next > packet.length || packet.subarray(end, next).some((b) => b !== 0))
      throw new Error("Invalid OSC padding");
    offset = next;
    return value;
  };
  const address = str();
  if (address === "#bundle") {
    if (packet.length < 16) throw new Error("Truncated OSC bundle");
    const tag = packet.readBigUInt64BE(8);
    if (tag !== 1n) {
      const seconds = Number(tag >> 32n) - 2208988800,
        fraction = Number(tag & 0xffffffffn) / 2 ** 32;
      if ((seconds + fraction) * 1000 > Date.now())
        throw new Error("Scheduled OSC bundles are unsupported");
    }
    offset = 16;
    const messages: OscMessage[] = [];
    while (offset < packet.length) {
      if (offset + 4 > packet.length) throw new Error("Truncated bundle");
      const size = packet.readInt32BE(offset);
      offset += 4;
      if (size < 4 || offset + size > packet.length)
        throw new Error("Invalid bundle element");
      messages.push(
        ...oscDecode(packet.subarray(offset, offset + size), depth + 1),
      );
      offset += size;
      if (messages.length > 300) throw new Error("Too many OSC messages");
    }
    return messages;
  }
  if (!address.startsWith("/")) throw new Error("Invalid OSC address");
  const tag = str();
  if (!tag.startsWith(",") || /[^ifs]/.test(tag.slice(1)))
    throw new Error("Unsupported OSC argument type");
  const types = tag.slice(1),
    args = [...types].map((type) => {
      if (type === "s") return str();
      if (offset + 4 > packet.length) throw new Error("Truncated OSC number");
      const value =
        type === "i" ? packet.readInt32BE(offset) : packet.readFloatBE(offset);
      offset += 4;
      if (!Number.isFinite(value)) throw new Error("Non-finite OSC number");
      return value;
    });
  if (offset !== packet.length) throw new Error("Unexpected OSC trailing data");
  return [{ address, types, args }];
}
