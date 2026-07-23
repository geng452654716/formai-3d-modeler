import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformBedGuide,
  createPrintPlatformBoundarySegment,
  createPrintPlatformGridGuide,
  createPrintPlatformOverlay,
  createPrintPlatformRectanglePoints,
  resolvePrintPlatformBedGuide,
  resolvePrintPlatformGridGuide
} from './printPlatformOverlay';
import type {
  PrintPlatformBoundaryPreview,
  PrintPlatformSafetyAreaPreview
} from './printOrientation';

function boundary(): PrintPlatformBoundaryPreview {
  return {
    boundsMm: { minimumX: 90, maximumX: 140, minimumZ: -20, maximumZ: 30, width: 50, depth: 50 },
    platformBoundsMm: { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 },
    marginsMm: { left: 218, right: -12, front: 98, back: 108 },
    overflowMm: { left: 0, right: 12, front: 0, back: 0 },
    fitsPlatform: false,
    minimumMarginMm: -12,
    centerDeltaMm: { x: -115, z: -5 },
    targetHorizontalPositionMm: { x: -115, z: -5 },
    alreadyCentered: false
  };
}

function safety(overrides: Partial<PrintPlatformSafetyAreaPreview> = {}): PrintPlatformSafetyAreaPreview {
  return {
    safetyMarginMm: 10,
    effectivePlatformBoundsMm: {
      minimumX: -118,
      maximumX: 118,
      minimumZ: -118,
      maximumZ: 118,
      width: 236,
      depth: 236
    },
    marginsMm: { left: 208, right: -22, front: 88, back: 98 },
    overflowMm: { left: 0, right: 22, front: 0, back: 0 },
    fitsEffectiveArea: false,
    canFitEffectiveArea: true,
    minimumMarginMm: -22,
    correctionDeltaMm: { x: -22, z: 0 },
    ...overrides
  };
}

const genericSource = {
  identity: 'uploaded-stl:revision-7:position-90',
  objectId: 'uploaded-model-42',
  objectLabel: '任意上传模型'
};

describe('打印平台三维视口叠加协议', () => {
  it('完整复制物理平台、安全区域和对象占地且不修改来源预览', () => {
    const originalBoundary = boundary();
    const originalSafety = safety();
    const boundarySnapshot = structuredClone(originalBoundary);
    const safetySnapshot = structuredClone(originalSafety);

    const overlay = createPrintPlatformOverlay(genericSource, originalBoundary, originalSafety);

    expect(overlay).toMatchObject({
      sourceIdentity: genericSource.identity,
      objectId: genericSource.objectId,
      objectLabel: genericSource.objectLabel,
      safetyMarginMm: 10,
      status: 'overflow',
      overflow: { left: false, right: true, front: false, back: false }
    });
    expect(overlay.platformBoundsMm).toEqual(originalBoundary.platformBoundsMm);
    expect(overlay.effectiveBoundsMm).toEqual({ minimumX: -118, maximumX: 118, minimumZ: -118, maximumZ: 118 });
    expect(overlay.objectBoundsMm).toEqual({ minimumX: 90, maximumX: 140, minimumZ: -20, maximumZ: 30 });
    expect(originalBoundary).toEqual(boundarySnapshot);
    expect(originalSafety).toEqual(safetySnapshot);
  });

  it('区分位于安全区域、单轴越界、双轴越界和对象过大', () => {
    const inside = createPrintPlatformOverlay(genericSource, boundary(), safety({
      marginsMm: { left: 20, right: 30, front: 25, back: 25 },
      overflowMm: { left: 0, right: 0, front: 0, back: 0 },
      fitsEffectiveArea: true,
      minimumMarginMm: 20,
      correctionDeltaMm: { x: 0, z: 0 }
    }));
    expect(inside.status).toBe('inside');
    expect(inside.overflow).toEqual({ left: false, right: false, front: false, back: false });

    const doubleAxis = createPrintPlatformOverlay(genericSource, boundary(), safety({
      overflowMm: { left: 3, right: 0, front: 7, back: 0 }
    }));
    expect(doubleAxis.status).toBe('overflow');
    expect(doubleAxis.overflow).toEqual({ left: true, right: false, front: true, back: false });

    const tooLarge = createPrintPlatformOverlay(genericSource, boundary(), safety({
      overflowMm: { left: 9, right: 12, front: 0, back: 0 },
      fitsEffectiveArea: false,
      canFitEffectiveArea: false,
      correctionDeltaMm: { x: 0, z: 0 }
    }));
    expect(tooLarge.status).toBe('too-large');
    expect(tooLarge.canFitEffectiveArea).toBe(false);
  });

  it('安全边距变化会生成新的安全区域边界', () => {
    const first = createPrintPlatformOverlay(genericSource, boundary(), safety());
    const second = createPrintPlatformOverlay(genericSource, boundary(), safety({
      safetyMarginMm: 20,
      effectivePlatformBoundsMm: {
        minimumX: -108,
        maximumX: 108,
        minimumZ: -108,
        maximumZ: 108,
        width: 216,
        depth: 216
      }
    }));

    expect(first.effectiveBoundsMm.maximumX).toBe(118);
    expect(second.effectiveBoundsMm.maximumX).toBe(108);
    expect(second.safetyMarginMm).toBe(20);
  });

  it('使用通用来源身份并拒绝空身份或非有限边界', () => {
    expect(createPrintPlatformOverlay(genericSource, boundary(), safety()).objectLabel).toBe('任意上传模型');
    expect(() => createPrintPlatformOverlay({ ...genericSource, objectId: '' }, boundary(), safety()))
      .toThrow('打印平台叠加对象身份不能为空');
    expect(() => createPrintPlatformOverlay(genericSource, {
      ...boundary(),
      boundsMm: { ...boundary().boundsMm, maximumX: Number.NaN }
    }, safety())).toThrow('当前对象占地边界maximumX必须是有限毫米数值');
  });

  it('按物理平台真实毫米边界派生床面尺寸、中心十字和前侧 Z 正标识', () => {
    const overlay = createPrintPlatformOverlay(genericSource, boundary(), safety());
    const guide = createPrintPlatformBedGuide(overlay);

    expect(guide).toMatchObject({
      sourceIdentity: genericSource.identity,
      centerMm: { x: 0, y: 0.015, z: 0 },
      widthMm: 256,
      depthMm: 256,
      centerCrossHalfLengthMm: 20.48,
      frontLabel: '前侧（Z 正）',
      frontLabelPositionMm: { x: 104, y: 0.24, z: 120 }
    });
    expect(guide.centerCrossSegments).toEqual([
      [[-20.48, 0.04, 0], [20.48, 0.04, 0]],
      [[0, 0.04, -20.48], [0, 0.04, 20.48]]
    ]);
  });

  it('非对称平台仍使用真实中心且前侧始终对应最大 Z', () => {
    const guide = createPrintPlatformBedGuide({
      sourceIdentity: '通用模型:非对称平台',
      platformBoundsMm: { minimumX: -80, maximumX: 120, minimumZ: -40, maximumZ: 160 }
    });

    expect(guide.centerMm).toEqual({ x: 20, y: 0.015, z: 60 });
    expect(guide.widthMm).toBe(200);
    expect(guide.depthMm).toBe(200);
    expect(guide.frontLabelPositionMm).toEqual({ x: 100, y: 0.24, z: 152 });
  });

  it('来源清除、非法数值和退化边界不会生成床面几何', () => {
    expect(resolvePrintPlatformBedGuide(null)).toBeNull();
    expect(resolvePrintPlatformBedGuide({
      sourceIdentity: '旧来源',
      platformBoundsMm: { minimumX: -1, maximumX: Number.NaN, minimumZ: -1, maximumZ: 1 }
    })).toBeNull();
    expect(resolvePrintPlatformBedGuide({
      sourceIdentity: '退化来源',
      platformBoundsMm: { minimumX: 2, maximumX: 2, minimumZ: -1, maximumZ: 1 }
    })).toBeNull();
    expect(() => createPrintPlatformBedGuide({
      sourceIdentity: '',
      platformBoundsMm: { minimumX: -1, maximumX: 1, minimumZ: -1, maximumZ: 1 }
    })).toThrow('打印平台床面来源身份不能为空');

    const next = resolvePrintPlatformBedGuide({
      sourceIdentity: '新来源',
      platformBoundsMm: { minimumX: -2, maximumX: 2, minimumZ: -3, maximumZ: 3 }
    });
    expect(next?.sourceIdentity).toBe('新来源');
  });

  it('为 P1S 物理边界生成 10 毫米次网格、50 毫米主网格和中文刻度', () => {
    const guide = createPrintPlatformGridGuide(createPrintPlatformOverlay(genericSource, boundary(), safety()));

    expect(guide).toMatchObject({
      sourceIdentity: genericSource.identity,
      minorSpacingMm: 10,
      majorSpacingMm: 50
    });
    expect(guide.minorLines).toHaveLength(40);
    expect(guide.majorLines).toHaveLength(10);
    expect(guide.ticks).toHaveLength(10);
    expect(guide.majorLines.filter((line) => line.axis === 'x').map((line) => line.coordinateMm))
      .toEqual([-100, -50, 0, 50, 100]);
    expect(guide.majorLines.find((line) => line.axis === 'x' && line.coordinateMm === 0)?.points)
      .toEqual([[0, 0.025, -128], [0, 0.025, 128]]);
    expect(guide.ticks.find((tick) => tick.axis === 'x' && tick.coordinateMm === 0)).toEqual({
      axis: 'x',
      coordinateMm: 0,
      text: 'X 轴 0 毫米（原点）',
      positionMm: { x: 0, y: 0.22, z: -122 }
    });
    expect(guide.ticks.find((tick) => tick.axis === 'z' && tick.coordinateMm === 50)).toEqual({
      axis: 'z',
      coordinateMm: 50,
      text: 'Z 轴 +50 毫米',
      positionMm: { x: -122, y: 0.22, z: 50 }
    });
  });

  it('非对称且跨零点的平台保持真实原点、正负方向和边界裁剪', () => {
    const guide = createPrintPlatformGridGuide({
      sourceIdentity: '通用模型:跨零平台',
      platformBoundsMm: { minimumX: -83, maximumX: 117, minimumZ: -37, maximumZ: 163 }
    });

    expect(guide.majorLines.filter((line) => line.axis === 'x').map((line) => line.coordinateMm))
      .toEqual([-50, 0, 50, 100]);
    expect(guide.majorLines.filter((line) => line.axis === 'z').map((line) => line.coordinateMm))
      .toEqual([0, 50, 100, 150]);
    expect(guide.minorLines.find((line) => line.axis === 'x' && line.coordinateMm === -80)?.points)
      .toEqual([[-80, 0.025, -37], [-80, 0.025, 163]]);
    expect(guide.majorLines.find((line) => line.axis === 'z' && line.coordinateMm === 150)?.points)
      .toEqual([[-83, 0.025, 150], [117, 0.025, 150]]);
    expect(guide.ticks.map((tick) => tick.text)).toContain('X 轴 -50 毫米');
    expect(guide.ticks.map((tick) => tick.text)).toContain('Z 轴 +150 毫米');
  });

  it('不跨零点的平台只显示范围内的网格与刻度且不伪造原点', () => {
    const guide = createPrintPlatformGridGuide({
      sourceIdentity: '通用模型:偏移平台',
      platformBoundsMm: { minimumX: 12, maximumX: 84, minimumZ: -37, maximumZ: -12 }
    });

    expect([...guide.minorLines, ...guide.majorLines]
      .filter((line) => line.axis === 'x')
      .map((line) => line.coordinateMm)
      .sort((left, right) => left - right)).toEqual([20, 30, 40, 50, 60, 70, 80]);
    expect([...guide.minorLines, ...guide.majorLines]
      .filter((line) => line.axis === 'z')
      .map((line) => line.coordinateMm)
      .sort((left, right) => left - right)).toEqual([-30, -20]);
    expect(guide.ticks.map((tick) => tick.text)).toEqual(['X 轴 +50 毫米']);
    expect(guide.ticks.some((tick) => tick.coordinateMm === 0)).toBe(false);
  });

  it('来源清除、非法退化或异常超大边界不会生成网格几何', () => {
    expect(resolvePrintPlatformGridGuide(null)).toBeNull();
    expect(resolvePrintPlatformGridGuide({
      sourceIdentity: '非法来源',
      platformBoundsMm: { minimumX: Number.NaN, maximumX: 10, minimumZ: -10, maximumZ: 10 }
    })).toBeNull();
    expect(resolvePrintPlatformGridGuide({
      sourceIdentity: '退化来源',
      platformBoundsMm: { minimumX: 0, maximumX: 0, minimumZ: -10, maximumZ: 10 }
    })).toBeNull();
    expect(resolvePrintPlatformGridGuide({
      sourceIdentity: '异常超大来源',
      platformBoundsMm: { minimumX: -10_000, maximumX: 10_000, minimumZ: -10, maximumZ: 10 }
    })).toBeNull();
    expect(() => createPrintPlatformGridGuide({
      sourceIdentity: '',
      platformBoundsMm: { minimumX: -10, maximumX: 10, minimumZ: -10, maximumZ: 10 }
    })).toThrow('打印平台网格来源身份不能为空');

    expect(resolvePrintPlatformGridGuide({
      sourceIdentity: '新网格来源',
      platformBoundsMm: { minimumX: -20, maximumX: 20, minimumZ: -20, maximumZ: 20 }
    })?.sourceIdentity).toBe('新网格来源');
  });

  it('按真实毫米坐标生成闭合矩形和四个方向的高亮边段', () => {
    const bounds = { minimumX: -8, maximumX: 12, minimumZ: -6, maximumZ: 14 };
    expect(createPrintPlatformRectanglePoints(bounds, 0.08)).toEqual([
      [-8, 0.08, -6],
      [12, 0.08, -6],
      [12, 0.08, 14],
      [-8, 0.08, 14],
      [-8, 0.08, -6]
    ]);
    expect(createPrintPlatformBoundarySegment(bounds, 'left', 0.1)).toEqual([[-8, 0.1, -6], [-8, 0.1, 14]]);
    expect(createPrintPlatformBoundarySegment(bounds, 'right', 0.1)).toEqual([[12, 0.1, -6], [12, 0.1, 14]]);
    expect(createPrintPlatformBoundarySegment(bounds, 'front', 0.1)).toEqual([[-8, 0.1, 14], [12, 0.1, 14]]);
    expect(createPrintPlatformBoundarySegment(bounds, 'back', 0.1)).toEqual([[-8, 0.1, -6], [12, 0.1, -6]]);
  });
});
