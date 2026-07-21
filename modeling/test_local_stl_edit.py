"""上传 STL 局部圆柱加料与切除回归测试。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from local_stl_edit import edit_uploaded_stl
from split_and_cap import inspect_stl_file


class LocalStlEditTests(unittest.TestCase):
    def _project(self, root: Path) -> Path:
        source = root / "imported-model.stl"
        exporters.export(cq.Workplane("XY").box(20, 16, 10, centered=(False, False, False)), str(source))
        inspect_stl_file(source, root, original_file_name="任意测试模型.stl")
        return source

    def test_adds_verified_cylindrical_boss_and_updates_working_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._project(root)
            result = edit_uploaded_stl(
                source,
                root,
                "add-cylinder",
                center=(10, 8, 10),
                inward_normal=(0, 0, -1),
                radius_mm=3,
                depth_mm=2,
                command="这里增加直径 6 毫米、高 2 毫米的凸台",
            )

            self.assertGreater(result["validation"]["volumeDeltaMm3"], 0)
            self.assertEqual(result["validation"]["solidCount"], 1)
            self.assertEqual(result["updatedModel"]["sourceFile"], "imported-model-working.stl")
            self.assertTrue((root / "imported-model-working.stl").is_file())
            self.assertTrue((root / "imported-model-working.step").is_file())
            manifest = json.loads((root / "imported-model-result.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["revision"], result["revision"])
            self.assertAlmostEqual(manifest["metrics"]["boundsMm"]["maxZ"], 12.0, places=2)

    def test_cuts_verified_cylindrical_hole_and_supports_consecutive_edits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._project(root)
            added = edit_uploaded_stl(
                source,
                root,
                "add-cylinder",
                center=(10, 8, 10),
                inward_normal=(0, 0, -1),
                radius_mm=3,
                depth_mm=2,
            )
            cut = edit_uploaded_stl(
                root / added["updatedModel"]["sourceFile"],
                root,
                "cut-cylinder",
                center=(10, 8, 12),
                inward_normal=(0, 0, -1),
                radius_mm=1,
                depth_mm=4,
            )

            self.assertLess(cut["validation"]["volumeDeltaMm3"], 0)
            self.assertEqual(cut["validation"]["solidCount"], 1)
            self.assertNotEqual(cut["revision"], added["revision"])
            self.assertLess(
                cut["validation"]["volumeAfterMm3"],
                cut["validation"]["volumeBeforeMm3"],
            )

    def test_rejects_non_intersecting_operation_without_replacing_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._project(root)
            original_manifest = (root / "imported-model-result.json").read_text(encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "没有形成有效相交|体积增加|2 个 Solid"):
                edit_uploaded_stl(
                    source,
                    root,
                    "add-cylinder",
                    center=(100, 100, 100),
                    inward_normal=(0, 0, -1),
                    radius_mm=2,
                    depth_mm=2,
                )
            self.assertEqual(
                (root / "imported-model-result.json").read_text(encoding="utf-8"),
                original_manifest,
            )

    def test_rejects_invalid_normal_and_ranges_in_chinese(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._project(root)
            with self.assertRaisesRegex(ValueError, "法向无效"):
                edit_uploaded_stl(source, root, "cut-cylinder", (1, 1, 10), (0, 0, 0), 1, 2)
            with self.assertRaisesRegex(ValueError, "半径"):
                edit_uploaded_stl(source, root, "cut-cylinder", (1, 1, 10), (0, 0, -1), 0.1, 2)


if __name__ == "__main__":
    unittest.main()
