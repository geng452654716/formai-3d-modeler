"""稳定 CAD 曲面点击真实 UV 与外法线解析测试。"""

from __future__ import annotations

import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

import cadquery as cq

from cad_surface_hit_core import resolve_surface_hit
from face_geometry_signatures import match_shape_faces_with_sources
from face_tessellation_mapping import build_face_tessellation
from resolve_cad_surface_hit import resolve_cad_surface_hit


def _descriptor_for(
    pairs: list[tuple[cq.Face, dict]],
    geometry_type: str,
    predicate=lambda _descriptor: True,
) -> dict:
    return next(
        descriptor
        for _, descriptor in pairs
        if descriptor["geometryType"] == geometry_type and predicate(descriptor)
    )


def _triangle_hit(binary: bytes, triangle_index: int) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    offset = 84 + triangle_index * 50
    normal = struct.unpack_from("<3f", binary, offset)
    vertices = [struct.unpack_from("<3f", binary, offset + 12 + corner * 12) for corner in range(3)]
    center = tuple(sum(vertex[axis] for vertex in vertices) / 3 for axis in range(3))
    return center, normal


class CadSurfaceHitCoreTests(unittest.TestCase):
    def test_plane_returns_finite_uv_and_true_outward_normal(self) -> None:
        model = cq.Workplane("XY").box(20, 16, 10)
        pairs, _ = match_shape_faces_with_sources(model)
        descriptor = _descriptor_for(
            pairs,
            "PLANE",
            lambda value: value.get("normal") == [0.0, 0.0, 1.0],
        )
        result = resolve_surface_hit(
            model,
            [value for _, value in pairs],
            descriptor["stableId"],
            (2.0, -3.0, 5.0),
            (0.0, 0.0, 1.0),
            target_face_descriptor=descriptor,
        )
        self.assertEqual(result["geometryType"], "PLANE")
        self.assertAlmostEqual(result["pointDistanceMm"], 0.0, places=7)
        self.assertEqual(result["projectedPointMm"], {"x": 2.0, "y": -3.0, "z": 5.0})
        self.assertEqual(result["outwardNormal"], {"x": 0.0, "y": 0.0, "z": 1.0})
        tangent = result["surfaceTangentU"]
        tangent_length = math.sqrt(sum(tangent[axis] ** 2 for axis in ("x", "y", "z")))
        tangent_normal_dot = sum(tangent[axis] * result["outwardNormal"][axis] for axis in ("x", "y", "z"))
        self.assertAlmostEqual(tangent_length, 1.0, places=7)
        self.assertAlmostEqual(tangent_normal_dot, 0.0, places=7)
        self.assertTrue(math.isfinite(result["surfaceUv"]["u"]))
        self.assertTrue(math.isfinite(result["surfaceUv"]["v"]))
        self.assertEqual(result["trimmedFaceState"], "inside")

    def test_cylinder_normals_change_with_circumference_position(self) -> None:
        model = cq.Workplane("XY").cylinder(10, 5)
        pairs, _ = match_shape_faces_with_sources(model)
        descriptor = _descriptor_for(pairs, "CYLINDER")
        faces = [value for _, value in pairs]
        first = resolve_surface_hit(
            model,
            faces,
            descriptor["stableId"],
            (5.0, 0.0, 0.0),
            (1.0, 0.0, 0.0),
            target_face_descriptor=descriptor,
        )
        second = resolve_surface_hit(
            model,
            faces,
            descriptor["stableId"],
            (0.0, 5.0, 0.0),
            (0.0, 1.0, 0.0),
            target_face_descriptor=descriptor,
        )
        self.assertEqual(first["geometryType"], "CYLINDER")
        self.assertGreater(first["outwardNormal"]["x"], 0.99)
        self.assertGreater(second["outwardNormal"]["y"], 0.99)
        for result in (first, second):
            tangent = result["surfaceTangentU"]
            normal = result["outwardNormal"]
            self.assertAlmostEqual(
                math.sqrt(sum(tangent[axis] ** 2 for axis in ("x", "y", "z"))),
                1.0,
                places=7,
            )
            self.assertAlmostEqual(
                sum(tangent[axis] * normal[axis] for axis in ("x", "y", "z")),
                0.0,
                places=7,
            )
        self.assertNotAlmostEqual(first["surfaceUv"]["u"], second["surfaceUv"]["u"], places=3)
        self.assertGreater(first["normalDot"], 0.99)
        self.assertGreater(second["normalDot"], 0.99)

    def test_projection_outside_trimmed_plane_is_rejected(self) -> None:
        model = cq.Workplane("XY").box(20, 16, 10)
        pairs, _ = match_shape_faces_with_sources(model)
        descriptor = _descriptor_for(
            pairs,
            "PLANE",
            lambda value: value.get("normal") == [0.0, 0.0, 1.0],
        )
        with self.assertRaisesRegex(ValueError, "不在当前裁剪面内"):
            resolve_surface_hit(
                model,
                [value for _, value in pairs],
                descriptor["stableId"],
                (10.5, 0.0, 5.0),
                (0.0, 0.0, 1.0),
                target_face_descriptor=descriptor,
            )

    def test_reversed_mesh_normal_is_rejected(self) -> None:
        model = cq.Workplane("XY").cylinder(10, 5)
        pairs, _ = match_shape_faces_with_sources(model)
        descriptor = _descriptor_for(pairs, "CYLINDER")
        with self.assertRaisesRegex(ValueError, "真实外法线不一致"):
            resolve_surface_hit(
                model,
                [value for _, value in pairs],
                descriptor["stableId"],
                (5.0, 0.0, 0.0),
                (-1.0, 0.0, 0.0),
                target_face_descriptor=descriptor,
            )


class CadSurfaceHitWorkerTests(unittest.TestCase):
    def _fixture(self, directory: Path) -> tuple[dict, bytes, dict]:
        model = cq.Workplane("XY").cylinder(10, 5)
        pairs, matching = match_shape_faces_with_sources(model)
        binary, mapping = build_face_tessellation(
            "generic-part",
            pairs,
            source_stl_file="generic-part.stl",
            selection_mesh_file="generic-part-selection.stl",
            mapping_file="generic-part-map.json",
        )
        cq.exporters.export(model, str(directory / "generic-part.step"))
        manifest = {
            "status": "ok",
            "revision": "surface-hit-revision",
            "parts": [{
                "id": "generic-part",
                "stepFile": "generic-part.step",
                "stlFile": "generic-part.stl",
                "faces": [descriptor for _, descriptor in pairs],
                "faceMatching": matching,
                "faceTessellation": mapping,
            }],
        }
        (directory / "generation-result.json").write_text(
            json.dumps(manifest, ensure_ascii=False),
            encoding="utf-8",
        )
        cylinder_range = next(face for face in mapping["faces"] if face["geometryType"] == "CYLINDER")
        return manifest, binary, cylinder_range

    def test_worker_binds_revision_part_face_and_triangle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            _, binary, face_range = self._fixture(output)
            triangle_index = face_range["triangleStart"]
            point, normal = _triangle_hit(binary, triangle_index)
            result = resolve_cad_surface_hit(
                output_dir=output,
                selection_revision="surface-hit-revision",
                part_id="generic-part",
                stable_face_id=face_range["stableId"],
                triangle_index=triangle_index,
                point_mm=point,
                mesh_normal=normal,
            )
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["geometryType"], "CYLINDER")
            self.assertEqual(result["stableFaceId"], face_range["stableId"])
            self.assertEqual(result["triangleIndex"], triangle_index)
            self.assertLess(result["pointDistanceMm"], 0.1)
            self.assertGreater(result["normalDot"], 0.99)
            self.assertIn("surfaceTangentU", result)
            self.assertIn(
                "曲面点击上下文支持受限圆形凸台、圆孔和切平面槽孔；槽孔不代表支持任意曲面贴合轮廓、曲面边圆角或曲面参数直接编辑",
                result["limitations"],
            )

    def test_worker_rejects_stale_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            _, binary, face_range = self._fixture(output)
            triangle_index = face_range["triangleStart"]
            point, normal = _triangle_hit(binary, triangle_index)
            with self.assertRaisesRegex(ValueError, "triangleIndex 已失效"):
                resolve_cad_surface_hit(
                    output_dir=output,
                    selection_revision="old-revision",
                    part_id="generic-part",
                    stable_face_id=face_range["stableId"],
                    triangle_index=triangle_index,
                    point_mm=point,
                    mesh_normal=normal,
                )

    def test_worker_rejects_triangle_from_another_face(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            manifest, binary, cylinder_range = self._fixture(output)
            other_range = next(
                face for face in manifest["parts"][0]["faceTessellation"]["faces"]
                if face["stableId"] != cylinder_range["stableId"]
            )
            triangle_index = other_range["triangleStart"]
            point, normal = _triangle_hit(binary, triangle_index)
            with self.assertRaisesRegex(ValueError, "triangleIndex 与目标稳定面不一致"):
                resolve_cad_surface_hit(
                    output_dir=output,
                    selection_revision="surface-hit-revision",
                    part_id="generic-part",
                    stable_face_id=cylinder_range["stableId"],
                    triangle_index=triangle_index,
                    point_mm=point,
                    mesh_normal=normal,
                )


if __name__ == "__main__":
    unittest.main()
