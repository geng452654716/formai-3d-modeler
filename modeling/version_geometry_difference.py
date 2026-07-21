#!/usr/bin/env python3
"""对两个受信任生成清单中的通用 STEP 零件执行 OpenCascade 精确布尔差集。"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from time import time_ns
from typing import Any

import cadquery as cq
from cadquery import exporters, importers

RESULT_FILE_NAME = "version-difference-result.json"
METHOD_NAME = "OpenCascade 精确布尔差集"
KERNEL_NAME = "OpenCascade 7.8 / CadQuery 2.6"
VOLUME_TOLERANCE_RATIO = 1e-7
MINIMUM_VOLUME_TOLERANCE_MM3 = 1e-6


def _plain_file_name(value: object, description: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{description}无效")
    path = Path(value)
    if path.name != value or value in {".", ".."}:
        raise ValueError(f"{description}必须是清单目录中的普通文件名")
    return value


def _canonical_directory(directory: Path, description: str) -> Path:
    if not directory.is_dir():
        raise ValueError(f"{description}不存在：{directory}")
    return directory.resolve(strict=True)


def _read_manifest(directory: Path, description: str) -> tuple[Path, dict[str, Any]]:
    resolved_directory = _canonical_directory(directory, description)
    manifest_path = resolved_directory / "generation-result.json"
    if not manifest_path.is_file():
        raise ValueError(f"{description}缺少精确模型清单 generation-result.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{description}精确模型清单格式错误：{error}") from error
    if not isinstance(manifest, dict) or manifest.get("status") != "ok":
        raise ValueError(f"{description}精确模型清单状态无效")
    if manifest.get("units") != "mm":
        raise ValueError(f"{description}不是毫米制模型，无法执行精确差异")
    return resolved_directory, manifest


def _declared_output_names(manifest: dict[str, Any], description: str) -> set[str]:
    outputs = manifest.get("outputs")
    if not isinstance(outputs, list):
        raise ValueError(f"{description}精确模型清单缺少 outputs")
    declared: set[str] = set()
    for index, value in enumerate(outputs):
        declared.add(_plain_file_name(value, f"{description}第 {index + 1} 个输出文件名"))
    return declared


def _manifest_parts(
    directory: Path,
    manifest: dict[str, Any],
    description: str,
) -> dict[str, dict[str, Any]]:
    raw_parts = manifest.get("parts")
    if not isinstance(raw_parts, list):
        raise ValueError(f"{description}精确模型清单缺少 parts")
    declared = _declared_output_names(manifest, description)
    parts: dict[str, dict[str, Any]] = {}
    for index, raw_part in enumerate(raw_parts):
        if not isinstance(raw_part, dict):
            raise ValueError(f"{description}第 {index + 1} 个零件格式无效")
        part_id = raw_part.get("id")
        if not isinstance(part_id, str) or not part_id.strip() or len(part_id) > 160:
            raise ValueError(f"{description}第 {index + 1} 个零件 ID 无效")
        if part_id in parts:
            raise ValueError(f"{description}包含重复零件 ID：{part_id}")
        step_file = _plain_file_name(raw_part.get("stepFile"), f"{description}零件“{part_id}”的 STEP 文件名")
        if Path(step_file).suffix.lower() not in {".step", ".stp"}:
            raise ValueError(f"{description}零件“{part_id}”没有声明 STEP 文件")
        if step_file not in declared:
            raise ValueError(f"{description}清单未在 outputs 中声明 STEP 文件：{step_file}")
        step_path = directory / step_file
        if not step_path.is_file():
            raise ValueError(f"{description}缺少 STEP 文件：{step_file}")
        resolved_step = step_path.resolve(strict=True)
        if resolved_step.parent != directory:
            raise ValueError(f"{description}STEP 文件超出清单目录：{step_file}")
        parts[part_id] = {
            "id": part_id,
            "label": raw_part.get("label") if isinstance(raw_part.get("label"), str) else part_id,
            "role": raw_part.get("role") if isinstance(raw_part.get("role"), str) else "part",
            "stepFile": step_file,
            "stepPath": resolved_step,
        }
    return parts


def _load_step(path: Path, description: str) -> cq.Workplane:
    try:
        model = importers.importStep(str(path))
    except Exception as error:  # CadQuery/OCP 会抛出多种底层异常
        raise ValueError(f"无法读取{description} STEP 文件“{path.name}”：{error}") from error
    shape = model.val()
    solids = shape.Solids()
    if not shape.isValid() or not solids:
        raise ValueError(f"{description} STEP 文件“{path.name}”不是有效封闭实体")
    volume = sum(solid.Volume() for solid in solids)
    if not math.isfinite(volume) or volume <= 0:
        raise ValueError(f"{description} STEP 文件“{path.name}”没有有效实体体积")
    return model


def _model_metrics(model: cq.Workplane) -> dict[str, float | int | bool]:
    shape = model.val()
    solids = shape.Solids()
    volume = sum(solid.Volume() for solid in solids)
    return {
        "valid": bool(shape.isValid()),
        "solidCount": len(solids),
        "volumeMm3": float(volume),
    }


def _difference_model(
    minuend: cq.Workplane,
    subtrahend: cq.Workplane,
    description: str,
) -> cq.Workplane:
    try:
        result = minuend.cut(subtrahend)
    except Exception as error:
        raise RuntimeError(f"{description}布尔差集失败：{error}") from error
    metrics = _model_metrics(result)
    if not metrics["valid"]:
        raise RuntimeError(f"{description}产生了无效 OpenCascade 结果")
    return result


def _safe_part_token(part_id: str, index: int) -> str:
    readable = re.sub(r"[^a-zA-Z0-9_-]+", "-", part_id).strip("-_")[:32]
    digest = hashlib.sha256(part_id.encode("utf-8")).hexdigest()[:10]
    return f"{index:03d}-{readable + '-' if readable else ''}{digest}"


def _export_difference(
    model: cq.Workplane,
    output_dir: Path,
    file_name: str,
    tolerance_mm3: float,
    description: str,
) -> tuple[str | None, dict[str, float | int | bool]]:
    metrics = _model_metrics(model)
    rounded_metrics = {
        "valid": metrics["valid"],
        "solidCount": metrics["solidCount"],
        "volumeMm3": round(float(metrics["volumeMm3"]), 6),
    }
    if float(metrics["volumeMm3"]) <= tolerance_mm3 or int(metrics["solidCount"]) == 0:
        return None, rounded_metrics
    output_path = output_dir / file_name
    try:
        exporters.export(model, str(output_path), tolerance=0.05)
    except Exception as error:
        raise RuntimeError(f"无法导出{description} STL：{error}") from error
    if not output_path.is_file() or output_path.stat().st_size <= 84:
        raise RuntimeError(f"{description} STL 输出为空或无效：{file_name}")
    return file_name, rounded_metrics


def _remove_previous_outputs(output_dir: Path) -> None:
    result_path = output_dir / RESULT_FILE_NAME
    if not result_path.is_file():
        return
    try:
        previous = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    outputs = previous.get("outputs") if isinstance(previous, dict) else None
    if not isinstance(outputs, list):
        return
    for value in outputs:
        try:
            file_name = _plain_file_name(value, "旧差异输出文件名")
        except ValueError:
            continue
        if not file_name.startswith("version-difference-") or not file_name.endswith(".stl"):
            continue
        path = output_dir / file_name
        if path.is_file() and path.resolve(strict=True).parent == output_dir.resolve(strict=True):
            path.unlink()


def compare_version_geometry(
    base_directory: Path,
    current_directory: Path,
    output_directory: Path,
) -> dict[str, Any]:
    """按稳定零件 ID 比较两个通用生成清单，并导出新增/删除实体。"""

    base_dir, base_manifest = _read_manifest(base_directory, "历史版本")
    current_dir, current_manifest = _read_manifest(current_directory, "当前版本")
    output_directory.mkdir(parents=True, exist_ok=True)
    output_dir = output_directory.resolve(strict=True)
    if output_dir != current_dir:
        # Worker 支持独立测试输出目录，但不允许写入历史快照目录。
        try:
            output_dir.relative_to(current_dir)
        except ValueError:
            pass
    if output_dir == base_dir:
        raise ValueError("差异结果不能写入历史版本快照目录")

    base_parts = _manifest_parts(base_dir, base_manifest, "历史版本")
    current_parts = _manifest_parts(current_dir, current_manifest, "当前版本")
    if not base_parts and not current_parts:
        raise ValueError("历史版本和当前版本都没有可比较的 STEP 零件")

    _remove_previous_outputs(output_dir)
    outputs: list[str] = []
    part_results: list[dict[str, Any]] = []
    ordered_ids = list(base_parts)
    ordered_ids.extend(part_id for part_id in current_parts if part_id not in base_parts)

    for index, part_id in enumerate(ordered_ids, start=1):
        base_part = base_parts.get(part_id)
        current_part = current_parts.get(part_id)
        base_model = _load_step(base_part["stepPath"], "历史版本") if base_part else None
        current_model = _load_step(current_part["stepPath"], "当前版本") if current_part else None
        base_volume = float(_model_metrics(base_model)["volumeMm3"]) if base_model else 0.0
        current_volume = float(_model_metrics(current_model)["volumeMm3"]) if current_model else 0.0
        tolerance = max(
            MINIMUM_VOLUME_TOLERANCE_MM3,
            max(base_volume, current_volume, 1.0) * VOLUME_TOLERANCE_RATIO,
        )

        if current_model is None:
            added_model = cq.Workplane("XY").newObject([cq.Compound.makeCompound([])])
            removed_model = base_model
            change_type = "removed-part"
        elif base_model is None:
            added_model = current_model
            removed_model = cq.Workplane("XY").newObject([cq.Compound.makeCompound([])])
            change_type = "added-part"
        else:
            added_model = _difference_model(current_model, base_model, f"零件“{part_id}”新增区域")
            removed_model = _difference_model(base_model, current_model, f"零件“{part_id}”删除区域")
            change_type = "modified"

        token = _safe_part_token(part_id, index)
        added_file, added_metrics = _export_difference(
            added_model,
            output_dir,
            f"version-difference-{token}-added.stl",
            tolerance,
            f"零件“{part_id}”新增区域",
        )
        removed_file, removed_metrics = _export_difference(
            removed_model,
            output_dir,
            f"version-difference-{token}-removed.stl",
            tolerance,
            f"零件“{part_id}”删除区域",
        )
        if added_file:
            outputs.append(added_file)
        if removed_file:
            outputs.append(removed_file)
        changed = added_file is not None or removed_file is not None
        if not changed:
            change_type = "unchanged"
        descriptor = current_part or base_part
        part_results.append(
            {
                "id": part_id,
                "label": descriptor["label"],
                "role": descriptor["role"],
                "changeType": change_type,
                "addedStlFile": added_file,
                "removedStlFile": removed_file,
                "metrics": {
                    "baseVolumeMm3": round(base_volume, 6),
                    "currentVolumeMm3": round(current_volume, 6),
                    "addedVolumeMm3": added_metrics["volumeMm3"],
                    "removedVolumeMm3": removed_metrics["volumeMm3"],
                    "addedSolidCount": added_metrics["solidCount"],
                    "removedSolidCount": removed_metrics["solidCount"],
                    "volumeToleranceMm3": round(tolerance, 9),
                    "changed": changed,
                },
            }
        )

    result = {
        "status": "ok",
        "revision": str(time_ns()),
        "units": "mm",
        "kernel": KERNEL_NAME,
        "method": METHOD_NAME,
        "baseRevision": str(base_manifest.get("revision", "")),
        "currentRevision": str(current_manifest.get("revision", "")),
        "outputs": outputs,
        "summary": {
            "partCount": len(part_results),
            "changedPartCount": sum(bool(part["metrics"]["changed"]) for part in part_results),
            "addedVolumeMm3": round(sum(float(part["metrics"]["addedVolumeMm3"]) for part in part_results), 6),
            "removedVolumeMm3": round(sum(float(part["metrics"]["removedVolumeMm3"]) for part in part_results), 6),
        },
        "parts": part_results,
    }
    (output_dir / RESULT_FILE_NAME).write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-directory", type=Path, required=True, help="历史版本快照目录")
    parser.add_argument("--current-directory", type=Path, required=True, help="当前 artifacts 目录")
    parser.add_argument("--output", type=Path, required=True, help="差异文件输出目录")
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    result = compare_version_geometry(
        arguments.base_directory,
        arguments.current_directory,
        arguments.output,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error)) from error
