"""
Mesh helpers: numpy arrays in, Blender objects out.

Design frame used by every geometry function: (BL, FS, WL) in metres =
  BL  butt line, positive to the LEFT wing,
  FS  fuselage station, positive AFT, 0 = front face of the firewall,
  WL  water line, height above the ground with the aircraft standing on its gear.
That is a right-handed frame and maps straight onto Blender's (x, y, z), so the exported
glTF frame (x, z, -y) becomes x left, y up, z forward: the model frame of the game.
All vertices are shifted by the reference point (REF) when an object is made, so the
object origins and the glTF origin sit at the aircraft's centre of gravity.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

# Reference point (centre of gravity) in the design frame; set by the type script.
REF = np.zeros(3)


def set_reference(bl, fs, wl):
    REF[:] = (bl, fs, wl)


def P(bl, fs, wl):
    """Design-frame point -> Blender location (relative to the reference point)."""
    return Vector((bl - REF[0], fs - REF[1], wl - REF[2]))


# ---------------------------------------------------------------------------
# Interpolation
# ---------------------------------------------------------------------------

def pchip(xs, ys, x):
    """Monotone cubic interpolation (no overshoot between keys), vectorised over x."""
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    x = np.clip(np.asarray(x, float), xs[0], xs[-1])
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros_like(ys)
    for k in range(1, len(xs) - 1):
        if d[k - 1] * d[k] > 0:
            w1 = 2 * h[k] + h[k - 1]
            w2 = h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    m[0] = d[0]
    m[-1] = d[-1]
    i = np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2)
    t = (x - xs[i]) / h[i]
    h00 = (1 + 2 * t) * (1 - t) ** 2
    h10 = t * (1 - t) ** 2
    h01 = t * t * (3 - 2 * t)
    h11 = t * t * (t - 1)
    return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def cosine_spacing(n):
    """0..1 with points clustered at both ends (leading and trailing edges)."""
    return 0.5 * (1 - np.cos(np.linspace(0, math.pi, n)))


# ---------------------------------------------------------------------------
# Topology
# ---------------------------------------------------------------------------

def grid_faces(n_rows, n_cols, wrap_cols=False, wrap_rows=False):
    """Quads of a rows x cols vertex grid (row-major)."""
    faces = []
    cols = n_cols if wrap_cols else n_cols - 1
    rows = n_rows if wrap_rows else n_rows - 1
    for r in range(rows):
        r2 = (r + 1) % n_rows
        for c in range(cols):
            c2 = (c + 1) % n_cols
            faces.append((r * n_cols + c, r * n_cols + c2, r2 * n_cols + c2, r2 * n_cols + c))
    return faces


def fan_cap(ring_indices, center_index, reverse=False):
    n = len(ring_indices)
    out = []
    for i in range(n):
        a, b = ring_indices[i], ring_indices[(i + 1) % n]
        out.append((center_index, b, a) if reverse else (center_index, a, b))
    return out


# ---------------------------------------------------------------------------
# Objects
# ---------------------------------------------------------------------------

def collection(name, parent=None):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    parent = parent or bpy.context.scene.collection
    if col.name not in parent.children:
        parent.children.link(col)
    return col


def make_object(name, verts, faces, col, mat=None, smooth=True, sharp_angle=None,
                design_frame=True, origin=None, uvs=None, recalc=True):
    """
    verts: (N,3) in the design frame (or Blender frame if design_frame=False).
    origin: Blender-frame Vector for the object origin (pivot); vertices keep their place.
    uvs: optional (len(loops), 2) array in face-corner order.
    """
    v = np.asarray(verts, float).reshape(-1, 3)
    if design_frame:
        v = v - REF
    org = Vector(origin) if origin is not None else Vector((0, 0, 0))
    v = v - np.array(org)
    me = bpy.data.meshes.new(name)
    me.from_pydata(v.tolist(), [], [tuple(int(i) for i in f) for f in faces])
    me.validate(clean_customdata=False)
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
    if uvs is not None:
        uv = me.uv_layers.new(name="UVMap")
        uv.data.foreach_set("uv", np.asarray(uvs, np.float32).ravel())
    if mat is not None:
        me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    obj.location = org
    col.objects.link(obj)
    if smooth:
        me.shade_smooth()
        if sharp_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    else:
        me.shade_flat()
    return obj


def from_bmesh(name, bm, col, mat=None, smooth=True, sharp_angle=None, origin=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    col.objects.link(obj)
    if mat is not None:
        me.materials.append(mat)
    if origin is not None:
        shift_origin(obj, origin)
    if smooth:
        me.shade_smooth()
        if sharp_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    return obj


def shift_origin(obj, origin):
    """Moves the object origin to `origin` (Blender frame) without moving the geometry."""
    origin = Vector(origin)
    delta = origin - obj.location
    obj.data.transform(Matrix.Translation(-delta))
    obj.location = origin


def empty(name, col, loc, parent=None, size=0.1, props=None):
    """A pivot node. Rest rotation is always identity; the hinge axis goes into extras."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = size
    e.empty_display_type = "ARROWS"
    col.objects.link(e)
    if parent is not None:
        e.parent = parent
        e.location = Vector(loc) - parent.matrix_world.translation
    else:
        e.location = Vector(loc)
    for k, v in (props or {}).items():
        e[k] = v
    bpy.context.view_layer.update()
    return e


def parent_keep(child, parent):
    """Parents without moving the child (pivots never rotate at rest, so this is a shift)."""
    bpy.context.view_layer.update()
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_world = mw
    bpy.context.view_layer.update()


def model_axis(bl, fs, wl):
    """Direction in the design frame -> unit vector in the game's model frame (x left, y up, z fwd)."""
    v = np.array([bl, wl, -fs], float)
    return [float(c) for c in v / np.linalg.norm(v)]


def join(objs, name=None):
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        if name:
            objs[0].name = name
            objs[0].data.name = name
        return objs[0]
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs,
                                   selected_objects=objs):
        bpy.ops.object.join()
    if name:
        objs[0].name = name
        objs[0].data.name = name
    return objs[0]


def apply_modifiers(obj):
    with bpy.context.temp_override(object=obj, active_object=obj):
        for m in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)


def bevel(obj, width, segments=2, angle=40, harden=True):
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(angle)
    m.harden_normals = harden
    m.miter_outer = "MITER_ARC"
    apply_modifiers(obj)
    return obj


def subdivide(obj, levels=1):
    m = obj.modifiers.new("Subsurf", "SUBSURF")
    m.levels = levels
    m.render_levels = levels
    apply_modifiers(obj)
    return obj


def set_material(obj, mat, faces=None):
    me = obj.data
    if mat.name not in [m.name for m in me.materials if m]:
        me.materials.append(mat)
    idx = [m.name if m else None for m in me.materials].index(mat.name)
    if faces is None:
        me.polygons.foreach_set("material_index", [idx] * len(me.polygons))
    else:
        for f in faces:
            me.polygons[f].material_index = idx
    return idx


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def boolean(obj, cutter, op="DIFFERENCE"):
    m = obj.modifiers.new("Bool", "BOOLEAN")
    m.operation = op
    m.solver = "EXACT"
    m.object = cutter
    m.use_self = False
    m.use_hole_tolerant = False
    # Faces from the cutter keep the cutter's material (window cutters are deleted by it).
    m.material_mode = "TRANSFER"
    apply_modifiers(obj)
    return obj


def transfer_normals(obj, source):
    """Copies interpolated normals of a smooth source surface (shading without boolean seams)."""
    m = obj.modifiers.new("Normals", "DATA_TRANSFER")
    m.object = source
    m.use_loop_data = True
    m.data_types_loops = {"CUSTOM_NORMAL"}
    m.loop_mapping = "POLYINTERP_NEAREST"
    apply_modifiers(obj)


def delete_object(obj):
    me = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj, do_unlink=True)
    if me is not None and me.users == 0:
        bpy.data.meshes.remove(me)


def duplicate(obj, name, col=None):
    o = obj.copy()
    if obj.data is not None:
        o.data = obj.data.copy()
    o.name = name
    if o.data is not None:
        o.data.name = name
    (col or obj.users_collection[0]).objects.link(o)
    return o


# ---------------------------------------------------------------------------
# Primitive shapes (design frame)
# ---------------------------------------------------------------------------

def frame_from_axis(axis):
    """Two unit vectors perpendicular to `axis` (numpy)."""
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    ref = np.array([0, 0, 1.0]) if abs(a[2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(a, ref)
    u /= np.linalg.norm(u)
    w = np.cross(a, u)
    return a, u, w


def tube_path(points, radii, n=16, cap=True, rot0=0.0):
    """Swept circle along a polyline (design frame). Returns verts, faces."""
    pts = np.asarray(points, float)
    radii = np.broadcast_to(np.asarray(radii, float), (len(pts),))
    verts = []
    prev_u = None
    for i, p in enumerate(pts):
        t = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        if prev_u is None:
            _, u, _ = frame_from_axis(t)
        else:
            u = prev_u - t * np.dot(prev_u, t)
            u /= np.linalg.norm(u)
        prev_u = u
        w = np.cross(t, u)
        for k in range(n):
            a = rot0 + 2 * math.pi * k / n
            verts.append(p + radii[i] * (math.cos(a) * u + math.sin(a) * w))
    faces = grid_faces(len(pts), n, wrap_cols=True)
    verts = list(verts)
    if cap:
        c0 = len(verts)
        verts.append(pts[0])
        faces += fan_cap(list(range(n)), c0, reverse=True)
        c1 = len(verts)
        verts.append(pts[-1])
        faces += fan_cap([(len(pts) - 1) * n + k for k in range(n)], c1)
    return np.array(verts), faces


def cylinder(a, b, r, n=16, cap=True):
    return tube_path([a, b], [r, r], n, cap)


def lathe(profile, axis_origin, axis_dir, n=32, close_start=True, close_end=True):
    """
    Surface of revolution. profile: list of (s, r) along the axis from axis_origin.
    Ends with r == 0 collapse into a pole vertex.
    """
    o = np.asarray(axis_origin, float)
    a, u, w = frame_from_axis(axis_dir)
    verts, faces = [], []
    rows = []
    for s, r in profile:
        c = o + a * s
        if r <= 1e-6:
            rows.append([len(verts)])
            verts.append(c)
            continue
        row = []
        for k in range(n):
            ang = 2 * math.pi * k / n
            row.append(len(verts))
            verts.append(c + r * (math.cos(ang) * u + math.sin(ang) * w))
        rows.append(row)
    for r0, r1 in zip(rows[:-1], rows[1:]):
        if len(r0) == 1 and len(r1) == 1:
            continue
        if len(r0) == 1:
            for k in range(n):
                faces.append((r0[0], r1[(k + 1) % n], r1[k]))
        elif len(r1) == 1:
            for k in range(n):
                faces.append((r0[k], r0[(k + 1) % n], r1[0]))
        else:
            for k in range(n):
                faces.append((r0[k], r0[(k + 1) % n], r1[(k + 1) % n], r1[k]))
    if close_start and len(rows[0]) > 1:
        c = len(verts)
        verts.append(o + a * profile[0][0])
        faces += fan_cap(rows[0], c, reverse=True)
    if close_end and len(rows[-1]) > 1:
        c = len(verts)
        verts.append(o + a * profile[-1][0])
        faces += fan_cap(rows[-1], c)
    return np.array(verts), faces


def rounded_box(center, size, radius, segments=3):
    """Axis-aligned box with rounded edges (design frame), via bmesh + bevel."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if radius > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=radius, segments=segments,
                        affect="EDGES", profile=0.5, clamp_overlap=True)
    verts = np.array([v.co[:] for v in bm.verts]) + np.asarray(center, float)
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return verts, faces


def merge(parts):
    """Concatenates (verts, faces) pairs."""
    verts, faces, off = [], [], 0
    for v, f in parts:
        v = np.asarray(v, float).reshape(-1, 3)
        verts.append(v)
        faces += [tuple(i + off for i in face) for face in f]
        off += len(v)
    return np.vstack(verts), faces


def transform(verts, rot=None, scale=None, offset=None, pivot=(0, 0, 0)):
    v = np.asarray(verts, float) - np.asarray(pivot, float)
    if scale is not None:
        v = v * np.asarray(scale, float)
    if rot is not None:
        v = v @ np.asarray(rot, float).T
    v = v + np.asarray(pivot, float)
    if offset is not None:
        v = v + np.asarray(offset, float)
    return v


def rot_axis(axis, angle):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    x, y, z = a
    c, s = math.cos(angle), math.sin(angle)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def mirror_bl(verts, faces):
    """Mirror across the centre plane (BL -> -BL) with corrected winding."""
    v = np.asarray(verts, float).copy()
    v[:, 0] *= -1
    return v, [tuple(reversed(f)) for f in faces]


def rounded_polygon(points, radius, seg=6):
    """2D polygon with filleted corners (counter-clockwise or clockwise, any)."""
    pts = np.asarray(points, float)
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        d0 = p0 - p1
        d2 = p2 - p1
        l0, l2 = np.linalg.norm(d0), np.linalg.norm(d2)
        d0 /= l0
        d2 /= l2
        ang = math.acos(np.clip(np.dot(d0, d2), -1, 1))
        r = radius[i] if hasattr(radius, "__len__") else radius
        if r <= 0 or ang > math.pi - 1e-3:
            out.append(p1)
            continue
        t = min(r / math.tan(ang / 2), 0.45 * l0, 0.45 * l2)
        r = t * math.tan(ang / 2)
        a = p1 + d0 * t
        b = p1 + d2 * t
        bis = d0 + d2
        bis /= np.linalg.norm(bis)
        c = p1 + bis * (r / math.sin(ang / 2))
        a0 = math.atan2(*(a - c)[::-1])
        a1 = math.atan2(*(b - c)[::-1])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(seg + 1):
            ak = a0 + da * k / seg
            out.append(c + r * np.array([math.cos(ak), math.sin(ak)]))
    return np.array(out)


def prism(poly2d, axis, lo, hi, plane_axes):
    """
    Closed prism: a 2D polygon in the plane spanned by plane_axes (indices into design xyz),
    extruded along `axis` (index) from lo to hi. Returns verts, faces (outward normals).
    """
    poly = np.asarray(poly2d, float)
    # Make the polygon counter-clockwise in its 2D frame.
    area = 0.5 * np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])
    if area < 0:
        poly = poly[::-1]
    n = len(poly)
    verts = []
    for h in (lo, hi):
        for p in poly:
            v = [0.0, 0.0, 0.0]
            v[plane_axes[0]] = p[0]
            v[plane_axes[1]] = p[1]
            v[axis] = h
            verts.append(v)
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    verts = np.array(verts)
    # Orientation depends on the handedness of (plane_axes, axis); fix it by a volume check.
    vol = 0.0
    for f in faces:
        a = verts[f[0]]
        for k in range(1, len(f) - 1):
            vol += np.dot(a, np.cross(verts[f[k]], verts[f[k + 1]]))
    if vol < 0:
        faces = [tuple(reversed(f)) for f in faces]
    return verts, faces
