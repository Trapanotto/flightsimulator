"""
HB-FTS livery and surface detail of the PC-12, computed per texel of the skin atlas (the same
method as the Cessna's c172/livery.py).

White, with a restrained two-colour cheatline (slate grey with a thin red line above it)
from the cowling to the tail, where it sweeps up towards the fin; black pneumatic de-ice
boots on the wing and tail leading edges; the registration on the rear fuselage and under
the left wing (ICAO Annex 7: tops of the letters towards the leading edge); a Swiss flag on
both sides of the fin. Panel lines (cowling, airstair and cargo doors, fuselage joints),
restrained rivet rows, exhaust soot behind the PT6 stubs and grime on the belly.
"""

import os

import bpy
import numpy as np

from lib import bake as B
from lib import mesh as M
from . import dims as D
from . import wing as W

WHITE = np.array([0.93, 0.932, 0.925])
SLATE = np.array([0.16, 0.19, 0.24])
RED = np.array([0.74, 0.05, 0.07])
BOOT = np.array([0.045, 0.045, 0.048])
METAL = np.array([0.80, 0.81, 0.82])
DIRT = np.array([0.36, 0.32, 0.27])
SOOT = np.array([0.07, 0.063, 0.055])
REG = "HB-FTS"

TEXEL = [0.006]
DEPTH = 1.8


def srgb_to_linear(c):
    return np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)


def _font():
    for p in (r"C:\Windows\Fonts\bahnschrift.ttf",
              os.path.join(os.path.dirname(bpy.app.binary_path),
                           f"{bpy.app.version[0]}.{bpy.app.version[1]}", "datafiles", "fonts", "Inter.woff2")):
        if os.path.exists(p):
            return p
    return None


def _groove(d, w):
    w = np.maximum(w, 0.8 * TEXEL[0])
    return np.exp(-(d / w) ** 2)


def _rivets(along, across, pitch, r=0.0022):
    r = max(r, 0.6 * TEXEL[0])
    pitch = max(pitch, 4.5 * r)
    a = (np.mod(along, pitch) - pitch / 2)
    return np.exp(-(a * a + across * across) / (r * r))


def _wing_x(bl, fs):
    a = np.abs(bl)
    t = np.clip((a - D.WING_ROOT_BL) / (D.TIP_BL - D.WING_ROOT_BL), 0, 1)
    le = D.WING_ROOT_LE_FS + t * D.LE_SWEEP_FS
    chord = D.ROOT_CHORD + t * (D.TIP_CHORD - D.ROOT_CHORD)
    return (fs - le) / chord


def _tail_x(span, fs, le0, le1, c0, c1, s0, s1):
    t = np.clip((span - s0) / (s1 - s0), 0, 1.2)
    return (fs - (le0 + t * (le1 - le0))) / (c0 + t * (c1 - c0))


def compute(pos, nrm, pid, cov, ao, names):
    H, Wd = pid.shape
    step = np.linalg.norm(np.diff(pos, axis=1), axis=-1)
    ok = cov[:, 1:] & cov[:, :-1] & (pid[:, 1:] == pid[:, :-1])
    TEXEL[0] = float(np.median(step[ok & (step < 0.05)]))
    print(f"atlas texel size {TEXEL[0] * 1000:.1f} mm")
    bl, fs, wl = pos[..., 0], pos[..., 1], pos[..., 2]
    nb, nf, nw = nrm[..., 0], nrm[..., 1], nrm[..., 2]

    def part(*keys):
        ids = [i for i, n in enumerate(names) if any(n == k or (k.endswith("*") and n.startswith(k[:-1])) for k in keys)]
        return np.isin(pid, ids) & cov

    fuse = part("Fuselage")
    wing_box = part("Wing")
    wing = part("Wing", "WingCentreTE", "WingTipTE_*", "Winglet_*", "Flap_*", "Aileron_*")
    winglet = part("Winglet_*")
    flaps = part("Flap_*")
    ail = part("Aileron_*")
    htail = part("HStab", "Elevator")
    hstab = part("HStab")
    fin = part("Fin")
    vtail = part("Fin", "Rudder")
    doors = part("MainLegDoor_*", "MainDoorMesh_*", "NoseDoorMesh_*")
    noise = B.ValueNoise(12)
    p = pos.astype(np.float32)
    col = np.broadcast_to(WHITE, pos.shape).astype(np.float32).copy()
    rough = np.full((H, Wd), 0.28, np.float32)
    metal = np.zeros((H, Wd), np.float32)
    height = np.zeros((H, Wd), np.float32)

    def paint(mask, c, r=None):
        col[mask] = c
        if r is not None:
            rough[mask] = r

    # --- cheatline: slate band with a red line above it, rising at the tail ---------------
    wl_c = M.pchip([0.7, 2.8, 8.6, 10.4, 12.0, 13.3], [1.66, 1.62, 1.62, 1.72, 1.92, 2.04], fs)
    half = M.pchip([0.7, 3.0, 9.0, 12.0, 13.3], [0.05, 0.075, 0.075, 0.05, 0.035], fs)
    side = np.abs(nw) < 0.85
    # The band starts as a point behind the spinner and widens to full width.
    half = half * np.clip((fs - 0.72) / 0.9, 0, 1) ** 0.6
    band = fuse & side & (np.abs(wl - wl_c) < half) & (fs > 0.72)
    pin_lo = wl_c + half + 0.018
    pin = fuse & side & (wl > pin_lo) & (wl < pin_lo + 0.016) & (fs > 0.80)
    paint(band, SLATE, 0.26)
    paint(pin, RED, 0.26)
    # Winglets and the stabiliser tips in slate.
    paint(winglet & (wl > W._le(D.TIP_BL)[1] + 0.25), SLATE, 0.26)

    # --- de-ice boots on the leading edges (rubber: black, matt) --------------------------
    xw = _wing_x(bl, fs)
    boots_w = wing_box & (np.abs(bl) > 0.95) & (np.abs(bl) < D.TIP_BL - 0.15) & (xw < 0.075) & \
        ((nw > -0.2) | (xw < 0.035))
    xh = np.where(htail, _tail_x(np.abs(bl), fs, D.HSTAB_ROOT_LE, D.HSTAB_TIP_LE, D.HSTAB_ROOT_CHORD,
                                 D.HSTAB_TIP_CHORD, 0, D.HSTAB_HALF), 1.0)
    boots_h = hstab & (np.abs(bl) > 0.15) & (np.abs(bl) < D.HSTAB_HALF - 0.12) & (xh < 0.09)
    xv = np.where(vtail, _tail_x(wl, fs, D.FIN_ROOT_LE, D.FIN_TOP_LE, D.FIN_ROOT_CHORD, D.FIN_TOP_CHORD,
                                 D.FIN_ROOT_WL, D.FIN_TOP_WL), 1.0)
    boots_v = fin & (wl > 2.55) & (wl < D.FIN_TOP_WL - 0.1) & (xv < 0.06)
    boots = boots_w | boots_h | boots_v
    paint(boots, BOOT, 0.75)

    # --- Swiss flag on both sides of the fin ---------------------------------------------
    fc_fs, fc_wl, fsz = 13.05, 3.30, 0.42
    du, dv = fs - fc_fs, wl - fc_wl
    sq = vtail & (np.abs(du) < fsz / 2) & (np.abs(dv) < fsz / 2) & (np.abs(nb) > 0.5)
    paint(sq, np.array([0.85, 0.04, 0.06]), 0.26)
    arm, thick = fsz * 0.3125, fsz * 0.1
    cross = sq & (((np.abs(du) < arm) & (np.abs(dv) < thick)) | ((np.abs(dv) < arm) & (np.abs(du) < thick)))
    paint(cross, np.array([0.97, 0.97, 0.96]), 0.26)

    # --- registration -------------------------------------------------------------------
    bmp, gpx, pad = B.text_bitmap(REG, _font(), bold=0.012)
    h_side = 0.27
    w_side = h_side * (bmp.shape[1] - 2 * pad) / gpx
    fs0, wl0 = 9.75, 2.06
    left = fuse & (nb > 0.45)
    right = fuse & (nb < -0.45)
    cov_l = B.sample_bitmap(bmp, fs - fs0, wl - wl0, h_side, gpx, pad)
    cov_r = B.sample_bitmap(bmp, (fs0 + w_side) - fs, wl - wl0, h_side, gpx, pad)
    for m, c in ((left, cov_l), (right, cov_r)):
        a = np.where(m, c, 0)[..., None]
        col[:] = col * (1 - a) + SLATE * a
    h_wing = 0.80
    w_wing = h_wing * (bmp.shape[1] - 2 * pad) / gpx
    bl0 = 1.6 + (D.AILERON_BL[1] - 1.6 - w_wing) / 2
    under = (wing_box & (bl > 0) & (nw < -0.6))
    fs_base = D.WING_ROOT_LE_FS + 0.15 + 0.12 * (bl - 1.6) / 6 + h_wing + 0.25
    cov_w = B.sample_bitmap(bmp, bl - bl0, fs_base - fs, h_wing, gpx, pad)
    a = np.where(under, cov_w, 0)[..., None]
    col[:] = col * (1 - a) + SLATE * a

    # --- panel lines, doors, fasteners (height field, metres) ----------------------------
    gw = 0.0028
    for c in (0.68, 1.62, 2.78, 4.25, 6.0, 7.8, 9.75, 11.2, 12.4):
        height -= np.where(fuse, 0.0007 * _groove(fs - c, gw), 0)
    cowl = fuse & (fs < 2.78) & (fs > 0.68) & (np.abs(nw) < 0.9)
    height -= np.where(cowl, 0.0007 * _groove(wl - 1.95, gw), 0)
    height -= np.where(cowl & (fs > 1.5), 0.0007 * _groove(wl - 1.30, gw), 0)
    for k in np.arange(0.78, 2.70, 0.13):
        for w0 in (1.95, 1.30):
            d = np.sqrt((fs - k) ** 2 + (wl - w0) ** 2)
            height -= np.where(cowl, 0.0004 * np.exp(-(d / 0.006) ** 2), 0)
    # Airstair door (front left) and cargo door (rear left), rounded corners.
    stair = B.poly_segments(M.rounded_polygon([(4.33, 0.98), (4.97, 0.98), (4.97, 2.40), (4.33, 2.40)], 0.07, 4))
    cargo = B.poly_segments(M.rounded_polygon([(8.05, 1.02), (9.40, 1.02), (9.40, 2.34), (8.05, 2.34)], 0.09, 4))
    lside = fuse & (nb > 0.25)
    for segs in (stair, cargo):
        height -= np.where(lside, 0.0010 * _groove(B.seg_distance(fs, wl, segs), gw), 0)
    # Door handles as small dark recesses.
    for hfs, hwl in ((4.90, 1.62), (9.30, 1.62), (8.12, 1.70)):
        d = np.sqrt(((fs - hfs) / 1.8) ** 2 + (wl - hwl) ** 2)
        m = lside & (d < 0.022)
        col[m] = col[m] * 0.35
        height -= np.where(lside, 0.0006 * np.exp(-(d / 0.02) ** 4), 0)
    # Emergency exit outline on the right (over the wing).
    exit_r = B.poly_segments(M.rounded_polygon([(5.93, 1.62), (6.55, 1.62), (6.55, 2.36), (5.93, 2.36)], 0.06, 4))
    height -= np.where(fuse & (nb < -0.25), 0.0009 * _groove(B.seg_distance(fs, wl, exit_r), gw), 0)
    # Rivet rows on the fuselage joints and the cabin's longerons, restrained.
    for c in (4.25, 6.0, 7.8, 9.75, 11.2, 12.4):
        height += np.where(fuse, 0.0003 * _rivets(wl + bl, fs - c - 0.012, 0.032), 0)
    for c in (1.25, 2.45):
        m = fuse & (fs > 4.3) & (fs < 12.5)
        height += np.where(m, 0.0003 * _rivets(fs, wl - c, 0.034), 0)
    # Wing: spar rivet rows, rib rows, the panel joint ahead of the aileron, fuel caps' rings.
    for xs in (0.12, 0.66):
        height += np.where(wing_box, 0.0003 * _rivets(bl, (xw - xs) * 1.8, 0.034), 0)
    ribs = np.concatenate([np.arange(1.2, 7.8, 0.42), -np.arange(1.2, 7.8, 0.42)])
    for r in ribs:
        m = wing_box & (np.abs(bl - r) < 0.02) & (xw > 0.08)
        height += np.where(m, 0.0003 * _rivets(fs, bl - r, 0.034), 0)
    height -= np.where(wing_box, 0.0008 * _groove(np.abs(bl) - 4.95, gw), 0)
    # Access panels under the wing (rounded rectangles).
    for c in (2.2, 3.4, 4.6, 5.8, 7.0):
        for sgn in (1, -1):
            seg = B.poly_segments(M.rounded_polygon([(sgn * c - 0.13, 0.30), (sgn * c + 0.13, 0.30),
                                                    (sgn * c + 0.13, 0.42), (sgn * c - 0.13, 0.42)], 0.02, 3))
            d = B.seg_distance(bl, xw, [(a, b * 2.0, cc, dd * 2.0) for a, b, cc, dd in seg])
            height -= np.where(wing_box & (nw < -0.5), 0.0006 * _groove(d, 0.003), 0)

    # --- weathering -------------------------------------------------------------------
    n_lo = noise.fbm(p, 1.4, 4)
    n_hi = noise.fbm(p, 22.0, 3)
    skin = cov
    rough += np.where(skin, 0.05 * (n_lo - 0.5) + 0.03 * np.clip(nw, 0, 1), 0)
    grime = (1 - ao) * 0.30 + np.clip(-nw, 0, 1) * 0.08 * (0.6 + 0.8 * n_lo)
    belly = fuse & (nw < -0.3)
    grime += np.where(belly, 0.08 * (0.5 + n_lo), 0)
    grime = np.clip(grime * np.where(skin & ~boots, 1, 0), 0, 0.45)
    # Exhaust soot along both sides behind the stubs (the PT6's brown-black streak).
    soot_zone = fuse & (fs > 1.2) & (fs < 6.8) & (np.abs(nb) > 0.3)
    run = np.clip(fs - 1.35, 0, None)
    s = np.exp(-run / 1.6) * np.exp(-((wl - (1.66 - 0.035 * run)) / (0.07 + 0.05 * run)) ** 2)
    s = np.where(soot_zone, np.clip(s * (0.75 + 0.5 * n_hi), 0, 1), 0) * 0.85
    col = col * (1 - 0.55 * grime[..., None]) + DIRT * 0.55 * grime[..., None]
    col = col * (1 - s[..., None]) + SOOT * s[..., None]
    rough = rough + 0.25 * grime + 0.35 * s
    # Leading-edge erosion on the fin cap and winglets: a few chips to bare metal.
    le_zone = (winglet & (_wing_x(np.full_like(bl, D.TIP_BL), fs) < 0.04)) | (doors & (n_hi > 2))
    chips = le_zone & (noise(p, 90.0) > 0.88)
    col[chips] = METAL
    metal[chips] = 1.0
    rough[chips] = 0.35
    col = col * (1 + np.clip(height, -0.001, 0)[..., None] * 140)
    rough = np.clip(rough, 0.12, 0.9)
    ao_out = np.clip(0.25 + 0.75 * ao, 0, 1)
    base = np.clip(col, 0, 1)
    base[~cov] = WHITE
    orm = np.stack([ao_out, rough, metal], -1)
    orm[~cov] = (1.0, 0.3, 0.0)
    nmap = B.height_to_normal(height, pos, cov, pid, strength=DEPTH)
    return srgb_to_linear(base), orm, nmap
