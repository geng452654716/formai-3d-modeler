import { describe, expect, it } from 'vitest';
import type { CadGenerationResult } from './cad';
import {
  calculateVersionComparisonOffsets,
  getVersionModelWidth
} from './versionGeometryComparison';

function resultWithWidths(...widths: number[]): CadGenerationResult {
  return {
    status: 'ok',
    revision: 'test',
    outputs: [],
    units: 'mm',
    kernel: '测试内核',
    printer: { model: 'Bambu Lab P1S', buildVolumeMm: [256, 256, 256], nozzleMm: 0.4 },
    model: { id: 'test', name: '测试模型', templateId: 'test', templateName: '测试模板' },
    parameters: {},
    interfaceOpeningMode: 'custom',
    interfaceOpenings: [],
    openingValidation: {
      count: 0,
      bodyCount: 0,
      coverCount: 0,
      minimumEdgeMarginMm: null,
      minimumSpacingMm: null
    },
    parts: widths.map((width, index) => ({
      id: `part-${index}`,
      label: `零件 ${index + 1}`,
      role: index === 0 ? 'primary' : 'part',
      stlFile: `part-${index}.stl`,
      stepFile: `part-${index}.step`,
      metrics: {
        valid: true,
        volumeMm3: 1,
        boundsMm: { x: width, y: 20, z: 10 },
        fitsP1S: true
      }
    })),
    assemblyFile: 'assembly.3mf',
    files: {}
  };
}

describe('版本实体对比布局', () => {
  it('使用所有零件中的最大宽度', () => {
    expect(getVersionModelWidth(resultWithWidths(42, 76, 51))).toBe(76);
  });

  it('并排模式按毫米尺寸留出指定间距且左右对称', () => {
    const offsets = calculateVersionComparisonOffsets(
      resultWithWidths(80),
      resultWithWidths(40),
      'side-by-side',
      20
    );
    expect(offsets.base[0]).toBe(-40);
    expect(offsets.current[0]).toBe(40);
    expect(offsets.current[0] - offsets.base[0] - (80 + 40) / 2).toBe(20);
  });

  it('重叠模式保持两个实体的原始毫米坐标', () => {
    expect(calculateVersionComparisonOffsets(
      resultWithWidths(80),
      resultWithWidths(40),
      'overlay'
    )).toEqual({ base: [0, 0, 0], current: [0, 0, 0], gapMm: 18 });
  });

  it('精确差异模式保持布尔结果和当前实体的原始毫米坐标', () => {
    expect(calculateVersionComparisonOffsets(
      resultWithWidths(80),
      resultWithWidths(40),
      'difference'
    )).toEqual({ base: [0, 0, 0], current: [0, 0, 0], gapMm: 18 });
  });

  it('空清单和无效尺寸使用安全回退值', () => {
    const invalid = resultWithWidths(Number.NaN, 0, -4);
    expect(getVersionModelWidth(null)).toBe(60);
    expect(getVersionModelWidth(invalid)).toBe(60);
    const offsets = calculateVersionComparisonOffsets(null, invalid, 'side-by-side', Number.NaN);
    expect(offsets).toEqual({ base: [-39, 0, 0], current: [39, 0, 0], gapMm: 18 });
  });
});
