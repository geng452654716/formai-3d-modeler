"""稳定 CAD 平面局部与整面特征的 OpenCascade 纯几何核心。

本模块不读写清单或模型文件，只负责重新定位稳定平面、校验点击坐标与法线、
构造确定性的局部平面坐标系、执行布尔并返回新的面描述。稳定面定位属于
“几何签名匹配第一版”，不是 OpenCascade 原生永久拓扑命名。
"""

from __future__ import annotations

import math
from typing import Any, Literal

import cadquery as cq
from OCP.BRep import BRep_Tool
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepGProp import BRepGProp_Face
from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.GeomLProp import GeomLProp_SLProps
from OCP.TopAbs import TopAbs_IN, TopAbs_ON
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt, gp_Pnt2d, gp_Vec

from face_geometry_signatures import match_shape_faces_with_sources
from split_and_cap import _closed_solids

Operation = Literal[
    "add-cylinder",
    "cut-cylinder",
    "add-rectangle",
    "cut-rectangle",
    "cut-slot",
    "offset-face-outward",
    "offset-face-inward",
    "fillet-edge",
    "chamfer-edge",
    "fillet-edge-loop",
    "chamfer-edge-loop",
    "fillet-edge-chain",
    "chamfer-edge-chain",
    "fillet-edge-manual-chain",
    "chamfer-edge-manual-chain",
]


class CurvedFeatureInterferenceError(ValueError):
    """携带精确工具体和结构化诊断的曲面干涉预检错误。"""

    def __init__(self, message: str, diagnostics: dict[str, Any], tool: cq.Workplane):
        super().__init__(message)
        self.diagnostics = diagnostics
        self.tool = tool

SURFACE_GEOMETRY_LABELS = {
    "PLANE": "平面",
    "CYLINDER": "圆柱面",
    "CONE": "圆锥面",
    "SPHERE": "球面",
    "TORUS": "圆环面",
    "BEZIER": "贝塞尔曲面",
    "BSPLINE": "B 样条曲面",
    "REVOLUTION": "旋转曲面",
    "EXTRUSION": "拉伸曲面",
    "OTHER": "其他曲面",
}


def describe_surface_geometry_type(geometry_type: str) -> str:
    """把 OpenCascade 曲面枚举转换为可直接展示的中文名称。"""
    return SURFACE_GEOMETRY_LABELS.get(geometry_type, "未知曲面")


def _unit_vector(values: tuple[float, float, float], label: str) -> cq.Vector:
    if len(values) != 3 or not all(math.isfinite(value) for value in values):
        raise ValueError(f"{label}必须是三个有限数值")
    length = math.sqrt(sum(value * value for value in values))
    if length < 0.5:
        raise ValueError(f"{label}无效，请重新选择 CAD 平面")
    return cq.Vector(*(value / length for value in values))


def _optional_dimension(value: float | None, label: str) -> float | None:
    if value is None:
        return None
    if not math.isfinite(value):
        raise ValueError(f"{label}必须是有限毫米数值")
    return float(value)


def validate_planar_feature_inputs(
    operation: str,
    stable_face_id: str,
    center: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    *,
    radius_mm: float | None,
    width_mm: float | None,
    height_mm: float | None,
    length_mm: float | None,
    depth_mm: float,
    rotation_deg: float = 0.0,
) -> None:
    """严格校验判别操作及其允许的尺寸字段。"""
    if operation not in (
        "add-cylinder",
        "cut-cylinder",
        "add-rectangle",
        "cut-rectangle",
        "cut-slot",
        "offset-face-outward",
        "offset-face-inward",
    ):
        raise ValueError("稳定 CAD 面局部特征操作无效")
    if not stable_face_id.strip():
        raise ValueError("稳定 CAD 面选择缺少稳定面 ID，请重新选择平面")
    if len(center) != 3 or not all(math.isfinite(value) for value in center):
        raise ValueError("CAD 点击坐标必须是三个有限毫米数值")
    _unit_vector(hit_normal, "点击命中法线")

    radius_mm = _optional_dimension(radius_mm, "局部圆形区域半径")
    width_mm = _optional_dimension(width_mm, "局部轮廓宽度")
    height_mm = _optional_dimension(height_mm, "局部矩形高度")
    length_mm = _optional_dimension(length_mm, "局部槽孔长度")
    if not math.isfinite(depth_mm) or not 0.2 <= depth_mm <= 200.0:
        raise ValueError("局部修改深度必须在 0.20 至 200.00 毫米之间")
    if not math.isfinite(rotation_deg) or not -180.0 <= rotation_deg <= 180.0:
        raise ValueError("局部轮廓旋转角必须在 -180.00 至 180.00 度之间")

    if operation in ("offset-face-outward", "offset-face-inward"):
        if any(value is not None for value in (radius_mm, width_mm, height_mm, length_mm)):
            raise ValueError("整面拉伸或偏移不能携带局部轮廓尺寸")
        if abs(rotation_deg) > 1e-9:
            raise ValueError("整面拉伸或偏移不需要旋转角，rotationDeg 必须为 0")
        return

    if operation in ("add-cylinder", "cut-cylinder"):
        if radius_mm is None or not 0.5 <= radius_mm <= 100.0:
            raise ValueError("局部圆形区域半径必须在 0.50 至 100.00 毫米之间")
        if any(value is not None for value in (width_mm, height_mm, length_mm)):
            raise ValueError("圆柱局部特征不能携带矩形或槽孔尺寸")
        if abs(rotation_deg) > 1e-9:
            raise ValueError("圆柱局部特征不需要旋转角，rotationDeg 必须为 0")
        return

    if radius_mm is not None:
        raise ValueError("矩形或槽孔局部特征不能携带圆形半径")
    if width_mm is None or not 0.5 <= width_mm <= 200.0:
        raise ValueError("局部轮廓宽度必须在 0.50 至 200.00 毫米之间")

    if operation in ("add-rectangle", "cut-rectangle"):
        if height_mm is None or not 0.5 <= height_mm <= 200.0:
            raise ValueError("局部矩形高度必须在 0.50 至 200.00 毫米之间")
        if length_mm is not None:
            raise ValueError("矩形局部特征不能携带槽孔长度")
        return

    if height_mm is not None:
        raise ValueError("槽孔局部特征不能携带矩形高度")
    if length_mm is None or not 1.0 <= length_mm <= 200.0:
        raise ValueError("局部槽孔长度必须在 1.00 至 200.00 毫米之间")
    if length_mm + 1e-9 < width_mm:
        raise ValueError("局部槽孔长度不能小于槽孔宽度")


def validate_edge_feature_inputs(
    operation: str,
    stable_face_id: str,
    stable_edge_id: str,
    hit_point: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    size_mm: float,
) -> None:
    """校验稳定边圆角或倒角的受限输入。"""
    if operation not in ("fillet-edge", "chamfer-edge", "fillet-edge-loop", "chamfer-edge-loop", "fillet-edge-chain", "chamfer-edge-chain", "fillet-edge-manual-chain", "chamfer-edge-manual-chain"):
        raise ValueError("稳定 CAD 边特征操作无效")
    if not stable_face_id.strip() or not stable_edge_id.strip():
        raise ValueError("稳定 CAD 边选择缺少稳定面或稳定边 ID，请重新点击目标边")
    if len(hit_point) != 3 or not all(math.isfinite(value) for value in hit_point):
        raise ValueError("CAD 边点击坐标必须是三个有限毫米数值")
    _unit_vector(hit_normal, "CAD 边点击命中法线")
    if not math.isfinite(size_mm) or not 0.2 <= size_mm <= 50.0:
        raise ValueError("圆角半径或倒角距离必须在 0.20 至 50.00 毫米之间")


def validate_feature_inputs(
    operation: str,
    stable_face_id: str,
    center: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    radius_mm: float,
    depth_mm: float,
) -> None:
    """兼容既有圆柱调用的校验包装。"""
    validate_planar_feature_inputs(
        operation,
        stable_face_id,
        center,
        hit_normal,
        radius_mm=radius_mm,
        width_mm=None,
        height_mm=None,
        length_mm=None,
        depth_mm=depth_mm,
        rotation_deg=0.0,
    )


def resolve_stable_face_pair(
    model: cq.Workplane | cq.Shape,
    current_faces: list[dict[str, Any]],
    stable_face_id: str,
    target_face_descriptor: dict[str, Any] | None,
) -> tuple[cq.Face, dict[str, Any]]:
    """通过现有几何签名协议重新定位一个稳定面及其当前描述。"""
    current_sources, _ = match_shape_faces_with_sources(model, current_faces)
    pair = next(
        (
            (face, descriptor)
            for face, descriptor in current_sources
            if descriptor.get("stableId") == stable_face_id
        ),
        None,
    )
    if pair is not None:
        return pair

    if (
        isinstance(target_face_descriptor, dict)
        and target_face_descriptor.get("stableId") == stable_face_id
    ):
        target_sources, _ = match_shape_faces_with_sources(model, [target_face_descriptor])
        pair = next(
            (
                (face, descriptor)
                for face, descriptor in target_sources
                if descriptor.get("stableId") == stable_face_id
            ),
            None,
        )
        if pair is not None:
            return pair

    raise ValueError("无法在当前实体中安全重新定位目标稳定面，需要重新选择目标面")


def _target_pair(
    model: cq.Workplane | cq.Shape,
    current_faces: list[dict[str, Any]],
    stable_face_id: str,
    target_face_descriptor: dict[str, Any] | None,
) -> tuple[cq.Face, dict[str, Any]]:
    """兼容既有局部特征调用的内部包装。"""
    return resolve_stable_face_pair(
        model, current_faces, stable_face_id, target_face_descriptor
    )


def _edge_descriptor(
    face_descriptor: dict[str, Any], stable_edge_id: str
) -> dict[str, Any]:
    edges = face_descriptor.get("edges")
    if not isinstance(edges, list):
        raise ValueError("当前稳定面没有边几何签名，请重新生成 CAD 后选择目标边")
    descriptor = next(
        (
            value for value in edges
            if isinstance(value, dict) and value.get("stableId") == stable_edge_id
        ),
        None,
    )
    if descriptor is None:
        raise ValueError("无法在目标稳定面中重新定位稳定边，请重新点击目标边")
    return descriptor


def _target_edge(
    target_face: cq.Face,
    descriptor: dict[str, Any],
    diagonal: float,
) -> cq.Edge:
    center_values = descriptor.get("centerMm")
    if not isinstance(center_values, list) or len(center_values) != 3:
        raise ValueError("稳定边几何签名缺少中心坐标，请重新选择目标边")
    expected_center = cq.Vector(*(float(value) for value in center_values))
    expected_length = float(descriptor.get("lengthMm", 0.0))
    expected_type = descriptor.get("geometryType")
    candidates: list[tuple[float, cq.Edge]] = []
    for edge in target_face.Edges():
        if edge.geomType() != expected_type:
            continue
        center_cost = edge.Center().sub(expected_center).Length / max(diagonal, 1e-9)
        length_cost = abs(edge.Length() - expected_length) / max(expected_length, 1e-9)
        candidates.append((center_cost + 0.35 * length_cost, edge))
    if not candidates:
        raise ValueError("目标稳定面中没有与几何签名一致的 OpenCascade 边")
    candidates.sort(key=lambda value: value[0])
    if candidates[0][0] > 0.08:
        raise ValueError("目标边几何签名与当前实体偏差过大，请重新选择目标边")
    if len(candidates) > 1 and abs(candidates[1][0] - candidates[0][0]) < 1e-5:
        raise ValueError("目标面存在无法区分的对称边，请换一个视角重新点击目标边")
    return candidates[0][1]


def _point_distance(first: cq.Vector, second: cq.Vector) -> float:
    """返回两个 OpenCascade 点之间的毫米距离。"""
    return float(first.sub(second).Length)


def _edge_endpoint_direction(edge: cq.Edge, endpoint: cq.Vector, tolerance: float) -> cq.Vector | None:
    """返回从指定端点沿边向内的单位切向；闭合边或端点不匹配时返回空。"""
    start = edge.startPoint()
    end = edge.endPoint()
    at_start = _point_distance(start, endpoint) <= tolerance
    at_end = _point_distance(end, endpoint) <= tolerance
    if at_start and at_end:
        return None
    try:
        if at_start:
            return edge.tangentAt(0.0).normalized()
        if at_end:
            return edge.tangentAt(1.0).multiply(-1.0).normalized()
    except Exception:
        return None
    return None


def _tangent_chain_edges(
    model: cq.Workplane,
    seed_edge: cq.Edge,
    diagonal: float,
    *,
    maximum_angle_deg: float = 5.0,
) -> list[cq.Edge]:
    """从种子边两端确定性传播到唯一切线连续边链。"""
    vertex_tolerance = max(1e-6, min(1e-3, diagonal * 1e-7))
    minimum_dot = math.cos(math.radians(maximum_angle_deg))
    all_edges = [edge for edge in model.val().Edges() if float(edge.Length()) > 1e-6]
    chain: list[cq.Edge] = [seed_edge]

    def contains(edge: cq.Edge) -> bool:
        return any(candidate.isSame(edge) for candidate in chain)

    def extend(endpoint: cq.Vector, current: cq.Edge) -> None:
        nonlocal chain
        visited_vertices: list[cq.Vector] = []
        while True:
            if any(_point_distance(endpoint, value) <= vertex_tolerance for value in visited_vertices):
                return
            visited_vertices.append(endpoint)
            current_direction = _edge_endpoint_direction(current, endpoint, vertex_tolerance)
            if current_direction is None:
                return
            candidates: list[tuple[float, cq.Edge]] = []
            for candidate in all_edges:
                if contains(candidate):
                    continue
                candidate_direction = _edge_endpoint_direction(candidate, endpoint, vertex_tolerance)
                if candidate_direction is None:
                    continue
                alignment = -float(current_direction.dot(candidate_direction))
                if alignment >= minimum_dot:
                    candidates.append((alignment, candidate))
            if not candidates:
                return
            candidates.sort(key=lambda value: value[0], reverse=True)
            if len(candidates) > 1:
                raise ValueError("种子边端点存在多条切线连续候选边，形成分叉链，已拒绝自动传播")
            next_edge = candidates[0][1]
            chain.append(next_edge)
            start = next_edge.startPoint()
            end = next_edge.endPoint()
            if _point_distance(start, endpoint) <= vertex_tolerance:
                endpoint = end
            elif _point_distance(end, endpoint) <= vertex_tolerance:
                endpoint = start
            else:
                return
            current = next_edge
            if len(chain) > 64:
                raise ValueError("切线连续边链超过 64 条边，已拒绝自动传播")

    extend(seed_edge.startPoint(), seed_edge)
    extend(seed_edge.endPoint(), seed_edge)
    if len(chain) < 2:
        raise ValueError("所选种子边两端没有可唯一传播的切线连续边，请选择分段连续边")
    return chain


def _local_x_direction(
    outward: cq.Vector,
    rotation_deg: float,
    base_direction: cq.Vector | None = None,
) -> cq.Vector:
    """从指定面内基准或世界轴构造平面 X 轴，再绕外法线旋转。"""
    if base_direction is None:
        axes = (cq.Vector(1, 0, 0), cq.Vector(0, 1, 0), cq.Vector(0, 0, 1))
        reference = min(axes, key=lambda axis: abs(float(axis.dot(outward))))
        projected = reference.sub(outward.multiply(float(reference.dot(outward))))
    else:
        projected = base_direction.sub(outward.multiply(float(base_direction.dot(outward))))
        if projected.Length <= 1e-9:
            raise ValueError("曲面 U 切向与外法线退化，无法安全确定轮廓方向")
    base_x = projected.normalized()
    base_y = outward.cross(base_x).normalized()
    radians = math.radians(rotation_deg)
    return base_x.multiply(math.cos(radians)).add(base_y.multiply(math.sin(radians))).normalized()



def _surface_frame(
    face: cq.Face,
    surface_uv: tuple[float, float],
) -> tuple[cq.Vector, cq.Vector, cq.Vector]:
    """在真实裁剪面 UV 上重新计算点、外法线和单位 U 切向。"""
    if len(surface_uv) != 2 or not all(math.isfinite(value) for value in surface_uv):
        raise ValueError("曲面 UV 必须是两个有限数值")
    u, v = (float(value) for value in surface_uv)
    u_min, u_max, v_min, v_max = (float(value) for value in face.uvBounds())
    if not all(math.isfinite(value) for value in (u_min, u_max, v_min, v_max)):
        raise ValueError("目标稳定面的 UV 范围不是有限值，当前版本无法安全编辑")
    tolerance = max(float(BRep_Tool.Tolerance_s(face.wrapped)) * 10.0, 1e-7)
    classifier = BRepClass_FaceClassifier(face.wrapped, gp_Pnt2d(u, v), tolerance, True)
    if classifier.State() not in (TopAbs_IN, TopAbs_ON):
        raise ValueError("记录的曲面 UV 不在当前裁剪面内，需要重新点击目标面")
    point = gp_Pnt()
    normal = gp_Vec()
    BRepGProp_Face(face.wrapped).Normal(u, v, point, normal)
    magnitude = float(normal.Magnitude())
    if not math.isfinite(magnitude) or magnitude <= 1e-12:
        raise ValueError("OpenCascade 无法在记录 UV 位置计算真实外法线")
    surface = BRep_Tool.Surface_s(face.wrapped)
    properties = GeomLProp_SLProps(surface, u, v, 1, 1e-9)
    if not properties.IsTangentUDefined():
        raise ValueError("OpenCascade 无法在记录 UV 位置计算 U 切向")
    tangent = gp_Dir()
    properties.TangentU(tangent)
    tangent_magnitude = math.sqrt(tangent.X() ** 2 + tangent.Y() ** 2 + tangent.Z() ** 2)
    if not math.isfinite(tangent_magnitude) or tangent_magnitude <= 1e-12:
        raise ValueError("记录 UV 位置的 U 切向退化，无法安全确定轮廓方向")
    return (
        cq.Vector(float(point.X()), float(point.Y()), float(point.Z())),
        cq.Vector(float(normal.X()) / magnitude, float(normal.Y()) / magnitude, float(normal.Z()) / magnitude),
        cq.Vector(
            float(tangent.X()) / tangent_magnitude,
            float(tangent.Y()) / tangent_magnitude,
            float(tangent.Z()) / tangent_magnitude,
        ),
    )


def _curvature_diagnostics(
    face: cq.Face,
    surface_uv: tuple[float, float],
    footprint_radius_mm: float,
    profile_label: str,
) -> dict[str, float | None]:
    """计算曲面局部曲率，并限制切平面轮廓包络相对曲率半径的尺寸。"""
    u, v = surface_uv
    surface = BRep_Tool.Surface_s(face.wrapped)
    properties = GeomLProp_SLProps(surface, float(u), float(v), 2, 1e-9)
    if not properties.IsCurvatureDefined():
        raise ValueError("OpenCascade 无法计算当前曲面的局部曲率，已拒绝自动修改")
    maximum_abs = max(abs(float(properties.MaxCurvature())), abs(float(properties.MinCurvature())))
    if not math.isfinite(maximum_abs):
        raise ValueError("当前曲面的局部曲率不是有限值，已拒绝自动修改")
    curvature_ratio = footprint_radius_mm * maximum_abs
    if curvature_ratio > 0.5 + 1e-9:
        minimum_radius = 1.0 / maximum_abs if maximum_abs > 1e-12 else math.inf
        raise ValueError(
            f"{profile_label}包络半径与局部曲率之比为 {curvature_ratio:.3f}，超过 0.500；"
            f"当前最小曲率半径约 {minimum_radius:.3f} 毫米，请减小{profile_label}尺寸"
        )
    return {
        "maximumAbsCurvaturePerMm": maximum_abs,
        "minimumCurvatureRadiusMm": None if maximum_abs <= 1e-12 else 1.0 / maximum_abs,
        "curvatureRatio": curvature_ratio,
    }


def _validate_curved_profile_footprint(
    face: cq.Face,
    point: cq.Vector,
    outward: cq.Vector,
    footprint_radius_mm: float,
    profile_label: str,
) -> None:
    """把切平面轮廓包络投影回同一裁剪面，保守拒绝越过裁剪边界的曲面特征。"""
    surface = BRep_Tool.Surface_s(face.wrapped)
    tolerance = max(float(BRep_Tool.Tolerance_s(face.wrapped)) * 10.0, 1e-7)
    x_direction = _local_x_direction(outward, 0.0)
    y_direction = outward.cross(x_direction).normalized()
    for index in range(24):
        angle = math.tau * index / 24.0
        sample = point.add(
            x_direction.multiply(footprint_radius_mm * math.cos(angle)).add(
                y_direction.multiply(footprint_radius_mm * math.sin(angle))
            )
        )
        projection = GeomAPI_ProjectPointOnSurf(gp_Pnt(sample.x, sample.y, sample.z), surface, 1e-9)
        inside = False
        for projection_index in range(1, projection.NbPoints() + 1):
            u, v = (float(value) for value in projection.Parameters(projection_index))
            if not all(math.isfinite(value) for value in (u, v)):
                continue
            classifier = BRepClass_FaceClassifier(face.wrapped, gp_Pnt2d(u, v), tolerance, True)
            if classifier.State() in (TopAbs_IN, TopAbs_ON):
                inside = True
                break
        if not inside:
            raise ValueError(f"{profile_label}作用区域会越过当前曲面的裁剪边界，请缩小尺寸或远离边界重新点击")


def _local_wall_thickness(model: cq.Workplane, point: cq.Vector, outward: cq.Vector, diagonal: float) -> float | None:
    """沿真实内法线寻找下一处实体边界，返回点击处的局部壁厚估算。"""
    epsilon = max(1e-4, min(0.01, diagonal * 1e-5))
    inward = outward.multiply(-1.0)
    origin = point.add(inward.multiply(epsilon))
    line = gp_Lin(gp_Pnt(origin.x, origin.y, origin.z), gp_Dir(inward.x, inward.y, inward.z))
    intersection = BRepIntCurveSurface_Inter()
    intersection.Init(model.val().wrapped, line, max(1e-7, epsilon * 0.01))
    nearest: float | None = None
    while intersection.More():
        distance = float(intersection.W())
        if distance > epsilon * 2.0 and (nearest is None or distance < nearest):
            nearest = distance
        intersection.Next()
    return None if nearest is None else nearest + epsilon


def _contact_axis_samples(contact: cq.Shape, point: cq.Vector, direction: cq.Vector) -> list[float]:
    """提取工具与单个源面的接触子形状中心，并换算为沿操作方向的毫米距离。"""
    samples: list[float] = []
    for sub_shapes in (contact.Faces(), contact.Edges(), contact.Vertices()):
        for sub_shape in sub_shapes:
            try:
                axis_distance = float(sub_shape.Center().sub(point).dot(direction))
            except Exception:
                continue
            if math.isfinite(axis_distance):
                samples.append(axis_distance)
    return samples


def _curved_profile_interference_diagnostics(
    model: cq.Workplane,
    target_face: cq.Face,
    current_faces: list[dict[str, Any]],
    tool: cq.Workplane,
    point: cq.Vector,
    outward: cq.Vector,
    operation: Literal["add-cylinder", "cut-cylinder", "add-rectangle", "cut-rectangle", "cut-slot"],
    footprint_radius_mm: float,
    profile_label: str,
    depth_mm: float,
    curvature_ratio: float,
    local_wall_thickness: float,
    through_cut: bool,
) -> dict[str, Any]:
    """在写入布尔结果前检查曲面轮廓工具是否再次撞回目标曲面或碰到非目标面。"""
    adding = operation in ("add-cylinder", "add-rectangle")
    cutting = operation in ("cut-cylinder", "cut-rectangle", "cut-slot")
    direction = outward if adding else outward.multiply(-1.0)
    root_allowance = max(0.1, footprint_radius_mm * max(curvature_ratio, 0.0) + 0.05)
    extent_tolerance = max(1e-4, min(0.05, depth_mm * 0.01))
    exit_allowance = max(root_allowance, 0.25)
    expected_exit_start = (
        local_wall_thickness - exit_allowance
        if cutting and through_cut
        else math.inf
    )
    face_sources, _ = match_shape_faces_with_sources(model, current_faces)
    contact_face_count = 0
    contact_sample_count = 0
    self_intersection_distances: list[float] = []
    adjacent_interference: list[tuple[str, float]] = []

    for source_face, descriptor in face_sources:
        try:
            contact = source_face.intersect(tool.val())
        except Exception as error:
            raise ValueError(f"OpenCascade 无法完成曲面作用区域干涉检查：{error}") from error
        distances = [
            distance for distance in _contact_axis_samples(contact, point, direction)
            if -extent_tolerance <= distance <= depth_mm + extent_tolerance
        ]
        if not distances:
            continue
        contact_face_count += 1
        contact_sample_count += len(distances)
        target_contact = source_face.wrapped.IsSame(target_face.wrapped)

        if target_contact:
            for distance in distances:
                if distance <= root_allowance:
                    continue
                if distance >= expected_exit_start:
                    continue
                self_intersection_distances.append(distance)
            continue

        blocking_distances = [
            distance for distance in distances
            if distance < expected_exit_start
        ]
        if blocking_distances:
            stable_id = str(descriptor.get("stableId") or "未知稳定面")
            adjacent_interference.append((stable_id, max(0.0, min(blocking_distances))))

    self_intersection = bool(self_intersection_distances)
    adjacent_face_interference = bool(adjacent_interference)
    if self_intersection or adjacent_face_interference:
        stable_ids = list(dict.fromkeys(stable_id for stable_id, _ in adjacent_interference))
        all_distances = self_intersection_distances + [distance for _, distance in adjacent_interference]
        blocked_diagnostics = {
            "interferenceCheckPassed": False,
            "selfIntersectionDetected": self_intersection,
            "adjacentFaceInterferenceDetected": adjacent_face_interference,
            "interferingFaceCount": len(stable_ids),
            "interferingStableFaceIds": stable_ids,
            "minimumInterferenceDistanceMm": min(all_distances) if all_distances else None,
            "contactFaceCount": contact_face_count,
            "contactSampleCount": contact_sample_count,
        }
        details: list[str] = []
        if self_intersection:
            nearest = min(self_intersection_distances)
            details.append(f"{profile_label}工具在距离点击位置约 {nearest:.3f} 毫米处再次接触目标曲面")
        if adjacent_face_interference:
            nearest = min(distance for _, distance in adjacent_interference)
            preview_ids = "、".join(stable_ids[:3])
            suffix = "等" if len(stable_ids) > 3 else ""
            details.append(
                f"{profile_label}工具在距离点击位置约 {nearest:.3f} 毫米处碰到 "
                f"{len(stable_ids)} 个非目标稳定面（{preview_ids}{suffix}）"
            )
        raise CurvedFeatureInterferenceError(
            f"曲面作用区域干涉检查未通过：{'；'.join(details)}。"
            f"已阻止写入模型，请减小{profile_label}尺寸或深度，或更换点击位置",
            blocked_diagnostics,
            tool,
        )

    return {
        "interferenceCheckPassed": True,
        "selfIntersectionDetected": False,
        "adjacentFaceInterferenceDetected": False,
        "interferingFaceCount": 0,
        "interferingStableFaceIds": [],
        "minimumInterferenceDistanceMm": None,
        "contactFaceCount": contact_face_count,
        "contactSampleCount": contact_sample_count,
    }


def _whole_face_tool(
    target_face: cq.Face,
    outward: cq.Vector,
    depth_mm: float,
    *,
    outward_offset: bool,
) -> cq.Workplane:
    """沿目标面的真实外法线生成整面加料或内移切削体。"""
    try:
        positive = target_face.thicken(depth_mm)
    except Exception as error:
        raise ValueError(f"OpenCascade 无法对当前平面生成整面拉伸体：{error}") from error
    face_center = target_face.Center()
    positive_shift = positive.Center().sub(face_center)
    projection = float(positive_shift.dot(outward))
    if abs(projection) < max(1e-6, depth_mm * 0.1):
        raise ValueError("OpenCascade 无法可靠判断当前平面的整面拉伸方向，请重新选择平面")
    positive_is_outward = projection > 0
    signed_depth = depth_mm if positive_is_outward == outward_offset else -depth_mm
    try:
        tool = positive if signed_depth > 0 else target_face.thicken(signed_depth)
    except Exception as error:
        raise ValueError(f"OpenCascade 无法对当前平面生成整面偏移体：{error}") from error
    if not tool.isValid() or tool.Volume() <= 1e-8:
        raise ValueError("当前平面无法生成有效的整面拉伸或偏移实体")
    return cq.Workplane(obj=tool)


def _planar_tool(
    operation: Operation,
    target_face: cq.Face,
    point: cq.Vector,
    outward: cq.Vector,
    diagonal: float,
    *,
    radius_mm: float | None,
    width_mm: float | None,
    height_mm: float | None,
    length_mm: float | None,
    depth_mm: float,
    rotation_deg: float,
    surface_x_direction: cq.Vector | None = None,
) -> cq.Workplane:
    if operation in ("offset-face-outward", "offset-face-inward"):
        return _whole_face_tool(
            target_face,
            outward,
            depth_mm,
            outward_offset=operation == "offset-face-outward",
        )

    overlap_mm = max(0.05, min(0.25, diagonal * 0.002))
    adding = operation in ("add-cylinder", "add-rectangle")
    start = point.add(outward.multiply(-overlap_mm if adding else overlap_mm))
    plane = cq.Plane(
        origin=start,
        xDir=_local_x_direction(outward, rotation_deg, surface_x_direction),
        normal=outward,
    )
    profile = cq.Workplane(plane)
    if operation in ("add-cylinder", "cut-cylinder"):
        profile = profile.circle(float(radius_mm))
    elif operation in ("add-rectangle", "cut-rectangle"):
        profile = profile.rect(float(width_mm), float(height_mm))
    else:
        profile = profile.slot2D(float(length_mm), float(width_mm))
    signed_depth = depth_mm + overlap_mm if adding else -(depth_mm + overlap_mm)
    return profile.extrude(signed_depth, combine=False)


def _operation_label(operation: Operation) -> str:
    return {
        "add-cylinder": "稳定 CAD 面圆形凸台",
        "cut-cylinder": "稳定 CAD 面圆孔切除",
        "add-rectangle": "稳定 CAD 面矩形凸台",
        "cut-rectangle": "稳定 CAD 面矩形孔切除",
        "cut-slot": "稳定 CAD 面槽孔切除",
        "offset-face-outward": "稳定 CAD 平面整面向外拉伸",
        "offset-face-inward": "稳定 CAD 平面整面向内偏移",
    }[operation]


def apply_planar_feature(
    model: cq.Workplane,
    operation: Operation,
    stable_face_id: str,
    current_faces: list[dict[str, Any]],
    center: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    *,
    radius_mm: float | None,
    width_mm: float | None,
    height_mm: float | None,
    length_mm: float | None,
    depth_mm: float,
    rotation_deg: float = 0.0,
    target_face_descriptor: dict[str, Any] | None = None,
    surface_geometry_type: str | None = None,
    surface_uv: tuple[float, float] | None = None,
    surface_tangent_u: tuple[float, float, float] | None = None,
) -> dict[str, Any]:
    """执行可验证的稳定面特征；曲面允许圆形、矩形和槽孔的切平面安全近似。"""
    validate_planar_feature_inputs(
        operation,
        stable_face_id,
        center,
        hit_normal,
        radius_mm=radius_mm,
        width_mm=width_mm,
        height_mm=height_mm,
        length_mm=length_mm,
        depth_mm=depth_mm,
        rotation_deg=rotation_deg,
    )
    if not isinstance(current_faces, list) or not current_faces:
        raise ValueError("目标零件没有稳定面描述，无法安全执行局部特征")

    target_face, current_descriptor = _target_pair(
        model,
        current_faces,
        stable_face_id,
        target_face_descriptor,
    )
    geometry_type = str(current_descriptor.get("geometryType", target_face.geomType()))
    requested_geometry_type = (surface_geometry_type or geometry_type).strip()
    if requested_geometry_type != geometry_type:
        raise ValueError(
            f"记录曲面类型{describe_surface_geometry_type(requested_geometry_type)}与当前 OpenCascade 面类型"
            f"{describe_surface_geometry_type(geometry_type)}不一致，需要重新选择目标面"
        )
    curved_face = geometry_type != "PLANE"
    if curved_face and operation not in (
        "add-cylinder", "cut-cylinder", "add-rectangle", "cut-rectangle", "cut-slot"
    ):
        raise ValueError(
            f"当前稳定面是{describe_surface_geometry_type(geometry_type)}；"
            "当前曲面局部特征只支持圆形凸台、圆孔、矩形凸台、矩形孔或受限槽孔"
        )
    if curved_face:
        if surface_uv is None:
            raise ValueError("曲面局部特征缺少真实 UV，请重新点击目标面")
        point, outward, exact_surface_tangent_u = _surface_frame(target_face, surface_uv)
        directional_profile = operation in ("add-rectangle", "cut-rectangle", "cut-slot")
        if directional_profile and surface_tangent_u is not None:
            requested_tangent = _unit_vector(surface_tangent_u, "记录曲面 U 切向")
            tangent_dot = float(exact_surface_tangent_u.dot(requested_tangent))
            if tangent_dot < 0.8:
                raise ValueError("记录曲面 U 切向与当前 OpenCascade 曲面方向不一致，需要重新选择目标面")
    else:
        normal_values = current_descriptor.get("normal")
        if not isinstance(normal_values, list) or len(normal_values) != 3:
            raise ValueError("当前 OpenCascade 平面缺少可校验的外法线")
        outward = _unit_vector(tuple(float(value) for value in normal_values), "OpenCascade 面外法线")
        point = cq.Vector(*center)
        exact_surface_tangent_u = None

    requested_normal = _unit_vector(hit_normal, "点击命中法线")
    normal_dot = float(outward.dot(requested_normal))
    if normal_dot < 0.8:
        raise ValueError("记录法线与当前 OpenCascade 面方向不一致，需要重新选择目标面")

    point_distance = float(point.sub(cq.Vector(*center)).Length) if curved_face else float(target_face.distance(cq.Vertex.makeVertex(*center)))
    bounds = model.val().BoundingBox()
    diagonal = math.sqrt(bounds.xlen**2 + bounds.ylen**2 + bounds.zlen**2)
    maximum_point_distance = max(0.2, min(0.75, diagonal * 0.005))
    if point_distance > maximum_point_distance:
        raise ValueError(
            f"记录中心距离当前稳定面真实 UV 点 {point_distance:.3f} 毫米，超过安全阈值 "
            f"{maximum_point_distance:.3f} 毫米，需要重新选择目标面"
        )

    curvature = {
        "maximumAbsCurvaturePerMm": None,
        "minimumCurvatureRadiusMm": None,
        "curvatureRatio": None,
    }
    local_wall_thickness: float | None = None
    remaining_wall: float | None = None
    through_cut = False
    if curved_face:
        if operation == "cut-slot":
            profile_label = "槽孔"
            footprint_radius_mm = float(length_mm) / 2.0
        elif operation in ("add-rectangle", "cut-rectangle"):
            profile_label = "矩形"
            footprint_radius_mm = math.hypot(float(width_mm), float(height_mm)) / 2.0
        else:
            profile_label = "圆形"
            footprint_radius_mm = float(radius_mm)
        curvature = _curvature_diagnostics(
            target_face, surface_uv, footprint_radius_mm, profile_label
        )
        _validate_curved_profile_footprint(
            target_face, point, outward, footprint_radius_mm, profile_label
        )
        local_wall_thickness = _local_wall_thickness(model, point, outward, diagonal)
        if local_wall_thickness is None or not math.isfinite(local_wall_thickness):
            raise ValueError("无法沿真实内法线估算当前曲面的局部壁厚，已拒绝自动修改")
        if operation in ("add-cylinder", "add-rectangle") and local_wall_thickness < 0.8:
            raise ValueError(
                f"点击位置局部壁厚约 {local_wall_thickness:.3f} 毫米，小于曲面凸台要求的 0.800 毫米"
            )
        if operation in ("cut-cylinder", "cut-rectangle", "cut-slot"):
            through_cut = depth_mm >= local_wall_thickness - 1e-6
            if not through_cut:
                remaining_wall = local_wall_thickness - depth_mm
                if remaining_wall < 1.2:
                    raise ValueError(
                        f"{profile_label}切除后预计剩余壁厚仅 {remaining_wall:.3f} 毫米，小于 1.200 毫米；请减小深度或改为通孔"
                    )

    tool = _planar_tool(
        operation,
        target_face,
        point,
        outward,
        diagonal,
        radius_mm=radius_mm,
        width_mm=width_mm,
        height_mm=height_mm,
        length_mm=length_mm,
        depth_mm=depth_mm,
        rotation_deg=rotation_deg,
        surface_x_direction=(
            exact_surface_tangent_u
            if curved_face and operation in ("add-rectangle", "cut-rectangle", "cut-slot")
            else None
        ),
    )
    interference = {
        "interferenceCheckPassed": None,
        "selfIntersectionDetected": None,
        "adjacentFaceInterferenceDetected": None,
        "interferingFaceCount": 0,
        "interferingStableFaceIds": [],
        "minimumInterferenceDistanceMm": None,
        "contactFaceCount": 0,
        "contactSampleCount": 0,
    }
    if curved_face:
        try:
            interference = _curved_profile_interference_diagnostics(
                model,
                target_face,
                current_faces,
                tool,
                point,
                outward,
                operation,
                footprint_radius_mm,
                profile_label,
                depth_mm,
                float(curvature["curvatureRatio"]),
                local_wall_thickness,
                through_cut,
            )
        except CurvedFeatureInterferenceError as error:
            error.diagnostics = {
                "pointDistanceMm": point_distance,
                "normalDot": normal_dot,
                "maximumPointDistanceMm": maximum_point_distance,
                "surfaceGeometryType": geometry_type,
                "surfaceUv": {"u": float(surface_uv[0]), "v": float(surface_uv[1])},
                "surfaceTangentU": None if exact_surface_tangent_u is None else {
                    "x": float(exact_surface_tangent_u.x),
                    "y": float(exact_surface_tangent_u.y),
                    "z": float(exact_surface_tangent_u.z),
                },
                **curvature,
                "localWallThicknessMm": local_wall_thickness,
                "remainingWallMm": remaining_wall,
                "throughCut": through_cut,
                **error.diagnostics,
            }
            raise
    adding = operation in ("add-cylinder", "add-rectangle", "offset-face-outward")
    edited = (model.union(tool, clean=True) if adding else model.cut(tool)).clean()
    operation_label = _operation_label(operation)

    source_solids = _closed_solids(model, "修改前目标 CAD 零件")
    result_solids = _closed_solids(edited, operation_label)
    if len(result_solids) != 1:
        raise ValueError(
            f"{operation_label}后产生 {len(result_solids)} 个 Solid，已拒绝结果以避免模型断裂"
        )
    volume_before = float(source_solids[0].Volume())
    volume_after = float(result_solids[0].Volume())
    volume_delta = volume_after - volume_before
    volume_tolerance = max(1e-4, volume_before * 1e-8)
    if adding and volume_delta <= volume_tolerance:
        guidance = "请重新选择平面或减小拉伸距离" if operation == "offset-face-outward" else "请缩小轮廓或重新选择平面"
        raise ValueError(f"{operation_label}没有与目标零件形成有效相交，{guidance}")
    if not adding and volume_delta >= -volume_tolerance:
        guidance = "请重新选择平面或减小内移距离" if operation == "offset-face-inward" else "请重新选择平面或增大切入深度"
        raise ValueError(f"{operation_label}没有进入目标零件，{guidance}")

    new_face_sources, face_matching = match_shape_faces_with_sources(edited, current_faces)
    new_faces = [descriptor for _, descriptor in new_face_sources]
    stable_face_status = (
        "inherited"
        if any(face.get("stableId") == stable_face_id for face in new_faces)
        else "disappeared"
    )
    return {
        "model": edited,
        "tool": tool,
        "faceSources": new_face_sources,
        "faces": new_faces,
        "faceMatching": face_matching,
        "stableFaceStatus": stable_face_status,
        "targetFace": dict(current_descriptor),
        "outwardNormal": {
            "x": float(outward.x),
            "y": float(outward.y),
            "z": float(outward.z),
        },
        "validation": {
            "valid": True,
            "watertight": True,
            "solidCount": 1,
            "pointDistanceMm": point_distance,
            "normalDot": normal_dot,
            "maximumPointDistanceMm": maximum_point_distance,
            "volumeBeforeMm3": volume_before,
            "volumeAfterMm3": volume_after,
            "volumeDeltaMm3": volume_delta,
            "surfaceGeometryType": geometry_type,
            "surfaceUv": None if surface_uv is None else {"u": float(surface_uv[0]), "v": float(surface_uv[1])},
            "surfaceTangentU": None if exact_surface_tangent_u is None else {
                "x": float(exact_surface_tangent_u.x),
                "y": float(exact_surface_tangent_u.y),
                "z": float(exact_surface_tangent_u.z),
            },
            **curvature,
            "localWallThicknessMm": local_wall_thickness,
            "remainingWallMm": remaining_wall,
            "throughCut": through_cut,
            **interference,
        },
    }


def apply_cylinder_feature(
    model: cq.Workplane,
    operation: Literal["add-cylinder", "cut-cylinder"],
    stable_face_id: str,
    current_faces: list[dict[str, Any]],
    center: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    radius_mm: float,
    depth_mm: float,
    *,
    target_face_descriptor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """兼容既有圆柱调用的执行包装。"""
    return apply_planar_feature(
        model,
        operation,
        stable_face_id,
        current_faces,
        center,
        hit_normal,
        radius_mm=radius_mm,
        width_mm=None,
        height_mm=None,
        length_mm=None,
        depth_mm=depth_mm,
        rotation_deg=0.0,
        target_face_descriptor=target_face_descriptor,
    )


def apply_edge_feature(
    model: cq.Workplane,
    current_faces: list[dict[str, Any]],
    operation: Operation,
    stable_face_id: str,
    stable_edge_id: str,
    hit_point: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    size_mm: float,
    *,
    target_face_descriptor: dict[str, Any] | None = None,
    target_edge_descriptor: dict[str, Any] | None = None,
    surface_uv: tuple[float, float] | None = None,
    manual_edge_targets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """对点击并复核后的单边、自动边链或手工无分叉边链执行圆角/倒角。"""
    manual_chain_operation = operation in (
        "fillet-edge-manual-chain", "chamfer-edge-manual-chain"
    )
    if manual_chain_operation:
        if not math.isfinite(size_mm) or not 0.2 <= size_mm <= 50.0:
            raise ValueError("圆角半径或倒角距离必须在 0.20 至 50.00 毫米之间")
        if not manual_edge_targets or not 2 <= len(manual_edge_targets) <= 64:
            raise ValueError("手工多选边链必须包含 2 至 64 条逐边精确目标")
    else:
        validate_edge_feature_inputs(
            operation, stable_face_id, stable_edge_id, hit_point, hit_normal, size_mm
        )
        if manual_edge_targets:
            raise ValueError("非手工边链操作不能携带逐边目标列表")

    bounds = model.val().BoundingBox()
    diagonal = math.sqrt(bounds.xlen ** 2 + bounds.ylen ** 2 + bounds.zlen ** 2)
    if manual_chain_operation:
        target_edges: list[cq.Edge] = []
        resolved_targets: list[dict[str, Any]] = []
        point_distances: list[float] = []
        surface_point_distances: list[float] = []
        normal_dots: list[float] = []
        maximum_distance = max(0.35, min(3.0, diagonal * 0.025))
        maximum_surface_point_distance = max(0.2, min(0.75, diagonal * 0.005))
        for index, raw_target in enumerate(manual_edge_targets or []):
            label = f"手工边链第 {index + 1} 条目标"
            if not isinstance(raw_target, dict):
                raise ValueError(f"{label}格式无效")
            face_id = str(raw_target.get("stableFaceId", "")).strip()
            edge_id = str(raw_target.get("stableEdgeId", "")).strip()
            center_value = raw_target.get("center")
            normal_value = raw_target.get("hitNormal")
            uv_value = raw_target.get("surfaceUv")
            if not isinstance(center_value, dict) or not isinstance(normal_value, dict) or not isinstance(uv_value, dict):
                raise ValueError(f"{label}缺少点击坐标、法线或真实 UV")
            center = tuple(float(center_value[key]) for key in ("xMm", "yMm", "zMm"))
            normal = tuple(float(normal_value[key]) for key in ("x", "y", "z"))
            uv = (float(uv_value["u"]), float(uv_value["v"]))
            validate_edge_feature_inputs(operation, face_id, edge_id, center, normal, size_mm)
            face_snapshot = raw_target.get("targetFace")
            edge_snapshot = raw_target.get("targetEdge")
            if face_snapshot is not None and not isinstance(face_snapshot, dict):
                raise ValueError(f"{label}的稳定面签名快照无效")
            if edge_snapshot is not None and not isinstance(edge_snapshot, dict):
                raise ValueError(f"{label}的稳定边签名快照无效")
            target_face, face_descriptor = _target_pair(
                model, current_faces, face_id, face_snapshot
            )
            geometry_type = str(face_descriptor.get("geometryType", ""))
            requested_type = str(raw_target.get("surfaceGeometryType", geometry_type)).strip()
            if requested_type != geometry_type:
                raise ValueError(f"{label}的曲面类型与当前稳定面不一致")
            if edge_snapshot is not None and edge_snapshot.get("stableId") != edge_id:
                raise ValueError(f"{label}的稳定边 ID 与几何签名快照不一致")
            edge_descriptor = _edge_descriptor(face_descriptor, edge_id)
            target_edge = _target_edge(target_face, edge_descriptor, diagonal)
            if edge_snapshot is not None:
                snapshot_edge = _target_edge(target_face, edge_snapshot, diagonal)
                if not snapshot_edge.isSame(target_edge):
                    raise ValueError(f"{label}的稳定边几何签名快照与当前目标不一致")
            if any(candidate.isSame(target_edge) for candidate in target_edges):
                raise ValueError("手工多选边链包含重复物理边")
            point_distance = float(target_edge.distance(cq.Vertex.makeVertex(*center)))
            if point_distance > maximum_distance:
                raise ValueError(
                    f"{label}点击位置距离目标边 {point_distance:.3f} 毫米，超过允许的 {maximum_distance:.3f} 毫米"
                )
            supplied = _unit_vector(normal, f"{label}点击命中法线")
            surface_point_distance = 0.0
            if geometry_type != "PLANE":
                if not all(math.isfinite(value) for value in uv):
                    raise ValueError(f"{label}缺少有限的真实 UV")
                surface_point, outward, _ = _surface_frame(target_face, uv)
                surface_point_distance = float(surface_point.sub(cq.Vector(*center)).Length)
                if surface_point_distance > maximum_surface_point_distance:
                    raise ValueError(
                        f"{label}点击点距离真实 UV 点 {surface_point_distance:.3f} 毫米，超过安全阈值 {maximum_surface_point_distance:.3f} 毫米"
                    )
            else:
                normal_values = face_descriptor.get("normal")
                if not isinstance(normal_values, list) or len(normal_values) != 3:
                    normal_values = list(target_face.normalAt().toTuple())
                outward = _unit_vector(tuple(float(value) for value in normal_values), f"{label}目标面外法线")
            normal_dot = float(outward.dot(supplied))
            if normal_dot < 0.75:
                raise ValueError(f"{label}点击法线与目标面的真实外法线不一致")
            target_edges.append(target_edge)
            point_distances.append(point_distance)
            surface_point_distances.append(surface_point_distance)
            normal_dots.append(normal_dot)
            resolved_targets.append({
                **raw_target,
                "targetFace": face_descriptor,
                "targetEdge": edge_descriptor,
                "outwardNormal": {"x": float(outward.x), "y": float(outward.y), "z": float(outward.z)},
            })

        vertex_tolerance = max(1e-6, min(0.05, diagonal * 1e-5))
        vertices: list[cq.Vector] = []
        edge_vertices: list[tuple[int, int]] = []
        def vertex_index(point: cq.Vector) -> int:
            for candidate_index, candidate in enumerate(vertices):
                if _point_distance(point, candidate) <= vertex_tolerance:
                    return candidate_index
            vertices.append(point)
            return len(vertices) - 1
        for edge in target_edges:
            edge_vertices.append((vertex_index(edge.startPoint()), vertex_index(edge.endPoint())))
        degrees = [0 for _ in vertices]
        incident: list[list[int]] = [[] for _ in vertices]
        for edge_index, (start_index, end_index) in enumerate(edge_vertices):
            degrees[start_index] += 1
            degrees[end_index] += 1
            incident[start_index].append(edge_index)
            incident[end_index].append(edge_index)
        if any(degree > 2 for degree in degrees):
            raise ValueError("手工多选边链存在分叉顶点，当前第一版只支持无分叉链")
        visited = {0}
        pending = [0]
        while pending:
            current = pending.pop()
            for vertex in edge_vertices[current]:
                for neighbor in incident[vertex]:
                    if neighbor not in visited:
                        visited.add(neighbor)
                        pending.append(neighbor)
        if len(visited) != len(target_edges):
            raise ValueError("手工多选边链不连续，请只选择一条连通的开放链或闭合链")
        endpoint_count = sum(1 for degree in degrees if degree == 1)
        if endpoint_count not in (0, 2) or any(degree not in (1, 2) for degree in degrees):
            raise ValueError("手工多选边链拓扑无效，只允许一条开放链或闭合链")

        volume_before = float(model.val().Volume())
        try:
            stack = cq.Workplane(obj=model.val()).newObject(target_edges)
            edited = stack.fillet(size_mm) if operation == "fillet-edge-manual-chain" else stack.chamfer(size_mm)
        except Exception as error:
            label = "圆角" if operation == "fillet-edge-manual-chain" else "倒角"
            raise ValueError(f"OpenCascade 无法对手工边链执行{label}：{error}") from error
        solids = _closed_solids(edited, "手工多选边链特征结果")
        if len(solids) != 1 or not edited.val().isValid():
            raise ValueError("手工边链特征结果不是有效、封闭且唯一的 Solid")
        volume_after = float(edited.val().Volume())
        if abs(volume_after - volume_before) <= max(volume_before * 1e-8, 1e-6):
            raise ValueError("手工边链特征没有产生可验证的实体体积变化")
        updated_sources, matching = match_shape_faces_with_sources(edited, current_faces)
        updated_faces = [descriptor for _, descriptor in updated_sources]
        inherited_face = next((value for value in updated_faces if value.get("stableId") == stable_face_id), None)
        first = resolved_targets[0]
        return {
            "model": edited,
            "faceSources": updated_sources,
            "faces": updated_faces,
            "faceMatching": matching,
            "targetFace": first["targetFace"],
            "targetEdge": first["targetEdge"],
            "targetEdges": resolved_targets,
            "stableFaceStatus": "inherited" if inherited_face is not None else "disappeared",
            "stableEdgeStatus": "disappeared",
            "outwardNormal": first["outwardNormal"],
            "validation": {
                "valid": True, "watertight": True, "solidCount": 1,
                "pointDistanceMm": max(point_distances),
                "maximumPointDistanceMm": maximum_distance,
                "affectedEdgeCount": len(target_edges), "edgeScope": "manual-chain",
                "surfacePointDistanceMm": max(surface_point_distances),
                "maximumSurfacePointDistanceMm": maximum_surface_point_distance,
                "surfaceGeometryType": str(first.get("surfaceGeometryType", "")),
                "surfaceUv": first.get("surfaceUv"),
                "normalDot": min(normal_dots),
                "volumeBeforeMm3": volume_before, "volumeAfterMm3": volume_after,
                "volumeDeltaMm3": volume_after - volume_before,
            },
        }

    target_face, face_descriptor = _target_pair(
        model, current_faces, stable_face_id, target_face_descriptor
    )
    surface_geometry_type = str(face_descriptor.get("geometryType", ""))
    curved_owner_face = surface_geometry_type != "PLANE"
    loop_operation = operation in ("fillet-edge-loop", "chamfer-edge-loop")
    chain_operation = operation in ("fillet-edge-chain", "chamfer-edge-chain")
    if loop_operation and curved_owner_face:
        raise ValueError("整圈边圆角或倒角第一版只支持平面边界，请重新选择平面所属边")
    if curved_owner_face and (
        surface_uv is None
        or len(surface_uv) != 2
        or not all(math.isfinite(value) for value in surface_uv)
    ):
        raise ValueError("曲面所属稳定边缺少真实 UV，请重新点击目标边")
    if target_edge_descriptor is not None:
        if target_edge_descriptor.get("stableId") != stable_edge_id:
            raise ValueError("局部特征记录中的稳定边 ID 与边签名快照不一致")
        edge_descriptor = target_edge_descriptor
    else:
        edge_descriptor = _edge_descriptor(face_descriptor, stable_edge_id)

    target_edge = _target_edge(target_face, edge_descriptor, diagonal)
    target_edges = [target_edge]
    if loop_operation:
        matching_wires = [
            wire for wire in target_face.Wires()
            if any(candidate.isSame(target_edge) for candidate in wire.Edges())
        ]
        if len(matching_wires) != 1:
            raise ValueError("无法从所选种子边唯一定位平面边界整圈，请重新选择目标边")
        target_edges = [edge for edge in matching_wires[0].Edges() if float(edge.Length()) > 1e-6]
        if len(target_edges) < 2:
            raise ValueError("所选平面边界不足两条有效边，不能执行整圈圆角或倒角")
        if len(target_edges) > 64:
            raise ValueError("所选平面边界超过 64 条边，已拒绝整圈圆角或倒角")
    elif chain_operation:
        target_edges = _tangent_chain_edges(model, target_edge, diagonal)
    point_distance = float(target_edge.distance(cq.Vertex.makeVertex(*hit_point)))
    maximum_distance = max(0.35, min(3.0, diagonal * 0.025))
    if point_distance > maximum_distance:
        raise ValueError(
            f"点击位置距离目标边 {point_distance:.3f} 毫米，超过允许的 {maximum_distance:.3f} 毫米，请放大后重新点击边线"
        )

    surface_point_distance = 0.0
    maximum_surface_point_distance = max(0.2, min(0.75, diagonal * 0.005))
    if curved_owner_face:
        try:
            surface_point, outward, _ = _surface_frame(target_face, surface_uv)  # type: ignore[arg-type]
        except Exception as error:
            raise ValueError(f"无法在真实 UV 位置复核目标边所属曲面：{error}") from error
        surface_point_distance = float(surface_point.sub(cq.Vector(*hit_point)).Length)
        if surface_point_distance > maximum_surface_point_distance:
            raise ValueError(
                f"记录点击点距离目标边所属曲面的真实 UV 点 {surface_point_distance:.3f} 毫米，"
                f"超过安全阈值 {maximum_surface_point_distance:.3f} 毫米，请重新选择目标边"
            )
    else:
        normal_values = face_descriptor.get("normal")
        if not isinstance(normal_values, list) or len(normal_values) != 3:
            try:
                normal_values = list(target_face.normalAt().toTuple())
            except Exception as error:
                raise ValueError(f"目标边所属面缺少可校验的外法线：{error}") from error
        outward = _unit_vector(tuple(float(value) for value in normal_values), "目标面外法线")
    supplied = _unit_vector(hit_normal, "CAD 边点击命中法线")
    normal_dot = float(outward.dot(supplied))
    if normal_dot < 0.75:
        raise ValueError("点击命中法线与目标边所属面的真实外法线不一致，请重新选择目标边")

    volume_before = float(model.val().Volume())
    try:
        stack = cq.Workplane(obj=model.val()).newObject(target_edges)
        edited = stack.fillet(size_mm) if operation in ("fillet-edge", "fillet-edge-loop", "fillet-edge-chain") else stack.chamfer(size_mm)
    except Exception as error:
        label = "圆角" if operation in ("fillet-edge", "fillet-edge-loop", "fillet-edge-chain") else "倒角"
        raise ValueError(f"OpenCascade 无法对目标边执行{label}：{error}") from error
    solids = _closed_solids(edited, "稳定 CAD 边特征结果")
    if len(solids) != 1 or not edited.val().isValid():
        raise ValueError("边特征结果不是有效、封闭且唯一的 Solid，已拒绝本次修改")
    volume_after = float(edited.val().Volume())
    tolerance = max(volume_before * 1e-8, 1e-6)
    if abs(volume_after - volume_before) <= tolerance:
        raise ValueError("边特征没有产生可验证的实体体积变化，请减小尺寸或选择其他边")

    updated_sources, matching = match_shape_faces_with_sources(edited, current_faces)
    updated_faces = [descriptor for _, descriptor in updated_sources]
    inherited_face = next(
        (descriptor for descriptor in updated_faces if descriptor.get("stableId") == stable_face_id),
        None,
    )
    stable_edge_status = "disappeared"
    if inherited_face is not None:
        inherited_edges = inherited_face.get("edges")
        if isinstance(inherited_edges, list) and any(
            isinstance(value, dict) and value.get("stableId") == stable_edge_id
            for value in inherited_edges
        ):
            stable_edge_status = "inherited"
    return {
        "model": edited,
        "faceSources": updated_sources,
        "faces": updated_faces,
        "faceMatching": matching,
        "targetFace": face_descriptor,
        "targetEdge": edge_descriptor,
        "stableFaceStatus": "inherited" if inherited_face is not None else "disappeared",
        "stableEdgeStatus": stable_edge_status,
        "outwardNormal": {
            "x": float(outward.x), "y": float(outward.y), "z": float(outward.z)
        },
        "validation": {
            "valid": True,
            "watertight": True,
            "solidCount": 1,
            "pointDistanceMm": point_distance,
            "maximumPointDistanceMm": maximum_distance,
            "affectedEdgeCount": len(target_edges),
            "edgeScope": "loop" if loop_operation else "tangent-chain" if chain_operation else "single",
            "surfacePointDistanceMm": surface_point_distance,
            "maximumSurfacePointDistanceMm": maximum_surface_point_distance,
            "surfaceGeometryType": surface_geometry_type,
            "surfaceUv": None if surface_uv is None else {"u": surface_uv[0], "v": surface_uv[1]},
            "normalDot": normal_dot,
            "volumeBeforeMm3": volume_before,
            "volumeAfterMm3": volume_after,
            "volumeDeltaMm3": volume_after - volume_before,
        },
    }
