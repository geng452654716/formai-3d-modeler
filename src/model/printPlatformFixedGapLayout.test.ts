import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformFixedGapPlan,
  type PrintPlatformFixedGapAnchorMode,
  type PrintPlatformFixedGapOperation
} from './printPlatformFixedGapLayout';
import type { PrintPlatformMultiObjectPreview, PrintPlatformObjectFootprint } from './printPlatformMultiObject';

function candidate(
  id: string,
  x: number,
  z: number,
  width = 10,
  depth = 8,
  sourceIdentity = `来源:${id}`
): PrintPlatformObjectFootprint {
  const boundsMm = {
    minimumX: x,
    maximumX: x + width,
    minimumZ: z,
    maximumZ: z + depth
  };
  return {
    sourceIdentity,
    objectId: id,
    objectLabel: id,
    sourceKind: 'cad',
    boundsMm,
    widthMm: width,
    depthMm: depth,
    currentRotationYDeg: 0,
    rotated90BoundsMm: boundsMm,
    rotated90WidthMm: width,
    rotated90DepthMm: depth,
    fitsPlatform: true,
    canFitPlatform: true,
    fitsEffectiveArea: true,
    canFitEffectiveArea: true,
    status: 'inside'
  };
}

function preview(objects: PrintPlatformObjectFootprint[]): PrintPlatformMultiObjectPreview {
  return {
    sourceIdentity: '预览来源',
    objects,
    objectCount: objects.length,
    combinedBoundsMm: null,
    combinedWidthMm: 0,
    combinedDepthMm: 0,
    combinedFitsPlatform: true,
    combinedCanFitPlatform: true,
    combinedFitsEffectiveArea: true,
    combinedCanFitEffectiveArea: true,
    combinedStatus: 'inside',
    excludedCounts: { reference: 0, hidden: 0, invalidGeometry: 0 }
  };
}

const effective = { minimumX: 0, maximumX: 120, minimumZ: 0, maximumZ: 120 };

function plan(
  objects: PrintPlatformObjectFootprint[],
  selected: string[],
  operation: PrintPlatformFixedGapOperation,
  options: { clearance?: number; gap?: number; locked?: string[]; bounds?: typeof effective; anchorMode?: PrintPlatformFixedGapAnchorMode } = {}
) {
  return createPrintPlatformFixedGapPlan(
    preview(objects),
    options.bounds ?? effective,
    options.clearance ?? 2,
    options.gap ?? 4,
    options.locked ?? [],
    selected,
    operation,
    options.anchorMode
  );
}

function selectedPlacement(result: ReturnType<typeof plan>, id: string) {
  return result.placements.find((placement) => placement.objectId === id)!;
}

describe('打印平台多对象固定净间距分布', () => {
  it('X 方向按不同尺寸对象边界递推并保持首对象不动', () => {
    const result = plan([
      candidate('first', 10, 20, 12, 10),
      candidate('second', 50, 24, 20, 12),
      candidate('third', 90, 28, 8, 6)
    ], ['third', 'first', 'second'], 'distribute-x-fixed-gap', { clearance: 3, gap: 5 });

    expect(selectedPlacement(result, 'first')).toMatchObject({ fixedAnchor: true, moved: false, sequenceIndex: 0 });
    expect(selectedPlacement(result, 'second')).toMatchObject({
      targetCenterMm: { x: 37, z: 30 },
      deltaMm: { x: -23, z: 0 },
      previousGapMm: 5,
      sequenceIndex: 1
    });
    expect(selectedPlacement(result, 'third')).toMatchObject({
      targetCenterMm: { x: 56, z: 31 },
      deltaMm: { x: -38, z: 0 },
      previousGapMm: 5,
      sequenceIndex: 2
    });
    expect(result.canApply).toBe(true);
  });

  it('Z 方向只改变 Z 中心并保持 X 中心', () => {
    const result = plan([
      candidate('first', 10, 10, 12, 6),
      candidate('second', 40, 40, 8, 14)
    ], ['first', 'second'], 'distribute-z-fixed-gap', { clearance: 2, gap: 7 });

    expect(selectedPlacement(result, 'second')).toMatchObject({
      targetCenterMm: { x: 44, z: 30 },
      deltaMm: { x: 0, z: -17 },
      previousGapMm: 7
    });
  });


  it('默认锚点模式保持首对象，兼容既有调用', () => {
    const result = plan([
      candidate('first', 10, 10),
      candidate('second', 40, 30)
    ], ['first', 'second'], 'distribute-x-fixed-gap', { clearance: 2, gap: 6 });

    expect(result.anchorMode).toBe('keep-first');
    expect(selectedPlacement(result, 'first')).toMatchObject({ fixedAnchor: true, moved: false });
    expect(selectedPlacement(result, 'second').fixedAnchor).toBe(false);
    expect(result.sourceIdentity).toContain('锚点:keep-first');
  });

  it('保持末对象时沿 X 轴反向按不同尺寸边界递推', () => {
    const result = plan([
      candidate('first', 10, 20, 12, 10),
      candidate('second', 50, 24, 20, 12),
      candidate('third', 90, 28, 8, 6)
    ], ['third', 'first', 'second'], 'distribute-x-fixed-gap', {
      clearance: 3,
      gap: 5,
      anchorMode: 'keep-last'
    });

    expect(result.anchorMode).toBe('keep-last');
    expect(selectedPlacement(result, 'third')).toMatchObject({ fixedAnchor: true, moved: false, sequenceIndex: 2 });
    expect(selectedPlacement(result, 'second')).toMatchObject({
      targetCenterMm: { x: 75, z: 30 },
      deltaMm: { x: 15, z: 0 },
      previousGapMm: 5,
      sequenceIndex: 1
    });
    expect(selectedPlacement(result, 'first')).toMatchObject({
      targetCenterMm: { x: 54, z: 25 },
      deltaMm: { x: 38, z: 0 },
      previousGapMm: null,
      sequenceIndex: 0
    });
    expect(result.canApply).toBe(true);
  });

  it('保持末对象时沿 Z 轴反向递推且保持 X 中心', () => {
    const result = plan([
      candidate('first', 10, 10, 12, 6),
      candidate('second', 40, 40, 8, 14)
    ], ['first', 'second'], 'distribute-z-fixed-gap', {
      clearance: 2,
      gap: 7,
      anchorMode: 'keep-last'
    });

    expect(selectedPlacement(result, 'second')).toMatchObject({ fixedAnchor: true, moved: false });
    expect(selectedPlacement(result, 'first')).toMatchObject({
      targetCenterMm: { x: 16, z: 30 },
      deltaMm: { x: 0, z: 17 }
    });
    expect(selectedPlacement(result, 'second').previousGapMm).toBe(7);
  });

  it('锚点模式进入来源身份，末端模式输入顺序不改变结果', () => {
    const objects = [candidate('a', 10, 10), candidate('b', 40, 30, 12), candidate('c', 80, 50, 8)];
    const first = plan(objects, ['a', 'b', 'c'], 'distribute-x-fixed-gap', {
      clearance: 2,
      gap: 8,
      anchorMode: 'keep-last'
    });
    const second = plan([...objects].reverse(), ['c', 'b', 'a'], 'distribute-x-fixed-gap', {
      clearance: 2,
      gap: 8,
      anchorMode: 'keep-last'
    });
    const keepFirst = plan(objects, ['a', 'b', 'c'], 'distribute-x-fixed-gap', { clearance: 2, gap: 8 });

    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(first.sourceIdentity).toContain('锚点:keep-last');
    expect(first.sourceIdentity).not.toBe(keepFirst.sourceIdentity);
    expect(second.placements.map((placement) => [placement.objectId, placement.targetBoundsMm]).sort())
      .toEqual(first.placements.map((placement) => [placement.objectId, placement.targetBoundsMm]).sort());
  });

  it('中心相同时使用稳定身份和对象 ID 决定空间顺序', () => {
    const result = plan([
      candidate('z', 10, 10, 10, 8, '来源:z'),
      candidate('a-2', 10, 30, 10, 8, '来源:a'),
      candidate('a-1', 10, 50, 10, 8, '来源:a')
    ], ['z', 'a-2', 'a-1'], 'distribute-x-fixed-gap', { clearance: 0, gap: 2 });

    expect(selectedPlacement(result, 'a-1').sequenceIndex).toBe(0);
    expect(selectedPlacement(result, 'a-2').sequenceIndex).toBe(1);
    expect(selectedPlacement(result, 'z').sequenceIndex).toBe(2);
  });

  it('输入顺序不会改变结果和来源身份', () => {
    const objects = [candidate('a', 10, 10), candidate('b', 40, 30, 12), candidate('fixed', 90, 90)];
    const first = plan(objects, ['a', 'b'], 'distribute-x-fixed-gap', { clearance: 2, gap: 8 });
    const second = plan([...objects].reverse(), ['b', 'a'], 'distribute-x-fixed-gap', { clearance: 2, gap: 8 });

    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(second.placements.map((placement) => [placement.objectId, placement.targetBoundsMm]).sort())
      .toEqual(first.placements.map((placement) => [placement.objectId, placement.targetBoundsMm]).sort());
  });

  it('拒绝小于安全间距的目标净间距', () => {
    const result = plan([candidate('a', 10, 10), candidate('b', 40, 30)], ['a', 'b'], 'distribute-x-fixed-gap', {
      clearance: 4,
      gap: 3.99
    });

    expect(result).toMatchObject({ status: 'invalid', canApply: false });
    expect(result.failureReason).toContain('不得小于当前 4.00 毫米安全间距');
  });

  it('拒绝选择不足和已选锁定对象', () => {
    const objects = [candidate('a', 10, 10), candidate('b', 40, 30)];
    const insufficient = plan(objects, ['a'], 'distribute-x-fixed-gap');
    const locked = plan(objects, ['a', 'b'], 'distribute-x-fixed-gap', { locked: ['b'] });

    expect(insufficient.failureReason).toContain('至少需要选择 2 个');
    expect(locked.failureReason).toContain('处于锁定状态');
  });

  it('目标越界时整批禁止确认', () => {
    const result = plan([
      candidate('first', 80, 10, 12),
      candidate('second', 95, 30, 20)
    ], ['first', 'second'], 'distribute-x-fixed-gap', { clearance: 2, gap: 12, bounds: { ...effective, maximumX: 110 } });

    expect(selectedPlacement(result, 'second').status).toBe('outside');
    expect(result).toMatchObject({ status: 'invalid', canApply: false });
  });

  it('未选对象和锁定对象继续参与重叠与安全间距校验', () => {
    const overlap = plan([
      candidate('first', 10, 10),
      candidate('moving', 60, 10),
      candidate('fixed', 24, 10)
    ], ['first', 'moving'], 'distribute-x-fixed-gap', { clearance: 0, gap: 4 });
    const tooClose = plan([
      candidate('first', 10, 10),
      candidate('moving', 60, 10),
      candidate('locked', 35, 10)
    ], ['first', 'moving'], 'distribute-x-fixed-gap', { clearance: 4, gap: 4, locked: ['locked'] });

    expect(selectedPlacement(overlap, 'moving').status).toBe('overlap');
    expect(selectedPlacement(overlap, 'moving').conflictObjectIds).toContain('fixed');
    expect(selectedPlacement(tooClose, 'moving').status).toBe('too-close');
    expect(selectedPlacement(tooClose, 'moving').conflictObjectIds).toContain('locked');
  });

  it('已满足固定净间距时不允许创建空版本', () => {
    const result = plan([
      candidate('a', 10, 10, 10),
      candidate('b', 25, 30, 12)
    ], ['a', 'b'], 'distribute-x-fixed-gap', { clearance: 2, gap: 5 });

    expect(result).toMatchObject({ status: 'ready', changedObjectCount: 0, canApply: false });
    expect(result.failureReason).toContain('不会改变任何已选对象');
  });

  it('拒绝负数和非有限目标净间距', () => {
    const objects = preview([candidate('a', 10, 10), candidate('b', 40, 30)]);
    expect(() => createPrintPlatformFixedGapPlan(objects, effective, 2, -1, [], ['a', 'b'], 'distribute-x-fixed-gap')).toThrow('目标净间距');
    expect(() => createPrintPlatformFixedGapPlan(objects, effective, 2, Number.NaN, [], ['a', 'b'], 'distribute-x-fixed-gap')).toThrow('目标净间距');
  });
});
