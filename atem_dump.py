#!/usr/bin/env python3
"""Read-only ATEM client: performs the UDP handshake, ACKs the initial
state dump, and saves every command to a JSON file. Sends nothing but
hello + ACK packets, so it cannot change switcher or camera settings."""
import json, socket, sys, time

HOST = sys.argv[1] if len(sys.argv) > 1 else "172.16.10.10"
OUT = sys.argv[2] if len(sys.argv) > 2 else "atem_state.json"
PORT = 9910

F_ACKREQ, F_HELLO, F_ACK = 0x08, 0x10, 0x80


def header(flags, length, session, ack=0, pkt=0):
    b = bytearray(12)
    b[0] = (flags & 0xF8) | ((length >> 8) & 0x07)
    b[1] = length & 0xFF
    b[2:4] = session.to_bytes(2, "big")
    b[4:6] = ack.to_bytes(2, "big")
    b[10:12] = pkt.to_bytes(2, "big")
    return b


s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(2)
hello = header(F_HELLO, 20, 0x53AB) + bytes([1, 0, 0, 0, 0, 0, 0, 0])
s.sendto(hello, (HOST, PORT))
d, _ = s.recvfrom(4096)
if d[12] != 2:
    sys.exit(f"Handshake rejected (code {d[12]}); switcher may have too many clients")
session = int.from_bytes(d[2:4], "big")
s.sendto(header(F_ACK, 12, session), (HOST, PORT))

cmds, seen, done_at = [], set(), None
deadline = time.time() + 20
while time.time() < deadline:
    try:
        d, _ = s.recvfrom(4096)
    except socket.timeout:
        if done_at:
            break
        continue
    flags = d[0] & 0xF8
    session = int.from_bytes(d[2:4], "big")
    pkt = int.from_bytes(d[10:12], "big")
    if flags & F_ACKREQ:
        s.sendto(header(F_ACK, 12, session, ack=pkt), (HOST, PORT))
    if pkt in seen:
        continue
    seen.add(pkt)
    i, n = 12, ((d[0] & 0x07) << 8) | d[1]
    while i + 8 <= n:
        clen = int.from_bytes(d[i:i + 2], "big")
        if clen < 8:
            break
        name = d[i + 4:i + 8].decode("latin1")
        cmds.append({"name": name, "data": d[i + 8:i + clen].hex()})
        if name == "InCm":
            done_at = time.time()
        i += clen
    # Keep listening ~3s after InCm to catch trailing camera-control updates
    if done_at and time.time() - done_at > 3:
        break

json.dump(cmds, open(OUT, "w"), indent=0)
print(f"Captured {len(cmds)} commands from {HOST} -> {OUT}")
