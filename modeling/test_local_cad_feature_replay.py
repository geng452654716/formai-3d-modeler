"""参数化整模重建时稳定 CAD 面局部特征安全重放的自动化回归测试。"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any

import cadquery as cq

from face_geometry_signatures import match_shape_faces_with_sources
from generate_model import EnclosureParameters, _replay_local_features, export_models
from local_cad_feature import edit_cad_feature
from local_cad_feature_core import apply_edge_feature


class LocalCadFeatureReplayTests(unittest.TestCase):
    parameters = EnclosureParameters()

    def _export(self, root: Path) -> dict[str, Any]:
        with contextlib.redirect_stdout(io.StringIO()):
            export_models(self.parameters, root)
        return self._manifest(root)

    def _manifest(self, root: Path) -> dict[str, Any]:
        return json.loads((root / "generation-result.json").read_text(encoding="utf-8"))

    def _write_manifest(self, root: Path, manifest: dict[str, Any]) -> None:
        (root / "generation-result.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _part(self, manifest: dict[str, Any], part_id: str = "body") -> dict[str, Any]:
        return next(part for part in manifest["parts"] if part["id"] == part_id)

    def _bottom_face(self, manifest: dict[str, Any]) -> dict[str, Any]:
        candidates = [
            face
            for face in self._part(manifest)["faces"]
            if face.get("geometryType") == "PLANE"
            and face.get("normal") == [0.0, 0.0, -1.0]
        ]
        self.assertTrue(candidates, "主体应包含可安全定位的外底面")
        return max(candidates, key=lambda face: float(face.get("areaMm2", 0)))

    def _edit(
        self,
        root: Path,
        manifest: dict[str, Any],
        operation: str,
        *,
        center: tuple[float, float, float] = (0.0, 0.0, 0.0),
        radius_mm: float | None = None,
        width_mm: float | None = None,
        height_mm: float | None = None,
        length_mm: float | None = None,
        depth_mm: float = 3.0,
        rotation_deg: float = 0.0,
        command: str | None = None,
    ) -> dict[str, Any]:
        face = self._bottom_face(manifest)
        with contextlib.redirect_stdout(io.StringIO()):
            return edit_cad_feature(
                root,
                operation,  # type: ignore[arg-type]
                str(manifest["revision"]),
                "body",
                str(face["stableId"]),
                center,
                (0.0, 0.0, -1.0),
                radius_mm if radius_mm is not None else (2.0 if operation in ("add-cylinder", "cut-cylinder") else None),
                depth_mm,
                command or f"测试重放 {operation}",
                width_mm=width_mm,
                height_mm=height_mm,
                length_mm=length_mm,
                rotation_deg=rotation_deg,
            )

    def _bottom_edge(self, manifest: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        face = self._bottom_face(manifest)
        edges = [edge for edge in face.get("edges", []) if edge.get("geometryType") == "LINE"]
        self.assertTrue(edges, "主体外底面应包含可安全定位的直线边")
        return face, max(edges, key=lambda edge: float(edge.get("lengthMm", 0)))

    def _edit_edge(
        self,
        root: Path,
        manifest: dict[str, Any],
        operation: str = "chamfer-edge",
        size_mm: float = 0.6,
    ) -> dict[str, Any]:
        face, edge = self._bottom_edge(manifest)
        with contextlib.redirect_stdout(io.StringIO()):
            return edit_cad_feature(
                root,
                operation,  # type: ignore[arg-type]
                str(manifest["revision"]),
                "body",
                str(face["stableId"]),
                tuple(float(value) for value in edge["centerMm"]),
                (0.0, 0.0, -1.0),
                None,
                size_mm,
                f"测试重放 {operation}",
                stable_edge_id=str(edge["stableId"]),
            )

    def _curved_edge_replay_fixture(
        self,
    ) -> tuple[cq.Workplane, list[dict[str, Any]], dict[str, Any]]:
        """创建不依赖示例外壳的圆柱曲面稳定边重放记录。"""
        model = cq.Workplane("XY").cylinder(10, 5)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(value for value in faces if value.get("geometryType") == "CYLINDER")
        edge = next(
            value for value in face.get("edges", [])
            if value.get("geometryType") == "CIRCLE"
        )
        point = [float(value) for value in edge["samplePointsMm"][0]]
        record = {
            "operation": "chamfer-edge",
            "partId": "generic-part",
            "stableFaceId": face["stableId"],
            "stableEdgeId": edge["stableId"],
            "surfaceGeometryType": "CYLINDER",
            "surfaceUv": {"u": 0.0, "v": 0.0},
            "centerMm": {"x": point[0], "y": point[1], "z": point[2]},
            "outwardNormal": {"x": 1.0, "y": 0.0, "z": 0.0},
            "targetFace": face,
            "targetEdge": edge,
            "radiusMm": None,
            "widthMm": None,
            "heightMm": None,
            "lengthMm": None,
            "depthMm": 1.0,
            "rotationDeg": 0.0,
            "command": "将这条圆柱面边做 1 毫米倒角",
        }
        return model, faces, record

    def _tangent_chain_replay_fixture(
        self,
    ) -> tuple[cq.Workplane, list[dict[str, Any]], dict[str, Any]]:
        """创建包含两条共线分段边的切线连续边链重放记录。"""
        points = [(-10, -5), (0, -5), (10, -5), (10, 5), (-10, 5)]
        model = cq.Workplane("XY").polyline(points).close().extrude(10, clean=False)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(
            value for value in faces
            if value.get("geometryType") == "PLANE"
            and abs(float(value["centerMm"][2])) < 1e-6
        )
        edge = next(
            value for value in face["edges"]
            if abs(float(value["lengthMm"]) - 10.0) < 1e-6
            and abs(float(value["centerMm"][1]) + 5.0) < 1e-6
        )
        center = [float(value) for value in edge["centerMm"]]
        record = {
            "operation": "fillet-edge-chain",
            "partId": "generic-part",
            "stableFaceId": face["stableId"],
            "stableEdgeId": edge["stableId"],
            "surfaceGeometryType": "PLANE",
            "surfaceUv": None,
            "centerMm": {"x": center[0], "y": center[1], "z": center[2]},
            "outwardNormal": {"x": 0.0, "y": 0.0, "z": -1.0},
            "targetFace": face,
            "targetEdge": edge,
            "radiusMm": None,
            "widthMm": None,
            "heightMm": None,
            "lengthMm": None,
            "depthMm": 1.0,
            "rotationDeg": 0.0,
            "command": "沿切线链做 1 毫米圆角",
        }
        return model, faces, record

    def _manual_chain_replay_fixture(
        self,
        operation: str = "fillet-edge-manual-chain",
    ) -> tuple[cq.Workplane, list[dict[str, Any]], dict[str, Any]]:
        """创建两条相邻稳定边组成的手工开放链重放记录。"""
        model = cq.Workplane("XY").box(20, 16, 10)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(
            value for value in faces
            if value.get("geometryType") == "PLANE"
            and value.get("normal") == [0.0, 0.0, 1.0]
        )
        edges_by_center = {
            tuple(float(value) for value in edge["centerMm"]): edge
            for edge in face["edges"]
        }
        edge_targets = []
        for center in ((0.0, -8.0, 5.0), (10.0, 0.0, 5.0)):
            edge = edges_by_center[center]
            edge_targets.append({
                "stableFaceId": face["stableId"],
                "stableEdgeId": edge["stableId"],
                "centerMm": {"x": center[0], "y": center[1], "z": center[2]},
                "outwardNormal": {"x": 0.0, "y": 0.0, "z": 1.0},
                "surfaceGeometryType": "PLANE",
                "surfaceUv": {"u": center[0], "v": center[1]},
                "targetFace": copy.deepcopy(face),
                "targetEdge": copy.deepcopy(edge),
            })
        first = edge_targets[0]
        record = {
            "operation": operation,
            "partId": "generic-part",
            "stableFaceId": face["stableId"],
            "stableEdgeId": None,
            "edgeTargets": edge_targets,
            "surfaceGeometryType": "PLANE",
            "surfaceUv": None,
            "centerMm": dict(first["centerMm"]),
            "outwardNormal": dict(first["outwardNormal"]),
            "targetFace": copy.deepcopy(face),
            "targetEdge": None,
            "radiusMm": None,
            "widthMm": None,
            "heightMm": None,
            "lengthMm": None,
            "depthMm": 1.0,
            "rotationDeg": 0.0,
            "command": "将手工选中的两条相邻边做 1 毫米圆角",
        }
        return model, faces, record

    def _file_digests(self, root: Path, manifest: dict[str, Any]) -> dict[str, str]:
        names = [
            name
            for name in manifest.get("outputs", [])
            if isinstance(name, str) and (root / name).is_file()
        ]
        return {
            name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in names
        }

    def test_add_boss_replays_and_refreshes_all_selection_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            edited = self._edit(root, initial, "add-cylinder")
            edited_manifest = edited["updatedCadResult"]
            edited_volume = self._part(edited_manifest)["metrics"]["volumeMm3"]

            rebuilt = self._export(root)

            self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], edited_volume)
            self.assertEqual(rebuilt["localFeatureReplay"]["status"], "ok")
            self.assertEqual(rebuilt["localFeatureReplay"]["requestedCount"], 1)
            self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 1)
            self.assertEqual(rebuilt["localFeatures"][0]["replayStatus"], "replayed")
            self.assertEqual(
                rebuilt["localFeatures"][0]["replayedRevision"],
                rebuilt["revision"],
            )
            self.assertIsNone(rebuilt["localFeatures"][0]["failureReason"])

            body = self._part(rebuilt)
            mapping = body["faceTessellation"]
            self.assertEqual(mapping["sourceStlFile"], body["stlFile"])
            self.assertGreater(mapping["triangleCount"], 0)
            self.assertEqual(mapping["faceCount"], len(body["faces"]))
            self.assertTrue((root / mapping["selectionMeshFile"]).is_file())
            self.assertTrue((root / mapping["mappingFile"]).is_file())
            for name in rebuilt["outputs"]:
                self.assertGreater((root / name).stat().st_size, 0)
                self.assertEqual(rebuilt["files"][name]["bytes"], (root / name).stat().st_size)
            with zipfile.ZipFile(root / rebuilt["assemblyFile"]) as archive:
                self.assertIn("3D/3dmodel.model", archive.namelist())

    def test_cut_hole_replays_with_same_volume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            edited = self._edit(root, initial, "cut-cylinder", depth_mm=4.0)
            edited_volume = self._part(edited["updatedCadResult"])["metrics"]["volumeMm3"]

            rebuilt = self._export(root)

            self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], edited_volume)
            self.assertEqual(rebuilt["localFeatures"][0]["operation"], "cut-cylinder")
            self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 1)


    def test_planar_profile_features_replay_with_same_volume(self) -> None:
        cases = (
            ("add-rectangle", {"width_mm": 8.0, "height_mm": 5.0, "depth_mm": 2.0, "rotation_deg": 30.0}),
            ("cut-rectangle", {"width_mm": 8.0, "height_mm": 5.0, "depth_mm": 1.5, "rotation_deg": -20.0}),
            ("cut-slot", {"width_mm": 4.0, "length_mm": 12.0, "depth_mm": 1.5, "rotation_deg": 45.0}),
        )
        for operation, dimensions in cases:
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                initial = self._export(root)
                edited = self._edit(root, initial, operation, **dimensions)
                expected_volume = self._part(edited["updatedCadResult"])["metrics"]["volumeMm3"]
                rebuilt = self._export(root)
                self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], expected_volume)
                feature = rebuilt["localFeatures"][0]
                self.assertEqual(feature["operation"], operation)
                self.assertEqual(feature["rotationDeg"], dimensions["rotation_deg"])
                self.assertEqual(rebuilt["localFeatureReplay"]["requestedCount"], 1)
                self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 1)

    def test_whole_face_features_use_parameterized_safe_replay(self) -> None:
        for operation, expected_delta in (
            ("offset-face-outward", 30 * 24 * 2),
            ("offset-face-inward", -(30 * 24 * 2)),
        ):
            with self.subTest(operation=operation):
                model = cq.Workplane("XY").box(30, 24, 10)
                sources, _ = match_shape_faces_with_sources(model)
                faces = [descriptor for _, descriptor in sources]
                face = next(value for value in faces if value.get("normal") == [0.0, 0.0, 1.0])
                record = {
                    "revision": "recorded-revision",
                    "createdRevision": "recorded-revision",
                    "operation": operation,
                    "partId": "body",
                    "stableFaceId": face["stableId"],
                    "centerMm": {"x": 0.0, "y": 0.0, "z": 5.0},
                    "outwardNormal": {"x": 0.0, "y": 0.0, "z": 1.0},
                    "targetFace": face,
                    "radiusMm": None,
                    "widthMm": None,
                    "heightMm": None,
                    "lengthMm": None,
                    "depthMm": 2.0,
                    "rotationDeg": 0.0,
                    "command": f"测试重放 {operation}",
                }
                models, replayed = _replay_local_features(
                    {"body": model}, {"body": faces}, [record], "rebuilt-revision"
                )
                self.assertAlmostEqual(models["body"].val().Volume() - model.val().Volume(), expected_delta, places=4)
                self.assertEqual(len(replayed), 1)
                self.assertEqual(replayed[0]["operation"], operation)
                self.assertEqual(replayed[0]["replayStatus"], "replayed")
                self.assertEqual(replayed[0]["replayedRevision"], "rebuilt-revision")
                self.assertIsNone(replayed[0]["radiusMm"])
                self.assertIsNone(replayed[0]["widthMm"])
                self.assertIsNone(replayed[0]["heightMm"])
                self.assertIsNone(replayed[0]["lengthMm"])

    def test_multiple_features_replay_in_recorded_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            first = self._edit(
                root,
                initial,
                "add-cylinder",
                center=(-8.0, 0.0, 0.0),
                command="先在左侧增加圆形凸台",
            )
            second = self._edit(
                root,
                first["updatedCadResult"],
                "cut-cylinder",
                center=(8.0, 0.0, 0.0),
                depth_mm=4.0,
                command="再在右侧切除圆孔",
            )
            expected_volume = self._part(second["updatedCadResult"])["metrics"]["volumeMm3"]

            rebuilt = self._export(root)

            self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], expected_volume)
            self.assertEqual(
                [feature["operation"] for feature in rebuilt["localFeatures"]],
                ["add-cylinder", "cut-cylinder"],
            )
            self.assertEqual(rebuilt["localFeatureReplay"]["requestedCount"], 2)
            self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 2)

    def test_repeated_rebuild_does_not_duplicate_feature(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            self._edit(root, initial, "add-cylinder")

            first_rebuild = self._export(root)
            second_rebuild = self._export(root)

            self.assertEqual(
                self._part(first_rebuild)["metrics"]["volumeMm3"],
                self._part(second_rebuild)["metrics"]["volumeMm3"],
            )
            self.assertEqual(len(second_rebuild["localFeatures"]), 1)
            self.assertEqual(second_rebuild["localFeatureReplay"]["requestedCount"], 1)
            self.assertEqual(second_rebuild["localFeatureReplay"]["replayedCount"], 1)

    def test_center_mismatch_rejects_without_overwriting_last_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            self._edit(root, initial, "add-cylinder")
            manifest = self._manifest(root)
            manifest["localFeatures"][0]["centerMm"]["z"] += 20.0
            self._write_manifest(root, manifest)
            manifest_bytes = (root / "generation-result.json").read_bytes()
            output_digests = self._file_digests(root, manifest)

            with self.assertRaisesRegex(ValueError, "记录中心距离当前稳定面.*已保留修改前模型"):
                self._export(root)

            self.assertEqual((root / "generation-result.json").read_bytes(), manifest_bytes)
            self.assertEqual(self._file_digests(root, manifest), output_digests)

    def test_reversed_normal_and_unknown_part_are_rejected(self) -> None:
        for mutation, expected in (
            (lambda record: record.__setitem__("outwardNormal", {"x": 0, "y": 0, "z": 1}), "记录法线与当前 OpenCascade 面方向不一致"),
            (lambda record: record.__setitem__("partId", "不存在的零件"), "目标零件 不存在的零件 不属于当前参数化模型"),
        ):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                initial = self._export(root)
                self._edit(root, initial, "add-cylinder")
                manifest = self._manifest(root)
                mutation(manifest["localFeatures"][0])
                self._write_manifest(root, manifest)
                digests = self._file_digests(root, manifest)

                with self.assertRaisesRegex(ValueError, expected):
                    self._export(root)

                self.assertEqual(self._file_digests(root, manifest), digests)

    def test_target_face_snapshot_recovers_when_final_face_list_lacks_old_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            edited = self._edit(root, initial, "add-cylinder")
            manifest = edited["updatedCadResult"]
            feature = manifest["localFeatures"][0]
            target_face = feature["targetFace"]
            stable_face_id = feature["stableFaceId"]
            self.assertEqual(target_face["stableId"], stable_face_id)

            body = self._part(manifest)
            body["faces"] = [
                face for face in body["faces"] if face.get("stableId") != stable_face_id
            ]
            self._write_manifest(root, manifest)
            expected_volume = body["metrics"]["volumeMm3"]

            rebuilt = self._export(root)

            self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], expected_volume)
            self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 1)
            self.assertEqual(rebuilt["localFeatures"][0]["targetFace"]["stableId"], stable_face_id)


    def test_single_edge_chamfer_replays_with_same_volume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            edited = self._edit_edge(root, initial)
            edited_manifest = edited["updatedCadResult"]
            expected_volume = self._part(edited_manifest)["metrics"]["volumeMm3"]
            feature = edited_manifest["localFeatures"][0]
            self.assertEqual(feature["operation"], "chamfer-edge")
            self.assertTrue(feature["stableEdgeId"].startswith("edge-"))
            self.assertEqual(feature["targetEdge"]["stableId"], feature["stableEdgeId"])

            rebuilt = self._export(root)

            self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], expected_volume)
            self.assertEqual(rebuilt["localFeatureReplay"]["requestedCount"], 1)
            self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 1)
            self.assertEqual(rebuilt["localFeatures"][0]["replayStatus"], "replayed")

    def test_planar_boundary_loop_chamfer_replays_with_same_volume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            edited = self._edit_edge(root, initial, operation="chamfer-edge-loop", size_mm=0.6)
            edited_manifest = edited["updatedCadResult"]
            expected_volume = self._part(edited_manifest)["metrics"]["volumeMm3"]
            feature = edited_manifest["localFeatures"][0]
            seed_edge_id = feature["stableEdgeId"]
            self.assertEqual(feature["operation"], "chamfer-edge-loop")
            self.assertEqual(feature["targetEdge"]["stableId"], seed_edge_id)
            self.assertGreaterEqual(edited["validation"]["affectedEdgeCount"], 2)
            self.assertLessEqual(edited["validation"]["affectedEdgeCount"], 64)
            self.assertEqual(edited["validation"]["edgeScope"], "loop")

            rebuilt = self._export(root)

            self.assertEqual(self._part(rebuilt)["metrics"]["volumeMm3"], expected_volume)
            replayed = rebuilt["localFeatures"][0]
            self.assertEqual(replayed["operation"], "chamfer-edge-loop")
            self.assertEqual(replayed["stableEdgeId"], seed_edge_id)
            self.assertEqual(replayed["targetEdge"]["stableId"], seed_edge_id)
            self.assertEqual(replayed["replayStatus"], "replayed")
            self.assertEqual(rebuilt["localFeatureReplay"]["requestedCount"], 1)
            self.assertEqual(rebuilt["localFeatureReplay"]["replayedCount"], 1)

    def test_tangent_chain_replays_by_rediscovering_current_topology(self) -> None:
        model, faces, record = self._tangent_chain_replay_fixture()
        direct = apply_edge_feature(
            model, faces, "fillet-edge-chain", record["stableFaceId"],
            record["stableEdgeId"],
            (record["centerMm"]["x"], record["centerMm"]["y"], record["centerMm"]["z"]),
            (0.0, 0.0, -1.0), 1.0,
            target_face_descriptor=record["targetFace"],
            target_edge_descriptor=record["targetEdge"],
        )
        models, replayed = _replay_local_features(
            {"generic-part": model},
            {"generic-part": faces},
            [record],
            "tangent-chain-replay",
        )
        self.assertAlmostEqual(models["generic-part"].val().Volume(), direct["model"].val().Volume(), places=6)
        self.assertEqual(replayed[0]["operation"], "fillet-edge-chain")
        self.assertEqual(replayed[0]["stableEdgeId"], record["stableEdgeId"])
        self.assertEqual(replayed[0]["replayStatus"], "replayed")

    def test_manual_open_chain_replays_and_refreshes_each_edge_snapshot(self) -> None:
        model, faces, record = self._manual_chain_replay_fixture()
        original_targets = record["edgeTargets"]
        for target in original_targets:
            target["targetFace"]["测试旧快照标记"] = True
            target["targetEdge"]["测试旧快照标记"] = True
        direct_targets = [
            {
                "stableFaceId": target["stableFaceId"],
                "stableEdgeId": target["stableEdgeId"],
                "center": {
                    "xMm": target["centerMm"]["x"],
                    "yMm": target["centerMm"]["y"],
                    "zMm": target["centerMm"]["z"],
                },
                "hitNormal": dict(target["outwardNormal"]),
                "surfaceGeometryType": target["surfaceGeometryType"],
                "surfaceUv": dict(target["surfaceUv"]),
                "targetFace": target["targetFace"],
                "targetEdge": target["targetEdge"],
            }
            for target in original_targets
        ]
        direct = apply_edge_feature(
            model,
            faces,
            "fillet-edge-manual-chain",
            record["stableFaceId"],
            "",
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 1.0),
            1.0,
            manual_edge_targets=direct_targets,
        )

        models, replayed = _replay_local_features(
            {"generic-part": model},
            {"generic-part": faces},
            [record],
            "manual-chain-replay",
        )

        self.assertAlmostEqual(
            models["generic-part"].val().Volume(),
            direct["model"].val().Volume(),
            places=6,
        )
        replayed_record = replayed[0]
        self.assertEqual(replayed_record["operation"], "fillet-edge-manual-chain")
        self.assertEqual(replayed_record["replayStatus"], "replayed")
        self.assertEqual(replayed_record["replayedRevision"], "manual-chain-replay")
        self.assertEqual(
            [target["stableEdgeId"] for target in replayed_record["edgeTargets"]],
            [target["stableEdgeId"] for target in original_targets],
        )
        for target in replayed_record["edgeTargets"]:
            self.assertNotIn("测试旧快照标记", target["targetFace"])
            self.assertNotIn("测试旧快照标记", target["targetEdge"])

    def test_manual_chain_replay_rejects_stale_edge_id_or_snapshot_atomically(self) -> None:
        mutations = (
            (
                lambda value: value["edgeTargets"][1].__setitem__("stableEdgeId", "edge-invalid"),
                "稳定边 ID 与几何签名快照不一致",
            ),
            (
                lambda value: value["edgeTargets"][1]["targetEdge"].__setitem__(
                    "centerMm", [500.0, 500.0, 500.0]
                ),
                "几何签名",
            ),
        )
        for mutation, expected in mutations:
            with self.subTest(expected=expected):
                model, faces, record = self._manual_chain_replay_fixture()
                original_volume = model.val().Volume()
                models = {"generic-part": model}
                mutation(record)

                with self.assertRaisesRegex(ValueError, expected):
                    _replay_local_features(
                        models,
                        {"generic-part": faces},
                        [record],
                        "manual-chain-replay-invalid",
                    )

                self.assertIs(models["generic-part"], model)
                self.assertAlmostEqual(models["generic-part"].val().Volume(), original_volume)

    def test_curved_owner_edge_replays_with_real_uv_safety_chain(self) -> None:
        model, faces, record = self._curved_edge_replay_fixture()
        original_volume = model.val().Volume()

        models, replayed = _replay_local_features(
            {"generic-part": model},
            {"generic-part": faces},
            [record],
            "curved-edge-replay",
        )

        rebuilt = models["generic-part"]
        self.assertTrue(rebuilt.val().isValid())
        self.assertEqual(len(rebuilt.solids().vals()), 1)
        self.assertLess(rebuilt.val().Volume(), original_volume)
        self.assertEqual(replayed[0]["replayStatus"], "replayed")
        self.assertEqual(replayed[0]["replayedRevision"], "curved-edge-replay")
        self.assertEqual(replayed[0]["surfaceUv"], {"u": 0.0, "v": 0.0})
        self.assertEqual(replayed[0]["targetEdge"]["stableId"], record["stableEdgeId"])

    def test_curved_owner_edge_replay_rejects_missing_or_stale_uv_without_replacing_model(self) -> None:
        for mutation, expected in (
            (lambda value: value.pop("surfaceUv"), "曲面局部特征记录缺少真实 UV"),
            (
                lambda value: value.__setitem__("surfaceUv", {"u": 3.141592653589793, "v": 10.0}),
                "真实 UV 点",
            ),
        ):
            with self.subTest(expected=expected):
                model, faces, record = self._curved_edge_replay_fixture()
                original_volume = model.val().Volume()
                mutation(record)
                models = {"generic-part": model}

                with self.assertRaisesRegex(ValueError, expected):
                    _replay_local_features(
                        models,
                        {"generic-part": faces},
                        [record],
                        "curved-edge-replay-invalid",
                    )

                self.assertIs(models["generic-part"], model)
                self.assertAlmostEqual(models["generic-part"].val().Volume(), original_volume)

    def test_invalid_edge_id_replay_rejects_without_overwriting_last_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = self._export(root)
            self._edit_edge(root, initial)
            manifest = self._manifest(root)
            manifest["localFeatures"][0]["stableEdgeId"] = "edge-invalid"
            self._write_manifest(root, manifest)
            manifest_bytes = (root / "generation-result.json").read_bytes()
            output_digests = self._file_digests(root, manifest)

            with self.assertRaisesRegex(ValueError, "稳定边 ID 与边签名快照不一致.*已保留修改前模型"):
                self._export(root)

            self.assertEqual((root / "generation-result.json").read_bytes(), manifest_bytes)
            self.assertEqual(self._file_digests(root, manifest), output_digests)


if __name__ == "__main__":
    unittest.main(verbosity=2)
