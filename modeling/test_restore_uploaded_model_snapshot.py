"""上传模型版本快照恢复回归测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq
from cadquery import exporters

from edit_mesh_element import edit_mesh_element
from restore_uploaded_model_snapshot import restore_uploaded_model_snapshot
from split_and_cap import inspect_stl_file


class UploadedModelSnapshotRestoreTests(unittest.TestCase):
    def _create_uploaded_model(self, root: Path, size: tuple[float, float, float]) -> dict[str, object]:
        source = root / "imported-model.stl"
        exporters.export(cq.Workplane("XY").box(*size, centered=(False, False, False)), str(source))
        return inspect_stl_file(source, root, original_file_name="任意上传模型.stl")

    def _create_snapshot(self, root: Path, manifest: dict[str, object]) -> Path:
        snapshot = root / "versions" / "100-上传模型"
        snapshot.mkdir(parents=True)
        (snapshot / "version.json").write_text(
            json.dumps({"modelSource": "uploaded-stl", "modelRevision": manifest["revision"]}),
            encoding="utf-8",
        )
        for file_name in (*manifest["outputs"], "imported-model-result.json"):
            source = root / str(file_name)
            (snapshot / str(file_name)).write_bytes(source.read_bytes())
        return snapshot

    def test_restores_exact_uploaded_model_after_mesh_edit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self._create_uploaded_model(root, (20, 16, 10))
            snapshot = self._create_snapshot(root, original)
            source = root / str(original["sourceFile"])
            edited = edit_mesh_element(source, root, str(original["revision"]), "vertex", 0, 0, (0.25, 0, 0))
            self.assertNotEqual(edited["revision"], original["revision"])

            restored = restore_uploaded_model_snapshot(snapshot, root, str(original["revision"]))
            self.assertEqual(restored["updatedModel"]["revision"], original["revision"])
            current = json.loads((root / "imported-model-result.json").read_text(encoding="utf-8"))
            self.assertEqual(current["revision"], original["revision"])
            self.assertEqual(restored["validation"]["solidCount"], 1)
            self.assertTrue(restored["validation"]["watertight"])

    def test_preserves_cad_mesh_branch_source_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self._create_uploaded_model(root, (18, 14, 9))
            original["branchSource"] = {
                "kind": "cad-part",
                "cadRevision": "cad-source-revision",
                "partId": "figure-head",
                "partLabel": "头部",
                "sourceStlFile": "figure-head.stl",
            }
            (root / "imported-model-result.json").write_text(
                json.dumps(original, ensure_ascii=False), encoding="utf-8"
            )
            snapshot = self._create_snapshot(root, original)

            restored = restore_uploaded_model_snapshot(snapshot, root, str(original["revision"]))
            self.assertEqual(restored["updatedModel"]["branchSource"], original["branchSource"])
            current = json.loads((root / "imported-model-result.json").read_text(encoding="utf-8"))
            self.assertEqual(current["branchSource"], original["branchSource"])

    def test_rejects_revision_mismatch_without_overwriting_current_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self._create_uploaded_model(root, (20, 16, 10))
            snapshot = self._create_snapshot(root, original)
            source = root / str(original["sourceFile"])
            edit_mesh_element(source, root, str(original["revision"]), "face", 0, 0, (0, 0, 0.1))
            current_manifest = (root / "imported-model-result.json").read_text(encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "修订号不一致"):
                restore_uploaded_model_snapshot(snapshot, root, "错误修订")
            self.assertEqual((root / "imported-model-result.json").read_text(encoding="utf-8"), current_manifest)

    def test_rejects_missing_step_and_tampered_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self._create_uploaded_model(root, (12, 10, 8))
            snapshot = self._create_snapshot(root, original)
            (snapshot / "imported-model-working.step").unlink()
            with self.assertRaisesRegex(ValueError, "缺少模型文件"):
                restore_uploaded_model_snapshot(snapshot, root, str(original["revision"]))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self._create_uploaded_model(root, (12, 10, 8))
            snapshot = self._create_snapshot(root, original)
            manifest_path = snapshot / "imported-model-result.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["outputs"] = ["../外部.stl"]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "输出必须完整包含"):
                restore_uploaded_model_snapshot(snapshot, root, str(original["revision"]))


if __name__ == "__main__":
    unittest.main()
