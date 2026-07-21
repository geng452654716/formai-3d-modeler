"""OpenCascade 拆件、补面和通用 STL 导入回归测试。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from generate_model import EnclosureParameters, build_body
from manufacturing_features import apply_manufacturing_features, feature_validation_json
from split_and_cap import (
    import_stl_as_solid,
    inspect_stl_file,
    split_model_file,
    split_solid_with_caps,
    split_step_file,
)
from stl_mesh_repair import repair_stl_mesh, write_ascii_stl


def box_triangles(*, include_top: bool = True, warped_top: bool = False):
    """生成带一致外法线的立方体三角网格，便于构造通用破面样本。"""

    top_height = 11.0 if warped_top else 10.0
    vertices = {
        "000": (0.0, 0.0, 0.0),
        "100": (10.0, 0.0, 0.0),
        "110": (10.0, 10.0, 0.0),
        "010": (0.0, 10.0, 0.0),
        "001": (0.0, 0.0, 10.0),
        "101": (10.0, 0.0, 10.0),
        "111": (10.0, 10.0, top_height),
        "011": (0.0, 10.0, 10.0),
    }
    faces = [
        ("000", "010", "110"), ("000", "110", "100"),
        ("000", "100", "101"), ("000", "101", "001"),
        ("010", "011", "111"), ("010", "111", "110"),
        ("000", "001", "011"), ("000", "011", "010"),
        ("100", "110", "111"), ("100", "111", "101"),
    ]
    if include_top:
        faces[2:2] = [("001", "101", "111"), ("001", "111", "011")]
    return [tuple(vertices[name] for name in face) for face in faces]


class SplitAndCapTests(unittest.TestCase):
    def test_box_split_creates_two_closed_capped_solids(self) -> None:
        model = cq.Workplane("XY").box(40, 30, 20)
        negative, positive, validation = split_solid_with_caps(model, "x", 3.0)

        self.assertTrue(negative.val().isValid())
        self.assertTrue(positive.val().isValid())
        self.assertGreaterEqual(validation.negative_cap_faces, 1)
        self.assertGreaterEqual(validation.positive_cap_faces, 1)
        self.assertLess(validation.volume_error_mm3, 1e-5)
        self.assertAlmostEqual(
            validation.negative_volume_mm3 + validation.positive_volume_mm3,
            validation.original_volume_mm3,
            places=5,
        )

    def test_hollow_printable_body_remains_closed_after_split(self) -> None:
        outer = cq.Workplane("XY").box(48, 34, 18)
        cavity = cq.Workplane("XY").workplane(offset=2).box(44, 30, 18, centered=(True, True, False))
        model = outer.cut(cavity)
        negative, positive, validation = split_solid_with_caps(model, "y", 0.0)

        for part in (negative, positive):
            solids = part.val().Solids()
            self.assertTrue(solids)
            self.assertTrue(all(shell.Closed() for solid in solids for shell in solid.Shells()))
        self.assertGreaterEqual(validation.negative_cap_faces, 1)
        self.assertGreaterEqual(validation.positive_cap_faces, 1)

    def test_generated_demo_body_keeps_volume_and_caps(self) -> None:
        body = build_body(EnclosureParameters())
        _, _, validation = split_solid_with_caps(body, "x", 0.0)

        self.assertEqual(validation.negative_solid_count, 1)
        self.assertEqual(validation.positive_solid_count, 1)
        self.assertGreaterEqual(validation.negative_cap_faces, 1)
        self.assertGreaterEqual(validation.positive_cap_faces, 1)
        self.assertLess(validation.volume_error_mm3, 1e-5)

    def test_step_worker_exports_two_validated_parts_and_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "source.step"
            exporters.export(cq.Workplane("XY").box(30, 20, 10), str(source))

            summary = split_step_file(source, directory, "x", 0.0, "test-split", "demo-body")

            self.assertEqual(summary["status"], "ok")
            self.assertEqual(summary["sourcePartId"], "demo-body")
            self.assertEqual(summary["sourceKind"], "cad-part")
            self.assertEqual(summary["sourceFormat"], "step")
            self.assertEqual(summary["validation"]["negativeCapFaces"], 1)
            self.assertEqual(summary["validation"]["positiveCapFaces"], 1)
            for suffix in ("negative.step", "positive.step", "negative.stl", "positive.stl"):
                self.assertTrue((directory / f"test-split-{suffix}").is_file())
            persisted = json.loads((directory / "test-split-result.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["revision"], summary["revision"])

    def test_imports_arbitrary_watertight_stl_as_valid_solid(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "用户自定义模型.stl"
            exporters.export(cq.Workplane("XY").box(10, 12, 14), str(source), tolerance=0.01)

            model, validation = import_stl_as_solid(source)

            self.assertTrue(model.val().isValid())
            self.assertGreater(validation.triangle_count, 0)
            self.assertEqual(validation.solid_count, 1)
            self.assertAlmostEqual(validation.volume_mm3, 1680.0, places=3)
            self.assertAlmostEqual(validation.bounds.xlen, 10.0, places=3)
            self.assertAlmostEqual(validation.bounds.ylen, 12.0, places=3)
            self.assertAlmostEqual(validation.bounds.zlen, 14.0, places=3)

    def test_inspect_stl_persists_original_file_name_and_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "imported-model.stl"
            exporters.export(cq.Workplane("XY").box(18, 16, 8), str(source), tolerance=0.01)

            summary = inspect_stl_file(source, directory, original_file_name="机械外壳原型.stl")

            self.assertEqual(summary["status"], "ok")
            self.assertEqual(summary["sourceKind"], "uploaded-stl")
            self.assertEqual(summary["originalFileName"], "机械外壳原型.stl")
            self.assertEqual(summary["name"], "机械外壳原型")
            self.assertTrue(summary["metrics"]["watertight"])
            self.assertGreater(summary["metrics"]["triangleCount"], 0)
            persisted = json.loads(
                (directory / "imported-model-result.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["revision"], summary["revision"])

    def test_uploaded_stl_worker_splits_caps_and_exports_both_formats(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "任意手办部件.stl"
            exporters.export(cq.Workplane("XY").box(26, 18, 12), str(source), tolerance=0.01)

            summary = split_model_file(
                source,
                directory,
                "z",
                1.0,
                "uploaded-split",
                "uploaded-model",
                "uploaded-stl",
            )

            self.assertEqual(summary["sourceKind"], "uploaded-stl")
            self.assertEqual(summary["sourceFormat"], "stl")
            self.assertGreaterEqual(summary["validation"]["negativeCapFaces"], 1)
            self.assertGreaterEqual(summary["validation"]["positiveCapFaces"], 1)
            self.assertLess(summary["validation"]["volumeErrorMm3"], 1e-5)
            for suffix in ("negative.step", "positive.step", "negative.stl", "positive.stl"):
                self.assertTrue((directory / f"uploaded-split-{suffix}").is_file())

    def test_repairs_one_simple_planar_hole_and_persists_working_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "imported-model.stl"
            write_ascii_stl(source, box_triangles(include_top=False), "open_box")

            summary = inspect_stl_file(source, directory, original_file_name="开放立方体.stl")

            repair = summary["metrics"]["repair"]
            self.assertTrue(repair["repaired"])
            self.assertEqual(repair["boundaryEdgeCountBefore"], 4)
            self.assertEqual(repair["boundaryEdgeCountAfter"], 0)
            self.assertEqual(repair["repairedHoleCount"], 1)
            self.assertEqual(repair["addedTriangleCount"], 2)
            self.assertEqual(summary["sourceFile"], "imported-model-repaired.stl")
            self.assertEqual(summary["originalSourceFile"], "imported-model.stl")
            self.assertTrue((directory / "imported-model-repaired.stl").is_file())
            self.assertAlmostEqual(summary["metrics"]["volumeMm3"], 1000.0, places=3)

    def test_repaired_open_mesh_can_continue_through_split_and_cap(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "任意开放模型.stl"
            write_ascii_stl(source, box_triangles(include_top=False), "open_box")

            summary = split_model_file(
                source,
                directory,
                "x",
                5.0,
                "repaired-split",
                "uploaded-model",
                "uploaded-stl",
            )

            self.assertLess(summary["validation"]["volumeErrorMm3"], 1e-5)
            self.assertAlmostEqual(summary["validation"]["originalVolumeMm3"], 1000.0, places=3)
            self.assertGreaterEqual(summary["validation"]["negativeCapFaces"], 1)
            self.assertGreaterEqual(summary["validation"]["positiveCapFaces"], 1)

    def test_removes_degenerate_and_duplicate_triangles_before_import(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "待清理模型.stl"
            triangles = box_triangles()
            triangles.append(triangles[0])
            triangles.append(((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (10.0, 0.0, 0.0)))
            write_ascii_stl(source, triangles, "dirty_box")

            result = repair_stl_mesh(source, directory / "cleaned.stl")
            model, validation = import_stl_as_solid(source)

            self.assertTrue(result.report.repaired)
            self.assertEqual(result.report.removed_duplicate_triangles, 1)
            self.assertEqual(result.report.removed_degenerate_triangles, 1)
            self.assertEqual(result.report.output_triangle_count, 12)
            self.assertTrue(model.val().isValid())
            self.assertAlmostEqual(validation.volume_mm3, 1000.0, places=3)

    def test_rejects_non_manifold_edge_with_chinese_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            source = Path(directory_name) / "非流形模型.stl"
            triangles = box_triangles()
            triangles.append(((0.0, 0.0, 0.0), (0.0, 10.0, 0.0), (0.0, 5.0, -5.0)))
            write_ascii_stl(source, triangles, "non_manifold")

            with self.assertRaisesRegex(ValueError, "非流形"):
                import_stl_as_solid(source)

    def test_rejects_non_planar_hole_instead_of_faking_repair(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            source = Path(directory_name) / "非共面破面.stl"
            write_ascii_stl(
                source,
                box_triangles(include_top=False, warped_top=True),
                "warped_open_box",
            )

            with self.assertRaisesRegex(ValueError, "不共面"):
                import_stl_as_solid(source)

    def test_rejects_open_stl_mesh(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            source = Path(directory_name) / "开放网格.stl"
            source.write_text(
                """solid open
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid open
""",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "三角面数量不足|不是封闭网格"):
                import_stl_as_solid(source)

    def test_exact_round_pin_and_m3_boss_export_valid_parts(self) -> None:
        """精确连接结构必须进入最终 STEP/STL，并返回制造校验数据。"""

        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "通用外壳.step"
            exporters.export(cq.Workplane("XY").box(50, 40, 24), str(source))

            summary = split_model_file(
                source,
                directory,
                "x",
                0.0,
                "exact-features",
                "generic-part",
                "cad-part",
                joint_type="round-pin",
                fastener_type="screw-boss",
                screw_size="M3",
                clearance_mm=0.25,
                apply_features=True,
            )

            features = summary["features"]
            self.assertEqual(features["status"], "exact")
            self.assertEqual(features["jointType"], "round-pin")
            self.assertEqual(features["jointCount"], 2)
            self.assertGreaterEqual(features["fastenerCount"], 1)
            self.assertGreaterEqual(features["minimumDesignedWallMm"], 1.2)
            self.assertLess(features["interferenceVolumeMm3"], 1e-4)
            self.assertLess(summary["validation"]["volumeErrorMm3"], 1e-5)
            for suffix in ("negative.step", "positive.step", "negative.stl", "positive.stl"):
                self.assertTrue((directory / f"exact-features-{suffix}").is_file())

            persisted = json.loads(
                (directory / "exact-features-result.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["features"]["jointCount"], 2)

    def test_all_joint_types_create_closed_exact_solids(self) -> None:
        """五类通用连接器都必须产生有效、封闭且无装配干涉的实体。"""

        joint_types = ("round-pin", "d-pin", "dovetail", "ball-socket", "magnet")
        for joint_type in joint_types:
            with self.subTest(joint_type=joint_type):
                negative, positive, _ = split_solid_with_caps(
                    cq.Workplane("XY").box(50, 40, 24), "x", 0.0
                )
                featured_negative, featured_positive, validation = apply_manufacturing_features(
                    negative,
                    positive,
                    "x",
                    0.0,
                    joint_type,
                    "screw-boss",
                    "M3",
                    0.25,
                )

                for part in (featured_negative, featured_positive):
                    shape = part.val()
                    self.assertTrue(shape.isValid())
                    self.assertTrue(shape.Solids())
                    self.assertTrue(
                        all(shell.Closed() for solid in shape.Solids() for shell in solid.Shells())
                    )
                self.assertEqual(validation.joint_count, 2)
                self.assertGreaterEqual(validation.fastener_count, 1)
                self.assertGreaterEqual(validation.minimum_designed_wall_mm, 1.2)
                self.assertLess(validation.interference_volume_mm3, 1e-4)

    def test_m2_m25_and_m3_screw_bosses_are_supported(self) -> None:
        """0.4 毫米喷嘴常用的三种螺丝柱规格均可精确生成。"""

        for screw_size in ("M2", "M2.5", "M3"):
            with self.subTest(screw_size=screw_size):
                negative, positive, _ = split_solid_with_caps(
                    cq.Workplane("XY").box(50, 40, 24), "x", 0.0
                )
                featured_negative, featured_positive, validation = apply_manufacturing_features(
                    negative,
                    positive,
                    "x",
                    0.0,
                    "d-pin",
                    "screw-boss",
                    screw_size,
                    0.25,
                )

                self.assertTrue(featured_negative.val().isValid())
                self.assertTrue(featured_positive.val().isValid())
                self.assertEqual(validation.screw_size, screw_size)
                self.assertGreaterEqual(validation.fastener_count, 1)
                self.assertGreaterEqual(validation.minimum_designed_wall_mm, 1.2)

    def test_print_friendly_threads_support_all_sizes_and_axes(self) -> None:
        """两类近似螺纹均须覆盖 M2/M2.5/M3，并且不能绑定全局坐标轴。"""

        cases = (("M2", "x"), ("M2.5", "y"), ("M3", "z"))
        expected_pitch = {"M2": 0.8, "M2.5": 1.0, "M3": 1.2}
        expected_diameter = {"M2": 2.0, "M2.5": 2.5, "M3": 3.0}
        for fastener_type in ("threaded-hole", "external-thread"):
            for screw_size, axis in cases:
                with self.subTest(fastener_type=fastener_type, screw_size=screw_size, axis=axis):
                    negative, positive, _ = split_solid_with_caps(
                        cq.Workplane("XY").box(50, 40, 24), axis, 0.0
                    )
                    featured_negative, featured_positive, validation = apply_manufacturing_features(
                        negative,
                        positive,
                        axis,
                        0.0,
                        "d-pin",
                        fastener_type,
                        screw_size,
                        0.25,
                    )

                    for part in (featured_negative, featured_positive):
                        shape = part.val()
                        self.assertTrue(shape.isValid())
                        self.assertEqual(len(shape.Solids()), 1)
                        self.assertTrue(
                            all(shell.Closed() for solid in shape.Solids() for shell in solid.Shells())
                        )
                    self.assertGreaterEqual(validation.fastener_count, 1)
                    self.assertGreaterEqual(validation.minimum_designed_wall_mm, 1.2 - 1e-6)
                    self.assertLess(validation.interference_volume_mm3, 1e-4)
                    result = feature_validation_json(validation, axis)
                    placements = [item for item in result["placements"] if item["role"] == "fastener"]
                    self.assertTrue(placements)
                    self.assertAlmostEqual(placements[0]["diameterMm"], expected_diameter[screw_size])
                    self.assertAlmostEqual(placements[0]["pitchMm"], expected_pitch[screw_size])
                    self.assertGreater(placements[0]["lengthMm"], 0)

    def test_iso_metric_threads_support_all_sizes_axes_and_true_profile_metadata(self) -> None:
        """ISO 粗牙内外螺纹须覆盖三种规格、三轴，并返回 60° 真实牙型元数据。"""

        cases = (("M2", "x"), ("M2.5", "y"), ("M3", "z"))
        expected_pitch = {"M2": 0.4, "M2.5": 0.45, "M3": 0.5}
        expected_diameter = {"M2": 2.0, "M2.5": 2.5, "M3": 3.0}
        for fastener_type in ("iso-threaded-hole", "iso-external-thread"):
            for screw_size, axis in cases:
                with self.subTest(fastener_type=fastener_type, screw_size=screw_size, axis=axis):
                    negative, positive, _ = split_solid_with_caps(
                        cq.Workplane("XY").box(50, 40, 24), axis, 0.0
                    )
                    featured_negative, featured_positive, validation = apply_manufacturing_features(
                        negative,
                        positive,
                        axis,
                        0.0,
                        "d-pin",
                        fastener_type,
                        screw_size,
                        0.25,
                    )

                    for part in (featured_negative, featured_positive):
                        shape = part.val()
                        self.assertTrue(shape.isValid())
                        self.assertEqual(len(shape.Solids()), 1)
                        self.assertTrue(
                            all(shell.Closed() for solid in shape.Solids() for shell in solid.Shells())
                        )
                    self.assertGreaterEqual(validation.fastener_count, 1)
                    self.assertGreaterEqual(validation.minimum_designed_wall_mm, 1.2 - 1e-6)
                    self.assertLess(validation.interference_volume_mm3, 1e-4)
                    result = feature_validation_json(validation, axis)
                    placements = [item for item in result["placements"] if item["role"] == "fastener"]
                    self.assertTrue(placements)
                    self.assertAlmostEqual(placements[0]["diameterMm"], expected_diameter[screw_size])
                    self.assertAlmostEqual(placements[0]["pitchMm"], expected_pitch[screw_size])
                    self.assertEqual(placements[0]["threadStandard"], "ISO 公制粗牙基本牙型")
                    self.assertEqual(placements[0]["profileAngleDeg"], 60.0)
                    self.assertGreater(placements[0]["lengthMm"], 0)

    def test_iso_external_thread_exports_step_stl_and_metadata(self) -> None:
        """ISO 60° 外螺纹必须进入最终 STEP/STL，并持久化标准和牙型角。"""

        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "ISO螺纹测试件.step"
            exporters.export(cq.Workplane("XY").box(50, 40, 24), str(source))
            summary = split_model_file(
                source,
                directory,
                "x",
                0.0,
                "iso-external-thread-features",
                "generic-iso-thread-part",
                "cad-part",
                joint_type="d-pin",
                fastener_type="iso-external-thread",
                screw_size="M3",
                clearance_mm=0.25,
                apply_features=True,
            )

            features = summary["features"]
            placements = [item for item in features["placements"] if item["role"] == "fastener"]
            self.assertEqual(features["fastenerType"], "iso-external-thread")
            self.assertTrue(placements)
            self.assertEqual(placements[0]["diameterMm"], 3.0)
            self.assertEqual(placements[0]["pitchMm"], 0.5)
            self.assertEqual(placements[0]["profileAngleDeg"], 60.0)
            self.assertEqual(placements[0]["threadStandard"], "ISO 公制粗牙基本牙型")
            self.assertLess(features["interferenceVolumeMm3"], 1e-4)
            for suffix in ("negative.step", "positive.step", "negative.stl", "positive.stl"):
                self.assertTrue((directory / f"iso-external-thread-features-{suffix}").is_file())

    def test_external_thread_exports_step_stl_and_metadata(self) -> None:
        """一体式外螺纹必须进入最终 STEP/STL，并返回螺距和有效长度。"""

        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "通用模型.step"
            exporters.export(cq.Workplane("XY").box(50, 40, 24), str(source))
            summary = split_model_file(
                source,
                directory,
                "x",
                0.0,
                "external-thread-features",
                "generic-part",
                "cad-part",
                joint_type="d-pin",
                fastener_type="external-thread",
                screw_size="M3",
                clearance_mm=0.25,
                apply_features=True,
            )

            features = summary["features"]
            placements = [item for item in features["placements"] if item["role"] == "fastener"]
            self.assertEqual(features["fastenerType"], "external-thread")
            self.assertTrue(placements)
            self.assertEqual(placements[0]["diameterMm"], 3.0)
            self.assertEqual(placements[0]["pitchMm"], 1.2)
            self.assertGreater(placements[0]["lengthMm"], 0)
            self.assertLess(features["interferenceVolumeMm3"], 1e-4)
            for suffix in ("negative.step", "positive.step", "negative.stl", "positive.stl"):
                self.assertTrue((directory / f"external-thread-features-{suffix}").is_file())

    def test_external_thread_rejects_shallow_or_narrow_sections_in_chinese(self) -> None:
        """螺纹没有足够旋合深度或截面空间时必须用中文明确拒绝。"""

        shallow_negative, shallow_positive, _ = split_solid_with_caps(
            cq.Workplane("XY").box(8, 40, 24), "x", 0.0
        )
        with self.assertRaisesRegex(ValueError, "打印外螺纹至少需要"):
            apply_manufacturing_features(
                shallow_negative,
                shallow_positive,
                "x",
                0.0,
                "d-pin",
                "external-thread",
                "M3",
                0.25,
            )

        with self.assertRaisesRegex(ValueError, "ISO 60° 外螺纹至少需要"):
            apply_manufacturing_features(
                shallow_negative,
                shallow_positive,
                "x",
                0.0,
                "d-pin",
                "iso-external-thread",
                "M3",
                0.25,
            )

        narrow_negative, narrow_positive, _ = split_solid_with_caps(
            cq.Workplane("XY").box(30, 7, 7), "x", 0.0
        )
        with self.assertRaisesRegex(ValueError, "拆件截面空间不足"):
            apply_manufacturing_features(
                narrow_negative,
                narrow_positive,
                "x",
                0.0,
                "d-pin",
                "threaded-hole",
                "M3",
                0.25,
            )

    def test_snap_fit_exports_closed_parts_with_dimension_metadata(self) -> None:
        """PLA/PETG 可拆卡扣必须进入最终 STEP/STL，并返回非圆形三维尺寸。"""

        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            source = directory / "通用卡扣测试件.step"
            exporters.export(cq.Workplane("XY").box(50, 40, 24), str(source))

            summary = split_model_file(
                source,
                directory,
                "x",
                0.0,
                "snap-fit-features",
                "generic-snap-fit-part",
                "cad-part",
                joint_type="d-pin",
                fastener_type="snap-fit",
                screw_size="M3",
                clearance_mm=0.25,
                apply_features=True,
            )

            features = summary["features"]
            self.assertEqual(features["fastenerType"], "snap-fit")
            self.assertGreaterEqual(features["fastenerCount"], 1)
            self.assertGreaterEqual(features["minimumDesignedWallMm"], 1.2)
            self.assertLess(features["interferenceVolumeMm3"], 1e-4)
            snap_placements = [item for item in features["placements"] if item["role"] == "fastener"]
            self.assertTrue(snap_placements)
            self.assertIsNone(snap_placements[0]["diameterMm"])
            self.assertGreater(snap_placements[0]["widthMm"], 0)
            self.assertGreater(snap_placements[0]["heightMm"], 0)
            self.assertGreater(snap_placements[0]["lengthMm"], 0)
            for suffix in ("negative.step", "positive.step", "negative.stl", "positive.stl"):
                self.assertTrue((directory / f"snap-fit-features-{suffix}").is_file())

    def test_snap_fit_is_axis_independent_and_accepts_material_clearances(self) -> None:
        """卡扣必须使用局部切割坐标，并覆盖 PLA/PETG 常用装配间隙。"""

        for axis, clearance_mm in (("x", 0.2), ("y", 0.25), ("z", 0.35)):
            with self.subTest(axis=axis, clearance_mm=clearance_mm):
                negative, positive, _ = split_solid_with_caps(
                    cq.Workplane("XY").box(50, 40, 24), axis, 0.0
                )
                featured_negative, featured_positive, validation = apply_manufacturing_features(
                    negative,
                    positive,
                    axis,
                    0.0,
                    "d-pin",
                    "snap-fit",
                    "M3",
                    clearance_mm,
                )

                for part in (featured_negative, featured_positive):
                    self.assertTrue(part.val().isValid())
                    self.assertTrue(
                        all(shell.Closed() for solid in part.val().Solids() for shell in solid.Shells())
                    )
                self.assertEqual(validation.fastener_type, "snap-fit")
                self.assertGreaterEqual(validation.fastener_count, 1)
                self.assertGreaterEqual(validation.minimum_designed_wall_mm, 1.2 - 1e-6)
                self.assertLess(validation.interference_volume_mm3, 1e-4)

    def test_snap_fit_rejects_shallow_or_narrow_sections_in_chinese(self) -> None:
        """卡扣没有足够臂长或横截面空间时必须明确拒绝。"""

        shallow_negative, shallow_positive, _ = split_solid_with_caps(
            cq.Workplane("XY").box(12, 40, 24), "x", 0.0
        )
        with self.assertRaisesRegex(ValueError, "可拆卡扣至少需要"):
            apply_manufacturing_features(
                shallow_negative,
                shallow_positive,
                "x",
                0.0,
                "d-pin",
                "snap-fit",
                "M3",
                0.25,
            )

        narrow_negative, narrow_positive, _ = split_solid_with_caps(
            cq.Workplane("XY").box(30, 7, 7), "x", 0.0
        )
        with self.assertRaisesRegex(ValueError, "拆件截面空间不足"):
            apply_manufacturing_features(
                narrow_negative,
                narrow_positive,
                "x",
                0.0,
                "d-pin",
                "snap-fit",
                "M3",
                0.25,
            )

    def test_rejects_invalid_feature_clearance_with_chinese_error(self) -> None:
        """过紧或过松的公母间隙都必须用中文拒绝。"""

        negative, positive, _ = split_solid_with_caps(
            cq.Workplane("XY").box(50, 40, 24), "x", 0.0
        )
        for clearance_mm in (0.09, 1.01):
            with self.subTest(clearance_mm=clearance_mm):
                with self.assertRaisesRegex(ValueError, "公母间隙必须在"):
                    apply_manufacturing_features(
                        negative,
                        positive,
                        "x",
                        0.0,
                        "round-pin",
                        "screw-boss",
                        "M3",
                        clearance_mm,
                    )

    def test_rejects_insufficient_section_for_exact_features(self) -> None:
        """截面无法容纳支撑壁时，不得生成悬浮或过薄连接结构。"""

        negative, positive, _ = split_solid_with_caps(
            cq.Workplane("XY").box(20, 6, 6), "x", 0.0
        )
        with self.assertRaisesRegex(ValueError, "拆件截面空间不足"):
            apply_manufacturing_features(
                negative,
                positive,
                "x",
                0.0,
                "round-pin",
                "screw-boss",
                "M3",
                0.25,
            )

    def test_rejects_plane_outside_model(self) -> None:
        with self.assertRaisesRegex(ValueError, "包围盒内部"):
            split_solid_with_caps(cq.Workplane("XY").box(10, 10, 10), "z", 6.0)


if __name__ == "__main__":
    unittest.main()
