import { describe, expect, it } from 'vitest';
import { evaluateAxisAlignedPrintOrientations } from './printOrientation';

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
