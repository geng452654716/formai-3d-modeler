import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformMultiObjectPreview,
  createPrintPlatformMultiObjectRotationLayoutPlan,
  type PrintPlatformObjectFootprintCandidate
} from './printPlatformMultiObject';

const platform = { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 };

function candidate(
  objectId: string,
  widthMm: number,
  depthMm: number,
  options: {
    minimumX?: number;
    minimumZ?: number;
    currentRotationYDeg?: number;
    rotatedWidthMm?: number;
    rotatedDepthMm?: number;
  } = {}
): PrintPlatformObjectFootprintCandidate {
  const minimumX = options.minimumX ?? 0;
  const minimumZ = options.minimumZ ?? 0;
  const centerX = minimumX + widthMm / 2;
  const centerZ = minimumZ + depthMm / 2;
  const rotatedWidthMm = options.rotatedWidthMm ?? depthMm;
  const rotatedDepthMm = options.rotatedDepthMm ?? widthMm;
  return {
    sourceIdentity: `任意来源:${objectId}`,
    objectId,
    objectLabel: `零件 ${objectId}`,
    sourceKind: objectId.startsWith('上传') ? 'uploaded-stl' : 'cad',
    printable: true,
    visible: true,
    boundsMm: {
      minimumX,
      maximumX: minimumX + widthMm,
      minimumZ,
      maximumZ: minimumZ + depthMm
    },
    currentRotationYDeg: options.currentRotationYDeg ?? 0,
    rotated90BoundsMm: {
      minimumX: centerX - rotatedWidthMm / 2,
      maximumX: centerX + rotatedWidthMm / 2,
      minimumZ: centerZ - rotatedDepthMm / 2,
      maximumZ: centerZ + rotatedDepthMm / 2
    }
  };
}

function plan(
  candidates: PrintPlatformObjectFootprintCandidate[],
  effective: { minimumX: number; maximumX: number; minimumZ: number; maximumZ: number },
  clearanceMm = 0
) {
  const preview = createPrintPlatformMultiObjectPreview('旋转寻优测试来源', candidates, platform, effective);
  return createPrintPlatformMultiObjectRotationLayoutPlan(preview, effective, clearanceMm);
}

describe('打印平台多对象 90 度旋转寻优排布', () => {
  it('对象只有旋转 90 度后才能放入安全有效区域', () => {
    const result = plan([candidate('长条件', 18, 10, { currentRotationYDeg: 15 })], {
      minimumX: 0,
      maximumX: 12,
      minimumZ: 0,
      maximumZ: 20
    });

    expect(result).toMatchObject({ status: 'ready', rowCount: 1, rotatedObjectCount: 1, changedObjectCount: 1 });
    expect(result.placements[0]).toMatchObject({
      rotated: true,
      currentRotationYDeg: 15,
      targetRotationYDeg: 105,
      rotationDeltaYDeg: 90,
      targetBoundsMm: { minimumX: 0, maximumX: 10, minimumZ: 0, maximumZ: 18 }
    });
  });

  it('优先选择较少排布行数，即使需要旋转多个对象', () => {
    const result = plan([
      candidate('a', 12, 8),
      candidate('b', 12, 8)
    ], { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 30 }, 2);

    expect(result.rowCount).toBe(1);
    expect(result.rotatedObjectCount).toBe(2);
    expect(result.placements.map((placement) => placement.targetBoundsMm)).toEqual([
      { minimumX: 0, maximumX: 8, minimumZ: 0, maximumZ: 12 },
      { minimumX: 10, maximumX: 18, minimumZ: 0, maximumZ: 12 }
    ]);
  });

  it('行数相同时选择较小整体占地面积', () => {
    const result = plan([
      candidate('a', 12, 4),
      candidate('b', 4, 12)
    ], { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 });

    expect(result.rowCount).toBe(1);
    expect(result.combinedTargetAreaMm2).toBe(96);
    expect(result.placements.map((placement) => [placement.objectId, placement.rotated])).toEqual([
      ['a', true],
      ['b', false]
    ]);
  });

  it('评分相同时按稳定对象身份得到相同方案且抑制无意义旋转', () => {
    const candidates = [candidate('b', 8, 8), candidate('a', 8, 8)];
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 };
    const first = plan(candidates, effective, 2);
    const second = plan([...candidates].reverse(), effective, 2);

    expect(first.placements.map((placement) => placement.objectId)).toEqual(['a', 'b']);
    expect(first.placements.every((placement) => !placement.rotated)).toBe(true);
    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(second.placements).toEqual(first.placements);
  });

  it('非 0 当前角度保持其他轴语义并只增加 90 度', () => {
    const result = plan([candidate('斜放件', 14, 6, { currentRotationYDeg: -35 })], {
      minimumX: 0,
      maximumX: 8,
      minimumZ: 0,
      maximumZ: 16
    });

    expect(result.placements[0]).toMatchObject({
      currentRotationYDeg: -35,
      targetRotationYDeg: 55,
      rotationDeltaYDeg: 90
    });
  });

  it('无需旋转即可达到同等或更优评分时保持当前角度', () => {
    const result = plan([candidate('扁平件', 12, 6)], {
      minimumX: 0,
      maximumX: 20,
      minimumZ: 0,
      maximumZ: 20
    });

    expect(result.rotatedObjectCount).toBe(0);
    expect(result.placements[0]).toMatchObject({ rotated: false, rotationDeltaYDeg: 0, targetRotationYDeg: 0 });
  });

  it('两种朝向都过大时返回全中文失败原因且不返回部分方案', () => {
    const result = plan([candidate('超大件', 25, 24)], {
      minimumX: 0,
      maximumX: 20,
      minimumZ: 0,
      maximumZ: 20
    });

    expect(result.status).toBe('unplaceable');
    expect(result.placements).toEqual([]);
    expect(result.failureReason).toContain('两种朝向都大于安全有效区域');
  });

  it('单件均可放入但整体空间仍不足时返回旋转寻优失败建议', () => {
    const result = plan([
      candidate('a', 20, 12),
      candidate('b', 20, 12)
    ], { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 }, 2);

    expect(result.status).toBe('unplaceable');
    expect(result.placements).toEqual([]);
    expect(result.failureReason).toContain('逐个比较当前朝向与绕 Y 轴增加 90 度');
  });

  it('空集合和非法输入安全处理', () => {
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 };
    const emptyPreview = createPrintPlatformMultiObjectPreview('空旋转寻优来源', [], platform, effective);
    expect(createPrintPlatformMultiObjectRotationLayoutPlan(emptyPreview, effective, 2)).toMatchObject({
      status: 'empty',
      placements: [],
      rotatedObjectCount: 0,
      changedObjectCount: 0
    });
    expect(() => createPrintPlatformMultiObjectRotationLayoutPlan(emptyPreview, effective, -1)).toThrow('旋转寻优排布安全间距');
  });
});
