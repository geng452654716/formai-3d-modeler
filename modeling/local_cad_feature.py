"""对当前参数化 CAD 的一个稳定平面执行可验证的局部或整面特征。

稳定面定位使用“几何签名匹配第一版”，不是 OpenCascade 原生永久拓扑命名。
请求中的点击坐标和法线仅作为二次校验；实际布尔方向由当前 STEP 中重新定位的面决定。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import zipfile
from pathlib import Path
from time import time_ns
from typing import Any, Literal
from xml.etree import ElementTree as ET

import cadquery as cq
from cadquery import exporters, importers

from face_geometry_signatures import MATCH_METHOD, MATCH_WARNING, match_shape_faces_with_sources
from face_tessellation_mapping import build_face_tessellation
from local_cad_feature_core import (
    apply_edge_feature,
    apply_planar_feature,
    validate_edge_feature_inputs,
    validate_planar_feature_inputs,
)
from local_stl_edit import _commit_files_with_rollback
from split_and_cap import _closed_solids, import_stl_as_solid

Operation = Literal["add-cylinder", "cut-cylinder", "add-rectangle", "cut-rectangle", "cut-slot", "offset-face-outward", "offset-face-inward", "fillet-edge", "chamfer-edge"]
P1S_BUILD_VOLUME_MM = (256.0, 256.0, 256.0)
MODEL_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"


def _plain_file_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or Path(value).name != value:
        raise ValueError(f"当前精确模型清单中的{label}文件名无效")
    return value


def _load_manifest(output_dir: Path) -> tuple[Path, dict[str, Any]]:
    path = output_dir / "generation-result.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError("没有找到当前精确 CAD 清单，请先重建 CAD") from error
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"当前精确 CAD 清单无法读取：{error}") from error
    if manifest.get("status") != "ok" or manifest.get("units") != "mm":
        raise ValueError("当前精确 CAD 清单格式无效，请先重建 CAD")
    if not isinstance(manifest.get("parts"), list) or not manifest["parts"]:
        raise ValueError("当前精确 CAD 清单没有可编辑零件")
    return path, manifest


def _part_metrics(model: cq.Workplane) -> dict[str, Any]:
    shape = model.val()
    bounds = shape.BoundingBox()
    dimensions = {
        "x": round(float(bounds.xlen), 3),
        "y": round(float(bounds.ylen), 3),
        "z": round(float(bounds.zlen), 3),
    }
    return {
        "valid": bool(shape.isValid()),
        "volumeMm3": round(float(shape.Volume()), 3),
        "boundsMm": dimensions,
        "fitsP1S": all(
            dimensions[axis] <= limit
            for axis, limit in zip(("x", "y", "z"), P1S_BUILD_VOLUME_MM, strict=True)
        ),
    }


def _identity_face_matching(face_count: int) -> dict[str, Any]:
    return {
        "method": MATCH_METHOD,
        "previousFaceCount": face_count,
        "currentFaceCount": face_count,
        "inheritedFaceCount": face_count,
        "newFaceCount": 0,
        "disappearedFaceCount": 0,
        "averageInheritedConfidence": 1.0 if face_count else None,
        "warning": MATCH_WARNING,
    }


def _aggregate_face_matching(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    inherited = [
        (float(summary["averageInheritedConfidence"]), int(summary["inheritedFaceCount"]))
        for summary in summaries
        if summary.get("averageInheritedConfidence") is not None
        and int(summary.get("inheritedFaceCount", 0)) > 0
    ]
    inherited_count = sum(count for _, count in inherited)
    return {
        "method": MATCH_METHOD,
        "previousFaceCount": sum(int(value.get("previousFaceCount", 0)) for value in summaries),
        "currentFaceCount": sum(int(value.get("currentFaceCount", 0)) for value in summaries),
        "inheritedFaceCount": sum(int(value.get("inheritedFaceCount", 0)) for value in summaries),
        "newFaceCount": sum(int(value.get("newFaceCount", 0)) for value in summaries),
        "disappearedFaceCount": sum(int(value.get("disappearedFaceCount", 0)) for value in summaries),
        "averageInheritedConfidence": (
            round(sum(confidence * count for confidence, count in inherited) / inherited_count, 4)
            if inherited_count
            else None
        ),
        "warning": MATCH_WARNING,
    }


def _mesh_xml(model: cq.Workplane, object_id: int, name: str) -> ET.Element:
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
            {"x": f"{vertex.x:.6f}", "y": f"{vertex.y:.6f}", "z": f"{vertex.z:.6f}"},
        )
    triangles_element = ET.SubElement(mesh, f"{{{MODEL_NAMESPACE}}}triangles")
    for triangle in triangles:
        ET.SubElement(
            triangles_element,
            f"{{{MODEL_NAMESPACE}}}triangle",
            {"v1": str(triangle[0]), "v2": str(triangle[1]), "v3": str(triangle[2])},
        )
    return object_element


def _export_assembly_3mf(parts: list[tuple[str, cq.Workplane]], output_path: Path) -> None:
    """重新打包通用多零件 3MF；零件沿 Y 轴留 8 毫米打印间距。"""
    ET.register_namespace("", MODEL_NAMESPACE)
    model = ET.Element(f"{{{MODEL_NAMESPACE}}}model", {"unit": "millimeter", "xml:lang": "zh-CN"})
    ET.SubElement(model, f"{{{MODEL_NAMESPACE}}}metadata", {"name": "Title"}).text = "FormAI 当前模型"
    resources = ET.SubElement(model, f"{{{MODEL_NAMESPACE}}}resources")
    build = ET.SubElement(model, f"{{{MODEL_NAMESPACE}}}build")
    previous_max_y: float | None = None
    for index, (label, part) in enumerate(parts, start=1):
        resources.append(_mesh_xml(part, index, label))
        bounds = part.val().BoundingBox()
        translation_y = 0.0 if previous_max_y is None else previous_max_y + 8.0 - float(bounds.ymin)
        attributes = {"objectid": str(index)}
        if abs(translation_y) > 1e-9:
            attributes["transform"] = f"1 0 0 0 1 0 0 0 1 0 {translation_y:.6f} 0"
        ET.SubElement(build, f"{{{MODEL_NAMESPACE}}}item", attributes)
        previous_max_y = float(bounds.ymax) + translation_y

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
        {"Target": "/3D/3dmodel.model", "Id": "rel0", "Type": "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"},
    )
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", ET.tostring(content_types, encoding="utf-8", xml_declaration=True))
        archive.writestr("_rels/.rels", ET.tostring(relationships, encoding="utf-8", xml_declaration=True))
        archive.writestr("3D/3dmodel.model", ET.tostring(model, encoding="utf-8", xml_declaration=True))


def _shape_from_step(path: Path, label: str) -> cq.Workplane:
    if not path.is_file():
        raise ValueError(f"没有找到{label} STEP 文件：{path.name}")
    model = importers.importStep(str(path))
    solids = _closed_solids(model, label)
    if len(solids) != 1:
        raise ValueError(f"{label}包含 {len(solids)} 个 Solid；局部特征第一版只支持单一封闭 Solid")
    return model


def edit_cad_feature(
    output_dir: Path,
    operation: Operation,
    selection_revision: str,
    part_id: str,
    stable_face_id: str,
    center: tuple[float, float, float],
    hit_normal: tuple[float, float, float],
    radius_mm: float | None,
    depth_mm: float,
    command: str = "",
    *,
    width_mm: float | None = None,
    height_mm: float | None = None,
    length_mm: float | None = None,
    rotation_deg: float = 0.0,
    stable_edge_id: str | None = None,
    surface_geometry_type: str | None = None,
    surface_uv: tuple[float, float] | None = None,
) -> dict[str, Any]:
    if not selection_revision.strip() or not part_id.strip() or not stable_face_id.strip():
        raise ValueError("稳定 CAD 面选择上下文不完整，请重新选择平面")
    edge_operation = operation in ("fillet-edge", "chamfer-edge")
    if edge_operation:
        validate_edge_feature_inputs(
            operation, stable_face_id, stable_edge_id or "", center, hit_normal, depth_mm
        )
        if any(value is not None for value in (radius_mm, width_mm, height_mm, length_mm)):
            raise ValueError("圆角或倒角不能携带平面轮廓尺寸")
        if abs(rotation_deg) > 1e-9:
            raise ValueError("圆角或倒角不需要旋转角，rotationDeg 必须为 0")
    else:
        validate_planar_feature_inputs(
            operation,
            stable_face_id,
            center,
            hit_normal,
            radius_mm=radius_mm,
            width_mm=width_mm,
            height_mm=height_mm,
            length_mm=length_mm,
            depth_mm=depth_mm,
            rotation_deg=rotation_deg,
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path, manifest = _load_manifest(output_dir)
    if str(manifest.get("revision", "")) != selection_revision:
        raise ValueError("当前 CAD 已在选择后发生变化，triangleIndex 已失效，请重新点击目标平面")

    matching_parts = [part for part in manifest["parts"] if isinstance(part, dict) and part.get("id") == part_id]
    if len(matching_parts) != 1:
        raise ValueError(f"没有找到唯一的目标 CAD 零件：{part_id}")
    target_part = matching_parts[0]
    previous_faces = target_part.get("faces")
    if not isinstance(previous_faces, list) or not previous_faces:
        raise ValueError("目标零件没有稳定面描述，请先重新生成选择网格")
    requested_descriptor = next(
        (face for face in previous_faces if isinstance(face, dict) and face.get("stableId") == stable_face_id),
        None,
    )
    if requested_descriptor is None:
        raise ValueError("所选稳定面已不存在或已重新编号，请重新点击目标平面")
    descriptor_geometry_type = str(requested_descriptor.get("geometryType", ""))
    requested_geometry_type = (surface_geometry_type or descriptor_geometry_type).strip()
    if requested_geometry_type != descriptor_geometry_type:
        raise ValueError(
            f"请求曲面类型 {requested_geometry_type} 与稳定面类型 {descriptor_geometry_type} 不一致，请重新点击目标面"
        )
    if edge_operation and descriptor_geometry_type != "PLANE":
        raise ValueError("稳定 CAD 边圆角和倒角第一版只支持平面所属边")
    if not edge_operation and descriptor_geometry_type != "PLANE":
        if operation not in ("add-cylinder", "cut-cylinder"):
            raise ValueError(
                f"当前选中的是 {descriptor_geometry_type} 曲面；第一版曲面局部特征只支持圆形凸台或圆孔"
            )
        if surface_uv is None or len(surface_uv) != 2 or not all(math.isfinite(value) for value in surface_uv):
            raise ValueError("曲面圆形局部特征缺少有限的真实 UV，请重新点击目标面")

    step_file = _plain_file_name(target_part.get("stepFile"), "目标零件 STEP ")
    stl_file = _plain_file_name(target_part.get("stlFile"), "目标零件 STL ")
    face_tessellation = target_part.get("faceTessellation")
    if not isinstance(face_tessellation, dict):
        raise ValueError("目标零件缺少面三角映射，请先重新生成 CAD")
    selection_mesh_file = _plain_file_name(face_tessellation.get("selectionMeshFile"), "选择网格 ")
    mapping_file = _plain_file_name(face_tessellation.get("mappingFile"), "面映射 ")
    assembly_file = _plain_file_name(manifest.get("assemblyFile"), "装配 ")

    model = _shape_from_step(output_dir / step_file, "目标 CAD 零件")
    if edge_operation:
        application = apply_edge_feature(
            model,
            previous_faces,
            operation,
            stable_face_id,
            stable_edge_id or "",
            center,
            hit_normal,
            depth_mm,
            target_face_descriptor=requested_descriptor,
        )
    else:
        application = apply_planar_feature(
            model,
            operation,
            stable_face_id,
            previous_faces,
            center,
            hit_normal,
            radius_mm=radius_mm,
            width_mm=width_mm,
            height_mm=height_mm,
            length_mm=length_mm,
            depth_mm=depth_mm,
            rotation_deg=rotation_deg,
            target_face_descriptor=requested_descriptor,
            surface_geometry_type=requested_geometry_type,
            surface_uv=surface_uv,
        )
    edited = application["model"]
    new_face_sources = application["faceSources"]
    new_faces = application["faces"]
    target_face_matching = application["faceMatching"]
    target_face_status = application["stableFaceStatus"]
    target_edge_status = application.get("stableEdgeStatus")
    outward = application["outwardNormal"]
    validation = application["validation"]
    point_distance = float(validation["pointDistanceMm"])
    normal_dot = float(validation["normalDot"])
    volume_before = float(validation["volumeBeforeMm3"])
    volume_after = float(validation["volumeAfterMm3"])
    revision = str(time_ns())

    temporary_step = output_dir / f".{Path(step_file).stem}-{revision}.step"
    temporary_stl = output_dir / f".{Path(stl_file).stem}-{revision}.stl"
    temporary_selection = output_dir / f".{Path(selection_mesh_file).stem}-{revision}.stl"
    temporary_mapping = output_dir / f".{Path(mapping_file).stem}-{revision}.json"
    temporary_assembly = output_dir / f".{Path(assembly_file).stem}-{revision}.3mf"
    temporary_manifest = output_dir / f".generation-result-{revision}.json"
    temporary_result = output_dir / f".local-cad-feature-result-{revision}.json"
    temporary_paths = [
        temporary_step,
        temporary_stl,
        temporary_selection,
        temporary_mapping,
        temporary_assembly,
        temporary_manifest,
        temporary_result,
    ]

    try:
        exporters.export(edited, str(temporary_step))
        exporters.export(edited, str(temporary_stl), tolerance=0.05)
        verified_step = _shape_from_step(temporary_step, "局部特征导出 STEP")
        verified_stl_model, _ = import_stl_as_solid(temporary_stl)
        verified_stl_solids = _closed_solids(verified_stl_model, "局部特征导出 STL")
        if len(verified_stl_solids) != 1:
            raise ValueError("局部特征 STL 导出后不再是单一封闭 Solid，已拒绝覆盖当前模型")
        exported_volume = float(verified_stl_solids[0].Volume())
        # STL 是三角网格近似；曲面零件允许千分之一体积误差，同时继续要求有效、封闭且单一 Solid。
        export_volume_tolerance = max(0.05, volume_after * 1e-3)
        export_volume_error = abs(exported_volume - volume_after)
        if export_volume_error > export_volume_tolerance:
            raise ValueError(
                "局部特征 STL 导出体积误差超限"
                f"（误差 {export_volume_error:.3f} 立方毫米，允许 {export_volume_tolerance:.3f} 立方毫米），"
                "已拒绝覆盖当前模型"
            )
        if not verified_step.val().isValid():
            raise ValueError("局部特征 STEP 导出校验失败，已拒绝覆盖当前模型")

        selection_binary, mapping = build_face_tessellation(
            part_id,
            new_face_sources,
            source_stl_file=stl_file,
            selection_mesh_file=selection_mesh_file,
            mapping_file=mapping_file,
        )
        temporary_selection.write_bytes(selection_binary)
        temporary_mapping.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

        assembly_parts: list[tuple[str, cq.Workplane]] = []
        part_summaries: list[dict[str, Any]] = []
        for part in manifest["parts"]:
            if not isinstance(part, dict):
                raise ValueError("当前精确 CAD 清单包含无效零件记录")
            if part is target_part:
                part["metrics"] = _part_metrics(edited)
                part["faces"] = new_faces
                part["faceMatching"] = target_face_matching
                part["faceTessellation"] = mapping
                assembly_parts.append((str(part.get("label") or part_id), edited))
                part_summaries.append(target_face_matching)
            else:
                other_step = _plain_file_name(part.get("stepFile"), "其他零件 STEP ")
                other_model = _shape_from_step(output_dir / other_step, f"零件 {part.get('id') or other_step}")
                other_faces = part.get("faces") if isinstance(part.get("faces"), list) else []
                identity_summary = _identity_face_matching(len(other_faces))
                part["faceMatching"] = identity_summary
                assembly_parts.append((str(part.get("label") or part.get("id") or other_step), other_model))
                part_summaries.append(identity_summary)
        _export_assembly_3mf(assembly_parts, temporary_assembly)

        manifest["revision"] = revision
        manifest["faceMatching"] = _aggregate_face_matching(part_summaries)
        feature_record = {
            "revision": revision,
            "operation": operation,
            "partId": part_id,
            "stableFaceId": stable_face_id,
            "stableEdgeId": stable_edge_id,
            "centerMm": {"x": center[0], "y": center[1], "z": center[2]},
            "outwardNormal": outward,
            "surfaceGeometryType": requested_geometry_type,
            "surfaceUv": None if surface_uv is None else {"u": surface_uv[0], "v": surface_uv[1]},
            "targetFace": application["targetFace"],
            "targetEdge": application.get("targetEdge"),
            "createdRevision": revision,
            "replayStatus": "recorded",
            "replayedRevision": None,
            "radiusMm": radius_mm,
            "widthMm": width_mm,
            "heightMm": height_mm,
            "lengthMm": length_mm,
            "depthMm": depth_mm,
            "rotationDeg": rotation_deg,
            "command": command,
            "stableFaceStatus": target_face_status,
            "stableEdgeStatus": target_edge_status,
        }
        previous_features = manifest.get("localFeatures")
        manifest["localFeatures"] = [
            *(previous_features if isinstance(previous_features, list) else []),
            feature_record,
        ]

        pending_files = {
            step_file: temporary_step,
            stl_file: temporary_stl,
            selection_mesh_file: temporary_selection,
            mapping_file: temporary_mapping,
            assembly_file: temporary_assembly,
        }
        output_names = manifest.get("outputs") if isinstance(manifest.get("outputs"), list) else []
        manifest["outputs"] = list(dict.fromkeys([
            *[name for name in output_names if isinstance(name, str)],
            stl_file,
            step_file,
            assembly_file,
            selection_mesh_file,
            mapping_file,
        ]))
        manifest["files"] = {
            name: {"bytes": pending_files.get(name, output_dir / name).stat().st_size}
            for name in manifest["outputs"]
            if Path(name).name == name and pending_files.get(name, output_dir / name).is_file()
        }

        result: dict[str, Any] = {
            "status": "ok",
            "revision": revision,
            "operation": operation,
            "command": command,
            "partId": part_id,
            "stableFaceId": stable_face_id,
            "stableEdgeId": stable_edge_id,
            "stableFaceStatus": target_face_status,
            "stableEdgeStatus": target_edge_status,
            "outputs": [stl_file, step_file, selection_mesh_file, mapping_file, assembly_file, "generation-result.json"],
            "units": "mm",
            "kernel": "OpenCascade 7.8 / CadQuery 2.6",
            "validation": {
                "valid": True,
                "watertight": True,
                "solidCount": 1,
                "pointDistanceMm": point_distance,
                "normalDot": normal_dot,
                "volumeBeforeMm3": volume_before,
                "volumeAfterMm3": exported_volume,
                "volumeDeltaMm3": exported_volume - volume_before,
                "boundsMm": _part_metrics(edited)["boundsMm"],
                "surfaceGeometryType": validation.get("surfaceGeometryType", requested_geometry_type),
                "surfaceUv": validation.get("surfaceUv"),
                "maximumAbsCurvaturePerMm": validation.get("maximumAbsCurvaturePerMm"),
                "minimumCurvatureRadiusMm": validation.get("minimumCurvatureRadiusMm"),
                "curvatureRatio": validation.get("curvatureRatio"),
                "localWallThicknessMm": validation.get("localWallThicknessMm"),
                "remainingWallMm": validation.get("remainingWallMm"),
                "throughCut": bool(validation.get("throughCut", False)),
                "interferenceCheckPassed": validation.get("interferenceCheckPassed"),
                "selfIntersectionDetected": validation.get("selfIntersectionDetected"),
                "adjacentFaceInterferenceDetected": validation.get("adjacentFaceInterferenceDetected"),
                "interferingFaceCount": int(validation.get("interferingFaceCount", 0)),
                "interferingStableFaceIds": validation.get("interferingStableFaceIds", []),
                "minimumInterferenceDistanceMm": validation.get("minimumInterferenceDistanceMm"),
                "contactFaceCount": int(validation.get("contactFaceCount", 0)),
                "contactSampleCount": int(validation.get("contactSampleCount", 0)),
            },
            "faceMatching": target_face_matching,
            "updatedCadResult": manifest,
            "limitations": [
                "第一版支持稳定平面轮廓与整面特征、曲面圆形凸台或圆孔，以及点击单条稳定 CAD 边执行圆角或倒角",
                "曲面圆形特征会在布尔和文件写回前检查目标曲面回撞与非目标稳定面干涉；通孔只放行局部壁厚附近的正常出口接触",
                "稳定面和面内稳定边 ID 使用几何签名匹配第一版，不是 OpenCascade 原生永久拓扑命名",
                "triangleIndex 只对同一次生成的选择网格有效，修改后必须重新选择",
                "局部特征记录会在参数化整模重建时按顺序安全重放；稳定面、记录中心或法线不一致时会拒绝重建",
            ],
        }
        temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_result.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        _commit_files_with_rollback(
            [
                (temporary_step, output_dir / step_file),
                (temporary_stl, output_dir / stl_file),
                (temporary_selection, output_dir / selection_mesh_file),
                (temporary_mapping, output_dir / mapping_file),
                (temporary_assembly, output_dir / assembly_file),
                (temporary_manifest, manifest_path),
                (temporary_result, output_dir / "local-cad-feature-result.json"),
            ],
            revision,
        )
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)

    print(json.dumps(result, ensure_ascii=False))
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="当前精确 CAD 输出目录")
    parser.add_argument("--operation", choices=("add-cylinder", "cut-cylinder", "add-rectangle", "cut-rectangle", "cut-slot", "offset-face-outward", "offset-face-inward", "fillet-edge", "chamfer-edge"), required=True)
    parser.add_argument("--selection-revision", required=True)
    parser.add_argument("--part-id", required=True)
    parser.add_argument("--stable-face-id", required=True)
    parser.add_argument("--stable-edge-id")
    parser.add_argument("--center-x", type=float, required=True)
    parser.add_argument("--center-y", type=float, required=True)
    parser.add_argument("--center-z", type=float, required=True)
    parser.add_argument("--normal-x", type=float, required=True)
    parser.add_argument("--normal-y", type=float, required=True)
    parser.add_argument("--normal-z", type=float, required=True)
    parser.add_argument("--surface-geometry-type", required=True)
    parser.add_argument("--surface-u", type=float, required=True)
    parser.add_argument("--surface-v", type=float, required=True)
    parser.add_argument("--radius", type=float)
    parser.add_argument("--width", type=float)
    parser.add_argument("--height", type=float)
    parser.add_argument("--length", type=float)
    parser.add_argument("--depth", type=float, required=True)
    parser.add_argument("--rotation", type=float, default=0.0)
    parser.add_argument("--command", default="")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        edit_cad_feature(
            output_dir=arguments.output,
            operation=arguments.operation,
            selection_revision=arguments.selection_revision,
            part_id=arguments.part_id,
            stable_face_id=arguments.stable_face_id,
            stable_edge_id=arguments.stable_edge_id,
            surface_geometry_type=arguments.surface_geometry_type,
            surface_uv=(arguments.surface_u, arguments.surface_v),
            center=(arguments.center_x, arguments.center_y, arguments.center_z),
            hit_normal=(arguments.normal_x, arguments.normal_y, arguments.normal_z),
            radius_mm=arguments.radius,
            width_mm=arguments.width,
            height_mm=arguments.height,
            length_mm=arguments.length,
            depth_mm=arguments.depth,
            rotation_deg=arguments.rotation,
            command=arguments.command,
        )
        return 0
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - 输出本机 OpenCascade 具体中文诊断。
        print(f"稳定 CAD 面局部特征失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
