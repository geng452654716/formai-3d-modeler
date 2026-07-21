import { describe, expect, it } from 'vitest';
import type { CadFaceSelectionContext } from './cadFaceSelection';
import {
  applyCadSurfaceHitResult,
  buildCadSurfaceHitRequest,
  failCadSurfaceHitSelection,
  type CadSurfaceHitResult
} from './cadSurfaceHit';

function selection(): CadFaceSelectionContext {
  return {
    protocol: 'FormAI-CAD-局部编辑上下文',
    protocolVersion: 1,
    sourceKind: 'cad-face',
    selectionMode: 'click',
    revision: 'revision-1',
    units: 'mm',
    partBoundsMm: { shell: { x: 40, y: 30, z: 20 } },
    faces: [{
      partId: 'shell', partLabel: '外壳', stableId: 'face-curve', geometryType: 'CYLINDER',
      areaMm2: 100, centerMm: [0, 0, 0]
    }],
    hit: {
      partId: 'shell', stableId: 'face-curve', triangleIndex: 12,
      pointMm: { x: 10.01, y: 0, z: 5 }, normal: { x: 0.999, y: 0.01, z: 0 },
      meshPointMm: { x: 10.01, y: 0, z: 5 }, meshNormal: { x: 0.999, y: 0.01, z: 0 },
      surfaceUv: null, uvBounds: null, precision: 'mesh', resolutionStatus: 'resolving',
      pointDistanceMm: null, normalDot: null, resolutionError: null
    },
    camera: {
      positionMm: { x: 50, y: 50, z: 50 }, projectionMatrix: [], viewMatrix: [],
      viewportPixels: { width: 800, height: 600 }
    },
    screenshot: null,
    parameters: {} as CadFaceSelectionContext['parameters'],
    printer: { model: 'Bambu Lab P1S', buildVolumeMm: [256, 256, 256], nozzleMm: 0.4 },
    warning: '测试'
  };
}

function result(): CadSurfaceHitResult {
  return {
    status: 'ok', selectionRevision: 'revision-1', partId: 'shell', stableFaceId: 'face-curve',
    triangleIndex: 12, geometryType: 'CYLINDER', projectedPointMm: { x: 10, y: 0, z: 5 },
    pointDistanceMm: 0.01, maximumPointDistanceMm: 0.35, surfaceUv: { u: 0, v: 5 },
    uvBounds: { uMin: 0, uMax: Math.PI * 2, vMin: 0, vMax: 20 },
    outwardNormal: { x: 1, y: 0, z: 0 }, surfaceTangentU: { x: 0, y: 1, z: 0 }, normalDot: 0.999,
    trimmedFaceState: 'inside', units: 'mm', kernel: 'OpenCascade 7.8 / CadQuery 2.6', limitations: []
  };
}

describe('OpenCascade 曲面点击结果绑定', () => {
  it('请求始终使用原始选择网格坐标和法线', () => {
    expect(buildCadSurfaceHitRequest(selection())).toMatchObject({
      selectionRevision: 'revision-1', partId: 'shell', stableFaceId: 'face-curve', triangleIndex: 12,
      pointMm: { x: 10.01, y: 0, z: 5 }, meshNormal: { x: 0.999, y: 0.01, z: 0 }
    });
  });

  it('成功后保留网格诊断值并把权威位置、法线和 UV 更新为 OpenCascade 结果', () => {
    const updated = applyCadSurfaceHitResult(selection(), result());
    expect(updated.hit).toMatchObject({
      pointMm: { x: 10, y: 0, z: 5 }, normal: { x: 1, y: 0, z: 0 },
      meshPointMm: { x: 10.01, y: 0, z: 5 }, meshNormal: { x: 0.999, y: 0.01, z: 0 },
      surfaceUv: { u: 0, v: 5 }, surfaceTangentU: { x: 0, y: 1, z: 0 },
      precision: 'opencascade', resolutionStatus: 'resolved',
      pointDistanceMm: 0.01, normalDot: 0.999, resolutionError: null
    });
  });

  it.each([
    ['selectionRevision', 'revision-other'],
    ['partId', 'other-part'],
    ['stableFaceId', 'face-other'],
    ['triangleIndex', 13]
  ] as const)('拒绝不匹配的 %s', (key, value) => {
    expect(() => applyCadSurfaceHitResult(selection(), { ...result(), [key]: value }))
      .toThrow('与当前选择不一致');
  });

  it('拒绝非有限 UV，失败时不伪造 UV 并恢复网格预览', () => {
    expect(() => applyCadSurfaceHitResult(selection(), {
      ...result(), surfaceUv: { u: Number.NaN, v: 5 }
    })).toThrow('包含无效数值');
    const failed = failCadSurfaceHitSelection(selection(), '测试解析失败');
    expect(failed.hit).toMatchObject({
      surfaceUv: null, uvBounds: null, precision: 'mesh', resolutionStatus: 'failed',
      resolutionError: '测试解析失败', pointDistanceMm: null, normalDot: null
    });
  });
});
