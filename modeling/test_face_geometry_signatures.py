"""几何签名匹配第一版的自动化回归测试。"""

from __future__ import annotations

import unittest
from dataclasses import replace

import cadquery as cq

from face_geometry_signatures import MATCH_METHOD, face_match_cost, match_shape_faces
from generate_model import EnclosureParameters, build_body, build_cover


class FaceGeometrySignatureTests(unittest.TestCase):
    def test_identical_shape_inherits_every_stable_id(self) -> None:
        shape = cq.Workplane("XY").box(20, 16, 10)
        first, first_summary = match_shape_faces(shape)
        second, second_summary = match_shape_faces(shape, first)

        self.assertEqual(first_summary["method"], MATCH_METHOD)
        self.assertEqual(len(first), 6)
        self.assertEqual({face["stableId"] for face in first}, {face["stableId"] for face in second})
        self.assertEqual(second_summary["inheritedFaceCount"], 6)
        self.assertEqual(second_summary["newFaceCount"], 0)
        self.assertEqual(second_summary["disappearedFaceCount"], 0)
        self.assertEqual(second_summary["averageInheritedConfidence"], 1.0)

    def test_resized_box_keeps_planar_face_ids(self) -> None:
        base = cq.Workplane("XY").box(20, 16, 10)
        resized = cq.Workplane("XY").box(24, 18, 12)
        previous, _ = match_shape_faces(base)
        current, summary = match_shape_faces(resized, previous)

        self.assertEqual(summary["inheritedFaceCount"], 6)
        self.assertEqual(summary["newFaceCount"], 0)
        self.assertEqual({face["stableId"] for face in previous}, {face["stableId"] for face in current})

    def test_added_hole_preserves_existing_faces_and_marks_new_cylinder(self) -> None:
        base = cq.Workplane("XY").box(20, 16, 10)
        with_hole = base.faces(">Z").workplane().hole(4)
        previous, _ = match_shape_faces(base)
        current, summary = match_shape_faces(with_hole, previous)

        self.assertGreaterEqual(summary["inheritedFaceCount"], 6)
        self.assertGreaterEqual(summary["newFaceCount"], 1)
        new_faces = [face for face in current if face["matchSource"] == "new"]
        self.assertTrue(any(face["geometryType"] == "CYLINDER" for face in new_faces))

    def test_descriptor_ids_and_fingerprints_are_unique(self) -> None:
        shape = cq.Workplane("XY").box(20, 16, 10).edges().fillet(1.5)
        faces, summary = match_shape_faces(shape)

        self.assertEqual(len(faces), summary["currentFaceCount"])
        self.assertEqual(len({face["stableId"] for face in faces}), len(faces))
        self.assertTrue(all(len(face["fingerprint"]) == 64 for face in faces))
        self.assertTrue(all(len(face["normalizedCenter"]) == 3 for face in faces))
        self.assertTrue(all("不能视为" in summary["warning"] for _ in [0]))

    def test_real_enclosure_parameter_change_inherits_existing_faces(self) -> None:
        base_parameters = EnclosureParameters()
        changed_parameters = replace(
            base_parameters,
            board_length=60.0,
            usb_port_offset_y=3.0,
        )
        for builder in (build_body, build_cover):
            previous, _ = match_shape_faces(builder(base_parameters))
            current, summary = match_shape_faces(builder(changed_parameters), previous)
            self.assertEqual(summary["inheritedFaceCount"], len(previous))
            self.assertEqual(summary["newFaceCount"], 0)
            self.assertEqual(
                {face["stableId"] for face in previous},
                {face["stableId"] for face in current},
            )
            self.assertGreater(summary["averageInheritedConfidence"], 0.95)

    def test_incompatible_geometry_types_do_not_match(self) -> None:
        plane = {
            "geometryType": "PLANE",
            "normalizedCenter": [0, 0, 0],
            "normalizedBounds": [1, 1, 0],
            "areaRatio": 0.5,
            "edgeCount": 4,
            "edgeGeometryTypes": {"LINE": 4},
        }
        cylinder = {**plane, "geometryType": "CYLINDER"}
        self.assertEqual(face_match_cost(plane, cylinder), float("inf"))

    def test_duplicate_previous_ids_are_ignored_without_creating_duplicates(self) -> None:
        shape = cq.Workplane("XY").box(20, 16, 10)
        previous, _ = match_shape_faces(shape)
        previous[1]["stableId"] = previous[0]["stableId"]
        current, summary = match_shape_faces(shape, previous)

        self.assertEqual(len({face["stableId"] for face in current}), len(current))
        self.assertEqual(summary["previousFaceCount"], 5)


if __name__ == "__main__":
    unittest.main()
