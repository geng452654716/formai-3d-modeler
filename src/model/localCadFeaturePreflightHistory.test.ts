import { describe, expect, it } from 'vitest';
import type { LocalCadFeaturePreflightResult, LocalCadFeatureRequest } from './localCadFeature';
import {
  appendLocalCadFeaturePreflightRecord,
  compareLocalCadFeaturePreflights,
  createLocalCadFeaturePreflightRecord,
  findPreviousComparableLocalCadFeaturePreflight,
  linkLocalCadFeaturePreflightExecution,
  suggestLocalCadFeatureRiskAdjustments
} from './localCadFeaturePreflightHistory';

function request(overrides: Partial<LocalCadFeatureRequest> = {}): LocalCadFeatureRequest {
  return {
    sourceKind: 'cad-part',
    selectionRevision: 'revision-before',
    partId: 'part-a',
    stableFaceId: 'face-a',
    stableEdgeId: null,
    operation: 'cut-cylinder',
    center: { xMm: 1, yMm: 2, zMm: 3 },
    hitNormal: { x: 0, y: 0, z: 1 },
    surfaceTangentU: { x: 1, y: 0, z: 0 },
    surfaceGeometryType: 'CYLINDER',
    surfaceUv: { u: 0.2, v: 4 },
    radiusMm: 5,
    widthMm: null,
    heightMm: null,
    lengthMm: null,
    depthMm: 6,
    rotationDeg: 0,
    summary: '曲面圆孔',
    command: '在这里开一个直径 10 毫米、深 6 毫米的圆孔',
    ...overrides
  };
}

function preflight(
  status: 'ok' | 'blocked' = 'blocked',
  overrides: Partial<LocalCadFeaturePreflightResult['validation']> = {}
): LocalCadFeaturePreflightResult {
  return {
    status,
    revision: 'revision-before',
    operation: 'cut-cylinder',
    partId: 'part-a',
    stableFaceId: 'face-a',
    previewFile: 'tool.stl',
    outputs: ['tool.stl'],
    units: 'mm',
    kernel: 'OpenCascade',
    message: status === 'ok' ? '预检通过' : '发现邻面干涉',
    validation: {
      maximumAbsCurvaturePerMm: 0.1,
      minimumCurvatureRadiusMm: 10,
      curvatureRatio: 0.5,
      localWallThicknessMm: 4,
      remainingWallMm: 0.4,
      throughCut: false,
      interferenceCheckPassed: status === 'ok',
      selfIntersectionDetected: false,
      adjacentFaceInterferenceDetected: status === 'blocked',
      interferingFaceCount: status === 'blocked' ? 2 : 0,
      interferingStableFaceIds: status === 'blocked' ? ['face-b', 'face-c'] : [],
      minimumInterferenceDistanceMm: status === 'blocked' ? 0.12 : null,
      contactFaceCount: 2,
      contactSampleCount: 12,
      toolValid: true,
      toolWatertight: true,
      toolSolidCount: 1,
      toolVolumeMm3: 471.24,
      toolBoundsMm: { x: 10, y: 10, z: 6 },
      ...overrides
    },
    limitations: ['切平面安全近似']
  };
}

function record(
  id: string,
  currentRequest = request(),
  currentPreflight = preflight()
) {
  return createLocalCadFeaturePreflightRecord(currentRequest, currentPreflight, {
    id,
    createdAt: `2026-07-21T00:00:0${id.length}.000Z`
  });
}

describe('精确局部特征预检历史', () => {
  it('深拷贝请求和结果，后续预览变化不会污染留档', () => {
    const sourceRequest = request();
    const sourceResult = preflight();
    const archived = createLocalCadFeaturePreflightRecord(sourceRequest, sourceResult, { id: 'record-1' });

    sourceRequest.center.xMm = 99;
    sourceRequest.surfaceUv.u = 99;
    sourceResult.validation.interferingStableFaceIds.push('face-d');
    sourceResult.validation.toolBoundsMm.x = 99;

    expect(archived.request.center.xMm).toBe(1);
    expect(archived.request.surfaceUv.u).toBe(0.2);
    expect(archived.result.validation.interferingStableFaceIds).toEqual(['face-b', 'face-c']);
    expect(archived.result.validation.toolBoundsMm.x).toBe(10);
  });

  it('按限制裁剪为最近记录，并可关联正式执行修订', () => {
    const history = ['1', '2', '3'].reduce(
      (current, id) => appendLocalCadFeaturePreflightRecord(current, record(id), 2),
      [] as ReturnType<typeof record>[]
    );
    expect(history.map((item) => item.id)).toEqual(['2', '3']);
    expect(linkLocalCadFeaturePreflightExecution(history, '3', 'revision-after').at(-1)?.executedRevision)
      .toBe('revision-after');
  });

  it('只查找同源修订、零件、稳定面和操作的上一次记录', () => {
    const first = record('first');
    const unrelated = record('other', request({ stableFaceId: 'face-other' }));
    const current = record('current');
    expect(findPreviousComparableLocalCadFeaturePreflight([first, unrelated, current], current)?.id)
      .toBe('first');
  });

  it('比较阻断到通过、参数、工具体和干涉面增减', () => {
    const before = record('before');
    const afterRequest = request({ radiusMm: 4, depthMm: 5 });
    const after = record('after', afterRequest, preflight('ok', {
      toolVolumeMm3: 251.33,
      toolBoundsMm: { x: 8, y: 8, z: 5 },
      interferingStableFaceIds: ['face-c'],
      interferingFaceCount: 1
    }));
    const comparison = compareLocalCadFeaturePreflights(before, after);

    expect(comparison.becamePassed).toBe(true);
    expect(comparison.parameterDifferences.map((item) => item.field)).toEqual(['diameterMm', 'depthMm']);
    expect(comparison.diagnosticDifferences.map((item) => item.field)).toContain('toolVolumeMm3');
    expect(comparison.removedInterferingStableFaceIds).toEqual(['face-b']);
    expect(comparison.addedInterferingStableFaceIds).toEqual([]);
  });
});

describe('受限风险参数收敛建议', () => {
  it('为圆形轮廓生成递减直径并保持目标绑定', () => {
    const suggestions = suggestLocalCadFeatureRiskAdjustments(record('circle')).suggestions;
    expect(suggestions.slice(0, 3).map((item) => item.adjustment.diameterMm)).toEqual([9, 8, 7]);
    expect(suggestions.every((item) => item.adjustment.depthMm > 0)).toBe(true);
  });

  it('为矩形同比缩放宽高且候选保持在安全范围内', () => {
    const rectangle = record('rectangle', request({
      operation: 'cut-rectangle', radiusMm: null, widthMm: 12, heightMm: 8, rotationDeg: 175
    }), { ...preflight(), operation: 'cut-rectangle' });
    const suggestions = suggestLocalCadFeatureRiskAdjustments(rectangle).suggestions;
    expect(suggestions[0]?.adjustment).toMatchObject({ widthMm: 10.8, heightMm: 7.2 });
    expect(suggestions.every((item) => item.adjustment.rotationDeg >= -180 && item.adjustment.rotationDeg <= 180))
      .toBe(true);
  });

  it('为槽孔保持长度不小于宽度', () => {
    const slot = record('slot', request({
      operation: 'cut-slot', radiusMm: null, widthMm: 6, lengthMm: 7, rotationDeg: -178
    }), { ...preflight(), operation: 'cut-slot' });
    const suggestions = suggestLocalCadFeatureRiskAdjustments(slot).suggestions;
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((item) => (
      item.adjustment.lengthMm === null
      || item.adjustment.widthMm === null
      || item.adjustment.lengthMm >= item.adjustment.widthMm
    ))).toBe(true);
  });

  it('通过记录和不可收敛操作返回中文说明而不是非法参数', () => {
    const passed = record('passed', request(), preflight('ok'));
    expect(suggestLocalCadFeatureRiskAdjustments(passed)).toEqual({
      suggestions: [],
      explanation: '当前预检已经通过，无需生成风险收敛候选。'
    });

    const unsupported = record('offset', request({
      operation: 'offset-face-outward', radiusMm: null, depthMm: 0.1
    }), { ...preflight(), operation: 'offset-face-outward', validation: {
      ...preflight().validation,
      adjacentFaceInterferenceDetected: false,
      selfIntersectionDetected: false,
      remainingWallMm: null
    } });
    const result = suggestLocalCadFeatureRiskAdjustments(unsupported);
    expect(result.suggestions).toEqual([]);
    expect(result.explanation).toContain('没有可在安全范围内自动收敛');
  });
});
