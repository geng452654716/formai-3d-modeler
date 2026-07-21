"""通用 STEP/STL 全局壁厚分析回归测试。"""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from test_split_and_cap import box_triangles, write_ascii_stl
from wall_thickness_analysis import (
    ThicknessThresholds,
    analyze_wall_thickness,
    classify_thickness,
)


class WallThicknessAnalysisTests(unittest.TestCase):
    def test_classifies_p1s_default_risk_levels(self) -> None:
        thresholds = ThicknessThresholds()
        self.assertEqual(classify_thickness(0.79, thresholds), "critical")
        self.assertEqual(classify_thickness(0.8, thresholds), "thin")
        self.assertEqual(classify_thickness(1.2, thresholds), "recommended")
        self.assertEqual(classify_thickness(2.0, thresholds), "safe")

    def test_analyzes_closed_step_box_in_millimeters(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "box.step"
            exporters.export(cq.Workplane("XY").box(10, 8, 4), str(source))
            result = analyze_wall_thickness(
                source,
                root,
                source_kind="cad-part",
                source_part_id="arbitrary-part",
                sample_limit=120,
            )

            self.assertEqual(result["sourceFormat"], "step")
            self.assertEqual(result["method"], "表面法向射线采样估算")
            self.assertEqual(result["sampleCount"], 12)
            self.assertAlmostEqual(result["coverageRatio"], 1.0)
            self.assertAlmostEqual(result["minimumThicknessMm"], 4.0, places=3)
            self.assertAlmostEqual(result["maximumThicknessMm"], 10.0, places=3)
            self.assertEqual(result["safeCount"], 12)
            for sample in result["samples"]:
                inward = sample["inwardNormal"]
                length = math.sqrt(inward["x"] ** 2 + inward["y"] ** 2 + inward["z"] ** 2)
                self.assertAlmostEqual(length, 1.0, places=6)
            self.assertTrue((root / "wall-thickness-result.json").is_file())

    def test_serialized_boundary_value_matches_reported_severity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "boundary.step"
            exporters.export(cq.Workplane("XY").box(10, 8, 2), str(source))
            result = analyze_wall_thickness(
                source,
                root,
                source_kind="cad-part",
                source_part_id="boundary-part",
                sample_limit=120,
            )

            boundary_samples = [
                sample for sample in result["samples"]
                if sample["thicknessMm"] == 2.0
            ]
            self.assertGreater(len(boundary_samples), 0)
            self.assertTrue(all(sample["severity"] == "safe" for sample in boundary_samples))

    def test_finds_critical_regions_in_thin_uploaded_stl(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "thin.stl"
            exporters.export(cq.Workplane("XY").box(12, 10, 0.6), str(source))
            result = analyze_wall_thickness(
                source,
                root,
                source_kind="uploaded-stl",
                source_part_id="uploaded-model",
                sample_limit=120,
            )

            self.assertEqual(result["sourceFormat"], "stl")
            self.assertAlmostEqual(result["minimumThicknessMm"], 0.6, places=3)
            self.assertGreater(result["criticalCount"], 0)
            self.assertEqual(result["sourcePartId"], "uploaded-model")

    def test_rejects_non_manifold_uploaded_stl_instead_of_reporting_false_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "non-manifold.stl"
            triangles = box_triangles()
            triangles.append(((0.0, 0.0, 0.0), (0.0, 10.0, 0.0), (0.0, 5.0, -5.0)))
            write_ascii_stl(source, triangles, "non_manifold")
            with self.assertRaisesRegex(ValueError, "非流形|封闭|外壳"):
                analyze_wall_thickness(
                    source,
                    root,
                    source_kind="uploaded-stl",
                    source_part_id="uploaded-model",
                )

    def test_rejects_invalid_threshold_and_sample_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "box.step"
            exporters.export(cq.Workplane("XY").box(2, 2, 2), str(source))
            with self.assertRaisesRegex(ValueError, "最小目标壁厚"):
                analyze_wall_thickness(source, root, "cad-part", "box", minimum_wall_mm=0.2)
            with self.assertRaisesRegex(ValueError, "采样上限"):
                analyze_wall_thickness(source, root, "cad-part", "box", sample_limit=4)


if __name__ == "__main__":
    unittest.main()
