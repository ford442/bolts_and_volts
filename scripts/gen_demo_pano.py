#!/usr/bin/env python3
"""Paint public/levels/demo-pano/pano.png from public/levels/demo-pano.json.

Every rock pillar / bridge / pylon is positioned from the level's platform and goal
coordinates, so the painting and the collision geometry cannot drift apart. The image is
transparent where there is sky (the parallax layer beneath shows through).

    python3 scripts/gen_demo_pano.py

Requires Pillow and numpy. Keep PX_PER_UNIT / WORLD_RECT in sync with the level's world layer.
"""
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
LEVEL = ROOT / "public/levels/demo-pano.json"
OUT = ROOT / "public/levels/demo-pano/pano.png"

PX_PER_UNIT = 64
level = json.loads(LEVEL.read_text())
pano = next(l for l in level["backgroundLayers"] if l.get("mode") == "world")
CX, CY = pano["position"]["x"], pano["position"]["y"]
W_U, H_U = pano["size"]["x"], pano["size"]["y"]
X0, Y1 = CX - W_U / 2, CY + H_U / 2  # world coords of the image's top-left corner
W, H = int(W_U * PX_PER_UNIT), int(H_U * PX_PER_UNIT)
rng = random.Random(7)


def px(x, y):
    """World (x, y) -> image pixel (+Y is up in the world, down in the image)."""
    return ((x - X0) * PX_PER_UNIT, (Y1 - y) * PX_PER_UNIT)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

# --- distant ridge (semi-transparent so the parallax sky reads through) ---
ridge = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(ridge)
pts = [(0, H)]
for i in range(0, W + 40, 40):
    wx = X0 + i / PX_PER_UNIT
    wy = 1.5 + 2.2 * math.sin(wx * 0.19) + 1.2 * math.sin(wx * 0.53 + 1.3)
    pts.append((i, (Y1 - wy) * PX_PER_UNIT))
pts.append((W, H))
d.polygon(pts, fill=(38, 52, 86, 150))
img.alpha_composite(ridge.filter(ImageFilter.GaussianBlur(3)))


def rock_texture(w, h):
    """Strata + speckle, as an RGBA array, lit lighter at the top."""
    ys = np.linspace(0, 1, h)[:, None]
    base = np.array([108, 92, 84])[None, None, :] * (1 - ys[..., None]) + np.array([46, 40, 48])[None, None, :] * ys[..., None]
    base = np.broadcast_to(base, (h, w, 3)).astype(np.float32).copy()
    noise = np.random.default_rng(w * 7 + h).normal(0, 7, (h, w, 1))
    strata = (np.sin(np.arange(h)[:, None, None] / 9.0 + np.arange(w)[None, :, None] / 140.0) * 6)
    rgb = np.clip(base + noise + strata, 0, 255).astype(np.uint8)
    return np.concatenate([rgb, np.full((h, w, 1), 255, np.uint8)], axis=2)


def paint_pillar(cx, top, width, grass=(120, 220, 140)):
    """Rock pillar under a flat top surface at world y=top, centred on cx, running to the image bottom."""
    left, right = cx - width / 2 - 0.25, cx + width / 2 + 0.25
    x_a, y_t = px(left, top)
    x_b, _ = px(right, top)
    taper = min(0.35, width * 0.08) * PX_PER_UNIT
    poly = [(x_a, y_t), (x_b, y_t), (x_b - taper, H), (x_a + taper, H)]
    tex = Image.fromarray(rock_texture(W, H), "RGBA")
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(tex, (0, 0), mask)
    img.alpha_composite(layer)
    dd = ImageDraw.Draw(img)
    # bright lip exactly on the collision top surface
    dd.line([(x_a, y_t + 2), (x_b, y_t + 2)], fill=grass + (255,), width=5)
    for _ in range(int(width * 3)):  # hanging moss tufts
        tx = rng.uniform(x_a, x_b)
        dd.line([(tx, y_t), (tx + rng.uniform(-3, 3), y_t + rng.uniform(6, 22))], fill=(70, 150, 90, 220), width=2)


def paint_pylon(cx, base, height):
    """Lattice pylon with a glowing coil, standing on world y=base."""
    dd = ImageDraw.Draw(img)
    bx, by = px(cx, base)
    tx, ty = px(cx, base + height)
    half = 0.55 * PX_PER_UNIT
    steel = (150, 165, 190, 255)
    dd.line([(bx - half, by), (tx - 6, ty)], fill=steel, width=6)
    dd.line([(bx + half, by), (tx + 6, ty)], fill=steel, width=6)
    levels = 6
    for i in range(levels):
        t0, t1 = i / levels, (i + 1) / levels
        x0l, y0 = bx - half + (tx - 6 - (bx - half)) * t0, by + (ty - by) * t0
        x0r = bx + half + (tx + 6 - (bx + half)) * t0
        x1l, y1 = bx - half + (tx - 6 - (bx - half)) * t1, by + (ty - by) * t1
        x1r = bx + half + (tx + 6 - (bx + half)) * t1
        dd.line([(x0l, y0), (x1r, y1)], fill=steel, width=3)
        dd.line([(x0r, y0), (x1l, y1)], fill=steel, width=3)
        dd.line([(x1l, y1), (x1r, y1)], fill=steel, width=4)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r, a in ((70, 40), (44, 90), (26, 170)):
        gd.ellipse([tx - r, ty - r, tx + r, ty + r], fill=(90, 220, 255, a))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6)))
    dd = ImageDraw.Draw(img)
    dd.ellipse([tx - 12, ty - 12, tx + 12, ty + 12], fill=(220, 250, 255, 255))


def paint_arch(left, right, top, depth):
    """Steel truss arch hanging under a bridge deck whose top surface is world y=top."""
    dd = ImageDraw.Draw(img)
    xa, yt = px(left, top)
    xb, _ = px(right, top)
    steel = (150, 165, 190, 255)
    # lower half of an ellipse whose rim is the deck's top surface
    dd.arc([xa, yt - depth * PX_PER_UNIT, xb, yt + depth * PX_PER_UNIT], 0, 180, fill=steel, width=7)
    n = 9
    for i in range(1, n):
        t = i / n
        ax = xa + (xb - xa) * t
        ay = yt + depth * PX_PER_UNIT * math.sin(math.pi * t)
        dd.line([(ax, yt), (ax, ay)], fill=steel, width=3)


plats = {p["label"]: p for p in level["platforms"]}


def top_of(p):
    return p["position"]["y"] + p["size"]["y"] / 2


for label, p in plats.items():
    cx, w = p["position"]["x"], p["size"]["x"]
    if label == "bridge":
        paint_arch(cx - w / 2, cx + w / 2, top_of(p), 1.6)
        continue
    paint_pillar(cx, top_of(p), w)

# Landmarks stand on specific platform tops.
paint_pylon(plats["plateau"]["position"]["x"] + 1.2, top_of(plats["plateau"]), 3.6)
paint_pylon(plats["mesa"]["position"]["x"] - 1.6, top_of(plats["mesa"]), 4.2)

# Beacon halo behind the goal.
goal = level["goals"][0]
gx, gy = px(goal["position"]["x"], goal["position"]["y"] + 1.2)
halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
hd = ImageDraw.Draw(halo)
for r, a in ((190, 30), (120, 60), (60, 110)):
    hd.ellipse([gx - r, gy - r, gx + r, gy + r], fill=(255, 230, 120, a))
img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(14)))

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, optimize=True)
print(f"wrote {OUT} ({W}x{H}, {PX_PER_UNIT} px/unit, world x {X0}..{X0 + W_U}, y {Y1 - H_U}..{Y1})")
