"""通用 STL 拓扑诊断与简单平面孔洞修复。

首批能力只处理可验证的简单平面边界闭环。非流形边、分叉边界、嵌套轮廓、
明显非共面破面和无法可靠三角化的轮廓会返回中文错误，避免伪造可打印实体。
"""

from __future__ import annotations

import math
import struct
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

Point3 = tuple[float, float, float]
Point2 = tuple[float, float]
Triangle = tuple[Point3, Point3, Point3]
IndexedTriangle = tuple[int, int, int]
Edge = tuple[int, int]


@dataclass(frozen=True)
class MeshRepairReport:
    """STL 清理、拓扑检查和简单修洞的可持久化指标。"""

    attempted: bool
    repaired: bool
    input_triangle_count: int
    output_triangle_count: int
    removed_degenerate_triangles: int
    removed_duplicate_triangles: int
    boundary_edge_count_before: int
    boundary_edge_count_after: int
    non_manifold_edge_count: int
    connected_component_count: int
    repaired_hole_count: int
    added_cap_triangle_count: int


@dataclass(frozen=True)
class MeshRepairResult:
    """修复后的三角网格和诊断报告。"""

    triangles: tuple[Triangle, ...]
    report: MeshRepairReport


def _subtract(left: Point3, right: Point3) -> Point3:
    return (left[0] - right[0], left[1] - right[1], left[2] - right[2])


def _cross(left: Point3, right: Point3) -> Point3:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _dot(left: Point3, right: Point3) -> float:
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]


def _length(vector: Point3) -> float:
    return math.sqrt(_dot(vector, vector))


def _triangle_normal(triangle: Triangle) -> Point3:
    normal = _cross(_subtract(triangle[1], triangle[0]), _subtract(triangle[2], triangle[0]))
    magnitude = _length(normal)
    if magnitude == 0:
        return (0.0, 0.0, 0.0)
    return (normal[0] / magnitude, normal[1] / magnitude, normal[2] / magnitude)


def _read_binary_stl(data: bytes) -> list[Triangle] | None:
    if len(data) < 84:
        return None
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    expected_size = 84 + triangle_count * 50
    if expected_size != len(data):
        return None

    triangles: list[Triangle] = []
    offset = 84
    for _ in range(triangle_count):
        values = struct.unpack_from("<12fH", data, offset)
        triangles.append(
            (
                (float(values[3]), float(values[4]), float(values[5])),
                (float(values[6]), float(values[7]), float(values[8])),
                (float(values[9]), float(values[10]), float(values[11])),
            )
        )
        offset += 50
    return triangles


def _read_ascii_stl(data: bytes) -> list[Triangle]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = data.decode("ascii")
        except UnicodeDecodeError as error:
            raise ValueError("无法解析 STL：文件既不是有效二进制 STL，也不是 ASCII STL") from error

    vertices: list[Point3] = []
    for line in text.splitlines():
        fields = line.strip().split()
        if len(fields) != 4 or fields[0].lower() != "vertex":
            continue
        try:
            point = (float(fields[1]), float(fields[2]), float(fields[3]))
        except ValueError as error:
            raise ValueError("ASCII STL 中包含无法解析的顶点坐标") from error
        vertices.append(point)

    if not vertices or len(vertices) % 3 != 0:
        raise ValueError("ASCII STL 的三角面顶点数量不完整")
    return [tuple(vertices[index : index + 3]) for index in range(0, len(vertices), 3)]  # type: ignore[list-item]


def read_stl_triangles(input_path: Path) -> list[Triangle]:
    """读取 ASCII 或二进制 STL，并拒绝非有限坐标。"""

    data = input_path.read_bytes()
    triangles = _read_binary_stl(data)
    if triangles is None:
        triangles = _read_ascii_stl(data)
    if any(not math.isfinite(value) for triangle in triangles for point in triangle for value in point):
        raise ValueError("STL 包含无穷大或非数字坐标")
    return triangles


def _weld_vertices(
    triangles: Sequence[Triangle], tolerance_mm: float
) -> tuple[list[Point3], list[IndexedTriangle]]:
    if tolerance_mm <= 0:
        raise ValueError("顶点焊接公差必须大于 0 毫米")

    vertices: list[Point3] = []
    indexed: list[IndexedTriangle] = []
    cells: dict[tuple[int, int, int], list[int]] = defaultdict(list)
    tolerance_squared = tolerance_mm * tolerance_mm

    def vertex_index(point: Point3) -> int:
        cell = tuple(math.floor(value / tolerance_mm) for value in point)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for candidate_index in cells.get(
                        (cell[0] + dx, cell[1] + dy, cell[2] + dz), ()
                    ):
                        candidate = vertices[candidate_index]
                        distance_squared = sum(
                            (candidate[axis] - point[axis]) ** 2 for axis in range(3)
                        )
                        if distance_squared <= tolerance_squared:
                            return candidate_index
        index = len(vertices)
        vertices.append(point)
        cells[cell].append(index)
        return index

    for triangle in triangles:
        indexed.append(tuple(vertex_index(point) for point in triangle))  # type: ignore[arg-type]
    return vertices, indexed


def _clean_triangles(
    vertices: Sequence[Point3], triangles: Sequence[IndexedTriangle], area_tolerance: float
) -> tuple[list[IndexedTriangle], int, int]:
    cleaned: list[IndexedTriangle] = []
    seen: set[tuple[int, int, int]] = set()
    removed_degenerate = 0
    removed_duplicate = 0

    for triangle in triangles:
        if len(set(triangle)) < 3:
            removed_degenerate += 1
            continue
        a, b, c = (vertices[index] for index in triangle)
        doubled_area = _length(_cross(_subtract(b, a), _subtract(c, a)))
        if doubled_area <= area_tolerance:
            removed_degenerate += 1
            continue
        identity = tuple(sorted(triangle))
        if identity in seen:
            removed_duplicate += 1
            continue
        seen.add(identity)
        cleaned.append(triangle)
    return cleaned, removed_degenerate, removed_duplicate


def _edge_uses(triangles: Sequence[IndexedTriangle]) -> dict[Edge, list[tuple[int, Edge]]]:
    uses: dict[Edge, list[tuple[int, Edge]]] = defaultdict(list)
    for triangle_index, (a, b, c) in enumerate(triangles):
        for directed in ((a, b), (b, c), (c, a)):
            uses[tuple(sorted(directed))].append((triangle_index, directed))
    return uses


def _connected_component_count(
    triangle_count: int, edge_uses: dict[Edge, list[tuple[int, Edge]]]
) -> int:
    if triangle_count == 0:
        return 0
    neighbors: list[set[int]] = [set() for _ in range(triangle_count)]
    for uses in edge_uses.values():
        triangle_indexes = [item[0] for item in uses]
        for triangle_index in triangle_indexes:
            neighbors[triangle_index].update(
                candidate for candidate in triangle_indexes if candidate != triangle_index
            )

    remaining = set(range(triangle_count))
    components = 0
    while remaining:
        components += 1
        queue = deque([remaining.pop()])
        while queue:
            current = queue.popleft()
            for neighbor in neighbors[current]:
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    queue.append(neighbor)
    return components


def _boundary_loops(edge_uses: dict[Edge, list[tuple[int, Edge]]]) -> list[list[int]]:
    boundary = {edge: uses[0][1] for edge, uses in edge_uses.items() if len(uses) == 1}
    if not boundary:
        return []

    adjacency: dict[int, set[int]] = defaultdict(set)
    for left, right in boundary:
        adjacency[left].add(right)
        adjacency[right].add(left)
    branching = [vertex for vertex, neighbors in adjacency.items() if len(neighbors) != 2]
    if branching:
        raise ValueError(
            f"STL 开放边界存在分叉或断链（{len(branching)} 个异常边界顶点），当前不能自动修复"
        )

    remaining = set(boundary)
    loops: list[list[int]] = []
    while remaining:
        first_edge = min(remaining)
        existing_direction = boundary[first_edge]
        # 补面的边方向必须与相邻原三角面相反，才能保持一致外法线。
        start, next_vertex = existing_direction[1], existing_direction[0]
        loop = [start]
        previous = start
        current = next_vertex
        remaining.remove(first_edge)

        while current != start:
            if current in loop:
                raise ValueError("STL 开放边界发生自交，当前不能自动修复")
            loop.append(current)
            candidates = adjacency[current] - {previous}
            if len(candidates) != 1:
                raise ValueError("STL 开放边界无法连接成唯一闭环")
            following = next(iter(candidates))
            edge = tuple(sorted((current, following)))
            if edge not in remaining:
                raise ValueError("STL 开放边界包含重复路径或法线方向不一致")
            existing = boundary[edge]
            if existing != (following, current):
                raise ValueError("STL 边界相邻面的法线方向不一致，当前不能安全自动补面")
            remaining.remove(edge)
            previous, current = current, following

        if len(loop) < 3:
            raise ValueError("STL 开放边界顶点不足，无法生成补面")
        loops.append(loop)
    return loops


def _newell_normal(points: Sequence[Point3]) -> Point3:
    normal = [0.0, 0.0, 0.0]
    for index, current in enumerate(points):
        following = points[(index + 1) % len(points)]
        normal[0] += (current[1] - following[1]) * (current[2] + following[2])
        normal[1] += (current[2] - following[2]) * (current[0] + following[0])
        normal[2] += (current[0] - following[0]) * (current[1] + following[1])
    magnitude = _length((normal[0], normal[1], normal[2]))
    if magnitude == 0:
        raise ValueError("STL 孔洞轮廓退化为直线，无法生成补面")
    return (normal[0] / magnitude, normal[1] / magnitude, normal[2] / magnitude)


def _project_points(points: Sequence[Point3], normal: Point3) -> list[Point2]:
    dropped_axis = max(range(3), key=lambda axis: abs(normal[axis]))
    if dropped_axis == 0:
        return [(point[1], point[2]) for point in points]
    if dropped_axis == 1:
        return [(point[0], point[2]) for point in points]
    return [(point[0], point[1]) for point in points]


def _signed_area(points: Sequence[Point2]) -> float:
    return sum(
        current[0] * following[1] - following[0] * current[1]
        for current, following in zip(points, points[1:] + points[:1])
    ) / 2


def _orientation(a: Point2, b: Point2, c: Point2) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_intersect(a: Point2, b: Point2, c: Point2, d: Point2, tolerance: float) -> bool:
    orientations = (_orientation(a, b, c), _orientation(a, b, d), _orientation(c, d, a), _orientation(c, d, b))
    return (
        (orientations[0] > tolerance and orientations[1] < -tolerance)
        or (orientations[0] < -tolerance and orientations[1] > tolerance)
    ) and (
        (orientations[2] > tolerance and orientations[3] < -tolerance)
        or (orientations[2] < -tolerance and orientations[3] > tolerance)
    )


def _validate_simple_polygon(points: Sequence[Point2], tolerance: float) -> None:
    count = len(points)
    for first in range(count):
        a, b = points[first], points[(first + 1) % count]
        for second in range(first + 1, count):
            if second in (first, (first + 1) % count) or (second + 1) % count == first:
                continue
            c, d = points[second], points[(second + 1) % count]
            if _segments_intersect(a, b, c, d, tolerance):
                raise ValueError("STL 孔洞轮廓在投影平面内自交，当前不能自动修复")


def _point_in_triangle(point: Point2, a: Point2, b: Point2, c: Point2, tolerance: float) -> bool:
    signs = (_orientation(a, b, point), _orientation(b, c, point), _orientation(c, a, point))
    has_negative = any(value < -tolerance for value in signs)
    has_positive = any(value > tolerance for value in signs)
    return not (has_negative and has_positive)


def _triangulate_polygon(
    loop: Sequence[int], projected: Sequence[Point2], tolerance: float
) -> list[IndexedTriangle]:
    area = _signed_area(projected)
    if abs(area) <= tolerance:
        raise ValueError("STL 孔洞投影面积过小，无法生成稳定补面")
    orientation_sign = 1.0 if area > 0 else -1.0
    remaining = list(range(len(loop)))
    triangles: list[IndexedTriangle] = []

    while len(remaining) > 3:
        ear_found = False
        for position, current_index in enumerate(remaining):
            previous_index = remaining[position - 1]
            next_index = remaining[(position + 1) % len(remaining)]
            a, b, c = projected[previous_index], projected[current_index], projected[next_index]
            if orientation_sign * _orientation(a, b, c) <= tolerance:
                continue
            if any(
                _point_in_triangle(projected[candidate], a, b, c, tolerance)
                for candidate in remaining
                if candidate not in (previous_index, current_index, next_index)
            ):
                continue
            triangles.append((loop[previous_index], loop[current_index], loop[next_index]))
            del remaining[position]
            ear_found = True
            break
        if not ear_found:
            raise ValueError("STL 孔洞轮廓过于复杂或包含共线异常，当前不能可靠三角化")

    triangles.append(tuple(loop[index] for index in remaining))  # type: ignore[arg-type]
    return triangles


def _point_in_polygon(point: Point2, polygon: Sequence[Point2]) -> bool:
    inside = False
    previous = polygon[-1]
    for current in polygon:
        if (current[1] > point[1]) != (previous[1] > point[1]):
            crossing_x = (previous[0] - current[0]) * (point[1] - current[1]) / (
                previous[1] - current[1]
            ) + current[0]
            if point[0] < crossing_x:
                inside = not inside
        previous = current
    return inside


def _reject_nested_coplanar_loops(
    loops: Sequence[Sequence[int]], vertices: Sequence[Point3], planarity_tolerance: float
) -> None:
    loop_geometry: list[tuple[Point3, float, list[Point2]]] = []
    for loop in loops:
        points = [vertices[index] for index in loop]
        normal = _newell_normal(points)
        plane_offset = _dot(normal, points[0])
        loop_geometry.append((normal, plane_offset, _project_points(points, normal)))

    for first in range(len(loop_geometry)):
        normal_a, offset_a, polygon_a = loop_geometry[first]
        for second in range(first + 1, len(loop_geometry)):
            normal_b, offset_b, polygon_b = loop_geometry[second]
            parallel = abs(abs(_dot(normal_a, normal_b)) - 1.0) <= 1e-5
            if not parallel:
                continue
            signed_offset_b = offset_b if _dot(normal_a, normal_b) >= 0 else -offset_b
            if abs(offset_a - signed_offset_b) > planarity_tolerance:
                continue
            points_b = [vertices[index] for index in loops[second]]
            projected_b_in_a = _project_points(points_b, normal_a)
            if _point_in_polygon(projected_b_in_a[0], polygon_a) or _point_in_polygon(
                polygon_a[0], projected_b_in_a
            ):
                raise ValueError("STL 开放区域包含嵌套孔洞轮廓，当前不能作为独立平面孔自动补面")


def repair_stl_mesh(
    input_path: Path,
    output_path: Path | None = None,
    weld_tolerance_mm: float = 1e-5,
    max_hole_vertices: int = 256,
) -> MeshRepairResult:
    """诊断 STL，并自动补齐独立、简单、近似共面的开放孔洞。"""

    input_triangles = read_stl_triangles(input_path)
    if len(input_triangles) < 4:
        raise ValueError("STL 三角面数量不足，无法形成封闭实体")

    vertices, indexed = _weld_vertices(input_triangles, weld_tolerance_mm)
    coordinate_scale = max((abs(value) for point in vertices for value in point), default=1.0)
    area_tolerance = max(weld_tolerance_mm * weld_tolerance_mm, coordinate_scale**2 * 1e-18)
    cleaned, removed_degenerate, removed_duplicate = _clean_triangles(
        vertices, indexed, area_tolerance
    )
    if len(cleaned) < 4:
        raise ValueError("STL 清理退化或重复三角面后数量不足，无法形成封闭实体")

    edge_uses = _edge_uses(cleaned)
    non_manifold_edges = [edge for edge, uses in edge_uses.items() if len(uses) > 2]
    if non_manifold_edges:
        raise ValueError(
            f"STL 包含 {len(non_manifold_edges)} 条非流形边；当前不会自动猜测拓扑，请先修复后再导入"
        )

    boundary_before = sum(1 for uses in edge_uses.values() if len(uses) == 1)
    component_count = _connected_component_count(len(cleaned), edge_uses)
    loops = _boundary_loops(edge_uses)
    added_triangles: list[IndexedTriangle] = []

    if loops:
        bounds = [
            max(point[axis] for point in vertices) - min(point[axis] for point in vertices)
            for axis in range(3)
        ]
        diagonal = math.sqrt(sum(value * value for value in bounds))
        planarity_tolerance = max(weld_tolerance_mm * 10, diagonal * 1e-6, 1e-6)
        _reject_nested_coplanar_loops(loops, vertices, planarity_tolerance)

        for loop in loops:
            if len(loop) > max_hole_vertices:
                raise ValueError(
                    f"STL 孔洞轮廓包含 {len(loop)} 个顶点，超过当前自动修复上限 {max_hole_vertices}"
                )
            points = [vertices[index] for index in loop]
            normal = _newell_normal(points)
            plane_origin = points[0]
            maximum_distance = max(
                abs(_dot(normal, _subtract(point, plane_origin))) for point in points
            )
            if maximum_distance > planarity_tolerance:
                raise ValueError(
                    f"STL 孔洞轮廓不共面（最大偏差 {maximum_distance:.6f} 毫米），当前不能自动补面"
                )
            projected = _project_points(points, normal)
            polygon_tolerance = max(planarity_tolerance**2, 1e-12)
            _validate_simple_polygon(projected, polygon_tolerance)
            added_triangles.extend(_triangulate_polygon(loop, projected, polygon_tolerance))

    repaired_indexed = [*cleaned, *added_triangles]
    repaired_edge_uses = _edge_uses(repaired_indexed)
    boundary_after = sum(1 for uses in repaired_edge_uses.values() if len(uses) == 1)
    non_manifold_after = sum(1 for uses in repaired_edge_uses.values() if len(uses) > 2)
    if boundary_after or non_manifold_after:
        raise ValueError(
            f"STL 简单孔洞修复后仍有 {boundary_after} 条开放边、{non_manifold_after} 条非流形边，已停止导入"
        )

    output_triangles = tuple(
        tuple(vertices[index] for index in triangle) for triangle in repaired_indexed
    )
    changed = bool(removed_degenerate or removed_duplicate or added_triangles)
    report = MeshRepairReport(
        attempted=True,
        repaired=changed,
        input_triangle_count=len(input_triangles),
        output_triangle_count=len(output_triangles),
        removed_degenerate_triangles=removed_degenerate,
        removed_duplicate_triangles=removed_duplicate,
        boundary_edge_count_before=boundary_before,
        boundary_edge_count_after=boundary_after,
        non_manifold_edge_count=0,
        connected_component_count=component_count,
        repaired_hole_count=len(loops),
        added_cap_triangle_count=len(added_triangles),
    )
    if output_path is not None and changed:
        write_ascii_stl(output_path, output_triangles, solid_name="FormAI_Repaired_Model")
    return MeshRepairResult(output_triangles, report)


def write_ascii_stl(output_path: Path, triangles: Iterable[Triangle], solid_name: str) -> None:
    """写出不依赖原始文件名的安全 ASCII STL 工作副本。"""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(
        character if character.isascii() and (character.isalnum() or character in "_-") else "_"
        for character in solid_name
    ).strip("_") or "FormAI_Model"
    lines = [f"solid {safe_name}"]
    for triangle in triangles:
        normal = _triangle_normal(triangle)
        lines.append(f"  facet normal {normal[0]:.12g} {normal[1]:.12g} {normal[2]:.12g}")
        lines.append("    outer loop")
        for point in triangle:
            lines.append(f"      vertex {point[0]:.12g} {point[1]:.12g} {point[2]:.12g}")
        lines.extend(("    endloop", "  endfacet"))
    lines.append(f"endsolid {safe_name}")
    output_path.write_text("\n".join(lines) + "\n", encoding="ascii")


def repair_report_json(report: MeshRepairReport) -> dict[str, bool | int]:
    """将诊断报告转换为前端协议使用的驼峰字段。"""

    return {
        "attempted": report.attempted,
        "repaired": report.repaired,
        "inputTriangleCount": report.input_triangle_count,
        "outputTriangleCount": report.output_triangle_count,
        "removedDegenerateTriangleCount": report.removed_degenerate_triangles,
        "removedDuplicateTriangleCount": report.removed_duplicate_triangles,
        "boundaryEdgeCountBefore": report.boundary_edge_count_before,
        "boundaryEdgeCountAfter": report.boundary_edge_count_after,
        "nonManifoldEdgeCount": report.non_manifold_edge_count,
        "connectedComponentCount": report.connected_component_count,
        "repairedHoleCount": report.repaired_hole_count,
        "addedTriangleCount": report.added_cap_triangle_count,
    }
