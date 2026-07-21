"""为 OpenCascade 实体生成面几何签名，并执行跨重建近似匹配。

这是“几何签名匹配第一版”：它使用曲面类型、归一化位置、包围盒、面积比例、
法向和边拓扑摘要做一对一近似匹配。它不能保证任意拓扑修改下的面 ID 完全稳定。
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from typing import Any, Iterable

import cadquery as cq

MATCH_METHOD = "几何签名匹配第一版"
MATCH_WARNING = (
    "稳定 ID 基于几何签名近似继承；大幅拓扑变化、对称面或布尔重建可能导致重新编号，"
    "不能视为 OpenCascade 原生永久拓扑命名。"
)
_MATCH_THRESHOLD = 0.34
_EDGE_MATCH_THRESHOLD = 0.28
_EPSILON = 1e-9


def _rounded(value: float, digits: int = 6) -> float:
    rounded = round(float(value), digits)
    return 0.0 if abs(rounded) < 10 ** (-digits) else rounded


def _vector_tuple(vector: cq.Vector) -> tuple[float, float, float]:
    return (float(vector.x), float(vector.y), float(vector.z))


def _normalized_vector(values: Iterable[float]) -> list[float] | None:
    vector = tuple(float(value) for value in values)
    length = math.sqrt(sum(value * value for value in vector))
    if not math.isfinite(length) or length <= _EPSILON:
        return None
    return [_rounded(value / length) for value in vector]


def _normalized_axis(value: float, center: float, length: float) -> float:
    return _rounded((value - center) / max(length, _EPSILON))


def _normalized_length(value: float, length: float) -> float:
    return _rounded(value / max(length, _EPSILON))


def _edge_geometry_summary(face: cq.Face) -> dict[str, int]:
    return dict(sorted(Counter(edge.geomType() for edge in face.Edges()).items()))


def _edge_signature_payload(descriptor: dict[str, Any]) -> dict[str, Any]:
    """生成仅在所属稳定面内使用的尺度归一化边签名。"""
    return {
        "geometryType": descriptor["geometryType"],
        "normalizedCenter": [_rounded(value, 4) for value in descriptor["normalizedCenter"]],
        "normalizedLength": _rounded(descriptor["normalizedLength"], 5),
        "normalizedEndpoints": [
            [_rounded(value, 4) for value in point]
            for point in descriptor["normalizedEndpoints"]
        ],
    }


def _edge_fingerprint(descriptor: dict[str, Any]) -> str:
    payload = json.dumps(
        _edge_signature_payload(descriptor),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _describe_face_edges(
    face: cq.Face,
    part_center: tuple[float, float, float],
    part_lengths: tuple[float, float, float],
) -> list[dict[str, Any]]:
    diagonal = math.sqrt(sum(max(length, _EPSILON) ** 2 for length in part_lengths))
    descriptors: list[dict[str, Any]] = []
    for edge in face.Edges():
        center = _vector_tuple(edge.Center())
        endpoints = sorted((_vector_tuple(edge.startPoint()), _vector_tuple(edge.endPoint())))
        samples = [_vector_tuple(edge.positionAt(index / 8)) for index in range(9)]
        descriptor: dict[str, Any] = {
            "geometryType": edge.geomType(),
            "lengthMm": _rounded(edge.Length()),
            "centerMm": [_rounded(value) for value in center],
            "startMm": [_rounded(value) for value in endpoints[0]],
            "endMm": [_rounded(value) for value in endpoints[1]],
            "samplePointsMm": [
                [_rounded(value) for value in point]
                for point in samples
            ],
            "normalizedCenter": [
                _normalized_axis(value, axis_center, axis_length)
                for value, axis_center, axis_length in zip(
                    center, part_center, part_lengths, strict=True
                )
            ],
            "normalizedLength": _rounded(edge.Length() / max(diagonal, _EPSILON)),
            "normalizedEndpoints": sorted([
                [
                    _normalized_axis(value, axis_center, axis_length)
                    for value, axis_center, axis_length in zip(
                        point, part_center, part_lengths, strict=True
                    )
                ]
                for point in endpoints
            ]),
        }
        descriptor["fingerprint"] = _edge_fingerprint(descriptor)
        descriptors.append(descriptor)
    descriptors.sort(
        key=lambda value: (
            value["geometryType"],
            tuple(value["normalizedCenter"]),
            value["normalizedLength"],
            value["fingerprint"],
        )
    )
    return descriptors


def _face_signature_payload(descriptor: dict[str, Any]) -> dict[str, Any]:
    """只使用尺度归一化特征，避免简单整体缩放造成全部 fingerprint 失效。"""
    return {
        "geometryType": descriptor["geometryType"],
        "normalizedCenter": [_rounded(value, 4) for value in descriptor["normalizedCenter"]],
        "normalizedBounds": [_rounded(value, 4) for value in descriptor["normalizedBounds"]],
        "areaRatio": _rounded(descriptor["areaRatio"], 5),
        "normal": descriptor.get("normal"),
        "edgeCount": descriptor["edgeCount"],
        "edgeGeometryTypes": descriptor["edgeGeometryTypes"],
    }


def _fingerprint(descriptor: dict[str, Any]) -> str:
    payload = json.dumps(
        _face_signature_payload(descriptor),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _describe_shape_faces_with_sources(
    model: cq.Workplane | cq.Shape,
) -> list[tuple[cq.Face, dict[str, Any]]]:
    """返回按几何签名顺序排列的 OpenCascade 面及其描述。"""
    shape = model.val() if isinstance(model, cq.Workplane) else model
    bounds = shape.BoundingBox()
    part_center = (
        (bounds.xmin + bounds.xmax) / 2,
        (bounds.ymin + bounds.ymax) / 2,
        (bounds.zmin + bounds.zmax) / 2,
    )
    part_lengths = (bounds.xlen, bounds.ylen, bounds.zlen)
    faces = list(shape.Faces())
    total_area = sum(max(float(face.Area()), 0.0) for face in faces)
    described_faces: list[tuple[cq.Face, dict[str, Any]]] = []

    for face in faces:
        face_bounds = face.BoundingBox()
        center = _vector_tuple(face.Center())
        normal = None
        try:
            normal = _normalized_vector(_vector_tuple(face.normalAt()))
        except Exception:
            normal = None
        area = max(float(face.Area()), 0.0)
        descriptor: dict[str, Any] = {
            "geometryType": face.geomType(),
            "areaMm2": _rounded(area),
            "centerMm": [_rounded(value) for value in center],
            "boundsMm": {
                "x": _rounded(face_bounds.xlen),
                "y": _rounded(face_bounds.ylen),
                "z": _rounded(face_bounds.zlen),
            },
            "normalizedCenter": [
                _normalized_axis(value, axis_center, axis_length)
                for value, axis_center, axis_length in zip(
                    center, part_center, part_lengths, strict=True
                )
            ],
            "normalizedBounds": [
                _normalized_length(value, axis_length)
                for value, axis_length in zip(
                    (face_bounds.xlen, face_bounds.ylen, face_bounds.zlen),
                    part_lengths,
                    strict=True,
                )
            ],
            "areaRatio": _rounded(area / max(total_area, _EPSILON)),
            "edgeCount": len(face.Edges()),
            "edgeGeometryTypes": _edge_geometry_summary(face),
            "edges": _describe_face_edges(face, part_center, part_lengths),
        }
        if normal is not None:
            descriptor["normal"] = normal
        descriptor["fingerprint"] = _fingerprint(descriptor)
        described_faces.append((face, descriptor))

    described_faces.sort(
        key=lambda value: (
            value[1]["geometryType"],
            tuple(value[1]["normalizedCenter"]),
            tuple(value[1]["normalizedBounds"]),
            value[1]["areaRatio"],
            value[1]["fingerprint"],
        )
    )
    return described_faces


def describe_shape_faces(model: cq.Workplane | cq.Shape) -> list[dict[str, Any]]:
    """返回不含稳定 ID 的通用面描述，单位为毫米。"""
    return [descriptor for _, descriptor in _describe_shape_faces_with_sources(model)]


def _matched_face_descriptors(
    current: list[dict[str, Any]],
    previous_faces: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """为已经排序的当前面描述继承或创建稳定 ID。"""
    previous = _valid_previous_faces(previous_faces)
    used_previous_indexes: set[int] = set()
    used_ids = {str(face["stableId"]) for face in previous}
    assignments: dict[int, tuple[int, float]] = {}

    exact_candidates: list[tuple[int, int]] = []
    previous_by_fingerprint: dict[str, list[int]] = {}
    for previous_index, face in enumerate(previous):
        fingerprint = face.get("fingerprint")
        if isinstance(fingerprint, str):
            previous_by_fingerprint.setdefault(fingerprint, []).append(previous_index)
    for current_index, face in enumerate(current):
        candidates = previous_by_fingerprint.get(face["fingerprint"], [])
        if len(candidates) == 1:
            exact_candidates.append((current_index, candidates[0]))
    for current_index, previous_index in exact_candidates:
        if previous_index in used_previous_indexes:
            continue
        assignments[current_index] = (previous_index, 0.0)
        used_previous_indexes.add(previous_index)

    candidates: list[tuple[float, int, int]] = []
    for current_index, current_face in enumerate(current):
        if current_index in assignments:
            continue
        for previous_index, previous_face in enumerate(previous):
            if previous_index in used_previous_indexes:
                continue
            cost = face_match_cost(current_face, previous_face)
            if math.isfinite(cost) and cost <= _MATCH_THRESHOLD:
                candidates.append((cost, current_index, previous_index))
    for cost, current_index, previous_index in sorted(candidates):
        if current_index in assignments or previous_index in used_previous_indexes:
            continue
        assignments[current_index] = (previous_index, cost)
        used_previous_indexes.add(previous_index)

    inherited_confidences: list[float] = []
    result: list[dict[str, Any]] = []
    for current_index, face in enumerate(current):
        descriptor = dict(face)
        assignment = assignments.get(current_index)
        if assignment is not None:
            previous_index, cost = assignment
            descriptor["stableId"] = previous[previous_index]["stableId"]
            descriptor["matchSource"] = "inherited"
            descriptor["matchConfidence"] = _rounded(max(0.0, 1.0 - cost), 4)
            descriptor["matchedPreviousFingerprint"] = previous[previous_index].get("fingerprint")
            descriptor["edges"] = _matched_edge_descriptors(
                descriptor.get("edges"), previous[previous_index].get("edges")
            )
            inherited_confidences.append(descriptor["matchConfidence"])
        else:
            descriptor["stableId"] = _new_stable_id(descriptor["fingerprint"], used_ids)
            descriptor["matchSource"] = "new"
            descriptor["matchConfidence"] = 1.0 if not previous else 0.0
            descriptor["edges"] = _matched_edge_descriptors(descriptor.get("edges"), None)
        result.append(descriptor)

    inherited_count = len(assignments)
    summary = {
        "method": MATCH_METHOD,
        "previousFaceCount": len(previous),
        "currentFaceCount": len(result),
        "inheritedFaceCount": inherited_count,
        "newFaceCount": len(result) - inherited_count,
        "disappearedFaceCount": len(previous) - inherited_count,
        "averageInheritedConfidence": (
            _rounded(sum(inherited_confidences) / len(inherited_confidences), 4)
            if inherited_confidences
            else None
        ),
        "matchThreshold": _MATCH_THRESHOLD,
        "warning": MATCH_WARNING,
    }
    return result, summary


def match_shape_faces_with_sources(
    model: cq.Workplane | cq.Shape,
    previous_faces: Any = None,
) -> tuple[list[tuple[cq.Face, dict[str, Any]]], dict[str, Any]]:
    """生成稳定面描述，并保留每个描述对应的 OpenCascade 面对象。"""
    described_faces = _describe_shape_faces_with_sources(model)
    matched, summary = _matched_face_descriptors(
        [descriptor for _, descriptor in described_faces],
        previous_faces,
    )
    paired = [
        (face, descriptor)
        for (face, _), descriptor in zip(described_faces, matched, strict=True)
    ]
    paired.sort(key=lambda value: value[1]["stableId"])
    return paired, summary


def _vector_distance(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        return 1.0
    return min(
        math.sqrt(sum((float(a) - float(b)) ** 2 for a, b in zip(left, right, strict=True)))
        / math.sqrt(max(len(left), 1)),
        1.0,
    )


def _edge_match_cost(current: dict[str, Any], previous: dict[str, Any]) -> float:
    if current.get("geometryType") != previous.get("geometryType"):
        return math.inf
    center_cost = _vector_distance(
        current.get("normalizedCenter", []), previous.get("normalizedCenter", [])
    )
    current_length = max(float(current.get("normalizedLength", 0.0)), _EPSILON)
    previous_length = max(float(previous.get("normalizedLength", 0.0)), _EPSILON)
    length_cost = min(abs(math.log(current_length / previous_length)) / 1.2, 1.0)
    current_endpoints = current.get("normalizedEndpoints", [])
    previous_endpoints = previous.get("normalizedEndpoints", [])
    endpoint_cost = 1.0
    if len(current_endpoints) == 2 and len(previous_endpoints) == 2:
        endpoint_cost = (
            _vector_distance(current_endpoints[0], previous_endpoints[0])
            + _vector_distance(current_endpoints[1], previous_endpoints[1])
        ) / 2
    return 0.5 * center_cost + 0.25 * length_cost + 0.25 * endpoint_cost


def _matched_edge_descriptors(current_edges: Any, previous_edges: Any) -> list[dict[str, Any]]:
    """在同一个稳定面内部继承边 ID；这是几何签名匹配第一版的一部分。"""
    current = [dict(value) for value in current_edges if isinstance(value, dict)] \
        if isinstance(current_edges, list) else []
    previous = [value for value in previous_edges if isinstance(value, dict)] \
        if isinstance(previous_edges, list) else []
    used_previous: set[int] = set()
    assignments: dict[int, int] = {}
    by_fingerprint: dict[str, list[int]] = {}
    for index, edge in enumerate(previous):
        fingerprint = edge.get("fingerprint")
        if isinstance(fingerprint, str):
            by_fingerprint.setdefault(fingerprint, []).append(index)
    for current_index, edge in enumerate(current):
        candidates = by_fingerprint.get(str(edge.get("fingerprint", "")), [])
        if len(candidates) == 1 and candidates[0] not in used_previous:
            assignments[current_index] = candidates[0]
            used_previous.add(candidates[0])
    candidates: list[tuple[float, int, int]] = []
    for current_index, edge in enumerate(current):
        if current_index in assignments:
            continue
        for previous_index, previous_edge in enumerate(previous):
            if previous_index in used_previous:
                continue
            cost = _edge_match_cost(edge, previous_edge)
            if math.isfinite(cost) and cost <= _EDGE_MATCH_THRESHOLD:
                candidates.append((cost, current_index, previous_index))
    for _, current_index, previous_index in sorted(candidates):
        if current_index in assignments or previous_index in used_previous:
            continue
        assignments[current_index] = previous_index
        used_previous.add(previous_index)

    used_ids = {
        str(edge.get("stableId")) for edge in previous
        if isinstance(edge.get("stableId"), str)
    }
    for current_index, edge in enumerate(current):
        previous_index = assignments.get(current_index)
        if previous_index is not None and isinstance(previous[previous_index].get("stableId"), str):
            edge["stableId"] = previous[previous_index]["stableId"]
            edge["matchSource"] = "inherited"
        else:
            edge["stableId"] = _new_scoped_stable_id("edge", edge["fingerprint"], used_ids)
            edge["matchSource"] = "new"
    return sorted(current, key=lambda value: value["stableId"])


def _area_cost(current: dict[str, Any], previous: dict[str, Any]) -> float:
    current_ratio = max(float(current.get("areaRatio", 0.0)), _EPSILON)
    previous_ratio = max(float(previous.get("areaRatio", 0.0)), _EPSILON)
    return min(abs(math.log(current_ratio / previous_ratio)) / 1.5, 1.0)


def _normal_cost(current: dict[str, Any], previous: dict[str, Any]) -> float:
    current_normal = current.get("normal")
    previous_normal = previous.get("normal")
    if not isinstance(current_normal, list) or not isinstance(previous_normal, list):
        return 0.25
    if len(current_normal) != 3 or len(previous_normal) != 3:
        return 0.25
    dot = sum(float(a) * float(b) for a, b in zip(current_normal, previous_normal, strict=True))
    return min(max((1 - dot) / 2, 0.0), 1.0)


def _edge_summary_cost(current: dict[str, Any], previous: dict[str, Any]) -> float:
    current_edges = current.get("edgeGeometryTypes")
    previous_edges = previous.get("edgeGeometryTypes")
    if not isinstance(current_edges, dict) or not isinstance(previous_edges, dict):
        return 0.5
    keys = set(current_edges) | set(previous_edges)
    difference = sum(abs(int(current_edges.get(key, 0)) - int(previous_edges.get(key, 0))) for key in keys)
    total = max(
        sum(int(value) for value in current_edges.values()),
        sum(int(value) for value in previous_edges.values()),
        1,
    )
    return min(difference / total, 1.0)


def face_match_cost(current: dict[str, Any], previous: dict[str, Any]) -> float:
    """返回 0–1 的近似匹配代价；曲面类型不同时不可匹配。"""
    if current.get("geometryType") != previous.get("geometryType"):
        return math.inf
    center_cost = _vector_distance(
        current.get("normalizedCenter", []), previous.get("normalizedCenter", [])
    )
    bounds_cost = _vector_distance(
        current.get("normalizedBounds", []), previous.get("normalizedBounds", [])
    )
    current_edge_count = max(int(current.get("edgeCount", 0)), 0)
    previous_edge_count = max(int(previous.get("edgeCount", 0)), 0)
    edge_count_cost = min(
        abs(current_edge_count - previous_edge_count) / max(current_edge_count, previous_edge_count, 1),
        1.0,
    )
    normal_weight = 0.12 if current.get("geometryType") == "PLANE" else 0.04
    remaining_normal_weight = 0.12 - normal_weight
    return (
        0.42 * center_cost
        + (0.18 + remaining_normal_weight) * bounds_cost
        + 0.18 * _area_cost(current, previous)
        + normal_weight * _normal_cost(current, previous)
        + 0.05 * edge_count_cost
        + 0.05 * _edge_summary_cost(current, previous)
    )


def _valid_previous_faces(previous_faces: Any) -> list[dict[str, Any]]:
    if not isinstance(previous_faces, list):
        return []
    valid: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for value in previous_faces:
        if not isinstance(value, dict):
            continue
        stable_id = value.get("stableId")
        geometry_type = value.get("geometryType")
        if not isinstance(stable_id, str) or not stable_id.strip() or stable_id in seen_ids:
            continue
        if not isinstance(geometry_type, str) or not geometry_type:
            continue
        seen_ids.add(stable_id)
        valid.append(value)
    return valid


def _new_stable_id(fingerprint: str, used_ids: set[str]) -> str:
    return _new_scoped_stable_id("face", fingerprint, used_ids)


def _new_scoped_stable_id(prefix: str, fingerprint: str, used_ids: set[str]) -> str:
    base = f"{prefix}-{fingerprint[:12]}"
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def match_shape_faces(
    model: cq.Workplane | cq.Shape,
    previous_faces: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """生成当前面描述，并从上一版近似继承稳定 ID。"""
    paired, summary = match_shape_faces_with_sources(model, previous_faces)
    return [descriptor for _, descriptor in paired], summary
