#!/usr/bin/env python3
"""从受管版本快照安全恢复任意上传 STL 的工作文件。"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path
from time import time_ns

from cadquery import importers

from local_stl_edit import _commit_files_with_rollback
from split_and_cap import _closed_solids, import_stl_as_solid

ALLOWED_MODEL_FILES = (
    "imported-model.stl",
    "imported-model-working.stl",
    "imported-model-working.step",
)
MANIFEST_FILE_NAME = "imported-model-result.json"
RESULT_FILE_NAME = "uploaded-model-restore-result.json"


def _read_json(path: Path, label: str) -> dict[str, object]:
    """读取并校验 JSON 对象，错误信息保持为中文。"""

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"版本快照缺少{label}：{path.name}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"版本快照{label}无法读取：{error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"版本快照{label}必须是 JSON 对象")
    return value


def _safe_snapshot_file(snapshot_dir: Path, file_name: str) -> Path:
    """只允许读取快照根目录中的固定普通文件，拒绝路径穿越与符号链接逃逸。"""

    if file_name not in (*ALLOWED_MODEL_FILES, MANIFEST_FILE_NAME):
        raise ValueError(f"版本快照包含不允许恢复的文件：{file_name}")
    try:
        path = (snapshot_dir / file_name).resolve(strict=True)
        root = snapshot_dir.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"版本快照缺少模型文件：{file_name}") from error
    if path.parent != root or not path.is_file():
        raise ValueError(f"版本快照模型文件不允许指向快照目录之外：{file_name}")
    return path


def _validate_manifest(snapshot_dir: Path, expected_revision: str) -> dict[str, object]:
    """校验上传模型清单、修订绑定和固定输出文件集合。"""

    manifest = _read_json(_safe_snapshot_file(snapshot_dir, MANIFEST_FILE_NAME), "上传模型清单")
    if manifest.get("status") != "ok" or manifest.get("sourceKind") != "uploaded-stl":
        raise ValueError("版本快照上传模型清单格式无效")
    if manifest.get("id") != "uploaded-model":
        raise ValueError("版本快照上传模型标识无效")
    revision = manifest.get("revision")
    if not isinstance(revision, str) or not revision.strip():
        raise ValueError("版本快照上传模型修订号无效")
    if revision != expected_revision:
        raise ValueError("版本记录与上传模型快照修订号不一致，已拒绝恢复")
    if manifest.get("sourceFile") != "imported-model-working.stl":
        raise ValueError("版本快照工作 STL 文件声明无效")
    if manifest.get("originalSourceFile") != "imported-model.stl":
        raise ValueError("版本快照原始 STL 文件声明无效")
    outputs = manifest.get("outputs")
    if not isinstance(outputs, list) or any(not isinstance(value, str) for value in outputs):
        raise ValueError("版本快照上传模型输出列表无效")
    output_names = list(dict.fromkeys(outputs))
    if set(output_names) != set(ALLOWED_MODEL_FILES):
        raise ValueError("版本快照上传模型输出必须完整包含原始 STL、工作 STL 和工作 STEP")
    for file_name in ALLOWED_MODEL_FILES:
        _safe_snapshot_file(snapshot_dir, file_name)
    return manifest


def _validate_snapshot_geometry(snapshot_dir: Path, manifest: dict[str, object]) -> dict[str, object]:
    """使用 OpenCascade 复核 STL 与 STEP 的有效性、封闭性、Solid 数量和体积一致性。"""

    stl_path = _safe_snapshot_file(snapshot_dir, "imported-model-working.stl")
    step_path = _safe_snapshot_file(snapshot_dir, "imported-model-working.step")
    stl_model, stl_validation = import_stl_as_solid(stl_path)
    if stl_validation.repair.repaired:
        raise ValueError("版本快照工作 STL 需要自动修洞或清理才能封闭，已拒绝恢复")
    stl_solids = _closed_solids(stl_model, "版本快照工作 STL")

    try:
        step_model = importers.importStep(str(step_path))
    except Exception as error:
        raise ValueError(f"版本快照工作 STEP 无法由 OpenCascade 读取：{error}") from error
    step_solids = _closed_solids(step_model, "版本快照工作 STEP")
    if len(step_solids) != len(stl_solids):
        raise ValueError(
            f"版本快照 STL 与 STEP 的 Solid 数量不一致：{len(stl_solids)} 与 {len(step_solids)}"
        )
    step_volume = sum(solid.Volume() for solid in step_solids)
    allowed_volume_error = max(0.01, stl_validation.volume_mm3 * 5e-5)
    if not math.isfinite(step_volume) or abs(step_volume - stl_validation.volume_mm3) > allowed_volume_error:
        raise ValueError("版本快照 STL 与 STEP 的体积不一致，已拒绝恢复")

    metrics = manifest.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("版本快照上传模型清单缺少几何指标")
    declared_solid_count = metrics.get("solidCount")
    declared_volume = metrics.get("volumeMm3")
    if declared_solid_count != len(stl_solids):
        raise ValueError("版本快照清单声明的 Solid 数量与模型不一致")
    if not isinstance(declared_volume, (int, float)) or not math.isfinite(float(declared_volume)):
        raise ValueError("版本快照清单声明的体积无效")
    if abs(float(declared_volume) - stl_validation.volume_mm3) > allowed_volume_error:
        raise ValueError("版本快照清单声明的体积与模型不一致")

    return {
        "valid": True,
        "watertight": True,
        "solidCount": len(stl_solids),
        "volumeMm3": stl_validation.volume_mm3,
        "stepVolumeMm3": step_volume,
        "triangleCount": stl_validation.triangle_count,
    }


def restore_uploaded_model_snapshot(
    snapshot_dir: Path,
    output_dir: Path,
    expected_revision: str,
) -> dict[str, object]:
    """校验完整快照后，以临时文件和批量回滚原子替换当前上传模型。"""

    if not expected_revision.strip():
        raise ValueError("待恢复的上传模型修订号不能为空")
    snapshot_dir = snapshot_dir.resolve(strict=True)
    if not snapshot_dir.is_dir():
        raise ValueError("版本快照目录不存在")
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest = _validate_manifest(snapshot_dir, expected_revision)
    validation = _validate_snapshot_geometry(snapshot_dir, manifest)
    operation_revision = str(time_ns())
    temporary_paths: list[Path] = []
    replacements: list[tuple[Path, Path]] = []

    try:
        for file_name in ALLOWED_MODEL_FILES:
            temporary = output_dir / f".{file_name}-{operation_revision}.restore"
            shutil.copy2(_safe_snapshot_file(snapshot_dir, file_name), temporary)
            temporary_paths.append(temporary)
            replacements.append((temporary, output_dir / file_name))

        manifest_temp = output_dir / f".{MANIFEST_FILE_NAME}-{operation_revision}.restore"
        manifest_temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_paths.append(manifest_temp)
        replacements.append((manifest_temp, output_dir / MANIFEST_FILE_NAME))

        result: dict[str, object] = {
            "status": "ok",
            "operation": "restore-uploaded-model-snapshot",
            "restoredRevision": expected_revision,
            "sourceKind": "uploaded-stl",
            "updatedModel": manifest,
            "validation": validation,
            "restoredFiles": [*ALLOWED_MODEL_FILES, MANIFEST_FILE_NAME],
            "limitations": [
                "只允许恢复 FormAI 受管版本目录中的上传模型快照",
                "恢复前已复核 STL 与 STEP 的有效性、封闭性、Solid 数量和体积一致性",
                "恢复过程使用临时文件、原子替换和失败回滚，不接受任意外部路径",
            ],
        }
        result_temp = output_dir / f".{RESULT_FILE_NAME}-{operation_revision}.restore"
        result_temp.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_paths.append(result_temp)
        replacements.append((result_temp, output_dir / RESULT_FILE_NAME))

        _commit_files_with_rollback(replacements, operation_revision)
        return result
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="恢复 FormAI 受管上传模型版本快照")
    parser.add_argument("--snapshot", type=Path, required=True, help="已由宿主校验的版本快照目录")
    parser.add_argument("--output", type=Path, required=True, help="当前模型输出目录")
    parser.add_argument("--expected-revision", required=True, help="版本记录绑定的上传模型修订号")
    args = parser.parse_args()
    try:
        result = restore_uploaded_model_snapshot(args.snapshot, args.output, args.expected_revision)
    except (ValueError, OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
