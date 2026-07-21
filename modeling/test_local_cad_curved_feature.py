"""真实 OpenCascade 曲面圆形、矩形与槽孔局部特征的受限执行测试。"""

from __future__ import annotations

import unittest

import cadquery as cq

from cad_surface_hit_core import resolve_surface_hit
from face_geometry_signatures import match_shape_faces_with_sources
from generate_model import _replay_local_features
from local_cad_feature_core import apply_planar_feature
from split_and_cap import _closed_solids


class LocalCadCurvedFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.model = cq.Workplane("XY").cylinder(20, 10)
        pairs, _ = match_shape_faces_with_sources(cls.model)
        cls.faces = [descriptor for _, descriptor in pairs]
        cls.descriptor = next(
            descriptor for descriptor in cls.faces if descriptor["geometryType"] == "CYLINDER"
        )
        cls.hit = resolve_surface_hit(
            cls.model,
            cls.faces,
            cls.descriptor["stableId"],
            (10.0, 0.0, 0.0),
            (1.0, 0.0, 0.0),
            target_face_descriptor=cls.descriptor,
        )

    def apply(
        self,
        operation: str,
        *,
        radius: float = 2.0,
        width: float = 3.0,
        height: float = 4.0,
        length: float = 6.0,
        depth: float = 4.0,
        rotation: float = 0.0,
        uv=None,
    ):
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        surface_uv = uv or (self.hit["surfaceUv"]["u"], self.hit["surfaceUv"]["v"])
        surface_tangent_u = self.hit["surfaceTangentU"]
        return apply_planar_feature(
            self.model,
            operation,  # type: ignore[arg-type]
            self.descriptor["stableId"],
            self.faces,
            (point["x"], point["y"], point["z"]),
            (normal["x"], normal["y"], normal["z"]),
            radius_mm=radius if operation in ("add-cylinder", "cut-cylinder") else None,
            width_mm=width if operation in ("add-rectangle", "cut-rectangle", "cut-slot") else None,
            height_mm=height if operation in ("add-rectangle", "cut-rectangle") else None,
            length_mm=length if operation == "cut-slot" else None,
            depth_mm=depth,
            rotation_deg=rotation,
            target_face_descriptor=self.descriptor,
            surface_geometry_type="CYLINDER",
            surface_uv=surface_uv,
            surface_tangent_u=(
                surface_tangent_u["x"],
                surface_tangent_u["y"],
                surface_tangent_u["z"],
            ) if operation in ("add-rectangle", "cut-rectangle", "cut-slot") else None,
        )

    def test_curved_boss_increases_volume_and_returns_diagnostics(self) -> None:
        result = self.apply("add-cylinder", depth=2.0)
        self.assertGreater(result["validation"]["volumeDeltaMm3"], 0)
        self.assertEqual(result["validation"]["surfaceGeometryType"], "CYLINDER")
        self.assertAlmostEqual(result["validation"]["curvatureRatio"], 0.2, places=6)
        self.assertAlmostEqual(result["validation"]["localWallThicknessMm"], 20.0, places=4)
        self.assertTrue(result["validation"]["interferenceCheckPassed"])
        self.assertFalse(result["validation"]["selfIntersectionDetected"])
        self.assertFalse(result["validation"]["adjacentFaceInterferenceDetected"])
        self.assertGreaterEqual(result["validation"]["contactFaceCount"], 1)
        self.assertGreater(result["validation"]["contactSampleCount"], 0)

    def test_curved_blind_hole_decreases_volume_and_keeps_wall(self) -> None:
        result = self.apply("cut-cylinder", depth=4.0)
        self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
        self.assertFalse(result["validation"]["throughCut"])
        self.assertAlmostEqual(result["validation"]["remainingWallMm"], 16.0, places=4)

    def test_result_is_valid_closed_single_solid(self) -> None:
        result = self.apply("cut-cylinder", depth=4.0)
        self.assertTrue(result["model"].val().isValid())
        self.assertEqual(len(_closed_solids(result["model"], "曲面圆孔结果")), 1)
        self.assertTrue(result["validation"]["watertight"])


    def test_curved_slot_decreases_volume_and_uses_conservative_envelope(self) -> None:
        result = self.apply("cut-slot", width=3.0, length=6.0, depth=4.0, rotation=25.0)
        self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
        self.assertAlmostEqual(result["validation"]["curvatureRatio"], 0.3, places=6)
        self.assertAlmostEqual(result["validation"]["localWallThicknessMm"], 20.0, places=4)
        self.assertAlmostEqual(result["validation"]["remainingWallMm"], 16.0, places=4)
        expected_tangent = self.hit["surfaceTangentU"]
        actual_tangent = result["validation"]["surfaceTangentU"]
        for axis in ("x", "y", "z"):
            self.assertAlmostEqual(actual_tangent[axis], expected_tangent[axis], places=7)
        self.assertFalse(result["validation"]["throughCut"])
        self.assertTrue(result["validation"]["interferenceCheckPassed"])
        self.assertTrue(result["model"].val().isValid())
        self.assertEqual(len(_closed_solids(result["model"], "曲面槽孔结果")), 1)

    def test_curved_directional_profiles_reject_stale_or_reversed_u_tangent(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        uv = self.hit["surfaceUv"]
        tangent = self.hit["surfaceTangentU"]
        for operation in ("cut-slot", "cut-rectangle"):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(ValueError, "U 切向与当前 OpenCascade 曲面方向不一致"):
                    apply_planar_feature(
                        self.model,
                        operation,  # type: ignore[arg-type]
                        self.descriptor["stableId"],
                        self.faces,
                        (point["x"], point["y"], point["z"]),
                        (normal["x"], normal["y"], normal["z"]),
                        radius_mm=None,
                        width_mm=3.0,
                        height_mm=4.0 if operation == "cut-rectangle" else None,
                        length_mm=6.0 if operation == "cut-slot" else None,
                        depth_mm=4.0,
                        target_face_descriptor=self.descriptor,
                        surface_geometry_type="CYLINDER",
                        surface_uv=(uv["u"], uv["v"]),
                        surface_tangent_u=(-tangent["x"], -tangent["y"], -tangent["z"]),
                    )

    def test_curved_slot_length_over_curvature_limit_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "槽孔包络半径与局部曲率之比"):
            self.apply("cut-slot", width=3.0, length=12.0, depth=4.0)

    def test_curved_rectangle_boss_and_hole_use_half_diagonal_envelope(self) -> None:
        boss = self.apply("add-rectangle", width=3.0, height=4.0, depth=2.0, rotation=30.0)
        hole = self.apply("cut-rectangle", width=3.0, height=4.0, depth=4.0, rotation=-20.0)
        self.assertGreater(boss["validation"]["volumeDeltaMm3"], 0)
        self.assertLess(hole["validation"]["volumeDeltaMm3"], 0)
        self.assertAlmostEqual(boss["validation"]["curvatureRatio"], 0.25, places=6)
        self.assertAlmostEqual(hole["validation"]["curvatureRatio"], 0.25, places=6)
        self.assertTrue(boss["validation"]["interferenceCheckPassed"])
        self.assertTrue(hole["validation"]["interferenceCheckPassed"])

    def test_curved_rectangle_half_diagonal_over_curvature_limit_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "矩形包络半径与局部曲率之比"):
            self.apply("add-rectangle", width=9.0, height=6.0, depth=2.0)

    def test_missing_uv_is_rejected(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        with self.assertRaisesRegex(ValueError, "缺少真实 UV"):
            apply_planar_feature(
                self.model,
                "add-cylinder",
                self.descriptor["stableId"],
                self.faces,
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                radius_mm=2.0,
                width_mm=None,
                height_mm=None,
                length_mm=None,
                depth_mm=2.0,
                target_face_descriptor=self.descriptor,
                surface_geometry_type="CYLINDER",
                surface_uv=None,
            )

    def test_uv_outside_trimmed_face_is_rejected(self) -> None:
        uv = self.hit["surfaceUv"]
        with self.assertRaisesRegex(ValueError, "不在当前裁剪面内"):
            self.apply("add-cylinder", depth=2.0, uv=(uv["u"], uv["v"] + 100.0))

    def test_curvature_ratio_over_limit_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "曲率之比"):
            self.apply("add-cylinder", radius=6.0, depth=2.0)

    def test_blind_hole_with_too_little_remaining_wall_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "剩余壁厚"):
            self.apply("cut-cylinder", depth=19.0)

    def test_through_hole_is_detected(self) -> None:
        result = self.apply("cut-cylinder", depth=20.0)
        self.assertTrue(result["validation"]["throughCut"])
        self.assertIsNone(result["validation"]["remainingWallMm"])
        self.assertTrue(result["validation"]["interferenceCheckPassed"])

    def test_curved_boss_self_intersection_is_rejected_before_boolean(self) -> None:
        outer = cq.Workplane("XY").cylinder(20, 10)
        model = outer.cut(cq.Workplane("XY").cylinder(20, 5)).clean()
        pairs, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in pairs]
        descriptor = min(
            (descriptor for descriptor in faces if descriptor["geometryType"] == "CYLINDER"),
            key=lambda descriptor: descriptor["areaMm2"],
        )
        hit = resolve_surface_hit(
            model,
            faces,
            descriptor["stableId"],
            (5.0, 0.0, 0.0),
            (-1.0, 0.0, 0.0),
            target_face_descriptor=descriptor,
        )
        point = hit["projectedPointMm"]
        normal = hit["outwardNormal"]
        uv = hit["surfaceUv"]

        with self.assertRaisesRegex(ValueError, "干涉检查未通过.*再次接触目标曲面"):
            apply_planar_feature(
                model,
                "add-cylinder",
                descriptor["stableId"],
                faces,
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                radius_mm=2.0,
                width_mm=None,
                height_mm=None,
                length_mm=None,
                depth_mm=12.0,
                target_face_descriptor=descriptor,
                surface_geometry_type="CYLINDER",
                surface_uv=(uv["u"], uv["v"]),
            )

    def test_curved_boss_adjacent_face_interference_is_rejected_before_boolean(self) -> None:
        base = cq.Workplane("XY").cylinder(20, 10)
        column = cq.Workplane("XY").box(2, 3, 9).translate((13, 0, 2.5))
        bridge = cq.Workplane("XY").box(6, 3, 2).translate((11, 0, 6))
        model = base.union(column).union(bridge).clean()
        pairs, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in pairs]
        descriptor = next(
            descriptor for descriptor in faces if descriptor["geometryType"] == "CYLINDER"
        )
        hit = resolve_surface_hit(
            model,
            faces,
            descriptor["stableId"],
            (10.0, 0.0, 0.0),
            (1.0, 0.0, 0.0),
            target_face_descriptor=descriptor,
        )
        point = hit["projectedPointMm"]
        normal = hit["outwardNormal"]
        uv = hit["surfaceUv"]

        with self.assertRaisesRegex(ValueError, "干涉检查未通过.*非目标稳定面"):
            apply_planar_feature(
                model,
                "add-cylinder",
                descriptor["stableId"],
                faces,
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                radius_mm=2.0,
                width_mm=None,
                height_mm=None,
                length_mm=None,
                depth_mm=4.0,
                target_face_descriptor=descriptor,
                surface_geometry_type="CYLINDER",
                surface_uv=(uv["u"], uv["v"]),
            )

    def test_curved_hole_edge_interference_is_rejected_before_boolean(self) -> None:
        base = cq.Workplane("XY").cylinder(20, 10)
        hole = (
            cq.Workplane("XY")
            .workplane(offset=-10)
            .center(5, 1.5)
            .circle(0.75)
            .extrude(20)
        )
        model = base.cut(hole).clean()
        pairs, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in pairs]
        descriptor = max(
            (descriptor for descriptor in faces if descriptor["geometryType"] == "CYLINDER"),
            key=lambda descriptor: descriptor["areaMm2"],
        )
        hit = resolve_surface_hit(
            model,
            faces,
            descriptor["stableId"],
            (10.0, 0.0, 0.0),
            (1.0, 0.0, 0.0),
            target_face_descriptor=descriptor,
        )
        point = hit["projectedPointMm"]
        normal = hit["outwardNormal"]
        uv = hit["surfaceUv"]

        with self.assertRaisesRegex(ValueError, "干涉检查未通过.*非目标稳定面"):
            apply_planar_feature(
                model,
                "cut-cylinder",
                descriptor["stableId"],
                faces,
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                radius_mm=2.0,
                width_mm=None,
                height_mm=None,
                length_mm=None,
                depth_mm=6.0,
                target_face_descriptor=descriptor,
                surface_geometry_type="CYLINDER",
                surface_uv=(uv["u"], uv["v"]),
            )

    def test_curved_feature_replays_and_preserves_surface_context(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        surface_uv = self.hit["surfaceUv"]
        volume_before = self.model.val().Volume()
        feature = {
            "operation": "add-cylinder",
            "partId": "generic-part",
            "stableFaceId": self.descriptor["stableId"],
            "centerMm": {"x": point["x"], "y": point["y"], "z": point["z"]},
            "outwardNormal": {"x": normal["x"], "y": normal["y"], "z": normal["z"]},
            "surfaceGeometryType": "CYLINDER",
            "surfaceUv": {"u": surface_uv["u"], "v": surface_uv["v"]},
            "radiusMm": 2.0,
            "widthMm": None,
            "heightMm": None,
            "lengthMm": None,
            "depthMm": 2.0,
            "rotationDeg": 0.0,
            "targetFace": self.descriptor,
            "command": "增加圆形凸台",
            "curvedDiagnostics": {
                "maximumAbsCurvaturePerMm": 999.0,
                "minimumCurvatureRadiusMm": 0.001,
                "curvatureRatio": 999.0,
                "localWallThicknessMm": 0.001,
                "remainingWallMm": 999.0,
                "throughCut": True,
                "interferenceCheckPassed": False,
                "selfIntersectionDetected": True,
                "adjacentFaceInterferenceDetected": True,
                "interferingFaceCount": 1,
                "interferingStableFaceIds": ["旧错误面"],
                "minimumInterferenceDistanceMm": 0.001,
                "contactFaceCount": 999,
                "contactSampleCount": 999,
            },
        }

        models, replayed = _replay_local_features(
            {"generic-part": self.model},
            {"generic-part": self.faces},
            [feature],
            "curved-replay-revision",
        )

        self.assertGreater(models["generic-part"].val().Volume(), volume_before)
        self.assertEqual(replayed[0]["replayStatus"], "replayed")
        self.assertEqual(replayed[0]["replayedRevision"], "curved-replay-revision")
        self.assertEqual(replayed[0]["surfaceGeometryType"], "CYLINDER")
        self.assertEqual(replayed[0]["surfaceUv"], feature["surfaceUv"])
        diagnostics = replayed[0]["curvedDiagnostics"]
        self.assertAlmostEqual(diagnostics["maximumAbsCurvaturePerMm"], 0.1, places=6)
        self.assertAlmostEqual(diagnostics["minimumCurvatureRadiusMm"], 10.0, places=6)
        self.assertAlmostEqual(diagnostics["curvatureRatio"], 0.2, places=6)
        self.assertAlmostEqual(diagnostics["localWallThicknessMm"], 20.0, places=4)
        self.assertIsNone(diagnostics["remainingWallMm"])
        self.assertFalse(diagnostics["throughCut"])
        self.assertTrue(diagnostics["interferenceCheckPassed"])
        self.assertFalse(diagnostics["selfIntersectionDetected"])
        self.assertFalse(diagnostics["adjacentFaceInterferenceDetected"])
        self.assertEqual(diagnostics["interferingStableFaceIds"], [])
        self.assertGreaterEqual(diagnostics["contactFaceCount"], 1)
        self.assertGreater(diagnostics["contactSampleCount"], 0)

    def test_legacy_curved_feature_without_diagnostics_is_backfilled_on_replay(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        surface_uv = self.hit["surfaceUv"]
        feature = {
            "operation": "cut-cylinder",
            "partId": "generic-part",
            "stableFaceId": self.descriptor["stableId"],
            "centerMm": {"x": point["x"], "y": point["y"], "z": point["z"]},
            "outwardNormal": {"x": normal["x"], "y": normal["y"], "z": normal["z"]},
            "surfaceGeometryType": "CYLINDER",
            "surfaceUv": {"u": surface_uv["u"], "v": surface_uv["v"]},
            "radiusMm": 2.0,
            "widthMm": None,
            "heightMm": None,
            "lengthMm": None,
            "depthMm": 4.0,
            "rotationDeg": 0.0,
            "targetFace": self.descriptor,
            "command": "旧版本曲面圆孔",
        }

        _, replayed = _replay_local_features(
            {"generic-part": self.model},
            {"generic-part": self.faces},
            [feature],
            "legacy-curved-replay-revision",
        )

        diagnostics = replayed[0]["curvedDiagnostics"]
        self.assertAlmostEqual(diagnostics["curvatureRatio"], 0.2, places=6)
        self.assertAlmostEqual(diagnostics["localWallThicknessMm"], 20.0, places=4)
        self.assertAlmostEqual(diagnostics["remainingWallMm"], 16.0, places=4)
        self.assertFalse(diagnostics["throughCut"])
        self.assertTrue(diagnostics["interferenceCheckPassed"])

    def test_curved_slot_replays_and_rebuilds_diagnostics(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        surface_uv = self.hit["surfaceUv"]
        feature = {
            "operation": "cut-slot",
            "partId": "generic-part",
            "stableFaceId": self.descriptor["stableId"],
            "centerMm": {"x": point["x"], "y": point["y"], "z": point["z"]},
            "outwardNormal": {"x": normal["x"], "y": normal["y"], "z": normal["z"]},
            "surfaceGeometryType": "CYLINDER",
            "surfaceUv": {"u": surface_uv["u"], "v": surface_uv["v"]},
            "radiusMm": None,
            "widthMm": 3.0,
            "heightMm": None,
            "lengthMm": 6.0,
            "depthMm": 4.0,
            "rotationDeg": 15.0,
            "targetFace": self.descriptor,
            "command": "创建曲面槽孔",
            "curvedDiagnostics": {"curvatureRatio": 999},
        }

        _, replayed = _replay_local_features(
            {"generic-part": self.model}, {"generic-part": self.faces}, [feature],
            "curved-slot-replay-revision",
        )

        self.assertEqual(replayed[0]["operation"], "cut-slot")
        self.assertEqual(replayed[0]["replayStatus"], "replayed")
        self.assertEqual(replayed[0]["surfaceTangentU"], self.hit["surfaceTangentU"])
        self.assertAlmostEqual(replayed[0]["curvedDiagnostics"]["curvatureRatio"], 0.3, places=6)
        self.assertTrue(replayed[0]["curvedDiagnostics"]["interferenceCheckPassed"])

    def test_legacy_curved_rectangle_replays_and_recomputes_u_tangent(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        surface_uv = self.hit["surfaceUv"]
        feature = {
            "operation": "cut-rectangle",
            "partId": "generic-part",
            "stableFaceId": self.descriptor["stableId"],
            "centerMm": {"x": point["x"], "y": point["y"], "z": point["z"]},
            "outwardNormal": {"x": normal["x"], "y": normal["y"], "z": normal["z"]},
            "surfaceGeometryType": "CYLINDER",
            "surfaceUv": {"u": surface_uv["u"], "v": surface_uv["v"]},
            "radiusMm": None,
            "widthMm": 3.0,
            "heightMm": 4.0,
            "lengthMm": None,
            "depthMm": 4.0,
            "rotationDeg": -20.0,
            "targetFace": self.descriptor,
            "command": "创建曲面矩形孔",
            "curvedDiagnostics": {"curvatureRatio": 999},
        }

        _, replayed = _replay_local_features(
            {"generic-part": self.model}, {"generic-part": self.faces}, [feature],
            "curved-rectangle-replay-revision",
        )

        self.assertEqual(replayed[0]["operation"], "cut-rectangle")
        self.assertEqual(replayed[0]["rotationDeg"], -20.0)
        self.assertEqual(replayed[0]["surfaceTangentU"], self.hit["surfaceTangentU"])
        self.assertAlmostEqual(replayed[0]["curvedDiagnostics"]["curvatureRatio"], 0.25, places=6)
        self.assertTrue(replayed[0]["curvedDiagnostics"]["interferenceCheckPassed"])

    def test_curved_feature_replay_without_uv_is_rejected_before_model_change(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        models = {"generic-part": self.model}
        volume_before = self.model.val().Volume()
        feature = {
            "operation": "cut-cylinder",
            "partId": "generic-part",
            "stableFaceId": self.descriptor["stableId"],
            "centerMm": {"x": point["x"], "y": point["y"], "z": point["z"]},
            "outwardNormal": {"x": normal["x"], "y": normal["y"], "z": normal["z"]},
            "surfaceGeometryType": "CYLINDER",
            "radiusMm": 2.0,
            "widthMm": None,
            "heightMm": None,
            "lengthMm": None,
            "depthMm": 4.0,
            "rotationDeg": 0.0,
            "targetFace": self.descriptor,
            "command": "开圆孔",
        }

        with self.assertRaisesRegex(ValueError, "曲面局部特征记录缺少真实 UV.*已保留修改前模型"):
            _replay_local_features(
                models,
                {"generic-part": self.faces},
                [feature],
                "curved-replay-revision",
            )

        self.assertAlmostEqual(models["generic-part"].val().Volume(), volume_before, places=6)

    def test_wrong_surface_type_is_rejected(self) -> None:
        point = self.hit["projectedPointMm"]
        normal = self.hit["outwardNormal"]
        uv = self.hit["surfaceUv"]
        with self.assertRaisesRegex(ValueError, "曲面类型"):
            apply_planar_feature(
                self.model,
                "add-cylinder",
                self.descriptor["stableId"],
                self.faces,
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                radius_mm=2.0,
                width_mm=None,
                height_mm=None,
                length_mm=None,
                depth_mm=2.0,
                target_face_descriptor=self.descriptor,
                surface_geometry_type="SPHERE",
                surface_uv=(uv["u"], uv["v"]),
            )

    def test_thin_curved_wall_rejects_boss(self) -> None:
        outer = cq.Workplane("XY").cylinder(20, 10)
        inner = cq.Workplane("XY").cylinder(20, 9.5)
        model = outer.cut(inner)
        pairs, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in pairs]
        descriptor = max(
            (value for value in faces if value["geometryType"] == "CYLINDER"),
            key=lambda value: value["boundsMm"]["x"],
        )
        hit = resolve_surface_hit(
            model, faces, descriptor["stableId"], (10.0, 0.0, 0.0), (1.0, 0.0, 0.0),
            target_face_descriptor=descriptor,
        )
        point = hit["projectedPointMm"]
        normal = hit["outwardNormal"]
        uv = hit["surfaceUv"]
        with self.assertRaisesRegex(ValueError, "小于曲面凸台要求"):
            apply_planar_feature(
                model, "add-cylinder", descriptor["stableId"], faces,
                (point["x"], point["y"], point["z"]),
                (normal["x"], normal["y"], normal["z"]),
                radius_mm=2.0, width_mm=None, height_mm=None, length_mm=None, depth_mm=2.0,
                target_face_descriptor=descriptor, surface_geometry_type="CYLINDER",
                surface_uv=(uv["u"], uv["v"]),
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
