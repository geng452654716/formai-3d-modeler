import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadFaceSelectionContext } from '../model/cadFaceSelection';
import type { CadSurfaceHitResult } from '../model/cadSurfaceHit';

const backendMocks = vi.hoisted(() => ({ resolveCadSurfaceHit: vi.fn() }));
vi.mock('../platform/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/backend')>();
  return { ...actual, resolveCadSurfaceHit: backendMocks.resolveCadSurfaceHit };
});

import { useModelStore } from './useModelStore';

const initialState = useModelStore.getState();

function selection(triangleIndex = 12): CadFaceSelectionContext {
  return {
    protocol: 'FormAI-CAD-局部编辑上下文', protocolVersion: 1, sourceKind: 'cad-face',
    selectionMode: 'click', revision: 'revision-1', units: 'mm',
    partBoundsMm: { shell: { x: 40, y: 30, z: 20 } },
    faces: [{ partId: 'shell', partLabel: '外壳', stableId: 'face-curve', geometryType: 'CYLINDER', areaMm2: 100, centerMm: [0, 0, 0] }],
    hit: {
      partId: 'shell', stableId: 'face-curve', triangleIndex,
      pointMm: { x: 10.01, y: 0, z: 5 }, normal: { x: 0.999, y: 0.01, z: 0 },
      meshPointMm: { x: 10.01, y: 0, z: 5 }, meshNormal: { x: 0.999, y: 0.01, z: 0 },
      surfaceUv: null, uvBounds: null, precision: 'mesh', resolutionStatus: 'resolving',
      pointDistanceMm: null, normalDot: null, resolutionError: null
    },
    camera: { positionMm: { x: 50, y: 50, z: 50 }, projectionMatrix: [], viewMatrix: [], viewportPixels: { width: 800, height: 600 } },
    screenshot: null, parameters: initialState.parameters,
    printer: { model: 'Bambu Lab P1S', buildVolumeMm: [256, 256, 256], nozzleMm: 0.4 }, warning: '测试'
  };
}

function result(triangleIndex = 12): CadSurfaceHitResult {
  return {
    status: 'ok', selectionRevision: 'revision-1', partId: 'shell', stableFaceId: 'face-curve', triangleIndex,
    geometryType: 'CYLINDER', projectedPointMm: { x: 10, y: 0, z: 5 }, pointDistanceMm: 0.01,
    maximumPointDistanceMm: 0.35, surfaceUv: { u: 0, v: 5 },
    uvBounds: { uMin: 0, uMax: Math.PI * 2, vMin: 0, vMax: 20 }, outwardNormal: { x: 1, y: 0, z: 0 },
    normalDot: 0.999, trimmedFaceState: 'inside', units: 'mm', kernel: 'OpenCascade 7.8 / CadQuery 2.6', limitations: []
  };
}

describe('曲面点击异步精确解析状态', () => {
  beforeEach(() => {
    backendMocks.resolveCadSurfaceHit.mockReset();
    useModelStore.setState({ ...initialState, cadFaceSelection: null }, true);
  });

  afterEach(() => useModelStore.setState(initialState, true));

  it('成功时只更新当前选择为 OpenCascade 精确值', async () => {
    const current = selection();
    useModelStore.getState().selectCadFaces(current);
    backendMocks.resolveCadSurfaceHit.mockResolvedValue(result());
    await useModelStore.getState().resolveCadSurfaceHitSelection(current);
    expect(backendMocks.resolveCadSurfaceHit).toHaveBeenCalledWith(expect.objectContaining({ triangleIndex: 12 }));
    expect(useModelStore.getState().cadFaceSelection?.hit).toMatchObject({
      precision: 'opencascade', resolutionStatus: 'resolved', surfaceUv: { u: 0, v: 5 },
      pointMm: { x: 10, y: 0, z: 5 }, meshPointMm: { x: 10.01, y: 0, z: 5 }
    });
  });

  it('失败时保留网格命中、记录中文错误且不生成 UV', async () => {
    const current = selection();
    useModelStore.getState().selectCadFaces(current);
    backendMocks.resolveCadSurfaceHit.mockRejectedValue(new Error('点击位置不在当前裁剪面内'));
    await useModelStore.getState().resolveCadSurfaceHitSelection(current);
    expect(useModelStore.getState().cadFaceSelection?.hit).toMatchObject({
      precision: 'mesh', resolutionStatus: 'failed', surfaceUv: null,
      resolutionError: '点击位置不在当前裁剪面内', pointMm: { x: 10.01, y: 0, z: 5 }
    });
  });

  it('旧请求晚返回时不能覆盖用户后续点击的新选择', async () => {
    let finish!: (value: CadSurfaceHitResult) => void;
    backendMocks.resolveCadSurfaceHit.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const oldSelection = selection(12);
    const newSelection = selection(13);
    useModelStore.getState().selectCadFaces(oldSelection);
    const pending = useModelStore.getState().resolveCadSurfaceHitSelection(oldSelection);
    useModelStore.getState().selectCadFaces(newSelection);
    finish(result(12));
    await pending;
    expect(useModelStore.getState().cadFaceSelection).toBe(newSelection);
    expect(useModelStore.getState().cadFaceSelection?.hit?.resolutionStatus).toBe('resolving');
  });
});
