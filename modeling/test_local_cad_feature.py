"""稳定 CAD 面局部 OpenCascade 特征的自动化回归测试。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from cad_surface_hit_core import resolve_surface_hit
from face_geometry_signatures import match_shape_faces_with_sources
from face_tessellation_mapping import export_face_tessellation_mapping
from local_cad_feature import _export_assembly_3mf, edit_cad_feature
from local_cad_feature_core import describe_surface_geometry_type


class LocalCadFeatureTests(unittest.TestCase):
    def test_surface_geometry_type_uses_chinese_display_name(self) -> None:
        self.assertEqual(describe_surface_geometry_type("CYLINDER"), "圆柱面")
        self.assertEqual(describe_surface_geometry_type("UNKNOWN"), "未知曲面")

    def _project(self, root: Path) -> tuple[dict[str, object], dict[str, object]]:
        main = cq.Workplane("XY").box(20, 16, 10)
        companion = cq.Workplane("XY").box(8, 8, 4).translate((0, 0, 9))
        main_sources, main_matching = match_shape_faces_with_sources(main)
        companion_sources, companion_matching = match_shape_faces_with_sources(companion)
        parts = []
        for part_id, label, model, sources, matching in (
            ("main-part", "主零件", main, main_sources, main_matching),
            ("companion", "配套零件", companion, companion_sources, companion_matching),
        ):
            stl_name = f"{part_id}.stl"
            step_name = f"{part_id}.step"
            selection_name = f"{part_id}-selection.stl"
            map_name = f"{part_id}-face-map.json"
            exporters.export(model, str(root / stl_name), tolerance=0.05)
            exporters.export(model, str(root / step_name))
            mapping = export_face_tessellation_mapping(
                root,
                part_id,
                sources,
                source_stl_file=stl_name,
                selection_mesh_file=selection_name,
                mapping_file=map_name,
            )
            bounds = model.val().BoundingBox()
            parts.append({
                "id": part_id,
                "label": label,
                "role": "primary" if part_id == "main-part" else "secondary",
                "stlFile": stl_name,
                "stepFile": step_name,
                "metrics": {
                    "valid": True,
                    "volumeMm3": model.val().Volume(),
                    "boundsMm": {"x": bounds.xlen, "y": bounds.ylen, "z": bounds.zlen},
                    "fitsP1S": True,
                },
                "faces": [descriptor for _, descriptor in sources],
                "faceMatching": matching,
                "faceTessellation": mapping,
            })
        assembly_name = "assembly.3mf"
        _export_assembly_3mf([("主零件", main), ("配套零件", companion)], root / assembly_name)
        outputs = [
            value
            for part in parts
            for value in (
                part["stlFile"],
                part["stepFile"],
                part["faceTessellation"]["selectionMeshFile"],
                part["faceTessellation"]["mappingFile"],
            )
        ] + [assembly_name]
        manifest = {
            "status": "ok",
            "revision": "fixture-revision",
            "outputs": outputs,
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "printer": {"model": "Bambu Lab P1S", "buildVolumeMm": [256, 256, 256], "nozzleMm": 0.4},
            "model": {"id": "fixture", "name": "测试模型", "templateId": "test", "templateName": "测试"},
            "parameters": {},
            "interfaceOpeningMode": "custom",
            "interfaceOpenings": [],
            "openingValidation": {"count": 0, "bodyCount": 0, "coverCount": 0, "minimumEdgeMarginMm": None, "minimumSpacingMm": None},
            "faceMatching": main_matching,
            "parts": parts,
            "assemblyFile": assembly_name,
            "files": {name: {"bytes": (root / name).stat().st_size} for name in outputs},
        }
        (root / "generation-result.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        target = next(
            face for face in parts[0]["faces"]
            if face.get("geometryType") == "PLANE" and face.get("normal") == [0.0, 0.0, 1.0]
        )
        return manifest, target

    def _curved_project(
        self, root: Path
    ) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
        model = cq.Workplane("XY").cylinder(20, 10)
        sources, matching = match_shape_faces_with_sources(model)
        descriptors = [descriptor for _, descriptor in sources]
        target = next(
            descriptor for descriptor in descriptors if descriptor.get("geometryType") == "CYLINDER"
        )
        hit = resolve_surface_hit(
            model, descriptors, target["stableId"], (10.0, 0.0, 0.0), (1.0, 0.0, 0.0),
            target_face_descriptor=target,
        )
        stl_name = "curved-part.stl"
        step_name = "curved-part.step"
        selection_name = "curved-part-selection.stl"
        map_name = "curved-part-face-map.json"
        assembly_name = "curved-assembly.3mf"
        exporters.export(model, str(root / stl_name), tolerance=0.05)
        exporters.export(model, str(root / step_name))
        mapping = export_face_tessellation_mapping(
            root, "curved-part", sources, source_stl_file=stl_name,
            selection_mesh_file=selection_name, mapping_file=map_name,
        )
        _export_assembly_3mf([("曲面零件", model)], root / assembly_name)
        bounds = model.val().BoundingBox()
        part = {
            "id": "curved-part",
            "label": "曲面零件",
            "role": "primary",
            "stlFile": stl_name,
            "stepFile": step_name,
            "metrics": {
                "valid": True,
                "volumeMm3": model.val().Volume(),
                "boundsMm": {"x": bounds.xlen, "y": bounds.ylen, "z": bounds.zlen},
                "fitsP1S": True,
            },
            "faces": descriptors,
            "faceMatching": matching,
            "faceTessellation": mapping,
        }
        outputs = [stl_name, step_name, selection_name, map_name, assembly_name]
        manifest = {
            "status": "ok",
            "revision": "curved-fixture-revision",
            "outputs": outputs,
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "printer": {"model": "Bambu Lab P1S", "buildVolumeMm": [256, 256, 256], "nozzleMm": 0.4},
            "model": {"id": "curved-fixture", "name": "曲面测试模型", "templateId": "test", "templateName": "测试"},
            "parameters": {},
            "interfaceOpeningMode": "custom",
            "interfaceOpenings": [],
            "openingValidation": {"count": 0, "bodyCount": 0, "coverCount": 0, "minimumEdgeMarginMm": None, "minimumSpacingMm": None},
            "faceMatching": matching,
            "parts": [part],
            "assemblyFile": assembly_name,
            "files": {name: {"bytes": (root / name).stat().st_size} for name in outputs},
        }
        (root / "generation-result.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return manifest, target, hit

    def test_curved_hole_worker_persists_uv_and_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face, hit = self._curved_project(root)
            point = hit["projectedPointMm"]
            normal = hit["outwardNormal"]
            surface_uv = hit["surfaceUv"]
            surface_tangent_u = hit["surfaceTangentU"]

            result = edit_cad_feature(
                root,
                "cut-cylinder",
                manifest["revision"],
                "curved-part",
                face["stableId"],
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                2.0,
                4.0,
                "在曲面这里开直径 4 毫米、深 4 毫米的圆孔",
                surface_geometry_type="CYLINDER",
                surface_uv=(surface_uv["u"], surface_uv["v"]),
                surface_tangent_u=(
                    surface_tangent_u["x"],
                    surface_tangent_u["y"],
                    surface_tangent_u["z"],
                ),
            )

            self.assertNotEqual(result["revision"], manifest["revision"])
            self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
            self.assertEqual(result["validation"]["surfaceGeometryType"], "CYLINDER")
            self.assertEqual(result["validation"]["surfaceUv"], surface_uv)
            self.assertAlmostEqual(result["validation"]["curvatureRatio"], 0.2, places=6)
            self.assertAlmostEqual(result["validation"]["localWallThicknessMm"], 20.0, places=4)
            self.assertAlmostEqual(result["validation"]["remainingWallMm"], 16.0, places=4)
            self.assertFalse(result["validation"]["throughCut"])
            self.assertTrue(result["validation"]["interferenceCheckPassed"])
            self.assertFalse(result["validation"]["selfIntersectionDetected"])
            self.assertFalse(result["validation"]["adjacentFaceInterferenceDetected"])
            self.assertEqual(result["validation"]["interferingFaceCount"], 0)
            self.assertEqual(result["validation"]["interferingStableFaceIds"], [])
            self.assertIsNone(result["validation"]["minimumInterferenceDistanceMm"])
            self.assertGreaterEqual(result["validation"]["contactFaceCount"], 1)
            self.assertGreater(result["validation"]["contactSampleCount"], 0)
            feature = result["updatedCadResult"]["localFeatures"][0]
            self.assertEqual(feature["surfaceGeometryType"], "CYLINDER")
            self.assertEqual(feature["surfaceUv"], surface_uv)
            diagnostics = feature["curvedDiagnostics"]
            self.assertAlmostEqual(diagnostics["curvatureRatio"], 0.2, places=6)
            self.assertAlmostEqual(diagnostics["localWallThicknessMm"], 20.0, places=4)
            self.assertAlmostEqual(diagnostics["remainingWallMm"], 16.0, places=4)
            self.assertFalse(diagnostics["throughCut"])
            self.assertTrue(diagnostics["interferenceCheckPassed"])
            self.assertEqual(diagnostics["interferingStableFaceIds"], [])
            persisted = json.loads((root / "local-cad-feature-result.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["revision"], result["revision"])
            self.assertEqual(persisted["validation"]["surfaceUv"], surface_uv)
            generation_result = json.loads((root / "generation-result.json").read_text(encoding="utf-8"))
            self.assertEqual(
                generation_result["localFeatures"][0]["curvedDiagnostics"],
                diagnostics,
            )
            for name in (
                "curved-part.stl",
                "curved-part.step",
                "curved-part-selection.stl",
                "curved-part-face-map.json",
                "curved-assembly.3mf",
            ):
                self.assertTrue((root / name).is_file())
                self.assertGreater((root / name).stat().st_size, 0)

    def test_curved_slot_worker_persists_dimensions_and_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face, hit = self._curved_project(root)
            point = hit["projectedPointMm"]
            normal = hit["outwardNormal"]
            surface_uv = hit["surfaceUv"]
            surface_tangent_u = hit["surfaceTangentU"]

            result = edit_cad_feature(
                root, "cut-slot", manifest["revision"], "curved-part", face["stableId"],
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                None, 4.0, "在曲面这里开宽 3 毫米、长 6 毫米、深 4 毫米的槽孔",
                width_mm=3.0, length_mm=6.0, rotation_deg=20.0,
                surface_geometry_type="CYLINDER",
                surface_uv=(surface_uv["u"], surface_uv["v"]),
                surface_tangent_u=(
                    surface_tangent_u["x"],
                    surface_tangent_u["y"],
                    surface_tangent_u["z"],
                ),
            )

            feature = result["updatedCadResult"]["localFeatures"][0]
            self.assertEqual(feature["operation"], "cut-slot")
            self.assertEqual(feature["widthMm"], 3.0)
            self.assertEqual(feature["lengthMm"], 6.0)
            self.assertEqual(feature["rotationDeg"], 20.0)
            self.assertEqual(feature["surfaceTangentU"], surface_tangent_u)
            self.assertAlmostEqual(feature["curvedDiagnostics"]["curvatureRatio"], 0.3, places=6)
            self.assertTrue(feature["curvedDiagnostics"]["interferenceCheckPassed"])
            persisted = json.loads((root / "generation-result.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["localFeatures"][0]["curvedDiagnostics"], feature["curvedDiagnostics"])

    def test_adds_circular_boss_and_refreshes_manifest_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face = self._project(root)
            result = edit_cad_feature(
                root,
                "add-cylinder",
                manifest["revision"],
                "main-part",
                face["stableId"],
                (0, 0, 5),
                (0, 0, 1),
                2,
                2,
                "在这里增加直径 4 毫米、高 2 毫米的圆形凸台",
            )
            self.assertGreater(result["validation"]["volumeDeltaMm3"], 0)
            self.assertEqual(result["updatedCadResult"]["revision"], result["revision"])
            self.assertEqual(result["stableFaceStatus"], "inherited")
            self.assertTrue((root / "main-part-selection.stl").is_file())
            self.assertTrue((root / "main-part-face-map.json").is_file())
            self.assertTrue((root / "assembly.3mf").is_file())
            self.assertEqual(len(result["updatedCadResult"]["localFeatures"]), 1)

    def test_cuts_circular_hole_and_keeps_one_closed_solid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face = self._project(root)
            result = edit_cad_feature(
                root,
                "cut-cylinder",
                manifest["revision"],
                "main-part",
                face["stableId"],
                (0, 0, 5),
                (0, 0, 1),
                2,
                6,
                "在这里开直径 4 毫米、深 6 毫米的圆孔",
            )
            self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
            self.assertEqual(result["validation"]["solidCount"], 1)
            self.assertGreater(result["faceMatching"]["newFaceCount"], 0)

    def test_whole_face_outward_and_inward_refresh_manifest_assets(self) -> None:
        for operation, expected_sign, command in (
            ("offset-face-outward", 1, "将整个面向外拉伸 2 毫米"),
            ("offset-face-inward", -1, "将整个面向内偏移 2 毫米"),
        ):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest, face = self._project(root)
                result = edit_cad_feature(
                    root, operation, manifest["revision"], "main-part", face["stableId"],
                    (0, 0, 5), (0, 0, 1), None, 2, command,
                )
                self.assertGreater(result["validation"]["volumeDeltaMm3"] * expected_sign, 0)
                self.assertEqual(result["validation"]["solidCount"], 1)
                feature = result["updatedCadResult"]["localFeatures"][0]
                self.assertEqual(feature["operation"], operation)
                self.assertIsNone(feature["radiusMm"])
                self.assertIsNone(feature["widthMm"])
                self.assertIsNone(feature["heightMm"])
                self.assertIsNone(feature["lengthMm"])
                for name in ("main-part.stl", "main-part.step", "main-part-selection.stl", "main-part-face-map.json", "assembly.3mf"):
                    self.assertTrue((root / name).is_file())
                    self.assertGreater((root / name).stat().st_size, 0)

    def test_rejects_stale_selection_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, face = self._project(root)
            with self.assertRaisesRegex(ValueError, "triangleIndex 已失效"):
                edit_cad_feature(
                    root, "cut-cylinder", "old-revision", "main-part", face["stableId"],
                    (0, 0, 5), (0, 0, 1), 2, 4,
                )

    def test_rejects_mismatched_hit_normal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, face = self._project(root)
            with self.assertRaisesRegex(ValueError, "法线.*不一致"):
                edit_cad_feature(
                    root, "cut-cylinder", manifest["revision"], "main-part", face["stableId"],
                    (0, 0, 5), (0, 0, -1), 2, 4,
                )


if __name__ == "__main__":
    unittest.main()
