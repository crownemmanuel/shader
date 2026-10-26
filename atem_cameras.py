#!/usr/bin/env python3
"""Decode camera-control (CCdP) state from an atem_dump.py capture and
print each camera's color settings. Takes the last value seen per
parameter, so live changes during capture are reflected."""
import json, math, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "atem_state.json"
cmds = json.load(open(SRC))

# Blackmagic camera control: (category, parameter) -> label
LABELS = {
    (0, 0): "focus", (0, 2): "aperture", (0, 9): "zoom_speed",
    (1, 1): "gain_legacy", (1, 2): "white_balance", (1, 5): "exposure_us",
    (1, 8): "detail", (1, 13): "gain_db", (1, 16): "nd",
    (4, 4): "color_bars",
    (8, 0): "lift", (8, 1): "gamma", (8, 2): "gain", (8, 3): "offset",
    (8, 4): "contrast", (8, 5): "luma_mix", (8, 6): "hue_sat",
    (11, 0): "ptz",
}
DEFAULTS = {
    "lift": [0, 0, 0, 0], "gamma": [0, 0, 0, 0], "gain": [1, 1, 1, 1],
    "offset": [0, 0, 0, 0], "contrast": [0.5, 1.0], "luma_mix": [1.0],
    "hue_sat": [0.0, 1.0],
}


def decode(d):
    typ, n8 = d[3], int.from_bytes(d[4:6], "big")
    n16, n32 = int.from_bytes(d[6:8], "big"), int.from_bytes(d[8:10], "big")
    p = d[16:]
    if typ in (0, 1):
        return [int.from_bytes(p[i:i + 1], "big", signed=True) for i in range(n8)]
    if typ == 2:
        return [int.from_bytes(p[i*2:i*2+2], "big", signed=True) for i in range(n16)]
    if typ == 3:
        return [int.from_bytes(p[i*4:i*4+4], "big", signed=True) for i in range(n32)]
    if typ == 0x80:
        return [round(int.from_bytes(p[i*2:i*2+2], "big", signed=True) / 2048, 3)
                for i in range(n16)]
    return None


names, cams, history = {}, {}, {}
for c in cmds:
    d = bytes.fromhex(c["data"])
    if c["name"] == "InPr":
        idx = int.from_bytes(d[0:2], "big")
        names[idx] = d[2:22].split(b"\0")[0].decode("latin1")
    elif c["name"] == "CCdP":
        cam, key = d[0], LABELS.get((d[1], d[2]), f"{d[1]}.{d[2]}")
        val = decode(d)
        history.setdefault((cam, key), []).append(val)
        cams.setdefault(cam, {})[key] = val


def fmt_rgby(v):
    return "R{:+.3f} G{:+.3f} B{:+.3f} Y{:+.3f}".format(*v) if v and len(v) == 4 else str(v)


for cam in sorted(cams):
    s = cams[cam]
    off = [k for k, dv in DEFAULTS.items() if k in s and s[k] != dv]
    print(f"\n=== Camera {cam}  ({names.get(cam, '?')})"
          + ("   [all color at defaults]" if not off else f"   [non-default: {', '.join(off)}]"))
    if "white_balance" in s:
        print(f"  White balance : {s['white_balance'][0]} K, tint {s['white_balance'][1]:+d}")
    if "gain_db" in s:
        h = [v[0] for v in history[(cam, 'gain_db')]]
        print(f"  Master gain   : {s['gain_db'][0]} dB" + (f"   (changed live: {h})" if len(set(h)) > 1 else ""))
    if "exposure_us" in s and s["exposure_us"][0]:
        print(f"  Shutter       : {s['exposure_us'][0]} us (1/{round(1e6 / s['exposure_us'][0])})")
    if "aperture" in s:
        print(f"  Iris          : f/{math.sqrt(2 ** s['aperture'][0]):.1f}")
    for k in ("lift", "gamma", "gain", "offset"):
        if k in s:
            print(f"  {k.capitalize():<14}: {fmt_rgby(s[k])}")
    if "contrast" in s:
        print(f"  Contrast      : pivot {s['contrast'][0]}, adjust {s['contrast'][1]}")
    if "hue_sat" in s:
        print(f"  Hue / Sat     : hue {s['hue_sat'][0]}, sat {s['hue_sat'][1]}")
    if "luma_mix" in s:
        print(f"  Luma mix      : {s['luma_mix'][0]}")
    if s.get("color_bars", [0])[0]:
        print(f"  COLOR BARS ON : {s['color_bars']}")
    other = {k: v for k, v in s.items() if "." in k}
    if other:
        print(f"  Other         : {other}")
