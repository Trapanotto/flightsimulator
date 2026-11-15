"""
Swiss Air Force livery of the F/A-18C (J-5099, not a real aircraft), computed per texel of
the skin atlas like the other types' liveries.

Two-tone low-visibility greys: the darker grey (about FS 36320) on the upper surfaces of the
fuselage, LEX, wings, stabilators and the fins, the lighter one (about FS 36375) on the sides
and below, blended over a short distance as the spray gun leaves it; the radome a shade
different. Swiss roundels (a red disc with the white cross) in a muted low-visibility form
on the wings (top and bottom) and on the intake sides; J-5099 in dark grey on the outer fin
faces and small on the nose; a few stencils. Panel lines and fasteners, sealant on the
LEX and wing joints, restrained mottling, soot on the aft fuselage round the nozzles.
"""

import math
import os

import bpy
import numpy as np

from lib import bake as B
from lib import mesh as M
from . import dims as D

DARK = np.array([0.44, 0.475, 0.505])
LIGHT = np.array([0.585, 0.615, 0.64])
RADOME = np.array([0.50, 0.52, 0.53])
TEXT = np.array([0.26, 0.28, 0.30])
RED = np.array([0.60, 0.20, 0.21])
CROSS = np.array([0.84, 0.85, 0.85])
SOOT = np.array([0.10, 0.095, 0.09])
DIRT = np.array([0.33, 0.32, 0.30])
TAIL = "J-5099"
TEXEL = [0.006]
DEPTH = 1.6


def srgb_to_linear(c):
    return np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)


def _font():
    for p in (r"C:\Windows\Fonts\bahnschrift.ttf", r"C:\Windows\Fonts\arialbd.ttf"):
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
    le = D.WING_ROOT_LE_FS + a * math.tan(D.LE_SWEEP)
    t = np.clip(a / D.WING_TIP_BL, 0, 1)
    chord = D.WING_ROOT_CHORD + t * (D.WING_TIP_CHORD - D.WING_ROOT_CHORD)
    return (fs - le) / chord


def _fin_coords(bl, fs, wl):
    """Span along the fin (h) and chord share (x) from the design frame."""
    c, s = math.cos(D.FIN_CANT), math.sin(D.FIN_CANT)
    dbl = np.abs(bl) - D.FIN_ROOT_BL
    dwl = wl - D.FIN_ROOT_WL
    h = dbl * s + dwl * c
    le = D.FIN_ROOT_LE + h * math.tan(D.FIN_LE_SWEEP)
    t = np.clip(h / D.FIN_SPAN, 0, 1)
    chord = D.FIN_ROOT_CHORD + t * (D.FIN_TIP_CHORD - D.FIN_ROOT_CHORD)
    return h, (fs - le) / chord


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

    fuse = part("Fuselage", "Intakes", "Splitters", "Nacelles", "WindscreenArch", "CanopyFrame", "Speedbrake")
    wing = part("Wing", "LEF_*", "TEF_*", "Aileron_*", "Rails")
    wing_box = part("Wing")
    fins = part("Fins", "Rudder_*")
    stabs = part("Stabilator_*")
    noise = B.ValueNoise(18)
    p = pos.astype(np.float32)
    rough = np.full((H, Wd), 0.55, np.float32)
    metal = np.zeros((H, Wd), np.float32)
    height = np.zeros((H, Wd), np.float32)

    # --- the two greys: dark on top, light on the sides and below, a soft spray edge ----------
    n_edge = noise.fbm(p, 3.0, 3)
    top_fuse = (nw - 0.30 + 0.12 * (n_edge - 0.5)) / 0.18
    top_flat = (nw - 0.05 + 0.08 * (n_edge - 0.5)) / 0.10
    k_dark = np.where(fuse, np.clip(top_fuse, 0, 1), 0)
    k_dark = np.where(wing | stabs, np.clip(top_flat, 0, 1), k_dark)
    k_dark = np.where(fins, 0.85, k_dark)
    # The aft spine between the fins and the nose ahead of the windscreen carry the dark grey.
    k_dark = np.where(fuse & (fs < 0.02), 0, k_dark)
    col = LIGHT[None, None, :] * (1 - k_dark[..., None]) + DARK[None, None, :] * k_dark[..., None]
    radome = fuse & (fs < 2.32)
    col[radome] = RADOME
    rough[radome] = 0.42
    paint = lambda m, c: col.__setitem__(m, c)  # noqa: E731

    # --- roundels: on the wings (top left and right, bottom) and the intake sides ----------
    def roundel(mask, u, v, r):
        d = np.sqrt(u * u + v * v)
        disc = mask & (d < r)
        paint(disc, RED)
        arm, th = r * 0.62, r * 0.20
        cross = disc & (((np.abs(u) < arm) & (np.abs(v) < th)) | ((np.abs(v) < arm) & (np.abs(u) < th)))
        paint(cross, CROSS)
        return disc

    for sgn in (1, -1):
        cbl = sgn * 4.05
        cfs = D.WING_ROOT_LE_FS + 4.05 * math.tan(D.LE_SWEEP) + 1.15
        roundel(wing & (np.abs(nw) > 0.6), bl - cbl, fs - cfs, 0.30)
        roundel(fuse & (sgn * nb > 0.6) & (fs > 7.0) & (fs < 8.6), fs - 7.80, wl - 1.76, 0.24)

    # --- J-5099: outer fin faces and small on the nose ---------------------------------------
    bmp, gpx, pad = B.text_bitmap(TAIL, _font(), bold=0.01)
    wfac = (bmp.shape[1] - 2 * pad) / gpx
    h_fin, h_nose = 0.26, 0.10
    for sgn in (1, -1):
        out = fins & (sgn * nb > 0.4) & (sgn * bl > 0)
        fh, fx = _fin_coords(bl, fs, wl)
        w = h_fin * wfac
        f0 = 12.25 + 0.42 * math.tan(D.FIN_LE_SWEEP)
        u = (fs - f0) if sgn > 0 else (f0 + w - fs)
        cov_t = B.sample_bitmap(bmp, u, fh - 0.42, h_fin, gpx, pad)
        a = np.where(out, cov_t, 0)[..., None]
        col[:] = col * (1 - a) + TEXT * a
        side = fuse & (sgn * nb > 0.5) & (fs > 1.8) & (fs < 3.3)
        w2 = h_nose * wfac
        u2 = (fs - 2.05) if sgn > 0 else (2.05 + w2 - fs)
        cov_n = B.sample_bitmap(bmp, u2, wl - 1.86, h_nose, gpx, pad)
        a = np.where(side, cov_n, 0)[..., None]
        col[:] = col * (1 - a) + TEXT * a

    # --- stencils: NO STEP on the wing roots, the rescue arrow area by the canopy ----------
    bmp2, gpx2, pad2 = B.text_bitmap("NO STEP", _font())
    for sgn in (1, -1):
        m = wing_box & (nw > 0.6) & (sgn * bl > 0)
        cov_s = B.sample_bitmap(bmp2, np.abs(bl) - 2.3, 8.95 - fs, 0.045, gpx2, pad2)
        a = np.where(m, cov_s, 0)[..., None] * 0.8
        col[:] = col * (1 - a) + TEXT * a

    # --- panel lines, fasteners ----------------------------------------------------------------
    gw = 0.0025
    for c in (2.32, 3.30, 5.0, 6.4, 7.6, 9.1, 10.6, 12.1, 13.5, 14.6, 15.4):
        height -= np.where(fuse, 0.0007 * _groove(fs - c, gw), 0)
    # The LEX's outline seam along the chine and the lines of the access panels.
    for w0 in (2.05, 1.62):
        height -= np.where(fuse & (fs > 3.3) & (fs < 13) & (np.abs(nw) < 0.75), 0.0006 * _groove(wl - w0, gw), 0)
    for f0, f1, w0, w1 in ((3.5, 4.4, 1.60, 1.95), (9.2, 10.2, 1.45, 1.90), (11.0, 12.0, 1.50, 1.95)):
        segs = B.poly_segments(M.rounded_polygon([(f0, w0), (f1, w0), (f1, w1), (f0, w1)], 0.03, 3))
        height -= np.where(fuse & (np.abs(nb) > 0.4), 0.0008 * _groove(B.seg_distance(fs, wl, segs), gw), 0)
    for c in (4.6, 7.0, 9.6, 12.4):
        height += np.where(fuse, 0.00025 * _rivets(wl + bl, fs - c - 0.012, 0.03), 0)
    xw = _wing_x(bl, fs)
    height -= np.where(wing_box, 0.0010 * _groove(np.abs(bl) - D.FOLD_BL, gw * 1.3), 0)
    for xs in (0.25, 0.45, 0.62):
        height -= np.where(wing_box & (np.abs(bl) > 1.4), 0.0005 * _groove((xw - xs) * 3.0, gw), 0)
        height += np.where(wing_box, 0.00025 * _rivets(bl, (xw - xs - 0.02) * 3.0, 0.03), 0)
    for r in (1.9, 2.6, 3.9, 4.6):
        for sgn in (1, -1):
            height -= np.where(wing_box & (xw > 0.18) & (xw < 0.74), 0.0005 * _groove(bl - sgn * r, gw), 0)
    fh, fx = _fin_coords(bl, fs, wl)
    for xs in (0.2, 0.5):
        height -= np.where(fins, 0.0005 * _groove((fx - xs) * 2.5, gw), 0)
    height -= np.where(fins, 0.0005 * _groove(fh - 1.4, gw), 0)

    # --- weathering: restrained mottling, grime, soot round the nozzles -----------------------
    n_lo = noise.fbm(p, 1.2, 4)
    n_hi = noise.fbm(p, 16.0, 3)
    mott = (n_lo - 0.5) * 0.06 + (n_hi - 0.5) * 0.025
    col = col * (1 + mott[..., None])
    rough += np.where(cov, 0.06 * (n_lo - 0.5), 0)
    grime = (1 - ao) * 0.25 + np.clip(-nw, 0, 1) * 0.06 * (0.6 + 0.8 * n_lo)
    grime = np.clip(grime * cov, 0, 0.35)
    col = col * (1 - 0.45 * grime[..., None]) + DIRT * 0.45 * grime[..., None]
    soot_zone = (fuse | stabs) & (fs > 14.0)
    s = np.clip((fs - 14.0) / 2.2, 0, 1) ** 1.6 * np.exp(-((np.abs(bl) - D.ENGINE_BL) / 0.7) ** 2)
    s = np.where(soot_zone, np.clip(s * (0.7 + 0.5 * n_hi), 0, 1), 0) * 0.75
    col = col * (1 - s[..., None]) + SOOT * s[..., None]
    rough = rough + 0.2 * grime + 0.2 * s
    # Worn leading edges: the radome tip and the wing and fin leading edges a little lighter.
    le = (wing_box & (xw < 0.02)) | (fins & (fx < 0.025))
    col[le] = col[le] * 1.08
    col = col * (1 + np.clip(height, -0.001, 0)[..., None] * 120)
    rough = np.clip(rough, 0.25, 0.85)
    ao_out = np.clip(0.25 + 0.75 * ao, 0, 1)
    base = np.clip(col, 0, 1)
    base[~cov] = LIGHT
    orm = np.stack([ao_out, rough, metal], -1)
    orm[~cov] = (1.0, 0.55, 0.0)
    nmap = B.height_to_normal(height, pos, cov, pid, strength=DEPTH)
    return srgb_to_linear(base), orm, nmap
