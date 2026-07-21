#!/usr/bin/env python3
"""安全地把视口对象变换烘焙到 STL 或带对象颜色的标准 3MF。"""
from __future__ import annotations

import argparse
import json
import math
import re
import struct
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

SAFE_STL = re.compile(r"^[A-Za-z0-9_.-]{1,160}\.stl$", re.I)
SAFE_OUTPUT = re.compile(r"^[A-Za-z0-9_.\-\u4e00-\u9fff]{1,120}\.(stl|3mf)$", re.I)
MAX_TRIANGLES = 5_000_000


def _finite(value, name: str) -> float:
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name} 必须是有限数值")
    return value


def read_stl(path: Path) -> list[tuple[tuple[float, float, float], ...]]:
    data = path.read_bytes()
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if count <= MAX_TRIANGLES and 84 + count * 50 == len(data):
            triangles = []
            offset = 84
            for _ in range(count):
                values = struct.unpack_from("<12fH", data, offset)
                triangles.append((values[3:6], values[6:9], values[9:12]))
                offset += 50
            return triangles
    text = data.decode("utf-8", errors="strict")
    vertices = [tuple(map(float, match)) for match in re.findall(
        r"\bvertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)", text
    )]
    if not vertices or len(vertices) % 3:
        raise ValueError(f"无法解析 STL：{path.name}")
    if len(vertices) // 3 > MAX_TRIANGLES:
        raise ValueError("STL 三角面数量超过安全上限")
    return [tuple(vertices[index:index + 3]) for index in range(0, len(vertices), 3)]


def _normal(triangle):
    a, b, c = triangle
    ab = (b[0]-a[0], b[1]-a[1], b[2]-a[2])
    ac = (c[0]-a[0], c[1]-a[1], c[2]-a[2])
    n = (ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0])
    length = math.sqrt(sum(value * value for value in n))
    return (0.0, 0.0, 0.0) if length < 1e-12 else tuple(value / length for value in n)


def transform_point(point, transform, base):
    # OpenCascade Z 向上 -> Three.js 显示坐标 (x, z, -y)。
    x, y, z = point[0], point[2], -point[1]
    scale = _finite(transform["scale"], "缩放")
    x, y, z = x * scale, y * scale, z * scale
    rotation = transform["rotationDeg"]
    rx, ry, rz = (_finite(rotation[key], f"旋转 {key}") * math.pi / 180 for key in ("x", "y", "z"))
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    y, z = y * cx - z * sx, y * sx + z * cx
    x, z = x * cy + z * sy, -x * sy + z * cy
    x, y = x * cz - y * sz, x * sz + y * cz
    position = transform["positionMm"]
    x += _finite(position["x"], "位置 x") + _finite(base.get("x", 0), "基础位置 x")
    y += _finite(position["y"], "位置 y") + _finite(base.get("y", 0), "基础位置 y")
    z += _finite(position["z"], "位置 z") + _finite(base.get("z", 0), "基础位置 z")
    # 显示坐标 -> OpenCascade Z 向上。
    return (x, -z, y)


def transformed_objects(request: dict, artifacts: Path):
    objects = request.get("objects")
    if not isinstance(objects, list) or not 1 <= len(objects) <= 64:
        raise ValueError("导出对象数量必须在 1 到 64 之间")
    result = []
    total = 0
    for item in objects:
        source_name = item.get("sourceFile", "")
        if not SAFE_STL.fullmatch(source_name) or Path(source_name).name != source_name:
            raise ValueError("源 STL 文件名不合法")
        source = artifacts / source_name
        if not source.is_file():
            raise ValueError(f"找不到源 STL：{source_name}")
        color = str(item.get("color", "")).lower()
        if not re.fullmatch(r"#[0-9a-f]{6}", color):
            raise ValueError("对象颜色必须使用 #RRGGBB")
        transform = item.get("transform") or {}
        scale = _finite(transform.get("scale", 1), "缩放")
        if not 0.05 <= scale <= 20:
            raise ValueError("缩放必须在 0.05 到 20 之间")
        transform.setdefault("positionMm", {"x": 0, "y": 0, "z": 0})
        transform.setdefault("rotationDeg", {"x": 0, "y": 0, "z": 0})
        triangles = read_stl(source)
        total += len(triangles)
        if total > MAX_TRIANGLES:
            raise ValueError("导出总三角面数量超过安全上限")
        base = item.get("basePositionDisplayMm") or {}
        triangles = [tuple(transform_point(point, transform, base) for point in triangle) for triangle in triangles]
        result.append({"id": str(item.get("id", "")), "name": str(item.get("name", "零件"))[:120], "color": color, "triangles": triangles})
    return result


def write_binary_stl(path: Path, triangles) -> None:
    with path.open("wb") as stream:
        stream.write("FormAI 变换后 STL".encode("utf-8")[:80].ljust(80, b"\0"))
        stream.write(struct.pack("<I", len(triangles)))
        for triangle in triangles:
            normal = _normal(triangle)
            stream.write(struct.pack("<12fH", *normal, *triangle[0], *triangle[1], *triangle[2], 0))


def write_3mf(path: Path, objects) -> None:
    ns = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
    ET.register_namespace("", ns)
    model = ET.Element(f"{{{ns}}}model", {"unit": "millimeter", "xml:lang": "zh-CN"})
    resources = ET.SubElement(model, f"{{{ns}}}resources")
    materials = ET.SubElement(resources, f"{{{ns}}}basematerials", {"id": "1"})
    for item in objects:
        ET.SubElement(materials, f"{{{ns}}}base", {"name": item["name"], "displaycolor": item["color"].upper() + "FF"})
    build = ET.SubElement(model, f"{{{ns}}}build")
    for index, item in enumerate(objects, 1):
        obj = ET.SubElement(resources, f"{{{ns}}}object", {"id": str(index), "name": item["name"], "type": "model", "pid": "1", "pindex": str(index - 1)})
        mesh = ET.SubElement(obj, f"{{{ns}}}mesh")
        vertices = ET.SubElement(mesh, f"{{{ns}}}vertices")
        triangle_nodes = ET.SubElement(mesh, f"{{{ns}}}triangles")
        vertex_index = 0
        for triangle in item["triangles"]:
            for x, y, z in triangle:
                ET.SubElement(vertices, f"{{{ns}}}vertex", {"x": f"{x:.9g}", "y": f"{y:.9g}", "z": f"{z:.9g}"})
            ET.SubElement(triangle_nodes, f"{{{ns}}}triangle", {"v1": str(vertex_index), "v2": str(vertex_index + 1), "v3": str(vertex_index + 2)})
            vertex_index += 3
        ET.SubElement(build, f"{{{ns}}}item", {"objectid": str(index)})
    content_types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
    rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("3D/3dmodel.model", ET.tostring(model, encoding="utf-8", xml_declaration=True))


def export_request(request: dict, artifacts: Path) -> dict:
    output_name = str(request.get("outputFileName", ""))
    export_format = str(request.get("format", "")).lower()
    if not SAFE_OUTPUT.fullmatch(output_name) or Path(output_name).name != output_name:
        raise ValueError("导出文件名不合法")
    if export_format not in {"stl", "3mf"} or not output_name.lower().endswith("." + export_format):
        raise ValueError("导出格式与文件扩展名不一致")
    objects = transformed_objects(request, artifacts)
    if export_format == "stl" and len(objects) != 1:
        raise ValueError("STL 一次只能导出一个对象")
    artifacts.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=artifacts, suffix="." + export_format, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        if export_format == "stl":
            write_binary_stl(temporary_path, objects[0]["triangles"])
            read_stl(temporary_path)
        else:
            write_3mf(temporary_path, objects)
            with zipfile.ZipFile(temporary_path) as archive:
                if "3D/3dmodel.model" not in archive.namelist():
                    raise ValueError("3MF 验证失败")
        destination = artifacts / output_name
        temporary_path.replace(destination)
    finally:
        temporary_path.unlink(missing_ok=True)
    return {"status": "ok", "fileName": output_name, "objectCount": len(objects), "triangleCount": sum(len(item["triangles"]) for item in objects), "bytes": (artifacts / output_name).stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin)
        print(json.dumps(export_request(request, Path(args.output).resolve()), ensure_ascii=False))
    except Exception as error:
        print(f"变换导出失败：{error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
