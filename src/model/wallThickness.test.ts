import { describe, expect, it } from 'vitest';
import {
  buildWallThicknessCommandContext,
  classifyWallThickness,
  describeWallThicknessRisk,
  findNearestWallThicknessSample,
  findThinnestWallThicknessSample,
  WALL_THICKNESS_COLORS,
  type WallThicknessAnalysisResult
} from './wallThickness';

const baseResult: WallThicknessAnalysisResult = {
  status: 'ok', revision: '1', sourceKind: 'cad-part', sourcePartId: 'part', sourceFormat: 'step',
  sourceFile: 'part.step', units: 'mm', kernel: 'OpenCascade', method: '表面法向射线采样估算',
  printerProfile: { printer: 'Bambu Lab P1S', nozzleMm: 0.4, materials: ['PLA', 'PETG'] },
  thresholds: { criticalBelowMm: 0.8, thinBelowMm: 1.2, recommendedBelowMm: 2 },
  requestedSampleCount: 10, sampleCount: 10, surfaceTriangleCount: 10, surfaceAreaMm2: 20,
  minimumWallMm: 1.2, minimumThicknessMm: 1.3, percentile05Mm: 1.4,
  medianThicknessMm: 2, maximumThicknessMm: 4, criticalCount: 0, thinCount: 0,
  recommendedCount: 2, safeCount: 8, coverageRatio: 1, samples: [], limitations: []
};

describe('壁厚分析协议', () => {
  it('按照 P1S 默认阈值分为四级', () => {
    expect(classifyWallThickness(0.79, baseResult.thresholds)).toBe('critical');
    expect(classifyWallThickness(0.8, baseResult.thresholds)).toBe('thin');
    expect(classifyWallThickness(1.2, baseResult.thresholds)).toBe('recommended');
    expect(classifyWallThickness(2, baseResult.thresholds)).toBe('safe');
    expect(WALL_THICKNESS_COLORS.critical).not.toBe(WALL_THICKNESS_COLORS.safe);
  });

  it('优先报告危险和偏薄区域', () => {
    expect(describeWallThicknessRisk({ ...baseResult, criticalCount: 3, minimumThicknessMm: 0.6 }))
      .toContain('3 个危险采样点');
    expect(describeWallThicknessRisk({ ...baseResult, thinCount: 2, minimumThicknessMm: 1 }))
      .toContain('2 个偏薄采样点');
    expect(describeWallThicknessRisk(baseResult)).toContain('未发现低于 1.20 毫米');
  });

  it('可以定位最薄点并在重建后寻找最近复查点', () => {
    const samples = [
      { xMm: 0, yMm: 0, zMm: 0, inwardNormal: { x: 0, y: 0, z: 1 }, thicknessMm: 2.4, severity: 'safe' as const },
      { xMm: 5, yMm: 1, zMm: 2, inwardNormal: { x: -1, y: 0, z: 0 }, thicknessMm: 0.7, severity: 'critical' as const },
      { xMm: 5.2, yMm: 1, zMm: 2, inwardNormal: { x: -1, y: 0, z: 0 }, thicknessMm: 1.1, severity: 'thin' as const }
    ];
    expect(findThinnestWallThicknessSample({ ...baseResult, samples })).toEqual(samples[1]);
    expect(findNearestWallThicknessSample(samples, { xMm: 5.18, yMm: 1, zMm: 2 }))
      .toEqual(samples[2]);
  });

  it('生成中文局部几何上下文供 Codex 使用', () => {
    const context = buildWallThicknessCommandContext({
      sourceKind: 'cad-part',
      sourcePartId: 'body',
      sample: { xMm: 1, yMm: 2, zMm: 3, inwardNormal: { x: -1, y: 0, z: 0 }, thicknessMm: 0.75, severity: 'critical' }
    });
    expect(context).toContain('坐标=(1.000, 2.000, 3.000) 毫米');
    expect(context).toContain('内法向=(-1.000000, 0.000000, 0.000000)');
    expect(context).toContain('风险=危险');
    expect(context).toContain('若当前参数化特征无法精确表达');
  });
});
