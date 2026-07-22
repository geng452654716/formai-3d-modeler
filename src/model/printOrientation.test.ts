import { describe, expect, it } from 'vitest';
import {
  createPrintBedPlacementPresentation,
  createPrintOrientationPresentation,
  createPrintPlatformCenterPresentation,
  evaluateAxisAlignedPrintOrientations,
  evaluatePrintBedPlacement,
  evaluatePrintPlatformBoundary,
  getPrintOrientationRotationDeg,
  isPrintOrientationRotationApplied
} from './printOrientation';

function boxMesh(width: number, depth: number, height: number) {
  const positions = [
    0, 0, 0,
    width, 0, 0,
    width, depth, 0,
    0, depth, 0,
    0, 0, height,
    width, 0, height,
    width, depth, height,
    0, depth, height
  ];
  const indices = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7
  ];
  return { positions, indices };
}

function reverseTriangleWinding(indices: number[]) {
  return indices.flatMap((_, offset) => offset % 3 === 0
    ? [indices[offset], indices[offset + 2], indices[offset + 1]]
    : []);
}

function triangularPrismMesh() {
  const positions = [
    0, 0, 0,
    20, 0, 0,
    20, 0, 10,
    0, 10, 0,
    20, 10, 0,
    20, 10, 10
  ];
  const indices = [
    0, 2, 1,
    3, 4, 5,
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    2, 0, 3, 2, 3, 5
  ];
  return { positions, indices };
}

describe('六向打印方向评估', () => {

  it('把六个候选映射为确定性的绝对 90 度对象旋转', () => {
    expect(getPrintOrientationRotationDeg('positive-z')).toEqual({ x: 0, y: 0, z: 0 });
    expect(getPrintOrientationRotationDeg('negative-z')).toEqual({ x: 180, y: 0, z: 0 });
    expect(getPrintOrientationRotationDeg('positive-y')).toEqual({ x: 90, y: 0, z: 0 });
    expect(getPrintOrientationRotationDeg('negative-y')).toEqual({ x: -90, y: 0, z: 0 });
    expect(getPrintOrientationRotationDeg('positive-x')).toEqual({ x: 0, y: 0, z: 90 });
    expect(getPrintOrientationRotationDeg('negative-x')).toEqual({ x: 0, y: 0, z: -90 });
  });

  it('按 360 度模等价识别已应用方向并拒绝其他旋转', () => {
    expect(isPrintOrientationRotationApplied({ x: 360, y: -720, z: 0 }, 'positive-z')).toBe(true);
    expect(isPrintOrientationRotationApplied({ x: -270, y: 360, z: 720 }, 'positive-y')).toBe(true);
    expect(isPrintOrientationRotationApplied({ x: 0, y: 0, z: 270 }, 'negative-x')).toBe(true);
    expect(isPrintOrientationRotationApplied({ x: 1, y: 0, z: 0 }, 'positive-z')).toBe(false);
  });

  it('创建推荐方向展示状态时只替换旋转并保留位置、缩放和颜色', () => {
    const result = createPrintOrientationPresentation({
      transform: {
        positionMm: { x: 12, y: -3, z: 4 },
        rotationDeg: { x: 17, y: 23, z: 42 },
        scale: 1.5
      },
      color: '#123456'
    }, 'positive-x');

    expect(result).toEqual({
      transform: {
        positionMm: { x: 12, y: -3, z: 4 },
        rotationDeg: { x: 0, y: 0, z: 90 },
        scale: 1.5
      },
      color: '#123456'
    });
  });

  it('按视口 Y 轴计算六个推荐旋转后的对象内归一化最低点', () => {
    const expectedMinimumHeight = {
      'positive-z': 0,
      'negative-z': -5,
      'positive-y': -5,
      'negative-y': -5,
      'positive-x': -10,
      'negative-x': -10
    } as const;

    Object.entries(expectedMinimumHeight).forEach(([id, minimumHeightMm]) => {
      const preview = evaluatePrintBedPlacement(boxMesh(20, 10, 5), {
        rotationDeg: getPrintOrientationRotationDeg(id as keyof typeof expectedMinimumHeight),
        positionMm: { x: 0, y: 0, z: 0 },
        normalizationSpace: 'object-local'
      });
      expect(preview.minimumHeightMm).toBeCloseTo(minimumHeightMm);
      expect(preview.requiredVerticalDeltaMm).toBeCloseTo(-minimumHeightMm);
    });
  });

  it('对象内归一化会叠加基础位置、当前位置和均匀缩放', () => {
    const preview = evaluatePrintBedPlacement(boxMesh(20, 10, 5), {
      rotationDeg: getPrintOrientationRotationDeg('negative-z'),
      positionMm: { x: 8, y: 2, z: -3 },
      uniformScale: 2,
      normalizationSpace: 'object-local',
      basePositionDisplayMm: { x: 0, y: 3, z: 0 }
    });

    expect(preview.minimumHeightMm).toBeCloseTo(-5);
    expect(preview.requiredVerticalDeltaMm).toBeCloseTo(5);
    expect(preview.targetVerticalPositionMm).toBeCloseTo(7);
    expect(preview.alreadyOnBed).toBe(false);
  });

  it('上传 STL 使用对象外归一化并保持与视口旋转中心一致', () => {
    const translated = boxMesh(20, 10, 5);
    const positions = translated.positions.map((value, index) => index % 3 === 2 ? value + 10 : value);
    const preview = evaluatePrintBedPlacement({ positions, indices: translated.indices }, {
      rotationDeg: getPrintOrientationRotationDeg('negative-z'),
      positionMm: { x: 0, y: 0, z: 0 },
      normalizationSpace: 'world'
    });

    expect(preview.minimumHeightMm).toBeCloseTo(-25);
    expect(preview.targetVerticalPositionMm).toBeCloseTo(25);
  });

  it('已经落床时不会产生重复位移，并且只替换垂直位置', () => {
    const preview = evaluatePrintBedPlacement(boxMesh(20, 10, 5), {
      rotationDeg: getPrintOrientationRotationDeg('positive-z'),
      positionMm: { x: 4, y: 0, z: -2 },
      normalizationSpace: 'object-local'
    });
    const presentation = createPrintBedPlacementPresentation({
      transform: {
        positionMm: { x: 4, y: 0, z: -2 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 1.25
      },
      color: '#123456'
    }, preview);

    expect(preview.alreadyOnBed).toBe(true);
    expect(preview.requiredVerticalDeltaMm).toBeCloseTo(0);
    expect(presentation).toEqual({
      transform: {
        positionMm: { x: 4, y: 0, z: -2 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 1.25
      },
      color: '#123456'
    });
  });

  it('拒绝自动落床中的无效网格、旋转、位置和缩放', () => {
    expect(() => evaluatePrintBedPlacement({ positions: [0, 0] }, {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: 0, z: 0 },
      normalizationSpace: 'object-local'
    })).toThrow('自动落床至少需要一个完整的三维顶点');
    expect(() => evaluatePrintBedPlacement(boxMesh(1, 1, 1), {
      rotationDeg: { x: Number.NaN, y: 0, z: 0 },
      positionMm: { x: 0, y: 0, z: 0 },
      normalizationSpace: 'object-local'
    })).toThrow('自动落床旋转必须是三个有限角度值');
    expect(() => evaluatePrintBedPlacement(boxMesh(1, 1, 1), {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
      normalizationSpace: 'object-local'
    })).toThrow('自动落床位置必须是三个有限毫米值');
    expect(() => evaluatePrintBedPlacement(boxMesh(1, 1, 1), {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: 0, z: 0 },
      uniformScale: 0,
      normalizationSpace: 'object-local'
    })).toThrow('自动落床的均匀缩放必须是大于 0 的有限值');
  });

  it('对象内归一化会按当前水平位置计算四边余量和居中目标', () => {
    const preview = evaluatePrintPlatformBoundary(boxMesh(20, 10, 5), {
      rotationDeg: getPrintOrientationRotationDeg('positive-z'),
      positionMm: { x: 10, y: 0, z: -20 },
      normalizationSpace: 'object-local',
      platformSizeMm: [256, 256]
    });

    expect(preview.boundsMm).toMatchObject({
      minimumX: 0,
      maximumX: 20,
      minimumZ: -25,
      maximumZ: -15,
      width: 20,
      depth: 10
    });
    expect(preview.marginsMm).toEqual({ left: 128, right: 108, front: 143, back: 103 });
    expect(preview.fitsPlatform).toBe(true);
    expect(preview.minimumMarginMm).toBe(103);
    expect(preview.centerDeltaMm).toEqual({ x: -10, z: 20 });
    expect(preview.targetHorizontalPositionMm).toEqual({ x: 0, z: 0 });
    expect(preview.alreadyCentered).toBe(false);
  });

  it('旋转与均匀缩放后的真实 X/Z 包围范围会识别右侧越界', () => {
    const preview = evaluatePrintPlatformBoundary(boxMesh(20, 10, 5), {
      rotationDeg: { x: 0, y: 90, z: 0 },
      positionMm: { x: 120, y: 0, z: 0 },
      uniformScale: 2,
      normalizationSpace: 'object-local'
    });

    expect(preview.boundsMm.width).toBeCloseTo(20);
    expect(preview.boundsMm.depth).toBeCloseTo(40);
    expect(preview.boundsMm.minimumX).toBeCloseTo(110);
    expect(preview.boundsMm.maximumX).toBeCloseTo(130);
    expect(preview.marginsMm.right).toBeCloseTo(-2);
    expect(preview.overflowMm).toEqual({ left: 0, right: 2, front: 0, back: 0 });
    expect(preview.fitsPlatform).toBe(false);
    expect(preview.centerDeltaMm.x).toBeCloseTo(-120);
  });

  it('任意上传 STL 使用对象外归一化计算居中的平台范围', () => {
    const source = boxMesh(20, 10, 5);
    const translatedPositions = source.positions.map((value, index) => {
      if (index % 3 === 0) return value + 50;
      if (index % 3 === 1) return value - 30;
      return value + 12;
    });
    const preview = evaluatePrintPlatformBoundary({ positions: translatedPositions, indices: source.indices }, {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: 0, z: 0 },
      normalizationSpace: 'world'
    });

    expect(preview.boundsMm.minimumX).toBeCloseTo(-10);
    expect(preview.boundsMm.maximumX).toBeCloseTo(10);
    expect(preview.boundsMm.minimumZ).toBeCloseTo(-5);
    expect(preview.boundsMm.maximumZ).toBeCloseTo(5);
    expect(preview.alreadyCentered).toBe(true);
    expect(preview.targetHorizontalPositionMm).toEqual({ x: 0, z: 0 });
  });

  it('分别识别左、右、前、后四个方向的越界量', () => {
    const positions = [
      { x: -125, z: 0, side: 'left', overflow: 7 },
      { x: 125, z: 0, side: 'right', overflow: 7 },
      { x: 0, z: 125, side: 'front', overflow: 2 },
      { x: 0, z: -125, side: 'back', overflow: 2 }
    ] as const;

    positions.forEach(({ x, z, side, overflow }) => {
      const preview = evaluatePrintPlatformBoundary(boxMesh(20, 10, 5), {
        rotationDeg: { x: 0, y: 0, z: 0 },
        positionMm: { x, y: 0, z },
        normalizationSpace: 'object-local'
      });
      expect(preview.overflowMm[side]).toBeCloseTo(overflow);
      expect(preview.fitsPlatform).toBe(false);
    });
  });

  it('平台居中展示状态只替换 X/Z 并保留 Y、旋转、缩放和颜色', () => {
    const preview = evaluatePrintPlatformBoundary(boxMesh(20, 10, 5), {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 12, y: 7, z: -9 },
      normalizationSpace: 'object-local'
    });
    const presentation = createPrintPlatformCenterPresentation({
      transform: {
        positionMm: { x: 12, y: 7, z: -9 },
        rotationDeg: { x: 90, y: -45, z: 180 },
        scale: 1.25
      },
      color: '#123456'
    }, preview);

    expect(preview.targetHorizontalPositionMm).toEqual({ x: 0, z: 0 });
    expect(presentation).toEqual({
      transform: {
        positionMm: { x: 0, y: 7, z: 0 },
        rotationDeg: { x: 90, y: -45, z: 180 },
        scale: 1.25
      },
      color: '#123456'
    });
  });

  it('已居中目标不会改变展示状态，并拒绝非有限水平目标', () => {
    const preview = evaluatePrintPlatformBoundary(boxMesh(20, 10, 5), {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: 4, z: 0 },
      normalizationSpace: 'object-local'
    });
    const current = {
      transform: {
        positionMm: { x: 0, y: 4, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 1
      },
      color: '#abcdef'
    };

    expect(preview.alreadyCentered).toBe(true);
    expect(createPrintPlatformCenterPresentation(current, preview)).toEqual(current);
    expect(() => createPrintPlatformCenterPresentation(current, {
      ...preview,
      targetHorizontalPositionMm: { x: Number.NaN, z: 0 }
    })).toThrow('打印平台居中目标位置必须是两个有限毫米值');
  });

  it('拒绝无效平台尺寸和平台边界分析输入', () => {
    expect(() => evaluatePrintPlatformBoundary(boxMesh(1, 1, 1), {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: 0, z: 0 },
      normalizationSpace: 'object-local',
      platformSizeMm: [256, 0]
    })).toThrow('打印平台尺寸必须是两个大于 0 的有限毫米值');
    expect(() => evaluatePrintPlatformBoundary({ positions: [0, 0] }, {
      rotationDeg: { x: 0, y: 0, z: 0 },
      positionMm: { x: 0, y: 0, z: 0 },
      normalizationSpace: 'object-local'
    })).toThrow('打印平台分析至少需要一个完整的三维顶点');
  });

  it('均匀缩放同步作用于尺寸、面积和体积', () => {
    const normal = evaluateAxisAlignedPrintOrientations(boxMesh(20, 10, 5));
    const scaled = evaluateAxisAlignedPrintOrientations(boxMesh(20, 10, 5), { uniformScale: 2 });
    const normalPositiveZ = normal.candidates.find((candidate) => candidate.id === 'positive-z')!;
    const scaledPositiveZ = scaled.candidates.find((candidate) => candidate.id === 'positive-z')!;

    expect(scaled.uniformScale).toBe(2);
    expect(scaledPositiveZ.widthMm).toBeCloseTo(normalPositiveZ.widthMm * 2);
    expect(scaledPositiveZ.depthMm).toBeCloseTo(normalPositiveZ.depthMm * 2);
    expect(scaledPositiveZ.heightMm).toBeCloseTo(normalPositiveZ.heightMm * 2);
    expect(scaledPositiveZ.contactAreaMm2).toBeCloseTo(normalPositiveZ.contactAreaMm2 * 4);
    expect(scaled.surfaceAreaMm2).toBeCloseTo(normal.surfaceAreaMm2 * 4);
    expect(scaled.volumeMm3).toBeCloseTo(normal.volumeMm3 * 8);
  });

  it('拒绝非有限、零或负数均匀缩放', () => {
    expect(() => evaluateAxisAlignedPrintOrientations(boxMesh(20, 10, 5), { uniformScale: 0 })).toThrow('均匀缩放必须是大于 0 的有限值');
    expect(() => evaluateAxisAlignedPrintOrientations(boxMesh(20, 10, 5), { uniformScale: -1 })).toThrow('均匀缩放必须是大于 0 的有限值');
    expect(() => evaluateAxisAlignedPrintOrientations(boxMesh(20, 10, 5), { uniformScale: Number.NaN })).toThrow('均匀缩放必须是大于 0 的有限值');
  });

  it('为长方体比较六向尺寸并推荐低高度大接触底面', () => {
    const result = evaluateAxisAlignedPrintOrientations(boxMesh(200, 100, 20));
    const positiveZ = result.candidates.find((candidate) => candidate.id === 'positive-z');

    expect(result.recommendedId).toBe('positive-z');
    expect(positiveZ).toMatchObject({
      widthMm: 200,
      depthMm: 100,
      heightMm: 20,
      fitsBuildVolume: true,
      supportAreaMm2: 0,
      contactAreaMm2: 20000,
      riskLevel: '低'
    });
    expect(result.candidates).toHaveLength(6);
  });

  it('索引网格和展开后的非索引 STL 三角面得到相同结果', () => {
    const indexed = boxMesh(60, 30, 12);
    const nonIndexedPositions = indexed.indices.flatMap((vertexIndex) => (
      indexed.positions.slice(vertexIndex * 3, vertexIndex * 3 + 3)
    ));

    const indexedResult = evaluateAxisAlignedPrintOrientations(indexed);
    const nonIndexedResult = evaluateAxisAlignedPrintOrientations({ positions: nonIndexedPositions });

    expect(nonIndexedResult).toEqual(indexedResult);
  });

  it('整体反转三角面绕序不会改变候选推荐和几何风险', () => {
    const source = triangularPrismMesh();
    const normal = evaluateAxisAlignedPrintOrientations(source);
    const reversed = evaluateAxisAlignedPrintOrientations({
      positions: source.positions,
      indices: reverseTriangleWinding(source.indices)
    });

    expect(reversed.recommendedId).toBe(normal.recommendedId);
    expect(reversed.candidates).toEqual(normal.candidates);
  });

  it('非对称斜面会产生不同悬垂风险并优先选择无需支撑的方向', () => {
    const result = evaluateAxisAlignedPrintOrientations(triangularPrismMesh());
    const positiveZ = result.candidates.find((candidate) => candidate.id === 'positive-z')!;
    const negativeZ = result.candidates.find((candidate) => candidate.id === 'negative-z')!;

    expect(positiveZ.supportAreaMm2).toBe(0);
    expect(negativeZ.supportAreaMm2).toBeGreaterThan(0);
    expect(result.recommendedId).toBe('positive-z');
  });

  it('模型任一方向仍有 300 毫米跨度时六个候选都拒绝 P1S 空间', () => {
    const result = evaluateAxisAlignedPrintOrientations(boxMesh(300, 20, 20));

    expect(result.recommendedId).toBeNull();
    expect(result.candidates.every((candidate) => !candidate.fitsBuildVolume)).toBe(true);
    expect(result.recommendedReason).toContain('建议先拆件或缩小模型');
  });

  it('拒绝退化、非有限和没有封闭体积的网格', () => {
    expect(() => evaluateAxisAlignedPrintOrientations({ positions: [0, 0, 0] })).toThrow('至少需要 4 个有效三角面顶点');
    expect(() => evaluateAxisAlignedPrintOrientations({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, Number.NaN],
      indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]
    })).toThrow('非有限毫米坐标');
    expect(() => evaluateAxisAlignedPrintOrientations({
      positions: [
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        0, 0, 0, 0, 1, 0, 1, 1, 0,
        0, 0, 0, 1, 1, 0, 1, 0, 0,
        1, 0, 0, 1, 1, 0, 0, 1, 0
      ]
    })).toThrow('具有三维体积的封闭模型');
  });
});
