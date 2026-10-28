#!/usr/bin/env python3
"""Render the HCG board from cells.json at the exact calibrated coordinates."""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CELLS_PATH = ROOT / "src/game/data/cells.json"
OUT_PNG = ROOT / "public/BoardHAP.png"
PREVIEW = ROOT / "public/BoardHAP-preview.jpg"

W, H = 2160, 3840  # 9:16 @ 2K

BG = (11, 9, 20)
MINT = (0, 255, 170)
PURPLE = (199, 125, 255)
GOLD = (245, 197, 66)
PINK = (255, 107, 157)
CYAN = (0, 240, 255)
WHITE = (224, 224, 230)

TYPE_FILL = {
    "start": (0, 80, 70),
    "finish": (90, 60, 10),
    "normal": (28, 26, 42),
    "bitcoin": (18, 70, 55),
    "flask": (70, 40, 90),
    "bonus": (12, 55, 70),
    "penalty": (70, 18, 40),
    "snake": (90, 12, 28),
}
TYPE_GLOW = {
    "start": MINT,
    "finish": GOLD,
    "normal": (90, 90, 120),
    "bitcoin": MINT,
    "flask": PURPLE,
    "bonus": CYAN,
    "penalty": PINK,
    "snake": (255, 60, 80),
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    )
    for n in names:
        p = Path(n)
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))


def xy(cell):
    return int(cell["x"] / 100.0 * W), int(cell["y"] / 100.0 * H)


def catmull(pts, n=18):
    if len(pts) < 2:
        return pts
    out = []
    ext = [pts[0]] + pts + [pts[-1], pts[-1]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for j in range(n):
            t = j / n
            t2, t3 = t * t, t * t * t
            x = 0.5 * (
                2 * p1[0]
                + (-p0[0] + p2[0]) * t
                + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
            )
            y = 0.5 * (
                2 * p1[1]
                + (-p0[1] + p2[1]) * t
                + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
            )
            out.append((x, y))
    out.append(pts[-1])
    return out


def draw_glow_line(base, pts, color, width, blur=18, alpha=90):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.line(pts, fill=(*color, alpha), width=width, joint="curve")
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer)


def rounded_rect(draw, box, r, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def city_bg(rng: random.Random) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    px = img.load()
    for y in range(H):
        t = y / H
        c = mix((8, 6, 18), (18, 12, 48), 1 - t)
        c = mix(c, (40, 10, 50), max(0, 0.35 - t))
        for x in range(W):
            px[x, y] = c

    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    # stars
    for _ in range(900):
        x, y = rng.randint(0, W - 1), rng.randint(0, int(H * 0.55))
        a = rng.randint(30, 160)
        s = rng.choice([1, 1, 1, 2])
        col = rng.choice([WHITE, MINT, PURPLE, PINK, CYAN])
        d.ellipse((x, y, x + s, y + s), fill=(*col, a))

    # distant towers
    for i in range(28):
        tw = rng.randint(40, 140)
        th = rng.randint(280, 1100)
        x = int(i * (W / 22) + rng.randint(-20, 20))
        y = int(H * 0.08 + rng.randint(0, 200))
        col = mix((16, 14, 32), (40, 20, 70), rng.random() * 0.6)
        d.rectangle((x, y, x + tw, y + th), fill=(*col, 210))
        # windows
        for wy in range(y + 16, y + th - 10, 22):
            for wx in range(x + 8, x + tw - 8, 14):
                if rng.random() < 0.45:
                    wc = rng.choice([MINT, PURPLE, GOLD, PINK, CYAN])
                    d.rectangle((wx, wy, wx + 6, wy + 10), fill=(*wc, rng.randint(40, 140)))

    # holographic core in the empty sky (cells start ~28% down, like the old art)
    cx, cy, cr = int(W * 0.52), int(H * 0.13), 420
    for i, col in enumerate((PURPLE, PINK, MINT, GOLD)):
        rr = cr - i * 48
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=(*col, 70 - i * 10), width=3)
    d.polygon(
        [(cx, cy - 90), (cx + 70, cy), (cx, cy + 90), (cx - 70, cy)],
        outline=(*GOLD, 200),
    )
    d.polygon(
        [(cx, cy - 50), (cx + 38, cy), (cx, cy + 50), (cx - 38, cy)],
        fill=(*MINT, 40),
        outline=(*MINT, 220),
    )

    img = img.convert("RGBA")
    img.alpha_composite(overlay.filter(ImageFilter.GaussianBlur(0.6)))

    # vignette + scan
    vig = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse((-W * 0.15, -H * 0.05, W * 1.15, H * 1.05), fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(180))
    dark = Image.new("RGBA", (W, H), (4, 2, 10, 160))
    img.paste(Image.composite(img, dark, vig))

    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    step = 48
    for x in range(0, W, step):
        gd.line((x, 0, x, H), fill=(255, 255, 255, 10), width=1)
    for y in range(0, H, step):
        gd.line((0, y, W, y), fill=(255, 255, 255, 10), width=1)
    img.alpha_composite(grid)
    return img


def cell_radius(cell) -> int:
    t = cell["type"]
    if t in ("start", "finish"):
        return 78
    if t in ("snake", "flask", "bitcoin", "bonus", "penalty"):
        return 64
    return 50


def wrap(text: str, limit: int) -> list[str]:
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if len(trial) <= limit:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines[:3]


def main() -> None:
    cells = json.loads(CELLS_PATH.read_text(encoding="utf-8"))
    cells = sorted(cells, key=lambda c: c["id"])
    rng = random.Random(20260825)
    img = city_bg(rng)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    top = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    pts = [xy(c) for c in cells]
    smooth = catmull(pts, n=16)

    draw_glow_line(glow, smooth, PURPLE, 90, blur=28, alpha=70)
    draw_glow_line(glow, smooth, MINT, 54, blur=14, alpha=90)
    gd = ImageDraw.Draw(top)
    gd.line(smooth, fill=(18, 16, 32, 245), width=92, joint="curve")
    gd.line(smooth, fill=(40, 38, 62, 255), width=78, joint="curve")
    gd.line(smooth, fill=(*MINT, 70), width=6, joint="curve")

    img.alpha_composite(glow)
    img.alpha_composite(top)

    d = ImageDraw.Draw(img)
    f_num = font(28, bold=True)
    f_sm = font(18, bold=True)
    f_xs = font(16, bold=True)
    f_title = font(42, bold=True)
    f_sub = font(22, bold=True)

    # title
    d.text((80, 70), "HAPSTORE", font=f_title, fill=MINT)
    d.text((80, 128), "CYBER GRID  //  0 → 64", font=f_sub, fill=PURPLE)

    for cell in cells:
        x, y = xy(cell)
        r = cell_radius(cell)
        glow_c = TYPE_GLOW.get(cell["type"], MINT)
        fill = TYPE_FILL.get(cell["type"], (28, 26, 42))
        blob = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        bd = ImageDraw.Draw(blob)
        bd.ellipse((x - r * 1.8, y - r * 1.8, x + r * 1.8, y + r * 1.8), fill=(*glow_c, 70))
        img.alpha_composite(blob.filter(ImageFilter.GaussianBlur(18)))

        box = (x - r, y - r, x + r, y + r)
        d.rounded_rectangle(box, radius=int(r * 0.35), fill=fill, outline=glow_c, width=4)
        inner = (x - r + 8, y - r + 8, x + r - 8, y + r - 8)
        d.rounded_rectangle(inner, radius=int(r * 0.28), outline=(*glow_c, 90) if False else glow_c, width=1)

        label = str(cell["id"])
        bbox = d.textbbox((0, 0), label, font=f_num)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text((x - tw / 2, y - th / 2 - 4), label, font=f_num, fill=WHITE)

        extra = cell.get("extra")
        if extra:
            eb = d.textbbox((0, 0), extra, font=f_xs)
            ew = eb[2] - eb[0]
            d.text((x - ew / 2, y + r * 0.22), extra, font=f_xs, fill=glow_c)

        # special names off-cell, avoid overlapping the pad
        if cell["type"] not in ("normal",):
            name = cell["name"].replace(" (Финиш)", "")
            lines = wrap(name, 16)
            ny = y - r - 10 - 20 * len(lines)
            if ny < 40:
                ny = y + r + 12
            for i, line in enumerate(lines):
                lb = d.textbbox((0, 0), line, font=f_sm)
                lw = lb[2] - lb[0]
                nx = min(max(20, x - lw / 2), W - lw - 20)
                d.text((nx, ny + i * 22), line, font=f_sm, fill=glow_c)

    legend = [
        (MINT, "крипто / старт"),
        (PURPLE, "кристалл"),
        (CYAN, "бонус / ход"),
        (PINK, "штраф"),
        (GOLD, "финиш / ядро"),
        ((255, 60, 80), "краш −10"),
    ]
    lx, ly = 70, H - 280
    d.rounded_rectangle((50, ly - 30, 620, H - 70), radius=18, fill=(8, 6, 16, 200), outline=(*PURPLE, 120), width=2)
    d.text((70, ly - 18), "ЛЕГЕНДА", font=f_sm, fill=WHITE)
    for i, (col, txt) in enumerate(legend):
        yy = ly + 22 + i * 28
        d.ellipse((lx, yy, lx + 18, yy + 18), fill=col)
        d.text((lx + 28, yy - 2), txt, font=f_xs, fill=WHITE)

    out = img.convert("RGB")
    out.save(OUT_PNG, "PNG", optimize=True)
    preview = out.copy()
    preview.thumbnail((1080, 1920), Image.Resampling.LANCZOS)
    preview.save(PREVIEW, "JPEG", quality=92, optimize=True)
    print(f"wrote {OUT_PNG} {out.size} {OUT_PNG.stat().st_size}")
    print(f"wrote {PREVIEW}")


if __name__ == "__main__":
    main()
