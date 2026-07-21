"""生成可验证的 STL 三角面到 OpenCascade 稳定面 ID 回映射。

选择网格按稳定面 ID 分组写入二进制 STL。前端 STLLoader 的 faceIndex 因而可以通过
连续三角形区间精确回查到参数化 CAD 面。该映射只适用于同一次生成产出的选择网格，
不能套用到经过第三方软件重排三角面的 STL。
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path
from typing import Any, Iterable

import cadquery as cq

MAPPING_METHOD = "按 OpenCascade 面分组的 STL 三角面区间回映射第一版"
MAPPING_WARNING = (
    "triangleIndex 只对同一次生成的选择网格有效；重新三角化、第三方修复或导出会改变三角面顺序。"
    "稳定面 ID 仍受几何签名匹配第一版的能力边界约束。"
)


def _rounded(value: float, digits: int = 6) -> float:
    rounded = round(float(value), digits)
    return 0.0 if abs(rounded) < 10 ** (-digits) else rounded


def _vector_tuple(vector: cq.Vector) -> tuple[float, float, float]:
    return (float(vector.x), float(vector.y), float(vector.z))


def _triangle_normal(
    first: cq.Vector,
    second: cq.Vector,
    third: cq.Vector,
) -> tuple[float, float, float] | None:
    cross = (second - first).cross(third - first)
    length = cross.Length
    if not math.isfinite(length) or length <= 1e-12:
        return None
    return _vector_tuple(cross.multiply(1.0 / length))


def _stl_header(part_id: str) -> bytes:
    value = f"FormAI 稳定面选择网格 {part_id}".encode("utf-8")[:80]
    return value.ljust(80, b"\0")


def build_face_tessellation(
    part_id: str,
    described_faces: Iterable[tuple[cq.Face, dict[str, Any]]],
    *,
    source_stl_file: str,
    selection_mesh_file: str,
    mapping_file: str,
    linear_tolerance_mm: float = 0.05,
    angular_tolerance_rad: float = 0.1,
) -> tuple[bytes, dict[str, Any]]:
    """返回按稳定面分组的二进制 STL 与三角面区间映射清单。"""
    if not part_id.strip():
        raise ValueError("零件 ID 不能为空")
    if linear_tolerance_mm <= 0 or not math.isfinite(linear_tolerance_mm):
        raise ValueError("线性三角化容差必须大于零")
    if angular_tolerance_rad <= 0 or not math.isfinite(angular_tolerance_rad):
        raise ValueError("角度三角化容差必须大于零")

    triangle_records: list[tuple[tuple[float, float, float], tuple[cq.Vector, cq.Vector, cq.Vector]]] = []
    face_ranges: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for face, descriptor in described_faces:
        stable_id = descriptor.get("stableId")
        if not isinstance(stable_id, str) or not stable_id.strip():
            raise ValueError("面描述缺少稳定 ID")
        if stable_id in seen_ids:
            raise ValueError(f"面稳定 ID 重复：{stable_id}")
        seen_ids.add(stable_id)

        vertices, triangles = face.tessellate(linear_tolerance_mm, angular_tolerance_rad)
        triangle_start = len(triangle_records)
        for triangle in triangles:
            if len(triangle) != 3:
                continue
            first, second, third = (vertices[index] for index in triangle)
            normal = _triangle_normal(first, second, third)
            if normal is None:
                continue
            triangle_records.append((normal, (first, second, third)))

        triangle_count = len(triangle_records) - triangle_start
        if triangle_count <= 0:
            raise RuntimeError(f"OpenCascade 面 {stable_id} 没有生成有效三角面")
        face_ranges.append(
            {
                "stableId": stable_id,
                "geometryType": descriptor.get("geometryType", "UNKNOWN"),
                "triangleStart": triangle_start,
                "triangleCount": triangle_count,
                "areaMm2": descriptor.get("areaMm2", 0.0),
                "centerMm": descriptor.get("centerMm", [0.0, 0.0, 0.0]),
                **({"normal": descriptor["normal"]} if "normal" in descriptor else {}),
            }
        )

    if not triangle_records:
        raise RuntimeError("选择网格没有生成任何有效三角面")

    binary = bytearray(_stl_header(part_id))
    binary.extend(struct.pack("<I", len(triangle_records)))
    for normal, vertices in triangle_records:
        values = [*normal]
        for vertex in vertices:
            values.extend(_vector_tuple(vertex))
        binary.extend(struct.pack("<12fH", *values, 0))

    mapping = {
        "status": "ok",
        "version": 1,
        "partId": part_id,
        "units": "mm",
        "coordinateSystem": "CadQuery/OpenCascade 原始毫米坐标（Z 轴向上）",
        "method": MAPPING_METHOD,
        "sourceStlFile": source_stl_file,
        "selectionMeshFile": selection_mesh_file,
        "mappingFile": mapping_file,
        "triangleCount": len(triangle_records),
        "faceCount": len(face_ranges),
        "linearToleranceMm": _rounded(linear_tolerance_mm),
        "angularToleranceRad": _rounded(angular_tolerance_rad),
        "faces": face_ranges,
        "warning": MAPPING_WARNING,
    }
    return bytes(binary), mapping


def export_face_tessellation_mapping(
    output_directory: Path,
    part_id: str,
    described_faces: Iterable[tuple[cq.Face, dict[str, Any]]],
    *,
    source_stl_file: str,
    selection_mesh_file: str,
    mapping_file: str,
    linear_tolerance_mm: float = 0.05,
    angular_tolerance_rad: float = 0.1,
) -> dict[str, Any]:
    """写入选择 STL 和 JSON 映射，并返回可嵌入 generation-result 的摘要。"""
    output_directory.mkdir(parents=True, exist_ok=True)
    binary, mapping = build_face_tessellation(
        part_id,
        described_faces,
        source_stl_file=source_stl_file,
        selection_mesh_file=selection_mesh_file,
        mapping_file=mapping_file,
        linear_tolerance_mm=linear_tolerance_mm,
        angular_tolerance_rad=angular_tolerance_rad,
    )
    (output_directory / selection_mesh_file).write_bytes(binary)
    (output_directory / mapping_file).write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return mapping
