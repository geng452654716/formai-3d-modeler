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

describe('连续共面区域执行前预览', () => {
  const face = (
    triangleIndex: number,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number]
  ) => ({
    triangleIndex,
    triangleMm: [a, b, c].map(([x, y, z]) => ({ x, y, z })) as [
      { x: number; y: number; z: number },
      { x: number; y: number; z: number },
      { x: number; y: number; z: number }
    ]
  });

  it('从长方体顶面种子扩展两个三角面并测量闭合外环', async () => {
    const { createMeshPlanarRegionDimensionGuides, expandMeshPlanarRegion } = await import('./meshElementEdit');
    const preview = expandMeshPlanarRegion('修订-顶面', 0, [
      face(0, [0, 0, 12], [30, 0, 12], [30, 24, 12]),
      face(1, [0, 0, 12], [30, 24, 12], [0, 24, 12]),
      face(2, [0, 0, 0], [30, 0, 0], [30, 0, 12])
    ], Math.hypot(30, 24, 12));
    expect(preview.triangleIndexes).toEqual([0, 1]);
    expect(preview.affectedTriangleCount).toBe(2);
    expect(preview.regionAreaMm2).toBeCloseTo(720, 8);
    expect(preview.boundaryLoopCount).toBe(1);
    expect(preview.boundaryLoopsMm).toHaveLength(1);
    expect(preview.boundaryLoopsMm[0]).toHaveLength(4);
    expect(preview.outerBoundaryLoopCount).toBe(1);
    expect(preview.holeBoundaryLoopCount).toBe(0);
    expect(preview.boundaryLoops[0]).toMatchObject({
      kind: 'outer',
      nestingDepth: 0,
      boundsMm: { widthMm: 30, heightMm: 24 }
    });
    expect(preview.boundaryLoops[0].perimeterMm).toBeCloseTo(108, 8);
    expect(preview.boundaryLoops[0].measurementFrame).toMatchObject({
      minUMm: 0,
      maxUMm: 30,
      minVMm: 0,
      maxVMm: 24
    });
    const guides = createMeshPlanarRegionDimensionGuides(preview.boundaryLoops[0]);
    expect(guides.width.valueMm).toBeCloseTo(30, 8);
    expect(guides.height.valueMm).toBeCloseTo(24, 8);
    expect(Math.hypot(
      guides.width.dimensionLineMm[1].x - guides.width.dimensionLineMm[0].x,
      guides.width.dimensionLineMm[1].y - guides.width.dimensionLineMm[0].y,
      guides.width.dimensionLineMm[1].z - guides.width.dimensionLineMm[0].z
    )).toBeCloseTo(30, 8);
    expect(Math.hypot(
      guides.height.dimensionLineMm[1].x - guides.height.dimensionLineMm[0].x,
      guides.height.dimensionLineMm[1].y - guides.height.dimensionLineMm[0].y,
      guides.height.dimensionLineMm[1].z - guides.height.dimensionLineMm[0].z
    )).toBeCloseTo(24, 8);
    expect(guides.width.dimensionLineMm.every((point) => point.y < 0)).toBe(true);
    expect(guides.height.dimensionLineMm.every((point) => point.x > 30)).toBe(true);
    expect(guides.summaryLabelMm.y).toBeGreaterThan(24);
    const guideCoordinates = [
      ...guides.width.dimensionLineMm,
      ...guides.width.extensionLinesMm.flat(),
      ...guides.width.capLinesMm.flat(),
      guides.width.labelMm,
      ...guides.height.dimensionLineMm,
      ...guides.height.extensionLinesMm.flat(),
      ...guides.height.capLinesMm.flat(),
      guides.height.labelMm,
      guides.summaryLabelMm
    ].flatMap((point) => [point.x, point.y, point.z]);
    expect(guideCoordinates.every(Number.isFinite)).toBe(true);
    expect(preview.normalToleranceDegrees).toBe(0.5);
    expect(preview.planeToleranceMm).toBeCloseTo(Math.hypot(30, 24, 12) * 0.000001, 10);
  });

  it('不跨越锐边，也不连接空间上同平面但拓扑断开的三角面', async () => {
    const { expandMeshPlanarRegion } = await import('./meshElementEdit');
    const preview = expandMeshPlanarRegion('修订-隔离', 0, [
      face(0, [0, 0, 0], [10, 0, 0], [10, 10, 0]),
      face(1, [0, 0, 0], [10, 10, 0], [0, 10, 0]),
      face(2, [0, 0, 0], [10, 0, 0], [10, 0, 10]),
      face(3, [20, 0, 0], [30, 0, 0], [20, 10, 0])
    ], 50);
    expect(preview.triangleIndexes).toEqual([0, 1]);
  });

  it('识别带孔平面区域的外环和孔洞环', async () => {
    const { createMeshPlanarRegionDimensionGuides, expandMeshPlanarRegion } = await import('./meshElementEdit');
    const outer = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]] as const;
    const inner = [[4, 4, 0], [6, 4, 0], [6, 6, 0], [4, 6, 0]] as const;
    const faces = outer.flatMap((point, index) => {
      const next = (index + 1) % 4;
      return [
        face(index * 2, point, outer[next], inner[next]),
        face(index * 2 + 1, point, inner[next], inner[index])
      ];
    });
    const preview = expandMeshPlanarRegion('修订-带孔', 0, faces, 20);
    expect(preview.affectedTriangleCount).toBe(8);
    expect(preview.regionAreaMm2).toBeCloseTo(96, 8);
    expect(preview.boundaryLoopCount).toBe(2);
    expect(preview.boundaryLoopsMm).toHaveLength(2);
    expect(preview.boundaryLoopsMm.every((loop) => loop.length === 4)).toBe(true);
    expect(preview.outerBoundaryLoopCount).toBe(1);
    expect(preview.holeBoundaryLoopCount).toBe(1);
    const outerLoop = preview.boundaryLoops.find((loop) => loop.kind === 'outer');
    const holeLoop = preview.boundaryLoops.find((loop) => loop.kind === 'hole');
    expect(outerLoop).toMatchObject({ nestingDepth: 0, boundsMm: { widthMm: 10, heightMm: 10 } });
    expect(outerLoop?.perimeterMm).toBeCloseTo(40, 8);
    expect(holeLoop).toMatchObject({ nestingDepth: 1, boundsMm: { widthMm: 2, heightMm: 2 } });
    expect(holeLoop?.perimeterMm).toBeCloseTo(8, 8);
    if (!holeLoop) throw new Error('测试模型应包含孔洞环');
    const holeGuides = createMeshPlanarRegionDimensionGuides(holeLoop);
    expect(holeGuides.offsetMm).toBe(1.5);
    const segmentLengths = [
      holeGuides.width.dimensionLineMm,
      ...holeGuides.width.extensionLinesMm,
      ...holeGuides.width.capLinesMm,
      holeGuides.height.dimensionLineMm,
      ...holeGuides.height.extensionLinesMm,
      ...holeGuides.height.capLinesMm
    ].map(([start, end]) => Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z));
    expect(segmentLengths.every((length) => Number.isFinite(length) && length > 0)).toBe(true);
    expect(holeGuides.width.labelMm.y).toBeLessThan(4);
    expect(holeGuides.height.labelMm.x).toBeGreaterThan(6);
    expect(holeGuides.summaryLabelMm.y).toBeGreaterThan(6);
  });

  it('反转三角面绕序后仍按包含关系识别外环和孔洞', async () => {
    const { expandMeshPlanarRegion } = await import('./meshElementEdit');
    const outer = [[0, 0, 0], [12, 0, 0], [12, 8, 0], [0, 8, 0]] as const;
    const inner = [[3, 2, 0], [9, 2, 0], [9, 6, 0], [3, 6, 0]] as const;
    const faces = outer.flatMap((point, index) => {
      const next = (index + 1) % 4;
      return [
        face(index * 2, inner[next], outer[next], point),
        face(index * 2 + 1, inner[index], inner[next], point)
      ];
    });
    const preview = expandMeshPlanarRegion('修订-反向绕序', 0, faces, 20);
    expect(preview.outerBoundaryLoopCount).toBe(1);
    expect(preview.holeBoundaryLoopCount).toBe(1);
    expect(preview.boundaryLoops.find((loop) => loop.kind === 'outer')?.perimeterMm).toBeCloseTo(40, 8);
    expect(preview.boundaryLoops.find((loop) => loop.kind === 'hole')?.perimeterMm).toBeCloseTo(20, 8);
  });

  it('同一拓扑可由不同种子复用且支持不连续三角面索引', async () => {
    const { createMeshPlanarRegionTopology, expandMeshPlanarRegion } = await import('./meshElementEdit');
    const triangles = [
      face(10, [0, 0, 0], [10, 0, 0], [10, 10, 0]),
      face(30, [0, 0, 0], [10, 10, 0], [0, 10, 0]),
      face(90, [20, 0, 0], [30, 0, 0], [20, 10, 0])
    ];
    const topology = createMeshPlanarRegionTopology(triangles);
    expect(expandMeshPlanarRegion('修订-缓存', 10, topology, 40).triangleIndexes).toEqual([10, 30]);
    expect(expandMeshPlanarRegion('修订-缓存', 30, topology, 40).triangleIndexes).toEqual([10, 30]);
    expect(expandMeshPlanarRegion('修订-缓存', 90, topology, 40).triangleIndexes).toEqual([90]);
  });

  it('可复用拓扑与三角面迭代入口返回相同边界坐标', async () => {
    const { createMeshPlanarRegionTopology, expandMeshPlanarRegion } = await import('./meshElementEdit');
    const triangles = [
      face(5, [0, 0, 0], [8, 0, 0], [8, 6, 0]),
      face(8, [0, 0, 0], [8, 6, 0], [0, 6, 0])
    ];
    const direct = expandMeshPlanarRegion('修订-兼容', 5, triangles, 20);
    const cached = expandMeshPlanarRegion('修订-兼容', 5, createMeshPlanarRegionTopology(triangles), 20);
    expect(cached).toEqual(direct);
  });

  it('遇到三个三角面共享同一无向边时用中文拒绝', async () => {
    const { expandMeshPlanarRegion } = await import('./meshElementEdit');
    expect(() => expandMeshPlanarRegion('修订-非流形', 0, [
      face(0, [0, 0, 0], [10, 0, 0], [0, 10, 0]),
      face(1, [10, 0, 0], [0, 0, 0], [0, -10, 0]),
      face(2, [0, 0, 0], [10, 0, 0], [5, 5, 0])
    ], 20)).toThrow('共面区域预览遇到非流形共享边，无法安全扩展');
  });

  it('边界环顺序导航支持未聚焦起点和首尾循环', async () => {
    const { cycleMeshPlanarRegionLoopIndex } = await import('./meshElementEdit');
    expect(cycleMeshPlanarRegionLoopIndex(null, 3, 'next')).toBe(0);
    expect(cycleMeshPlanarRegionLoopIndex(null, 3, 'previous')).toBe(2);
    expect(cycleMeshPlanarRegionLoopIndex(2, 3, 'next')).toBe(0);
    expect(cycleMeshPlanarRegionLoopIndex(0, 3, 'previous')).toBe(2);
  });

  it('边界环顺序导航对空列表和过期索引安全回落', async () => {
    const { cycleMeshPlanarRegionLoopIndex } = await import('./meshElementEdit');
    expect(cycleMeshPlanarRegionLoopIndex(0, 0, 'next')).toBeNull();
    expect(cycleMeshPlanarRegionLoopIndex(8, 2, 'next')).toBe(0);
    expect(cycleMeshPlanarRegionLoopIndex(-1, 2, 'previous')).toBe(1);
  });

  it('动态平面距离公差限制在 0.00001 至 0.02 毫米', async () => {
    const { expandMeshPlanarRegion } = await import('./meshElementEdit');
    const triangles = [face(0, [0, 0, 0], [1, 0, 0], [0, 1, 0])];
    expect(expandMeshPlanarRegion('小模型', 0, triangles, 1).planeToleranceMm).toBe(0.00001);
    expect(expandMeshPlanarRegion('大模型', 0, triangles, 1_000_000).planeToleranceMm).toBe(0.02);
  });
});
