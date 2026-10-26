"""Minimal ATEM UDP link: handshake, ACK the state dump, send CCmd
camera-control commands and collect the CCdP updates that echo back."""
import socket, time

F_ACKREQ, F_HELLO, F_ACK = 0x08, 0x10, 0x80


def header(flags, length, session, ack=0, pkt=0):
    b = bytearray(12)
    b[0] = (flags & 0xF8) | ((length >> 8) & 0x07)
    b[1] = length & 0xFF
    b[2:4] = session.to_bytes(2, "big")
    b[4:6] = ack.to_bytes(2, "big")
    b[10:12] = pkt.to_bytes(2, "big")
    return b


def commands(d):
    """Split one packet's payload into (name, data) commands."""
    i, n = 12, ((d[0] & 0x07) << 8) | d[1]
    while i + 8 <= n:
        clen = int.from_bytes(d[i:i + 2], "big")
        if clen < 8:
            break
        yield d[i + 4:i + 8].decode("latin1"), d[i + 8:i + clen]
        i += clen


class AtemLink:
    def __init__(self, host, port=9910):
        self.addr = (host, port)
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.s.settimeout(1)
        self.s.sendto(header(F_HELLO, 20, 0x53AB) + bytes([1, 0, 0, 0, 0, 0, 0, 0]), self.addr)
        d, _ = self.s.recvfrom(4096)
        if d[12] != 2:
            raise RuntimeError(f"Handshake rejected (code {d[12]})")
        self.session = int.from_bytes(d[2:4], "big")
        self.s.sendto(header(F_ACK, 12, self.session), self.addr)
        self.next_pkt = 1
        self.state = []  # (name, data) from the initial dump
        self._pump(time.time() + 10, self.state, stop=lambda names, _: "InCm" in names)

    def _pump(self, until, sink, stop=None, acked=None):
        while time.time() < until:
            try:
                d, _ = self.s.recvfrom(4096)
            except socket.timeout:
                continue
            self.session = int.from_bytes(d[2:4], "big")
            if d[0] & F_ACKREQ:
                self.s.sendto(header(F_ACK, 12, self.session,
                                     ack=int.from_bytes(d[10:12], "big")), self.addr)
            if d[0] & F_ACK and acked is not None:
                acked.add(int.from_bytes(d[4:6], "big"))
            got = list(commands(d))
            sink.extend(got)
            if stop and stop({n for n, _ in got}, acked):
                break

    def program_sources(self):
        """Inputs currently on program (any M/E) or on an aux output."""
        out = {}
        for name, d in self.state:
            if name == "PrgI":
                out[f"ME{d[0] + 1} program"] = int.from_bytes(d[2:4], "big")
            elif name == "AuxS":
                out[f"Aux {d[0] + 1}"] = int.from_bytes(d[2:4], "big")
        return out

    def send_ccmds(self, payloads, listen=2.0):
        """Send CCmd payloads; return (unacked packet ids, CCdP echoes)."""
        packets, acked, echoes = {}, set(), []
        for p in payloads:
            body = (8 + len(p)).to_bytes(2, "big") + b"\0\0" + b"CCmd" + p
            packets[self.next_pkt] = body
            self.next_pkt += 1
        pending = list(packets)
        for _ in range(3):  # values are absolute, so re-sending is harmless
            for pkt in pending:
                body = packets[pkt]
                self.s.sendto(header(F_ACKREQ, 12 + len(body), self.session,
                                     pkt=pkt) + body, self.addr)
                time.sleep(0.02)
            self._pump(time.time() + listen, echoes, acked=acked)
            pending = [p for p in pending if p not in acked]
            if not pending:
                break
        return pending, [d for n, d in echoes if n == "CCdP"]


# Camera-control data types: type -> (bytes per element, CCmd count offset)
INT8, INT16, INT32, FIXED16 = 1, 2, 3, 0x80
TYPES = {INT8: (1, 6), INT16: (2, 8), INT32: (4, 10), FIXED16: (2, 8)}


def ccmd(cam, cat, par, typ, values):
    """Absolute CCmd payload. FIXED16 values are floats (5.11 fixed point)."""
    size, slot = TYPES[typ]
    if typ == FIXED16:
        values = [int(round(v * 2048)) for v in values]
    data = b"".join(int(v).to_bytes(size, "big", signed=True) for v in values)
    out = bytearray(16 + max(8, (len(data) + 7) // 8 * 8))
    out[0:3] = bytes([cam, cat, par])
    out[4] = typ
    out[slot:slot + 2] = len(values).to_bytes(2, "big")
    out[16:16 + len(data)] = data
    return bytes(out)


def fixed16_ccmd(cam, cat, par, values):
    return ccmd(cam, cat, par, FIXED16, values)


def decode_ccdp(d):
    """Values from a CCdP (state) payload; its type/counts sit one byte
    earlier than in CCmd."""
    typ = d[3]
    if typ not in TYPES:
        return None
    size, slot = TYPES[typ]
    n = int.from_bytes(d[slot - 2:slot], "big")
    vals = [int.from_bytes(d[16 + i*size:16 + (i+1)*size], "big", signed=True)
            for i in range(n)]
    return [round(v / 2048, 3) for v in vals] if typ == FIXED16 else vals


def decode_fixed16(d):
    return decode_ccdp(d)
