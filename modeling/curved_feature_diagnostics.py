"""Normalize persisted diagnostics for supported non-planar CAD features."""

from __future__ import annotations

from typing import Any

CURVED_DIAGNOSTIC_OPERATIONS = {"add-cylinder", "cut-cylinder", "cut-slot"}


def build_curved_feature_diagnostics(
    operation: str,
    surface_geometry_type: str,
    validation: dict[str, Any],
) -> dict[str, Any] | None:
    """Return a JSON-safe diagnostic snapshot for supported features on curved faces."""
    if operation not in CURVED_DIAGNOSTIC_OPERATIONS or surface_geometry_type == "PLANE":
        return None
    interfering_ids = validation.get("interferingStableFaceIds")
    return {
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
        "interferingStableFaceIds": [
            str(value) for value in interfering_ids
        ] if isinstance(interfering_ids, list) else [],
        "minimumInterferenceDistanceMm": validation.get("minimumInterferenceDistanceMm"),
        "contactFaceCount": int(validation.get("contactFaceCount", 0)),
        "contactSampleCount": int(validation.get("contactSampleCount", 0)),
    }
