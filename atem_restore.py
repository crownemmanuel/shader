#!/usr/bin/env python3
"""Restore camera color settings from an atem_dump.py snapshot.

Dry run by default: prints what would be sent. Pass --send to actually
write to the ATEM. Only restores white balance, shutter, master gain,
detail and the color corrector -- never lens/zoom/focus/PTZ/bars, so a
restore cannot move a camera.

  python3 atem_restore.py backups/atem_state_X.json --cams 1,3,4,6
  python3 atem_restore.py backups/atem_state_X.json --cams 4 --send
"""
import argparse, json, sys
from atem_link import AtemLink

RESTORABLE = {
    (1, 2): "white_balance", (1, 5): "exposure_us", (1, 13): "gain_db",
    (1, 8): "detail",
    (8, 0): "lift", (8, 1): "gamma", (8, 2): "gain", (8, 3): "offset",
    (8, 4): "contrast", (8, 5): "luma_mix", (8, 6): "hue_sat",
}
SIZES = {0: 1, 1: 1, 2: 2, 3: 4, 4: 8, 0x80: 2}  # bytes per element by type

ap = argparse.ArgumentParser()
ap.add_argument("snapshot")
ap.add_argument("--host", default="172.16.10.10")
ap.add_argument("--cams", help="comma-separated ATEM input numbers (default: all)")
ap.add_argument("--send", action="store_true", help="actually write to the ATEM")
args = ap.parse_args()
want = {int(c) for c in args.cams.split(",")} if args.cams else None


def ccdp_to_ccmd(d):
    """CCdP (state) -> CCmd (absolute set). CCmd has a 'relative' byte at 3,
    shifting type and counts one/two bytes later than CCdP."""
    typ = d[3]
    counts = [int.from_bytes(d[i:i + 2], "big") for i in (4, 6, 8, 10)]
    n = {0: counts[0], 1: counts[0], 2: counts[1], 0x80: counts[1],
         3: counts[2], 4: counts[3]}[typ]
    data = d[16:16 + n * SIZES[typ]]
    out = bytearray(16 + max(8, (len(data) + 7) // 8 * 8))
    out[0:3] = d[0:3]
    out[3] = 0  # absolute, not relative
    out[4] = typ
    slot = {0: 6, 1: 6, 2: 8, 0x80: 8, 3: 10, 4: 12}[typ]
    out[slot:slot + 2] = n.to_bytes(2, "big")
    out[16:16 + len(data)] = data
    return bytes(out)


latest = {}
for c in json.load(open(args.snapshot)):
    if c["name"] != "CCdP":
        continue
    d = bytes.fromhex(c["data"])
    if (d[1], d[2]) in RESTORABLE and (want is None or d[0] in want):
        latest[(d[0], d[1], d[2])] = d

cmds = [ccdp_to_ccmd(d) for _, d in sorted(latest.items())]
for (cam, cat, par), d in sorted(latest.items()):
    print(f"cam {cam:>2}  {RESTORABLE[(cat, par)]:<14} CCmd {ccdp_to_ccmd(d).hex(' ')}")
print(f"\n{len(cmds)} commands for cameras {sorted({k[0] for k in latest})}")
if not args.send:
    print("Dry run only -- nothing sent. Add --send to write to the ATEM.")
    sys.exit(0)


unacked, _ = AtemLink(args.host).send_ccmds(cmds)
print(f"Sent {len(cmds)} commands, ATEM acknowledged {len(cmds) - len(unacked)}")
if unacked:
    sys.exit(f"Not acknowledged: packet ids {unacked} -- re-run to retry")
