import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETERS } from './defaults';
import { compareModelVersions } from './versionComparison';
import type { InterfaceOpeningSpec, ModelVersion, VersionCurvedFeature } from './types';

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

function curvedFeature(
  overrides: Partial<VersionCurvedFeature> = {}
): VersionCurvedFeature {
  return {
    id: '创建修订-1:主体:add-cylinder',
    operation: 'add-cylinder',
    partId: '主体',
    stableFaceId: '稳定面-1',
    surfaceGeometryType: 'CYLINDER',
    radiusMm: 2,
    depthMm: 3,
    command: '增加曲面圆形凸台',
    diagnostics: {
      maximumAbsCurvaturePerMm: 0.1,
      minimumCurvatureRadiusMm: 10,
      curvatureRatio: 0.2,
      localWallThicknessMm: 20,
      remainingWallMm: 17,
      throughCut: false,
      interferenceCheckPassed: true,
      selfIntersectionDetected: false,
      adjacentFaceInterferenceDetected: false,
      interferingFaceCount: 0,
      interferingStableFaceIds: [],
      minimumInterferenceDistanceMm: null,
      contactFaceCount: 1,
      contactSampleCount: 7
    },
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
      curvedFeatureDifferences: [],
      hasDifferences: false
    });
  });

  it('相同曲面局部特征诊断不产生差异', () => {
    const feature = curvedFeature();
    const result = compareModelVersions(
      version('基础', { curvedFeatures: [feature] }),
      version('当前', { curvedFeatures: [structuredClone(feature)] })
    );

    expect(result.curvedFeatureDifferences).toEqual([]);
    expect(result.hasDifferences).toBe(false);
  });

  it('识别曲面局部特征新增和删除', () => {
    const removed = curvedFeature({ id: '删除特征', operation: 'cut-cylinder' });
    const added = curvedFeature({ id: '新增特征', stableFaceId: '稳定面-2' });
    const result = compareModelVersions(
      version('基础', { curvedFeatures: [removed] }),
      version('当前', { curvedFeatures: [added] })
    );

    expect(result.curvedFeatureDifferences).toMatchObject([
      { id: '删除特征', label: '曲面圆孔', changeType: 'removed' },
      { id: '新增特征', label: '曲面圆形凸台', changeType: 'added' }
    ]);
    expect(result.hasDifferences).toBe(true);
  });

  it('比较工具尺寸、曲率、壁厚、通孔与干涉诊断', () => {
    const before = curvedFeature();
    const after = curvedFeature({
      radiusMm: 2.5,
      depthMm: 20,
      surfaceGeometryType: 'SPHERE',
      diagnostics: {
        ...before.diagnostics,
        curvatureRatio: 0.25,
        localWallThicknessMm: 18,
        remainingWallMm: null,
        throughCut: true,
        interferenceCheckPassed: false,
        adjacentFaceInterferenceDetected: true,
        interferingFaceCount: 1,
        interferingStableFaceIds: ['稳定面-阻挡'],
        minimumInterferenceDistanceMm: 1.25,
        contactFaceCount: 2,
        contactSampleCount: 10
      }
    });
    const [difference] = compareModelVersions(
      version('基础', { curvedFeatures: [before] }),
      version('当前', { curvedFeatures: [after] })
    ).curvedFeatureDifferences;

    expect(difference.changeType).toBe('modified');
    expect(difference.changedFields).toEqual(expect.arrayContaining([
      '工具半径',
      '工具直径',
      '作用深度',
      '曲面类型',
      '曲率比',
      '局部壁厚',
      '剩余壁厚',
      '通孔状态',
      '干涉检查',
      '相邻面干涉',
      '干涉稳定面编号',
      '最近干涉距离',
      '接触面数量',
      '接触采样数量'
    ]));
    expect(difference.fields).toContainEqual({
      field: 'surfaceGeometryType',
      label: '曲面类型',
      before: '圆柱面',
      after: '球面'
    });
    expect(difference.fields).toContainEqual({
      field: 'throughCut',
      label: '通孔状态',
      before: '盲孔',
      after: '通孔'
    });
    expect(difference.fields).toContainEqual({
      field: 'interferingStableFaceIds',
      label: '干涉稳定面编号',
      before: '无',
      after: '稳定面-阻挡'
    });
  });

  it('兼容旧版本缺少曲面局部特征快照', () => {
    const result = compareModelVersions(
      version('旧版本'),
      version('当前', { curvedFeatures: [curvedFeature()] })
    );

    expect(result.curvedFeatureDifferences).toHaveLength(1);
    expect(result.curvedFeatureDifferences[0].changeType).toBe('added');
    expect(result.hasDifferences).toBe(true);
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
