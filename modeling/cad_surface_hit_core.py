"""OpenCascade 稳定面点击解析核心。

本模块只处理内存中的 CadQuery/OpenCascade 实体：复用稳定面几何签名重新定位，
把 STL 选择网格命中点投影到真实裁剪面，返回 UV、真实外法线和距离复核结果。
稳定面 ID 仍属于“几何签名匹配第一版”，不是永久拓扑命名。
"""

from __future__ import annotations

import math
from typing import Any

import cadquery as cq
from OCP.BRep import BRep_Tool
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepGProp import BRepGProp_Face
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.TopAbs import TopAbs_IN, TopAbs_ON
from OCP.gp import gp_Pnt, gp_Pnt2d, gp_Vec

from local_cad_feature_core import resolve_stable_face_pair

_EPSILON = 1e-12


def _finite_point(values: tuple[float, float, float], label: str) -> tuple[float, float, float]:
    if len(values) != 3 or not all(math.isfinite(value) for value in values):
        raise ValueError(f"{label}必须是三个有限毫米数值")
    return tuple(float(value) for value in values)


def _unit_vector(values: tuple[float, float, float], label: str) -> tuple[float, float, float]:
    vector = _finite_point(values, label)
    length = math.sqrt(sum(value * value for value in vector))
    if length < 0.5:
        raise ValueError(f"{label}无效，请重新点击目标面")
    return tuple(value / length for value in vector)


def _rounded(value: float, digits: int = 9) -> float:
    rounded = round(float(value), digits)
    return 0.0 if abs(rounded) < 10 ** (-digits) else rounded


def _surface_normal(face: cq.Face, u: float, v: float) -> tuple[float, float, float]:
    point = gp_Pnt()
    normal = gp_Vec()
    BRepGProp_Face(face.wrapped).Normal(u, v, point, normal)
    length = float(normal.Magnitude())
    if not math.isfinite(length) or length <= _EPSILON:
        raise ValueError("OpenCascade 无法在当前 UV 位置计算稳定外法线，请重新点击目标面")
    return (
        float(normal.X()) / length,
        float(normal.Y()) / length,
        float(normal.Z()) / length,
    )


def resolve_surface_hit(
    model: cq.Workplane | cq.Shape,
    current_faces: list[dict[str, Any]],
    stable_face_id: str,
    hit_point: tuple[float, float, float],
    mesh_normal: tuple[float, float, float],
    *,
    target_face_descriptor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """将选择网格命中解析为真实裁剪面上的 UV、投影点和外法线。"""
    if not stable_face_id.strip():
        raise ValueError("曲面点击缺少稳定面 ID，请重新点击目标面")
    point_values = _finite_point(hit_point, "曲面点击坐标")
    mesh_normal_values = _unit_vector(mesh_normal, "选择网格命中法线")
    target_face, descriptor = resolve_stable_face_pair(
        model,
        current_faces,
        stable_face_id,
        target_face_descriptor,
    )

    u_min, u_max, v_min, v_max = (float(value) for value in target_face.uvBounds())
    if not all(math.isfinite(value) for value in (u_min, u_max, v_min, v_max)):
        raise ValueError("目标稳定面的 UV 范围不是有限值，当前版本无法安全解析")
    if u_max < u_min or v_max < v_min:
        raise ValueError("目标稳定面的 UV 范围无效，请重新生成 CAD")

    surface = BRep_Tool.Surface_s(target_face.wrapped)
    source_point = gp_Pnt(*point_values)
    bounded_projection = GeomAPI_ProjectPointOnSurf(
        source_point,
        surface,
        u_min,
        u_max,
        v_min,
        v_max,
        1e-9,
    )
    projections = [bounded_projection]
    if bounded_projection.NbPoints() <= 0:
        # 平面裁剪框外等情况可能没有受限参数域极值；再投影到底层曲面，
        # 仅用于区分“曲面不可投影”和“投影落在裁剪面外”，不会接受越界结果。
        projections.append(GeomAPI_ProjectPointOnSurf(source_point, surface, 1e-9))

    classifier_tolerance = max(float(BRep_Tool.Tolerance_s(target_face.wrapped)) * 10.0, 1e-7)
    valid_projections: list[tuple[float, float, float, gp_Pnt, str]] = []
    projection_count = 0
    for projection in projections:
        projection_count += projection.NbPoints()
        for index in range(1, projection.NbPoints() + 1):
            u, v = (float(value) for value in projection.Parameters(index))
            if not all(math.isfinite(value) for value in (u, v)):
                continue
            projected = projection.Point(index)
            classifier = BRepClass_FaceClassifier(
                target_face.wrapped,
                gp_Pnt2d(u, v),
                classifier_tolerance,
                True,
            )
            state = classifier.State()
            if state not in (TopAbs_IN, TopAbs_ON):
                continue
            distance = float(source_point.Distance(projected))
            valid_projections.append(
                (distance, u, v, projected, "inside" if state == TopAbs_IN else "on-boundary")
            )

    if not valid_projections:
        if projection_count <= 0:
            raise ValueError("OpenCascade 无法把点击位置投影到目标稳定面，请重新点击")
        raise ValueError(
            "点击位置只能投影到底层无限曲面，但投影点不在当前裁剪面内，请在可见面内部重新点击"
        )

    point_distance, u, v, projected, trimmed_face_state = min(
        valid_projections,
        key=lambda value: value[0],
    )
    shape = model.val() if isinstance(model, cq.Workplane) else model
    bounds = shape.BoundingBox()
    diagonal = math.sqrt(bounds.xlen ** 2 + bounds.ylen ** 2 + bounds.zlen ** 2)
    maximum_point_distance = max(0.2, min(0.75, diagonal * 0.005))
    if point_distance > maximum_point_distance:
        raise ValueError(
            f"选择网格点击位置距离真实稳定面 {point_distance:.3f} 毫米，超过安全阈值 "
            f"{maximum_point_distance:.3f} 毫米，请重新生成选择网格或重新点击"
        )

    outward_normal = _surface_normal(target_face, u, v)
    normal_dot = sum(
        exact * mesh
        for exact, mesh in zip(outward_normal, mesh_normal_values, strict=True)
    )
    if normal_dot < 0.5:
        raise ValueError(
            f"选择网格法线与 OpenCascade 真实外法线不一致（点积 {normal_dot:.3f}），请重新点击目标面"
        )

    geometry_type = str(descriptor.get("geometryType", target_face.geomType()))
    return {
        "geometryType": geometry_type,
        "projectedPointMm": {
            "x": _rounded(projected.X()),
            "y": _rounded(projected.Y()),
            "z": _rounded(projected.Z()),
        },
        "pointDistanceMm": _rounded(point_distance),
        "maximumPointDistanceMm": _rounded(maximum_point_distance),
        "surfaceUv": {"u": _rounded(u, 12), "v": _rounded(v, 12)},
        "uvBounds": {
            "uMin": _rounded(u_min, 12),
            "uMax": _rounded(u_max, 12),
            "vMin": _rounded(v_min, 12),
            "vMax": _rounded(v_max, 12),
        },
        "outwardNormal": {
            "x": _rounded(outward_normal[0], 12),
            "y": _rounded(outward_normal[1], 12),
            "z": _rounded(outward_normal[2], 12),
        },
        "normalDot": _rounded(normal_dot),
        "trimmedFaceState": trimmed_face_state,
    }
