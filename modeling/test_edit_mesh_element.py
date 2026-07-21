"""上传 STL 顶点、边和面位移回归测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from edit_mesh_element import edit_mesh_element
from split_and_cap import inspect_stl_file


class MeshElementEditTests(unittest.TestCase):
    def _project(self, root: Path) -> tuple[Path, dict[str, object]]:
        source = root / "imported-model.stl"
        exporters.export(cq.Workplane("XY").box(20, 16, 10, centered=(False, False, False)), str(source))
        manifest = inspect_stl_file(source, root, original_file_name="任意模型.stl")
        working = root / str(manifest["sourceFile"])
        return working, manifest

    def test_moves_shared_vertex_and_updates_manifest_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            result = edit_mesh_element(source, root, str(manifest["revision"]), "vertex", 0, 0, (0.25, 0, 0))
            self.assertGreater(result["movedVertexOccurrenceCount"], 1)
            self.assertEqual(result["validation"]["solidCountBefore"], result["validation"]["solidCountAfter"])
            self.assertTrue((root / "imported-model-working.stl").is_file())
            self.assertTrue((root / "imported-model-working.step").is_file())
            updated = json.loads((root / "imported-model-result.json").read_text(encoding="utf-8"))
            self.assertEqual(updated["revision"], result["revision"])

    def test_moves_edge_and_face_with_distinct_coordinate_counts(self) -> None:
        for kind, element_index, expected in (("edge", 0, 2), ("face", 0, 3)):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, manifest = self._project(root)
                result = edit_mesh_element(source, root, str(manifest["revision"]), kind, 0, element_index, (0, 0, 0.1))
                self.assertEqual(result["movedCoordinateCount"], expected)
                self.assertTrue(result["validation"]["watertight"])

    def test_rejects_stale_revision_without_replacing_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, _ = self._project(root)
            original = (root / "imported-model-result.json").read_text(encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "模型已在选择后发生变化"):
                edit_mesh_element(source, root, "过期修订", "vertex", 0, 0, (0.1, 0, 0))
            self.assertEqual((root / "imported-model-result.json").read_text(encoding="utf-8"), original)

    def test_rejects_invalid_selection_and_zero_displacement_in_chinese(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            revision = str(manifest["revision"])
            with self.assertRaisesRegex(ValueError, "至少输入一个非零位移"):
                edit_mesh_element(source, root, revision, "vertex", 0, 0, (0, 0, 0))
            with self.assertRaisesRegex(ValueError, "索引与编辑类型不匹配"):
                edit_mesh_element(source, root, revision, "face", 0, 1, (0.1, 0, 0))


if __name__ == "__main__":
    unittest.main()
