"""沿上传 STL 的局部表面法向执行可验证的圆柱加料或切除。"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path
from time import time_ns
from typing import Literal

import cadquery as cq
from cadquery import exporters

from split_and_cap import _bounds_json, _closed_solids, import_stl_as_solid

Operation = Literal["add-cylinder", "cut-cylinder"]


def _unit_vector(x: float, y: float, z: float) -> cq.Vector:
    """校验并归一化用户选中表面的内法向。"""

    if not all(math.isfinite(value) for value in (x, y, z)):
        raise ValueError("局部表面法向必须是有限数值")
    length = math.sqrt(x * x + y * y + z * z)
    if length < 0.5:
        raise ValueError("局部表面法向无效，请重新执行壁厚分析并选择区域")
    return cq.Vector(x / length, y / length, z / length)


def _load_import_manifest(output_dir: Path) -> dict[str, object]:
    """读取上传模型清单，以保留用户原始文件和修复记录。"""

    manifest_path = output_dir / "imported-model-result.json"
    if not manifest_path.is_file():
        raise ValueError("没有找到上传模型清单，请重新上传 STL")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"上传模型清单无法读取：{error}") from error
    if manifest.get("status") != "ok" or manifest.get("sourceKind") != "uploaded-stl":
        raise ValueError("上传模型清单格式无效，请重新上传 STL")
    return manifest


def _existing_output_names(manifest: dict[str, object], output_dir: Path) -> list[str]:
    outputs = manifest.get("outputs")
    names = [value for value in outputs if isinstance(value, str)] if isinstance(outputs, list) else []
    return [name for name in names if Path(name).name == name and (output_dir / name).is_file()]


def _commit_files_with_rollback(
    replacements: list[tuple[Path, Path]], revision: str
) -> None:
    """批量替换工作文件；任一步失败时尽力恢复全部旧文件。"""

    backups: list[tuple[Path, Path | None]] = []
    for _, target in replacements:
        backup = target.with_name(f".{target.name}-{revision}.backup") if target.exists() else None
        if backup is not None:
            shutil.copy2(target, backup)
        backups.append((target, backup))

    try:
        for temporary, target in replacements:
            temporary.replace(target)
    except Exception as error:
        rollback_errors: list[str] = []
        for target, backup in reversed(backups):
            try:
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    backup.replace(target)
            except OSError as rollback_error:
                rollback_errors.append(f"{target.name}: {rollback_error}")
        if rollback_errors:
            details = "；".join(rollback_errors)
            raise RuntimeError(f"局部模型文件更新失败，且回滚未完整完成：{details}") from error
        raise
    finally:
        for _, backup in backups:
            if backup is not None:
                backup.unlink(missing_ok=True)


def edit_uploaded_stl(
    input_path: Path,
    output_dir: Path,
    operation: Operation,
    center: tuple[float, float, float],
    inward_normal: tuple[float, float, float],
    radius_mm: float,
    depth_mm: float,
    command: str = "",
) -> dict[str, object]:
    """执行第一版局部实体修改，并以带回滚的批量替换更新工作文件。"""

    if operation not in ("add-cylinder", "cut-cylinder"):
        raise ValueError("局部 STL 修改操作无效")
    if not all(math.isfinite(value) for value in center):
        raise ValueError("局部修改中心坐标必须是有限毫米数值")
    if not math.isfinite(radius_mm) or not 0.5 <= radius_mm <= 100.0:
        raise ValueError("局部圆形区域半径必须在 0.50 至 100.00 毫米之间")
    if not math.isfinite(depth_mm) or not 0.2 <= depth_mm <= 200.0:
        raise ValueError("局部修改深度必须在 0.20 至 200.00 毫米之间")
    if not input_path.is_file():
        raise ValueError(f"没有找到当前上传模型工作文件：{input_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_import_manifest(output_dir)
    model, _ = import_stl_as_solid(input_path)
    source_solids = _closed_solids(model, "当前上传模型")
    if len(source_solids) != 1:
        raise ValueError("局部实体修改第一版只支持单一封闭 Solid；多实体模型请先拆分后分别处理")

    inward = _unit_vector(*inward_normal)
    outward = inward.multiply(-1.0)
    point = cq.Vector(*center)
    bounds = model.val().BoundingBox()
    diagonal = math.sqrt(bounds.xlen**2 + bounds.ylen**2 + bounds.zlen**2)
    overlap_mm = max(0.05, min(0.25, diagonal * 0.002))

    if operation == "add-cylinder":
        start = point.add(inward.multiply(overlap_mm))
        tool = cq.Solid.makeCylinder(radius_mm, depth_mm + overlap_mm, start, outward)
        edited = model.union(tool, clean=True).clean()
        operation_label = "局部圆形凸台加厚"
    else:
        start = point.add(outward.multiply(overlap_mm))
        tool = cq.Solid.makeCylinder(radius_mm, depth_mm + overlap_mm, start, inward)
        edited = model.cut(tool).clean()
        operation_label = "局部圆孔切除"

    result_solids = _closed_solids(edited, operation_label)
    if len(result_solids) != 1:
        raise ValueError(f"{operation_label}后产生 {len(result_solids)} 个 Solid，已拒绝写回以避免模型断裂")

    volume_before = source_solids[0].Volume()
    volume_after = result_solids[0].Volume()
    volume_delta = volume_after - volume_before
    volume_tolerance = max(1e-4, volume_before * 1e-8)
    if operation == "add-cylinder" and volume_delta <= volume_tolerance:
        raise ValueError("圆形凸台与模型没有形成有效相交，未检测到体积增加，请重新选择表面区域")
    if operation == "cut-cylinder" and volume_delta >= -volume_tolerance:
        raise ValueError("圆孔切除没有进入模型实体，未检测到体积减少，请重新选择表面区域")

    revision = str(time_ns())
    working_stl = output_dir / "imported-model-working.stl"
    working_step = output_dir / "imported-model-working.step"
    imported_manifest_path = output_dir / "imported-model-result.json"
    edit_result_path = output_dir / "local-stl-edit-result.json"
    temporary_stl = output_dir / f".imported-model-working-{revision}.stl"
    temporary_step = output_dir / f".imported-model-working-{revision}.step"
    imported_temp = output_dir / f".imported-model-result-{revision}.json"
    edit_temp = output_dir / f".local-stl-edit-result-{revision}.json"
    temporary_paths = (temporary_stl, temporary_step, imported_temp, edit_temp)

    try:
        exporters.export(edited, str(temporary_step))
        exporters.export(edited, str(temporary_stl), tolerance=0.05)
        verified_model, verified = import_stl_as_solid(temporary_stl)
        verified_solids = _closed_solids(verified_model, "局部修改导出模型")
        if len(verified_solids) != 1:
            raise ValueError("局部修改导出后不再是单一封闭 Solid，已拒绝覆盖工作模型")
        exported_volume = verified_solids[0].Volume()
        allowed_export_error = max(0.01, volume_after * 5e-5)
        if abs(exported_volume - volume_after) > allowed_export_error:
            raise ValueError("局部修改 STL 导出体积误差超限，已拒绝覆盖工作模型")

        existing_outputs = _existing_output_names(manifest, output_dir)
        output_names = list(dict.fromkeys([*existing_outputs, working_stl.name, working_step.name]))
        pending_files = {
            working_stl.name: temporary_stl,
            working_step.name: temporary_step,
        }
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
            "kernel": "OpenCascade 7.8 / CadQuery 2.6 / STL 分面实体",
            "outputs": output_names,
            "files": files,
            "metrics": {
                "valid": True,
                "watertight": True,
                "triangleCount": verified.triangle_count,
                "solidCount": 1,
                "volumeMm3": exported_volume,
                "boundsMm": _bounds_json(verified.bounds),
                "repair": old_metrics.get("repair", {}),
            },
        }

        result: dict[str, object] = {
            "status": "ok",
            "revision": revision,
            "operation": operation,
            "command": command,
            "sourceFile": working_stl.name,
            "stepFile": working_step.name,
            "outputs": [working_stl.name, working_step.name],
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "validation": {
                "valid": True,
                "watertight": True,
                "solidCount": 1,
                "volumeBeforeMm3": volume_before,
                "volumeAfterMm3": exported_volume,
                "volumeDeltaMm3": exported_volume - volume_before,
                "boundsMm": _bounds_json(verified.bounds),
            },
            "updatedModel": updated_model,
            "limitations": [
                "第一版仅支持沿选中表面法向的局部圆形凸台加厚和圆孔切除",
                "不支持任意自由曲面重建、网格雕刻、复杂非流形或自相交修复",
                "结果已通过 OpenCascade 有效性、封闭性、单 Solid 和体积方向检查",
            ],
        }

        imported_temp.write_text(json.dumps(updated_model, ensure_ascii=False, indent=2), encoding="utf-8")
        edit_temp.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        _commit_files_with_rollback(
            [
                (temporary_stl, working_stl),
                (temporary_step, working_step),
                (imported_temp, imported_manifest_path),
                (edit_temp, edit_result_path),
            ],
            revision,
        )
    finally:
        for temporary_path in temporary_paths:
            temporary_path.unlink(missing_ok=True)

    print(json.dumps(result, ensure_ascii=False))
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="当前上传 STL 工作文件")
    parser.add_argument("--output", type=Path, required=True, help="结果输出目录")
    parser.add_argument("--operation", choices=("add-cylinder", "cut-cylinder"), required=True)
    parser.add_argument("--center-x", type=float, required=True)
    parser.add_argument("--center-y", type=float, required=True)
    parser.add_argument("--center-z", type=float, required=True)
    parser.add_argument("--normal-x", type=float, required=True)
    parser.add_argument("--normal-y", type=float, required=True)
    parser.add_argument("--normal-z", type=float, required=True)
    parser.add_argument("--radius", type=float, required=True, help="圆形区域半径，单位毫米")
    parser.add_argument("--depth", type=float, required=True, help="加料高度或切除深度，单位毫米")
    parser.add_argument("--command", default="", help="触发本次修改的中文指令")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        edit_uploaded_stl(
            input_path=arguments.input,
            output_dir=arguments.output,
            operation=arguments.operation,
            center=(arguments.center_x, arguments.center_y, arguments.center_z),
            inward_normal=(arguments.normal_x, arguments.normal_y, arguments.normal_z),
            radius_mm=arguments.radius,
            depth_mm=arguments.depth,
            command=arguments.command,
        )
        return 0
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - 输出具体中文边界便于本机诊断。
        print(f"局部 STL 修改失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
