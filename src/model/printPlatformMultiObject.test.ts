import { describe, expect, it } from 'vitest';
import {
  createPrintPlatformMultiObjectPreview,
  createPrintPlatformMultiObjectSourceIdentity,
  type PrintPlatformObjectFootprintCandidate
} from './printPlatformMultiObject';

const platform = { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 };
const effective = { minimumX: -123, maximumX: 123, minimumZ: -123, maximumZ: 123 };

function candidate(
  objectId: string,
  boundsMm: PrintPlatformObjectFootprintCandidate['boundsMm'],
  overrides: Partial<PrintPlatformObjectFootprintCandidate> = {}
): PrintPlatformObjectFootprintCandidate {
  return {
    sourceIdentity: `cad:revision-1:${objectId}`,
    objectId,
    objectLabel: `零件 ${objectId}`,
    sourceKind: 'cad',
    printable: true,
    visible: true,
    boundsMm,
    ...overrides
  };
}

describe('打印平台多对象联合占地', () => {
  it('聚合两个任意对象的联合边界且不修改输入', () => {
    const candidates = [
      candidate('a', { minimumX: -30, maximumX: 10, minimumZ: -20, maximumZ: 5 }),
      candidate('b', { minimumX: 5, maximumX: 45, minimumZ: -8, maximumZ: 32 })
    ];
    const snapshot = structuredClone(candidates);
    const preview = createPrintPlatformMultiObjectPreview('analysis-1', candidates, platform, effective);

    expect(preview).toMatchObject({
      objectCount: 2,
      combinedBoundsMm: { minimumX: -30, maximumX: 45, minimumZ: -20, maximumZ: 32 },
      combinedWidthMm: 75,
      combinedDepthMm: 52,
      combinedFitsPlatform: true,
      combinedFitsEffectiveArea: true,
      combinedStatus: 'inside'
    });
    expect(candidates).toEqual(snapshot);
  });

  it('支持 CAD 与上传 STL 混合集合并保留通用中文名称', () => {
    const preview = createPrintPlatformMultiObjectPreview('analysis-mixed', [
      candidate('cad-part', { minimumX: -20, maximumX: 20, minimumZ: -10, maximumZ: 10 }, {
        objectLabel: '参数外壳',
        sourceKind: 'cad'
      }),
      candidate('uploaded-part', { minimumX: 30, maximumX: 60, minimumZ: 25, maximumZ: 55 }, {
        sourceIdentity: 'uploaded-stl:revision-8:uploaded-part',
        objectLabel: '用户上传装饰件',
        sourceKind: 'uploaded-stl'
      })
    ], platform, effective);

    expect(preview.objects.map((object) => [object.objectLabel, object.sourceKind])).toEqual([
      ['参数外壳', 'cad'],
      ['用户上传装饰件', 'uploaded-stl']
    ]);
  });

  it('分别过滤参考对象、隐藏对象和无效几何对象', () => {
    const preview = createPrintPlatformMultiObjectPreview('analysis-filter', [
      candidate('reference', null, {
        sourceIdentity: 'reference:board',
        objectLabel: '定位参考件',
        sourceKind: 'reference',
        printable: false
      }),
      candidate('hidden', { minimumX: 0, maximumX: 10, minimumZ: 0, maximumZ: 10 }, { visible: false }),
      candidate('missing', null),
      candidate('non-finite', { minimumX: 0, maximumX: Number.NaN, minimumZ: 0, maximumZ: 10 }),
      candidate('valid', { minimumX: -5, maximumX: 5, minimumZ: -6, maximumZ: 6 })
    ], platform, effective);

    expect(preview.objectCount).toBe(1);
    expect(preview.excludedCounts).toEqual({ reference: 1, hidden: 1, invalidGeometry: 2 });
    expect(preview.objects[0].objectId).toBe('valid');
  });

  it('区分单对象越界、尺寸过大以及整体联合越界', () => {
    const preview = createPrintPlatformMultiObjectPreview('analysis-overflow', [
      candidate('left', { minimumX: -130, maximumX: -100, minimumZ: -10, maximumZ: 10 }),
      candidate('right', { minimumX: 100, maximumX: 130, minimumZ: -10, maximumZ: 10 }),
      candidate('too-large', { minimumX: -140, maximumX: 140, minimumZ: -20, maximumZ: 20 })
    ], platform, effective);

    expect(preview.objects.map((object) => object.status)).toEqual(['overflow', 'overflow', 'too-large']);
    expect(preview.objects[0].fitsPlatform).toBe(false);
    expect(preview.objects[0].canFitPlatform).toBe(true);
    expect(preview.objects[2].canFitEffectiveArea).toBe(false);
    expect(preview.combinedStatus).toBe('too-large');
    expect(preview.combinedFitsPlatform).toBe(false);
  });

  it('联合边界覆盖两个分散摆放且仍位于安全区的对象', () => {
    const preview = createPrintPlatformMultiObjectPreview('analysis-combined-overflow', [
      candidate('left', { minimumX: -120, maximumX: -80, minimumZ: -10, maximumZ: 10 }),
      candidate('right', { minimumX: 80, maximumX: 120, minimumZ: -10, maximumZ: 10 })
    ], platform, effective);

    expect(preview.objects.every((object) => object.fitsEffectiveArea)).toBe(true);
    expect(preview.combinedWidthMm).toBe(240);
    expect(preview.combinedFitsEffectiveArea).toBe(true);
  });

  it('空集合返回安全的零对象结果', () => {
    expect(createPrintPlatformMultiObjectPreview('analysis-empty', [], platform, effective)).toMatchObject({
      objectCount: 0,
      combinedBoundsMm: null,
      combinedWidthMm: 0,
      combinedDepthMm: 0,
      combinedStatus: null,
      combinedFitsPlatform: false,
      combinedFitsEffectiveArea: false
    });
  });

  it('拒绝非法平台边界和平台外的安全区域', () => {
    expect(() => createPrintPlatformMultiObjectPreview('analysis-invalid', [], {
      ...platform,
      maximumX: Number.POSITIVE_INFINITY
    }, effective)).toThrow('物理平台边界必须包含有限毫米边界');
    expect(() => createPrintPlatformMultiObjectPreview('analysis-invalid', [], platform, {
      ...effective,
      maximumX: 140
    })).toThrow('安全有效区域必须位于物理平台内部');
  });

  it('来源身份不受候选顺序影响但会响应修订、变换语义和可见性变化', () => {
    const first = candidate('a', null);
    const second = candidate('b', null, { sourceIdentity: 'uploaded:revision-2:position-0' });
    const original = createPrintPlatformMultiObjectSourceIdentity('analysis', [first, second]);

    expect(createPrintPlatformMultiObjectSourceIdentity('analysis', [second, first])).toBe(original);
    expect(createPrintPlatformMultiObjectSourceIdentity('analysis', [first, {
      ...second,
      sourceIdentity: 'uploaded:revision-3:position-0'
    }])).not.toBe(original);
    expect(createPrintPlatformMultiObjectSourceIdentity('analysis', [first, {
      ...second,
      visible: false
    }])).not.toBe(original);
  });
});
