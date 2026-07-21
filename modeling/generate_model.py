"""Generate the active parametric model using CadQuery/OpenCascade."""

from __future__ import annotations

import argparse
import json
import math
import zipfile
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from time import time_ns
from typing import Any
from xml.etree import ElementTree as ET

import cadquery as cq
from cadquery import exporters

from curved_feature_diagnostics import build_curved_feature_diagnostics
from face_geometry_signatures import (
    MATCH_METHOD,
    MATCH_WARNING,
    match_shape_faces_with_sources,
)
from face_tessellation_mapping import export_face_tessellation_mapping
from local_cad_feature_core import (
    apply_edge_feature,
    apply_planar_feature,
    validate_edge_feature_inputs,
    validate_planar_feature_inputs,
)

P1S_BUILD_VOLUME_MM = (256.0, 256.0, 256.0)
MODEL_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"
INTERFACE_OPENING_FACES = {"front", "back", "left", "right", "top", "bottom"}
INTERFACE_OPENING_SHAPES = {"circle", "rectangle", "rounded-rectangle", "slot"}
INTERFACE_OPENING_POSITION_REFERENCES = {"face-center-bottom"}


@dataclass(frozen=True)
class InterfaceOpening:
    """One exact opening on an orthogonal enclosure face."""

    id: str
    label: str
    source_type: str
    face: str
    shape: str
    width_mm: float
    height_mm: float
    center_u_mm: float
    center_v_mm: float
    corner_radius_mm: float
    minimum_edge_margin_mm: float
    minimum_spacing_mm: float
    source_confidence: float
    position_reference: str | None = None
    horizontal_offset_mm: float | None = None
    bottom_offset_mm: float | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any], index: int) -> "InterfaceOpening":
        try:
            opening = cls(**value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"第 {index + 1} 个照片精确开孔格式无效：{error}") from error
        opening.validate(index)
        return opening

    def validate(self, index: int | None = None) -> None:
        prefix = f"第 {index + 1} 个开孔" if index is not None else f"开孔“{self.id}”"
        if not self.id.strip() or len(self.id) > 80:
            raise ValueError(f"{prefix}的 ID 无效")
        if self.face not in INTERFACE_OPENING_FACES:
            raise ValueError(f"{prefix}的接口面无效：{self.face}")
        if self.shape not in INTERFACE_OPENING_SHAPES:
            raise ValueError(f"{prefix}的轮廓无效：{self.shape}")
        numeric_values = (
            self.width_mm,
            self.height_mm,
            self.center_u_mm,
            self.center_v_mm,
            self.corner_radius_mm,
            self.minimum_edge_margin_mm,
            self.minimum_spacing_mm,
            self.source_confidence,
        )
        if not all(math.isfinite(value) for value in numeric_values):
            raise ValueError(f"{prefix}包含非有限数值")
        if self.width_mm <= 0 or self.height_mm <= 0:
            raise ValueError(f"{prefix}的宽度和高度必须大于零")
        if self.corner_radius_mm < 0:
            raise ValueError(f"{prefix}的圆角半径不能为负数")
        if self.corner_radius_mm > min(self.width_mm, self.height_mm) / 2 + 1e-9:
            raise ValueError(f"{prefix}的圆角半径超过了轮廓尺寸的一半")
        if self.minimum_edge_margin_mm < 0 or self.minimum_spacing_mm < 0:
            raise ValueError(f"{prefix}的边缘距离和孔间距不能为负数")
        if not 0 <= self.source_confidence <= 1:
            raise ValueError(f"{prefix}的识别置信度必须在 0 到 1 之间")
        position_values = (
            self.position_reference,
            self.horizontal_offset_mm,
            self.bottom_offset_mm,
        )
        if any(value is not None for value in position_values):
            if any(value is None for value in position_values):
                raise ValueError(f"{prefix}的照片定位锚点不完整")
            if self.position_reference not in INTERFACE_OPENING_POSITION_REFERENCES:
                raise ValueError(f"{prefix}的照片定位方式无效")
            offsets = (self.horizontal_offset_mm, self.bottom_offset_mm)
            if not all(
                isinstance(value, (int, float)) and math.isfinite(value)
                for value in offsets
            ):
                raise ValueError(f"{prefix}的照片定位偏移无效")

    def resolve_position(self, parameters: "EnclosureParameters") -> "InterfaceOpening":
        """Resolve a photo anchor against the current orthogonal face dimensions."""
        if self.position_reference != "face-center-bottom":
            return self
        assert self.horizontal_offset_mm is not None
        assert self.bottom_offset_mm is not None
        face_height = (
            parameters.outer_width
            if self.face in {"top", "bottom"}
            else parameters.outer_height
        )
        return replace(
            self,
            center_u_mm=self.horizontal_offset_mm,
            center_v_mm=self.bottom_offset_mm + self.height_mm / 2 - face_height / 2,
        )


@dataclass(frozen=True)
class EnclosureParameters:
    """Parameters expressed in millimeters for the enclosure generator."""

    board_length: float = 58.0
    board_width: float = 28.0
    board_thickness: float = 1.6
    board_component_height: float = 8.5
    clearance_xy: float = 0.3
    clearance_z: float = 0.5
    wall_thickness: float = 2.0
    base_thickness: float = 2.0
    lid_thickness: float = 2.0
    corner_radius: float = 4.0
    edge_chamfer: float = 0.6
    usb_port_width: float = 11.0
    usb_port_height: float = 6.0
    usb_port_bottom: float = 2.7
    usb_port_offset_y: float = 0.0
    interface_openings: tuple[InterfaceOpening, ...] | None = None

    @classmethod
    def from_json(cls, path: Path) -> "EnclosureParameters":
        """Load known parameters from JSON while retaining defaults for omitted fields."""
        data = json.loads(path.read_text(encoding="utf-8"))
        known_fields = set(cls.__dataclass_fields__.keys()) - {"interface_openings"}
        values = {key: value for key, value in data.items() if key in known_fields}
        base_parameters = cls(**values)
        if "interface_openings" not in data:
            return base_parameters
        raw_openings = data["interface_openings"]
        if not isinstance(raw_openings, list):
            raise ValueError("照片精确开孔必须是数组")
        if len(raw_openings) > 100:
            raise ValueError("照片精确开孔不能超过 100 个")
        openings = tuple(
            InterfaceOpening.from_dict(opening, index).resolve_position(base_parameters)
            for index, opening in enumerate(raw_openings)
            if isinstance(opening, dict)
        )
        if len(openings) != len(raw_openings):
            raise ValueError("照片精确开孔数组包含无效项目")
        return cls(**values, interface_openings=openings)

    def validate(self) -> None:
        """Reject parameter sets that cannot produce a printable enclosure."""
        positive_fields = {
            "board_length": self.board_length,
            "board_width": self.board_width,
            "board_thickness": self.board_thickness,
            "board_component_height": self.board_component_height,
            "wall_thickness": self.wall_thickness,
            "base_thickness": self.base_thickness,
            "lid_thickness": self.lid_thickness,
            "usb_port_width": self.usb_port_width,
            "usb_port_height": self.usb_port_height,
        }
        invalid = [name for name, value in positive_fields.items() if value <= 0]
        if invalid:
            raise ValueError(f"以下参数必须大于零：{', '.join(invalid)}")
        if self.clearance_xy < 0 or self.clearance_z < 0:
            raise ValueError("装配间隙不能为负数")
        if self.corner_radius < 0 or self.edge_chamfer < 0:
            raise ValueError("圆角和倒角尺寸不能为负数")
        if self.interface_openings is None:
            if self.base_thickness + self.usb_port_bottom + self.usb_port_height > self.outer_height:
                raise ValueError("模板 USB 开孔超出了下壳高度")
            maximum_usb_offset = self.outer_width / 2 - self.usb_port_width / 2
            if abs(self.usb_port_offset_y) > maximum_usb_offset:
                raise ValueError("模板 USB 开孔水平偏移超出了接口面")
        else:
            validate_interface_openings(self)

    @property
    def outer_length(self) -> float:
        return self.board_length + 2 * (self.clearance_xy + self.wall_thickness)

    @property
    def outer_width(self) -> float:
        return self.board_width + 2 * (self.clearance_xy + self.wall_thickness)

    @property
    def outer_height(self) -> float:
        return (
            self.base_thickness
            + self.board_thickness
            + self.board_component_height
            + self.clearance_z
        )


def _opening_face_size(parameters: EnclosureParameters, face: str) -> tuple[float, float]:
    if face in {"front", "back"}:
        return parameters.outer_width, parameters.outer_height
    if face in {"left", "right"}:
        return parameters.outer_length, parameters.outer_height
    return parameters.outer_length, parameters.outer_width


def validate_interface_openings(parameters: EnclosureParameters) -> None:
    """Conservatively validate edge margins and spacing on each orthogonal face."""
    openings = parameters.interface_openings or ()
    for opening in openings:
        opening.validate()
        face_width, face_height = _opening_face_size(parameters, opening.face)
        if (
            abs(opening.center_u_mm)
            + opening.width_mm / 2
            + opening.minimum_edge_margin_mm
            > face_width / 2 + 1e-9
        ):
            raise ValueError(f"开孔“{opening.id}”距{opening.face}接口面的左右边缘不足")
        if (
            abs(opening.center_v_mm)
            + opening.height_mm / 2
            + opening.minimum_edge_margin_mm
            > face_height / 2 + 1e-9
        ):
            raise ValueError(f"开孔“{opening.id}”距{opening.face}接口面的上下边缘不足")

    for index, left in enumerate(openings):
        for right in openings[index + 1 :]:
            if left.face != right.face:
                continue
            gap_u = max(
                0.0,
                abs(left.center_u_mm - right.center_u_mm)
                - (left.width_mm + right.width_mm) / 2,
            )
            gap_v = max(
                0.0,
                abs(left.center_v_mm - right.center_v_mm)
                - (left.height_mm + right.height_mm) / 2,
            )
            spacing = math.hypot(gap_u, gap_v)
            required = max(left.minimum_spacing_mm, right.minimum_spacing_mm)
            if spacing + 1e-9 < required:
                raise ValueError(
                    f"同一接口面上的开孔“{left.id}”与“{right.id}”间距不足："
                    f"当前约 {spacing:.2f} 毫米，至少需要 {required:.2f} 毫米"
                )


def _opening_plane(
    parameters: EnclosureParameters, opening: InterfaceOpening
) -> tuple[cq.Plane, float]:
    """Return a local U/V plane and total cutter depth for one enclosure face."""
    if opening.face == "front":
        origin = (
            -parameters.outer_length / 2,
            opening.center_u_mm,
            parameters.outer_height / 2 + opening.center_v_mm,
        )
        return cq.Plane(origin=origin, xDir=(0, 1, 0), normal=(1, 0, 0)), parameters.wall_thickness * 4
    if opening.face == "back":
        origin = (
            parameters.outer_length / 2,
            opening.center_u_mm,
            parameters.outer_height / 2 + opening.center_v_mm,
        )
        return cq.Plane(origin=origin, xDir=(0, 1, 0), normal=(1, 0, 0)), parameters.wall_thickness * 4
    if opening.face == "left":
        origin = (
            opening.center_u_mm,
            -parameters.outer_width / 2,
            parameters.outer_height / 2 + opening.center_v_mm,
        )
        return cq.Plane(origin=origin, xDir=(1, 0, 0), normal=(0, -1, 0)), parameters.wall_thickness * 4
    if opening.face == "right":
        origin = (
            opening.center_u_mm,
            parameters.outer_width / 2,
            parameters.outer_height / 2 + opening.center_v_mm,
        )
        return cq.Plane(origin=origin, xDir=(1, 0, 0), normal=(0, -1, 0)), parameters.wall_thickness * 4
    if opening.face == "top":
        origin = (opening.center_u_mm, opening.center_v_mm, parameters.lid_thickness / 2)
        return cq.Plane(origin=origin, xDir=(1, 0, 0), normal=(0, 0, 1)), parameters.lid_thickness * 3
    origin = (opening.center_u_mm, opening.center_v_mm, parameters.base_thickness / 2)
    return cq.Plane(origin=origin, xDir=(1, 0, 0), normal=(0, 0, 1)), parameters.base_thickness * 3


def _circle_on_plane(plane: cq.Plane, diameter: float, depth: float) -> cq.Workplane:
    return cq.Workplane(plane).circle(diameter / 2).extrude(depth / 2, both=True)


def _rounded_rectangle_cutter(
    plane: cq.Plane, width: float, height: float, radius: float, depth: float
) -> cq.Workplane:
    radius = min(max(radius, 0.0), width / 2, height / 2)
    if radius <= 1e-6:
        return cq.Workplane(plane).box(width, height, depth)
    if abs(width - 2 * radius) <= 1e-6 and abs(height - 2 * radius) <= 1e-6:
        return _circle_on_plane(plane, 2 * radius, depth)
    result: cq.Workplane | None = None
    if width - 2 * radius > 1e-6:
        result = cq.Workplane(plane).box(width - 2 * radius, height, depth)
    if height - 2 * radius > 1e-6:
        vertical = cq.Workplane(plane).box(width, height - 2 * radius, depth)
        result = vertical if result is None else result.union(vertical)
    for center_u in (-width / 2 + radius, width / 2 - radius):
        for center_v in (-height / 2 + radius, height / 2 - radius):
            corner = (
                cq.Workplane(plane)
                .center(center_u, center_v)
                .circle(radius)
                .extrude(depth / 2, both=True)
            )
            result = corner if result is None else result.union(corner)
    if result is None:
        raise RuntimeError("无法创建圆角矩形开孔切削体")
    return result


def build_opening_cutter(
    parameters: EnclosureParameters, opening: InterfaceOpening
) -> cq.Workplane:
    plane, depth = _opening_plane(parameters, opening)
    if opening.shape == "circle":
        return _circle_on_plane(plane, max(opening.width_mm, opening.height_mm), depth)
    if opening.shape == "rectangle":
        return cq.Workplane(plane).box(opening.width_mm, opening.height_mm, depth)
    if opening.shape == "rounded-rectangle":
        return _rounded_rectangle_cutter(
            plane,
            opening.width_mm,
            opening.height_mm,
            opening.corner_radius_mm,
            depth,
        )
    slot_radius = min(opening.width_mm, opening.height_mm) / 2
    return _rounded_rectangle_cutter(
        plane, opening.width_mm, opening.height_mm, slot_radius, depth
    )


def _cut_openings(
    target: cq.Workplane,
    parameters: EnclosureParameters,
    openings: tuple[InterfaceOpening, ...],
) -> cq.Workplane:
    result = target
    for opening in openings:
        cutter = build_opening_cutter(parameters, opening)
        intersection_volume = result.intersect(cutter).val().Volume()
        if intersection_volume <= 1e-6:
            raise ValueError(f"开孔“{opening.id}”没有与目标实体相交，请复核接口面和位置")
        result = result.cut(cutter)
        shape = result.val()
        if not shape.isValid() or len(result.solids().vals()) != 1:
            raise RuntimeError(f"开孔“{opening.id}”导致实体无效或被切成多个独立实体")
    return result


def safe_fillet(body: cq.Workplane, selector: str, radius: float) -> cq.Workplane:
    """Apply a fillet when possible and preserve the prior solid on kernel failure."""
    if radius <= 0:
        return body
    try:
        return body.edges(selector).fillet(radius)
    except (ValueError, RuntimeError):
        return body


def safe_chamfer(body: cq.Workplane, selector: str, distance: float) -> cq.Workplane:
    """Apply a chamfer when possible and preserve the prior solid on kernel failure."""
    if distance <= 0:
        return body
    try:
        return body.edges(selector).chamfer(distance)
    except (ValueError, RuntimeError):
        return body


def build_body(parameters: EnclosureParameters) -> cq.Workplane:
    """Build a rounded body, hollow cavity, PCB rails and exact body openings."""
    inner_length = parameters.board_length + 2 * parameters.clearance_xy
    inner_width = parameters.board_width + 2 * parameters.clearance_xy
    inner_height = parameters.outer_height - parameters.base_thickness + 1.0
    outer_radius = min(
        parameters.corner_radius,
        parameters.outer_length / 2 - 0.1,
        parameters.outer_width / 2 - 0.1,
    )

    outer = cq.Workplane("XY").box(
        parameters.outer_length,
        parameters.outer_width,
        parameters.outer_height,
        centered=(True, True, False),
    )
    outer = safe_fillet(outer, "|Z", outer_radius)
    outer = safe_chamfer(outer, ">Z", parameters.edge_chamfer)

    inner_radius = max(0.4, outer_radius - parameters.wall_thickness)
    cavity = (
        cq.Workplane("XY")
        .workplane(offset=parameters.base_thickness)
        .box(inner_length, inner_width, inner_height, centered=(True, True, False))
    )
    cavity = safe_fillet(cavity, "|Z", inner_radius)
    body = outer.cut(cavity)

    rail_width = 1.2
    rail_height = 1.0
    rail_length = max(8.0, parameters.board_length - 8.0)
    rail_z = parameters.base_thickness + rail_height / 2
    rail_y = parameters.board_width / 2 + parameters.clearance_xy - rail_width / 2
    rails = (
        cq.Workplane("XY")
        .box(rail_length, rail_width, rail_height)
        .translate((2.0, rail_y, rail_z))
        .union(
            cq.Workplane("XY")
            .box(rail_length, rail_width, rail_height)
            .translate((2.0, -rail_y, rail_z))
        )
    )
    body = body.union(rails)
    if parameters.interface_openings is None:
        usb_cut = (
            cq.Workplane("XY")
            .box(
                parameters.wall_thickness * 4,
                parameters.usb_port_width,
                parameters.usb_port_height,
            )
            .translate(
                (
                    -parameters.outer_length / 2,
                    parameters.usb_port_offset_y,
                    parameters.base_thickness
                    + parameters.usb_port_bottom
                    + parameters.usb_port_height / 2,
                )
            )
        )
        return body.cut(usb_cut)

    body_openings = tuple(
        opening for opening in parameters.interface_openings if opening.face != "top"
    )
    return _cut_openings(body, parameters, body_openings)


def build_cover(parameters: EnclosureParameters) -> cq.Workplane:
    """Build a rounded, chamfered cover with five printable ventilation slots."""
    outer_radius = min(
        parameters.corner_radius,
        parameters.outer_length / 2 - 0.1,
        parameters.outer_width / 2 - 0.1,
    )
    cover = cq.Workplane("XY").box(
        parameters.outer_length,
        parameters.outer_width,
        parameters.lid_thickness,
        centered=(True, True, False),
    )
    cover = safe_fillet(cover, "|Z", outer_radius)
    cover = safe_chamfer(cover, ">Z", parameters.edge_chamfer)

    slot_length = min(parameters.board_length * 0.45, 28.0)
    for offset in (-6.0, -3.0, 0.0, 3.0, 6.0):
        slot = (
            cq.Workplane("XY")
            .box(slot_length, 1.6, parameters.lid_thickness * 3)
            .translate((5.0, offset, parameters.lid_thickness / 2))
        )
        slot = safe_fillet(slot, "|Z", 0.6)
        cover = cover.cut(slot)

    if parameters.interface_openings is None:
        return cover
    top_openings = tuple(
        opening for opening in parameters.interface_openings if opening.face == "top"
    )
    return _cut_openings(cover, parameters, top_openings)


def _load_previous_generation_state(
    output_dir: Path,
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """读取上一次成功清单的面描述和局部特征；异常旧清单按无历史处理。"""
    manifest_path = output_dir / "generation-result.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, []
    if manifest.get("status") != "ok" or manifest.get("units") != "mm":
        return {}, []
    parts = manifest.get("parts")
    if not isinstance(parts, list):
        return {}, []
    result: dict[str, list[dict[str, Any]]] = {}
    for part in parts:
        if not isinstance(part, dict):
            continue
        part_id = part.get("id")
        faces = part.get("faces")
        if isinstance(part_id, str) and part_id and isinstance(faces, list):
            result[part_id] = [face for face in faces if isinstance(face, dict)]
    raw_features = manifest.get("localFeatures")
    features = [dict(value) for value in raw_features if isinstance(value, dict)] \
        if isinstance(raw_features, list) else []
    return result, features


def _optional_record_float(record: dict[str, Any], key: str, label: str) -> float | None:
    value = record.get(key)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label}格式无效") from error
    if not math.isfinite(number):
        raise ValueError(f"{label}必须是有限数值")
    return number


def _record_vector(record: dict[str, Any], key: str, label: str) -> tuple[float, float, float]:
    value = record.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"{label}缺少三维向量")
    try:
        vector = (float(value["x"]), float(value["y"]), float(value["z"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"{label}三维向量格式无效") from error
    if not all(math.isfinite(component) for component in vector):
        raise ValueError(f"{label}三维向量必须是有限数值")
    return vector


def _optional_record_vector(
    record: dict[str, Any], key: str, label: str
) -> tuple[float, float, float] | None:
    """读取可选三维向量，兼容升级前没有曲面切向的历史记录。"""
    if record.get(key) is None:
        return None
    return _record_vector(record, key, label)



def _record_surface_uv(record: dict[str, Any], label: str) -> tuple[float, float] | None:
    value = record.get("surfaceUv")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{label}格式无效")
    try:
        result = (float(value["u"]), float(value["v"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"{label}格式无效") from error
    if not all(math.isfinite(component) for component in result):
        raise ValueError(f"{label}必须是有限数值")
    return result


def _replay_local_features(
    models: dict[str, cq.Workplane],
    current_faces: dict[str, list[dict[str, Any]]],
    features: list[dict[str, Any]],
    replay_revision: str,
) -> tuple[dict[str, cq.Workplane], list[dict[str, Any]]]:
    """从基础参数化实体开始按记录顺序重放，任一记录不安全时整体拒绝。"""
    if len(features) > 200:
        raise ValueError("历史局部特征超过 200 条，已拒绝自动重放")
    replayed: list[dict[str, Any]] = []
    for index, record in enumerate(features):
        label = f"第 {index + 1} 条局部特征"
        try:
            operation = str(record.get("operation", ""))
            part_id = str(record.get("partId", "")).strip()
            stable_face_id = str(record.get("stableFaceId", "")).strip()
            if part_id not in models:
                raise ValueError(f"目标零件 {part_id or '为空'} 不属于当前参数化模型")
            center = _record_vector(record, "centerMm", f"{label}记录中心")
            normal = _record_vector(record, "outwardNormal", f"{label}记录法线")
            radius_mm = _optional_record_float(record, "radiusMm", f"{label}圆形半径")
            width_mm = _optional_record_float(record, "widthMm", f"{label}轮廓宽度")
            height_mm = _optional_record_float(record, "heightMm", f"{label}矩形高度")
            length_mm = _optional_record_float(record, "lengthMm", f"{label}槽孔长度")
            depth_mm = float(record.get("depthMm"))
            rotation_deg = float(record.get("rotationDeg", 0.0))
            target_face = record.get("targetFace")
            if target_face is not None and not isinstance(target_face, dict):
                raise ValueError("修改前目标面几何签名格式无效")
            surface_geometry_type = str(
                record.get("surfaceGeometryType")
                or (target_face.get("geometryType") if isinstance(target_face, dict) else "PLANE")
                or "PLANE"
            ).strip()
            surface_uv = _record_surface_uv(record, f"{label}曲面 UV")
            surface_tangent_u = _optional_record_vector(record, "surfaceTangentU", f"{label}曲面 U 切向")
            if surface_geometry_type != "PLANE" and surface_uv is None:
                raise ValueError("曲面局部特征记录缺少真实 UV")
            if operation in ("fillet-edge", "chamfer-edge", "fillet-edge-loop", "chamfer-edge-loop", "fillet-edge-chain", "chamfer-edge-chain"):
                stable_edge_id = str(record.get("stableEdgeId", "")).strip()
                validate_edge_feature_inputs(
                    operation, stable_face_id, stable_edge_id, center, normal, depth_mm
                )
                if any(value is not None for value in (radius_mm, width_mm, height_mm, length_mm)):
                    raise ValueError("圆角或倒角记录不能携带平面轮廓尺寸")
                if abs(rotation_deg) > 1e-9:
                    raise ValueError("圆角或倒角记录的旋转角必须为 0")
                target_edge = record.get("targetEdge")
                if target_edge is not None and not isinstance(target_edge, dict):
                    raise ValueError("修改前目标边几何签名格式无效")
                application = apply_edge_feature(
                    models[part_id], current_faces[part_id], operation,  # type: ignore[arg-type]
                    stable_face_id, stable_edge_id, center, normal, depth_mm,
                    target_face_descriptor=target_face,
                    target_edge_descriptor=target_edge,
                    surface_uv=surface_uv,
                )
            else:
                validate_planar_feature_inputs(
                    operation,
                    stable_face_id,
                    center,
                    normal,
                    radius_mm=radius_mm,
                    width_mm=width_mm,
                    height_mm=height_mm,
                    length_mm=length_mm,
                    depth_mm=depth_mm,
                    rotation_deg=rotation_deg,
                )
                application = apply_planar_feature(
                    models[part_id],
                    operation,  # type: ignore[arg-type]
                    stable_face_id,
                    current_faces[part_id],
                    center,
                    normal,
                    radius_mm=radius_mm,
                    width_mm=width_mm,
                    height_mm=height_mm,
                    length_mm=length_mm,
                    depth_mm=depth_mm,
                    rotation_deg=rotation_deg,
                    target_face_descriptor=target_face,
                    surface_geometry_type=surface_geometry_type,
                    surface_uv=surface_uv,
                    surface_tangent_u=surface_tangent_u,
                )
            models[part_id] = application["model"]
            current_faces[part_id] = application["faces"]
            replayed_record = {
                **record,
                "stableFaceStatus": application["stableFaceStatus"],
                "stableEdgeStatus": application.get("stableEdgeStatus"),
                "targetFace": record.get("targetFace") or application["targetFace"],
                "targetEdge": record.get("targetEdge") or application.get("targetEdge"),
                "surfaceUv": application["validation"].get("surfaceUv"),
                "surfaceTangentU": application["validation"].get("surfaceTangentU"),
                "replayStatus": "replayed",
                "replayedRevision": replay_revision,
                "failureReason": None,
            }
            curved_diagnostics = build_curved_feature_diagnostics(
                operation,
                surface_geometry_type,
                application["validation"],
            )
            if curved_diagnostics is not None:
                replayed_record["curvedDiagnostics"] = curved_diagnostics
            else:
                replayed_record.pop("curvedDiagnostics", None)
            replayed.append(replayed_record)
        except (TypeError, ValueError) as error:
            command = str(record.get("command") or "").strip()
            command_text = f"（{command[:80]}）" if command else ""
            raise ValueError(
                f"{label}{command_text}无法安全重放：{error}。已保留修改前模型，需要重新选择目标面"
            ) from error
    return models, replayed


def _aggregate_face_matching(part_summaries: list[dict[str, Any]]) -> dict[str, Any]:
    inherited_confidences = [
        (float(summary["averageInheritedConfidence"]), int(summary["inheritedFaceCount"]))
        for summary in part_summaries
        if summary.get("averageInheritedConfidence") is not None
        and int(summary.get("inheritedFaceCount", 0)) > 0
    ]
    inherited_total = sum(count for _, count in inherited_confidences)
    return {
        "method": MATCH_METHOD,
        "previousFaceCount": sum(int(summary["previousFaceCount"]) for summary in part_summaries),
        "currentFaceCount": sum(int(summary["currentFaceCount"]) for summary in part_summaries),
        "inheritedFaceCount": sum(int(summary["inheritedFaceCount"]) for summary in part_summaries),
        "newFaceCount": sum(int(summary["newFaceCount"]) for summary in part_summaries),
        "disappearedFaceCount": sum(int(summary["disappearedFaceCount"]) for summary in part_summaries),
        "averageInheritedConfidence": (
            round(
                sum(confidence * count for confidence, count in inherited_confidences)
                / inherited_total,
                4,
            )
            if inherited_total > 0
            else None
        ),
        "warning": MATCH_WARNING,
    }


def _shape_metrics(model: cq.Workplane) -> dict[str, Any]:
    """Return validity, volume and axis-aligned bounds for one OpenCascade model."""
    shape = model.val()
    bounds = shape.BoundingBox()
    dimensions = {
        "x": round(bounds.xlen, 3),
        "y": round(bounds.ylen, 3),
        "z": round(bounds.zlen, 3),
    }
    fits_p1s = all(
        dimensions[axis] <= limit
        for axis, limit in zip(("x", "y", "z"), P1S_BUILD_VOLUME_MM, strict=True)
    )
    return {
        "valid": bool(shape.isValid()),
        "volumeMm3": round(shape.Volume(), 3),
        "boundsMm": dimensions,
        "fitsP1S": fits_p1s,
    }


def _mesh_xml(model: cq.Workplane, object_id: int, name: str) -> ET.Element:
    """Tessellate a CadQuery model into one 3MF mesh object."""
    vertices, triangles = model.val().tessellate(0.05, 0.1)
    object_element = ET.Element(
        f"{{{MODEL_NAMESPACE}}}object",
        {"id": str(object_id), "type": "model", "name": name},
    )
    mesh = ET.SubElement(object_element, f"{{{MODEL_NAMESPACE}}}mesh")
    vertices_element = ET.SubElement(mesh, f"{{{MODEL_NAMESPACE}}}vertices")
    for vertex in vertices:
        ET.SubElement(
            vertices_element,
            f"{{{MODEL_NAMESPACE}}}vertex",
            {
                "x": f"{vertex.x:.6f}",
                "y": f"{vertex.y:.6f}",
                "z": f"{vertex.z:.6f}",
            },
        )
    triangles_element = ET.SubElement(mesh, f"{{{MODEL_NAMESPACE}}}triangles")
    for triangle in triangles:
        ET.SubElement(
            triangles_element,
            f"{{{MODEL_NAMESPACE}}}triangle",
            {"v1": str(triangle[0]), "v2": str(triangle[1]), "v3": str(triangle[2])},
        )
    return object_element


def export_3mf(
    body: cq.Workplane,
    cover: cq.Workplane,
    parameters: EnclosureParameters,
    output_path: Path,
) -> None:
    """Export a standards-compliant 3MF containing separate body and cover objects."""
    ET.register_namespace("", MODEL_NAMESPACE)
    model = ET.Element(f"{{{MODEL_NAMESPACE}}}model", {"unit": "millimeter", "xml:lang": "zh-CN"})
    ET.SubElement(model, f"{{{MODEL_NAMESPACE}}}metadata", {"name": "Title"}).text = (
        "FormAI 参数化模型"
    )
    resources = ET.SubElement(model, f"{{{MODEL_NAMESPACE}}}resources")
    resources.append(_mesh_xml(body, 1, "模型主体"))
    resources.append(_mesh_xml(cover, 2, "模型上盖"))
    build = ET.SubElement(model, f"{{{MODEL_NAMESPACE}}}build")
    ET.SubElement(build, f"{{{MODEL_NAMESPACE}}}item", {"objectid": "1"})
    cover_y_offset = parameters.outer_width + 8.0
    ET.SubElement(
        build,
        f"{{{MODEL_NAMESPACE}}}item",
        {
            "objectid": "2",
            "transform": f"1 0 0 0 1 0 0 0 1 0 {cover_y_offset:.3f} 0",
        },
    )

    content_types = ET.Element(f"{{{CONTENT_TYPES_NAMESPACE}}}Types")
    ET.SubElement(
        content_types,
        f"{{{CONTENT_TYPES_NAMESPACE}}}Default",
        {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"},
    )
    ET.SubElement(
        content_types,
        f"{{{CONTENT_TYPES_NAMESPACE}}}Override",
        {"PartName": "/3D/3dmodel.model", "ContentType": "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"},
    )

    relationships = ET.Element(f"{{{RELATIONSHIP_NAMESPACE}}}Relationships")
    ET.SubElement(
        relationships,
        f"{{{RELATIONSHIP_NAMESPACE}}}Relationship",
        {
            "Target": "/3D/3dmodel.model",
            "Id": "rel0",
            "Type": "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel",
        },
    )

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            ET.tostring(content_types, encoding="utf-8", xml_declaration=True),
        )
        archive.writestr(
            "_rels/.rels",
            ET.tostring(relationships, encoding="utf-8", xml_declaration=True),
        )
        archive.writestr(
            "3D/3dmodel.model",
            ET.tostring(model, encoding="utf-8", xml_declaration=True),
        )


def export_models(parameters: EnclosureParameters, output_dir: Path) -> None:
    """Generate, validate and export body/cover STL, STEP and combined 3MF files."""
    parameters.validate()
    output_dir.mkdir(parents=True, exist_ok=True)
    previous_faces, previous_local_features = _load_previous_generation_state(output_dir)
    revision = str(time_ns())
    models = {
        "body": build_body(parameters),
        "cover": build_cover(parameters),
    }
    initial_face_sources = {
        part_id: match_shape_faces_with_sources(model, previous_faces.get(part_id))[0]
        for part_id, model in models.items()
    }
    current_faces = {
        part_id: [descriptor for _, descriptor in sources]
        for part_id, sources in initial_face_sources.items()
    }
    models, local_features = _replay_local_features(
        models,
        current_faces,
        previous_local_features,
        revision,
    )
    body = models["body"]
    cover = models["cover"]

    # 最终清单始终相对上一版最终实体进行几何签名匹配，避免把重放中间态
    # 误写成跨重建的永久拓扑关系。
    body_face_sources, body_face_matching = match_shape_faces_with_sources(
        body, previous_faces.get("body")
    )
    cover_face_sources, cover_face_matching = match_shape_faces_with_sources(
        cover, previous_faces.get("cover")
    )
    body_faces = [descriptor for _, descriptor in body_face_sources]
    cover_faces = [descriptor for _, descriptor in cover_face_sources]
    face_matching = _aggregate_face_matching([body_face_matching, cover_face_matching])
    metrics = {"body": _shape_metrics(body), "cover": _shape_metrics(cover)}
    if not all(model["valid"] for model in metrics.values()):
        raise RuntimeError("OpenCascade 生成了无效实体")

    output_names = [
        "model-body.stl",
        "model-cover.stl",
        "model-body.step",
        "model-cover.step",
        "model-assembly.3mf",
        "model-body-selection.stl",
        "model-body-face-map.json",
        "model-cover-selection.stl",
        "model-cover-face-map.json",
    ]
    exporters.export(body, str(output_dir / output_names[0]), tolerance=0.05)
    exporters.export(cover, str(output_dir / output_names[1]), tolerance=0.05)
    exporters.export(body, str(output_dir / output_names[2]))
    exporters.export(cover, str(output_dir / output_names[3]))
    export_3mf(body, cover, parameters, output_dir / output_names[4])
    body_face_tessellation = export_face_tessellation_mapping(
        output_dir,
        "body",
        body_face_sources,
        source_stl_file=output_names[0],
        selection_mesh_file=output_names[5],
        mapping_file=output_names[6],
    )
    cover_face_tessellation = export_face_tessellation_mapping(
        output_dir,
        "cover",
        cover_face_sources,
        source_stl_file=output_names[1],
        selection_mesh_file=output_names[7],
        mapping_file=output_names[8],
    )

    file_metrics = {
        name: {"bytes": (output_dir / name).stat().st_size}
        for name in output_names
    }
    if parameters.interface_openings is None:
        manifest_openings = [
            {
                "id": "template-usb-c",
                "label": "模板 USB-C 开孔",
                "sourceType": "USB-C",
                "face": "front",
                "shape": "rectangle",
                "widthMm": parameters.usb_port_width,
                "heightMm": parameters.usb_port_height,
                "centerUMm": parameters.usb_port_offset_y,
                "centerVMm": (
                    parameters.base_thickness
                    + parameters.usb_port_bottom
                    + parameters.usb_port_height / 2
                    - parameters.outer_height / 2
                ),
                "cornerRadiusMm": 0.0,
                "minimumEdgeMarginMm": 0.0,
                "minimumSpacingMm": 0.0,
                "sourceConfidence": 1.0,
            }
        ]
        opening_mode = "legacy-template"
        body_opening_count = 1
        cover_opening_count = 0
        minimum_edge_margin = None
        minimum_spacing = None
    else:
        manifest_openings = [
            {
                "id": opening.id,
                "label": opening.label,
                "sourceType": opening.source_type,
                "face": opening.face,
                "shape": opening.shape,
                "widthMm": opening.width_mm,
                "heightMm": opening.height_mm,
                "centerUMm": opening.center_u_mm,
                "centerVMm": opening.center_v_mm,
                "cornerRadiusMm": opening.corner_radius_mm,
                "minimumEdgeMarginMm": opening.minimum_edge_margin_mm,
                "minimumSpacingMm": opening.minimum_spacing_mm,
                "sourceConfidence": opening.source_confidence,
                **(
                    {
                        "positionReference": opening.position_reference,
                        "horizontalOffsetMm": opening.horizontal_offset_mm,
                        "bottomOffsetMm": opening.bottom_offset_mm,
                    }
                    if opening.position_reference is not None
                    else {}
                ),
            }
            for opening in parameters.interface_openings
        ]
        opening_mode = "custom"
        body_opening_count = sum(
            opening.face != "top" for opening in parameters.interface_openings
        )
        cover_opening_count = sum(
            opening.face == "top" for opening in parameters.interface_openings
        )
        minimum_edge_margin = min(
            (opening.minimum_edge_margin_mm for opening in parameters.interface_openings),
            default=None,
        )
        minimum_spacing = min(
            (opening.minimum_spacing_mm for opening in parameters.interface_openings),
            default=None,
        )
    parameter_values = {
        key: value
        for key, value in asdict(parameters).items()
        if key != "interface_openings"
    }
    summary = {
        "status": "ok",
        "revision": revision,
        "outputs": output_names,
        "units": "mm",
        "kernel": "OpenCascade 7.8 / CadQuery 2.6",
        "printer": {
            "model": "Bambu Lab P1S",
            "buildVolumeMm": list(P1S_BUILD_VOLUME_MM),
            "nozzleMm": 0.4,
        },
        "model": {
            "id": "current-model",
            "name": "未命名模型",
            "templateId": "electronics-enclosure",
            "templateName": "电子元件保护壳",
        },
        "parameters": parameter_values,
        "interfaceOpeningMode": opening_mode,
        "interfaceOpenings": manifest_openings,
        "openingValidation": {
            "count": len(manifest_openings),
            "bodyCount": body_opening_count,
            "coverCount": cover_opening_count,
            "minimumEdgeMarginMm": minimum_edge_margin,
            "minimumSpacingMm": minimum_spacing,
        },
        "faceMatching": face_matching,
        "parts": [
            {
                "id": "body",
                "label": "主体",
                "role": "primary",
                "stlFile": output_names[0],
                "stepFile": output_names[2],
                "metrics": metrics["body"],
                "faces": body_faces,
                "faceMatching": body_face_matching,
                "faceTessellation": body_face_tessellation,
            },
            {
                "id": "cover",
                "label": "上盖",
                "role": "cover",
                "stlFile": output_names[1],
                "stepFile": output_names[3],
                "metrics": metrics["cover"],
                "faces": cover_faces,
                "faceMatching": cover_face_matching,
                "faceTessellation": cover_face_tessellation,
            },
        ],
        "assemblyFile": output_names[4],
        "files": file_metrics,
        "localFeatures": local_features,
        "localFeatureReplay": {
            "status": "ok" if local_features else "none",
            "requestedCount": len(previous_local_features),
            "replayedCount": len(local_features),
            "revision": revision,
        },
    }
    (output_dir / "generation-result.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--parameters",
        type=Path,
        default=Path(__file__).with_name("default-model.json"),
        help="当前参数化模板的参数 JSON 文件。",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).parents[1] / "artifacts",
        help="生成模型文件的输出目录。",
    )
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    export_models(EnclosureParameters.from_json(arguments.parameters), arguments.output)
