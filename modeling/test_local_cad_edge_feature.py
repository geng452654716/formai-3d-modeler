"""稳定 CAD 单边与平面边界整圈圆角、倒角的几何和安全协议回归测试。"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from face_geometry_signatures import match_shape_faces_with_sources
from face_tessellation_mapping import export_face_tessellation_mapping
from local_cad_feature import _export_assembly_3mf, edit_cad_feature
from local_cad_feature_core import apply_edge_feature, validate_edge_feature_inputs


class LocalCadEdgeFeatureTests(unittest.TestCase):
    def _fixture(self, size: tuple[float, float, float] = (20, 16, 10)):
        model = cq.Workplane("XY").box(*size)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(
            value for value in faces
            if value.get("geometryType") == "PLANE" and value.get("normal") == [0.0, 0.0, 1.0]
        )
        edge = next(value for value in face.get("edges", []) if value.get("geometryType") == "LINE")
        return model, faces, face, edge

    def _apply(self, operation: str, size_mm: float = 1.0):
        model, faces, face, edge = self._fixture()
        point = tuple(float(value) for value in edge["centerMm"])
        return apply_edge_feature(
            model, faces, operation, face["stableId"], edge["stableId"],
            point, (0, 0, 1), size_mm,
        )

    def _project(
        self,
        root: Path,
        model: cq.Workplane | None = None,
        face_geometry_type: str = "PLANE",
        edge_geometry_type: str = "LINE",
    ):
        if model is None:
            model, sources_faces, face, edge = self._fixture()
        else:
            initial_sources, _ = match_shape_faces_with_sources(model)
            sources_faces = [descriptor for _, descriptor in initial_sources]
            face = next(
                value for value in sources_faces
                if value.get("geometryType") == face_geometry_type
            )
            edge = next(
                value for value in face.get("edges", [])
                if value.get("geometryType") == edge_geometry_type
            )
        sources, matching = match_shape_faces_with_sources(model, sources_faces)
        stl_name = "generic-part.stl"
        step_name = "generic-part.step"
        selection_name = "generic-part-selection.stl"
        map_name = "generic-part-face-map.json"
        assembly_name = "generic-model.3mf"
        exporters.export(model, str(root / stl_name), tolerance=0.05)
        exporters.export(model, str(root / step_name))
        mapping = export_face_tessellation_mapping(
            root, "generic-part", sources, source_stl_file=stl_name,
            selection_mesh_file=selection_name, mapping_file=map_name,
        )
        _export_assembly_3mf([("通用零件", model)], root / assembly_name)
        bounds = model.val().BoundingBox()
        outputs = [stl_name, step_name, selection_name, map_name, assembly_name]
        part = {
            "id": "generic-part", "label": "通用零件", "role": "primary",
            "stlFile": stl_name, "stepFile": step_name,
            "metrics": {
                "valid": True, "volumeMm3": model.val().Volume(),
                "boundsMm": {"x": bounds.xlen, "y": bounds.ylen, "z": bounds.zlen},
                "fitsP1S": True,
            },
            "faces": [descriptor for _, descriptor in sources],
            "faceMatching": matching, "faceTessellation": mapping,
        }
        manifest = {
            "status": "ok", "revision": "edge-fixture-revision", "outputs": outputs,
            "units": "mm", "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "printer": {"model": "Bambu Lab P1S", "buildVolumeMm": [256, 256, 256], "nozzleMm": 0.4},
            "model": {"id": "generic", "name": "通用测试模型", "templateId": "generic", "templateName": "通用模型"},
            "parameters": {}, "interfaceOpeningMode": "custom", "interfaceOpenings": [],
            "openingValidation": {"count": 0, "bodyCount": 0, "coverCount": 0, "minimumEdgeMarginMm": None, "minimumSpacingMm": None},
            "faceMatching": matching, "parts": [part], "assemblyFile": assembly_name,
            "files": {name: {"bytes": (root / name).stat().st_size} for name in outputs},
        }
        (root / "generation-result.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        actual_face = next(value for value in part["faces"] if value["stableId"] == face["stableId"])
        actual_edge = next(value for value in actual_face["edges"] if value["stableId"] == edge["stableId"])
        return manifest, actual_face, actual_edge

    def test_single_edge_fillet_produces_valid_closed_solid(self):
        result = self._apply("fillet-edge", 1.0)
        self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
        self.assertTrue(result["validation"]["valid"])
        self.assertTrue(result["validation"]["watertight"])
        self.assertEqual(result["validation"]["solidCount"], 1)
        self.assertTrue(result["targetEdge"]["stableId"].startswith("edge-"))

    def test_single_edge_chamfer_produces_valid_closed_solid(self):
        result = self._apply("chamfer-edge", 1.0)
        self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
        self.assertEqual(result["validation"]["solidCount"], 1)

    def test_planar_boundary_loop_fillet_and_chamfer_produce_valid_closed_solid(self):
        for operation in ("fillet-edge-loop", "chamfer-edge-loop"):
            with self.subTest(operation=operation):
                result = self._apply(operation, 1.0)
                validation = result["validation"]
                self.assertEqual(validation["affectedEdgeCount"], 4)
                self.assertEqual(validation["edgeScope"], "loop")
                self.assertLess(validation["volumeDeltaMm3"], 0)
                self.assertTrue(validation["valid"])
                self.assertTrue(validation["watertight"])
                self.assertEqual(validation["solidCount"], 1)

    def test_rejects_wrong_edge_id_and_click_far_from_edge(self):
        model, faces, face, edge = self._fixture()
        with self.assertRaisesRegex(ValueError, "稳定边"):
            apply_edge_feature(
                model, faces, "fillet-edge", face["stableId"], "edge-missing",
                tuple(edge["centerMm"]), (0, 0, 1), 1,
            )
        with self.assertRaisesRegex(ValueError, "距离目标边"):
            apply_edge_feature(
                model, faces, "fillet-edge", face["stableId"], edge["stableId"],
                (0, 0, 5), (0, 0, 1), 1,
            )

    def test_rejects_edge_size_outside_safe_range(self):
        for size in (0.19, 50.01):
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "0.20 至 50.00"):
                validate_edge_feature_inputs(
                    "fillet-edge", "face", "edge", (0, 0, 0), (0, 0, 1), size
                )

    def test_edge_descriptors_have_stable_id_and_samples(self):
        _, _, face, edge = self._fixture()
        self.assertTrue(str(edge["stableId"]).startswith("edge-"))
        self.assertGreaterEqual(len(edge["samplePointsMm"]), 2)
        self.assertEqual(edge["matchSource"], "new")
        self.assertTrue(face["edges"])

    def test_scaled_rebuild_inherits_face_and_edge_ids_within_owner_face(self):
        _, old_faces, old_face, old_edge = self._fixture()
        scaled = cq.Workplane("XY").box(30, 24, 15)
        sources, _ = match_shape_faces_with_sources(scaled, old_faces)
        new_faces = [descriptor for _, descriptor in sources]
        inherited_face = next(value for value in new_faces if value["stableId"] == old_face["stableId"])
        self.assertTrue(any(value["stableId"] == old_edge["stableId"] for value in inherited_face["edges"]))

    def test_curved_owner_face_supports_single_circular_edge_fillet_and_chamfer(self):
        for operation in ("fillet-edge", "chamfer-edge"):
            with self.subTest(operation=operation):
                model = cq.Workplane("XY").cylinder(10, 5)
                sources, _ = match_shape_faces_with_sources(model)
                faces = [descriptor for _, descriptor in sources]
                face = next(value for value in faces if value.get("geometryType") == "CYLINDER")
                edge = next(value for value in face["edges"] if value.get("geometryType") == "CIRCLE")
                point = tuple(float(value) for value in edge["samplePointsMm"][0])
                result = apply_edge_feature(
                    model, faces, operation, face["stableId"], edge["stableId"],
                    point, (1, 0, 0), 1, surface_uv=(0, 0),
                )
                self.assertTrue(result["validation"]["valid"])
                self.assertEqual(result["validation"]["surfaceGeometryType"], "CYLINDER")
                self.assertEqual(result["validation"]["surfaceUv"], {"u": 0, "v": 0})
                self.assertLess(result["validation"]["volumeDeltaMm3"], 0)

    def test_curved_owner_face_rejects_missing_or_stale_surface_uv(self):
        model = cq.Workplane("XY").cylinder(10, 5)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(value for value in faces if value.get("geometryType") == "CYLINDER")
        edge = next(value for value in face["edges"] if value.get("geometryType") == "CIRCLE")
        point = tuple(float(value) for value in edge["samplePointsMm"][0])
        with self.assertRaisesRegex(ValueError, "缺少真实 UV"):
            apply_edge_feature(
                model, faces, "fillet-edge", face["stableId"], edge["stableId"],
                point, (1, 0, 0), 1,
            )
        with self.assertRaisesRegex(ValueError, "真实 UV 点"):
            apply_edge_feature(
                model, faces, "fillet-edge", face["stableId"], edge["stableId"],
                point, (1, 0, 0), 1, surface_uv=(3.141592653589793, 10),
            )

    def test_curved_owner_face_rejects_loop_operation(self):
        model = cq.Workplane("XY").cylinder(10, 5)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(value for value in faces if value.get("geometryType") == "CYLINDER")
        edge = next(value for value in face["edges"] if value.get("geometryType") == "CIRCLE")
        point = tuple(float(value) for value in edge["samplePointsMm"][0])
        with self.assertRaisesRegex(ValueError, "只支持平面边界"):
            apply_edge_feature(
                model, faces, "fillet-edge-loop", face["stableId"], edge["stableId"],
                point, (1, 0, 0), 1, surface_uv=(0, 0),
            )

    def test_worker_exports_step_stl_selection_mapping_and_3mf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face, edge = self._project(root)
            with contextlib.redirect_stdout(io.StringIO()):
                result = edit_cad_feature(
                    root, "fillet-edge", manifest["revision"], "generic-part", face["stableId"],
                    tuple(edge["centerMm"]), (0, 0, 1), None, 1,
                    "将这条边做 1 毫米圆角", stable_edge_id=edge["stableId"],
                )
            self.assertEqual(result["stableEdgeId"], edge["stableId"])
            self.assertEqual(result["updatedCadResult"]["localFeatures"][0]["targetEdge"]["stableId"], edge["stableId"])
            for name in (
                "generic-part.stl", "generic-part.step", "generic-part-selection.stl",
                "generic-part-face-map.json", "generic-model.3mf",
            ):
                self.assertTrue((root / name).is_file(), name)
                self.assertGreater((root / name).stat().st_size, 0, name)

    def test_worker_executes_planar_boundary_loop_and_records_edge_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face, edge = self._project(root)
            with contextlib.redirect_stdout(io.StringIO()):
                result = edit_cad_feature(
                    root, "fillet-edge-loop", manifest["revision"], "generic-part", face["stableId"],
                    tuple(edge["centerMm"]), (0, 0, 1), None, 1,
                    "将这圈边做 1 毫米圆角", stable_edge_id=edge["stableId"],
                )
            feature = result["updatedCadResult"]["localFeatures"][0]
            self.assertEqual(feature["operation"], "fillet-edge-loop")
            self.assertEqual(feature["targetEdge"]["stableId"], edge["stableId"])
            self.assertEqual(result["validation"]["affectedEdgeCount"], 4)
            self.assertEqual(result["validation"]["edgeScope"], "loop")
            for name in (
                "generic-part.stl", "generic-part.step", "generic-part-selection.stl",
                "generic-part-face-map.json", "generic-model.3mf",
            ):
                self.assertTrue((root / name).is_file(), name)
                self.assertGreater((root / name).stat().st_size, 0, name)


    def test_worker_executes_curved_owner_edge_and_records_real_uv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face, edge = self._project(
                root, cq.Workplane("XY").cylinder(10, 5), "CYLINDER", "CIRCLE"
            )
            point = tuple(float(value) for value in edge["samplePointsMm"][0])
            with contextlib.redirect_stdout(io.StringIO()):
                result = edit_cad_feature(
                    root, "chamfer-edge", manifest["revision"], "generic-part", face["stableId"],
                    point, (1, 0, 0), None, 1, "将这条曲面边做 1 毫米倒角",
                    stable_edge_id=edge["stableId"], surface_geometry_type="CYLINDER",
                    surface_uv=(0, 0),
                )
            feature = result["updatedCadResult"]["localFeatures"][0]
            self.assertEqual(feature["surfaceGeometryType"], "CYLINDER")
            self.assertEqual(feature["surfaceUv"], {"u": 0, "v": 0})
            self.assertTrue(result["validation"]["valid"])
            self.assertEqual(result["validation"]["surfaceGeometryType"], "CYLINDER")

    def test_worker_rejects_profile_dimensions_and_nonzero_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face, edge = self._project(root)
            with self.assertRaisesRegex(ValueError, "不能携带平面轮廓尺寸"):
                edit_cad_feature(
                    root, "chamfer-edge", manifest["revision"], "generic-part", face["stableId"],
                    tuple(edge["centerMm"]), (0, 0, 1), None, 1,
                    stable_edge_id=edge["stableId"], width_mm=2,
                )
            with self.assertRaisesRegex(ValueError, "rotationDeg 必须为 0"):
                edit_cad_feature(
                    root, "chamfer-edge", manifest["revision"], "generic-part", face["stableId"],
                    tuple(edge["centerMm"]), (0, 0, 1), None, 1,
                    stable_edge_id=edge["stableId"], rotation_deg=1,
                )


if __name__ == "__main__":
    unittest.main()
