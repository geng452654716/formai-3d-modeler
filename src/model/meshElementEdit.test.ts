import { describe, expect, it } from 'vitest';
import { nearestMeshElementIndex, selectedMeshElementPoints, type MeshElementSelection } from './meshElementEdit';

const triangle = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 0, y: 10, z: 0 }
] as const;

describe('网格元素选择', () => {
  it('选择离点击点最近的顶点和边', () => {
    expect(nearestMeshElementIndex('vertex', [...triangle], { x: 9, y: 0.2, z: 0 })).toBe(1);
    expect(nearestMeshElementIndex('edge', [...triangle], { x: 6, y: 4.1, z: 0 })).toBe(1);
    expect(nearestMeshElementIndex('face', [...triangle], { x: 2, y: 2, z: 0 })).toBe(0);
  });

  it('按种类返回高亮坐标', () => {
    const base = {
      revision: '修订-1', sourcePartId: 'uploaded-model', triangleIndex: 0, triangleMm: [...triangle]
    } as const;
    expect(selectedMeshElementPoints({ ...base, kind: 'vertex', elementIndex: 2 } as MeshElementSelection)).toEqual([triangle[2]]);
    expect(selectedMeshElementPoints({ ...base, kind: 'edge', elementIndex: 0 } as MeshElementSelection)).toEqual([triangle[0], triangle[1]]);
    expect(selectedMeshElementPoints({ ...base, kind: 'face', elementIndex: 0 } as MeshElementSelection)).toHaveLength(3);
  });
});
