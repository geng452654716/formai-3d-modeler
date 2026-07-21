import { describe, expect, it } from 'vitest';
import type { DetectedInterface, ImageCalibration } from './imageRecognition';
import {
  buildMultiViewCalibrationResult,
  canApplyMultiViewCalibration,
  flattenMatchedInterfaces,
  ignoreMatchedInterface,
  matchInterfacesAcrossViews,
  mergeEstimatedParameterChanges,
  restoreIgnoredInterface,
  reviewMatchedInterface,
  splitMatchedInterface,
  type ReferenceViewRecord,
  type ReferenceViewType
} from './multiViewCalibration';

function calibration(mmPerPixel: number): ImageCalibration {
  return {
    imageWidthPx: 1000,
    imageHeightPx: 800,
    pointA: { xPercent: 10, yPercent: 50, xPixel: 100, yPixel: 400 },
    pointB: { xPercent: 60, yPercent: 50, xPixel: 600, yPixel: 400 },
    pixelDistance: 500,
    realDistanceMm: 500 * mmPerPixel,
    mmPerPixel
  };
}

function detectedInterface(overrides: Partial<DetectedInterface> = {}): DetectedInterface {
  return {
    id: 'usb-main',
    type: 'USB-C',
    side: '接口面',
    positionXPercent: 50,
    positionYPercent: 65,
    widthMm: 12,
    heightMm: 5,
    horizontalOffsetMm: 0,
    bottomOffsetMm: 2,
    confidence: 0.94,
    requiresOpening: true,
    ...overrides
  };
}

function view(
  id: string,
  viewType: ReferenceViewType,
  mmPerPixel: number,
  interfaces: DetectedInterface[] = [],
  parameterValue?: number
): ReferenceViewRecord {
  return {
    id,
    fileName: `${id}.jpg`,
    viewType,
    calibration: calibration(mmPerPixel),
    importedAt: '2026-07-17T00:00:00.000Z',
    analysis: {
      summary: '测试识别结果',
      objectType: '测试元件',
      confidence: 0.9,
      estimatedParameters: parameterValue === undefined ? [] : [{
        parameter: 'boardLength',
        value: parameterValue,
        reason: '照片尺寸估算'
      }],
      interfaces,
      warnings: []
    }
  };
}

describe('多视角联合尺度', () => {
  it('少于两个已标定视角时不允许声称完成联合标定', () => {
    const result = buildMultiViewCalibrationResult([view('front', 'front', 0.1)]);
    expect(result.status).toBe('insufficient');
    expect(result.warnings[0]).toContain('至少需要两张');
  });

  it('使用中位数融合多个视角的毫米比例', () => {
    const result = buildMultiViewCalibrationResult([
      view('front', 'front', 0.1),
      view('left', 'left', 0.11),
      view('top', 'top', 0.3)
    ]);
    expect(result.fusedMmPerPixel).toBeCloseTo(0.11);
  });

  it('尺度最大偏差超过 10% 时显示中文复核警告', () => {
    const result = buildMultiViewCalibrationResult([
      view('front', 'front', 0.1),
      view('side', 'left', 0.14)
    ]);
    expect(result.status).toBe('warning');
    expect(result.warnings.some((warning) => warning.includes('超过 10%'))).toBe(true);
  });
});

describe('跨视角接口匹配', () => {
  it('相同稳定 ID 的接口跨视角合并并标记为已匹配', () => {
    const matches = matchInterfacesAcrossViews([
      view('front', 'front', 0.1, [detectedInterface()]),
      view('top', 'top', 0.1, [detectedInterface({ side: '顶部可见边缘' })])
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchStatus).toBe('matched');
    expect(matches[0].matchMethod).toBe('same-id');
    expect(matches[0].observations).toHaveLength(2);
  });

  it('不同 ID 但类型和尺寸接近时只形成待确认候选', () => {
    const matches = matchInterfacesAcrossViews([
      view('front', 'front', 0.1, [detectedInterface({ id: 'front-usb' })]),
      view('left', 'left', 0.1, [detectedInterface({ id: 'left-usb', widthMm: 11.5, heightMm: 5.2 })])
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchStatus).toBe('needs-confirmation');
    expect(matches[0].matchMethod).toBe('similar-size');
  });

  it('只在单一视角出现的接口仍会保留', () => {
    const result = buildMultiViewCalibrationResult([
      view('front', 'front', 0.1, [detectedInterface({ id: 'single-led', type: 'LED' })]),
      view('back', 'back', 0.1)
    ]);
    expect(result.matchedInterfaces).toHaveLength(1);
    expect(result.matchedInterfaces[0].matchMethod).toBe('single-view');
    expect(flattenMatchedInterfaces(result)[0].type).toBe('LED');
  });
});

describe('多视角尺寸参数融合', () => {
  it('同一尺寸参数取中位数而不是按照片顺序覆盖', () => {
    expect(mergeEstimatedParameterChanges([
      view('front', 'front', 0.1, [], 58),
      view('back', 'back', 0.1, [], 60),
      view('top', 'top', 0.1, [], 80)
    ])).toEqual({ boardLength: 60 });
  });
});


describe('接口人工复核闭环', () => {
  function candidateResult() {
    return buildMultiViewCalibrationResult([
      view('front', 'front', 0.1, [detectedInterface({ id: 'front-usb' })]),
      view('left', 'left', 0.1, [detectedInterface({ id: 'left-usb', widthMm: 11.5, heightMm: 5.2 })])
    ]);
  }

  it('存在待确认接口时禁止直接应用联合结果', () => {
    expect(canApplyMultiViewCalibration(candidateResult())).toBe(false);
  });

  it('人工确认后清除待确认警告并允许应用', () => {
    const result = candidateResult();
    const reviewed = reviewMatchedInterface(result, result.matchedInterfaces[0].id);
    expect(reviewed.matchedInterfaces[0].matchStatus).toBe('matched');
    expect(reviewed.matchedInterfaces[0].matchMethod).toBe('manual-confirmation');
    expect(reviewed.warnings.some((warning) => warning.includes('需要人工确认'))).toBe(false);
    expect(canApplyMultiViewCalibration(reviewed)).toBe(true);
  });

  it('人工编辑后的接口尺寸和开孔要求进入扁平接口结果', () => {
    const result = candidateResult();
    const reviewed = reviewMatchedInterface(result, result.matchedInterfaces[0].id, {
      id: '人工确认-usb',
      widthMm: 13.2,
      heightMm: 5.8,
      horizontalOffsetMm: 1.5,
      requiresOpening: false
    });
    expect(flattenMatchedInterfaces(reviewed)[0]).toMatchObject({
      id: '人工确认-usb',
      widthMm: 13.2,
      heightMm: 5.8,
      horizontalOffsetMm: 1.5,
      requiresOpening: false
    });
  });

  it('忽略误识别后不再输出该接口，并可恢复原状态', () => {
    const result = candidateResult();
    const id = result.matchedInterfaces[0].id;
    const ignored = ignoreMatchedInterface(result, id);
    expect(flattenMatchedInterfaces(ignored)).toEqual([]);
    expect(canApplyMultiViewCalibration(ignored)).toBe(true);
    const restored = restoreIgnoredInterface(ignored, id);
    expect(restored.matchedInterfaces[0].matchStatus).toBe('needs-confirmation');
    expect(canApplyMultiViewCalibration(restored)).toBe(false);
  });

  it('将错误合并的跨视角候选拆成两个独立待确认接口', () => {
    const result = candidateResult();
    const split = splitMatchedInterface(result, result.matchedInterfaces[0].id);
    expect(split.matchedInterfaces).toHaveLength(2);
    expect(split.matchedInterfaces.every((item) => item.matchMethod === 'single-view')).toBe(true);
    expect(split.matchedInterfaces.every((item) => item.matchStatus === 'needs-confirmation')).toBe(true);
    expect(split.matchedInterfaces.map((item) => item.id)).toEqual(['front-usb', 'left-usb']);
  });

  it('按视角输出接口时只保留在该视角有观测的分组', () => {
    const result = buildMultiViewCalibrationResult([
      view('front', 'front', 0.1, [detectedInterface({ id: 'front-led', type: 'LED' })]),
      view('top', 'top', 0.1, [detectedInterface({ id: 'top-button', type: '按钮' })])
    ]);
    expect(flattenMatchedInterfaces(result, 'front').map((item) => item.id)).toEqual(['front-led']);
    expect(flattenMatchedInterfaces(result, 'top').map((item) => item.id)).toEqual(['top-button']);
  });
});
