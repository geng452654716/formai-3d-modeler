import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETERS } from './defaults';
import {
  buildInterfaceOpenings,
  inferInterfaceOpeningShape,
  resolveInterfaceOpeningForParameters
} from './interfaceOpenings';
import { buildMultiViewCalibrationResult, type ReferenceViewRecord } from './multiViewCalibration';
import type { DetectedInterface } from './imageRecognition';

function detectedInterface(overrides: Partial<DetectedInterface> = {}): DetectedInterface {
  return {
    id: '接口-1',
    type: 'USB-C',
    side: '正面',
    positionXPercent: 50,
    positionYPercent: 60,
    widthMm: 12,
    heightMm: 6,
    horizontalOffsetMm: 2,
    bottomOffsetMm: 3,
    confidence: 0.94,
    requiresOpening: true,
    ...overrides
  };
}

function view(
  viewType: ReferenceViewRecord['viewType'],
  interfaces: DetectedInterface[]
): ReferenceViewRecord {
  return {
    id: `view-${viewType}`,
    fileName: `${viewType}.png`,
    viewType,
    importedAt: '2026-07-17T00:00:00.000Z',
    calibration: {
      imageWidthPx: 1000,
      imageHeightPx: 800,
      pointA: { xPercent: 10, yPercent: 50, xPixel: 100, yPixel: 400 },
      pointB: { xPercent: 90, yPercent: 50, xPixel: 900, yPixel: 400 },
      pixelDistance: 800,
      realDistanceMm: 80,
      mmPerPixel: 0.1
    },
    analysis: {
      summary: '测试',
      objectType: '电子元件',
      confidence: 0.9,
      estimatedParameters: [],
      interfaces,
      warnings: []
    }
  };
}

describe('通用接口开孔协议', () => {
  it('按接口类型推断默认开孔形状，同时允许人工覆盖', () => {
    expect(inferInterfaceOpeningShape(detectedInterface())).toBe('rounded-rectangle');
    expect(inferInterfaceOpeningShape(detectedInterface({ type: 'LED' }))).toBe('circle');
    expect(inferInterfaceOpeningShape(detectedInterface({ type: '排针' }))).toBe('rectangle');
    expect(inferInterfaceOpeningShape(detectedInterface({ openingShape: 'slot' }))).toBe('slot');
  });

  it('把正面接口转换为以接口面中心为原点的毫米坐标', () => {
    const result = buildMultiViewCalibrationResult([view('front', [detectedInterface()])]);
    const built = buildInterfaceOpenings(result, DEFAULT_PARAMETERS);
    expect(built.warnings).toEqual([]);
    expect(built.openings).toHaveLength(1);
    expect(built.openings[0]).toMatchObject({
      id: '接口-1',
      face: 'front',
      shape: 'rounded-rectangle',
      widthMm: 12,
      heightMm: 6,
      centerUMm: 2,
      positionReference: 'face-center-bottom',
      horizontalOffsetMm: 2,
      bottomOffsetMm: 3,
      minimumEdgeMarginMm: 1.2,
      minimumSpacingMm: 1.2
    });
    expect(built.openings[0].centerVMm).toBeCloseTo(-0.3, 5);
  });

  it('外壳高度变化时按底边锚点重算侧面位置，不缩放开孔尺寸和物理偏移', () => {
    const result = buildMultiViewCalibrationResult([view('front', [detectedInterface()])]);
    const [opening] = buildInterfaceOpenings(result, DEFAULT_PARAMETERS).openings;
    const resolved = resolveInterfaceOpeningForParameters(opening, {
      ...DEFAULT_PARAMETERS,
      baseThickness: 4
    });

    expect(resolved.centerUMm).toBe(2);
    expect(resolved.centerVMm).toBeCloseTo(-1.3, 5);
    expect(resolved.widthMm).toBe(12);
    expect(resolved.heightMm).toBe(6);
    expect(resolved.bottomOffsetMm).toBe(3);
  });

  it('顶部和底部开孔按外壳宽度重算竖向坐标', () => {
    const result = buildMultiViewCalibrationResult([
      view('top', [detectedInterface({ side: '顶部' })])
    ]);
    const [opening] = buildInterfaceOpenings(result, DEFAULT_PARAMETERS).openings;
    expect(opening.centerVMm).toBeCloseTo(-10.3, 5);

    const resolved = resolveInterfaceOpeningForParameters(opening, {
      ...DEFAULT_PARAMETERS,
      boardWidth: 38
    });
    expect(resolved.centerVMm).toBeCloseTo(-15.3, 5);
  });

  it('老项目不含照片定位锚点时继续使用固定毫米坐标', () => {
    const result = buildMultiViewCalibrationResult([view('front', [detectedInterface()])]);
    const [opening] = buildInterfaceOpenings(result, DEFAULT_PARAMETERS).openings;
    const {
      positionReference: _positionReference,
      horizontalOffsetMm: _horizontalOffsetMm,
      bottomOffsetMm: _bottomOffsetMm,
      ...legacyOpening
    } = opening;
    const resolved = resolveInterfaceOpeningForParameters(legacyOpening, {
      ...DEFAULT_PARAMETERS,
      baseThickness: 4
    });

    expect(resolved.centerUMm).toBe(2);
    expect(resolved.centerVMm).toBeCloseTo(-0.3, 5);
  });

  it('圆孔使用较大识别尺寸作为直径', () => {
    const result = buildMultiViewCalibrationResult([
      view('right', [detectedInterface({ type: '按钮', side: '右侧', widthMm: 5, heightMm: 6 })])
    ]);
    const [opening] = buildInterfaceOpenings(result, DEFAULT_PARAMETERS).openings;
    expect(opening).toMatchObject({ face: 'right', shape: 'circle', widthMm: 6, heightMm: 6 });
  });

  it('忽略仅避让接口，并拒绝只来自透视图的开孔', () => {
    const noOpening = buildMultiViewCalibrationResult([
      view('front', [detectedInterface({ requiresOpening: false })])
    ]);
    expect(buildInterfaceOpenings(noOpening, DEFAULT_PARAMETERS).openings).toEqual([]);

    const perspective = buildMultiViewCalibrationResult([
      view('perspective', [detectedInterface({ side: '斜视可见接口' })])
    ]);
    const built = buildInterfaceOpenings(perspective, DEFAULT_PARAMETERS);
    expect(built.openings).toEqual([]);
    expect(built.warnings[0]).toContain('缺少可确定开孔面的正交视角');
  });
});
