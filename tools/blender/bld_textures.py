"""
Facade and roof texture atlas for the regional building set (numpy, runs inside Blender).

Atlas: 8 x 8 cells of CELL px: 16 material families (CELLS) with 4 variants each, cell index
= family * 4 + variant. The game picks the wall and roof variant per building. Wall cells show
one bay (3.5 m wide x 3.0 m high, one window); roof cells a 2.6 x 2.6 m patch. Alpha = tint mask: 1.0 = plaster that may be tinted per instance,
0.5 = keep colour. Never 0: lossy WebP drops the colour of fully transparent pixels.
"""

import numpy as np

CELL = 256
GRID = 8
VARIANTS = 4

# Material families (shared with src/buildings/buildingMaterial.ts and footprints.ts)
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


def balcony(img, y=0.62, color=rgb(70, 60, 52), wood=False):
    """Railing across the bay: top rail and balusters (or boards for chalets)."""
    rect(img, 0.0, y, 1.0, y + 0.03, color)
    rect(img, 0.0, 0.94, 1.0, 0.97, color * 0.8)
    if wood:
        for k in range(16):
            x = k / 16
            rect(img, x + 0.005, y + 0.03, x + 0.05, 0.94, color * rng.uniform(0.85, 1.1))
    else:
        for k in range(24):
            x = k / 24
            rect(img, x + 0.008, y + 0.03, x + 0.016, 0.94, color)
    # Slab edge and its shadow below.
    rect(img, 0.0, 0.97, 1.0, 1.0, rgb(205, 202, 195))


def roller_blind(img, x0, y0, x1, y1, down=0.45, color=rgb(200, 196, 186)):
    rect(img, x0 + 0.02, y0 + 0.02, x1 - 0.02, y0 + 0.02 + (y1 - y0 - 0.04) * down, color)
    for k in range(int(30 * down)):
        yy = y0 + 0.02 + k * (y1 - y0) / 30
        rect(img, x0 + 0.02, yy, x1 - 0.02, yy + 0.003, color * 0.82)


def curtain_wall(tint, mullion=rgb(70, 76, 82), rows=2, cols=3):
    """Glass facade: reflective panes in a mullion grid (offices, terminals)."""
    img = np.zeros((CELL, CELL, 3), np.float32)
    t = np.linspace(0, 1, CELL)[:, None, None]
    sky = rgb(150, 175, 195) * (1 - t) + rgb(55, 72, 92) * t
    img[:] = sky * tint
    img *= (0.9 + 0.2 * noise(CELL, CELL, 3, 2))[..., None]
    for c in range(cols + 1):
        x = c / cols
        rect(img, x - 0.012, 0, x + 0.012, 1, mullion)
    for r in range(rows + 1):
        y = r / rows
        rect(img, 0, y - 0.015, 1, y + 0.015, mullion)
    rect(img, 0, 0.92, 1, 1, mullion * 0.8)  # floor slab band
    return img


def panels(color, horizontal=True, n=6, gap=0.012):
    """Metal or concrete cladding panels with joints."""
    img = fill(color, 0.04, 5)
    for k in range(n + 1):
        p = k / n
        if horizontal:
            rect(img, 0, p - gap, 1, p + gap, color * 0.7)
        else:
            rect(img, p - gap, 0, p + gap, 1, color * 0.7)
    return img


def corrugated(color, ribs=22):
    img = fill(color, 0.03, 4)
    u = np.arange(CELL) / CELL
    return img * (0.88 + 0.12 * np.sin(u * np.pi * 2 * ribs))[None, :, None]


def solar(img, x0, y0, x1, y1):
    """Photovoltaic modules: dark blue cells with a thin silver grid."""
    rect(img, x0, y0, x1, y1, rgb(190, 192, 196))
    for i in range(6):
        for j in range(3):
            a = x0 + (x1 - x0) * i / 6
            b = y0 + (y1 - y0) * j / 3
            rect(img, a + 0.006, b + 0.006, a + (x1 - x0) / 6 - 0.006, b + (y1 - y0) / 3 - 0.006,
                 rgb(28, 40, 72) * rng.uniform(0.9, 1.1))


def wood_shingles(color, rows=26, cols=20):
    """Schindelschirm: small overlapping wooden shingles on walls (grey with age)."""
    return roof_tiles(color, rows=rows, var=0.22) * (0.95 + 0.1 * noise(CELL, CELL, 8))[..., None]


def build_atlas():
    atlas = np.zeros((CELL * GRID, CELL * GRID, 4), np.float32)

    def put(family, variant, img, tint_mask=None):
        i = CELLS[family] * VARIANTS + variant
        cx, cy = i % GRID, i // GRID
        m = np.zeros((CELL, CELL), np.float32) if tint_mask is None else tint_mask
        a = 0.5 + 0.5 * m
        # Atlas rows count from the top here; flipped to Blender's bottom-up order at the end.
        atlas[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, :3] = np.clip(img, 0, 1)
        atlas[cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL, 3] = a

    def plaster_mask(x0, y0, x1, y1):
        """Tintable plaster everywhere except the window area."""
        m = np.ones((CELL, CELL), np.float32)
        m[int(y0 * CELL):int(y1 * CELL), int(x0 * CELL):int(x1 * CELL)] = 0
        return m

    # ---- 0 plaster_window: farmhouse / generic plaster with shutters ----
    for v, shutter in enumerate([rgb(52, 92, 60), rgb(122, 40, 32), rgb(78, 96, 112), None]):
        img = fill(rgb(236, 232, 222), 0.05, 6)
        window(img, 0.36, 0.3, 0.64, 0.72, shutters=shutter)
        if shutter is None:
            # Flower box instead of shutters.
            rect(img, 0.32, 0.72, 0.68, 0.78, rgb(96, 62, 36))
            for k in range(10):
                x = 0.33 + k * 0.034
                rect(img, x, 0.67, x + 0.026, 0.72, rgb(205, 40, 50) if k % 3 else rgb(240, 200, 60))
            put("plaster_window", v, img, plaster_mask(0.3, 0.27, 0.7, 0.8))
        else:
            put("plaster_window", v, img, plaster_mask(0.18, 0.27, 0.82, 0.75))

    # ---- 1 chalet_wood ----
    specs = [
        (rgb(118, 74, 42), rgb(150, 40, 35), True),    # classic dark brown, red-white shutters
        (rgb(168, 112, 62), rgb(48, 90, 56), True),     # honey-coloured, green shutters
        (rgb(96, 62, 38), None, False),                 # dark, double window
        (rgb(128, 118, 104), rgb(110, 110, 104), True),  # weathered grey wood
    ]
    for v, (wood, shut, flowers) in enumerate(specs):
        img = planks(wood, horizontal=True, width=0.07)
        if shut is None:
            window(img, 0.18, 0.28, 0.46, 0.7, frame=rgb(235, 230, 220))
            window(img, 0.54, 0.28, 0.82, 0.7, frame=rgb(235, 230, 220))
        else:
            window(img, 0.36, 0.28, 0.64, 0.7, frame=rgb(235, 230, 220), shutters=shut)
        if flowers:
            rect(img, 0.3, 0.7, 0.7, 0.76, wood * 0.75)
            for k in range(9):
                x = 0.31 + k * 0.043
                rect(img, x, 0.66, x + 0.03, 0.7, rgb(200, 40, 50) if k % 2 else rgb(220, 60, 120))
        put("chalet_wood", v, img)

    # ---- 2 larch_dark (Valais) ----
    for v, (wood, var) in enumerate([(rgb(62, 44, 32), 0.18), (rgb(80, 54, 36), 0.15),
                                     (rgb(48, 36, 28), 0.2), (rgb(92, 74, 58), 0.2)]):
        img = planks(wood, horizontal=True, width=0.09, var=var)
        img *= (0.85 + 0.3 * noise(CELL, CELL, 5))[..., None]
        window(img, 0.42, 0.38, 0.58, 0.62, frame=rgb(200, 195, 180), cross=False,
               shutters=rgb(90, 30, 28) if v == 1 else None)
        put("larch_dark", v, img)

    # ---- 3 stone_rubble ----
    for v, base in enumerate([rgb(150, 145, 138), rgb(168, 150, 124), rgb(118, 116, 112), rgb(140, 132, 118)]):
        img = stones(base)
        window(img, 0.43, 0.38, 0.57, 0.62, frame=rgb(120, 90, 60), cross=False)
        put("stone_rubble", v, img)

    # ---- 4 engadin: thick plaster, sgraffito, funnel windows (tintable) ----
    for v in range(4):
        img = fill(rgb(240, 238, 232), 0.04, 5)
        band = [rgb(120, 120, 118), rgb(150, 90, 70), rgb(80, 90, 100), rgb(120, 110, 90)][v]
        rect(img, 0.0, 0.08, 1.0, 0.12, band)
        for k in range(12):
            x = k / 12
            if v % 2:
                rect(img, x + 0.02, 0.13, x + 0.06, 0.16, band)
                rect(img, x + 0.035, 0.16, x + 0.045, 0.19, band)
            else:
                rect(img, x + 0.01, 0.13, x + 0.05, 0.17, band * 1.08)
        rect(img, 0.38, 0.33, 0.62, 0.67, rgb(200, 198, 190))
        rect(img, 0.33, 0.29, 0.67, 0.71, rgb(170, 168, 160), 0.35)
        window(img, 0.43, 0.4, 0.57, 0.6, frame=rgb(245, 245, 240),
               shutters=[None, rgb(60, 92, 64), rgb(130, 50, 40), None][v])
        put("engadin", v, img, plaster_mask(0.25, 0.27, 0.75, 0.73) * (1 if v else 0))

    # ---- 5 pastel_window (Ticino) ----
    for v, shut in enumerate([rgb(70, 110, 70), rgb(120, 120, 112), rgb(110, 70, 45), rgb(70, 96, 120)]):
        img = fill(rgb(240, 236, 226), 0.06, 7)
        if v == 3:
            # Arched window with a stone frame.
            rect(img, 0.36, 0.22, 0.64, 0.3, rgb(200, 196, 186))
        window(img, 0.38, 0.28, 0.62, 0.74, shutters=shut)
        put("pastel_window", v, img, plaster_mask(0.24, 0.2, 0.76, 0.77))

    # ---- 6 urban: apartments, balconies, modern, office glass ----
    img = fill(rgb(232, 228, 220), 0.04, 6)
    window(img, 0.22, 0.26, 0.78, 0.72)
    rect(img, 0.2, 0.72, 0.8, 0.75, rgb(190, 188, 182))
    put("urban", 0, img, plaster_mask(0.19, 0.23, 0.81, 0.76))
    img = fill(rgb(232, 228, 220), 0.04, 6)
    window(img, 0.25, 0.12, 0.75, 0.9, cross=False)
    roller_blind(img, 0.25, 0.12, 0.75, 0.9, 0.35)
    balcony(img, 0.6)
    put("urban", 1, img, plaster_mask(0.0, 0.1, 1.0, 1.0))
    img = fill(rgb(225, 224, 220), 0.03, 5)
    window(img, 0.12, 0.2, 0.88, 0.78, frame=rgb(70, 72, 76), cross=False)
    rect(img, 0.5 - 0.006, 0.22, 0.5 + 0.006, 0.76, rgb(70, 72, 76))
    put("urban", 2, img, plaster_mask(0.1, 0.18, 0.9, 0.8))
    put("urban", 3, curtain_wall(np.ones(3, np.float32)))

    # ---- 7 metal_hall: cladding, tintable ----
    img = corrugated(rgb(196, 200, 204))
    rect(img, 0.0, 0.12, 1.0, 0.24, rgb(60, 72, 84))
    m = np.ones((CELL, CELL), np.float32)
    m[int(0.12 * CELL):int(0.24 * CELL), :] = 0
    put("metal_hall", 0, img, m)
    img = panels(rgb(200, 202, 204), horizontal=True, n=5)
    put("metal_hall", 1, img, np.ones((CELL, CELL), np.float32))
    img = panels(rgb(204, 204, 200), horizontal=False, n=3)
    rect(img, 0.08, 0.15, 0.92, 0.55, rgb(40, 52, 64))
    for k in range(4):
        rect(img, 0.08 + k * 0.28, 0.15, 0.1 + k * 0.28, 0.55, rgb(150, 150, 150))
    m = np.ones((CELL, CELL), np.float32)
    m[int(0.15 * CELL):int(0.55 * CELL), int(0.08 * CELL):int(0.92 * CELL)] = 0
    put("metal_hall", 2, img, m)
    img = panels(rgb(178, 174, 166), horizontal=True, n=3, gap=0.008)  # concrete panels
    img *= (0.9 + 0.2 * noise(CELL, CELL, 20, 3))[..., None]
    put("metal_hall", 3, img)

    # ---- 8 church ----
    for v in range(4):
        img = fill(rgb(242, 240, 234) * [1, 0.97, 1, 0.98][v], 0.04, 5)
        window(img, 0.42, 0.18, 0.58, 0.8, frame=rgb(200, 196, 186), cross=False)
        put("church", v, img)

    # ---- 9 roof_clay: red, brown, anthracite, old with moss ----
    put("roof_clay", 0, roof_tiles(rgb(150, 72, 48)))
    put("roof_clay", 1, roof_tiles(rgb(112, 64, 46)))
    put("roof_clay", 2, roof_tiles(rgb(62, 62, 64), var=0.1))
    img = roof_tiles(rgb(138, 76, 54), var=0.25)
    moss = noise(CELL, CELL, 6, 4)
    img = img * (1 - 0.4 * (moss > 0.6)[..., None]) + rgb(70, 80, 40) * 0.4 * (moss > 0.6)[..., None]
    put("roof_clay", 3, img)

    # ---- 10 roof_gneiss: stone slabs ----
    for v, (base, mortar) in enumerate([(rgb(118, 118, 116), rgb(80, 80, 78)),
                                        (rgb(132, 126, 116), rgb(90, 86, 80)),
                                        (rgb(100, 102, 104), rgb(70, 70, 70)),
                                        (rgb(140, 138, 132), rgb(96, 94, 90))]):
        put("roof_gneiss", v, stones(base, size=0.16, mortar=mortar))

    # ---- 11 roof_shingle: wood shingles, grey shingles, Eternit slate, clay ----
    put("roof_shingle", 0, roof_tiles(rgb(88, 66, 50), rows=16, var=0.25))
    put("roof_shingle", 1, roof_tiles(rgb(104, 100, 94), rows=16, var=0.2))
    img = roof_tiles(rgb(84, 88, 92), rows=12, var=0.06)
    put("roof_shingle", 2, img)
    put("roof_shingle", 3, roof_tiles(rgb(126, 68, 46), rows=12))

    # ---- 12 roof_gravel: gravel, green roof, solar, bitumen ----
    put("roof_gravel", 0, fill(rgb(130, 128, 122), 0.12, 30))
    img = fill(rgb(92, 112, 58), 0.2, 20)
    img *= (0.8 + 0.4 * noise(CELL, CELL, 9))[..., None]
    put("roof_gravel", 1, img)
    img = fill(rgb(130, 128, 122), 0.12, 30)
    solar(img, 0.05, 0.08, 0.95, 0.9)
    put("roof_gravel", 2, img)
    put("roof_gravel", 3, fill(rgb(58, 58, 60), 0.06, 12))

    # ---- 13 roof_metal: grey, green, red-brown standing seam, with solar ----
    u = np.arange(CELL) / CELL
    for v, col in enumerate([rgb(96, 100, 104), rgb(62, 96, 72), rgb(122, 58, 44), rgb(96, 100, 104)]):
        img = fill(col, 0.03, 4)
        img *= (0.85 + 0.15 * (np.sin(u * np.pi * 2 * 8) > 0.9))[None, :, None]
        if v == 3:
            solar(img, 0.06, 0.1, 0.94, 0.88)
        put("roof_metal", v, img)

    # ---- 14 farm_wood: upper floor of farmhouses ----
    img = planks(rgb(150, 102, 60), horizontal=False, width=0.05)
    window(img, 0.34, 0.36, 0.66, 0.64, frame=rgb(240, 236, 226))
    put("farm_wood", 0, img)
    img = wood_shingles(rgb(118, 112, 104))
    window(img, 0.34, 0.36, 0.66, 0.64, frame=rgb(240, 236, 226), shutters=rgb(52, 92, 60))
    put("farm_wood", 1, img)
    img = planks(rgb(112, 74, 46), horizontal=False, width=0.07)
    window(img, 0.34, 0.36, 0.66, 0.64, frame=rgb(240, 236, 226), shutters=rgb(150, 40, 35))
    put("farm_wood", 2, img)
    img = planks(rgb(176, 140, 96), horizontal=True, width=0.06)
    window(img, 0.3, 0.34, 0.7, 0.66, frame=rgb(240, 236, 226))
    put("farm_wood", 3, img)

    # ---- 15 stone_plain: plinths ----
    for v, base in enumerate([rgb(140, 136, 128), rgb(160, 148, 128), rgb(120, 118, 114), rgb(176, 172, 162)]):
        put("stone_plain", v, stones(base, size=0.11))

    return np.flipud(atlas).copy()
