import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformAlignmentPlan,
  type PrintPlatformAlignmentOperation
} from './printPlatformAlignmentLayout';
import {
  createPrintPlatformMultiObjectPreview,
  type PrintPlatformObjectFootprintCandidate
} from './printPlatformMultiObject';

const platform = { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 };
const effective = { minimumX: 0, maximumX: 100, minimumZ: 0, maximumZ: 100 };

function candidate(
  objectId: string,
  minimumX: number,
  minimumZ: number,
  width = 8,
  depth = 8,
  sourceIdentity = `任意来源:${objectId}`
): PrintPlatformObjectFootprintCandidate {
  return {
    sourceIdentity,
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

function plan(
  candidates: PrintPlatformObjectFootprintCandidate[],
  selected: string[],
  operation: PrintPlatformAlignmentOperation,
  options: { locked?: string[]; reference?: string | null; clearance?: number; bounds?: typeof effective } = {}
) {
  return createPrintPlatformAlignmentPlan(
    createPrintPlatformMultiObjectPreview('对齐与分布测试来源', candidates, platform, options.bounds ?? effective),
    options.bounds ?? effective,
    options.clearance ?? 2,
    options.locked ?? [],
    selected,
    operation,
    options.reference ?? null
  );
}

function selectedPlacement(result: ReturnType<typeof plan>, objectId: string) {
  return result.placements.find((placement) => placement.objectId === objectId)!;
}

describe('打印平台多对象对齐与等距分布', () => {
  it('默认使用稳定来源身份最小的已选对象作为基准', () => {
    const result = plan([
      candidate('a', 10, 10, 8, 8, '来源:z'),
      candidate('b', 30, 30, 12, 8, '来源:a')
    ], ['a', 'b'], 'align-x-min', { clearance: 0 });

    expect(result.referenceObjectId).toBe('b');
    expect(selectedPlacement(result, 'b')).toMatchObject({ reference: true, moved: false });
    expect(selectedPlacement(result, 'a').targetBoundsMm.minimumX).toBe(30);
  });

  it('允许显式切换基准并按不同尺寸对象的右边界对齐', () => {
    const result = plan([
      candidate('a', 10, 10, 8, 8),
      candidate('b', 30, 30, 12, 8)
    ], ['a', 'b'], 'align-x-max', { reference: 'a', clearance: 0 });

    expect(result.referenceObjectId).toBe('a');
    expect(selectedPlacement(result, 'b')).toMatchObject({
      targetBoundsMm: { minimumX: 6, maximumX: 18 },
      deltaMm: { x: -24, z: 0 }
    });
  });

  it('支持 Z 轴中心对齐且不改变 X 中心', () => {
    const result = plan([
      candidate('a', 10, 10),
      candidate('b', 40, 30, 10, 12)
    ], ['a', 'b'], 'align-z-center', { reference: 'a', clearance: 0 });

    expect(selectedPlacement(result, 'b')).toMatchObject({
      targetCenterMm: { x: 45, z: 14 },
      deltaMm: { x: 0, z: -22 }
    });
  });

  it('X 方向等距分布保持两端中心不动并移动中间对象', () => {
    const result = plan([
      candidate('left', 0, 10),
      candidate('middle', 20, 30),
      candidate('right', 72, 50)
    ], ['middle', 'right', 'left'], 'distribute-x-centers', { clearance: 0 });

    expect(selectedPlacement(result, 'left')).toMatchObject({ distributionEndpoint: true, moved: false });
    expect(selectedPlacement(result, 'right')).toMatchObject({ distributionEndpoint: true, moved: false });
    expect(selectedPlacement(result, 'middle')).toMatchObject({
      distributionEndpoint: false,
      targetCenterMm: { x: 40, z: 34 },
      deltaMm: { x: 16, z: 0 }
    });
    expect(result.canApply).toBe(true);
  });

  it('中心坐标相同时使用稳定身份决定分布顺序', () => {
    const result = plan([
      candidate('first', 0, 0, 8, 8, '来源:a'),
      candidate('tie-z', 20, 20, 8, 8, '来源:z'),
      candidate('tie-a', 40, 20, 8, 8, '来源:b'),
      candidate('last', 60, 60, 8, 8, '来源:y')
    ], ['first', 'tie-z', 'tie-a', 'last'], 'distribute-z-centers', { clearance: 0 });

    expect(selectedPlacement(result, 'tie-a').targetCenterMm.z).toBe(24);
    expect(selectedPlacement(result, 'tie-z').targetCenterMm.z).toBe(44);
  });

  it('未选和锁定对象继续作为重叠约束并禁止确认', () => {
    const result = plan([
      candidate('reference', 10, 10),
      candidate('moving', 40, 30),
      candidate('locked', 8, 30)
    ], ['reference', 'moving'], 'align-x-min', { reference: 'reference', locked: ['locked'], clearance: 0 });

    expect(selectedPlacement(result, 'moving')).toMatchObject({ status: 'overlap' });
    expect(selectedPlacement(result, 'moving').conflictObjectIds).toContain('locked');
    expect(result).toMatchObject({ status: 'invalid', canApply: false });
  });

  it('安全间距不足时返回中文原因且不生成部分可应用方案', () => {
    const result = plan([
      candidate('reference', 10, 10),
      candidate('moving', 40, 20),
      candidate('fixed', 20, 20)
    ], ['reference', 'moving'], 'align-x-min', { reference: 'reference', clearance: 3 });

    expect(selectedPlacement(result, 'moving').status).toBe('too-close');
    expect(result.failureReason).toContain('3.00 毫米安全间距');
    expect(result.canApply).toBe(false);
  });

  it('目标越界时显示中文原因并禁止确认', () => {
    const result = plan([
      candidate('reference', 2, 10, 4),
      candidate('wide', 40, 30, 12)
    ], ['reference', 'wide'], 'align-x-max', { reference: 'reference', clearance: 0 });

    expect(selectedPlacement(result, 'wide').status).toBe('outside');
    expect(result.failureReason).toContain('超出打印平台安全有效区域');
  });

  it('拒绝选择不足和被锁定的移动目标', () => {
    const insufficient = plan([candidate('a', 0, 0), candidate('b', 20, 20)], ['a'], 'align-x-center');
    const locked = plan([candidate('a', 0, 0), candidate('b', 20, 20)], ['a', 'b'], 'align-x-center', { locked: ['b'] });

    expect(insufficient.failureReason).toContain('至少需要选择 2 个');
    expect(locked.failureReason).toContain('处于锁定状态');
    expect(insufficient.canApply).toBe(false);
    expect(locked.canApply).toBe(false);
  });

  it('输入顺序不会改变对齐结果和来源身份', () => {
    const candidates = [
      candidate('a', 10, 10, 8, 8, '来源:b'),
      candidate('b', 40, 30, 12, 8, '来源:a'),
      candidate('fixed', 70, 70)
    ];
    const first = plan(candidates, ['a', 'b'], 'align-z-min', { clearance: 0 });
    const second = plan([...candidates].reverse(), ['b', 'a'], 'align-z-min', { clearance: 0 });

    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(second.placements.map((placement) => [placement.objectId, placement.targetBoundsMm]).sort())
      .toEqual(first.placements.map((placement) => [placement.objectId, placement.targetBoundsMm]).sort());
  });

  it('没有实际变化时保持只读且不允许创建空版本', () => {
    const result = plan([
      candidate('a', 10, 10),
      candidate('b', 30, 30)
    ], ['a', 'b'], 'align-x-min', { reference: 'a', clearance: 0 });
    const alreadyAligned = plan([
      candidate('a', 10, 10),
      candidate('b', 10, 30)
    ], ['a', 'b'], 'align-x-min', { reference: 'a', clearance: 0 });

    expect(result.changedObjectCount).toBe(1);
    expect(alreadyAligned).toMatchObject({ status: 'ready', changedObjectCount: 0, canApply: false });
    expect(alreadyAligned.failureReason).toContain('不会改变任何已选对象');
  });
});
