import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETERS } from './defaults';
import { compareModelVersions } from './versionComparison';
import type { InterfaceOpeningSpec, ModelVersion } from './types';

function opening(overrides: Partial<InterfaceOpeningSpec> = {}): InterfaceOpeningSpec {
  return {
    id: '接口-1',
    label: '主接口',
    sourceType: 'USB-C',
    face: 'front',
    shape: 'rounded-rectangle',
    widthMm: 12,
    heightMm: 6,
    centerUMm: 2,
    centerVMm: -1,
    positionReference: 'face-center-bottom',
    horizontalOffsetMm: 2,
    bottomOffsetMm: 3,
    cornerRadiusMm: 1.5,
    minimumEdgeMarginMm: 1.2,
    minimumSpacingMm: 1.2,
    sourceConfidence: 0.94,
    ...overrides
  };
}

function version(
  id: string,
  overrides: Partial<ModelVersion> = {}
): ModelVersion {
  return {
    id,
    label: id,
    createdAt: '2026-07-20T00:00:00.000Z',
    parameters: { ...DEFAULT_PARAMETERS },
    interfaceOpenings: null,
    ...overrides
  };
}

describe('模型版本参数与开孔差异对比', () => {
  it('相同版本不产生差异', () => {
    const base = version('基础', { interfaceOpenings: [opening()] });
    const target = version('当前', { interfaceOpenings: [opening()] });

    expect(compareModelVersions(base, target)).toEqual({
      parameterDifferences: [],
      openingModeDifference: null,
      openingDifferences: [],
      hasDifferences: false
    });
  });

  it('输出参数增加和减少量及中文参数名', () => {
    const base = version('基础');
    const target = version('当前', {
      parameters: {
        ...DEFAULT_PARAMETERS,
        wallThickness: 2.6,
        cornerRadius: 3
      }
    });

    const result = compareModelVersions(base, target);
    expect(result.parameterDifferences).toEqual([
      {
        key: 'wallThickness',
        label: '外壳壁厚',
        before: 2,
        after: 2.6,
        delta: 0.6,
        unit: '毫米'
      },
      {
        key: 'cornerRadius',
        label: '圆角半径',
        before: 4,
        after: 3,
        delta: -1,
        unit: '毫米'
      }
    ]);
    expect(result.hasDifferences).toBe(true);
  });

  it('识别新增和删除的通用开孔', () => {
    const base = version('基础', {
      interfaceOpenings: [opening({ id: '删除项', label: '待删除接口' })]
    });
    const target = version('当前', {
      interfaceOpenings: [opening({ id: '新增项', label: '新增接口' })]
    });

    expect(compareModelVersions(base, target).openingDifferences).toMatchObject([
      { id: '删除项', label: '待删除接口', changeType: 'removed' },
      { id: '新增项', label: '新增接口', changeType: 'added' }
    ]);
  });

  it('按稳定接口编号识别尺寸、所在面和锚点修改', () => {
    const base = version('基础', { interfaceOpenings: [opening()] });
    const target = version('当前', {
      interfaceOpenings: [opening({
        face: 'right',
        widthMm: 14,
        centerVMm: -2,
        positionReference: undefined,
        horizontalOffsetMm: undefined,
        bottomOffsetMm: undefined
      })]
    });

    const [difference] = compareModelVersions(base, target).openingDifferences;
    expect(difference.changeType).toBe('modified');
    expect(difference.changedFields).toEqual([
      '所在面',
      '宽度',
      '竖直中心坐标',
      '定位方式',
      '水平锚点偏移',
      '底边锚点偏移'
    ]);
    expect(difference.fields).toContainEqual({
      field: 'face',
      label: '所在面',
      before: '正面',
      after: '右侧'
    });
    expect(difference.fields).toContainEqual({
      field: 'positionReference',
      label: '定位方式',
      before: '接口面中心与底边锚定',
      after: '固定毫米坐标'
    });
  });

  it('区分模板开孔模式和明确无开孔的自定义模式', () => {
    const result = compareModelVersions(
      version('基础', { interfaceOpenings: null }),
      version('当前', { interfaceOpenings: [] })
    );

    expect(result.openingModeDifference).toEqual({
      before: '模板参数开孔',
      after: '自定义通用开孔'
    });
    expect(result.openingDifferences).toEqual([]);
    expect(result.hasDifferences).toBe(true);
  });

  it('兼容老版本缺失开孔字段，并忽略容差内浮点误差', () => {
    const base = version('基础', { interfaceOpenings: undefined });
    const target = version('当前', {
      parameters: {
        ...DEFAULT_PARAMETERS,
        wallThickness: DEFAULT_PARAMETERS.wallThickness + 0.0000001
      },
      interfaceOpenings: null
    });

    expect(compareModelVersions(base, target).hasDifferences).toBe(false);
  });
});
