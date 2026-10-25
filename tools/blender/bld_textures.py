"""
Facade and roof texture atlas for the regional building set (numpy, runs inside Blender).

Atlas: 4 x 4 cells of CELL px. Wall cells show one bay (3.5 m wide x 3.0 m high, one window);
roof cells a 2 x 2 m patch. Alpha = tint mask: 1.0 = plaster that may be tinted per instance,
0.5 = keep colour. Never 0: lossy WebP drops the colour of fully transparent pixels.
"""

import numpy as np

CELL = 512
GRID = 4

# Cell indices (shared with src/buildings/buildingMaterial.ts)
CELLS = {
    "plaster_window": 0,
    "chalet_wood": 1,
    "larch_dark": 2,
    "stone_rubble": 3,
    "engadin": 4,
    "pastel_window": 5,
    "urban": 6,
    "metal_hall": 7,
    "church": 8,
    "roof_clay": 9,
    "roof_gneiss": 10,
    "roof_shingle": 11,
    "roof_gravel": 12,
    "roof_metal": 13,
    "farm_wood": 14,
    "stone_plain": 15,
}

rng = np.random.default_rng(1291)


def noise(h, w, scale, octaves=4):
    """Smooth value noise in 0..1 (tileable)."""
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = scale * 2 ** o
        g = rng.random((n + 1, n + 1)).astype(np.float32)
        g[-1, :] = g[0, :]
        g[:, -1] = g[:, 0]
        ys = np.linspace(0, n, h, endpoint=False)
        xs = np.linspace(0, n, w, endpoint=False)
        y0 = ys.astype(int)
        x0 = xs.astype(int)
        ty = (ys - y0)[:, None]
        tx = (xs - x0)[None, :]
        ty = ty * ty * (3 - 2 * ty)
        tx = tx * tx * (3 - 2 * tx)
        a = g[y0][:, x0]
        b = g[y0][:, x0 + 1]
        c = g[y0 + 1][:, x0]
        d = g[y0 + 1][:, x0 + 1]
        out += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty)
        total += amp
        amp *= 0.5
    return out / total


def rgb(*c):
    return np.array(c, np.float32) / 255.0


def fill(color, var=0.06, scale=6):
    n = noise(CELL, CELL, scale)
    img = np.ones((CELL, CELL, 3), np.float32) * color
    return img * (1 - var + 2 * var * n)[..., None]


def rect(img, x0, y0, x1, y1, color, alpha=1.0):
    """Coordinates in 0..1 of the cell, y measured from the TOP."""
    X0, X1 = int(x0 * CELL), int(x1 * CELL)
    Y0, Y1 = int(y0 * CELL), int(y1 * CELL)
    img[Y0:Y1, X0:X1] = img[Y0:Y1, X0:X1] * (1 - alpha) + np.asarray(color) * alpha


def window(img, x0, y0, x1, y1, frame=rgb(240, 238, 230), shutters=None, cross=True):
    rect(img, x0 - 0.015, y0 - 0.015, x1 + 0.015, y1 + 0.015, frame * 0.75)
    rect(img, x0, y0, x1, y1, frame)
    gx0, gy0, gx1, gy1 = x0 + 0.02, y0 + 0.02, x1 - 0.02, y1 - 0.02
    # Glass: dark blue with a soft sky reflection gradient.
    Y0, Y1 = int(gy0 * CELL), int(gy1 * CELL)
    X0, X1 = int(gx0 * CELL), int(gx1 * CELL)
    t = np.linspace(0, 1, Y1 - Y0)[:, None, None]
    img[Y0:Y1, X0:X1] = rgb(40, 55, 75) * (1 - t) + rgb(18, 24, 34) * t
    if cross:
        cx = (gx0 + gx1) / 2
        rect(img, cx - 0.006, gy0, cx + 0.006, gy1, frame)
        rect(img, gx0, gy0 + (gy1 - gy0) * 0.42, gx1, gy0 + (gy1 - gy0) * 0.42 + 0.012, frame)
    if shutters is not None:
        w = (x1 - x0) * 0.5
        for sx in (x0 - w - 0.02, x1 + 0.02):
            rect(img, sx, y0, sx + w, y1, shutters)
            for k in range(8):
                yy = y0 + (y1 - y0) * (k + 0.5) / 8
                rect(img, sx, yy, sx + w, yy + 0.006, shutters * 0.7)


def planks(color, horizontal=False, width=0.055, var=0.12):
    img = fill(color, 0.05, 10)
    n = CELL
    idx = np.arange(n) / n
    stripe = (idx / width).astype(int)
    shade = rng.random(stripe.max() + 2)[stripe] * var * 2 - var
    gap = (idx / width) % 1 < 0.06
    if horizontal:
        img *= (1 + shade)[:, None, None]
        img[gap] *= 0.45
    else:
        img *= (1 + shade)[None, :, None]
        img[:, gap] *= 0.45
    grain = noise(n, n, 40, 2)
    return img * (0.9 + 0.2 * grain)[..., None]


def stones(base, size=0.09, mortar=rgb(150, 145, 135)):
    img = np.ones((CELL, CELL, 3), np.float32) * mortar
    rows = int(1 / size)
    y = 0.0
    while y < 1.0:
        h = size * rng.uniform(0.7, 1.2)
        x = -rng.uniform(0, size)
        while x < 1.0:
            w = size * rng.uniform(0.9, 1.8)
            c = base * rng.uniform(0.78, 1.15) * np.array([rng.uniform(0.98, 1.02) for _ in range(3)], np.float32)
            rect(img, max(x, 0) + 0.004, y + 0.004, min(x + w, 1) - 0.004, min(y + h, 1) - 0.004, np.clip(c, 0, 1))
            x += w
        y += h
    del rows
    return img * (0.88 + 0.24 * noise(CELL, CELL, 14))[..., None]


def roof_tiles(color, rows=10, var=0.18):
    img = fill(color, 0.04, 8)
    v = np.arange(CELL) / CELL
    row = (v * rows).astype(int)
    tv = (v * rows) % 1
    # Each row darker at its lower edge (overlap shadow), random per-tile tint.
    shade = 0.75 + 0.35 * np.sin(np.pi * tv) ** 0.6
    img *= shade[:, None, None]
    cols = 14
    u = np.arange(CELL) / CELL
    for r in range(rows):
        off = (r % 2) * 0.5 / cols
        tile = (((u + off) * cols).astype(int)) % cols
        tint = 1 + (rng.random(cols) * 2 - 1) * var
        img[row == r] *= tint[tile][None, :, None]
        edge = ((u + off) * cols) % 1 < 0.05
        img[np.ix_(row == r, edge)] *= 0.7
    return img


def build_atlas():
    atlas = np.zeros((CELL * GRID, CELL * GRID, 4), np.float32)

    def put(name, img, tint_mask=None):
        i = CELLS[name]
        cx, cy = i % GRID, i // GRID
        m = np.zeros((CELL, CELL), np.float32) if tint_mask is None else tint_mask
        a = 0.5 + 0.5 * m
        # Atlas rows count from the top here; flipped to Blender's bottom-up order at the end.
        atlas[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, :3] = np.clip(img, 0, 1)
        atlas[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, 3] = a

    def plaster_mask(img_fn):
        return img_fn

    # 0 White plaster with a window and green shutters (farmhouse ground floor, generic).
    img = fill(rgb(236, 232, 222), 0.05, 6)
    mask = np.ones((CELL, CELL), np.float32)
    window(img, 0.36, 0.3, 0.64, 0.72, shutters=rgb(52, 92, 60))
    mask[int(0.27 * CELL):int(0.75 * CELL), int(0.18 * CELL):int(0.82 * CELL)] = 0
    put("plaster_window", img, mask)

    # 1 Chalet: horizontal dark wood, window with red-white shutters, flower box.
    img = planks(rgb(118, 74, 42), horizontal=True, width=0.07)
    window(img, 0.36, 0.28, 0.64, 0.7, frame=rgb(235, 230, 220), shutters=rgb(150, 40, 35))
    rect(img, 0.3, 0.7, 0.7, 0.76, rgb(90, 55, 30))
    for k in range(9):
        x = 0.31 + k * 0.043
        rect(img, x, 0.66, x + 0.03, 0.7, rgb(200, 40, 50) if k % 2 else rgb(220, 60, 120))
    put("chalet_wood", img)

    # 2 Valais larch: almost black weathered wood, tiny window.
    img = planks(rgb(62, 44, 32), horizontal=True, width=0.09, var=0.18)
    img *= (0.85 + 0.3 * noise(CELL, CELL, 5))[..., None]
    window(img, 0.42, 0.38, 0.58, 0.62, frame=rgb(200, 195, 180), cross=False)
    put("larch_dark", img)

    # 3 Rubble stone with a small deep window (rustico, plinths).
    img = stones(rgb(150, 145, 138))
    window(img, 0.43, 0.38, 0.57, 0.62, frame=rgb(120, 90, 60), cross=False)
    put("stone_rubble", img)

    # 4 Engadin: thick white walls, grey sgraffito band, small funnel window.
    img = fill(rgb(240, 238, 232), 0.04, 5)
    rect(img, 0.0, 0.08, 1.0, 0.12, rgb(120, 120, 118))
    for k in range(12):
        x = k / 12
        rect(img, x + 0.01, 0.13, x + 0.05, 0.17, rgb(130, 130, 126))
    rect(img, 0.38, 0.33, 0.62, 0.67, rgb(200, 198, 190))   # funnel reveal
    rect(img, 0.33, 0.29, 0.67, 0.71, rgb(170, 168, 160), 0.35)
    window(img, 0.43, 0.4, 0.57, 0.6, frame=rgb(245, 245, 240))
    put("engadin", img, np.ones((CELL, CELL), np.float32) * 0)

    # 5 Pastel plaster (Ticino), tintable, green shutters.
    img = fill(rgb(240, 236, 226), 0.06, 7)
    mask = np.ones((CELL, CELL), np.float32)
    window(img, 0.38, 0.28, 0.62, 0.74, shutters=rgb(70, 110, 70))
    mask[int(0.25 * CELL):int(0.77 * CELL), int(0.24 * CELL):int(0.76 * CELL)] = 0
    put("pastel_window", img, mask)

    # 6 Urban apartment facade: plaster with a wider window and a sill.
    img = fill(rgb(232, 228, 220), 0.04, 6)
    mask = np.ones((CELL, CELL), np.float32)
    window(img, 0.22, 0.26, 0.78, 0.72)
    rect(img, 0.2, 0.72, 0.8, 0.75, rgb(190, 188, 182))
    mask[int(0.23 * CELL):int(0.76 * CELL), int(0.19 * CELL):int(0.81 * CELL)] = 0
    put("urban", img, mask)

    # 7 Industrial hall: vertical corrugated metal, ribbon window high up.
    img = fill(rgb(176, 182, 186), 0.03, 4)
    u = np.arange(CELL) / CELL
    img *= (0.88 + 0.12 * np.sin(u * np.pi * 2 * 22))[None, :, None]
    rect(img, 0.0, 0.12, 1.0, 0.24, rgb(60, 72, 84))
    put("metal_hall", img)

    # 8 Church: white plaster with a tall arched window.
    img = fill(rgb(242, 240, 234), 0.04, 5)
    window(img, 0.42, 0.18, 0.58, 0.8, frame=rgb(200, 196, 186), cross=False)
    put("church", img)

    # 9-13 Roofs
    put("roof_clay", roof_tiles(rgb(150, 72, 48)))
    put("roof_gneiss", stones(rgb(118, 118, 116), size=0.16, mortar=rgb(80, 80, 78)))
    put("roof_shingle", roof_tiles(rgb(88, 66, 50), rows=16, var=0.25))
    put("roof_gravel", fill(rgb(130, 128, 122), 0.12, 30))
    img = fill(rgb(96, 100, 104), 0.03, 4)
    img *= (0.85 + 0.15 * (np.sin(u * np.pi * 2 * 8) > 0.9))[None, :, None]
    put("roof_metal", img)

    # 14 Farmhouse upper floor: warm vertical wood with a small window band.
    img = planks(rgb(150, 102, 60), horizontal=False, width=0.05)
    window(img, 0.34, 0.36, 0.66, 0.64, frame=rgb(240, 236, 226))
    put("farm_wood", img)

    # 15 Plain stone (plinths, no window)
    put("stone_plain", stones(rgb(140, 136, 128), size=0.11))

    return np.flipud(atlas).copy()
