import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from export_transformed_model import export_request, read_stl, write_binary_stl


class ExportTransformedModelTest(unittest.TestCase):
    def request(self, output_name="result.stl", export_format="stl"):
        return {
            "outputFileName": output_name,
            "format": export_format,
            "objects": [{
                "id": "part",
                "name": "测试零件",
                "sourceFile": "source.stl",
                "color": "#123456",
                "transform": {
                    "positionMm": {"x": 3, "y": 4, "z": 5},
                    "rotationDeg": {"x": 0, "y": 0, "z": 90},
                    "scale": 2,
                },
                "basePositionDisplayMm": {"x": 0, "y": 10, "z": 0},
            }],
        }

    def prepare(self, directory):
        triangle = (((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),)
        write_binary_stl(directory / "source.stl", triangle)

    def test_stl_bakes_display_transform_into_source_coordinates(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            self.prepare(directory)
            result = export_request(self.request(), directory)
            self.assertEqual(result["triangleCount"], 1)
            first = read_stl(directory / "result.stl")[0][0]
            self.assertAlmostEqual(first[0], 3)
            self.assertAlmostEqual(first[1], -5)
            self.assertAlmostEqual(first[2], 16)

    def test_3mf_contains_colored_named_object(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            self.prepare(directory)
            export_request(self.request("result.3mf", "3mf"), directory)
            with zipfile.ZipFile(directory / "result.3mf") as archive:
                model = archive.read("3D/3dmodel.model").decode("utf-8")
            self.assertIn("测试零件", model)
            self.assertIn("#123456FF", model)
            self.assertIn('unit="millimeter"', model)

    def test_rejects_parent_path(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            self.prepare(directory)
            request = self.request("../escape.stl")
            with self.assertRaisesRegex(ValueError, "文件名不合法"):
                export_request(request, directory)


if __name__ == "__main__":
    unittest.main()
