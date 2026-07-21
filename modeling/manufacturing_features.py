"""为 OpenCascade 拆件写入可打印连接与紧固结构，并执行几何校验。"""

from __future__ import annotations

from dataclasses import dataclass
from math import acos, cos, hypot, pi, sin, sqrt
from typing import Literal

import cadquery as cq

SplitAxis = Literal["x", "y", "z"]
JointType = Literal["round-pin", "d-pin", "dovetail", "ball-socket", "magnet"]
FastenerType = Literal[
    "none",
    "screw-boss",
    "snap-fit",
    "threaded-hole",
    "external-thread",
    "iso-threaded-hole",
    "iso-external-thread",
]
ScrewSize = Literal["M2", "M2.5", "M3"]


@dataclass(frozen=True)
class FeaturePlacement:
    """连接或紧固结构在拆件平面上的实际毫米坐标。"""

    label: str
    role: Literal["joint", "fastener"]
    u_mm: float
    v_mm: float
    diameter_mm: float | None = None
    width_mm: float | None = None
    height_mm: float | None = None
    length_mm: float | None = None
    pitch_mm: float | None = None
    thread_standard: str | None = None
    profile_angle_deg: float | None = None


@dataclass(frozen=True)
class ManufacturingFeatureValidation:
    """实体化连接结构后的通用制造校验结果。"""

    joint_type: JointType
    fastener_type: FastenerType
    screw_size: ScrewSize
    clearance_mm: float
    joint_count: int
    fastener_count: int
    minimum_designed_wall_mm: float
    interference_volume_mm3: float
    negative_final_volume_mm3: float
    positive_final_volume_mm3: float
    placements: tuple[FeaturePlacement, ...]


JOINT_DIAMETER_MM: dict[JointType, float] = {
    "round-pin": 4.0,
    "d-pin": 5.0,
    "dovetail": 6.0,
    "ball-socket": 7.0,
    "magnet": 6.2,
}

SCREW_PARAMETERS_MM: dict[ScrewSize, dict[str, float]] = {
    "M2": {"pilot": 1.6, "clearance": 2.4, "head": 4.2, "boss": 5.6},
    "M2.5": {"pilot": 2.0, "clearance": 2.9, "head": 5.0, "boss": 6.6},
    "M3": {"pilot": 2.5, "clearance": 3.4, "head": 6.0, "boss": 7.8},
}

# 面向 0.4 毫米喷嘴的 PLA/PETG 通用悬臂卡扣默认尺寸。
SNAP_FIT_PARAMETERS_MM = {
    "arm_width": 6.0,
    "arm_thickness": 1.6,
    "preferred_arm_length": 9.5,
    "minimum_arm_length": 6.5,
    "hook_height": 1.0,
    "hook_length": 2.2,
    "root_overlap": 1.0,
    "minimum_wall": 1.2,
}

# 针对 0.4 毫米喷嘴放大的圆脊近似螺纹，不冒充 ISO 60° 真实牙型。
PRINT_THREAD_PARAMETERS_MM: dict[ScrewSize, dict[str, float]] = {
    "M2": {"pitch": 0.8, "ridge_radius": 0.18, "length": 6.4},
    "M2.5": {"pitch": 1.0, "ridge_radius": 0.22, "length": 7.0},
    "M3": {"pitch": 1.2, "ridge_radius": 0.25, "length": 7.5},
}

THREAD_NOMINAL_DIAMETER_MM: dict[ScrewSize, float] = {"M2": 2.0, "M2.5": 2.5, "M3": 3.0}

# ISO 261 公制粗牙螺距；牙型按 ISO 基本 60° 截面生成，打印间隙只扩大配合孔。
ISO_METRIC_THREAD_PARAMETERS_MM: dict[ScrewSize, dict[str, float]] = {
    "M2": {"pitch": 0.4, "length": 6.0},
    "M2.5": {"pitch": 0.45, "length": 6.5},
    "M3": {"pitch": 0.5, "length": 7.0},
}

_AXIS_INDEX: dict[SplitAxis, int] = {"x": 0, "y": 1, "z": 2}
_TRANSVERSE_AXES: dict[SplitAxis, tuple[str, str]] = {
    "x": ("y", "z"),
    "y": ("x", "z"),
    "z": ("x", "y"),
}


def _workplane(shape: cq.Shape) -> cq.Workplane:
    return cq.Workplane("XY").newObject([shape])


def _axis_vector(axis: SplitAxis, sign: float = 1.0) -> cq.Vector:
    values = [0.0, 0.0, 0.0]
    values[_AXIS_INDEX[axis]] = sign
    return cq.Vector(*values)


def _point(axis: SplitAxis, axial_mm: float, u_mm: float, v_mm: float) -> cq.Vector:
    if axis == "x":
        return cq.Vector(axial_mm, u_mm, v_mm)
    if axis == "y":
        return cq.Vector(u_mm, axial_mm, v_mm)
    return cq.Vector(u_mm, v_mm, axial_mm)


def _plane(axis: SplitAxis, axial_mm: float, u_mm: float, v_mm: float) -> cq.Plane:
    origin = _point(axis, axial_mm, u_mm, v_mm)
    if axis == "x":
        return cq.Plane(origin=origin, xDir=(0, 1, 0), normal=(1, 0, 0))
    if axis == "y":
        return cq.Plane(origin=origin, xDir=(1, 0, 0), normal=(0, 1, 0))
    return cq.Plane(origin=origin, xDir=(1, 0, 0), normal=(0, 0, 1))


def _cylinder(
    axis: SplitAxis,
    axial_start_mm: float,
    u_mm: float,
    v_mm: float,
    radius_mm: float,
    length_mm: float,
    sign: float = 1.0,
) -> cq.Workplane:
    solid = cq.Solid.makeCylinder(
        radius_mm,
        length_mm,
        _point(axis, axial_start_mm, u_mm, v_mm),
        _axis_vector(axis, sign),
    )
    return _workplane(solid)


def _sphere(axis: SplitAxis, axial_mm: float, u_mm: float, v_mm: float, radius_mm: float) -> cq.Workplane:
    return _workplane(cq.Solid.makeSphere(radius_mm, _point(axis, axial_mm, u_mm, v_mm)))


def _profile_prism(
    axis: SplitAxis,
    axial_start_mm: float,
    u_mm: float,
    v_mm: float,
    points: list[tuple[float, float]],
    length_mm: float,
) -> cq.Workplane:
    return cq.Workplane(_plane(axis, axial_start_mm, u_mm, v_mm)).polyline(points).close().extrude(length_mm)


def _rect_prism(
    axis: SplitAxis,
    axial_start_mm: float,
    u_mm: float,
    v_mm: float,
    width_mm: float,
    height_mm: float,
    length_mm: float,
) -> cq.Workplane:
    """按切割轴和局部 U/V 坐标生成长方体，避免绑定全局 X/Y/Z。"""

    return cq.Workplane(_plane(axis, axial_start_mm, u_mm, v_mm)).rect(width_mm, height_mm).extrude(length_mm)


def _snap_hook_ramp(
    axis: SplitAxis,
    axial_start_mm: float,
    u_mm: float,
    v_mm: float,
    width_mm: float,
    arm_thickness_mm: float,
    hook_height_mm: float,
    length_mm: float,
) -> cq.Workplane:
    """生成前端收窄的卡扣导入斜面，扣钩只向局部 +V 方向凸出。"""

    plane = _plane(axis, axial_start_mm, u_mm, v_mm)
    return (
        cq.Workplane(plane)
        .center(0, hook_height_mm / 2)
        .rect(width_mm, arm_thickness_mm + hook_height_mm)
        .workplane(offset=length_mm)
        .center(0, -hook_height_mm / 2)
        .rect(width_mm, arm_thickness_mm)
        .loft(combine=True)
    )


def _thread_ridge(
    axis: SplitAxis,
    axial_start_mm: float,
    u_mm: float,
    v_mm: float,
    helix_radius_mm: float,
    ridge_radius_mm: float,
    pitch_mm: float,
    length_mm: float,
    sign: float = 1.0,
) -> cq.Workplane:
    """沿任意切割轴扫掠圆脊螺旋，作为 0.4 毫米喷嘴可打印的近似牙型。"""

    helix = cq.Wire.makeHelix(
        pitch_mm,
        length_mm,
        helix_radius_mm,
        center=_point(axis, axial_start_mm, u_mm, v_mm),
        dir=_axis_vector(axis, sign),
    )
    edge = helix.Edges()[0]
    start = edge.positionAt(0)
    tangent = edge.tangentAt(0)
    profile = cq.Workplane(cq.Plane(origin=start, normal=tangent)).circle(ridge_radius_mm)
    return profile.sweep(helix, isFrenet=True)


def _iso_thread_tooth(
    axis: SplitAxis,
    axial_start_mm: float,
    u_mm: float,
    v_mm: float,
    root_radius_mm: float,
    pitch_mm: float,
    length_mm: float,
    profile_depth_mm: float,
    *,
    radial_clearance_mm: float = 0.0,
    axial_clearance_mm: float = 0.0,
    sign: float = 1.0,
) -> cq.Workplane:
    """沿螺旋扫掠 ISO 公制基本 60° 梯形牙，不使用圆脊近似截面。"""

    helix_radius = root_radius_mm + radial_clearance_mm
    helix = cq.Wire.makeHelix(
        pitch_mm,
        length_mm,
        helix_radius,
        center=_point(axis, axial_start_mm, u_mm, v_mm),
        dir=_axis_vector(axis, sign),
    )
    edge = helix.Edges()[0]
    start = edge.positionAt(0)
    tangent = edge.tangentAt(0)
    radial = (start - _point(axis, axial_start_mm, u_mm, v_mm)).normalized()
    profile_plane = cq.Plane(origin=start, xDir=radial, normal=tangent)

    # ISO 基本牙型：H = sqrt(3)/2 * P，工作牙高 5H/8；
    # 外牙牙顶截平 P/8、牙根占宽 3P/4，两侧斜面保持 60° 夹角。
    crest_width = pitch_mm / 8 + axial_clearance_mm * 2
    root_width = pitch_mm * 3 / 4 + axial_clearance_mm * 2
    root_overlap = max(0.03, radial_clearance_mm + 0.08)
    profile = (
        cq.Workplane(profile_plane)
        .polyline(
            [
                (-root_overlap, -root_width / 2),
                (profile_depth_mm, -crest_width / 2),
                (profile_depth_mm, crest_width / 2),
                (-root_overlap, root_width / 2),
            ]
        )
        .close()
    )
    swept = profile.sweep(helix, isFrenet=True)
    axial_clip = _cylinder(
        axis,
        axial_start_mm,
        u_mm,
        v_mm,
        helix_radius + profile_depth_mm + 0.05,
        length_mm,
        sign,
    )
    return swept.intersect(axial_clip).clean()


def _iso_thread_dimensions(screw_size: ScrewSize) -> tuple[float, float, float, float]:
    """返回 ISO 粗牙螺距、牙高、牙根半径和默认有效长度。"""

    thread = ISO_METRIC_THREAD_PARAMETERS_MM[screw_size]
    pitch = thread["pitch"]
    fundamental_height = sqrt(3) / 2 * pitch
    profile_depth = fundamental_height * 5 / 8
    root_radius = THREAD_NOMINAL_DIAMETER_MM[screw_size] / 2 - profile_depth
    return pitch, profile_depth, root_radius, thread["length"]


def _d_profile(radius_mm: float) -> list[tuple[float, float]]:
    flat_x = -0.4 * radius_mm
    start = -acos(flat_x / radius_mm)
    end = -start
    return [
        (radius_mm * cos(start + (end - start) * index / 18), radius_mm * sin(start + (end - start) * index / 18))
        for index in range(19)
    ]


def _dovetail_profile(width_mm: float, height_mm: float) -> list[tuple[float, float]]:
    narrow_width = width_mm * 0.62
    return [
        (-narrow_width / 2, -height_mm / 2),
        (narrow_width / 2, -height_mm / 2),
        (width_mm / 2, height_mm / 2),
        (-width_mm / 2, height_mm / 2),
    ]


def _total_volume(model: cq.Workplane) -> float:
    return sum(solid.Volume() for solid in model.val().Solids())


def _closed_valid(model: cq.Workplane, label: str) -> list[cq.Solid]:
    shape = model.val()
    solids = shape.Solids()
    if not solids:
        raise ValueError(f"{label}没有生成封闭实体")
    if not shape.isValid() or not all(solid.isValid() for solid in solids):
        raise ValueError(f"{label}包含无效 OpenCascade 实体")
    if not all(solid.Shells() and all(shell.Closed() for shell in solid.Shells()) for solid in solids):
        raise ValueError(f"{label}存在未封闭外壳")
    return solids


def _candidate_points(bounds: cq.BoundBox, axis: SplitAxis, inset_mm: float) -> list[tuple[float, float]]:
    u_axis, v_axis = _TRANSVERSE_AXES[axis]
    u_min = getattr(bounds, f"{u_axis}min")
    u_max = getattr(bounds, f"{u_axis}max")
    v_min = getattr(bounds, f"{v_axis}min")
    v_max = getattr(bounds, f"{v_axis}max")
    if u_max - u_min <= inset_mm * 2 or v_max - v_min <= inset_mm * 2:
        raise ValueError("拆件截面空间不足，无法放置所选连接和紧固结构")

    usable_u_min = u_min + inset_mm
    usable_u_max = u_max - inset_mm
    usable_v_min = v_min + inset_mm
    usable_v_max = v_max - inset_mm
    u_values = [usable_u_min, usable_u_max, (u_min + u_max) / 2]
    v_values = [usable_v_min, usable_v_max, (v_min + v_max) / 2]
    preferred = [
        (u_values[0], v_values[0]),
        (u_values[1], v_values[0]),
        (u_values[0], v_values[1]),
        (u_values[1], v_values[1]),
        (u_values[0], v_values[2]),
        (u_values[1], v_values[2]),
        (u_values[2], v_values[0]),
        (u_values[2], v_values[1]),
        (u_values[2], v_values[2]),
    ]
    # 在可用内缩区域中补充规则网格，窄截面也能沿长边布置多个结构。
    for u_ratio in (0.0, 1 / 3, 0.5, 2 / 3, 1.0):
        for v_ratio in (0.0, 1 / 3, 0.5, 2 / 3, 1.0):
            preferred.append((
                usable_u_min + (usable_u_max - usable_u_min) * u_ratio,
                usable_v_min + (usable_v_max - usable_v_min) * v_ratio,
            ))

    unique: list[tuple[float, float]] = []
    for candidate in preferred:
        if not any(abs(candidate[0] - existing[0]) < 1e-6 and abs(candidate[1] - existing[1]) < 1e-6 for existing in unique):
            unique.append(candidate)
    return unique


def _find_placements(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    support_radius_mm: float,
    count: int,
    minimum_count: int | None = None,
) -> list[tuple[float, float]]:
    bounds = negative.val().fuse(positive.val()).BoundingBox()
    support_depth = max(3.0, support_radius_mm * 0.8)
    minimum_overlap = max(0.05, pi * support_radius_mm * support_radius_mm * support_depth * 0.015)
    candidates: list[tuple[float, float, float]] = []

    for u_mm, v_mm in _candidate_points(bounds, axis, support_radius_mm + 0.8):
        negative_probe = _cylinder(
            axis,
            offset_mm + 0.05,
            u_mm,
            v_mm,
            support_radius_mm,
            support_depth + 0.1,
            -1,
        )
        positive_probe = _cylinder(
            axis,
            offset_mm - 0.05,
            u_mm,
            v_mm,
            support_radius_mm,
            support_depth + 0.1,
            1,
        )
        negative_overlap = _total_volume(negative.intersect(negative_probe))
        positive_overlap = _total_volume(positive.intersect(positive_probe))
        if negative_overlap >= minimum_overlap and positive_overlap >= minimum_overlap:
            candidates.append((u_mm, v_mm, min(negative_overlap, positive_overlap)))

    selected: list[tuple[float, float]] = []
    minimum_spacing = support_radius_mm * 2.15
    for u_mm, v_mm, _ in sorted(candidates, key=lambda item: item[2], reverse=True):
        if all((u_mm - old_u) ** 2 + (v_mm - old_v) ** 2 >= minimum_spacing**2 for old_u, old_v in selected):
            selected.append((u_mm, v_mm))
            if len(selected) == count:
                return selected

    required = count if minimum_count is None else minimum_count
    if len(selected) >= required:
        return selected
    raise ValueError(
        f"当前拆件截面只能安全放置 {len(selected)} 个结构，所选方案至少需要 {required} 个；请调整拆件平面或改用更小规格"
    )


def _add_support_bosses(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    radius_mm: float,
    depth_mm: float,
) -> tuple[cq.Workplane, cq.Workplane]:
    negative_boss = _cylinder(axis, offset_mm + 0.08, u_mm, v_mm, radius_mm, depth_mm + 0.08, -1)
    positive_boss = _cylinder(axis, offset_mm - 0.08, u_mm, v_mm, radius_mm, depth_mm + 0.08, 1)
    return negative.union(negative_boss), positive.union(positive_boss)


def _apply_joint(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    joint_type: JointType,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, cq.Workplane | None, float]:
    diameter = JOINT_DIAMETER_MM[joint_type]
    radius = diameter / 2
    minimum_wall = 1.2
    support_radius = radius + clearance_mm + minimum_wall
    support_depth = max(3.2, diameter * 0.65)
    negative, positive = _add_support_bosses(
        negative, positive, axis, offset_mm, u_mm, v_mm, support_radius, support_depth
    )

    if joint_type == "magnet":
        pocket_radius = radius
        pocket_depth = 2.4
        negative_pocket = _cylinder(axis, offset_mm + 0.1, u_mm, v_mm, pocket_radius, pocket_depth + 0.1, -1)
        positive_pocket = _cylinder(axis, offset_mm - 0.1, u_mm, v_mm, pocket_radius, pocket_depth + 0.1, 1)
        return negative.cut(negative_pocket), positive.cut(positive_pocket), None, support_radius - pocket_radius

    pin_length = max(3.5, diameter * 0.72)
    root_overlap = 0.8
    if joint_type == "round-pin":
        male = _cylinder(axis, offset_mm - root_overlap, u_mm, v_mm, radius, pin_length + root_overlap)
        socket = _cylinder(
            axis,
            offset_mm - 0.15,
            u_mm,
            v_mm,
            radius + clearance_mm,
            pin_length + 0.45,
        )
    elif joint_type == "d-pin":
        male = _profile_prism(
            axis, offset_mm - root_overlap, u_mm, v_mm, _d_profile(radius), pin_length + root_overlap
        )
        socket = _profile_prism(
            axis,
            offset_mm - 0.15,
            u_mm,
            v_mm,
            _d_profile(radius + clearance_mm),
            pin_length + 0.45,
        )
    elif joint_type == "dovetail":
        profile_height = diameter * 0.68
        male = _profile_prism(
            axis,
            offset_mm - root_overlap,
            u_mm,
            v_mm,
            _dovetail_profile(diameter, profile_height),
            pin_length + root_overlap,
        )
        socket = _profile_prism(
            axis,
            offset_mm - 0.15,
            u_mm,
            v_mm,
            _dovetail_profile(diameter + clearance_mm * 2, profile_height + clearance_mm * 2),
            pin_length + 0.45,
        )
    else:
        ball_radius = radius
        ball_center = offset_mm + ball_radius * 0.82
        stem_radius = max(1.2, ball_radius * 0.42)
        stem = _cylinder(axis, offset_mm - root_overlap, u_mm, v_mm, stem_radius, ball_radius * 0.95 + root_overlap)
        ball = _sphere(axis, ball_center, u_mm, v_mm, ball_radius)
        male = stem.union(ball)
        entry = _cylinder(
            axis,
            offset_mm - 0.15,
            u_mm,
            v_mm,
            stem_radius + clearance_mm,
            ball_radius * 1.05 + 0.3,
        )
        cavity = _sphere(axis, ball_center, u_mm, v_mm, ball_radius + clearance_mm)
        socket = entry.union(cavity)

    negative = negative.union(male)
    positive = positive.cut(socket)
    interference_volume = _total_volume(male.intersect(positive))
    return negative, positive, male, support_radius - (radius + clearance_mm)


def _apply_screw_boss(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    screw_size: ScrewSize,
) -> tuple[cq.Workplane, cq.Workplane, float]:
    parameters = SCREW_PARAMETERS_MM[screw_size]
    boss_radius = parameters["boss"] / 2
    support_depth = max(4.5, parameters["boss"] * 0.72)
    negative, positive = _add_support_bosses(
        negative, positive, axis, offset_mm, u_mm, v_mm, boss_radius, support_depth
    )

    pilot_radius = parameters["pilot"] / 2
    clearance_radius = parameters["clearance"] / 2
    pilot = _cylinder(axis, offset_mm + 0.15, u_mm, v_mm, pilot_radius, support_depth + 0.3, -1)

    positive_bounds = positive.val().BoundingBox()
    positive_end = getattr(positive_bounds, f"{axis}max")
    through_length = positive_end - offset_mm + 1.0
    clearance_hole = _cylinder(axis, offset_mm - 0.2, u_mm, v_mm, clearance_radius, through_length + 0.2)
    head_depth = max(1.4, parameters["head"] * 0.32)
    counterbore = _cylinder(
        axis,
        positive_end - head_depth,
        u_mm,
        v_mm,
        parameters["head"] / 2,
        head_depth + 1.0,
    )
    return negative.cut(pilot), positive.cut(clearance_hole.union(counterbore)), boss_radius - pilot_radius


def _apply_snap_fit(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, cq.Workplane, float, tuple[float, float, float]]:
    """写入可拆悬臂卡扣和配合槽，并为扣钩预留向局部 -V 弯曲的释放空间。"""

    parameters = SNAP_FIT_PARAMETERS_MM
    arm_width = parameters["arm_width"]
    arm_thickness = parameters["arm_thickness"]
    hook_height = parameters["hook_height"]
    hook_length = parameters["hook_length"]
    root_overlap = parameters["root_overlap"]
    minimum_wall = parameters["minimum_wall"]

    positive_end = getattr(positive.val().BoundingBox(), f"{axis}max")
    available_length = positive_end - offset_mm - minimum_wall
    arm_length = min(parameters["preferred_arm_length"], available_length)
    if arm_length < parameters["minimum_arm_length"]:
        raise ValueError(
            f"正方向拆件沿 {axis.upper()} 轴仅有 {max(0.0, available_length):.2f} 毫米可用深度，"
            f"可拆卡扣至少需要 {parameters['minimum_arm_length']:.2f} 毫米"
        )

    hook_start = offset_mm + arm_length - hook_length
    support_height = arm_thickness + hook_height + clearance_mm * 2
    support_radius = hypot(arm_width / 2 + clearance_mm, support_height / 2) + minimum_wall
    negative_support_depth = max(3.6, support_radius * 0.85)
    positive_support_depth = arm_length + minimum_wall
    negative = negative.union(
        _cylinder(axis, offset_mm + 0.08, u_mm, v_mm, support_radius, negative_support_depth + 0.08, -1)
    )
    positive = positive.union(
        _cylinder(axis, offset_mm - 0.08, u_mm, v_mm, support_radius, positive_support_depth + 0.08)
    )

    arm = _rect_prism(
        axis,
        offset_mm - root_overlap,
        u_mm,
        v_mm,
        arm_width,
        arm_thickness,
        arm_length + root_overlap,
    )
    hook = _snap_hook_ramp(
        axis,
        hook_start,
        u_mm,
        v_mm,
        arm_width,
        arm_thickness,
        hook_height,
        hook_length,
    )
    male = arm.union(hook)

    slot_width = arm_width + clearance_mm * 2
    slot_height = arm_thickness + clearance_mm * 2
    slot_center_v = v_mm
    arm_slot = _rect_prism(
        axis,
        offset_mm - 0.15,
        u_mm,
        slot_center_v,
        slot_width,
        slot_height,
        arm_length + 0.45,
    )
    # 扣钩向 -V 弯曲后穿过入口；+V 一侧保留肩部，装配到位后形成可拆锁止。
    release_height = hook_height + clearance_mm
    release_slot = _rect_prism(
        axis,
        offset_mm - 0.15,
        u_mm,
        v_mm - (arm_thickness + release_height) / 2,
        slot_width,
        release_height,
        arm_length + 0.45,
    )
    hook_pocket = _rect_prism(
        axis,
        hook_start - clearance_mm,
        u_mm,
        v_mm + hook_height / 2,
        slot_width,
        arm_thickness + hook_height + clearance_mm * 2,
        hook_length + clearance_mm * 2,
    )
    socket = arm_slot.union(release_slot).union(hook_pocket)

    negative = negative.union(male)
    positive = positive.cut(socket)
    return negative, positive, male, minimum_wall, (arm_width, arm_thickness + hook_height, arm_length)


def _apply_threaded_hole(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    screw_size: ScrewSize,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, float, tuple[float, float]]:
    """在负方向螺丝柱内切出打印友好圆脊内螺纹，并在正方向生成通孔和沉孔。"""

    thread = PRINT_THREAD_PARAMETERS_MM[screw_size]
    nominal_radius = THREAD_NOMINAL_DIAMETER_MM[screw_size] / 2
    ridge_radius = thread["ridge_radius"]
    helix_radius = nominal_radius - ridge_radius
    minor_radius = nominal_radius - ridge_radius * 1.3
    groove_radius = ridge_radius + clearance_mm
    thread_length = thread["length"]
    boss_radius = max(SCREW_PARAMETERS_MM[screw_size]["boss"] / 2, nominal_radius + clearance_mm + 1.2)
    support_depth = thread_length + 1.0
    negative, positive = _add_support_bosses(
        negative, positive, axis, offset_mm, u_mm, v_mm, boss_radius, support_depth
    )

    pilot = _cylinder(
        axis,
        offset_mm + 0.2,
        u_mm,
        v_mm,
        minor_radius + clearance_mm,
        thread_length + 0.4,
        -1,
    )
    groove = _thread_ridge(
        axis,
        offset_mm - 0.05,
        u_mm,
        v_mm,
        helix_radius,
        groove_radius,
        thread["pitch"],
        thread_length + 0.25,
        -1,
    )
    negative = negative.cut(pilot.union(groove))

    positive_bounds = positive.val().BoundingBox()
    positive_end = getattr(positive_bounds, f"{axis}max")
    through_length = positive_end - offset_mm + 1.0
    clearance_hole = _cylinder(
        axis,
        offset_mm - 0.2,
        u_mm,
        v_mm,
        SCREW_PARAMETERS_MM[screw_size]["clearance"] / 2,
        through_length + 0.2,
    )
    head_depth = max(1.4, SCREW_PARAMETERS_MM[screw_size]["head"] * 0.32)
    counterbore = _cylinder(
        axis,
        positive_end - head_depth,
        u_mm,
        v_mm,
        SCREW_PARAMETERS_MM[screw_size]["head"] / 2,
        head_depth + 1.0,
    )
    positive = positive.cut(clearance_hole.union(counterbore))
    designed_wall = boss_radius - (nominal_radius + clearance_mm)
    return negative, positive, designed_wall, (thread["pitch"], thread_length)


def _apply_external_thread(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    screw_size: ScrewSize,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, cq.Workplane, float, tuple[float, float]]:
    """生成一体式打印外螺纹柱和具有相同螺距、带径向补偿的内螺纹配合孔。"""

    thread = PRINT_THREAD_PARAMETERS_MM[screw_size]
    nominal_radius = THREAD_NOMINAL_DIAMETER_MM[screw_size] / 2
    ridge_radius = thread["ridge_radius"]
    helix_radius = nominal_radius - ridge_radius
    core_radius = nominal_radius - ridge_radius * 1.3
    minimum_wall = 1.2
    root_overlap = 1.0
    positive_end = getattr(positive.val().BoundingBox(), f"{axis}max")
    available_length = positive_end - offset_mm - minimum_wall
    thread_length = min(thread["length"], available_length)
    minimum_length = max(thread["pitch"] * 4, 4.0)
    if thread_length < minimum_length:
        raise ValueError(
            f"正方向拆件沿 {axis.upper()} 轴仅有 {max(0.0, available_length):.2f} 毫米可用深度，"
            f"{screw_size} 打印外螺纹至少需要 {minimum_length:.2f} 毫米"
        )

    support_radius = nominal_radius + clearance_mm + minimum_wall
    negative = negative.union(
        _cylinder(axis, offset_mm + 0.08, u_mm, v_mm, support_radius, 3.8, -1)
    )
    positive = positive.union(
        _cylinder(axis, offset_mm - 0.08, u_mm, v_mm, support_radius, thread_length + minimum_wall + 0.08)
    )

    core = _cylinder(
        axis,
        offset_mm - root_overlap,
        u_mm,
        v_mm,
        core_radius,
        thread_length + root_overlap,
    )
    ridge = _thread_ridge(
        axis,
        offset_mm + 0.05,
        u_mm,
        v_mm,
        helix_radius,
        ridge_radius,
        thread["pitch"],
        thread_length - 0.1,
    )
    male = core.union(ridge)

    # 盲孔必须覆盖螺旋扫掠的端部包围盒；否则牙槽末端会留下与主体分离的薄螺旋芯。
    bore = _cylinder(
        axis,
        offset_mm - 0.25,
        u_mm,
        v_mm,
        core_radius + clearance_mm,
        thread_length + minimum_wall + 0.5,
    )
    groove = _thread_ridge(
        axis,
        offset_mm - 0.2,
        u_mm,
        v_mm,
        helix_radius,
        ridge_radius + clearance_mm,
        thread["pitch"],
        thread_length + 0.4,
    )
    negative = negative.union(male)
    positive = positive.cut(bore.union(groove)).clean()
    return negative, positive, male, minimum_wall, (thread["pitch"], thread_length)


def _apply_iso_threaded_hole(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    screw_size: ScrewSize,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, float, tuple[float, float]]:
    """生成 ISO 公制 60° 内螺纹螺丝柱，以及对侧通孔和圆柱沉孔。"""

    pitch, profile_depth, root_radius, thread_length = _iso_thread_dimensions(screw_size)
    nominal_radius = THREAD_NOMINAL_DIAMETER_MM[screw_size] / 2
    boss_radius = max(SCREW_PARAMETERS_MM[screw_size]["boss"] / 2, nominal_radius + clearance_mm + 1.2)
    negative, positive = _add_support_bosses(
        negative, positive, axis, offset_mm, u_mm, v_mm, boss_radius, thread_length + 1.0
    )

    pilot = _cylinder(
        axis,
        offset_mm + 0.2,
        u_mm,
        v_mm,
        root_radius + clearance_mm,
        thread_length + 0.4,
        -1,
    )
    groove = _iso_thread_tooth(
        axis,
        offset_mm - 0.05,
        u_mm,
        v_mm,
        root_radius,
        pitch,
        thread_length + 0.1,
        profile_depth,
        radial_clearance_mm=clearance_mm,
        axial_clearance_mm=min(clearance_mm * 0.25, pitch * 0.1),
        sign=-1,
    )
    negative = negative.cut(pilot.union(groove)).clean()

    positive_end = getattr(positive.val().BoundingBox(), f"{axis}max")
    through_length = positive_end - offset_mm + 1.0
    clearance_hole = _cylinder(
        axis,
        offset_mm - 0.2,
        u_mm,
        v_mm,
        SCREW_PARAMETERS_MM[screw_size]["clearance"] / 2,
        through_length + 0.2,
    )
    head_depth = max(1.4, SCREW_PARAMETERS_MM[screw_size]["head"] * 0.32)
    counterbore = _cylinder(
        axis,
        positive_end - head_depth,
        u_mm,
        v_mm,
        SCREW_PARAMETERS_MM[screw_size]["head"] / 2,
        head_depth + 1.0,
    )
    positive = positive.cut(clearance_hole.union(counterbore)).clean()
    designed_wall = boss_radius - (nominal_radius + clearance_mm)
    return negative, positive, designed_wall, (pitch, thread_length)


def _apply_iso_external_thread(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    u_mm: float,
    v_mm: float,
    screw_size: ScrewSize,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, cq.Workplane, float, tuple[float, float]]:
    """生成 ISO 公制 60° 外螺纹柱和带打印补偿的同牙型配合内螺纹孔。"""

    pitch, profile_depth, root_radius, preferred_length = _iso_thread_dimensions(screw_size)
    nominal_radius = THREAD_NOMINAL_DIAMETER_MM[screw_size] / 2
    minimum_wall = 1.2
    root_overlap = 1.0
    positive_end = getattr(positive.val().BoundingBox(), f"{axis}max")
    available_length = positive_end - offset_mm - minimum_wall
    thread_length = min(preferred_length, available_length)
    minimum_length = max(pitch * 6, 4.0)
    if thread_length < minimum_length:
        raise ValueError(
            f"正方向拆件沿 {axis.upper()} 轴仅有 {max(0.0, available_length):.2f} 毫米可用深度，"
            f"{screw_size} ISO 60° 外螺纹至少需要 {minimum_length:.2f} 毫米"
        )

    support_radius = nominal_radius + clearance_mm + minimum_wall
    negative = negative.union(
        _cylinder(axis, offset_mm + 0.08, u_mm, v_mm, support_radius, 3.8, -1)
    )
    positive = positive.union(
        _cylinder(axis, offset_mm - 0.08, u_mm, v_mm, support_radius, thread_length + minimum_wall + 0.08)
    )

    core = _cylinder(
        axis, offset_mm - root_overlap, u_mm, v_mm, root_radius, thread_length + root_overlap
    )
    tooth = _iso_thread_tooth(
        axis,
        offset_mm + 0.05,
        u_mm,
        v_mm,
        root_radius,
        pitch,
        thread_length - 0.1,
        profile_depth,
    )
    male = core.union(tooth).clean()

    bore = _cylinder(
        axis,
        offset_mm - 0.25,
        u_mm,
        v_mm,
        root_radius + clearance_mm,
        thread_length + minimum_wall + 0.5,
    )
    # 配合孔与公牙使用相同螺旋起点和相位；只扩大径向与轴向间隙，避免牙峰错相。
    groove = _iso_thread_tooth(
        axis,
        offset_mm + 0.05,
        u_mm,
        v_mm,
        root_radius,
        pitch,
        thread_length - 0.1,
        profile_depth,
        radial_clearance_mm=clearance_mm,
        axial_clearance_mm=min(clearance_mm * 0.25, pitch * 0.1),
    )
    negative = negative.union(male).clean()
    positive = positive.cut(bore.union(groove)).clean()
    return negative, positive, male, minimum_wall, (pitch, thread_length)


def apply_manufacturing_features(
    negative: cq.Workplane,
    positive: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    joint_type: JointType,
    fastener_type: FastenerType,
    screw_size: ScrewSize,
    clearance_mm: float,
) -> tuple[cq.Workplane, cq.Workplane, ManufacturingFeatureValidation]:
    """在两个拆件上布尔写入连接器与紧固结构，并拒绝无法安全附着的结果。"""

    if joint_type not in JOINT_DIAMETER_MM:
        raise ValueError("连接结构类型无效")
    if fastener_type not in (
        "none",
        "screw-boss",
        "snap-fit",
        "threaded-hole",
        "external-thread",
        "iso-threaded-hole",
        "iso-external-thread",
    ):
        raise ValueError("精确紧固结构只能选择螺丝柱、可拆卡扣、打印友好近似螺纹或 ISO 60° 螺纹")
    if screw_size not in SCREW_PARAMETERS_MM:
        raise ValueError("螺丝规格只能是 M2、M2.5 或 M3")
    if not 0.1 <= clearance_mm <= 1.0:
        raise ValueError("公母间隙必须在 0.10 至 1.00 毫米之间")

    joint_support_radius = JOINT_DIAMETER_MM[joint_type] / 2 + clearance_mm + 1.2
    screw_support_radius = (
        SCREW_PARAMETERS_MM[screw_size]["boss"] / 2
        if fastener_type in ("screw-boss", "threaded-hole", "iso-threaded-hole")
        else 0.0
    )
    snap_support_radius = 0.0
    if fastener_type == "snap-fit":
        snap = SNAP_FIT_PARAMETERS_MM
        snap_support_radius = hypot(
            snap["arm_width"] / 2 + clearance_mm,
            (snap["arm_thickness"] + snap["hook_height"] + clearance_mm * 2) / 2,
        ) + snap["minimum_wall"]
    external_thread_support_radius = (
        THREAD_NOMINAL_DIAMETER_MM[screw_size] / 2 + clearance_mm + 1.2
        if fastener_type in ("external-thread", "iso-external-thread")
        else 0.0
    )
    support_radius = max(
        joint_support_radius,
        screw_support_radius,
        snap_support_radius,
        external_thread_support_radius,
    )
    joint_count = 2
    target_fastener_count = (
        2
        if fastener_type in (
            "screw-boss",
            "snap-fit",
            "threaded-hole",
            "external-thread",
            "iso-threaded-hole",
            "iso-external-thread",
        )
        else 0
    )
    raw_placements = _find_placements(
        negative,
        positive,
        axis,
        offset_mm,
        support_radius,
        joint_count + target_fastener_count,
        joint_count + (1 if target_fastener_count else 0),
    )
    fastener_count = max(0, len(raw_placements) - joint_count)

    original_negative_solid_count = len(_closed_valid(negative, "负方向原拆件"))
    original_positive_solid_count = len(_closed_valid(positive, "正方向原拆件"))
    placements: list[FeaturePlacement] = []
    minimum_wall = float("inf")
    interference_volume = 0.0

    for index, (u_mm, v_mm) in enumerate(raw_placements[:joint_count], start=1):
        negative, positive, _male, designed_wall = _apply_joint(
            negative, positive, axis, offset_mm, u_mm, v_mm, joint_type, clearance_mm
        )
        minimum_wall = min(minimum_wall, designed_wall)
        if _male is not None:
            interference_volume += _total_volume(_male.intersect(positive))
        placements.append(
            FeaturePlacement(
                label=f"连接结构 {index}",
                role="joint",
                u_mm=u_mm,
                v_mm=v_mm,
                diameter_mm=JOINT_DIAMETER_MM[joint_type],
            )
        )

    if fastener_type == "screw-boss":
        for index, (u_mm, v_mm) in enumerate(raw_placements[joint_count:], start=1):
            negative, positive, designed_wall = _apply_screw_boss(
                negative, positive, axis, offset_mm, u_mm, v_mm, screw_size
            )
            minimum_wall = min(minimum_wall, designed_wall)
            placements.append(
                FeaturePlacement(
                    label=f"{screw_size} 螺丝柱 {index}",
                    role="fastener",
                    u_mm=u_mm,
                    v_mm=v_mm,
                    diameter_mm=SCREW_PARAMETERS_MM[screw_size]["boss"],
                )
            )
    elif fastener_type == "snap-fit":
        for index, (u_mm, v_mm) in enumerate(raw_placements[joint_count:], start=1):
            negative, positive, male, designed_wall, size = _apply_snap_fit(
                negative, positive, axis, offset_mm, u_mm, v_mm, clearance_mm
            )
            minimum_wall = min(minimum_wall, designed_wall)
            interference_volume += _total_volume(male.intersect(positive))
            placements.append(
                FeaturePlacement(
                    label=f"可拆卡扣 {index}",
                    role="fastener",
                    u_mm=u_mm,
                    v_mm=v_mm,
                    width_mm=size[0],
                    height_mm=size[1],
                    length_mm=size[2],
                )
            )
    elif fastener_type == "threaded-hole":
        for index, (u_mm, v_mm) in enumerate(raw_placements[joint_count:], start=1):
            negative, positive, designed_wall, thread_size = _apply_threaded_hole(
                negative, positive, axis, offset_mm, u_mm, v_mm, screw_size, clearance_mm
            )
            minimum_wall = min(minimum_wall, designed_wall)
            placements.append(
                FeaturePlacement(
                    label=f"{screw_size} 打印内螺纹 {index}",
                    role="fastener",
                    u_mm=u_mm,
                    v_mm=v_mm,
                    diameter_mm=THREAD_NOMINAL_DIAMETER_MM[screw_size],
                    length_mm=thread_size[1],
                    pitch_mm=thread_size[0],
                    thread_standard="打印友好圆脊近似牙型",
                )
            )
    elif fastener_type == "external-thread":
        for index, (u_mm, v_mm) in enumerate(raw_placements[joint_count:], start=1):
            negative, positive, male, designed_wall, thread_size = _apply_external_thread(
                negative, positive, axis, offset_mm, u_mm, v_mm, screw_size, clearance_mm
            )
            minimum_wall = min(minimum_wall, designed_wall)
            interference_volume += _total_volume(male.intersect(positive))
            placements.append(
                FeaturePlacement(
                    label=f"{screw_size} 打印外螺纹 {index}",
                    role="fastener",
                    u_mm=u_mm,
                    v_mm=v_mm,
                    diameter_mm=THREAD_NOMINAL_DIAMETER_MM[screw_size],
                    length_mm=thread_size[1],
                    pitch_mm=thread_size[0],
                    thread_standard="打印友好圆脊近似牙型",
                )
            )
    elif fastener_type == "iso-threaded-hole":
        for index, (u_mm, v_mm) in enumerate(raw_placements[joint_count:], start=1):
            negative, positive, designed_wall, thread_size = _apply_iso_threaded_hole(
                negative, positive, axis, offset_mm, u_mm, v_mm, screw_size, clearance_mm
            )
            minimum_wall = min(minimum_wall, designed_wall)
            placements.append(
                FeaturePlacement(
                    label=f"{screw_size} ISO 60° 内螺纹 {index}",
                    role="fastener",
                    u_mm=u_mm,
                    v_mm=v_mm,
                    diameter_mm=THREAD_NOMINAL_DIAMETER_MM[screw_size],
                    length_mm=thread_size[1],
                    pitch_mm=thread_size[0],
                    thread_standard="ISO 公制粗牙基本牙型",
                    profile_angle_deg=60.0,
                )
            )
    elif fastener_type == "iso-external-thread":
        for index, (u_mm, v_mm) in enumerate(raw_placements[joint_count:], start=1):
            negative, positive, male, designed_wall, thread_size = _apply_iso_external_thread(
                negative, positive, axis, offset_mm, u_mm, v_mm, screw_size, clearance_mm
            )
            minimum_wall = min(minimum_wall, designed_wall)
            interference_volume += _total_volume(male.intersect(positive))
            placements.append(
                FeaturePlacement(
                    label=f"{screw_size} ISO 60° 外螺纹 {index}",
                    role="fastener",
                    u_mm=u_mm,
                    v_mm=v_mm,
                    diameter_mm=THREAD_NOMINAL_DIAMETER_MM[screw_size],
                    length_mm=thread_size[1],
                    pitch_mm=thread_size[0],
                    thread_standard="ISO 公制粗牙基本牙型",
                    profile_angle_deg=60.0,
                )
            )

    negative_solids = _closed_valid(negative, "连接结构负方向拆件")
    positive_solids = _closed_valid(positive, "连接结构正方向拆件")
    if len(negative_solids) > original_negative_solid_count or len(positive_solids) > original_positive_solid_count:
        raise ValueError("连接结构未与拆件可靠相连，请调整拆件平面或结构规格")
    if interference_volume > 1e-4:
        raise ValueError(f"公母连接仍有 {interference_volume:.6f} 立方毫米干涉，请增大装配间隙")
    if minimum_wall < 1.2 - 1e-6:
        raise ValueError("连接结构设计壁厚不足 1.20 毫米，不适合 0.4 毫米喷嘴打印")

    validation = ManufacturingFeatureValidation(
        joint_type=joint_type,
        fastener_type=fastener_type,
        screw_size=screw_size,
        clearance_mm=clearance_mm,
        joint_count=joint_count,
        fastener_count=fastener_count,
        minimum_designed_wall_mm=minimum_wall,
        interference_volume_mm3=interference_volume,
        negative_final_volume_mm3=_total_volume(negative),
        positive_final_volume_mm3=_total_volume(positive),
        placements=tuple(placements),
    )
    return negative, positive, validation


def feature_validation_json(
    validation: ManufacturingFeatureValidation,
    axis: SplitAxis,
) -> dict[str, object]:
    """转换为桌面端使用的中文无关、驼峰字段结果协议。"""

    return {
        "status": "exact",
        "jointType": validation.joint_type,
        "fastenerType": validation.fastener_type,
        "screwSize": validation.screw_size,
        "clearanceMm": validation.clearance_mm,
        "jointCount": validation.joint_count,
        "fastenerCount": validation.fastener_count,
        "minimumDesignedWallMm": validation.minimum_designed_wall_mm,
        "interferenceVolumeMm3": validation.interference_volume_mm3,
        "negativeFinalVolumeMm3": validation.negative_final_volume_mm3,
        "positiveFinalVolumeMm3": validation.positive_final_volume_mm3,
        "placementAxes": list(_TRANSVERSE_AXES[axis]),
        "placements": [
            {
                "label": placement.label,
                "role": placement.role,
                "uMm": placement.u_mm,
                "vMm": placement.v_mm,
                "diameterMm": placement.diameter_mm,
                "widthMm": placement.width_mm,
                "heightMm": placement.height_mm,
                "lengthMm": placement.length_mm,
                "pitchMm": placement.pitch_mm,
                "threadStandard": placement.thread_standard,
                "profileAngleDeg": placement.profile_angle_deg,
            }
            for placement in validation.placements
        ],
    }
