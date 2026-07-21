"""Regression tests for generic exact interface openings."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from generate_model import EnclosureParameters, build_body, build_cover, export_models


BASE_PARAMETERS = {
    "board_length": 58.0,
    "board_width": 28.0,
    "board_thickness": 1.6,
    "board_component_height": 8.5,
    "clearance_xy": 0.3,
    "clearance_z": 0.5,
    "wall_thickness": 2.0,
    "base_thickness": 2.0,
    "lid_thickness": 2.0,
    "corner_radius": 4.0,
    "edge_chamfer": 0.6,
    "usb_port_width": 11.0,
    "usb_port_height": 6.0,
    "usb_port_bottom": 2.7,
    "usb_port_offset_y": 0.0,
}


def opening(
    opening_id: str,
    face: str,
    shape: str,
    width: float,
    height: float,
    center_u: float = 0.0,
    center_v: float = 0.0,
    radius: float = 0.0,
) -> dict[str, object]:
    return {
        "id": opening_id,
        "label": f"测试开孔 {opening_id}",
        "source_type": "测试接口",
        "face": face,
        "shape": shape,
        "width_mm": width,
        "height_mm": height,
        "center_u_mm": center_u,
        "center_v_mm": center_v,
        "corner_radius_mm": radius,
        "minimum_edge_margin_mm": 1.2,
        "minimum_spacing_mm": 1.2,
        "source_confidence": 0.95,
    }


def load_parameters(data: dict[str, object]) -> EnclosureParameters:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "parameters.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return EnclosureParameters.from_json(path)


class InterfaceOpeningTests(unittest.TestCase):
    def test_missing_opening_field_uses_legacy_template(self) -> None:
        parameters = load_parameters(dict(BASE_PARAMETERS))
        self.assertIsNone(parameters.interface_openings)
        body = build_body(parameters)
        self.assertTrue(body.val().isValid())
        self.assertEqual(len(body.solids().vals()), 1)

    def test_explicit_empty_opening_list_disables_template_usb(self) -> None:
        legacy = load_parameters(dict(BASE_PARAMETERS))
        custom_empty = load_parameters({**BASE_PARAMETERS, "interface_openings": []})
        self.assertEqual(custom_empty.interface_openings, ())
        self.assertGreater(build_body(custom_empty).val().Volume(), build_body(legacy).val().Volume())

    def test_photo_anchor_recalculates_front_position_for_current_height(self) -> None:
        anchored = opening("front-anchor", "front", "rounded-rectangle", 12.0, 6.0, 99.0, 99.0, 1.5)
        anchored.update({
            "position_reference": "face-center-bottom",
            "horizontal_offset_mm": 2.0,
            "bottom_offset_mm": 3.0,
        })
        default_parameters = load_parameters({
            **BASE_PARAMETERS,
            "interface_openings": [anchored],
        })
        taller_parameters = load_parameters({
            **BASE_PARAMETERS,
            "base_thickness": 4.0,
            "interface_openings": [anchored],
        })

        default_opening = default_parameters.interface_openings[0]
        taller_opening = taller_parameters.interface_openings[0]
        self.assertAlmostEqual(default_opening.center_u_mm, 2.0)
        self.assertAlmostEqual(default_opening.center_v_mm, -0.3)
        self.assertAlmostEqual(taller_opening.center_v_mm, -1.3)
        self.assertEqual(taller_opening.width_mm, 12.0)
        self.assertEqual(taller_opening.bottom_offset_mm, 3.0)

    def test_photo_anchor_on_top_uses_current_outer_width(self) -> None:
        anchored = opening("top-anchor", "top", "rectangle", 12.0, 6.0, 99.0, 99.0)
        anchored.update({
            "position_reference": "face-center-bottom",
            "horizontal_offset_mm": 2.0,
            "bottom_offset_mm": 3.0,
        })
        parameters = load_parameters({
            **BASE_PARAMETERS,
            "board_width": 38.0,
            "interface_openings": [anchored],
        })

        resolved = parameters.interface_openings[0]
        self.assertAlmostEqual(resolved.center_u_mm, 2.0)
        self.assertAlmostEqual(resolved.center_v_mm, -15.3)

    def test_rejects_incomplete_photo_anchor(self) -> None:
        incomplete = opening("incomplete", "front", "rectangle", 5.0, 3.0)
        incomplete["position_reference"] = "face-center-bottom"
        with self.assertRaisesRegex(ValueError, "照片定位锚点不完整"):
            load_parameters({
                **BASE_PARAMETERS,
                "interface_openings": [incomplete],
            })

    def test_all_faces_and_shapes_create_valid_closed_single_solids(self) -> None:
        parameters = load_parameters({
            **BASE_PARAMETERS,
            "interface_openings": [
                opening("front-usb", "front", "rounded-rectangle", 8.0, 4.0, -7.0, 0.0, 1.2),
                opening("back-header", "back", "rectangle", 5.0, 3.0, 7.0, 0.0),
                opening("left-button", "left", "circle", 3.0, 3.0, -10.0, 0.0, 1.5),
                opening("right-led", "right", "circle", 3.0, 3.0, 10.0, 0.0, 1.5),
                opening("top-slot", "top", "slot", 8.0, 3.0, -15.0, 10.0, 1.5),
                opening("bottom-power", "bottom", "circle", 3.0, 3.0, 15.0, -10.0, 1.5),
            ],
        })
        parameters.validate()
        body = build_body(parameters)
        cover = build_cover(parameters)
        self.assertTrue(body.val().isValid())
        self.assertTrue(cover.val().isValid())
        self.assertEqual(len(body.solids().vals()), 1)
        self.assertEqual(len(cover.solids().vals()), 1)

    def test_rejects_opening_outside_face_margin(self) -> None:
        parameters = load_parameters({
            **BASE_PARAMETERS,
            "interface_openings": [
                opening("outside", "front", "rectangle", 10.0, 4.0, 13.0, 0.0),
            ],
        })
        with self.assertRaisesRegex(ValueError, "边缘不足"):
            parameters.validate()

    def test_rejects_insufficient_spacing(self) -> None:
        parameters = load_parameters({
            **BASE_PARAMETERS,
            "interface_openings": [
                opening("first", "front", "circle", 4.0, 4.0, -1.0, 0.0, 2.0),
                opening("second", "front", "circle", 4.0, 4.0, 1.0, 0.0, 2.0),
            ],
        })
        with self.assertRaisesRegex(ValueError, "间距不足"):
            parameters.validate()

    def test_manifest_reports_custom_body_and_cover_counts(self) -> None:
        parameters = load_parameters({
            **BASE_PARAMETERS,
            "interface_openings": [
                opening("front", "front", "rectangle", 5.0, 3.0),
                opening("top", "top", "slot", 8.0, 3.0, -15.0, 10.0, 1.5),
            ],
        })
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            export_models(parameters, output)
            manifest = json.loads((output / "generation-result.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["interfaceOpeningMode"], "custom")
        self.assertEqual(manifest["openingValidation"]["count"], 2)
        self.assertEqual(manifest["openingValidation"]["bodyCount"], 1)
        self.assertEqual(manifest["openingValidation"]["coverCount"], 1)
        self.assertEqual(manifest["interfaceOpenings"][0]["sourceType"], "测试接口")
        self.assertNotIn("interface_openings", manifest["parameters"])

    def test_manifest_preserves_photo_anchor_metadata(self) -> None:
        anchored = opening("front-anchor", "front", "rectangle", 5.0, 3.0)
        anchored.update({
            "position_reference": "face-center-bottom",
            "horizontal_offset_mm": 1.5,
            "bottom_offset_mm": 3.0,
        })
        parameters = load_parameters({
            **BASE_PARAMETERS,
            "interface_openings": [anchored],
        })
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            export_models(parameters, output)
            manifest = json.loads((output / "generation-result.json").read_text(encoding="utf-8"))

        manifest_opening = manifest["interfaceOpenings"][0]
        self.assertEqual(manifest_opening["positionReference"], "face-center-bottom")
        self.assertEqual(manifest_opening["horizontalOffsetMm"], 1.5)
        self.assertEqual(manifest_opening["bottomOffsetMm"], 3.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
