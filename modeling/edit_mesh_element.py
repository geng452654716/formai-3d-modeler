#!/usr/bin/env python3
"""对任意上传 STL 的同类顶点、边或三角面集合执行可回滚的精确毫米位移。"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from time import time_ns
from typing import Literal

from cadquery import exporters

from export_transformed_model import read_stl, write_binary_stl
from local_stl_edit import _commit_files_with_rollback, _existing_output_names, _load_import_manifest
from split_and_cap import _bounds_json, _closed_solids, import_stl_as_solid

ElementKind = Literal["vertex", "edge", "face"]
SelectionMethod = Literal["click", "box"]
EDGE_VERTEX_INDEXES = ((0, 1), (1, 2), (2, 0))
MAX_DISPLACEMENT_MM = 500.0
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
        raise ValueError("请至少选择一个要移动的网格元素")
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


def edit_mesh_elements(
    input_path: Path,
    output_dir: Path,
    selection_revision: str,
    kind: ElementKind,
    selections: list[dict[str, object]],
    displacement_mm: tuple[float, float, float],
    selection_method: SelectionMethod = "click",
) -> dict[str, object]:
    """批量移动同类元素及所有同坐标副本，通过实体校验后原子写回工作文件。"""

    if kind not in ("vertex", "edge", "face"):
        raise ValueError("网格元素类型只能是顶点、边或面")
    if selection_method not in ("click", "box"):
        raise ValueError("网格元素选择方式只能是点击或框选")
    if not all(math.isfinite(value) for value in displacement_mm):
        raise ValueError("网格元素位移必须是有限毫米数值")
    if any(abs(value) > MAX_DISPLACEMENT_MM for value in displacement_mm):
        raise ValueError("网格元素每个坐标轴的单次位移不能超过 500 毫米")
    if math.sqrt(sum(value * value for value in displacement_mm)) < 1e-9:
        raise ValueError("请至少输入一个非零位移")
    if not input_path.is_file():
        raise ValueError(f"没有找到当前上传模型工作文件：{input_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_import_manifest(output_dir)
    if manifest.get("revision") != selection_revision:
        raise ValueError("模型已在选择后发生变化，请重新选择顶点、边或面")

    source_model, source_validation = import_stl_as_solid(input_path)
    source_solids = _closed_solids(source_model, "当前上传模型")
    triangles = read_stl(input_path)
    unique_selections, selected_keys = _validate_and_collect_selections(triangles, kind, selections)

    moved_occurrence_count = 0
    moved_triangles: list[tuple[tuple[float, float, float], ...]] = []
    dx, dy, dz = displacement_mm
    for triangle in triangles:
        moved_triangle = []
        for point in triangle:
            if _coordinate_key(point) in selected_keys:
                moved_point = (point[0] + dx, point[1] + dy, point[2] + dz)
                moved_occurrence_count += 1
            else:
                moved_point = tuple(float(value) for value in point)
            if not all(math.isfinite(value) for value in moved_point):
                raise ValueError("位移后出现无穷大或非数字坐标，已拒绝写回")
            moved_triangle.append(moved_point)
        moved = tuple(moved_triangle)
        if _double_area(moved) <= MIN_DOUBLE_AREA:
            raise ValueError("位移会产生零面积或退化三角面，已保留最后有效模型")
        moved_triangles.append(moved)

    if moved_occurrence_count == 0:
        raise ValueError("没有找到需要同步移动的 STL 顶点，请重新选择")

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
            raise ValueError("位移后的网格需要自动修洞或清理才能封闭，已拒绝写回")
        verified_solids = _closed_solids(verified_model, "网格元素位移结果")
        if len(verified_solids) != len(source_solids):
            raise ValueError(
                f"位移前后 Solid 数量从 {len(source_solids)} 变为 {len(verified_solids)}，已拒绝写回"
            )
        volume_before = source_validation.volume_mm3
        volume_after = verified.volume_mm3
        if not math.isfinite(volume_after) or volume_after <= 0:
            raise ValueError("位移后的实体体积无效，已拒绝写回")
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
            "kernel": "OpenCascade 7.8 / CadQuery 2.6 / STL 网格元素批量编辑",
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
        result: dict[str, object] = {
            "status": "ok",
            "revision": revision,
            "selectionRevision": selection_revision,
            "sourcePartId": "uploaded-model",
            "kind": kind,
            "selectionMethod": selection_method,
            "selectedElementCount": len(unique_selections),
            "displacementMm": {"x": dx, "y": dy, "z": dz},
            "movedCoordinateCount": len(selected_keys),
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
                f"单次最多批量移动 {MAX_SELECTIONS} 个同类顶点、三角边或三角面",
                "框选使用当前视角的屏幕投影，可能包含被遮挡区域中的元素",
                "不支持拓扑增删、焊接、分裂、挤出或未受约束的自由雕刻",
                "参数化 CAD 继续使用稳定面和稳定边特征，不直接改写 OpenCascade BRep 顶点",
            ],
        }
        temporary_manifest.write_text(json.dumps(updated_model, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_result.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        _commit_files_with_rollback(
            [
                (temporary_stl, working_stl),
                (temporary_step, working_step),
                (temporary_manifest, manifest_path),
                (temporary_result, result_path),
            ],
            revision,
        )
        return result
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)


def edit_mesh_element(
    input_path: Path,
    output_dir: Path,
    selection_revision: str,
    kind: ElementKind,
    triangle_index: int,
    element_index: int,
    displacement_mm: tuple[float, float, float],
) -> dict[str, object]:
    """兼容既有单元素调用，并补齐当前 STL 的源三角面坐标。"""

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
    parser = argparse.ArgumentParser(description="FormAI 上传 STL 网格元素批量位移 Worker")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--selection-revision", required=True)
    parser.add_argument("--kind", required=True, choices=("vertex", "edge", "face"))
    parser.add_argument("--selection-method", choices=("click", "box"), default="click")
    parser.add_argument("--selections-stdin", action="store_true")
    parser.add_argument("--triangle-index", type=int)
    parser.add_argument("--element-index", type=int)
    parser.add_argument("--delta-x", required=True, type=float)
    parser.add_argument("--delta-y", required=True, type=float)
    parser.add_argument("--delta-z", required=True, type=float)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.selections_stdin:
            selections = json.loads(sys.stdin.read())
            if not isinstance(selections, list):
                raise ValueError("网格元素选择集合必须是数组")
            result = edit_mesh_elements(
                arguments.input,
                arguments.output,
                arguments.selection_revision,
                arguments.kind,
                selections,
                (arguments.delta_x, arguments.delta_y, arguments.delta_z),
                arguments.selection_method,
            )
        else:
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
