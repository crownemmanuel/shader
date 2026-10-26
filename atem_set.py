#!/usr/bin/env python3
"""Set camera-control values on one or more cameras through the ATEM.
Refuses if a camera is on program or an aux output unless --allow-live.

  python3 atem_set.py --cams 4 --lift 0,0,0,-0.043 --gamma 0,0.049,0.1,0
  python3 atem_set.py --cams 1,3,4,6 --tint 0 --shutter 20000 --hue-sat 0,1.1
"""
import argparse, sys
from atem_link import AtemLink, ccmd, decode_ccdp, INT16, INT32, FIXED16

# option -> (category, parameter, type, expected value count)
PARAMS = {
    "lift": (8, 0, FIXED16, 4), "gamma": (8, 1, FIXED16, 4),
    "gain": (8, 2, FIXED16, 4), "contrast": (8, 4, FIXED16, 2),
    "hue_sat": (8, 6, FIXED16, 2), "wb": (1, 2, INT16, 2),
    "shutter": (1, 5, INT32, 1),
}

ap = argparse.ArgumentParser()
ap.add_argument("--host", default="172.16.10.10")
ap.add_argument("--cams", required=True, help="comma-separated ATEM inputs")
for k, (_, _, _, n) in PARAMS.items():
    ap.add_argument("--" + k.replace("_", "-"), help=f"{n} comma-separated values")
ap.add_argument("--tint", type=int, help="set tint, keeping each camera's colour temperature")
ap.add_argument("--allow-live", action="store_true")
args = ap.parse_args()
cams = [int(c) for c in args.cams.split(",")]

changes = {}
for k, (_, _, typ, n) in PARAMS.items():
    raw = getattr(args, k)
    if raw:
        vals = [float(v) if typ == FIXED16 else int(v) for v in raw.split(",")]
        if len(vals) != n:
            sys.exit(f"--{k} needs {n} values")
        changes[k] = vals
if not changes and args.tint is None:
    sys.exit("Nothing to set")

link = AtemLink(args.host)
live = {f"{where} (cam {src})" for where, src in link.program_sources().items() if src in cams}
if live and not args.allow_live:
    sys.exit(f"Live: {', '.join(sorted(live))} -- not sending")

current = {}
for name, d in link.state:
    if name == "CCdP":
        current[(d[0], d[1], d[2])] = decode_ccdp(d)

payloads = []
for cam in cams:
    per_cam = dict(changes)
    if args.tint is not None and "wb" not in per_cam:
        per_cam["wb"] = [current[(cam, 1, 2)][0], args.tint]
    for k, vals in per_cam.items():
        cat, par, typ, _ = PARAMS[k]
        payloads.append(ccmd(cam, cat, par, typ, vals))

unacked, echoes = link.send_ccmds(payloads)
if unacked:
    sys.exit(f"ATEM did not acknowledge packets {unacked}")
latest = {(d[0], d[1], d[2]): decode_ccdp(d) for d in echoes}
for cam in cams:
    for k, (cat, par, _, _) in PARAMS.items():
        if k in changes or (k == "wb" and args.tint is not None):
            print(f"cam {cam} {k:<8} was {current.get((cam, cat, par))}  "
                  f"now {latest.get((cam, cat, par), 'no update echoed')}")
