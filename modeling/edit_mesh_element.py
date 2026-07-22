#!/usr/bin/env python3
"""对任意受管单 Solid 网格执行可回滚的集合变换或连续共面区域法向编辑。"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from time import time_ns
from typing import Literal

import cadquery as cq
from cadquery import exporters
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.TopAbs import TopAbs_IN, TopAbs_OUT
from OCP.gp import gp_Pnt, gp_Vec

from export_transformed_model import read_stl, write_binary_stl
from local_stl_edit import _commit_files_with_rollback, _existing_output_names, _load_import_manifest
from split_and_cap import _bounds_json, _closed_solids, import_stl_as_solid

ElementKind = Literal["vertex", "edge", "face"]
SelectionMethod = Literal["click", "box"]
TransformOperation = Literal["move", "rotate", "scale"]
FaceExtrusionMode = Literal["add", "cut"]
TransformAxis = Literal["x", "y", "z"]
EDGE_VERTEX_INDEXES = ((0, 1), (1, 2), (2, 0))
MAX_DISPLACEMENT_MM = 500.0
MAX_ROTATION_DEGREES = 180.0
MIN_SCALE_FACTOR = 0.25
MAX_SCALE_FACTOR = 4.0
MIN_FACE_EXTRUSION_MM = 0.2
MAX_FACE_EXTRUSION_MM = 100.0
MAX_PLANAR_REGION_TRIANGLES = 20_000
MAX_PLANAR_REGION_AREA_MM2 = 200_000.0
PLANAR_REGION_NORMAL_TOLERANCE_DEGREES = 0.5
MAX_SELECTIONS = 512
MAX_TRIANGLE_INDEX = 5_000_000
MAX_COORDINATE_MM = 1_000_000.0
COORDINATE_DIGITS = 6
MIN_DOUBLE_AREA = 1e-9


def _coordinate_key(point: tuple[float, float, float]) -> tuple[float, float, float]:
    """用微米级量化键识别 STL 三角面中重复存储的同一拓扑顶点。"""

    return tuple(round(float(value), COORDINATE_DIGITS) for value in point)  # type: ignore[return-value]


def _double_area(triangle: tuple[tuple[float, float, float], ...]) -> float:
    a, b, c = triangle
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cross = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    return math.sqrt(sum(value * value for value in cross))


def _selected_vertex_indexes(kind: ElementKind, element_index: int) -> tuple[int, ...]:
    if kind == "vertex" and 0 <= element_index <= 2:
        return (element_index,)
    if kind == "edge" and 0 <= element_index <= 2:
        return EDGE_VERTEX_INDEXES[element_index]
    if kind == "face" and element_index == 0:
        return (0, 1, 2)
    raise ValueError("网格元素索引与编辑类型不匹配，请重新选择")


def _parse_triangle_mm(value: object) -> tuple[tuple[float, float, float], ...]:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError("网格元素源三角面坐标无效，请重新选择")
    triangle: list[tuple[float, float, float]] = []
    for point in value:
        if not isinstance(point, dict) or set(point) != {"x", "y", "z"}:
            raise ValueError("网格元素源坐标格式无效，请重新选择")
        coordinates = (point["x"], point["y"], point["z"])
        if any(not isinstance(item, (int, float)) or isinstance(item, bool) for item in coordinates):
            raise ValueError("网格元素源坐标必须是有限毫米数值")
        parsed = tuple(float(item) for item in coordinates)
        if any(not math.isfinite(item) or abs(item) > MAX_COORDINATE_MM for item in parsed):
            raise ValueError("网格元素源坐标超出安全范围")
        triangle.append(parsed)  # type: ignore[arg-type]
    return tuple(triangle)


def _selection_key(
    kind: ElementKind,
    triangle_index: int,
    element_index: int,
    triangle: tuple[tuple[float, float, float], ...],
) -> tuple[object, ...]:
    if kind == "vertex":
        return (kind, _coordinate_key(triangle[element_index]))
    if kind == "edge":
        start, end = EDGE_VERTEX_INDEXES[element_index]
        return (kind, *sorted((_coordinate_key(triangle[start]), _coordinate_key(triangle[end]))))
    return (kind, triangle_index)


def _validate_and_collect_selections(
    triangles: list[tuple[tuple[float, float, float], ...]],
    kind: ElementKind,
    selections: list[dict[str, object]],
) -> tuple[list[dict[str, object]], set[tuple[float, float, float]]]:
    if not selections:
        raise ValueError("请至少选择一个要变换的网格元素")
    if len(selections) > MAX_SELECTIONS:
        raise ValueError(f"单次最多选择 {MAX_SELECTIONS} 个同类网格元素")

    unique: dict[tuple[object, ...], dict[str, object]] = {}
    selected_keys: set[tuple[float, float, float]] = set()
    for selection in selections:
        if not isinstance(selection, dict) or set(selection) != {"triangleIndex", "elementIndex", "triangleMm"}:
            raise ValueError("网格元素选择数据包含不允许的字段")
        triangle_index = selection.get("triangleIndex")
        element_index = selection.get("elementIndex")
        if not isinstance(triangle_index, int) or isinstance(triangle_index, bool) or not 0 <= triangle_index <= MAX_TRIANGLE_INDEX:
            raise ValueError("三角面索引无效，请重新选择")
        if triangle_index >= len(triangles):
            raise ValueError("选中的三角面已不存在，请重新选择")
        if not isinstance(element_index, int) or isinstance(element_index, bool):
            raise ValueError("网格元素索引无效，请重新选择")
        selected_indexes = _selected_vertex_indexes(kind, element_index)
        supplied_triangle = _parse_triangle_mm(selection.get("triangleMm"))
        current_triangle = triangles[triangle_index]
        if tuple(_coordinate_key(point) for point in supplied_triangle) != tuple(
            _coordinate_key(point) for point in current_triangle
        ):
            raise ValueError("网格元素源坐标与当前模型不一致，请重新选择")
        key = _selection_key(kind, triangle_index, element_index, current_triangle)
        if key in unique:
            continue
        unique[key] = selection
        selected_keys.update(_coordinate_key(current_triangle[index]) for index in selected_indexes)
    return list(unique.values()), selected_keys


def _selection_pivot(selected_keys: set[tuple[float, float, float]]) -> tuple[float, float, float]:
    """使用选择集合唯一源坐标的几何中心作为旋转和缩放枢轴。"""

    if not selected_keys:
        raise ValueError("当前选择没有可变换的源坐标")
    count = len(selected_keys)
    return tuple(sum(point[index] for point in selected_keys) / count for index in range(3))  # type: ignore[return-value]


def _transform_point(
    point: tuple[float, float, float],
    operation: TransformOperation,
    pivot: tuple[float, float, float],
    displacement_mm: tuple[float, float, float],
    rotation_axis: TransformAxis,
    rotation_degrees: float,
    scale_factor: float,
) -> tuple[float, float, float]:
    if operation == "move":
        return tuple(point[index] + displacement_mm[index] for index in range(3))  # type: ignore[return-value]
    relative = tuple(point[index] - pivot[index] for index in range(3))
    if operation == "scale":
        return tuple(pivot[index] + relative[index] * scale_factor for index in range(3))  # type: ignore[return-value]
    angle = math.radians(rotation_degrees)
    cosine, sine = math.cos(angle), math.sin(angle)
    x, y, z = relative
    rotated = (
        (x, y * cosine - z * sine, y * sine + z * cosine)
        if rotation_axis == "x"
        else (x * cosine + z * sine, y, -x * sine + z * cosine)
        if rotation_axis == "y"
        else (x * cosine - y * sine, x * sine + y * cosine, z)
    )
    return tuple(pivot[index] + rotated[index] for index in range(3))  # type: ignore[return-value]



def _triangle_centroid(triangle: tuple[tuple[float, float, float], ...]) -> tuple[float, float, float]:
    """计算源三角面的毫米坐标重心。"""

    return tuple(sum(point[index] for point in triangle) / 3.0 for index in range(3))  # type: ignore[return-value]


def _triangle_unit_normal(triangle: tuple[tuple[float, float, float], ...]) -> tuple[float, float, float]:
    """根据源三角面几何计算单位法线，不信任 STL 文件中的法线字段。"""

    a, b, c = triangle
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cross = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    length = math.sqrt(sum(value * value for value in cross))
    if length <= MIN_DOUBLE_AREA:
        raise ValueError("选中的三角面面积过小或已退化，无法沿法向编辑")
    return tuple(value / length for value in cross)  # type: ignore[return-value]


def _point_state(solid: cq.Solid, point: tuple[float, float, float], tolerance: float = 1e-7):
    """使用 OpenCascade 实体分类器判断探针点位于实体内部还是外部。"""

    return BRepClass3d_SolidClassifier(solid.wrapped, gp_Pnt(*point), tolerance).State()


def _resolve_outward_normal(
    solid: cq.Solid,
    triangle: tuple[tuple[float, float, float], ...],
    diagonal_mm: float,
) -> tuple[float, float, float]:
    """通过三角面重心两侧的实体内外分类，确认真实外法线方向。"""

    centroid = _triangle_centroid(triangle)
    candidate = _triangle_unit_normal(triangle)
    base_probe = max(0.005, min(0.05, diagonal_mm * 1e-4))
    for multiplier in (1.0, 2.0, 5.0, 10.0):
        probe = base_probe * multiplier
        positive = tuple(centroid[index] + candidate[index] * probe for index in range(3))
        negative = tuple(centroid[index] - candidate[index] * probe for index in range(3))
        positive_state = _point_state(solid, positive)
        negative_state = _point_state(solid, negative)
        if positive_state == TopAbs_OUT and negative_state == TopAbs_IN:
            return candidate
        if positive_state == TopAbs_IN and negative_state == TopAbs_OUT:
            return tuple(-value for value in candidate)  # type: ignore[return-value]
    raise ValueError("无法确认选中三角面的实体内外方向，请选择远离薄壁、尖角或自交区域的三角面")


def _triangle_area(triangle: tuple[tuple[float, float, float], ...]) -> float:
    """返回三角面的平方毫米面积。"""

    return _double_area(triangle) / 2.0


def _edge_key(
    start: tuple[float, float, float],
    end: tuple[float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """生成与方向无关的共享边量化键。"""

    return tuple(sorted((_coordinate_key(start), _coordinate_key(end))))  # type: ignore[return-value]


def _expand_coplanar_region(
    triangles: list[tuple[tuple[float, float, float], ...]],
    seed_index: int,
    diagonal_mm: float,
) -> tuple[list[int], float, float]:
    """沿共享无向边扩展与种子三角面连续且共面的平面区域。"""

    seed = triangles[seed_index]
    seed_normal = _triangle_unit_normal(seed)
    seed_origin = seed[0]
    cosine_limit = math.cos(math.radians(PLANAR_REGION_NORMAL_TOLERANCE_DEGREES))
    plane_tolerance_mm = max(1e-5, min(0.02, diagonal_mm * 1e-6))
    edge_owners: dict[tuple[tuple[float, float, float], tuple[float, float, float]], list[int]] = {}
    for triangle_index, triangle in enumerate(triangles):
        for start_index, end_index in EDGE_VERTEX_INDEXES:
            edge_owners.setdefault(_edge_key(triangle[start_index], triangle[end_index]), []).append(triangle_index)

    def is_coplanar(triangle_index: int) -> bool:
        triangle = triangles[triangle_index]
        normal = _triangle_unit_normal(triangle)
        if abs(sum(normal[index] * seed_normal[index] for index in range(3))) < cosine_limit:
            return False
        return all(
            abs(sum((point[index] - seed_origin[index]) * seed_normal[index] for index in range(3))) <= plane_tolerance_mm
            for point in triangle
        )

    region = {seed_index}
    pending = [seed_index]
    area_mm2 = _triangle_area(seed)
    if MAX_PLANAR_REGION_TRIANGLES < 1:
        raise ValueError(f"连续共面区域超过 {MAX_PLANAR_REGION_TRIANGLES} 个三角面上限，请先简化网格或缩小平面区域")
    if area_mm2 > MAX_PLANAR_REGION_AREA_MM2:
        raise ValueError(f"连续共面区域面积超过 {MAX_PLANAR_REGION_AREA_MM2:.0f} 平方毫米上限，请先拆分模型")
    while pending:
        current = pending.pop()
        triangle = triangles[current]
        for start_index, end_index in EDGE_VERTEX_INDEXES:
            owners = edge_owners[_edge_key(triangle[start_index], triangle[end_index])]
            if len(owners) > 2:
                raise ValueError("共面区域扩展遇到非流形共享边，已拒绝自动猜测拓扑")
            for neighbor in owners:
                if neighbor in region or not is_coplanar(neighbor):
                    continue
                next_area = area_mm2 + _triangle_area(triangles[neighbor])
                if len(region) + 1 > MAX_PLANAR_REGION_TRIANGLES:
                    raise ValueError(f"连续共面区域超过 {MAX_PLANAR_REGION_TRIANGLES} 个三角面上限，请先简化网格或缩小平面区域")
                if next_area > MAX_PLANAR_REGION_AREA_MM2:
                    raise ValueError(f"连续共面区域面积超过 {MAX_PLANAR_REGION_AREA_MM2:.0f} 平方毫米上限，请先拆分模型")
                region.add(neighbor)
                pending.append(neighbor)
                area_mm2 = next_area
    return sorted(region), area_mm2, plane_tolerance_mm


def _boundary_loops(
    triangles: list[tuple[tuple[float, float, float], ...]],
    region_indexes: list[int],
) -> list[list[tuple[float, float, float]]]:
    """提取连续平面三角面区域的闭合外边界和孔洞边界。"""

    edge_counts: dict[tuple[tuple[float, float, float], tuple[float, float, float]], int] = {}
    points_by_key: dict[tuple[float, float, float], tuple[float, float, float]] = {}
    for triangle_index in region_indexes:
        triangle = triangles[triangle_index]
        for point in triangle:
            points_by_key.setdefault(_coordinate_key(point), point)
        for start_index, end_index in EDGE_VERTEX_INDEXES:
            key = _edge_key(triangle[start_index], triangle[end_index])
            edge_counts[key] = edge_counts.get(key, 0) + 1
    if any(count > 2 for count in edge_counts.values()):
        raise ValueError("连续共面区域包含非流形共享边，无法构造单一封闭工具体")
    boundary_edges = {edge for edge, count in edge_counts.items() if count == 1}
    if not boundary_edges:
        raise ValueError("连续共面区域没有可识别的闭合边界")

    adjacency: dict[tuple[float, float, float], list[tuple[float, float, float]]] = {}
    for start, end in boundary_edges:
        adjacency.setdefault(start, []).append(end)
        adjacency.setdefault(end, []).append(start)
    if any(len(neighbors) != 2 for neighbors in adjacency.values()):
        raise ValueError("连续共面区域边界存在分叉或开口，无法构造单一封闭工具体")

    unused = set(boundary_edges)
    loops: list[list[tuple[float, float, float]]] = []
    while unused:
        start, first = next(iter(unused))
        keys = [start]
        current = first
        unused.remove(_edge_key(start, current))
        while current != start:
            keys.append(current)
            candidates = [neighbor for neighbor in adjacency[current] if _edge_key(current, neighbor) in unused]
            if not candidates:
                raise ValueError("连续共面区域边界未闭合，无法构造法向工具体")
            following = candidates[0]
            unused.remove(_edge_key(current, following))
            current = following
            if len(keys) > len(boundary_edges) + 1:
                raise ValueError("连续共面区域边界遍历异常，已停止建模")
        if len(keys) < 3:
            raise ValueError("连续共面区域边界退化，无法构造法向工具体")
        loops.append([points_by_key[key] for key in keys])
    return loops


def _projected_loop_area(
    loop: list[tuple[float, float, float]],
    normal: tuple[float, float, float],
) -> float:
    """按主法线轴计算边界环投影面积，用于识别外环和孔洞。"""

    drop_axis = max(range(3), key=lambda index: abs(normal[index]))
    axes = [index for index in range(3) if index != drop_axis]
    return abs(sum(
        loop[index][axes[0]] * loop[(index + 1) % len(loop)][axes[1]]
        - loop[(index + 1) % len(loop)][axes[0]] * loop[index][axes[1]]
        for index in range(len(loop))
    )) / 2.0


def _planar_region_prism(
    loops: list[list[tuple[float, float, float]]],
    outward: tuple[float, float, float],
    start_offset: tuple[float, float, float],
    extrusion_vector: tuple[float, float, float],
) -> cq.Solid:
    """把平面区域边界一次拉伸为单一闭合工具体，避免重叠三角柱。"""

    ordered = sorted(loops, key=lambda loop: _projected_loop_area(loop, outward), reverse=True)
    wires = [cq.Wire.makePolygon([
        cq.Vector(*(point[index] + start_offset[index] for index in range(3))) for point in loop
    ], close=True) for loop in ordered]
    face = cq.Face.makeFromWires(wires[0], wires[1:])
    shape = cq.Shape.cast(BRepPrimAPI_MakePrism(face.wrapped, gp_Vec(*extrusion_vector), True, True).Shape())
    if not isinstance(shape, cq.Solid) or not shape.isValid() or shape.Volume() <= 0:
        raise ValueError("无法从连续共面区域构造有效的单一法向工具体")
    return shape


def extrude_mesh_face(
    input_path: Path,
    output_dir: Path,
    selection_revision: str,
    selection: dict[str, object],
    mode: FaceExtrusionMode,
    distance_mm: float,
    selection_method: SelectionMethod = "click",
) -> dict[str, object]:
    """从点击种子面扩展连续共面区域，并沿真实法线执行加料或压入切除。"""

    if mode not in ("add", "cut"):
        raise ValueError("连续共面区域法向编辑只能选择向外加料或向内压入")
    if not math.isfinite(distance_mm) or not MIN_FACE_EXTRUSION_MM <= distance_mm <= MAX_FACE_EXTRUSION_MM:
        raise ValueError("共面区域法向距离必须在 0.20 至 100.00 毫米之间")
    if selection_method != "click":
        raise ValueError("连续共面区域法向编辑只支持点击选择一个种子三角面")
    if not input_path.is_file():
        raise ValueError(f"没有找到当前上传模型工作文件：{input_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_import_manifest(output_dir)
    if manifest.get("revision") != selection_revision:
        raise ValueError("模型已在选择后发生变化，请重新选择三角面")

    model, source_validation = import_stl_as_solid(input_path)
    source_solids = _closed_solids(model, "当前上传模型")
    if len(source_solids) != 1:
        raise ValueError("连续共面区域法向编辑只支持单一封闭 Solid；多实体模型请先拆分后分别处理")
    triangles = read_stl(input_path)
    unique_selections, _ = _validate_and_collect_selections(triangles, "face", [selection])
    if len(unique_selections) != 1:
        raise ValueError("连续共面区域法向编辑必须且只能点击选择一个种子三角面")
    triangle_index = int(unique_selections[0]["triangleIndex"])
    triangle = triangles[triangle_index]
    bounds = model.val().BoundingBox()
    diagonal = math.sqrt(bounds.xlen**2 + bounds.ylen**2 + bounds.zlen**2)
    outward = _resolve_outward_normal(source_solids[0], triangle, diagonal)
    region_indexes, region_area_mm2, plane_tolerance_mm = _expand_coplanar_region(triangles, triangle_index, diagonal)
    loops = _boundary_loops(triangles, region_indexes)
    weighted_centroid = [0.0, 0.0, 0.0]
    for region_index in region_indexes:
        area = _triangle_area(triangles[region_index])
        current_centroid = _triangle_centroid(triangles[region_index])
        for axis in range(3):
            weighted_centroid[axis] += current_centroid[axis] * area
    centroid = tuple(value / region_area_mm2 for value in weighted_centroid)
    overlap_mm = max(0.02, min(0.20, diagonal * 0.001))

    if mode == "add":
        start_offset = tuple(-value * overlap_mm for value in outward)
        extrusion_vector = tuple(value * (distance_mm + overlap_mm) for value in outward)
        operation_label = "连续共面区域向外加料"
    else:
        start_offset = tuple(value * overlap_mm for value in outward)
        extrusion_vector = tuple(-value * (distance_mm + overlap_mm) for value in outward)
        operation_label = "连续共面区域向内压入"
    tool = _planar_region_prism(loops, outward, start_offset, extrusion_vector)
    edited = (model.union(tool, clean=True) if mode == "add" else model.cut(tool)).clean()
    result_solids = _closed_solids(edited, operation_label)
    if len(result_solids) != 1:
        raise ValueError(f"{operation_label}后产生 {len(result_solids)} 个 Solid，已拒绝写回以避免模型断裂")

    volume_before = source_solids[0].Volume()
    volume_after = result_solids[0].Volume()
    volume_delta = volume_after - volume_before
    volume_tolerance = max(1e-4, volume_before * 1e-8)
    if mode == "add" and volume_delta <= volume_tolerance:
        raise ValueError("共面区域加料没有形成有效实体相交，未检测到体积增加")
    if mode == "cut" and volume_delta >= -volume_tolerance:
        raise ValueError("共面区域压入没有进入模型实体，未检测到体积减少")

    revision = str(time_ns())
    working_stl = output_dir / "imported-model-working.stl"
    working_step = output_dir / "imported-model-working.step"
    manifest_path = output_dir / "imported-model-result.json"
    result_path = output_dir / "mesh-element-edit-result.json"
    temporary_stl = output_dir / f".imported-model-working-{revision}.stl"
    temporary_step = output_dir / f".imported-model-working-{revision}.step"
    temporary_manifest = output_dir / f".imported-model-result-{revision}.json"
    temporary_result = output_dir / f".mesh-element-edit-result-{revision}.json"
    temporary_paths = (temporary_stl, temporary_step, temporary_manifest, temporary_result)

    try:
        exporters.export(edited, str(temporary_step))
        exporters.export(edited, str(temporary_stl), tolerance=0.05)
        try:
            verified_model, verified = import_stl_as_solid(temporary_stl)
        except ValueError as error:
            raise ValueError(f"连续共面区域法向编辑导出结果未通过网格检查：{error}") from error
        verified_solids = _closed_solids(verified_model, "连续共面区域法向编辑导出模型")
        if len(verified_solids) != 1:
            raise ValueError("连续共面区域法向编辑导出后不再是单一封闭 Solid，已拒绝覆盖工作模型")
        exported_volume = verified_solids[0].Volume()
        allowed_export_error = max(0.01, volume_after * 5e-5)
        if abs(exported_volume - volume_after) > allowed_export_error:
            raise ValueError("连续共面区域法向编辑 STL 导出体积误差超限，已拒绝覆盖工作模型")

        existing_outputs = _existing_output_names(manifest, output_dir)
        output_names = list(dict.fromkeys([*existing_outputs, working_stl.name, working_step.name]))
        pending_files = {working_stl.name: temporary_stl, working_step.name: temporary_step}
        files = {
            name: {"bytes": pending_files.get(name, output_dir / name).stat().st_size}
            for name in output_names
            if pending_files.get(name, output_dir / name).is_file()
        }
        old_metrics = manifest.get("metrics") if isinstance(manifest.get("metrics"), dict) else {}
        updated_model: dict[str, object] = {
            "status": "ok",
            "revision": revision,
            "id": "uploaded-model",
            "name": manifest.get("name") or "上传模型",
            "originalFileName": manifest.get("originalFileName") or input_path.name,
            "sourceFile": working_stl.name,
            "originalSourceFile": manifest.get("originalSourceFile") or "imported-model.stl",
            "sourceKind": "uploaded-stl",
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6 / 连续共面区域法向布尔编辑",
            "outputs": output_names,
            "files": files,
            "metrics": {
                "valid": True,
                "watertight": True,
                "triangleCount": verified.triangle_count,
                "solidCount": len(verified_solids),
                "volumeMm3": exported_volume,
                "boundsMm": _bounds_json(verified.bounds),
                "repair": old_metrics.get("repair", {}),
            },
        }
        branch_source = manifest.get("branchSource")
        if isinstance(branch_source, dict):
            updated_model["branchSource"] = branch_source

        result: dict[str, object] = {
            "status": "ok",
            "revision": revision,
            "selectionRevision": selection_revision,
            "sourcePartId": "uploaded-model",
            "kind": "face",
            "selectionMethod": "click",
            "selectedElementCount": 1,
            "affectedTriangleCount": len(region_indexes),
            "regionAreaMm2": region_area_mm2,
            "boundaryLoopCount": len(loops),
            "normalToleranceDegrees": PLANAR_REGION_NORMAL_TOLERANCE_DEGREES,
            "planeToleranceMm": plane_tolerance_mm,
            "operation": "extrude-face",
            "pivotMm": {"x": centroid[0], "y": centroid[1], "z": centroid[2]},
            "faceExtrusionMode": mode,
            "distanceMm": distance_mm,
            "outwardNormal": {"x": outward[0], "y": outward[1], "z": outward[2]},
            "toolVolumeMm3": tool.Volume(),
            "movedCoordinateCount": 0,
            "movedVertexOccurrenceCount": 0,
            "sourceFile": working_stl.name,
            "stepFile": working_step.name,
            "outputs": [working_stl.name, working_step.name],
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "validation": {
                "valid": True,
                "watertight": True,
                "solidCountBefore": len(source_solids),
                "solidCountAfter": len(verified_solids),
                "volumeBeforeMm3": volume_before,
                "volumeAfterMm3": exported_volume,
                "volumeDeltaMm3": exported_volume - volume_before,
                "boundsBeforeMm": _bounds_json(source_validation.bounds),
                "boundsAfterMm": _bounds_json(verified.bounds),
            },
            "updatedModel": updated_model,
            "limitations": [
                "从当前修订中点击选择的种子三角面沿共享无向边自动扩展连续共面区域",
                f"区域最多 {MAX_PLANAR_REGION_TRIANGLES} 个三角面、{MAX_PLANAR_REGION_AREA_MM2:.0f} 平方毫米，法线夹角公差 {PLANAR_REGION_NORMAL_TOLERANCE_DEGREES:.1f}°",
                "方向由源 triangleMm 和 OpenCascade 实体内外分类确认的真实外法线决定",
                "不支持曲面区域、穿越锐边、多区域框选、侧壁斜度、倒角联动或自由雕刻",
            ],
        }
        temporary_manifest.write_text(json.dumps(updated_model, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_result.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        _commit_files_with_rollback(
            [(temporary_stl, working_stl), (temporary_step, working_step), (temporary_manifest, manifest_path), (temporary_result, result_path)],
            revision,
        )
        return result
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)

def transform_mesh_elements(
    input_path: Path,
    output_dir: Path,
    selection_revision: str,
    kind: ElementKind,
    selections: list[dict[str, object]],
    operation: TransformOperation,
    selection_method: SelectionMethod = "click",
    displacement_mm: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotation_axis: TransformAxis | None = None,
    rotation_degrees: float = 0.0,
    scale_factor: float = 1.0,
) -> dict[str, object]:
    """变换同类元素及所有同坐标副本，通过实体校验后原子写回工作文件。"""

    if kind not in ("vertex", "edge", "face"):
        raise ValueError("网格元素类型只能是顶点、边或面")
    if selection_method not in ("click", "box"):
        raise ValueError("网格元素选择方式只能是点击或框选")
    if operation not in ("move", "rotate", "scale"):
        raise ValueError("网格元素操作只能是位移、旋转或缩放")
    if operation == "move":
        if not all(math.isfinite(value) for value in displacement_mm):
            raise ValueError("网格元素位移必须是有限毫米数值")
        if any(abs(value) > MAX_DISPLACEMENT_MM for value in displacement_mm):
            raise ValueError("网格元素每个坐标轴的单次位移不能超过 500 毫米")
        if math.sqrt(sum(value * value for value in displacement_mm)) < 1e-9:
            raise ValueError("请至少输入一个非零位移")
    elif operation == "rotate":
        if rotation_axis not in ("x", "y", "z"):
            raise ValueError("旋转轴只能是源模型 X、Y 或 Z 轴")
        if not math.isfinite(rotation_degrees) or abs(rotation_degrees) > MAX_ROTATION_DEGREES or abs(rotation_degrees) < 1e-9:
            raise ValueError("旋转角度必须是 -180° 至 180° 之间的非零有限数值")
    elif not math.isfinite(scale_factor) or not MIN_SCALE_FACTOR <= scale_factor <= MAX_SCALE_FACTOR or abs(scale_factor - 1) < 1e-9:
        raise ValueError("缩放比例必须在 0.25 至 4 倍之间，且不能等于 1")
    if not input_path.is_file():
        raise ValueError(f"没有找到当前上传模型工作文件：{input_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_import_manifest(output_dir)
    if manifest.get("revision") != selection_revision:
        raise ValueError("模型已在选择后发生变化，请重新选择顶点、边或面")

    resolved_rotation_axis: TransformAxis = rotation_axis if rotation_axis in ("x", "y", "z") else "z"

    source_model, source_validation = import_stl_as_solid(input_path)
    source_solids = _closed_solids(source_model, "当前上传模型")
    triangles = read_stl(input_path)
    unique_selections, selected_keys = _validate_and_collect_selections(triangles, kind, selections)
    pivot = _selection_pivot(selected_keys)

    moved_occurrence_count = 0
    changed_coordinate_count = 0
    transformed_by_key: dict[tuple[float, float, float], tuple[float, float, float]] = {}
    for key in selected_keys:
        transformed = _transform_point(key, operation, pivot, displacement_mm, resolved_rotation_axis, rotation_degrees, scale_factor)
        if not all(math.isfinite(value) and abs(value) <= MAX_COORDINATE_MM for value in transformed):
            raise ValueError("变换后出现无效或超出安全范围的坐标，已拒绝写回")
        transformed_by_key[key] = transformed
        if any(abs(transformed[index] - key[index]) >= 1e-9 for index in range(3)):
            changed_coordinate_count += 1
    if changed_coordinate_count == 0:
        raise ValueError("当前选择围绕几何中心执行该操作不会产生坐标变化")

    moved_triangles: list[tuple[tuple[float, float, float], ...]] = []
    for triangle in triangles:
        moved_triangle = []
        for point in triangle:
            key = _coordinate_key(point)
            moved_point = transformed_by_key.get(key, tuple(float(value) for value in point))
            if key in transformed_by_key:
                moved_occurrence_count += 1
            moved_triangle.append(moved_point)
        moved = tuple(moved_triangle)
        if _double_area(moved) <= MIN_DOUBLE_AREA:
            raise ValueError("变换会产生零面积或退化三角面，已保留最后有效模型")
        moved_triangles.append(moved)

    revision = str(time_ns())
    working_stl = output_dir / "imported-model-working.stl"
    working_step = output_dir / "imported-model-working.step"
    manifest_path = output_dir / "imported-model-result.json"
    result_path = output_dir / "mesh-element-edit-result.json"
    temporary_stl = output_dir / f".imported-model-working-{revision}.stl"
    temporary_step = output_dir / f".imported-model-working-{revision}.step"
    temporary_manifest = output_dir / f".imported-model-result-{revision}.json"
    temporary_result = output_dir / f".mesh-element-edit-result-{revision}.json"
    temporary_paths = (temporary_stl, temporary_step, temporary_manifest, temporary_result)

    try:
        write_binary_stl(temporary_stl, moved_triangles)
        verified_model, verified = import_stl_as_solid(temporary_stl)
        if verified.repair.repaired:
            raise ValueError("变换后的网格需要自动修洞或清理才能封闭，已拒绝写回")
        verified_solids = _closed_solids(verified_model, "网格元素变换结果")
        if len(verified_solids) != len(source_solids):
            raise ValueError(f"变换前后 Solid 数量从 {len(source_solids)} 变为 {len(verified_solids)}，已拒绝写回")
        volume_before = source_validation.volume_mm3
        volume_after = verified.volume_mm3
        if not math.isfinite(volume_after) or volume_after <= 0:
            raise ValueError("变换后的实体体积无效，已拒绝写回")
        exporters.export(verified_model, str(temporary_step))

        existing_outputs = _existing_output_names(manifest, output_dir)
        output_names = list(dict.fromkeys([*existing_outputs, working_stl.name, working_step.name]))
        pending_files = {working_stl.name: temporary_stl, working_step.name: temporary_step}
        files = {
            name: {"bytes": pending_files.get(name, output_dir / name).stat().st_size}
            for name in output_names
            if pending_files.get(name, output_dir / name).is_file()
        }
        old_metrics = manifest.get("metrics") if isinstance(manifest.get("metrics"), dict) else {}
        updated_model: dict[str, object] = {
            "status": "ok",
            "revision": revision,
            "id": "uploaded-model",
            "name": manifest.get("name") or "上传模型",
            "originalFileName": manifest.get("originalFileName") or input_path.name,
            "sourceFile": working_stl.name,
            "originalSourceFile": manifest.get("originalSourceFile") or "imported-model.stl",
            "sourceKind": "uploaded-stl",
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6 / STL 网格元素集合变换",
            "outputs": output_names,
            "files": files,
            "metrics": {
                "valid": True,
                "watertight": True,
                "triangleCount": verified.triangle_count,
                "solidCount": len(verified_solids),
                "volumeMm3": volume_after,
                "boundsMm": _bounds_json(verified.bounds),
                "repair": old_metrics.get("repair", {}),
            },
        }
        branch_source = manifest.get("branchSource")
        if isinstance(branch_source, dict):
            updated_model["branchSource"] = branch_source

        result: dict[str, object] = {
            "status": "ok",
            "revision": revision,
            "selectionRevision": selection_revision,
            "sourcePartId": "uploaded-model",
            "kind": kind,
            "selectionMethod": selection_method,
            "selectedElementCount": len(unique_selections),
            "operation": operation,
            "pivotMm": {"x": pivot[0], "y": pivot[1], "z": pivot[2]},
            "movedCoordinateCount": changed_coordinate_count,
            "movedVertexOccurrenceCount": moved_occurrence_count,
            "sourceFile": working_stl.name,
            "stepFile": working_step.name,
            "outputs": [working_stl.name, working_step.name],
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "validation": {
                "valid": True,
                "watertight": True,
                "solidCountBefore": len(source_solids),
                "solidCountAfter": len(verified_solids),
                "volumeBeforeMm3": volume_before,
                "volumeAfterMm3": volume_after,
                "volumeDeltaMm3": volume_after - volume_before,
                "boundsBeforeMm": _bounds_json(source_validation.bounds),
                "boundsAfterMm": _bounds_json(verified.bounds),
            },
            "updatedModel": updated_model,
            "limitations": [
                f"单次最多变换 {MAX_SELECTIONS} 个同类顶点、三角边或三角面",
                "旋转和缩放以选择集合唯一源坐标的几何中心为枢轴",
                "框选使用当前视角的屏幕投影，可能包含被遮挡区域中的元素",
                "集合变换不支持拓扑增删、焊接、分裂、多面挤出或未受约束的自由雕刻",
            ],
        }
        if operation == "move":
            result["displacementMm"] = {"x": displacement_mm[0], "y": displacement_mm[1], "z": displacement_mm[2]}
        elif operation == "rotate":
            result["rotationAxis"] = resolved_rotation_axis
            result["rotationDegrees"] = rotation_degrees
        else:
            result["scaleFactor"] = scale_factor
        temporary_manifest.write_text(json.dumps(updated_model, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_result.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        _commit_files_with_rollback(
            [(temporary_stl, working_stl), (temporary_step, working_step), (temporary_manifest, manifest_path), (temporary_result, result_path)],
            revision,
        )
        return result
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)


def edit_mesh_elements(
    input_path: Path,
    output_dir: Path,
    selection_revision: str,
    kind: ElementKind,
    selections: list[dict[str, object]],
    displacement_mm: tuple[float, float, float],
    selection_method: SelectionMethod = "click",
) -> dict[str, object]:
    """兼容既有批量位移调用。"""

    return transform_mesh_elements(
        input_path, output_dir, selection_revision, kind, selections, "move", selection_method, displacement_mm
    )


def edit_mesh_element(
    input_path: Path,
    output_dir: Path,
    selection_revision: str,
    kind: ElementKind,
    triangle_index: int,
    element_index: int,
    displacement_mm: tuple[float, float, float],
) -> dict[str, object]:
    """兼容既有单元素位移调用，并补齐当前 STL 的源三角面坐标。"""

    triangles = read_stl(input_path)
    if not isinstance(triangle_index, int) or triangle_index < 0 or triangle_index >= len(triangles):
        raise ValueError("选中的三角面已不存在，请重新选择")
    triangle_mm = [{"x": point[0], "y": point[1], "z": point[2]} for point in triangles[triangle_index]]
    return edit_mesh_elements(
        input_path,
        output_dir,
        selection_revision,
        kind,
        [{"triangleIndex": triangle_index, "elementIndex": element_index, "triangleMm": triangle_mm}],
        displacement_mm,
        "click",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FormAI 受管网格元素变换与连续共面区域法向编辑 Worker")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--selection-revision", required=True)
    parser.add_argument("--kind", required=True, choices=("vertex", "edge", "face"))
    parser.add_argument("--selection-method", choices=("click", "box"), default="click")
    parser.add_argument("--operation", required=True, choices=("move", "rotate", "scale", "extrude-face"))
    parser.add_argument("--selections-stdin", action="store_true")
    parser.add_argument("--triangle-index", type=int)
    parser.add_argument("--element-index", type=int)
    parser.add_argument("--delta-x", type=float, default=0.0)
    parser.add_argument("--delta-y", type=float, default=0.0)
    parser.add_argument("--delta-z", type=float, default=0.0)
    parser.add_argument("--rotation-axis", choices=("x", "y", "z"))
    parser.add_argument("--rotation-degrees", type=float, default=0.0)
    parser.add_argument("--scale-factor", type=float, default=1.0)
    parser.add_argument("--face-extrusion-mode", choices=("add", "cut"))
    parser.add_argument("--distance", type=float, default=0.0)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.selections_stdin:
            selections = json.loads(sys.stdin.read())
            if not isinstance(selections, list):
                raise ValueError("网格元素选择集合必须是数组")
            if arguments.operation == "extrude-face":
                if arguments.kind != "face" or len(selections) != 1:
                    raise ValueError("连续共面区域法向编辑必须且只能点击选择一个种子三角面")
                result = extrude_mesh_face(
                    arguments.input,
                    arguments.output,
                    arguments.selection_revision,
                    selections[0],
                    arguments.face_extrusion_mode,
                    arguments.distance,
                    arguments.selection_method,
                )
            else:
                result = transform_mesh_elements(
                    arguments.input,
                    arguments.output,
                    arguments.selection_revision,
                    arguments.kind,
                    selections,
                    arguments.operation,
                    arguments.selection_method,
                    (arguments.delta_x, arguments.delta_y, arguments.delta_z),
                    arguments.rotation_axis,
                    arguments.rotation_degrees,
                    arguments.scale_factor,
                )
        else:
            if arguments.operation != "move":
                raise ValueError("旋转和缩放必须使用网格元素选择集合")
            if arguments.triangle_index is None or arguments.element_index is None:
                raise ValueError("缺少网格元素索引，请重新选择")
            result = edit_mesh_element(
                arguments.input,
                arguments.output,
                arguments.selection_revision,
                arguments.kind,
                arguments.triangle_index,
                arguments.element_index,
                (arguments.delta_x, arguments.delta_y, arguments.delta_z),
            )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - CLI 边界需要统一中文错误。
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
