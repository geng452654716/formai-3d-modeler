import type { CadGenerationResult } from './cad';

export type VersionGeometryComparisonMode = 'off' | 'overlay' | 'side-by-side' | 'difference';

export interface VersionGeometryComparisonOffsets {
  base: [number, number, number];
  current: [number, number, number];
  gapMm: number;
}

const DEFAULT_MODEL_WIDTH_MM = 60;
const DEFAULT_GAP_MM = 18;

/** Returns a conservative X-axis assembly width using manifest part bounds in millimeters. */
export function getVersionModelWidth(result: CadGenerationResult | null) {
  if (!result) return DEFAULT_MODEL_WIDTH_MM;
  const widths = result.parts
    .map((part) => part.metrics.boundsMm.x)
    .filter((width) => Number.isFinite(width) && width > 0);
  return widths.length > 0 ? Math.max(...widths) : DEFAULT_MODEL_WIDTH_MM;
}

/** Calculates centered comparison offsets while preserving a physical millimeter gap. */
export function calculateVersionComparisonOffsets(
  baseResult: CadGenerationResult | null,
  currentResult: CadGenerationResult | null,
  mode: VersionGeometryComparisonMode,
  gapMm = DEFAULT_GAP_MM
): VersionGeometryComparisonOffsets {
  const safeGap = Number.isFinite(gapMm) && gapMm >= 0 ? gapMm : DEFAULT_GAP_MM;
  if (mode !== 'side-by-side') {
    return { base: [0, 0, 0], current: [0, 0, 0], gapMm: safeGap };
  }
  const centerDistance = (
    getVersionModelWidth(baseResult) + getVersionModelWidth(currentResult)
  ) / 2 + safeGap;
  return {
    base: [-centerDistance / 2, 0, 0],
    current: [centerDistance / 2, 0, 0],
    gapMm: safeGap
  };
}
