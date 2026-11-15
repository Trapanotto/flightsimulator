"""
'Alpine' livery of HB-ITS (an invented operator), computed per texel of the skin atlas (the
method of c172/livery.py and pc12/livery.py).

White fuselage with a grey belly fairing and light grey wings in the Airbus manner; the
title 'Alpine' in dark blue ahead of the wing, a thin dark-blue line along the cabin windows;
the fin dark blue with a sky-blue sweep and a small white edelweiss-like star; dark-blue
nacelles with a sky-blue band. Painted cabin windows and door outlines (there is no cabin to
look into), panel lines, the walkway and the registration on the aft fuselage and under the
left wing (tops of the letters towards the leading edge, ICAO Annex 7), grime on the belly and
soot behind the APU exhaust.
"""

import math
import os

import bpy
import numpy as np

from lib import bake as B
from lib import mesh as M
from . import dims as D
from .fuselage import T

WHITE = np.array([0.93, 0.935, 0.935])
GREY = np.array([0.60, 0.62, 0.64])
WING_GREY = np.array([0.66, 0.68, 0.70])
NAVY = np.array([0.035, 0.085, 0.24])
SKY = np.array([0.16, 0.46, 0.80])
WINDOW = np.array([0.045, 0.055, 0.07])
METAL = np.array([0.80, 0.81, 0.82])
DIRT = np.array([0.36, 0.33, 0.29])
SOOT = np.array([0.06, 0.055, 0.05])
REG = "HB-ITS"
TITLE = "Alpine"

TEXEL = [0.012]
DEPTH = 1.4


def srgb_to_linear(c):
    return np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)


def _font(bold=True):
    names = (r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\bahnschrift.ttf") if bold else \
        (r"C:\Windows\Fonts\bahnschrift.ttf",)
    for p in names + (os.path.join(os.path.dirname(bpy.app.binary_path),
                                   f"{bpy.app.version[0]}.{bpy.app.version[1]}", "datafiles", "fonts", "Inter.woff2"),):
        if os.path.exists(p):
            return p
    return None


def _groove(d, w):
    w = np.maximum(w, 0.8 * TEXEL[0])
    return np.exp(-(d / w) ** 2)


def _rivets(along, across, pitch, r=0.003):
    r = max(r, 0.6 * TEXEL[0])
    pitch = max(pitch, 4.5 * r)
    a = (np.mod(along, pitch) - pitch / 2)
    return np.exp(-(a * a + across * across) / (r * r))


def _rounded_rect_dist(u, v, cu, cv, hw, hh, r):
    """Signed distance to a rounded rectangle (negative inside)."""
    qx = np.abs(u - cu) - (hw - r)
    qy = np.abs(v - cv) - (hh - r)
    out = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2)
    return out + np.minimum(np.maximum(qx, qy), 0) - r


def cabin_windows():
    """FS of the cabin windows: 21 in pitch, gaps at the doors and the overwing exits."""
    out = []
    fs = 7.30
    while fs < 29.4:
        if not (14.85 < fs < 16.75):
            out.append(fs)
        fs += 0.533
    return out


DOORS = [(5.62, 6.44, 3.40, 5.28), (29.95, 30.77, 3.40, 5.28)]           # FS0, FS1, WL0, WL1
EXITS = [(15.02, 15.53, 3.86, 4.88), (16.08, 16.59, 3.86, 4.88)]
CARGO = [(8.55, 10.37, 1.95, 3.25), (23.95, 25.77, 1.95, 3.25)]            # right side
WIN_WL = 4.38


def compute(pos, nrm, pid, cov, ao, names):
    H, Wd = pid.shape
    step = np.linalg.norm(np.diff(pos, axis=1), axis=-1)
    ok = cov[:, 1:] & cov[:, :-1] & (pid[:, 1:] == pid[:, :-1])
    TEXEL[0] = float(np.median(step[ok & (step < 0.1)]))
    print(f"atlas texel size {TEXEL[0] * 1000:.1f} mm")
    bl, fs, wl = pos[..., 0], pos[..., 1], pos[..., 2]
    nb, nf, nw = nrm[..., 0], nrm[..., 1], nrm[..., 2]

    def part(*keys):
        ids = [i for i, n in enumerate(names) if any(n == k or (k.endswith("*") and n.startswith(k[:-1])) for k in keys)]
        return np.isin(pid, ids) & cov

    fuse = part("Fuselage")
    belly = part("BellyFairing")
    wing_box = part("Wing")
    wing = part("Wing", "WingCentreTE", "WingTipTE_*", "Fence_*", "FlapIn_*", "FlapOut_*", "Aileron_*", "Slat_*",
                "Spoiler*", "FlapTracks")
    fence = part("Fence_*")
    vtail = part("Fin", "FinCap", "Rudder", "TailFairings")
    htail = part("HStab", "Elevator_*")
    nacelle = part("Nacelle_*", "RevDoorMesh_*")
    pylon = part("Pylon_*", "Strake_*")
    doors = part("MainLegDoor_*", "MainDoorMesh_*", "NoseDoorMesh_*", "NoseLegDoor")
    noise = B.ValueNoise(20)
    p = pos.astype(np.float32)
    col = np.broadcast_to(WHITE, pos.shape).astype(np.float32).copy()
    rough = np.full((H, Wd), 0.26, np.float32)
    metal = np.zeros((H, Wd), np.float32)
    height = np.zeros((H, Wd), np.float32)

    def paint(mask, c, r=None):
        col[mask] = c
        if r is not None:
            rough[mask] = r

    paint(belly, GREY, 0.34)
    paint(wing | htail, WING_GREY, 0.32)
    paint(doors & (np.abs(bl) > 0.2), GREY, 0.34)
    paint(pylon, WING_GREY, 0.32)
    # Fence in the tail's dark blue with a sky-blue tip.
    paint(fence, NAVY, 0.26)
    side = np.abs(nb) > 0.25

    # --- nacelles: dark blue with a sky-blue band, the lip left bare --------------------------
    paint(nacelle, NAVY, 0.26)
    band = nacelle & (fs > 12.55) & (fs < 12.85)
    paint(band, SKY, 0.26)

    # --- fin: dark blue, a sky-blue sweep, the edelweiss --------------------------------------
    paint(vtail & (wl > D.FIN_ROOT_WL + 0.05), NAVY, 0.25)
    u = (wl - D.FIN_ROOT_WL) / (D.FIN_TOP_WL - D.FIN_ROOT_WL)
    x_le = D.FIN_ROOT_LE + (wl - D.FIN_ROOT_WL) * math.tan(D.FIN_SWEEP)
    chordf = D.FIN_ROOT_CHORD + np.clip(u, 0, 1.1) * (D.FIN_TOP_CHORD - D.FIN_ROOT_CHORD)
    xf = (fs - x_le) / chordf
    # The sweep: a band rising from the fin's lower front to the trailing edge near the top.
    line = 0.08 + 0.95 * xf
    sweep = vtail & (wl > D.FIN_ROOT_WL + 0.05) & (np.abs(u - line) < 0.11)
    paint(sweep, SKY, 0.25)
    thin = vtail & (wl > D.FIN_ROOT_WL + 0.05) & (np.abs(u - line - 0.18) < 0.025)
    paint(thin, SKY, 0.25)
    # Edelweiss: six woolly petals round a cluster of florets, small, low on the fin.
    ec_fs, ec_wl, er = 32.45, 7.05, 0.62
    du, dv = fs - ec_fs, wl - ec_wl
    rr = np.sqrt(du * du + dv * dv)
    ang = np.arctan2(dv, du)
    petal = np.abs(((ang * 6 / (2 * math.pi)) % 1.0) - 0.5) * 2      # 0 on a petal's axis .. 1 between
    rad = er * (0.42 + 0.58 * np.clip(1 - petal ** 1.6, 0, 1)) * (0.92 + 0.08 * np.cos(ang * 18))
    flower = vtail & (np.abs(nb) > 0.4) & (rr < rad)
    paint(flower, WHITE, 0.3)
    core = vtail & (np.abs(nb) > 0.4) & (rr < er * 0.26)
    paint(core, np.array([0.94, 0.80, 0.30]), 0.3)
    for k in range(6):
        a = k * math.pi / 3 + math.pi / 6
        cx, cy = ec_fs + 0.11 * math.cos(a), ec_wl + 0.11 * math.sin(a)
        dot = vtail & (np.abs(nb) > 0.4) & (np.hypot(fs - cx, wl - cy) < 0.04)
        paint(dot, np.array([0.80, 0.62, 0.18]), 0.3)

    # --- windows line, title, registration ------------------------------------------------------
    wline_lo = WIN_WL - 0.32
    pin = fuse & side & (fs > 6.9) & (fs < 29.6) & (np.abs(wl - wline_lo) < 0.022)
    paint(pin, NAVY, 0.26)
    win = np.zeros((H, Wd), bool)
    frame = np.zeros((H, Wd), bool)
    for wfs in cabin_windows():
        d = _rounded_rect_dist(fs, wl, wfs, WIN_WL, 0.115, 0.165, 0.075)
        win |= fuse & side & (d < 0)
        frame |= fuse & side & (d >= 0) & (d < 0.022)
    paint(frame, np.array([0.62, 0.64, 0.66]), 0.4)
    paint(win, WINDOW, 0.05)
    height -= np.where(win, 0.002, 0)
    for f0, f1, w0, w1 in EXITS:
        d = _rounded_rect_dist(fs, wl, (f0 + f1) / 2, WIN_WL, 0.115, 0.165, 0.075)
        paint(fuse & side & (d < 0), WINDOW, 0.05)
    bmp, gpx, pad = B.text_bitmap(TITLE, _font(), bold=0.02)
    th = 0.80
    tw = th * (bmp.shape[1] - 2 * pad) / gpx
    t_fs0, t_wl0 = 8.0, WIN_WL + 0.32
    left = fuse & (nb > 0.3)
    right = fuse & (nb < -0.3)
    cov_l = B.sample_bitmap(bmp, fs - t_fs0, wl - t_wl0, th, gpx, pad)
    cov_r = B.sample_bitmap(bmp, (t_fs0 + tw) - fs, wl - t_wl0, th, gpx, pad)
    for m, c in ((left, cov_l), (right, cov_r)):
        a = np.where(m, c, 0)[..., None]
        col[:] = col * (1 - a) + NAVY * a
    # The registration: small on the aft fuselage, large under the left wing.
    bmp, gpx, pad = B.text_bitmap(REG, _font(False), bold=0.01)
    rh = 0.30
    rw = rh * (bmp.shape[1] - 2 * pad) / gpx
    r_fs0, r_wl0 = 27.2, WIN_WL - 0.10
    cov_l = B.sample_bitmap(bmp, fs - r_fs0, wl - r_wl0, rh, gpx, pad)
    cov_r = B.sample_bitmap(bmp, (r_fs0 + rw) - fs, wl - r_wl0, rh, gpx, pad)
    for m, c in ((left, cov_l), (right, cov_r)):
        a = np.where(m, c, 0)[..., None]
        col[:] = col * (1 - a) + NAVY * a
    hw_ = 1.4
    ww = hw_ * (bmp.shape[1] - 2 * pad) / gpx
    under = wing_box & (bl > 0) & (nw < -0.6)
    bl0 = 7.0 + (12.0 - 7.0 - ww) / 2
    le = D.WING_ROOT_LE + (bl - D.WING_ROOT_BL) * math.tan(D.LE_SWEEP)
    cov_w = B.sample_bitmap(bmp, bl - bl0, (le + 0.6 + hw_) - fs, hw_, gpx, pad)
    a = np.where(under, cov_w, 0)[..., None]
    col[:] = col * (1 - a) + NAVY * a

    # --- panel lines, doors, fasteners (height field, metres) ---------------------------------
    gw = 0.004
    for c in (1.95, 2.25, 5.0, 7.0, 11.0, 13.0, 18.9, 21.5, 26.0, 28.6, 31.8, 34.6, 36.6):
        height -= np.where(fuse, 0.0008 * _groove(fs - c, gw), 0)
    for f0, f1, w0, w1 in DOORS:
        seg = B.poly_segments(M.rounded_polygon([(f0, w0), (f1, w0), (f1, w1), (f0, w1)], 0.12, 4))
        height -= np.where(fuse & side, 0.0012 * _groove(B.seg_distance(fs, wl, seg), gw), 0)
        hx = f0 + 0.1 if True else f1
        d = np.sqrt(((fs - hx) / 2.0) ** 2 + (wl - 4.2) ** 2)
        col[fuse & side & (d < 0.03)] *= 0.4
    for f0, f1, w0, w1 in EXITS:
        seg = B.poly_segments(M.rounded_polygon([(f0, w0), (f1, w0), (f1, w1), (f0, w1)], 0.08, 4))
        height -= np.where(fuse & side, 0.0010 * _groove(B.seg_distance(fs, wl, seg), gw), 0)
    for f0, f1, w0, w1 in CARGO:
        seg = B.poly_segments(M.rounded_polygon([(f0, w0), (f1, w0), (f1, w1), (f0, w1)], 0.10, 4))
        m = fuse & (nb < -0.2)
        height -= np.where(m, 0.0012 * _groove(B.seg_distance(fs, wl, seg), gw), 0)
    # Radome joint and the avionics hatch under the nose.
    height -= np.where(fuse & (nf < 0.9), 0.0008 * _groove(fs - 1.80 + 0.0 * wl, gw), 0)
    hatch = B.poly_segments(M.rounded_polygon([(-0.32, 3.4), (0.32, 3.4), (0.32, 4.3), (-0.32, 4.3)], 0.06, 3))
    height -= np.where(fuse & (nw < -0.6), 0.001 * _groove(B.seg_distance(bl, fs, hatch), gw), 0)
    for c in (2.55, 3.45, 5.30):
        m = fuse & (fs > 6.0) & (fs < 31.0)
        height += np.where(m, 0.00035 * _rivets(fs, wl - c, 0.05), 0)
    # Wing: spar rivet rows, the walkway outline and access panels.
    le_w = D.WING_ROOT_LE + np.maximum(np.abs(bl) - D.WING_ROOT_BL, 0) * math.tan(D.LE_SWEEP)
    a_ = np.abs(bl)
    chord = np.where(a_ <= D.KINK_BL,
                     D.ROOT_CHORD + np.clip((a_ - D.WING_ROOT_BL) / (D.KINK_BL - D.WING_ROOT_BL), 0, 1) *
                     (D.KINK_CHORD - D.ROOT_CHORD),
                     D.KINK_CHORD + (a_ - D.KINK_BL) / (D.TIP_BL - D.KINK_BL) * (D.TIP_CHORD - D.KINK_CHORD))
    xw = (fs - le_w) / chord
    for xs in (0.15, 0.60):
        height += np.where(wing_box, 0.0003 * _rivets(bl, (xw - xs) * chord, 0.05), 0)
    walk = wing_box & (nw > 0.6) & (a_ > 2.2) & (a_ < 5.0)
    edge = (np.abs(xw - 0.20) < 0.006) | (np.abs(xw - 0.55) < 0.006)
    paint(walk & edge, np.array([0.30, 0.32, 0.34]), 0.4)
    for c in (3.0, 4.5, 7.5, 9.0, 10.5, 12.0, 13.5):
        for sgn in (1, -1):
            seg = B.poly_segments(M.rounded_polygon([(sgn * c - 0.2, 0.30), (sgn * c + 0.2, 0.30),
                                                    (sgn * c + 0.2, 0.42), (sgn * c - 0.2, 0.42)], 0.03, 3))
            d = B.seg_distance(bl, xw, [(a, b * 3.0, cc, dd * 3.0) for a, b, cc, dd in seg])
            height -= np.where(wing_box & (nw < -0.5), 0.0007 * _groove(d, 0.004), 0)

    # --- weathering ---------------------------------------------------------------------------
    n_lo = noise.fbm(p, 0.7, 4)
    n_hi = noise.fbm(p, 14.0, 3)
    skin = cov
    rough += np.where(skin, 0.05 * (n_lo - 0.5) + 0.03 * np.clip(nw, 0, 1), 0)
    grime = (1 - ao) * 0.28 + np.clip(-nw, 0, 1) * 0.08 * (0.6 + 0.8 * n_lo)
    grime += np.where((fuse | belly) & (nw < -0.4), 0.08 * (0.5 + n_lo), 0)
    grime = np.clip(grime * np.where(skin & ~win, 1, 0), 0, 0.45)
    # APU soot on the cone's end, streaks behind the wing on the belly.
    s = np.where(fuse & (fs > 35.6), np.clip((fs - 35.6) / 1.6, 0, 1) ** 1.5 * (0.6 + 0.5 * n_hi), 0) * 0.8
    col = col * (1 - 0.5 * grime[..., None]) + DIRT * 0.5 * grime[..., None]
    col = col * (1 - s[..., None]) + SOOT * s[..., None]
    rough = rough + 0.25 * grime + 0.35 * s
    # Leading-edge erosion of slats and fin: chips to bare metal.
    chips = (part("Slat_*") & (noise(p, 60.0) > 0.86)) | (vtail & (xf < 0.03) & (noise(p, 60.0) > 0.84))
    col[chips] = METAL
    metal[chips] = 1.0
    rough[chips] = 0.35
    col = col * (1 + np.clip(height, -0.0015, 0)[..., None] * 120)
    rough = np.clip(rough, 0.08, 0.9)
    ao_out = np.clip(0.25 + 0.75 * ao, 0, 1)
    base = np.clip(col, 0, 1)
    base[~cov] = WHITE
    orm = np.stack([ao_out, rough, metal], -1)
    orm[~cov] = (1.0, 0.3, 0.0)
    nmap = B.height_to_normal(height, pos, cov, pid, strength=DEPTH)
    _ = T
    return srgb_to_linear(base), orm, nmap
