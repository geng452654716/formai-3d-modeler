"""Tests for exact STL triangle ranges mapped back to stable OpenCascade faces."""

from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

import cadquery as cq

from face_geometry_signatures import match_shape_faces_with_sources
from face_tessellation_mapping import (
    MAPPING_METHOD,
    build_face_tessellation,
    export_face_tessellation_mapping,
)


class FaceTessellationMappingTests(unittest.TestCase):
    def test_box_ranges_are_contiguous_and_cover_binary_stl(self) -> None:
        shape = cq.Workplane("XY").box(10, 8, 6)
        faces, _ = match_shape_faces_with_sources(shape)
        binary, mapping = build_face_tessellation(
            "generic-part",
            faces,
            source_stl_file="generic.stl",
            selection_mesh_file="generic-selection.stl",
            mapping_file="generic-face-map.json",
        )

        triangle_count = struct.unpack_from("<I", binary, 80)[0]
        self.assertEqual(triangle_count, 12)
        self.assertEqual(len(binary), 84 + triangle_count * 50)
        self.assertEqual(mapping["triangleCount"], triangle_count)
        self.assertEqual(mapping["faceCount"], 6)
        self.assertEqual(mapping["method"], MAPPING_METHOD)

        cursor = 0
        stable_ids: set[str] = set()
        for face_range in mapping["faces"]:
            self.assertEqual(face_range["triangleStart"], cursor)
            self.assertGreater(face_range["triangleCount"], 0)
            cursor += face_range["triangleCount"]
            stable_ids.add(face_range["stableId"])
        self.assertEqual(cursor, triangle_count)
        self.assertEqual(len(stable_ids), 6)

    def test_curved_face_is_included_in_mapping(self) -> None:
        shape = cq.Workplane("XY").cylinder(10, 5)
        faces, _ = match_shape_faces_with_sources(shape)
        _, mapping = build_face_tessellation(
            "cylinder",
            faces,
            source_stl_file="cylinder.stl",
            selection_mesh_file="cylinder-selection.stl",
            mapping_file="cylinder-face-map.json",
        )
        cylinders = [face for face in mapping["faces"] if face["geometryType"] == "CYLINDER"]
        self.assertEqual(len(cylinders), 1)
        self.assertGreater(cylinders[0]["triangleCount"], 10)

    def test_export_writes_matching_files(self) -> None:
        shape = cq.Workplane("XY").box(4, 4, 4)
        faces, _ = match_shape_faces_with_sources(shape)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            mapping = export_face_tessellation_mapping(
                output,
                "part",
                faces,
                source_stl_file="part.stl",
                selection_mesh_file="part-selection.stl",
                mapping_file="part-map.json",
            )
            self.assertTrue((output / "part-selection.stl").is_file())
            stored = json.loads((output / "part-map.json").read_text(encoding="utf-8"))
            self.assertEqual(stored, mapping)

    def test_duplicate_stable_id_is_rejected(self) -> None:
        shape = cq.Workplane("XY").box(4, 4, 4)
        faces, _ = match_shape_faces_with_sources(shape)
        duplicate = [(face, {**descriptor, "stableId": "duplicate"}) for face, descriptor in faces]
        with self.assertRaisesRegex(ValueError, "稳定 ID 重复"):
            build_face_tessellation(
                "part",
                duplicate,
                source_stl_file="part.stl",
                selection_mesh_file="part-selection.stl",
                mapping_file="part-map.json",
            )


if __name__ == "__main__":
    unittest.main()
