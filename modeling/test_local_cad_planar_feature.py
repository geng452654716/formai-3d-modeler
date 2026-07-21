"""稳定 CAD 平面轮廓与整面特征几何核心测试。"""

from __future__ import annotations

import unittest

import cadquery as cq

from face_geometry_signatures import match_shape_faces_with_sources
from local_cad_feature_core import apply_planar_feature, validate_planar_feature_inputs


class LocalCadPlanarFeatureTests(unittest.TestCase):
    def _fixture(self):
        model = cq.Workplane("XY").box(30, 24, 10)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = next(value for value in faces if value.get("normal") == [0.0, 0.0, 1.0])
        return model, faces, face

    def _apply(self, operation: str, **dimensions):
        model, faces, face = self._fixture()
        return apply_planar_feature(
            model, operation, face["stableId"], faces, (0, 0, 5), (0, 0, 1),
            radius_mm=dimensions.get("radius_mm"), width_mm=dimensions.get("width_mm"),
            height_mm=dimensions.get("height_mm"), length_mm=dimensions.get("length_mm"),
            depth_mm=dimensions.get("depth_mm", 3), rotation_deg=dimensions.get("rotation_deg", 0),
        )

    def test_rectangle_boss_increases_volume_and_supports_rotation(self):
        result = self._apply("add-rectangle", width_mm=8, height_mm=5, depth_mm=2, rotation_deg=35)
        self.assertGreater(result["validation"]["volumeDeltaMm3"], 0)
        self.assertEqual(result["validation"]["solidCount"], 1)

    def test_rectangle_hole_decreases_volume(self):
        result = self._apply("cut-rectangle", width_mm=8, height_mm=5, depth_mm=4, rotation_deg=-25)
        self.assertLess(result["validation"]["volumeDeltaMm3"], 0)

    def test_slot_hole_decreases_volume(self):
        result = self._apply("cut-slot", width_mm=4, length_mm=14, depth_mm=4, rotation_deg=90)
        self.assertLess(result["validation"]["volumeDeltaMm3"], 0)
        self.assertTrue(result["validation"]["watertight"])

    def test_whole_face_outward_extrusion_increases_volume_and_bounds(self):
        result = self._apply("offset-face-outward", depth_mm=2)
        self.assertAlmostEqual(result["validation"]["volumeDeltaMm3"], 30 * 24 * 2, places=4)
        self.assertAlmostEqual(result["model"].val().BoundingBox().zmax, 7.0, places=4)
        self.assertEqual(result["validation"]["solidCount"], 1)

    def test_whole_face_inward_offset_decreases_volume_and_bounds(self):
        result = self._apply("offset-face-inward", depth_mm=2)
        self.assertAlmostEqual(result["validation"]["volumeDeltaMm3"], -(30 * 24 * 2), places=4)
        self.assertAlmostEqual(result["model"].val().BoundingBox().zmax, 3.0, places=4)
        self.assertTrue(result["validation"]["watertight"])


    def test_whole_face_outward_preserves_planar_inner_wire(self):
        model = cq.Workplane("XY").box(30, 24, 10).faces(">Z").workplane().hole(6)
        sources, _ = match_shape_faces_with_sources(model)
        faces = [descriptor for _, descriptor in sources]
        face = max(
            (value for value in faces if value.get("geometryType") == "PLANE" and value.get("normal") == [0.0, 0.0, 1.0]),
            key=lambda value: float(value.get("areaMm2", 0)),
        )
        result = apply_planar_feature(
            model, "offset-face-outward", face["stableId"], faces, (8, 0, 5), (0, 0, 1),
            radius_mm=None, width_mm=None, height_mm=None, length_mm=None, depth_mm=2, rotation_deg=0,
        )
        expected_area = 30 * 24 - 3.141592653589793 * 3 * 3
        self.assertAlmostEqual(result["validation"]["volumeDeltaMm3"], expected_area * 2, places=3)
        self.assertAlmostEqual(result["model"].val().BoundingBox().zmax, 7.0, places=4)
        self.assertEqual(result["validation"]["solidCount"], 1)

    def test_rejects_wrong_discriminator_dimensions(self):
        with self.assertRaisesRegex(ValueError, "不能携带矩形"):
            validate_planar_feature_inputs(
                "add-cylinder", "face", (0, 0, 0), (0, 0, 1), radius_mm=2,
                width_mm=4, height_mm=None, length_mm=None, depth_mm=2, rotation_deg=0,
            )
        with self.assertRaisesRegex(ValueError, "长度不能小于"):
            validate_planar_feature_inputs(
                "cut-slot", "face", (0, 0, 0), (0, 0, 1), radius_mm=None,
                width_mm=8, height_mm=None, length_mm=5, depth_mm=2, rotation_deg=0,
            )
        with self.assertRaisesRegex(ValueError, "旋转角"):
            validate_planar_feature_inputs(
                "cut-rectangle", "face", (0, 0, 0), (0, 0, 1), radius_mm=None,
                width_mm=8, height_mm=5, length_mm=None, depth_mm=2, rotation_deg=181,
            )
        with self.assertRaisesRegex(ValueError, "不能携带局部轮廓尺寸"):
            validate_planar_feature_inputs(
                "offset-face-outward", "face", (0, 0, 0), (0, 0, 1), radius_mm=None,
                width_mm=8, height_mm=None, length_mm=None, depth_mm=2, rotation_deg=0,
            )
        with self.assertRaisesRegex(ValueError, "不需要旋转角"):
            validate_planar_feature_inputs(
                "offset-face-inward", "face", (0, 0, 0), (0, 0, 1), radius_mm=None,
                width_mm=None, height_mm=None, length_mm=None, depth_mm=2, rotation_deg=10,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
