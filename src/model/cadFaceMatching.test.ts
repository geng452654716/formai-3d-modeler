import { describe, expect, it } from 'vitest';
import { compareCadStableFaceIds, type CadGenerationResult } from './cad';

function result(parts: Array<{ id: string; faceIds?: string[] }>) {
  return {
    parts: parts.map((part) => ({
      id: part.id,
      faces: part.faceIds?.map((stableId) => ({ stableId }))
    }))
  } as unknown as CadGenerationResult;
}

describe('几何签名稳定面 ID 对比', () => {
  it('按零件 ID 与面稳定 ID 的组合匹配', () => {
    const comparison = compareCadStableFaceIds(
      result([{ id: '主体', faceIds: ['面-a', '面-b'] }, { id: '上盖', faceIds: ['面-a'] }]),
      result([{ id: '主体', faceIds: ['面-a', '面-c'] }, { id: '上盖', faceIds: ['面-a'] }])
    );

    expect(comparison).toEqual({
      available: true,
      baseFaceCount: 3,
      currentFaceCount: 3,
      sharedStableIdCount: 2,
      addedStableIdCount: 1,
      disappearedStableIdCount: 1
    });
  });

  it('旧快照没有面描述时明确返回不可用', () => {
    expect(compareCadStableFaceIds(result([{ id: '主体' }]), result([{ id: '主体', faceIds: ['面-a'] }])))
      .toEqual({
        available: false,
        baseFaceCount: 0,
        currentFaceCount: 1,
        sharedStableIdCount: 0,
        addedStableIdCount: 0,
        disappearedStableIdCount: 0
      });
  });
});
