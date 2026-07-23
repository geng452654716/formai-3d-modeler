import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformManualLayoutSession,
  movePrintPlatformManualLayoutObject,
  setPrintPlatformManualLayoutSnapToGrid
} from './printPlatformManualLayout';
import {
  createPrintPlatformMultiObjectPreview,
  type PrintPlatformObjectFootprintCandidate
} from './printPlatformMultiObject';

const platform = { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 };
const effective = { minimumX: 0, maximumX: 40, minimumZ: 0, maximumZ: 40 };

function candidate(objectId: string, minimumX: number, minimumZ: number, width = 8, depth = 8): PrintPlatformObjectFootprintCandidate {
  return {
    sourceIdentity: `任意来源:${objectId}`,
    objectId,
    objectLabel: `零件 ${objectId}`,
    sourceKind: 'cad',
    printable: true,
    visible: true,
    boundsMm: {
      minimumX,
      maximumX: minimumX + width,
      minimumZ,
      maximumZ: minimumZ + depth
    }
  };
}

function session(
  candidates = [candidate('a', 0, 0), candidate('b', 14, 0)],
  locked: string[] = [],
  clearanceMm = 2,
  snapToGrid = true
) {
  return createPrintPlatformManualLayoutSession(
    createPrintPlatformMultiObjectPreview('手工排布测试来源', candidates, platform, effective),
    effective,
    clearanceMm,
    locked,
    snapToGrid
  );
}

describe('打印平台多对象手工排布', () => {
  it('锁定对象不可拖动且不会产生变更', () => {
    const initial = session(undefined, ['a']);
    const moved = movePrintPlatformManualLayoutObject(initial, 'a', { x: 20, z: 20 });

    expect(moved).toBe(initial);
    expect(moved.placements.find((placement) => placement.objectId === 'a')).toMatchObject({
      locked: true,
      moved: false,
      deltaMm: { x: 0, z: 0 }
    });
  });

  it('固定 1 毫米吸附并保留吸附前坐标', () => {
    const moved = movePrintPlatformManualLayoutObject(session(), 'a', { x: 9.49, z: 10.51 });
    const placement = moved.placements.find((candidatePlacement) => candidatePlacement.objectId === 'a')!;

    expect(placement.rawCenterMm).toEqual({ x: 9.49, z: 10.51 });
    expect(placement.targetCenterMm).toEqual({ x: 9, z: 11 });
    expect(placement.deltaMm).toEqual({ x: 5, z: 7 });
  });

  it('关闭吸附后恢复最后一次原始交点位置', () => {
    const moved = movePrintPlatformManualLayoutObject(session(), 'a', { x: 9.49, z: 10.51 });
    const unsnapped = setPrintPlatformManualLayoutSnapToGrid(moved, false);

    expect(unsnapped.placements.find((placement) => placement.objectId === 'a')).toMatchObject({
      rawCenterMm: { x: 9.49, z: 10.51 },
      targetCenterMm: { x: 9.49, z: 10.51 },
      deltaMm: { x: 5.49, z: 6.51 }
    });
  });

  it('对象边界刚好位于安全区域临界值时允许确认', () => {
    const moved = movePrintPlatformManualLayoutObject(session([candidate('a', 8, 8)]), 'a', { x: 4, z: 4 });

    expect(moved.placements[0]).toMatchObject({ status: 'valid', targetBoundsMm: { minimumX: 0, maximumX: 8, minimumZ: 0, maximumZ: 8 } });
    expect(moved.canApply).toBe(true);
  });

  it('越界候选显示中文原因并禁止确认', () => {
    const moved = movePrintPlatformManualLayoutObject(session([candidate('a', 8, 8)]), 'a', { x: 2, z: 2 });

    expect(moved.placements[0]).toMatchObject({ status: 'outside' });
    expect(moved.placements[0].failureReason).toContain('超出打印平台安全有效区域');
    expect(moved.canApply).toBe(false);
  });

  it('与其他对象重叠时双方标红并禁止确认', () => {
    const moved = movePrintPlatformManualLayoutObject(session(), 'a', { x: 18, z: 4 });

    expect(moved.invalidObjectCount).toBe(2);
    expect(moved.placements.every((placement) => placement.status === 'overlap')).toBe(true);
    expect(moved.canApply).toBe(false);
  });

  it('未满足安全间距时报告间距不足', () => {
    const moved = movePrintPlatformManualLayoutObject(session(), 'a', { x: 9, z: 4 });

    expect(moved.placements.map((placement) => placement.status)).toEqual(['too-close', 'too-close']);
    expect(moved.placements[0].failureReason).toContain('2.00 毫米安全间距');
  });

  it('可以连续拖动多个对象并形成一个可确认会话', () => {
    const initial = session([
      candidate('a', 0, 0),
      candidate('b', 14, 0),
      candidate('c', 28, 0)
    ]);
    const first = movePrintPlatformManualLayoutObject(initial, 'a', { x: 4, z: 16 });
    const second = movePrintPlatformManualLayoutObject(first, 'b', { x: 18, z: 16 });

    expect(second).toMatchObject({ changedObjectCount: 2, invalidObjectCount: 0, canApply: true });
    expect(second.placements.filter((placement) => placement.moved).map((placement) => placement.objectId)).toEqual(['a', 'b']);
  });

  it('未知对象身份不会改变会话', () => {
    const initial = session();
    expect(movePrintPlatformManualLayoutObject(initial, '不存在', { x: 20, z: 20 })).toBe(initial);
  });
});
