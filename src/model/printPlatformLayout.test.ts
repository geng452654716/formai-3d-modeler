import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformMultiObjectLayoutPlan,
  createPrintPlatformMultiObjectPreview,
  type PrintPlatformObjectFootprintCandidate
} from './printPlatformMultiObject';

const platform = { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 };

function candidate(
  objectId: string,
  widthMm: number,
  depthMm: number,
  minimumX = 0,
  minimumZ = 0
): PrintPlatformObjectFootprintCandidate {
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
    }
  };
}

function preview(
  candidates: PrintPlatformObjectFootprintCandidate[],
  effective = { minimumX: -20, maximumX: 20, minimumZ: -20, maximumZ: 20 }
) {
  return {
    effective,
    value: createPrintPlatformMultiObjectPreview('自动排布测试来源', candidates, platform, effective)
  };
}

describe('打印平台多对象自动排布计划', () => {
  it('单对象从安全区域左后角生成目标边界和水平位移', () => {
    const source = preview([candidate('主体', 10, 8, 5, 6)]);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, source.effective, 2);

    expect(plan).toMatchObject({
      status: 'ready',
      objectCount: 1,
      movedObjectCount: 1,
      rowCount: 1,
      fitsEffectiveArea: true,
      combinedTargetBoundsMm: { minimumX: -20, maximumX: -10, minimumZ: -20, maximumZ: -12 }
    });
    expect(plan.placements[0]).toMatchObject({
      objectId: '主体',
      deltaMm: { x: -25, z: -26 },
      targetBoundsMm: { minimumX: -20, maximumX: -10, minimumZ: -20, maximumZ: -12 },
      moved: true,
      rowIndex: 0
    });
  });

  it('多个不同尺寸对象按稳定身份排列并保持安全间距', () => {
    const source = preview([
      candidate('c', 5, 4),
      candidate('a', 10, 8),
      candidate('b', 6, 12)
    ]);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, source.effective, 2);

    expect(plan.placements.map((placement) => placement.objectId)).toEqual(['a', 'b', 'c']);
    expect(plan.placements.map((placement) => placement.targetBoundsMm)).toEqual([
      { minimumX: -20, maximumX: -10, minimumZ: -20, maximumZ: -12 },
      { minimumX: -8, maximumX: -2, minimumZ: -20, maximumZ: -8 },
      { minimumX: 0, maximumX: 5, minimumZ: -20, maximumZ: -16 }
    ]);
  });

  it('当前行放不下时按本行最大深度加安全间距换行', () => {
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 30 };
    const source = preview([
      candidate('a', 12, 8),
      candidate('b', 10, 5),
      candidate('c', 8, 6)
    ], effective);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, effective, 2);

    expect(plan.rowCount).toBe(2);
    expect(plan.placements.map((placement) => ({ id: placement.objectId, row: placement.rowIndex, bounds: placement.targetBoundsMm }))).toEqual([
      { id: 'a', row: 0, bounds: { minimumX: 0, maximumX: 12, minimumZ: 0, maximumZ: 8 } },
      { id: 'b', row: 1, bounds: { minimumX: 0, maximumX: 10, minimumZ: 10, maximumZ: 15 } },
      { id: 'c', row: 1, bounds: { minimumX: 12, maximumX: 20, minimumZ: 10, maximumZ: 16 } }
    ]);
  });

  it('对象和换行结果刚好贴合安全区域边界时仍可排布', () => {
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 22 };
    const source = preview([
      candidate('a', 20, 10),
      candidate('b', 20, 10)
    ], effective);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, effective, 2);

    expect(plan.status).toBe('ready');
    expect(plan.combinedTargetBoundsMm).toEqual(effective);
    expect(plan.fitsEffectiveArea).toBe(true);
  });

  it('单对象本身超过安全有效区域时返回全中文失败原因且不输出部分方案', () => {
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 };
    const source = preview([candidate('超大件', 21, 10)], effective);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, effective, 2);

    expect(plan.status).toBe('unplaceable');
    expect(plan.placements).toEqual([]);
    expect(plan.failureReason).toContain('大于安全有效区域');
    expect(plan.failureReason).toContain('无法在不旋转对象的前提下排布');
  });

  it('全部行空间不足时返回放置对象和可恢复建议', () => {
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 };
    const source = preview([
      candidate('a', 20, 10),
      candidate('b', 20, 10)
    ], effective);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, effective, 2);

    expect(plan.status).toBe('unplaceable');
    expect(plan.placements).toEqual([]);
    expect(plan.failureReason).toContain('无法容纳全部 2 个对象');
    expect(plan.failureReason).toContain('减小对象安全间距');
  });

  it('候选顺序不改变排布来源身份、对象顺序和目标位置', () => {
    const candidates = [candidate('a', 7, 4), candidate('上传-b', 9, 6), candidate('c', 5, 3)];
    const first = preview(candidates);
    const second = preview([...candidates].reverse());
    const firstPlan = createPrintPlatformMultiObjectLayoutPlan(first.value, first.effective, 3);
    const secondPlan = createPrintPlatformMultiObjectLayoutPlan(second.value, second.effective, 3);

    expect(secondPlan.sourceIdentity).toBe(firstPlan.sourceIdentity);
    expect(secondPlan.placements).toEqual(firstPlan.placements);
  });

  it('非对称安全区域严格从其最小 X/Z 坐标开始排布', () => {
    const effective = { minimumX: -7, maximumX: 31, minimumZ: 11, maximumZ: 41 };
    const source = preview([candidate('a', 5, 6)], effective);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, effective, 1.5);

    expect(plan.placements[0].targetBoundsMm).toEqual({
      minimumX: -7,
      maximumX: -2,
      minimumZ: 11,
      maximumZ: 17
    });
  });

  it('对象已经位于目标位置时不要求创建空版本', () => {
    const effective = { minimumX: 0, maximumX: 20, minimumZ: 0, maximumZ: 20 };
    const source = preview([candidate('a', 10, 8, 0, 0)], effective);
    const plan = createPrintPlatformMultiObjectLayoutPlan(source.value, effective, 2);

    expect(plan.movedObjectCount).toBe(0);
    expect(plan.placements[0]).toMatchObject({ moved: false, deltaMm: { x: 0, z: 0 }, distanceMm: 0 });
  });

  it('空集合安全返回 empty，并拒绝非法间距和失效边界', () => {
    const source = preview([]);
    expect(createPrintPlatformMultiObjectLayoutPlan(source.value, source.effective, 2)).toMatchObject({
      status: 'empty',
      objectCount: 0,
      placements: [],
      failureReason: null
    });
    expect(() => createPrintPlatformMultiObjectLayoutPlan(source.value, source.effective, -1)).toThrow('自动排布安全间距');
    expect(() => createPrintPlatformMultiObjectLayoutPlan(source.value, source.effective, Number.NaN)).toThrow('自动排布安全间距');
    expect(() => createPrintPlatformMultiObjectLayoutPlan(source.value, {
      minimumX: 0,
      maximumX: Number.POSITIVE_INFINITY,
      minimumZ: 0,
      maximumZ: 20
    }, 2)).toThrow('有限毫米边界');
  });
});
