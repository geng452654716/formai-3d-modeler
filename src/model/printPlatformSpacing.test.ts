import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformMultiObjectPreview,
  createPrintPlatformMultiObjectSpacingDiagnostic,
  type PrintPlatformObjectFootprintCandidate
} from './printPlatformMultiObject';

const platform = { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 };
const effective = { minimumX: -123, maximumX: 123, minimumZ: -123, maximumZ: 123 };

function candidate(
  objectId: string,
  minimumX: number,
  maximumX: number,
  minimumZ: number,
  maximumZ: number
): PrintPlatformObjectFootprintCandidate {
  return {
    sourceIdentity: `cad:revision-1:${objectId}`,
    objectId,
    objectLabel: `零件 ${objectId}`,
    sourceKind: 'cad',
    printable: true,
    visible: true,
    boundsMm: { minimumX, maximumX, minimumZ, maximumZ }
  };
}

function preview(candidates: PrintPlatformObjectFootprintCandidate[]) {
  return createPrintPlatformMultiObjectPreview('analysis-spacing', candidates, platform, effective);
}

describe('打印平台多对象间距与重叠诊断', () => {
  it('计算水平重叠深度、面积和达到安全间距所需的最小分离量', () => {
    const diagnostic = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 8, 18, 4, 12)
    ]), 2);

    expect(diagnostic).toMatchObject({
      pairCount: 1,
      overlapCount: 1,
      tooCloseCount: 0,
      safeCount: 0,
      riskCount: 1,
      status: 'overlap'
    });
    expect(diagnostic.pairs[0]).toMatchObject({
      status: 'overlap',
      gapXMm: 0,
      gapZMm: 0,
      distanceMm: 0,
      overlapXMm: 2,
      overlapZMm: 6,
      overlapAreaMm2: 12,
      requiredAdditionalMm: 4,
      overlapBoundsMm: { minimumX: 8, maximumX: 10, minimumZ: 4, maximumZ: 10 }
    });
  });

  it('仅沿 X 轴分离时使用真实水平间距', () => {
    const diagnostic = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 13, 20, 3, 7)
    ]), 2);

    expect(diagnostic.pairs[0]).toMatchObject({
      status: 'safe',
      gapXMm: 3,
      gapZMm: 0,
      distanceMm: 3,
      requiredAdditionalMm: 0
    });
  });

  it('仅沿 Z 轴分离且间距不足时输出缺口', () => {
    const diagnostic = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 2, 8, 11.25, 20)
    ]), 2);

    expect(diagnostic.pairs[0]).toMatchObject({
      status: 'too-close',
      gapXMm: 0,
      gapZMm: 1.25,
      distanceMm: 1.25,
      requiredAdditionalMm: 0.75,
      overlapBoundsMm: null
    });
  });

  it('对角分离使用二维欧氏距离', () => {
    const diagnostic = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 13, 20, 14, 20)
    ]), 5.1);

    expect(diagnostic.pairs[0].gapXMm).toBe(3);
    expect(diagnostic.pairs[0].gapZMm).toBe(4);
    expect(diagnostic.pairs[0].distanceMm).toBe(5);
    expect(diagnostic.pairs[0].status).toBe('too-close');
    expect(diagnostic.pairs[0].requiredAdditionalMm).toBeCloseTo(0.1);
  });

  it('刚好满足安全间距时判定安全', () => {
    const diagnostic = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 12, 20, 0, 10)
    ]), 2);

    expect(diagnostic.pairs[0].distanceMm).toBe(2);
    expect(diagnostic.pairs[0].status).toBe('safe');
  });

  it('三个对象生成三个对象对并汇总全部状态', () => {
    const diagnostic = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 8, 18, 0, 10),
      candidate('c', 21, 30, 0, 10)
    ]), 4);

    expect(diagnostic).toMatchObject({
      pairCount: 3,
      overlapCount: 1,
      tooCloseCount: 1,
      safeCount: 1,
      riskCount: 2,
      status: 'overlap'
    });
  });

  it('候选顺序不改变诊断来源身份和对象对输出', () => {
    const candidates = [
      candidate('a', 0, 10, 0, 10),
      candidate('b', 12, 20, 0, 10),
      candidate('c', 25, 30, 0, 10)
    ];
    const firstPreview = preview(candidates);
    const secondPreview = { ...firstPreview, objects: [...firstPreview.objects].reverse() };

    expect(createPrintPlatformMultiObjectSpacingDiagnostic(firstPreview, 3)).toEqual(
      createPrintPlatformMultiObjectSpacingDiagnostic(secondPreview, 3)
    );
  });

  it('安全间距变化会改变诊断身份和风险状态', () => {
    const source = preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 13, 20, 0, 10)
    ]);
    const safe = createPrintPlatformMultiObjectSpacingDiagnostic(source, 2);
    const tooClose = createPrintPlatformMultiObjectSpacingDiagnostic(source, 4);

    expect(safe.sourceIdentity).not.toBe(tooClose.sourceIdentity);
    expect(safe.status).toBe('safe');
    expect(tooClose.status).toBe('too-close');
  });

  it('零个或一个可打印对象返回空对象对诊断', () => {
    const empty = createPrintPlatformMultiObjectSpacingDiagnostic(preview([]), 2);
    const single = createPrintPlatformMultiObjectSpacingDiagnostic(preview([
      candidate('a', 0, 10, 0, 10)
    ]), 2);

    expect(empty).toMatchObject({ pairCount: 0, riskCount: 0, status: 'empty' });
    expect(single).toMatchObject({ pairCount: 0, riskCount: 0, status: 'empty' });
  });

  it('拒绝负数、非有限安全间距和失效对象边界', () => {
    const source = preview([
      candidate('a', 0, 10, 0, 10),
      candidate('b', 12, 20, 0, 10)
    ]);
    expect(() => createPrintPlatformMultiObjectSpacingDiagnostic(source, -1)).toThrow(
      '对象安全间距必须是大于或等于 0 的有限毫米值'
    );
    expect(() => createPrintPlatformMultiObjectSpacingDiagnostic(source, Number.NaN)).toThrow(
      '对象安全间距必须是大于或等于 0 的有限毫米值'
    );
    const invalid = structuredClone(source);
    invalid.objects[0].boundsMm.maximumX = Number.POSITIVE_INFINITY;
    expect(() => createPrintPlatformMultiObjectSpacingDiagnostic(invalid, 2)).toThrow(
      '必须包含有限毫米边界'
    );
  });
});
