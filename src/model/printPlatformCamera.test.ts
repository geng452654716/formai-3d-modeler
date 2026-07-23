import { describe, expect, it } from 'vitest';
import {
  capturePrintPlatformReturnSnapshot,
  createNextPrintPlatformReturnViewRequest,
  createNextPrintPlatformViewRequest,
  createPrintPlatformTopView,
  mergePrintPlatformViewBounds,
  resolvePrintPlatformReturnSnapshot,
  resolvePrintPlatformTopViewRequest
} from './printPlatformCamera';
import type { PrintPlatformOverlay } from './printPlatformOverlay';

function overlay(overrides: Partial<PrintPlatformOverlay> = {}): PrintPlatformOverlay {
  return {
    sourceIdentity: 'uploaded-stl:revision-1:通用模型.stl',
    objectId: 'uploaded-model',
    objectLabel: '通用模型',
    safetyMarginMm: 5,
    platformBoundsMm: { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 },
    effectiveBoundsMm: { minimumX: -123, maximumX: 123, minimumZ: -123, maximumZ: 123 },
    objectBoundsMm: { minimumX: -31.3, maximumX: 31.3, minimumZ: -16.3, maximumZ: 16.3 },
    overflowMm: { left: 0, right: 0, front: 0, back: 0 },
    overflow: { left: false, right: false, front: false, back: false },
    fitsEffectiveArea: true,
    canFitEffectiveArea: true,
    status: 'inside',
    ...overrides
  };
}

describe('打印平台俯视相机计算', () => {
  it('区域内对象以完整物理平台为适配范围', () => {
    const result = createPrintPlatformTopView(overlay(), { widthPx: 1000, heightPx: 1000 });
    expect(result.boundsMm).toEqual({ minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 });
    expect(result.targetMm).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.cameraPositionMm.x).toBe(0);
    expect(result.cameraPositionMm.y).toBeGreaterThan(400);
    expect(result.cameraPositionMm.z).toBeGreaterThan(0);
  });

  it('单轴越界时把平台和对象占地并入同一视野', () => {
    const result = createPrintPlatformTopView(overlay({
      objectBoundsMm: { minimumX: 90, maximumX: 160, minimumZ: -20, maximumZ: 20 },
      status: 'overflow'
    }), { widthPx: 1200, heightPx: 800 });
    expect(result.boundsMm).toEqual({ minimumX: -128, maximumX: 160, minimumZ: -128, maximumZ: 128 });
    expect(result.targetMm.x).toBe(16);
    expect(result.targetMm.z).toBe(0);
  });

  it('双轴越界时按并集中心俯视', () => {
    const result = createPrintPlatformTopView(overlay({
      objectBoundsMm: { minimumX: 100, maximumX: 180, minimumZ: 110, maximumZ: 170 },
      status: 'overflow'
    }), { widthPx: 900, heightPx: 700 });
    expect(result.boundsMm).toEqual({ minimumX: -128, maximumX: 180, minimumZ: -128, maximumZ: 170 });
    expect(result.targetMm).toEqual({ x: 26, y: 0, z: 21 });
  });

  it('对象大于平台时完整采用对象外边界', () => {
    expect(mergePrintPlatformViewBounds(
      { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 },
      { minimumX: -240, maximumX: 260, minimumZ: -180, maximumZ: 220 }
    )).toEqual({ minimumX: -240, maximumX: 260, minimumZ: -180, maximumZ: 220 });
  });

  it('窄视口需要比宽视口更远的相机距离', () => {
    const narrow = createPrintPlatformTopView(overlay(), { widthPx: 500, heightPx: 1000 });
    const wide = createPrintPlatformTopView(overlay(), { widthPx: 1500, heightPx: 1000 });
    expect(narrow.distanceMm).toBeGreaterThan(wide.distanceMm);
    expect(narrow.viewportAspect).toBe(0.5);
    expect(wide.viewportAspect).toBe(1.5);
  });

  it('拒绝空来源、无效视口、无效视场角与退化边界', () => {
    expect(() => createPrintPlatformTopView({ ...overlay(), sourceIdentity: ' ' }, { widthPx: 800, heightPx: 600 })).toThrow('来源身份不能为空');
    expect(() => createPrintPlatformTopView(overlay(), { widthPx: 0, heightPx: 600 })).toThrow('视口宽度必须是正有限数值');
    expect(() => createPrintPlatformTopView(overlay(), { widthPx: 800, heightPx: 600 }, 180)).toThrow('视场角必须小于 179 度');
    expect(() => createPrintPlatformTopView(overlay({
      objectBoundsMm: { minimumX: Number.NaN, maximumX: 1, minimumZ: 0, maximumZ: 10 }
    }), { widthPx: 800, heightPx: 600 })).toThrow('对象占地边界最小 X 必须是有限毫米数值');
    expect(() => createPrintPlatformTopView(overlay({
      objectBoundsMm: { minimumX: 1, maximumX: 1, minimumZ: 0, maximumZ: 10 }
    }), { widthPx: 800, heightPx: 600 })).toThrow('对象占地边界必须具有正宽度和正深度');
  });

  it('连续请求保持递增编号，并复制本次分析边界', () => {
    const source = overlay();
    const first = createNextPrintPlatformViewRequest(null, source);
    const second = createNextPrintPlatformViewRequest(first, source);
    source.platformBoundsMm.maximumX = 999;

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(second.sourceIdentity).toBe(source.sourceIdentity);
    expect(second.overlay.platformBoundsMm.maximumX).toBe(128);
  });

  it('来源清理或变化后拒绝旧请求', () => {
    const source = overlay();
    const request = createNextPrintPlatformViewRequest(null, source);

    expect(resolvePrintPlatformTopViewRequest(
      request,
      { sourceIdentity: source.sourceIdentity },
      { widthPx: 1000, heightPx: 700 }
    )).not.toBeNull();
    expect(resolvePrintPlatformTopViewRequest(request, null, { widthPx: 1000, heightPx: 700 })).toBeNull();
    expect(resolvePrintPlatformTopViewRequest(
      request,
      { sourceIdentity: 'cad:revision-2' },
      { widthPx: 1000, heightPx: 700 }
    )).toBeNull();
  });

  it('超大对象和窗口尺寸变化仍返回有限安全距离', () => {
    const source = overlay({
      objectBoundsMm: {
        minimumX: -50_000,
        maximumX: 50_000,
        minimumZ: -20_000,
        maximumZ: 20_000
      }
    });
    const request = createNextPrintPlatformViewRequest(null, source);
    const wide = resolvePrintPlatformTopViewRequest(
      request,
      source,
      { widthPx: 1800, heightPx: 700 }
    );
    const narrow = resolvePrintPlatformTopViewRequest(
      request,
      source,
      { widthPx: 700, heightPx: 1800 }
    );

    expect(Number.isFinite(wide?.distanceMm)).toBe(true);
    expect(Number.isFinite(narrow?.distanceMm)).toBe(true);
    expect(wide?.distanceMm).toBeGreaterThanOrEqual(55);
    expect(narrow?.distanceMm).toBeGreaterThan(wide?.distanceMm ?? 0);
  });
});


describe('打印平台原视角临时快照', () => {
  const sourceIdentity = 'cad:revision-1';
  const originalPose = {
    cameraPositionMm: { x: 118, y: 82, z: 136 },
    targetMm: { x: 8, y: 4, z: -6 }
  };

  it('首次俯视前复制相机位置和控制器目标', () => {
    const pose = {
      cameraPositionMm: { ...originalPose.cameraPositionMm },
      targetMm: { ...originalPose.targetMm }
    };
    const snapshot = capturePrintPlatformReturnSnapshot(null, sourceIdentity, pose);
    pose.cameraPositionMm.x = 999;
    pose.targetMm.z = 999;

    expect(snapshot).toEqual({ sourceIdentity, ...originalPose });
  });

  it('同一来源重复俯视不覆盖最初快照', () => {
    const first = capturePrintPlatformReturnSnapshot(null, sourceIdentity, originalPose);
    const repeated = capturePrintPlatformReturnSnapshot(first, sourceIdentity, {
      cameraPositionMm: { x: 0, y: 500, z: 0.5 },
      targetMm: { x: 0, y: 0, z: 0 }
    });

    expect(repeated).toBe(first);
    expect(repeated.cameraPositionMm).toEqual(originalPose.cameraPositionMm);
  });

  it('来源变化后捕获新来源视角，并拒绝返回旧来源', () => {
    const first = capturePrintPlatformReturnSnapshot(null, sourceIdentity, originalPose);
    const next = capturePrintPlatformReturnSnapshot(first, 'cad:revision-2', {
      cameraPositionMm: { x: -20, y: 70, z: 90 },
      targetMm: { x: 2, y: 0, z: 3 }
    });

    expect(next.sourceIdentity).toBe('cad:revision-2');
    expect(resolvePrintPlatformReturnSnapshot(first, { sourceIdentity: 'cad:revision-2' })).toBeNull();
    expect(resolvePrintPlatformReturnSnapshot(next, { sourceIdentity: 'cad:revision-2' })).toBe(next);
    expect(resolvePrintPlatformReturnSnapshot(next, null)).toBeNull();
  });

  it('返回请求与俯视请求共享递增编号但保持独立类型', () => {
    const topView = createNextPrintPlatformViewRequest(null, overlay({ sourceIdentity }));
    const returnView = createNextPrintPlatformReturnViewRequest(topView, sourceIdentity);

    expect(topView.kind).toBe('top-view');
    expect(returnView).toEqual({ kind: 'return-view', id: 2, sourceIdentity });
  });

  it('拒绝空来源、非有限坐标和相机目标重合', () => {
    expect(() => capturePrintPlatformReturnSnapshot(null, ' ', originalPose)).toThrow('原视角来源身份不能为空');
    expect(() => capturePrintPlatformReturnSnapshot(null, sourceIdentity, {
      ...originalPose,
      cameraPositionMm: { x: Number.NaN, y: 1, z: 2 }
    })).toThrow('原视角相机位置X 必须是有限毫米数值');
    expect(() => capturePrintPlatformReturnSnapshot(null, sourceIdentity, {
      cameraPositionMm: { x: 1, y: 2, z: 3 },
      targetMm: { x: 1, y: 2, z: 3 }
    })).toThrow('相机位置不能与控制器目标重合');
    expect(() => createNextPrintPlatformReturnViewRequest(null, ' ')).toThrow('返回视角来源身份不能为空');
  });
});
