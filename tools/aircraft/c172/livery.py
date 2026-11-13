"""
HB-TFS livery and surface detail, computed per texel of the skin atlas.

White with a dark-blue band and a red pinstripe along the fuselage that sweeps up into the
fin, red wing and stabiliser tips, the registration on both fuselage sides and under the left
wing (ICAO Annex 7: tops of the letters towards the leading edge), a Swiss flag on the fin.
Height field (panel lines, rivets, cowl fasteners) becomes the normal map; roughness, metal
and dirt go into the ORM map.
"""

import os

import bpy
import numpy as np

from lib import bake as B
from lib import mesh as M
from . import dims as D
from . import wing as W

WHITE = np.array([0.925, 0.928, 0.92])
NAVY = np.array([0.055, 0.10, 0.25])
RED = np.array([0.74, 0.055, 0.075])
METAL = np.array([0.80, 0.81, 0.82])
DIRT = np.array([0.36, 0.32, 0.27])
SOOT = np.array([0.08, 0.075, 0.07])
REG = "HB-TFS"


def srgb_to_linear(c):
    return np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)


def _font():
    for p in (r"C:\Windows\Fonts\bahnschrift.ttf",
              os.path.join(os.path.dirname(bpy.app.binary_path),
                           f"{bpy.app.version[0]}.{bpy.app.version[1]}", "datafiles", "fonts", "Inter.woff2")):
        if os.path.exists(p):
            return p
    return None


# World size of one texel of the atlas (set per bake); features never get thinner than this,
# or they would fall between texel centres and vanish.
TEXEL = [0.005]


def _groove(d, w):
    w = np.maximum(w, 0.8 * TEXEL[0])
    return np.exp(-(d / w) ** 2)


def _rivets(along, across, pitch, r=0.0022):
    """Bumps on a row: `across` = distance from the row line, `along` = position along it."""
    r = max(r, 0.6 * TEXEL[0])
    pitch = max(pitch, 4.5 * r)
    a = (np.mod(along, pitch) - pitch / 2)
    return np.exp(-(a * a + across * across) / (r * r))


def _wing_chord_coords(bl, fs):
    """Chord fraction x of design-frame points on the wing (planform, no twist)."""
    a = np.abs(bl)
    t = np.clip((a - D.PANEL_BREAK_BL) / (D.TIP_BL - D.PANEL_BREAK_BL), 0, 1)
    le = D.WING_ROOT_LE_FS + t * (D.ROOT_CHORD - D.TIP_CHORD)
    chord = D.WING_TE_FS - le
    return (fs - le) / chord


def _tail_chord_coords(span, fs, le0, le1, c0, c1, s0, s1):
    t = np.clip((span - s0) / (s1 - s0), 0, 1.2)
    le = le0 + t * (le1 - le0)
    c = c0 + t * (c1 - c0)
    return (fs - le) / c


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
    wing = part("Wing", "WingCentreTE", "WingTip_*", "WingTipTE_*", "Flap_*", "Aileron_*")
    flaps = part("Flap_*")
    ail = part("Aileron_*")
    htail = part("HStab", "Elevator", "TrimTab")
    vtail = part("Fin", "Rudder", "Dorsal")
    fair = part("WheelFairing_*", "NoseFairing")
    strut = part("Struts")

    noise = B.ValueNoise(172)
    p = pos.astype(np.float32)
    col = np.broadcast_to(WHITE, pos.shape).astype(np.float32).copy()
    rough = np.full((H, Wd), 0.30, np.float32)
    metal = np.zeros((H, Wd), np.float32)
    height = np.zeros((H, Wd), np.float32)

    def paint(mask, c, r=None):
        col[mask] = c
        if r is not None:
            rough[mask] = r

    # --- fuselage band: navy with a red pinstripe above, sweeping up into the fin ---------
    wl_c = M.pchip([-0.9, 3.0, 4.9, 5.7, 6.2, 6.8], [1.115, 1.125, 1.16, 1.30, 1.40, 1.46], fs)
    half = M.pchip([-0.9, 4.5, 6.0, 6.8], [0.062, 0.058, 0.045, 0.035], fs)
    side = np.abs(nw) < 0.80
    band = fuse & side & (np.abs(wl - wl_c) < half) & (fs > -0.785)
    pin = fuse & side & (wl > wl_c + half + 0.016) & (wl < wl_c + half + 0.016 + 0.6 * half) & (fs > -0.70)
    paint(band, NAVY, 0.28)
    paint(pin, RED, 0.28)
    # The band continues onto the fin as a rising swoosh, navy above it.
    fin_line = 1.62 + 0.55 * (fs - 6.0)
    paint(vtail & (wl > fin_line + 0.10), NAVY, 0.28)
    paint(vtail & (wl > fin_line + 0.01) & (wl < fin_line + 0.07), RED, 0.28)
    # Red tips on wing and stabiliser, a stripe on the wheel fairings.
    paint(wing & (np.abs(bl) > D.TIP_BL - 0.10), RED, 0.28)
    paint(htail & (np.abs(bl) > D.HSTAB_HORN_BL + 0.012), RED, 0.28)
    fz = np.where(np.abs(fs - D.NOSE_AXLE_FS) < 0.6, D.NOSE_TYRE_R + 0.06, D.MAIN_TYRE_R + 0.06)
    paint(fair & (np.abs(wl - fz) < 0.03) & (np.abs(nb) > 0.4), NAVY, 0.28)
    paint(fair & (np.abs(wl - fz - 0.05) < 0.010) & (np.abs(nb) > 0.4), RED, 0.28)

    # --- Swiss flag on both sides of the fin ---------------------------------------------
    fc_fs, fc_wl, fsz = 6.42, 2.24, 0.20
    du, dv = fs - fc_fs, wl - fc_wl
    sq = vtail & (np.abs(du) < fsz / 2) & (np.abs(dv) < fsz / 2) & (np.abs(nb) > 0.5)
    paint(sq, np.array([0.85, 0.04, 0.06]), 0.28)
    arm, thick = fsz * 0.3125, fsz * 0.1
    cross = sq & (((np.abs(du) < arm) & (np.abs(dv) < thick)) | ((np.abs(dv) < arm) & (np.abs(du) < thick)))
    paint(cross, np.array([0.97, 0.97, 0.96]), 0.28)

    # --- registration -------------------------------------------------------------------
    bmp, gpx, pad = B.text_bitmap(REG, _font(), bold=0.012)
    h_side = 0.25
    w_side = h_side * (bmp.shape[1] - 2 * pad) / gpx
    fs0, wl0 = 3.36, 1.205
    left = fuse & (nb > 0.45)
    right = fuse & (nb < -0.45)
    cov_l = B.sample_bitmap(bmp, fs - fs0, wl - wl0, h_side, gpx, pad)
    cov_r = B.sample_bitmap(bmp, (fs0 + w_side) - fs, wl - wl0, h_side, gpx, pad)
    reg_c = NAVY
    for m, c in ((left, cov_l), (right, cov_r)):
        a = np.where(m, c, 0)[..., None]
        col[:] = col * (1 - a) + reg_c * a
    # Under the left wing: big letters, tops towards the leading edge, reading outboard.
    h_wing = 0.62
    w_wing = h_wing * (bmp.shape[1] - 2 * pad) / gpx
    bl0 = 0.85 + (D.TIP_BL - 0.85 - w_wing) / 2
    under = (wing & (bl > 0) & (nw < -0.6)) & ~ail & ~flaps
    fs_base = D.WING_ROOT_LE_FS + 0.40 + h_wing
    cov_w = B.sample_bitmap(bmp, bl - bl0, fs_base - fs, h_wing, gpx, pad)
    a = np.where(under, cov_w, 0)[..., None]
    col[:] = col * (1 - a) + NAVY * a

    # --- small markings -----------------------------------------------------------------
    # Stall-warning opening in the left leading edge, dark.
    xw = _wing_chord_coords(bl, fs)
    paint(wing & (bl > 0.9) & (bl < 0.98) & (xw < 0.012) & (np.abs(nw) < 0.6), np.array([0.05, 0.05, 0.05]), 0.6)
    # "NO STEP" on both flaps near the root, readable from behind the wing (tops forward).
    nbmp, ngpx, npad = B.text_bitmap("NO STEP", _font(), px_per_unit=120)
    nh = 0.045
    nw_text = nh * (nbmp.shape[1] - 2 * npad) / ngpx
    for sgn in (1, -1):
        m = flaps & (nw > 0.6) & (sgn * bl > 0)
        bl0 = 0.80 + nw_text if sgn > 0 else -0.80
        cov_n = B.sample_bitmap(nbmp, bl0 - bl, (D.WING_TE_FS - 0.10) - fs, nh, ngpx, npad)
        a = np.where(m, cov_n, 0)[..., None]
        col[:] = col * (1 - a) + np.array([0.15, 0.15, 0.16]) * a

    # --- panel lines, doors, fasteners (height field, metres) ----------------------------
    gw = 0.0028
    for c in (-0.745, 0.0, 3.15, 4.15, 5.15, 6.05):
        height -= np.where(fuse, 0.0007 * _groove(fs - c, gw), 0)
    cowl_side = fuse & (fs < 0.0) & (fs > -0.75) & (np.abs(nw) < 0.85)
    height -= np.where(cowl_side, 0.0007 * _groove(wl - 1.215, gw), 0)
    # Oil-filler door on the top of the cowling.
    od = B.seg_distance(bl, fs, B.poly_segments([(-0.12, -0.42), (0.12, -0.42), (0.12, -0.16), (-0.12, -0.16)]))
    height -= np.where(fuse & (nw > 0.6) & (fs < 0.0), 0.0007 * _groove(od, gw), 0)
    # Cowl fasteners: shallow dimples along the cowl split and the firewall joint.
    for k in np.arange(-0.70, -0.02, 0.115):
        d = np.sqrt((fs - k) ** 2 + (wl - 1.215) ** 2)
        height -= np.where(cowl_side, 0.0005 * np.exp(-(d / 0.007) ** 2), 0)
        rim = np.abs(d - 0.009)
        height += np.where(cowl_side, 0.0002 * np.exp(-(rim / 0.002) ** 2), 0)
    for k in (0.90, 1.05, 1.20, 1.35, 1.48):
        d = np.sqrt((fs + 0.012) ** 2 + (wl - k) ** 2)
        height -= np.where(fuse, 0.0005 * np.exp(-(d / 0.007) ** 2), 0)
    # Doors (both sides) and the baggage door (left).
    door = B.poly_segments(M.rounded_polygon([(0.31, 0.92), (1.43, 0.92), (1.43, 1.935), (0.66, 1.935), (0.31, 1.52)],
                                             0.05, 4))
    dd = B.seg_distance(fs, wl, door)
    height -= np.where(fuse & (np.abs(nb) > 0.3), 0.0009 * _groove(dd, gw), 0)
    bag = B.poly_segments(M.rounded_polygon([(2.32, 1.02), (2.80, 1.02), (2.80, 1.36), (2.32, 1.36)], 0.03, 3))
    height -= np.where(fuse & (nb > 0.3), 0.0008 * _groove(B.seg_distance(fs, wl, bag), gw), 0)
    # Rivet rows along the tailcone bulkheads and longitudinal laps.
    for c in (3.15, 4.15, 5.15, 6.05):
        height += np.where(fuse, 0.00035 * _rivets(wl + bl, fs - c - 0.014, 0.028), 0)
    for c in (1.00, 1.42):
        m = fuse & (fs > 2.5)
        height += np.where(m, 0.00035 * _rivets(fs, wl - c, 0.028), 0)
        height -= np.where(m, 0.0004 * _groove(wl - c - 0.008, 0.002), 0)

    # Wing: leading-edge skin lap, spar and rib rivet rows, panel joint, fuel-cap ring.
    x = xw
    wing_box = part("Wing")
    for xs in (0.12,):
        height -= np.where(wing_box, 0.0005 * _groove(x - xs, 0.004), 0)
    for xs in (0.26, 0.68):
        height += np.where(wing_box, 0.00035 * _rivets(bl, (x - xs) * 1.4, 0.03), 0)
    ribs = np.concatenate([np.arange(0.56, 5.3, 0.30), -np.arange(0.56, 5.3, 0.30)])
    for r in ribs:
        m = wing & (np.abs(bl - r) < 0.02)
        height += np.where(m, 0.00035 * _rivets(fs, bl - r, 0.03), 0)
    height -= np.where(wing_box, 0.0008 * _groove(np.abs(bl) - D.PANEL_BREAK_BL, gw), 0)
    for sgn in (1, -1):
        d = np.sqrt((bl - sgn * 1.62) ** 2 + (fs - (D.WING_ROOT_LE_FS + 0.30 * D.ROOT_CHORD)) ** 2)
        height -= np.where(wing & (nw > 0.5), 0.0007 * _groove(d - 0.062, 0.002), 0)
    # Tail ribs.
    for r in np.arange(0.25, 1.75, 0.25):
        for sgn in (1, -1):
            height += np.where(htail, 0.0003 * _rivets(fs, bl - sgn * r, 0.03), 0)
    for r in np.arange(1.50, 2.6, 0.22):
        height += np.where(vtail & (fs > 5.6), 0.0003 * _rivets(fs, wl - r, 0.03), 0)

    # --- weathering -------------------------------------------------------------------
    n_lo = noise.fbm(p, 1.6, 4)
    n_hi = noise.fbm(p, 22.0, 3)
    skin = cov
    # Slight unevenness of the paint (roughness), more on upper surfaces (sun, rain).
    rough += np.where(skin, 0.06 * (n_lo - 0.5) + 0.04 * np.clip(nw, 0, 1), 0)
    # Grime: in cavities (AO), on the belly and lower surfaces, darker towards the gear.
    grime = (1 - ao) * 0.35 + np.clip(-nw, 0, 1) * 0.10 * (0.6 + 0.8 * n_lo)
    belly = fuse & (nw < -0.2)
    grime += np.where(belly, 0.10 * (0.5 + n_lo), 0)
    # Exhaust soot along the lower right side behind the stack, oil streaks on the belly.
    soot = (bl < 0.02) & fuse & (fs > -0.25) & (fs < 2.6)
    s = np.exp(-np.clip(fs + 0.2, 0, None) / 0.9) * np.exp(-((wl - 0.80) / 0.13) ** 2) * (0.7 + 0.6 * n_hi)
    s = np.where(soot, np.clip(s, 0, 1), 0)
    oil = fuse & (nw < -0.5) & (fs > 0.0) & (fs < 2.2)
    o = np.where(oil, np.exp(-(bl / 0.10) ** 2) * (0.4 + 0.6 * noise(p * np.array([3, 0.3, 3]), 8.0)) * 0.35, 0)
    grime = np.clip(grime * np.where(skin, 1, 0), 0, 0.5)
    col = col * (1 - 0.6 * grime[..., None]) + DIRT * 0.6 * grime[..., None]
    col = col * (1 - s[..., None] * 0.85) + SOOT * s[..., None] * 0.85
    col = col * (1 - o[..., None]) + np.array([0.20, 0.17, 0.12]) * o[..., None]
    rough = rough + 0.25 * grime + 0.3 * s + 0.1 * o
    # Leading-edge wear: tiny chips down to bare aluminium.
    xt = np.where(htail, _tail_chord_coords(np.abs(bl), fs, D.HSTAB_ROOT_LE, D.HSTAB_TIP_LE, D.HSTAB_ROOT_CHORD,
                                            D.HSTAB_TIP_CHORD, 0, D.HSTAB_HALF), 1.0)
    xv = np.where(vtail, _tail_chord_coords(wl, fs, D.FIN_ROOT_LE, D.FIN_TOP_LE, D.FIN_ROOT_CHORD, D.FIN_TOP_CHORD,
                                            D.FIN_ROOT_WL, D.FIN_TOP_WL), 1.0)
    le_zone = ((wing_box & (x < 0.035)) | (htail & (xt < 0.03)) | (vtail & (xv < 0.03)) |
               (strut & (nf < -0.7)) | (fuse & (fs < -0.70) & (fs > -0.80)))
    chips = le_zone & (noise(p, 70.0) > 0.80) & (n_hi > 0.45)
    col[chips] = METAL
    metal[chips] = 1.0
    rough[chips] = 0.35
    # Bug and dust film on the leading edges (subtle, rough).
    film = np.where(le_zone, 0.5 * (n_hi > 0.6), 0)
    col = col * (1 - 0.15 * film[..., None]) + DIRT * 0.15 * film[..., None]
    rough = rough + 0.15 * film
    # Darken panel-line grooves a little: dirt collects there.
    col = col * (1 + np.clip(height, -0.001, 0)[..., None] * 140)
    rough = np.clip(rough, 0.12, 0.9)
    ao_out = np.clip(0.25 + 0.75 * ao, 0, 1)

    base = np.clip(col, 0, 1)
    base[~cov] = WHITE
    orm = np.stack([ao_out, rough, metal], -1)
    orm[~cov] = (1.0, 0.3, 0.0)
    nmap = B.height_to_normal(height, pos, cov, pid, strength=1.0)
    return srgb_to_linear(base), orm, nmap
