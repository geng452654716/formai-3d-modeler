"""上传 STL 顶点、边和面集合变换回归测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cadquery as cq
from cadquery import exporters

from edit_mesh_element import edit_mesh_element, edit_mesh_elements, extrude_mesh_face, transform_mesh_elements
from export_transformed_model import read_stl
from split_and_cap import import_stl_as_solid, inspect_stl_file


class MeshElementEditTests(unittest.TestCase):
    def _project(self, root: Path) -> tuple[Path, dict[str, object]]:
        source = root / "imported-model.stl"
        exporters.export(cq.Workplane("XY").box(20, 16, 10, centered=(False, False, False)), str(source))
        manifest = inspect_stl_file(source, root, original_file_name="任意模型.stl")
        working = root / str(manifest["sourceFile"])
        return working, manifest

    def _selection(self, source: Path, triangle_index: int, element_index: int) -> dict[str, object]:
        triangle = read_stl(source)[triangle_index]
        return {
            "triangleIndex": triangle_index,
            "elementIndex": element_index,
            "triangleMm": [{"x": point[0], "y": point[1], "z": point[2]} for point in triangle],
        }

    def _top_face_selection(self, source: Path) -> dict[str, object]:
        """返回测试长方体顶面的一个真实源三角面。"""

        triangle_index = next(
            index for index, triangle in enumerate(read_stl(source))
            if all(abs(point[2] - 10.0) < 1e-6 for point in triangle)
        )
        return self._selection(source, triangle_index, 0)

    def test_adds_and_cuts_single_face_along_classified_outward_normal(self) -> None:
        for mode, expected_direction in (("add", 1), ("cut", -1)):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, manifest = self._project(root)
                selection = self._top_face_selection(source)
                result = extrude_mesh_face(
                    source, root, str(manifest["revision"]), selection, mode, 2.0, "click"
                )
                self.assertEqual(result["operation"], "extrude-face")
                self.assertEqual(result["faceExtrusionMode"], mode)
                self.assertEqual(result["selectedElementCount"], 1)
                self.assertAlmostEqual(result["outwardNormal"]["z"], 1.0, places=6)
                self.assertGreater(result["toolVolumeMm3"], 0)
                self.assertEqual(
                    result["validation"]["volumeDeltaMm3"] > 0,
                    expected_direction > 0,
                )
                self.assertTrue(result["validation"]["watertight"])
                self.assertEqual(result["validation"]["solidCountAfter"], 1)

    def test_face_extrusion_prefixes_export_mesh_failure_and_preserves_working_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            selection = self._top_face_selection(source)
            source_import = import_stl_as_solid(source)
            working_bytes = source.read_bytes()
            manifest_text = (root / "imported-model-result.json").read_text(encoding="utf-8")

            with patch(
                "edit_mesh_element.import_stl_as_solid",
                side_effect=[source_import, ValueError("STL 包含 1 条非流形边；当前不会自动猜测拓扑")],
            ):
                with self.assertRaisesRegex(ValueError, "三角面法向编辑导出结果未通过网格检查.*非流形边"):
                    extrude_mesh_face(source, root, str(manifest["revision"]), selection, "add", 2.0, "click")

            self.assertEqual(source.read_bytes(), working_bytes)
            self.assertEqual((root / "imported-model-result.json").read_text(encoding="utf-8"), manifest_text)
            self.assertFalse(any(path.name.startswith(".imported-model-working-") for path in root.iterdir()))

    def test_face_extrusion_preserves_cad_branch_source_and_rejects_unsafe_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            branch_source = {
                "kind": "cad-part",
                "cadRevision": "cad-source-revision",
                "partId": "ornament-left",
                "partLabel": "左侧装饰件",
                "sourceStlFile": "ornament-left.stl",
            }
            manifest["branchSource"] = branch_source
            (root / "imported-model-result.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
            )
            selection = self._top_face_selection(source)
            with self.assertRaisesRegex(ValueError, "只支持点击选择"):
                extrude_mesh_face(source, root, str(manifest["revision"]), selection, "add", 1.0, "box")
            with self.assertRaisesRegex(ValueError, "0.20 至 100.00"):
                extrude_mesh_face(source, root, str(manifest["revision"]), selection, "add", 0.1, "click")
            tampered = json.loads(json.dumps(selection))
            tampered["triangleMm"][0]["x"] += 0.5
            with self.assertRaisesRegex(ValueError, "源坐标与当前模型不一致"):
                extrude_mesh_face(source, root, str(manifest["revision"]), tampered, "cut", 1.0, "click")

            result = extrude_mesh_face(source, root, str(manifest["revision"]), selection, "add", 1.0, "click")
            self.assertEqual(result["updatedModel"]["branchSource"], branch_source)
            persisted = json.loads((root / "imported-model-result.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["branchSource"], branch_source)

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

    def test_preserves_cad_mesh_branch_source_after_transform(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            branch_source = {
                "kind": "cad-part",
                "cadRevision": "cad-source-revision",
                "partId": "figure-head",
                "partLabel": "头部",
                "sourceStlFile": "figure-head.stl",
            }
            manifest["branchSource"] = branch_source
            (root / "imported-model-result.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
            )

            result = edit_mesh_element(source, root, str(manifest["revision"]), "vertex", 0, 0, (0.25, 0, 0))
            self.assertEqual(result["updatedModel"]["branchSource"], branch_source)
            persisted = json.loads((root / "imported-model-result.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["branchSource"], branch_source)

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

    def test_box_moves_multiple_distinct_vertices_and_reports_deduplicated_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            selections: list[dict[str, object]] = []
            seen: set[tuple[float, float, float]] = set()
            for triangle_index, triangle in enumerate(read_stl(source)):
                for element_index, point in enumerate(triangle):
                    key = tuple(round(value, 6) for value in point)
                    if round(point[2], 6) != 10 or key in seen:
                        continue
                    seen.add(key)
                    selections.append(self._selection(source, triangle_index, element_index))
            self.assertEqual(len(selections), 4)
            result = edit_mesh_elements(
                source,
                root,
                str(manifest["revision"]),
                "vertex",
                selections,
                (0, 0, 0.2),
                "box",
            )
            self.assertEqual(result["selectionMethod"], "box")
            self.assertEqual(result["selectedElementCount"], 4)
            self.assertEqual(result["movedCoordinateCount"], 4)
            self.assertTrue(result["validation"]["watertight"])

    def test_rotates_and_scales_top_vertex_collection_around_geometric_center(self) -> None:
        for operation, options in (
            ("rotate", {"rotation_axis": "z", "rotation_degrees": 10.0}),
            ("scale", {"scale_factor": 0.9}),
        ):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, manifest = self._project(root)
                selections: list[dict[str, object]] = []
                seen: set[tuple[float, float, float]] = set()
                for triangle_index, triangle in enumerate(read_stl(source)):
                    for element_index, point in enumerate(triangle):
                        key = tuple(round(value, 6) for value in point)
                        if round(point[2], 6) != 10 or key in seen:
                            continue
                        seen.add(key)
                        selections.append(self._selection(source, triangle_index, element_index))
                result = transform_mesh_elements(
                    source,
                    root,
                    str(manifest["revision"]),
                    "vertex",
                    selections,
                    operation,
                    "box",
                    **options,
                )
                self.assertEqual(result["operation"], operation)
                self.assertEqual(result["pivotMm"], {"x": 10.0, "y": 8.0, "z": 10.0})
                self.assertEqual(result["movedCoordinateCount"], 4)
                self.assertTrue(result["validation"]["watertight"])
                self.assertEqual(result["validation"]["solidCountBefore"], result["validation"]["solidCountAfter"])

    def test_rejects_noop_single_vertex_rotation_and_unsafe_transform_parameters(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            revision = str(manifest["revision"])
            one_vertex = [self._selection(source, 0, 0)]
            with self.assertRaisesRegex(ValueError, "旋转轴只能"):
                transform_mesh_elements(source, root, revision, "vertex", one_vertex, "rotate", rotation_degrees=30)
            with self.assertRaisesRegex(ValueError, "不会产生坐标变化"):
                transform_mesh_elements(
                    source, root, revision, "vertex", one_vertex, "rotate", rotation_axis="z", rotation_degrees=30
                )
            with self.assertRaisesRegex(ValueError, "-180° 至 180°"):
                transform_mesh_elements(
                    source, root, revision, "vertex", one_vertex, "rotate", rotation_axis="z", rotation_degrees=181
                )
            with self.assertRaisesRegex(ValueError, "0.25 至 4"):
                transform_mesh_elements(source, root, revision, "vertex", one_vertex, "scale", scale_factor=5)

    def test_deduplicates_same_source_vertex_across_triangles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            triangles = read_stl(source)
            first_key = tuple(round(value, 6) for value in triangles[0][0])
            occurrences: list[tuple[int, int]] = []
            for triangle_index, triangle in enumerate(triangles):
                for element_index, point in enumerate(triangle):
                    if tuple(round(value, 6) for value in point) == first_key:
                        occurrences.append((triangle_index, element_index))
            self.assertGreater(len(occurrences), 1)
            result = edit_mesh_elements(
                source,
                root,
                str(manifest["revision"]),
                "vertex",
                [self._selection(source, *occurrences[0]), self._selection(source, *occurrences[1])],
                (0.1, 0, 0),
                "box",
            )
            self.assertEqual(result["selectedElementCount"], 1)
            self.assertEqual(result["movedCoordinateCount"], 1)

    def test_rejects_selection_limit_and_tampered_source_coordinates_without_writeback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, manifest = self._project(root)
            original = (root / "imported-model-result.json").read_text(encoding="utf-8")
            valid = self._selection(source, 0, 0)
            with self.assertRaisesRegex(ValueError, "最多选择 512"):
                edit_mesh_elements(
                    source,
                    root,
                    str(manifest["revision"]),
                    "vertex",
                    [valid] * 513,
                    (0.1, 0, 0),
                    "box",
                )
            tampered = json.loads(json.dumps(valid))
            tampered["triangleMm"][0]["x"] += 1
            with self.assertRaisesRegex(ValueError, "源坐标与当前模型不一致"):
                edit_mesh_elements(
                    source,
                    root,
                    str(manifest["revision"]),
                    "vertex",
                    [tampered],
                    (0.1, 0, 0),
                    "click",
                )
            self.assertEqual((root / "imported-model-result.json").read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
