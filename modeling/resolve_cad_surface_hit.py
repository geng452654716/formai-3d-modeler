#!/usr/bin/env python3
"""解析稳定 CAD 面点击的真实 UV、OpenCascade 外法线和投影位置。"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import cadquery as cq

from cad_surface_hit_core import resolve_surface_hit


def _plain_file_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}记录无效，请重新生成 CAD")
    candidate = Path(value)
    if candidate.name != value or candidate.is_absolute():
        raise ValueError(f"{label}必须是当前模型目录内的普通文件名")
    return value


def _load_manifest(output_dir: Path) -> dict[str, Any]:
    manifest_path = output_dir / "generation-result.json"
    if not manifest_path.is_file():
        raise ValueError("没有找到当前精确 CAD 清单，请先重建模型")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"当前精确 CAD 清单无法读取：{error}") from error
    if not isinstance(manifest, dict) or not isinstance(manifest.get("parts"), list):
        raise ValueError("当前精确 CAD 清单格式无效，请先重建模型")
    return manifest


def _finite_vector(values: tuple[float, float, float], label: str) -> None:
    if len(values) != 3 or not all(math.isfinite(value) for value in values):
        raise ValueError(f"{label}必须是三个有限数值")


def resolve_cad_surface_hit(
    *,
    output_dir: Path,
    selection_revision: str,
    part_id: str,
    stable_face_id: str,
    triangle_index: int,
    point_mm: tuple[float, float, float],
    mesh_normal: tuple[float, float, float],
) -> dict[str, Any]:
    """验证选择上下文并从当前 STEP 解析一个真实裁剪面命中。"""
    if not selection_revision.strip() or not part_id.strip() or not stable_face_id.strip():
        raise ValueError("曲面点击选择上下文不完整，请重新点击目标面")
    if triangle_index < 0:
        raise ValueError("曲面点击三角面索引无效，请重新点击目标面")
    _finite_vector(point_mm, "曲面点击坐标")
    _finite_vector(mesh_normal, "选择网格命中法线")

    manifest = _load_manifest(output_dir)
    if str(manifest.get("revision", "")) != selection_revision:
        raise ValueError("当前 CAD 已在点击后发生变化，triangleIndex 已失效，请重新点击目标面")

    matching_parts = [
        part for part in manifest["parts"]
        if isinstance(part, dict) and part.get("id") == part_id
    ]
    if len(matching_parts) != 1:
        raise ValueError(f"没有找到唯一的目标 CAD 零件：{part_id}")
    target_part = matching_parts[0]
    previous_faces = target_part.get("faces")
    if not isinstance(previous_faces, list) or not previous_faces:
        raise ValueError("目标零件没有稳定面描述，请先重新生成选择网格")
    requested_descriptor = next(
        (
            face for face in previous_faces
            if isinstance(face, dict) and face.get("stableId") == stable_face_id
        ),
        None,
    )
    if requested_descriptor is None:
        raise ValueError("所选稳定面已不存在或已重新编号，请重新点击目标面")

    face_tessellation = target_part.get("faceTessellation")
    mapping_faces = face_tessellation.get("faces") if isinstance(face_tessellation, dict) else None
    if not isinstance(mapping_faces, list):
        raise ValueError("目标零件缺少面三角映射，请先重新生成 CAD")
    mapped_faces = [
        face for face in mapping_faces
        if isinstance(face, dict)
        and face.get("stableId") == stable_face_id
        and isinstance(face.get("triangleStart"), int)
        and isinstance(face.get("triangleCount"), int)
        and face["triangleStart"] <= triangle_index < face["triangleStart"] + face["triangleCount"]
    ]
    if len(mapped_faces) != 1:
        raise ValueError("triangleIndex 与目标稳定面不一致，请重新点击目标面")

    step_file = _plain_file_name(target_part.get("stepFile"), "目标零件 STEP ")
    step_path = output_dir / step_file
    if not step_path.is_file():
        raise ValueError(f"没有找到目标 CAD 零件文件：{step_file}")
    try:
        model = cq.importers.importStep(str(step_path))
    except Exception as error:
        raise ValueError(f"目标 CAD 零件 STEP 无法读取：{error}") from error

    resolved = resolve_surface_hit(
        model,
        previous_faces,
        stable_face_id,
        point_mm,
        mesh_normal,
        target_face_descriptor=requested_descriptor,
    )
    return {
        "status": "ok",
        "selectionRevision": selection_revision,
        "partId": part_id,
        "stableFaceId": stable_face_id,
        "triangleIndex": triangle_index,
        **resolved,
        "units": "mm",
        "kernel": "OpenCascade 7.8 / CadQuery 2.6",
        "limitations": [
            "UV 和外法线来自当前 STEP 中重新定位的真实裁剪面",
            "稳定面 ID 使用几何签名匹配第一版，不是 OpenCascade 原生永久拓扑命名",
            "曲面点击上下文支持受限圆形、矩形和切平面槽孔；矩形与槽孔不代表支持任意曲面贴合轮廓、曲面边圆角或曲面参数直接编辑",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="当前精确 CAD 输出目录")
    parser.add_argument("--selection-revision", required=True)
    parser.add_argument("--part-id", required=True)
    parser.add_argument("--stable-face-id", required=True)
    parser.add_argument("--triangle-index", type=int, required=True)
    parser.add_argument("--point-x", type=float, required=True)
    parser.add_argument("--point-y", type=float, required=True)
    parser.add_argument("--point-z", type=float, required=True)
    parser.add_argument("--normal-x", type=float, required=True)
    parser.add_argument("--normal-y", type=float, required=True)
    parser.add_argument("--normal-z", type=float, required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        result = resolve_cad_surface_hit(
            output_dir=arguments.output,
            selection_revision=arguments.selection_revision,
            part_id=arguments.part_id,
            stable_face_id=arguments.stable_face_id,
            triangle_index=arguments.triangle_index,
            point_mm=(arguments.point_x, arguments.point_y, arguments.point_z),
            mesh_normal=(arguments.normal_x, arguments.normal_y, arguments.normal_z),
        )
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
