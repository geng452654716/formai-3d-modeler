import { describe, expect, it } from 'vitest';
import {
  createPrintOrientationPresentation,
  evaluateAxisAlignedPrintOrientations,
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
