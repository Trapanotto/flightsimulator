"""
Lifting surfaces from real airfoil sections (NACA 4-digit), lofted along the span.

A surface is cut chordwise into a fixed box (leading edge to the rear spar, ending in a cove)
and a movable part behind it (flap, aileron, elevator, rudder) with a rounded nose that sits
in that cove, the way the real ones are built. Every section of one part has the same number
of points, so a part is a clean quad grid that shades smoothly.
"""

import math

import numpy as np

from .mesh import cosine_spacing, fan_cap, grid_faces


def naca4(m, p, t, x, closed_te=True):
    """Upper and lower surface points at chord positions x (0..1). Returns (xu, yu, xl, yl)."""
    x = np.asarray(x, float)
    a4 = -0.1036 if closed_te else -0.1015
    yt = 5 * t * (0.2969 * np.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 + a4 * x ** 4)
    if m == 0:
        yc = np.zeros_like(x)
        dyc = np.zeros_like(x)
    else:
        yc = np.where(x < p, m / p ** 2 * (2 * p * x - x ** 2),
                      m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x ** 2))
        dyc = np.where(x < p, 2 * m / p ** 2 * (p - x), 2 * m / (1 - p) ** 2 * (p - x))
    th = np.arctan(dyc)
    xu = x - yt * np.sin(th)
    yu = yc + yt * np.cos(th)
    xl = x + yt * np.sin(th)
    yl = yc - yt * np.cos(th)
    return xu, yu, xl, yl


def _upper(foil, x):
    xu, yu, _, _ = naca4(*foil, x)
    return np.stack([xu, yu], -1)


def _lower(foil, x):
    _, _, xl, yl = naca4(*foil, x)
    return np.stack([xl, yl], -1)


def mean_line(foil, x):
    u = _upper(foil, np.atleast_1d(x))
    l = _lower(foil, np.atleast_1d(x))
    return 0.5 * (u[:, 1] + l[:, 1]), 0.5 * (u[:, 1] - l[:, 1])


def section_full(foil, n=40):
    """Closed loop: trailing edge -> upper -> leading edge -> lower -> (TE again, not repeated)."""
    x = cosine_spacing(n)
    up = _upper(foil, x[::-1])          # TE .. LE
    lo = _lower(foil, x[1:-1])          # after LE .. before TE
    return np.vstack([up, lo])


def section_box(foil, x_upper_end, x_lower_end, n=40, n_cove=7):
    """
    Fixed part: from the upper skin's rear end (it overhangs as a shroud) forward round the
    leading edge, along the lower skin, then up the cove (a concave arc) back to the start.
    """
    s = cosine_spacing(n)
    xu = s[::-1] * x_upper_end
    xl = s[1:] * x_lower_end
    up = _upper(foil, xu)
    lo = _lower(foil, xl)
    a = lo[-1]
    b = up[0]
    cove = []
    for k in range(1, n_cove):
        t = k / n_cove
        p = a + (b - a) * t
        # Bow the cove forward like the curved rear spar web.
        p = p + np.array([-0.022 * math.sin(math.pi * t) * (abs(b[1] - a[1]) / 0.07), 0.0])
        cove.append(p)
    return np.vstack([up, lo, np.array(cove)]) if cove else np.vstack([up, lo])


def section_movable(foil, x_nose, n=30, n_nose=10, x_end=1.0):
    """
    Movable part: rounded nose at x_nose, upper skin to the trailing edge, lower skin back.
    x_end < 1 cuts the trailing edge square (where a trim tab sits behind it).
    Returns (loop, hinge) with hinge = centre of the nose circle in chord units.
    """
    yc, ht = mean_line(foil, x_nose + 0.02)
    r = float(ht[0]) * 0.98
    cx = x_nose + r
    cy = float(yc[0])
    s = cosine_spacing(n)
    x = cx + (x_end - cx) * s
    up = _upper(foil, x)
    lo = _lower(foil, x)
    # Blend the first points onto the nose circle so the skin is tangent to it.
    up[0] = (cx, cy + r)
    lo[0] = (cx, cy - r)
    nose = []
    for k in range(1, n_nose):
        a = math.pi / 2 + math.pi * k / n_nose
        nose.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    tail = lo[:-1] if x_end >= 1.0 else lo
    loop = np.vstack([up[::-1], np.array(nose), tail])  # TE -> upper fwd -> nose -> lower aft
    return loop, (cx, cy)


class Planform:
    """
    Span-wise geometry of a surface. Functions of the span coordinate s (metres):
      le(s)    -> (a, b) chord-plane position of the leading edge: a along FS, b normal offset
      chord(s) -> metres
      twist(s) -> radians, positive = leading edge up, about the quarter chord
    `vertical`: span runs up the WL axis (fin); otherwise along BL (wing, stabiliser).
    """

    def __init__(self, le, chord, twist=lambda s: 0.0, vertical=False, side=1):
        self.le, self.chord, self.twist, self.vertical, self.side = le, chord, twist, vertical, side

    def point(self, s, x, y):
        """Design-frame point at span s, chord fraction x, thickness fraction y."""
        c = self.chord(s)
        fs0, n0 = self.le(s)
        th = self.twist(s)
        dx = (x - 0.25) * c
        yy = y * c
        X = 0.25 * c + dx * math.cos(th) + yy * math.sin(th)
        Y = yy * math.cos(th) - dx * math.sin(th)
        if self.vertical:
            # thickness along BL, span along WL
            return np.array([Y, fs0 + X, s])
        return np.array([self.side * s, fs0 + X, n0 + Y])


def loft(plan, stations, loop_at, cap_start=False, cap_end=False, tip=None):
    """
    Lofts a loop function (span s -> (k,2) chord-unit loop) over the stations.
    tip: (length, droop, n) adds a rounded tip beyond the last station: the section shrinks
    in thickness elliptically and closes, like a moulded wing-tip fairing.
    """
    rows = []
    for s in stations:
        loop = loop_at(s)
        rows.append([plan.point(s, x, y) for x, y in loop])
    if tip is not None:
        length, droop, n = tip
        s_end = stations[-1]
        loop = loop_at(s_end)
        direction = 1.0 if stations[-1] > stations[0] else -1.0
        # Thickness around the local mean line shrinks; the chord stays (the tip is cut square
        # in plan view on the 172, rounded in front view).
        mean = 0.5 * (loop[:, 1].max() + loop[:, 1].min())
        for k in range(1, n + 1):
            t = k / n
            f = math.sqrt(max(1 - t ** 2, 0.0)) * 0.94 + 0.06 * (1 - t)
            s = s_end + direction * length * math.sin(t * math.pi / 2)
            pts = []
            for x, y in loop:
                yy = mean + (y - mean) * max(f, 0.03)
                # Round the plan-view corners a little at the leading edge.
                xx = x + (1 - x) * 0.10 * t ** 2 * (1 - x) ** 4
                p = plan.point(s_end, xx, yy - droop * t ** 2)
                if plan.vertical:
                    p[2] = s
                else:
                    p[0] = plan.side * s
                pts.append(p)
            rows.append(pts)
    n_cols = len(rows[0])
    verts = np.array([p for row in rows for p in row])
    faces = grid_faces(len(rows), n_cols, wrap_cols=True)
    if cap_start:
        c = len(verts)
        verts = np.vstack([verts, verts[:n_cols].mean(0)])
        faces += fan_cap(list(range(n_cols)), c, reverse=True)
    if cap_end or tip is not None:
        c = len(verts)
        base = (len(rows) - 1) * n_cols
        verts = np.vstack([verts, verts[base:base + n_cols].mean(0)])
        faces += fan_cap(list(range(base, base + n_cols)), c)
    return verts, faces


def stations(a, b, step, extra=()):
    n = max(2, int(math.ceil(abs(b - a) / step)) + 1)
    s = list(np.linspace(a, b, n))
    for e in extra:
        if min(a, b) < e < max(a, b):
            s.append(e)
    return sorted(set(round(v, 5) for v in s), reverse=b < a)
