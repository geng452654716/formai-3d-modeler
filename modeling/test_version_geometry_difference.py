"""通用 OpenCascade 精确版本布尔差异回归测试。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from version_geometry_difference import compare_version_geometry


def write_manifest(directory: Path, revision: str, parts: list[tuple[str, str, cq.Workplane]]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    descriptors: list[dict[str, object]] = []
    for part_id, label, model in parts:
        file_name = f"{part_id}.step"
        exporters.export(model, str(directory / file_name))
        outputs.append(file_name)
        bounds = model.val().BoundingBox()
        descriptors.append(
            {
                "id": part_id,
                "label": label,
                "role": "part",
                "stepFile": file_name,
                "stlFile": f"{part_id}.stl",
                "metrics": {
                    "valid": True,
                    "volumeMm3": model.val().Volume(),
                    "boundsMm": {"x": bounds.xlen, "y": bounds.ylen, "z": bounds.zlen},
                    "fitsP1S": True,
                },
            }
        )
    manifest = {
        "status": "ok",
        "revision": revision,
        "units": "mm",
        "outputs": outputs,
        "parts": descriptors,
    }
    (directory / "generation-result.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )


class VersionGeometryDifferenceTests(unittest.TestCase):
    def test_identical_models_have_no_exported_difference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            current = root / "current"
            box = cq.Workplane("XY").box(10, 8, 6)
            write_manifest(base, "1", [("arbitrary-body", "任意主体", box)])
            write_manifest(current, "2", [("arbitrary-body", "任意主体", box)])

            result = compare_version_geometry(base, current, current)

            self.assertEqual(result["outputs"], [])
            self.assertEqual(result["summary"]["changedPartCount"], 0)
            self.assertEqual(result["parts"][0]["changeType"], "unchanged")
            self.assertEqual(result["parts"][0]["addedStlFile"], None)
            self.assertEqual(result["parts"][0]["removedStlFile"], None)

    def test_larger_model_reports_only_added_volume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            current = root / "current"
            write_manifest(base, "1", [("part-a", "零件 A", cq.Workplane("XY").box(8, 8, 8))])
            write_manifest(current, "2", [("part-a", "零件 A", cq.Workplane("XY").box(10, 10, 10))])

            result = compare_version_geometry(base, current, current)
            part = result["parts"][0]

            self.assertAlmostEqual(part["metrics"]["addedVolumeMm3"], 488.0, places=3)
            self.assertEqual(part["metrics"]["removedVolumeMm3"], 0.0)
            self.assertIsNotNone(part["addedStlFile"])
            self.assertIsNone(part["removedStlFile"])
            self.assertTrue((current / part["addedStlFile"]).is_file())

    def test_moved_opening_reports_added_and_removed_regions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            current = root / "current"
            solid = cq.Workplane("XY").box(20, 14, 8)
            hole_a = cq.Workplane("XY").center(-4, 0).circle(2).extrude(12, both=True)
            hole_b = cq.Workplane("XY").center(4, 0).circle(2).extrude(12, both=True)
            write_manifest(base, "1", [("body", "主体", solid.cut(hole_a))])
            write_manifest(current, "2", [("body", "主体", solid.cut(hole_b))])

            result = compare_version_geometry(base, current, current)
            part = result["parts"][0]

            self.assertGreater(part["metrics"]["addedVolumeMm3"], 0)
            self.assertGreater(part["metrics"]["removedVolumeMm3"], 0)
            self.assertIsNotNone(part["addedStlFile"])
            self.assertIsNotNone(part["removedStlFile"])

    def test_matches_multiple_parts_by_stable_id_not_list_position(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            current = root / "current"
            a = cq.Workplane("XY").box(3, 3, 3)
            b = cq.Workplane("XY").box(4, 4, 4).translate((10, 0, 0))
            write_manifest(base, "1", [("a", "A", a), ("b", "B", b)])
            write_manifest(current, "2", [("b", "B", b), ("a", "A", a)])

            result = compare_version_geometry(base, current, current)

            self.assertEqual(result["summary"]["changedPartCount"], 0)
            self.assertEqual([part["id"] for part in result["parts"]], ["a", "b"])

    def test_reports_added_and_removed_arbitrary_parts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            current = root / "current"
            write_manifest(base, "1", [("old-limb", "旧部件", cq.Workplane("XY").box(3, 4, 5))])
            write_manifest(current, "2", [("new-limb", "新部件", cq.Workplane("XY").sphere(3))])

            result = compare_version_geometry(base, current, current)
            by_id = {part["id"]: part for part in result["parts"]}

            self.assertEqual(by_id["old-limb"]["changeType"], "removed-part")
            self.assertEqual(by_id["new-limb"]["changeType"], "added-part")
            self.assertGreater(by_id["old-limb"]["metrics"]["removedVolumeMm3"], 0)
            self.assertGreater(by_id["new-limb"]["metrics"]["addedVolumeMm3"], 0)

    def test_rejects_traversal_and_undeclared_step_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            current = root / "current"
            write_manifest(base, "1", [("safe", "安全", cq.Workplane("XY").box(2, 2, 2))])
            write_manifest(current, "2", [("safe", "安全", cq.Workplane("XY").box(2, 2, 2))])
            manifest_path = base / "generation-result.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["parts"][0]["stepFile"] = "../outside.step"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "普通文件名"):
                compare_version_geometry(base, current, current)

            manifest["parts"][0]["stepFile"] = "safe.step"
            manifest["outputs"] = []
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "未在 outputs 中声明"):
                compare_version_geometry(base, current, current)


if __name__ == "__main__":
    unittest.main()
