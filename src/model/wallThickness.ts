export type WallThicknessSeverity = 'critical' | 'thin' | 'recommended' | 'safe';

export interface WallThicknessSample {
  xMm: number;
  yMm: number;
  zMm: number;
  /** 指向实体内部的单位法向，供上传 STL 局部实体修改使用。 */
  inwardNormal: { x: number; y: number; z: number };
  thicknessMm: number;
  severity: WallThicknessSeverity;
}

/** 用户在三维热力图中选中的一个局部壁厚采样区域。 */
export interface WallThicknessSelection {
  sourceKind: WallThicknessAnalysisResult['sourceKind'];
  sourcePartId: string;
  sample: WallThicknessSample;
}

export interface WallThicknessRequest {
  sourceKind: 'cad-part' | 'uploaded-stl';
  sourcePartId: string;
  minimumWallMm?: number;
  sampleLimit?: number;
}

export interface WallThicknessAnalysisResult {
  status: 'ok';
  revision: string;
  sourceKind: 'cad-part' | 'uploaded-stl';
  sourcePartId: string;
  sourceFormat: 'step' | 'stl';
  sourceFile: string;
  units: 'mm';
  kernel: string;
  method: string;
  printerProfile: {
    printer: string;
    nozzleMm: number;
    materials: string[];
  };
  thresholds: {
    criticalBelowMm: number;
    thinBelowMm: number;
    recommendedBelowMm: number;
  };
  requestedSampleCount: number;
  sampleCount: number;
  surfaceTriangleCount: number;
  surfaceAreaMm2: number;
  minimumWallMm: number;
  minimumThicknessMm: number;
  percentile05Mm: number;
  medianThicknessMm: number;
  maximumThicknessMm: number;
  criticalCount: number;
  thinCount: number;
  recommendedCount: number;
  safeCount: number;
  coverageRatio: number;
  samples: WallThicknessSample[];
  limitations: string[];
}

export const WALL_THICKNESS_COLORS: Record<WallThicknessSeverity, string> = {
  critical: '#ef4444',
  thin: '#f97316',
  recommended: '#facc15',
  safe: '#22c55e'
};

export const WALL_THICKNESS_LABELS: Record<WallThicknessSeverity, string> = {
  critical: '危险',
  thin: '偏薄',
  recommended: '建议',
  safe: '充足'
};

/** Returns the most important Chinese risk statement for one completed analysis. */
export function describeWallThicknessRisk(result: WallThicknessAnalysisResult) {
  if (result.criticalCount > 0) {
    return `发现 ${result.criticalCount} 个危险采样点，最薄处 ${result.minimumThicknessMm.toFixed(2)} 毫米`;
  }
  if (result.thinCount > 0) {
    return `发现 ${result.thinCount} 个偏薄采样点，最薄处 ${result.minimumThicknessMm.toFixed(2)} 毫米`;
  }
  return `未发现低于 ${result.minimumWallMm.toFixed(2)} 毫米的采样点`;
}

/** Maps an arbitrary thickness to the same four levels used by the Python worker. */
export function classifyWallThickness(
  thicknessMm: number,
  thresholds: WallThicknessAnalysisResult['thresholds']
): WallThicknessSeverity {
  if (thicknessMm < thresholds.criticalBelowMm) return 'critical';
  if (thicknessMm < thresholds.thinBelowMm) return 'thin';
  if (thicknessMm < thresholds.recommendedBelowMm) return 'recommended';
  return 'safe';
}

/** 找到最薄采样点，供“一键定位最薄处”和修改后复查使用。 */
export function findThinnestWallThicknessSample(result: WallThicknessAnalysisResult) {
  return result.samples.reduce<WallThicknessSample | null>(
    (thinnest, sample) => !thinnest || sample.thicknessMm < thinnest.thicknessMm ? sample : thinnest,
    null
  );
}

/** 在模型重建后，按原始毫米坐标找到最接近的复查采样点。 */
export function findNearestWallThicknessSample(
  samples: WallThicknessSample[],
  point: Pick<WallThicknessSample, 'xMm' | 'yMm' | 'zMm'>
) {
  return samples.reduce<{ sample: WallThicknessSample; distanceSquared: number } | null>(
    (nearest, sample) => {
      const distanceSquared = (sample.xMm - point.xMm) ** 2
        + (sample.yMm - point.yMm) ** 2
        + (sample.zMm - point.zMm) ** 2;
      return !nearest || distanceSquared < nearest.distanceSquared
        ? { sample, distanceSquared }
        : nearest;
    },
    null
  )?.sample ?? null;
}

/** 将局部选择压缩为可传给 Codex 的明确几何上下文。 */
export function buildWallThicknessCommandContext(selection: WallThicknessSelection) {
  const { sample } = selection;
  return [
    '局部壁厚选择上下文：',
    `来源=${selection.sourceKind === 'uploaded-stl' ? '上传 STL' : 'CAD 零件'}`,
    `零件=${selection.sourcePartId}`,
    `坐标=(${sample.xMm.toFixed(3)}, ${sample.yMm.toFixed(3)}, ${sample.zMm.toFixed(3)}) 毫米`,
    `内法向=(${sample.inwardNormal.x.toFixed(6)}, ${sample.inwardNormal.y.toFixed(6)}, ${sample.inwardNormal.z.toFixed(6)})`,
    `估算壁厚=${sample.thicknessMm.toFixed(3)} 毫米`,
    `风险=${WALL_THICKNESS_LABELS[sample.severity]}`,
    '请优先修改该局部区域；若当前参数化特征无法精确表达，必须明确说明。'
  ].join('；');
}
