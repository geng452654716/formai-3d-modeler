import { describe, expect, it } from 'vitest';
import { describeMeshRepair, type MeshRepairMetrics } from './importedModel';

const baseReport: MeshRepairMetrics = {
  attempted: true,
  repaired: false,
  inputTriangleCount: 12,
  outputTriangleCount: 12,
  removedDegenerateTriangleCount: 0,
  removedDuplicateTriangleCount: 0,
  boundaryEdgeCountBefore: 0,
  boundaryEdgeCountAfter: 0,
  nonManifoldEdgeCount: 0,
  connectedComponentCount: 1,
  repairedHoleCount: 0,
  addedTriangleCount: 0
};

describe('上传 STL 网格修复摘要', () => {
  it('明确说明封闭网格无需修复', () => {
    expect(describeMeshRepair(baseReport)).toBe('未发现开放边、退化面或重复面，无需修复');
  });

  it('区分上传孔洞补面与拆件切割补面', () => {
    expect(describeMeshRepair({
      ...baseReport,
      repaired: true,
      inputTriangleCount: 10,
      repairedHoleCount: 1,
      addedTriangleCount: 2,
      boundaryEdgeCountBefore: 4
    })).toBe('已自动修复 1 个上传网格孔洞，新增 2 个补面三角形');
  });

  it('汇总退化面和重复面清理', () => {
    expect(describeMeshRepair({
      ...baseReport,
      repaired: true,
      inputTriangleCount: 14,
      removedDegenerateTriangleCount: 1,
      removedDuplicateTriangleCount: 1
    })).toContain('移除 1 个退化三角形，移除 1 个重复三角形');
  });
});
