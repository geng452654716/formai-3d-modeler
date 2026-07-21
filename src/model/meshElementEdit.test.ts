import { describe, expect, it } from 'vitest';
import {
  collectMeshElementBoxSelection,
  createMeshElementSelectionSet,
  meshElementSelectionKey,
  meshElementSelectionPivot,
  uniqueMeshElementSelectionPoints,
  nearestMeshElementIndex,
  selectedMeshElementPoints,
  type MeshElementSelection
} from './meshElementEdit';

const triangle = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 0, y: 10, z: 0 }
] as const;

function selection(kind: MeshElementSelection['kind'], triangleIndex: number, elementIndex: number): MeshElementSelection {
  return {
    revision: '修订-1',
    sourcePartId: 'uploaded-model',
    kind,
    triangleIndex,
    elementIndex,
    triangleMm: [...triangle]
  };
}

describe('网格元素选择', () => {
  it('选择离点击点最近的顶点和边', () => {
    expect(nearestMeshElementIndex('vertex', [...triangle], { x: 9, y: 0.2, z: 0 })).toBe(1);
    expect(nearestMeshElementIndex('edge', [...triangle], { x: 6, y: 4.1, z: 0 })).toBe(1);
    expect(nearestMeshElementIndex('face', [...triangle], { x: 2, y: 2, z: 0 })).toBe(0);
  });

  it('按种类返回高亮坐标', () => {
    expect(selectedMeshElementPoints(selection('vertex', 0, 2))).toEqual([triangle[2]]);
    expect(selectedMeshElementPoints(selection('edge', 0, 0))).toEqual([triangle[0], triangle[1]]);
    expect(selectedMeshElementPoints(selection('face', 0, 0))).toHaveLength(3);
  });

  it('按源坐标去重顶点和无向边，面按三角面索引去重', () => {
    const sameVertex = { ...selection('vertex', 1, 0), triangleMm: [...triangle] } as MeshElementSelection;
    expect(meshElementSelectionKey(selection('vertex', 0, 0))).toBe(meshElementSelectionKey(sameVertex));

    const reversedEdge = {
      ...selection('edge', 1, 0),
      triangleMm: [triangle[1], triangle[0], triangle[2]]
    } as MeshElementSelection;
    expect(meshElementSelectionKey(selection('edge', 0, 0))).toBe(meshElementSelectionKey(reversedEdge));

    const set = createMeshElementSelectionSet([
      selection('face', 2, 0),
      selection('face', 2, 0),
      selection('face', 3, 0)
    ], 'box');
    expect(set?.selectionMethod).toBe('box');
    expect(set?.elements.map((item) => item.triangleIndex)).toEqual([2, 3]);
  });


  it('按唯一源坐标计算统一旋转和缩放的几何中心', () => {
    const set = createMeshElementSelectionSet([
      selection('edge', 0, 0),
      { ...selection('edge', 1, 0), triangleMm: [triangle[1], triangle[0], triangle[2]] }
    ], 'box');
    expect(set).not.toBeNull();
    expect(uniqueMeshElementSelectionPoints(set!).map((point) => point.x).sort((a, b) => a - b)).toEqual([0, 10]);
    expect(meshElementSelectionPivot(set!)).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('拒绝混合修订或混合种类进入同一集合', () => {
    const set = createMeshElementSelectionSet([
      selection('vertex', 0, 0),
      { ...selection('vertex', 1, 1), revision: '过期修订' },
      selection('edge', 2, 0)
    ], 'box');
    expect(set?.elements).toHaveLength(1);
    expect(set?.kind).toBe('vertex');
  });

  it('框选分别使用顶点、边中点和面重心的屏幕投影', () => {
    const triangles = [{
      triangleIndex: 7,
      triangleMm: [...triangle] as MeshElementSelection['triangleMm'],
      triangleWorld: [...triangle] as MeshElementSelection['triangleMm']
    }];
    const project = (point: { x: number; y: number; z: number }) => ({
      x: point.x / 10,
      y: point.y / 10,
      depth: point.z
    });

    const vertex = collectMeshElementBoxSelection(
      '修订-2',
      'vertex',
      { left: 0.95, top: 0, right: 1, bottom: 0.05 },
      triangles,
      project
    );
    expect(vertex.selectionSet?.elements.map((item) => item.elementIndex)).toEqual([1]);
    expect(vertex.selectionSet?.revision).toBe('修订-2');

    const edge = collectMeshElementBoxSelection(
      '修订-2',
      'edge',
      { left: 0.45, top: 0, right: 0.55, bottom: 0.05 },
      triangles,
      project
    );
    expect(edge.selectionSet?.elements.map((item) => item.elementIndex)).toEqual([0]);

    const face = collectMeshElementBoxSelection(
      '修订-2',
      'face',
      { left: 0.3, top: 0.3, right: 0.36, bottom: 0.36 },
      triangles,
      project
    );
    expect(face.selectionSet?.elements.map((item) => item.triangleIndex)).toEqual([7]);
  });

  it('框选按源坐标去重并按遍历顺序截断到安全上限', () => {
    const duplicateTriangles = [0, 1].map((triangleIndex) => ({
      triangleIndex,
      triangleMm: [...triangle] as MeshElementSelection['triangleMm'],
      triangleWorld: [...triangle] as MeshElementSelection['triangleMm']
    }));
    const duplicate = collectMeshElementBoxSelection(
      '修订-1',
      'vertex',
      { left: 0, top: 0, right: 0.01, bottom: 0.01 },
      duplicateTriangles,
      (point) => ({ x: point.x / 10, y: point.y / 10, depth: 0 })
    );
    expect(duplicate.selectionSet?.elements).toHaveLength(1);
    expect(duplicate.limitReached).toBe(false);

    const manyFaces = Array.from({ length: 513 }, (_, triangleIndex) => ({
      triangleIndex,
      triangleMm: [...triangle] as MeshElementSelection['triangleMm'],
      triangleWorld: [...triangle] as MeshElementSelection['triangleMm']
    }));
    const limited = collectMeshElementBoxSelection(
      '修订-1',
      'face',
      { left: 0, top: 0, right: 1, bottom: 1 },
      manyFaces,
      () => ({ x: 0.5, y: 0.5, depth: 0 })
    );
    expect(limited.selectionSet?.elements).toHaveLength(512);
    expect(limited.selectionSet?.elements.at(-1)?.triangleIndex).toBe(511);
    expect(limited.limitReached).toBe(true);
  });

});
