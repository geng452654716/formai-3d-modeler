"""拆分封闭 STEP/STL 模型，自动生成切割补面并验证可打印实体。"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from time import time_ns
from typing import Literal

import cadquery as cq
from cadquery import exporters
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.StlAPI import StlAPI_Reader
from OCP.TopoDS import TopoDS_Shape

from manufacturing_features import (
    FastenerType,
    JointType,
    ScrewSize,
    apply_manufacturing_features,
    feature_validation_json,
)
from stl_mesh_repair import MeshRepairReport, repair_report_json, repair_stl_mesh

SplitAxis = Literal["x", "y", "z"]
SourceKind = Literal["cad-part", "uploaded-stl"]


@dataclass(frozen=True)
class SplitValidation:
    """一次精确拆件的毫米制测量与封闭性验证结果。"""

    axis: SplitAxis
    offset_mm: float
    original_volume_mm3: float
    negative_volume_mm3: float
    positive_volume_mm3: float
    volume_error_mm3: float
    negative_solid_count: int
    positive_solid_count: int
    negative_cap_faces: int
    positive_cap_faces: int


@dataclass(frozen=True)
class ImportedStlValidation:
    """上传 STL 转换为 OpenCascade 分面实体后的验证结果。"""

    triangle_count: int
    solid_count: int
    volume_mm3: float
    bounds: cq.BoundBox
    repair: MeshRepairReport


def _coordinate(bounds: cq.BoundBox, axis: SplitAxis, side: str) -> float:
    return getattr(bounds, f"{axis}{side}")


def _closed_solids(model: cq.Workplane, label: str) -> list[cq.Solid]:
    shape = model.val()
    solids = shape.Solids()
    if not solids:
        raise ValueError(f"{label}没有生成封闭实体")
    if not shape.isValid() or not all(solid.isValid() for solid in solids):
        raise ValueError(f"{label}包含无效 OpenCascade 实体")
    if not all(solid.Shells() and all(shell.Closed() for shell in solid.Shells()) for solid in solids):
        raise ValueError(f"{label}存在未封闭外壳")
    if any(solid.Volume() <= 0 for solid in solids):
        raise ValueError(f"{label}包含零体积实体")
    return solids


def import_stl_as_solid(
    input_path: Path,
    sewing_tolerance_mm: float = 0.01,
    repaired_output_path: Path | None = None,
) -> tuple[cq.Workplane, ImportedStlValidation]:
    """诊断并修复简单孔洞，再缝合为一个或多个可布尔运算的分面实体。

    这里不假定模型类型、零件名称或外壳结构。任意几何内容都可以上传，
    简单、独立、近似共面的开放孔洞会自动补面。非流形、分叉边界、嵌套
    轮廓、明显非共面破面或复杂自交仍会明确拒绝，避免输出伪造结果。
    """

    if input_path.suffix.lower() != ".stl":
        raise ValueError("上传拆件当前只接受 STL 文件")
    if not input_path.is_file():
        raise ValueError(f"没有找到待拆 STL 文件：{input_path}")
    if input_path.stat().st_size == 0:
        raise ValueError("上传的 STL 文件为空")

    temporary_directory: tempfile.TemporaryDirectory[str] | None = None
    repair_target = repaired_output_path
    if repair_target is None:
        temporary_directory = tempfile.TemporaryDirectory(prefix="formai-stl-repair-")
        repair_target = Path(temporary_directory.name) / "repaired.stl"

    try:
        repair_result = repair_stl_mesh(input_path, repair_target)
        working_path = repair_target if repair_result.report.repaired else input_path

        raw_shape = TopoDS_Shape()
        if not StlAPI_Reader().Read(raw_shape, str(working_path)):
            raise ValueError("无法读取 STL，请确认文件是有效的二进制或 ASCII STL")
        raw_model = cq.Shape.cast(raw_shape)
        triangle_count = len(raw_model.Faces())

        sewing = BRepBuilderAPI_Sewing(sewing_tolerance_mm, True, True, True, False)
        sewing.Add(raw_shape)
        sewing.Perform()
        sewed_shape = cq.Shape.cast(sewing.SewedShape())
        shells = sewed_shape.Shells()
        if not shells:
            raise ValueError("STL 网格无法缝合为外壳，请检查破面、重复面或非流形边")
        if any(not shell.Closed() for shell in shells):
            raise ValueError("STL 不是封闭网格；简单孔洞修复后仍有开放边，无法进行拆件")

        solids: list[cq.Solid] = []
        for shell in shells:
            maker = BRepBuilderAPI_MakeSolid()
            maker.Add(shell.wrapped)
            solid = cq.Shape.cast(maker.Solid())
            if not isinstance(solid, cq.Solid) or not solid.isValid() or solid.Volume() <= 0:
                raise ValueError("STL 外壳无法转换为有效实体，请检查法线、自相交和非流形结构")
            solids.append(solid)

        compound = cq.Compound.makeCompound(solids)
        model = cq.Workplane("XY").newObject([compound])
        validated_solids = _closed_solids(model, "上传 STL")
        validation = ImportedStlValidation(
            triangle_count=triangle_count,
            solid_count=len(validated_solids),
            volume_mm3=sum(solid.Volume() for solid in validated_solids),
            bounds=model.val().BoundingBox(),
            repair=repair_result.report,
        )
        return model, validation
    finally:
        if temporary_directory is not None:
            temporary_directory.cleanup()


def _cap_face_count(model: cq.Workplane, axis: SplitAxis, offset_mm: float, tolerance: float) -> int:
    index = {"x": 0, "y": 1, "z": 2}[axis]
    count = 0
    for face in model.val().Faces():
        if face.geomType() != "PLANE":
            continue
        center = face.Center().toTuple()[index]
        if abs(center - offset_mm) <= tolerance:
            count += 1
    return count


def _clipping_box(
    bounds: cq.BoundBox,
    axis: SplitAxis,
    offset_mm: float,
    keep_negative: bool,
) -> cq.Workplane:
    spans = {"x": bounds.xlen, "y": bounds.ylen, "z": bounds.zlen}
    margin = max(spans.values()) + 10.0
    minimums = {"x": bounds.xmin - margin, "y": bounds.ymin - margin, "z": bounds.zmin - margin}
    maximums = {"x": bounds.xmax + margin, "y": bounds.ymax + margin, "z": bounds.zmax + margin}
    if keep_negative:
        maximums[axis] = offset_mm
    else:
        minimums[axis] = offset_mm

    sizes = {name: maximums[name] - minimums[name] for name in ("x", "y", "z")}
    centers = {name: (maximums[name] + minimums[name]) / 2 for name in ("x", "y", "z")}
    return (
        cq.Workplane("XY")
        .box(sizes["x"], sizes["y"], sizes["z"])
        .translate((centers["x"], centers["y"], centers["z"]))
    )


def split_solid_with_caps(
    model: cq.Workplane,
    axis: SplitAxis,
    offset_mm: float,
    volume_tolerance_ratio: float = 1e-6,
) -> tuple[cq.Workplane, cq.Workplane, SplitValidation]:
    """用两个半空间包围盒拆分封闭实体，并拒绝开放、无效或丢失体积的结果。"""

    if axis not in ("x", "y", "z"):
        raise ValueError("拆件轴只能是 x、y 或 z")
    if not isinstance(offset_mm, (int, float)):
        raise ValueError("拆件平面偏移必须是毫米数值")

    original_solids = _closed_solids(model, "原模型")
    original_volume = sum(solid.Volume() for solid in original_solids)
    bounds = model.val().BoundingBox()
    minimum = _coordinate(bounds, axis, "min")
    maximum = _coordinate(bounds, axis, "max")
    linear_tolerance = max(1e-6, max(bounds.xlen, bounds.ylen, bounds.zlen) * 1e-7)
    if not minimum + linear_tolerance < offset_mm < maximum - linear_tolerance:
        raise ValueError("拆件平面必须位于模型包围盒内部")

    negative = model.intersect(_clipping_box(bounds, axis, offset_mm, True))
    positive = model.intersect(_clipping_box(bounds, axis, offset_mm, False))
    negative_solids = _closed_solids(negative, "负方向拆件")
    positive_solids = _closed_solids(positive, "正方向拆件")
    negative_volume = sum(solid.Volume() for solid in negative_solids)
    positive_volume = sum(solid.Volume() for solid in positive_solids)
    volume_error = abs(original_volume - negative_volume - positive_volume)
    allowed_error = max(1e-5, original_volume * volume_tolerance_ratio)
    if volume_error > allowed_error:
        raise ValueError(
            f"拆件前后体积不守恒：误差 {volume_error:.6f} 立方毫米，允许 {allowed_error:.6f}"
        )

    negative_caps = _cap_face_count(negative, axis, offset_mm, linear_tolerance * 10)
    positive_caps = _cap_face_count(positive, axis, offset_mm, linear_tolerance * 10)
    if negative_caps == 0 or positive_caps == 0:
        raise ValueError("OpenCascade 未在拆件平面生成可验证的补面")

    validation = SplitValidation(
        axis=axis,
        offset_mm=float(offset_mm),
        original_volume_mm3=original_volume,
        negative_volume_mm3=negative_volume,
        positive_volume_mm3=positive_volume,
        volume_error_mm3=volume_error,
        negative_solid_count=len(negative_solids),
        positive_solid_count=len(positive_solids),
        negative_cap_faces=negative_caps,
        positive_cap_faces=positive_caps,
    )
    return negative, positive, validation


def export_split_parts(
    negative: cq.Workplane,
    positive: cq.Workplane,
    output_dir: Path,
    stem: str = "split-model",
) -> list[Path]:
    """将两个已验证拆件同时导出为 STEP 和 STL。"""

    output_dir.mkdir(parents=True, exist_ok=True)
    paths = [
        output_dir / f"{stem}-negative.step",
        output_dir / f"{stem}-positive.step",
        output_dir / f"{stem}-negative.stl",
        output_dir / f"{stem}-positive.stl",
    ]
    exporters.export(negative, str(paths[0]))
    exporters.export(positive, str(paths[1]))
    exporters.export(negative, str(paths[2]), tolerance=0.05)
    exporters.export(positive, str(paths[3]), tolerance=0.05)
    return paths


def _validation_json(validation: SplitValidation) -> dict[str, float | int | str]:
    """将拆件测量转换为桌面 API 使用的驼峰字段。"""

    return {
        "axis": validation.axis,
        "offsetMm": validation.offset_mm,
        "originalVolumeMm3": validation.original_volume_mm3,
        "negativeVolumeMm3": validation.negative_volume_mm3,
        "positiveVolumeMm3": validation.positive_volume_mm3,
        "volumeErrorMm3": validation.volume_error_mm3,
        "negativeSolidCount": validation.negative_solid_count,
        "positiveSolidCount": validation.positive_solid_count,
        "negativeCapFaces": validation.negative_cap_faces,
        "positiveCapFaces": validation.positive_cap_faces,
    }


def _bounds_json(bounds: cq.BoundBox) -> dict[str, float]:
    """返回用于视口归一化和打印尺寸检查的包围盒数据。"""

    return {
        "minX": bounds.xmin,
        "minY": bounds.ymin,
        "minZ": bounds.zmin,
        "maxX": bounds.xmax,
        "maxY": bounds.ymax,
        "maxZ": bounds.zmax,
        "x": bounds.xlen,
        "y": bounds.ylen,
        "z": bounds.zlen,
    }


def inspect_stl_file(
    input_path: Path,
    output_dir: Path,
    stem: str = "imported-model",
    original_file_name: str = "",
) -> dict[str, object]:
    """校验上传 STL 并持久化与具体模型类型无关的导入清单。"""

    output_dir.mkdir(parents=True, exist_ok=True)
    repaired_path = output_dir / f"{stem}-repaired.stl"
    model, validation = import_stl_as_solid(input_path, repaired_output_path=repaired_path)
    working_stl = output_dir / f"{stem}-working.stl"
    working_step = output_dir / f"{stem}-working.step"
    shutil.copy2(repaired_path if validation.repair.repaired else input_path, working_stl)
    exporters.export(model, str(working_step))
    repaired_path.unlink(missing_ok=True)

    working_path = working_stl
    output_paths = [input_path, working_stl, working_step]
    summary: dict[str, object] = {
        "status": "ok",
        "revision": str(time_ns()),
        "id": "uploaded-model",
        "name": Path(original_file_name or input_path.name).stem or "上传模型",
        "originalFileName": original_file_name or input_path.name,
        "sourceFile": working_path.name,
        "originalSourceFile": input_path.name,
        "sourceKind": "uploaded-stl",
        "units": "mm",
        "kernel": "OpenCascade 7.8 / CadQuery 2.6 / STL 分面实体",
        "outputs": [path.name for path in output_paths],
        "files": {path.name: {"bytes": path.stat().st_size} for path in output_paths},
        "metrics": {
            "valid": True,
            "watertight": True,
            "triangleCount": validation.triangle_count,
            "solidCount": validation.solid_count,
            "volumeMm3": validation.volume_mm3,
            "boundsMm": _bounds_json(validation.bounds),
            "repair": repair_report_json(validation.repair),
        },
    }
    result_path = output_dir / f"{stem}-result.json"
    result_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def split_model_file(
    input_path: Path,
    output_dir: Path,
    axis: SplitAxis,
    offset_mm: float,
    stem: str = "manufacturing",
    source_part_id: str = "",
    source_kind: SourceKind = "cad-part",
    joint_type: JointType = "round-pin",
    fastener_type: FastenerType = "none",
    screw_size: ScrewSize = "M3",
    clearance_mm: float = 0.25,
    apply_features: bool = False,
) -> dict[str, object]:
    """导入任意封闭 STEP/STL 模型，拆分、补面并写入精确连接结构。"""

    suffix = input_path.suffix.lower()
    if not input_path.is_file():
        raise ValueError(f"没有找到待拆模型文件：{input_path}")
    if suffix in (".step", ".stp"):
        model = cq.importers.importStep(str(input_path))
        source_format = "step"
    elif suffix == ".stl":
        model, _ = import_stl_as_solid(input_path)
        source_format = "stl"
    else:
        raise ValueError("拆件当前支持 STEP、STP 和 STL 文件")

    negative, positive, validation = split_solid_with_caps(model, axis, offset_mm)
    feature_summary: dict[str, object] | None = None
    if apply_features:
        negative, positive, feature_validation = apply_manufacturing_features(
            negative=negative,
            positive=positive,
            axis=axis,
            offset_mm=offset_mm,
            joint_type=joint_type,
            fastener_type=fastener_type,
            screw_size=screw_size,
            clearance_mm=clearance_mm,
        )
        feature_summary = feature_validation_json(feature_validation, axis)
    output_paths = export_split_parts(negative, positive, output_dir, stem)
    files = {path.name: {"bytes": path.stat().st_size} for path in output_paths}
    summary: dict[str, object] = {
        "status": "ok",
        "revision": str(time_ns()),
        "sourcePartId": source_part_id,
        "sourceKind": source_kind,
        "sourceFormat": source_format,
        "sourceFile": input_path.name,
        "units": "mm",
        "kernel": "OpenCascade 7.8 / CadQuery 2.6",
        "outputs": [path.name for path in output_paths],
        "files": files,
        "validation": _validation_json(validation),
    }
    if feature_summary is not None:
        summary["features"] = feature_summary
    result_path = output_dir / f"{stem}-result.json"
    result_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return summary


# 保留旧函数名，兼容现有测试和外部脚本；实际实现已经支持 STEP 与 STL。
def split_step_file(
    input_path: Path,
    output_dir: Path,
    axis: SplitAxis,
    offset_mm: float,
    stem: str = "manufacturing",
    source_part_id: str = "",
) -> dict[str, object]:
    return split_model_file(
        input_path,
        output_dir,
        axis,
        offset_mm,
        stem,
        source_part_id,
        "cad-part",
        fastener_type="none",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="待拆分或检查的 STEP/STL 模型")
    parser.add_argument("--output", type=Path, required=True, help="结果输出目录")
    parser.add_argument("--axis", choices=("x", "y", "z"), default="x", help="切割平面法向轴")
    parser.add_argument("--offset", type=float, default=0.0, help="切割平面在所选轴上的毫米坐标")
    parser.add_argument("--stem", default="manufacturing", help="输出文件名前缀")
    parser.add_argument("--source-part-id", default="", help="来源模型或零件 ID")
    parser.add_argument(
        "--source-kind",
        choices=("cad-part", "uploaded-stl"),
        default="cad-part",
        help="来源类型",
    )
    parser.add_argument("--inspect-only", action="store_true", help="只校验上传 STL，不执行拆件")
    parser.add_argument("--original-file-name", default="", help="用户上传时的原始文件名")
    parser.add_argument(
        "--joint-type",
        choices=("round-pin", "d-pin", "dovetail", "ball-socket", "magnet"),
        default="round-pin",
        help="写入拆件实体的连接结构",
    )
    parser.add_argument(
        "--fastener-type",
        choices=(
            "none",
            "screw-boss",
            "snap-fit",
            "threaded-hole",
            "external-thread",
            "iso-threaded-hole",
            "iso-external-thread",
        ),
        default="none",
        help="写入拆件实体的紧固结构",
    )
    parser.add_argument("--screw-size", choices=("M2", "M2.5", "M3"), default="M3", help="螺丝柱规格")
    parser.add_argument("--clearance", type=float, default=0.25, help="公母结构单边装配间隙，单位毫米")
    parser.add_argument("--apply-features", action="store_true", help="将连接和紧固结构布尔写入拆件实体")
    return parser.parse_args()


def main() -> int:
    """执行命令行 Worker，并确保传给软件界面的错误保持简洁中文。"""

    arguments = parse_args()
    try:
        if arguments.inspect_only:
            inspect_stl_file(
                input_path=arguments.input,
                output_dir=arguments.output,
                stem=arguments.stem,
                original_file_name=arguments.original_file_name,
            )
        else:
            split_model_file(
                input_path=arguments.input,
                output_dir=arguments.output,
                axis=arguments.axis,
                offset_mm=arguments.offset,
                stem=arguments.stem,
                source_part_id=arguments.source_part_id,
                source_kind=arguments.source_kind,
                joint_type=arguments.joint_type,
                fastener_type=arguments.fastener_type,
                screw_size=arguments.screw_size,
                clearance_mm=arguments.clearance,
                apply_features=arguments.apply_features,
            )
        return 0
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("模型处理失败：CAD 内核未完成请求，请检查模型文件后重试", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
