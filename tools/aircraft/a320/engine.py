"""
CFM56-5B engines on their pylons: the round intake with its lip, the fan (36 wide-chord blades
and the spinner) on its own pivot, the blurred fan disc, the fan cowl with the four pivoting
reverser doors, the core cowl, the core nozzle and the plug, the nacelle strake on the
inboard side, and the pylon with its aft fairing under the wing.

  Fan_L/R          fan rotation (extras.axis along the engine)
  RevDoor_L0..3    reverser doors (and _R): forward edge out, aft edge into the duct
                   (extras.openDeg)
"""

import math

import numpy as np

from lib import airframe as A
from lib import mesh as M
from . import dims as D
from . import wing as W

N = 48
DOOR_ANGLES = (50.0, 130.0, 230.0, 310.0)   # from the top, towards +BL
DOOR_HALF = 28.0

LIP = [(11.32, 0.880), (D.INLET_FS - 0.02, 0.905), (D.INLET_FS, 0.93), (11.29, 0.975)]
OUTER = [(11.29, 0.975), (11.42, 1.02), (11.75, 1.062),
         (12.3, 1.082), (12.9, 1.080), (13.55, 1.058), (14.05, 1.025), (14.55, 0.985), (D.FAN_EXIT_FS, 0.945)]
INNER = [(D.INLET_FS - 0.02, 0.905), (11.32, 0.880), (11.6, 0.872), (D.FAN_FS, 0.868)]
DUCT = [(12.25, 0.875), (13.4, 0.905), (14.5, 0.915), (D.FAN_EXIT_FS, 0.925)]
CORE = [(12.2, 0.42), (13.0, 0.56), (14.0, 0.63), (D.FAN_EXIT_FS, 0.625), (15.3, 0.585), (D.CORE_EXIT_FS, 0.47)]
PLUG = [(15.75, 0.355), (15.95, 0.345), (16.25, 0.24), (D.PLUG_FS, 0.0)]


def centre(side):
    return np.array([side * D.ENGINE_BL, 0.0, D.ENGINE_WL])


def ring_point(side, fs, ang_deg, r):
    a = math.radians(ang_deg)
    c = centre(side)
    return np.array([c[0] + side * r * math.sin(a), fs, c[2] + r * math.cos(a)])


def _interp(profile, fs):
    xs, ys = zip(*profile)
    return float(np.interp(fs, xs, ys))


def _in_door(ang, fs):
    if not (D.REVERSER_FS[0] < fs < D.REVERSER_FS[1]):
        return False
    return any(abs(((ang - d + 180) % 360) - 180) < DOOR_HALF for d in DOOR_ANGLES)


def nacelle_skin(side):
    """Outer skin (lip to fan exit) as a grid with holes where the reverser doors sit."""
    fss = sorted(set([p[0] for p in OUTER] + list(np.linspace(*D.REVERSER_FS, 4)) + [12.6, 13.25]))
    angs = sorted(set([i * 360.0 / N for i in range(N)] + [d + s * DOOR_HALF for d in DOOR_ANGLES for s in (-1, 1)]))
    verts = [ring_point(side, fs, a, _interp(OUTER, fs)) for fs in fss for a in angs]
    n = len(angs)
    faces = []
    for i in range(len(fss) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            mid_a = (angs[j] + (angs[j2] if j2 else 360.0)) / 2
            mid_f = (fss[i] + fss[i + 1]) / 2
            if _in_door(mid_a, mid_f):
                continue
            faces.append((i * n + j, i * n + j2, (i + 1) * n + j2, (i + 1) * n + j))
    return np.array(verts), faces


def lathe_profile(side, profile, n=N, inward=False):
    rows = []
    for fs, r in profile:
        rows.append([ring_point(side, fs, 360.0 * k / n, r) for k in range(n)])
    v = np.array([p for row in rows for p in row])
    f = M.grid_faces(len(rows), n, wrap_cols=True)
    if inward:
        f = [tuple(reversed(x)) for x in f]
    return v, f


def door(side, ang):
    a0, a1 = ang - DOOR_HALF + 0.6, ang + DOOR_HALF - 0.6
    f0, f1 = D.REVERSER_FS[0] + 0.01, D.REVERSER_FS[1] - 0.01

    def fn(u, v):
        r = _interp(OUTER, v)
        p = ring_point(side, v, u, r)
        nrm = p - ring_point(side, v, u, 0.0)
        return p, nrm / np.linalg.norm(nrm)

    return A.solid_patch(fn, (a0, a1), (f0, f1), 7, 5, 0.035)


def blades(side, n=36):
    """Wide-chord fan blades, twisted from the hub to the tip, in the fan plane."""
    parts = []
    c = centre(side)
    hub_r, tip_r = 0.33, D.FAN_R - 0.008
    for k in range(n):
        ang = 2 * math.pi * k / n
        radial = np.array([side * math.sin(ang), 0.0, math.cos(ang)])
        tang = np.array([side * math.cos(ang), 0.0, -math.sin(ang)])
        rows = []
        for t in np.linspace(0, 1, 6):
            r = hub_r + t * (tip_r - hub_r)
            chord = 0.36 + 0.10 * math.sin(math.pi * t * 0.8)
            twist = math.radians(58 - 38 * t)     # flatter at the tip
            le_dir = math.cos(twist) * tang + math.sin(twist) * np.array([0, -1.0, 0])
            th_dir = np.cross(le_dir, radial)
            th_dir /= np.linalg.norm(th_dir)
            p0 = c + radial * r + np.array([0, D.FAN_FS + 0.06, 0])
            row = []
            for x, y in ((0.5, 0.0), (0.2, 0.025), (-0.15, 0.02), (-0.5, 0.0), (-0.15, -0.01), (0.2, -0.012)):
                row.append(p0 + le_dir * (x * chord) + th_dir * (y * chord * (1 - 0.6 * t)))
            rows.append(row)
        v = np.array([p for row in rows for p in row])
        f = M.grid_faces(len(rows), 6, wrap_cols=True)
        cc = len(v)
        v = np.vstack([v, [np.mean(rows[-1], 0)]])
        f += M.fan_cap(list(range((len(rows) - 1) * 6, len(rows) * 6)), cc)
        parts.append((v, f))
    return M.merge(parts)


def spinner(side):
    c = centre(side)
    prof = [(0.0, 0.0)]
    for t in np.linspace(0.05, 1, 12):
        prof.append((t * 0.62, 0.345 * math.sin(t * math.pi / 2) ** 0.8))
    origin = c + np.array([0, D.FAN_FS - 0.48, 0])
    return M.lathe(prof + [(0.72, 0.345)], origin, (0, 1.0, 0), n=32, close_start=False, close_end=True)


def disc(side, n=48):
    c = centre(side)
    R = D.FAN_R
    verts, uvs_v = [], []
    for ring_r in (0.3, R):
        for k in range(n):
            a = 2 * math.pi * k / n
            x, z = ring_r * math.cos(a), ring_r * math.sin(a)
            verts.append((c[0] + x, D.FAN_FS + 0.02, c[2] + z))
            uvs_v.append((0.5 + x / (2 * R), 0.5 + z / (2 * R)))
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    uvs = [uvs_v[i] for f in faces for i in f]
    return np.array(verts), faces, uvs


def pylon(side):
    """Pylon: a slim fairing from the nacelle's top up to the wing, running on aft under it."""
    rows = []
    n = 12
    bl = side * D.ENGINE_BL
    top_nac = D.ENGINE_WL + 1.0
    for fs in np.linspace(11.9, 18.9, 30):
        lower_wing, _ = W.surface_point(bl, min(fs, W._le(bl)[0] + 0.65 * W.chord(bl)))
        le_fs = W._le(bl)[0]
        if fs < le_fs + 0.2:
            top = W._le(bl)[1] + 0.05 + 0.25 * max(0.0, (fs - 12.6) / (le_fs - 12.6))
            top = min(top, lower_wing[2] + 0.3) if fs > le_fs - 0.3 else top
        else:
            top = lower_wing[2] + 0.05
        if fs < 16.0:
            bot = top_nac - 0.12 if fs < D.FAN_EXIT_FS else top_nac - 0.05 - 0.45 * (fs - D.FAN_EXIT_FS) / 1.15
        else:
            t = (fs - 16.0) / 2.9
            bot = (top_nac - 0.5) + t * (top - 0.04 - (top_nac - 0.5))
        bot = min(bot, top - 0.03)
        nose = min(1.0, (fs - 11.9) / 0.6) ** 0.5
        tail = min(1.0, (18.9 - fs) / 1.8) ** 0.7
        hw = 0.17 * nose * tail + 0.015
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            ring.append((bl + hw * math.cos(a), fs, (top + bot) / 2 + (top - bot) / 2 * max(-1.0, min(1.0, 1.25 * math.sin(a)))))
        rows.append(ring)
    v = np.array([p for r in rows for p in r])
    f = M.grid_faces(len(rows), n, wrap_cols=True)
    c = len(v)
    v = np.vstack([v, [np.mean(rows[0], 0)], [np.mean(rows[-1], 0)]])
    f += M.fan_cap(list(range(n)), c, reverse=True)
    last = (len(rows) - 1) * n
    f += M.fan_cap(list(range(last, last + n)), c + 1)
    return v, f


def strake(side):
    """Nacelle strake on the inboard side, high up: a thin swept plate."""
    ang = -60.0     # towards the fuselage
    pts = []
    for fs, h in ((11.75, 0.0), (12.75, 0.0), (12.95, 0.24), (12.55, 0.24)):
        r = _interp(OUTER, fs) - 0.01
        p = ring_point(side, fs, ang, r + h)
        pts.append(p)
    pts = np.array(pts)
    nrm = np.array([0.0, 1.0, 0.0])
    radial = pts[2] - pts[1]
    off = np.cross(radial / np.linalg.norm(radial), nrm) * 0.012
    v = np.vstack([pts + off, pts - off])
    f = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    return v, f


def build(col, mats, parts):
    for side, sfx in ((1, "L"), (-1, "R")):
        parts[f"Nacelle_{sfx}"] = M.make_object(f"Nacelle_{sfx}", *nacelle_skin(side), col, mats["paint"],
                                                sharp_angle=60, recalc=True)
        parts[f"Pylon_{sfx}"] = M.make_object(f"Pylon_{sfx}", *pylon(side), col, mats["paint"], sharp_angle=50)
        parts[f"Strake_{sfx}"] = M.make_object(f"Strake_{sfx}", *strake(side), col, mats["paint"], smooth=False)
        lip = M.make_object(f"Lip_{sfx}", *lathe_profile(side, LIP),
                            col, mats["metal"], sharp_angle=70)
        inner = M.make_object(f"IntakeIn_{sfx}", *lathe_profile(side, INNER, inward=True), col, mats["intake_grey"],
                              sharp_angle=70)
        duct = M.make_object(f"Duct_{sfx}", *lathe_profile(side, DUCT, inward=True), col, mats["intake"], sharp_angle=70)
        core = M.make_object(f"Core_{sfx}", *lathe_profile(side, CORE), col, mats["core"], sharp_angle=60)
        plug = M.make_object(f"Plug_{sfx}", *M.lathe(PLUG, centre(side) * np.array([1, 0, 1]), (0, 1.0, 0), n=32,
                                                     close_start=True, close_end=False), col, mats["exhaust"],
                             sharp_angle=60)
        nozzle = M.make_object(f"Nozzle_{sfx}", *lathe_profile(side, [(D.CORE_EXIT_FS - 0.25, 0.43), (D.CORE_EXIT_FS, 0.46)],
                                                              inward=True), col, mats["exhaust"], sharp_angle=60)
        parts[f"EngineMetal_{sfx}"] = M.join([lip], f"EngineMetal_{sfx}")
        parts[f"EngineDark_{sfx}"] = M.join([inner, duct], f"EngineDark_{sfx}")
        parts[f"EngineCore_{sfx}"] = M.join([core], f"EngineCore_{sfx}")
        parts[f"EngineHot_{sfx}"] = M.join([plug, nozzle], f"EngineHot_{sfx}")
        # Fan: blades and spinner on one pivot.
        c = centre(side) + np.array([0, D.FAN_FS, 0])
        fan = M.empty(f"Fan_{sfx}", col, M.P(*c), props={"axis": [0.0, 0.0, 1.0]})
        b = M.make_object(f"FanBlades_{sfx}", *blades(side), col, mats["fan"], sharp_angle=40, origin=M.P(*c))
        M.parent_keep(b, fan)
        s = M.make_object(f"Spinner_{sfx}", *spinner(side), col, mats["spinner"], sharp_angle=70, origin=M.P(*c))
        M.parent_keep(s, fan)
        dv, df, duv = disc(side)
        d = M.make_object(f"FanDisc_{sfx}", dv, df, col, mats["prop_disc"], uvs=duv, origin=M.P(*c), recalc=False)
        M.parent_keep(d, fan)
        parts.update({f"FanBlades_{sfx}": b, f"Spinner_{sfx}": s, f"FanDisc_{sfx}": d})
        # Reverser doors: hinge across the door, 60 % aft; opening turns the forward edge out.
        for i, ang in enumerate(DOOR_ANGLES):
            hinge_fs = D.REVERSER_FS[0] + 0.6 * (D.REVERSER_FS[1] - D.REVERSER_FS[0])
            r = _interp(OUTER, hinge_fs) - 0.05
            hp = ring_point(side, hinge_fs, ang, r)
            tangent = ring_point(side, hinge_fs, ang + 1, r) - ring_point(side, hinge_fs, ang - 1, r)
            tangent /= np.linalg.norm(tangent)
            probe = ring_point(side, D.REVERSER_FS[0], ang, r)
            out = probe - ring_point(side, D.REVERSER_FS[0], ang, 0.0)
            ax, _ = W.oriented_axis(hp - tangent, hp + tangent, probe, out)
            p = M.empty(f"RevDoor_{sfx}{i}", col, M.P(*hp), props={"axis": ax, "openDeg": 38.0})
            o = M.make_object(f"RevDoorMesh_{sfx}{i}", *door(side, ang), col, mats["paint"], sharp_angle=50,
                              origin=M.P(*hp))
            M.parent_keep(o, p)
            parts[f"RevDoorMesh_{sfx}{i}"] = o
