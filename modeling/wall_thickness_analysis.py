"""对任意封闭 STEP/STL 模型执行全局壁厚采样和风险分级。"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from time import time_ns
from typing import Literal

import cadquery as cq
import numpy as np
from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

from split_and_cap import _closed_solids, import_stl_as_solid

SourceKind = Literal["cad-part", "uploaded-stl"]
Severity = Literal["critical", "thin", "recommended", "safe"]


@dataclass(frozen=True)
class ThicknessThresholds:
    """P1S、0.4 毫米喷嘴、PLA/PETG 的默认壁厚风险阈值。"""

    critical_mm: float = 0.8
    minimum_wall_mm: float = 1.2
    recommended_mm: float = 2.0


@dataclass(frozen=True)
class SurfaceSample:
    """一个三角化表面采样点及其指向实体内部的单位法向。"""

    point: np.ndarray
    inward_normal: np.ndarray


def _load_closed_model(input_path: Path) -> tuple[cq.Workplane, str]:
    """导入通用 STEP/STL，并拒绝开放、无效或零体积几何。"""

    if not input_path.is_file():
        raise ValueError(f"没有找到待分析模型文件：{input_path}")
    suffix = input_path.suffix.lower()
    if suffix in (".step", ".stp"):
        model = cq.importers.importStep(str(input_path))
        _closed_solids(model, "待分析模型")
        return model, "step"
    if suffix == ".stl":
        model, _ = import_stl_as_solid(input_path)
        _closed_solids(model, "待分析模型")
        return model, "stl"
    raise ValueError("壁厚分析当前支持 STEP、STP 和 STL 文件")


def _mesh_arrays(shape: cq.Shape) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """生成用于确定性表面采样的三角形、法向和面积数组。"""

    bounds = shape.BoundingBox()
    diagonal = math.sqrt(bounds.xlen**2 + bounds.ylen**2 + bounds.zlen**2)
    linear_tolerance = max(0.03, min(0.25, diagonal / 400.0))
    vertices, triangle_indices = shape.tessellate(linear_tolerance, 0.12)
    if not vertices or not triangle_indices:
        raise ValueError("模型表面无法三角化，不能执行壁厚分析")

    vertex_array = np.asarray([vertex.toTuple() for vertex in vertices], dtype=np.float64)
    indices = np.asarray(triangle_indices, dtype=np.int64)
    triangles = vertex_array[indices]
    cross_products = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    double_areas = np.linalg.norm(cross_products, axis=1)
    valid = double_areas > 1e-12
    if not np.any(valid):
        raise ValueError("模型三角化结果全部退化，不能执行壁厚分析")
    triangles = triangles[valid]
    double_areas = double_areas[valid]
    normals = cross_products[valid] / double_areas[:, None]
    return triangles, normals, double_areas * 0.5


def _deterministic_triangle_points(
    triangles: np.ndarray,
    normals: np.ndarray,
    areas: np.ndarray,
    sample_limit: int,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """按表面积分层选择三角形；同一大三角形可产生不同低差异采样点。"""

    sample_count = min(sample_limit, max(len(triangles), 1))
    if len(triangles) <= sample_count:
        points = triangles.mean(axis=1)
        return list(zip(points, normals, strict=True))

    cumulative = np.cumsum(areas)
    total_area = float(cumulative[-1])
    targets = (np.arange(sample_count, dtype=np.float64) + 0.5) * total_area / sample_count
    selected = np.searchsorted(cumulative, targets, side="left")
    samples: list[tuple[np.ndarray, np.ndarray]] = []
    golden_a = 0.6180339887498949
    golden_b = 0.7548776662466927
    for sample_index, triangle_index in enumerate(selected):
        triangle = triangles[int(triangle_index)]
        u = (0.5 + sample_index * golden_a) % 1.0
        v = (0.5 + sample_index * golden_b) % 1.0
        root_u = math.sqrt(0.08 + 0.84 * u)
        barycentric = np.asarray(
            [1.0 - root_u, root_u * (1.0 - v), root_u * v],
            dtype=np.float64,
        )
        point = barycentric @ triangle
        samples.append((point, normals[int(triangle_index)]))
    return samples


def _orient_inward_samples(
    shape: cq.Shape,
    candidates: list[tuple[np.ndarray, np.ndarray]],
) -> tuple[list[SurfaceSample], float]:
    """使用 OpenCascade 实体内部分类确定每个表面点的内法向。"""

    bounds = shape.BoundingBox()
    diagonal = math.sqrt(bounds.xlen**2 + bounds.ylen**2 + bounds.zlen**2)
    epsilon = max(1e-4, min(0.01, diagonal * 1e-5))
    samples: list[SurfaceSample] = []
    for point, normal in candidates:
        minus = point - normal * epsilon
        plus = point + normal * epsilon
        minus_inside = shape.isInside(tuple(minus), epsilon * 0.25)
        plus_inside = shape.isInside(tuple(plus), epsilon * 0.25)
        if minus_inside == plus_inside:
            continue
        inward = -normal if minus_inside else normal
        samples.append(SurfaceSample(point=point, inward_normal=inward))
    return samples, epsilon


def _ray_thickness(shape: cq.Shape, sample: SurfaceSample, epsilon: float) -> float | None:
    """沿内法向寻找最近的下一处实体边界，返回毫米距离。"""

    origin = sample.point + sample.inward_normal * epsilon
    line = gp_Lin(
        gp_Pnt(float(origin[0]), float(origin[1]), float(origin[2])),
        gp_Dir(
            float(sample.inward_normal[0]),
            float(sample.inward_normal[1]),
            float(sample.inward_normal[2]),
        ),
    )
    intersection = BRepIntCurveSurface_Inter()
    intersection.Init(shape.wrapped, line, max(1e-7, epsilon * 0.01))
    nearest: float | None = None
    while intersection.More():
        distance = float(intersection.W())
        if distance > epsilon * 2 and (nearest is None or distance < nearest):
            nearest = distance
        intersection.Next()
    if nearest is None:
        return None
    return nearest + epsilon


def classify_thickness(thickness_mm: float, thresholds: ThicknessThresholds) -> Severity:
    """把局部壁厚映射为中文界面使用的四级打印风险。"""

    if thickness_mm < thresholds.critical_mm:
        return "critical"
    if thickness_mm < thresholds.minimum_wall_mm:
        return "thin"
    if thickness_mm < thresholds.recommended_mm:
        return "recommended"
    return "safe"


def analyze_wall_thickness(
    input_path: Path,
    output_dir: Path,
    source_kind: SourceKind,
    source_part_id: str,
    minimum_wall_mm: float = 1.2,
    sample_limit: int = 1200,
    result_name: str = "wall-thickness-result.json",
) -> dict[str, object]:
    """执行表面法向射线采样估算，并写入与模型类型无关的 JSON 协议。"""

    if not math.isfinite(minimum_wall_mm) or not 0.4 <= minimum_wall_mm <= 10.0:
        raise ValueError("最小目标壁厚必须在 0.40 至 10.00 毫米之间")
    if not 12 <= sample_limit <= 5000:
        raise ValueError("壁厚采样上限必须在 12 至 5000 之间")
    if source_kind not in ("cad-part", "uploaded-stl"):
        raise ValueError("壁厚分析来源类型无效")

    model, source_format = _load_closed_model(input_path)
    shape = model.val()
    triangles, normals, areas = _mesh_arrays(shape)
    candidates = _deterministic_triangle_points(triangles, normals, areas, sample_limit)
    oriented_samples, epsilon = _orient_inward_samples(shape, candidates)

    thresholds = ThicknessThresholds(minimum_wall_mm=minimum_wall_mm)
    analyzed: list[dict[str, object]] = []
    for sample in oriented_samples:
        thickness = _ray_thickness(shape, sample, epsilon)
        if thickness is None or not math.isfinite(thickness) or thickness <= 0:
            continue
        rounded_thickness = round(thickness, 6)
        analyzed.append(
            {
                "xMm": round(float(sample.point[0]), 6),
                "yMm": round(float(sample.point[1]), 6),
                "zMm": round(float(sample.point[2]), 6),
                "inwardNormal": {
                    "x": round(float(sample.inward_normal[0]), 9),
                    "y": round(float(sample.inward_normal[1]), 9),
                    "z": round(float(sample.inward_normal[2]), 9),
                },
                "thicknessMm": rounded_thickness,
                # 风险等级必须和协议中实际返回的数值一致，避免 2.000000 被显示成“建议”。
                "severity": classify_thickness(rounded_thickness, thresholds),
            }
        )

    requested_count = len(candidates)
    if not analyzed:
        raise ValueError("没有获得有效壁厚样本；模型可能存在开放边、自相交或法向异常")
    coverage_ratio = len(analyzed) / requested_count
    if coverage_ratio < 0.35:
        raise ValueError(
            f"壁厚采样覆盖率仅 {coverage_ratio * 100:.1f}%，模型可能存在复杂非流形、自相交或法向异常"
        )

    thickness_values = np.asarray([float(sample["thicknessMm"]) for sample in analyzed])
    severity_counts = {
        severity: sum(sample["severity"] == severity for sample in analyzed)
        for severity in ("critical", "thin", "recommended", "safe")
    }
    summary: dict[str, object] = {
        "status": "ok",
        "revision": str(time_ns()),
        "sourceKind": source_kind,
        "sourcePartId": source_part_id,
        "sourceFormat": source_format,
        "sourceFile": input_path.name,
        "units": "mm",
        "kernel": "OpenCascade 7.8 / CadQuery 2.6",
        "method": "表面法向射线采样估算",
        "printerProfile": {
            "printer": "Bambu Lab P1S",
            "nozzleMm": 0.4,
            "materials": ["PLA", "PETG"],
        },
        "thresholds": {
            "criticalBelowMm": thresholds.critical_mm,
            "thinBelowMm": thresholds.minimum_wall_mm,
            "recommendedBelowMm": thresholds.recommended_mm,
        },
        "requestedSampleCount": requested_count,
        "sampleCount": len(analyzed),
        "surfaceTriangleCount": len(triangles),
        "surfaceAreaMm2": round(float(areas.sum()), 6),
        "minimumWallMm": minimum_wall_mm,
        "minimumThicknessMm": round(float(np.min(thickness_values)), 6),
        "percentile05Mm": round(float(np.percentile(thickness_values, 5)), 6),
        "medianThicknessMm": round(float(np.median(thickness_values)), 6),
        "maximumThicknessMm": round(float(np.max(thickness_values)), 6),
        "criticalCount": severity_counts["critical"],
        "thinCount": severity_counts["thin"],
        "recommendedCount": severity_counts["recommended"],
        "safeCount": severity_counts["safe"],
        "coverageRatio": round(coverage_ratio, 6),
        "samples": analyzed,
        "limitations": [
            "结果为离散表面采样估算，不是有限元、受力或疲劳仿真",
            "复杂非流形、自相交、极细纹理和未采样局部可能降低覆盖率",
            "风险阈值用于 P1S、0.4 毫米喷嘴、PLA/PETG 的设计检查，不能替代实际试打",
        ],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / result_name
    result_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="待分析的 STEP/STL 模型")
    parser.add_argument("--output", type=Path, required=True, help="分析结果输出目录")
    parser.add_argument(
        "--source-kind",
        choices=("cad-part", "uploaded-stl"),
        default="cad-part",
        help="来源模型类型",
    )
    parser.add_argument("--source-part-id", default="", help="来源模型或零件 ID")
    parser.add_argument("--minimum-wall", type=float, default=1.2, help="目标最小壁厚，单位毫米")
    parser.add_argument("--sample-limit", type=int, default=1200, help="表面采样点上限")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        analyze_wall_thickness(
            input_path=arguments.input,
            output_dir=arguments.output,
            source_kind=arguments.source_kind,
            source_part_id=arguments.source_part_id,
            minimum_wall_mm=arguments.minimum_wall,
            sample_limit=arguments.sample_limit,
        )
        return 0
    except Exception as error:  # noqa: BLE001 - CLI 需要把几何错误转换为中文失败边界。
        print(f"壁厚分析失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
