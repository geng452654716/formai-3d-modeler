import { describe, expect, it } from 'vitest';
import {
  appendMeshPlanarRegionCodexAnalysisDraft,
  collectMeshElementBoxSelection,
  copyMeshPlanarRegionCodexDiagnosticDifferenceSummary,
  copyMeshPlanarRegionExtrusionDiagnosticSummary,
  createMeshPlanarRegionCodexAnalysisRequest,
  createMeshPlanarRegionCodexDraftBlockLocation,
  createMeshPlanarRegionCodexDiagnosticDifferencePreview,
  createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics,
  createMeshPlanarRegionCodexDiagnosticDifferenceSummary,
  createMeshPlanarRegionCodexDiagnosticFieldDifferences,
  createMeshPlanarRegionExtrusionDiagnosticSummary,
  createMeshPlanarRegionExtrusionDirectionConsistency,
  createMeshPlanarRegionExtrusionResultComparison,
  createMeshPlanarRegionExtrusionToolVolumeComparison,
  inspectMeshPlanarRegionCodexAnalysisDraft,
  createMeshElementSelectionSet,
  meshElementSelectionKey,
  meshElementSelectionPivot,
  uniqueMeshElementSelectionPoints,
  nearestMeshElementIndex,
  removeMeshPlanarRegionCodexAnalysisDraftBlock,
  replaceMeshPlanarRegionCodexAnalysisDraftBlock,
  selectedMeshElementPoints,
  selectMeshPlanarRegionCodexDiagnosticDifferencePreviewText,
  type MeshElementEditResult,
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

  it('识别带孔平面区域的外环和孔洞环，并生成顺序无关的法向工具体轮廓', async () => {
    const {
      createMeshPlanarRegionDimensionGuides,
      createMeshPlanarRegionExtrusionPreviewGuides,
      createMeshPlanarRegionExtrusionPreviewMetrics,
      createMeshPlanarRegionExtrusionPreviewProfile,
      expandMeshPlanarRegion
    } = await import('./meshElementEdit');
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

    const addProfile = createMeshPlanarRegionExtrusionPreviewProfile(preview, 'add', 2);
    const cutProfile = createMeshPlanarRegionExtrusionPreviewProfile(preview, 'cut', 2);
    expect(addProfile?.outer).toHaveLength(4);
    expect(addProfile?.holes).toHaveLength(1);
    expect(addProfile?.holes[0]).toHaveLength(4);
    expect(addProfile?.distanceMm).toBe(2);
    expect(cutProfile?.directionNormalMm).toEqual({
      x: -addProfile!.directionNormalMm.x,
      y: -addProfile!.directionNormalMm.y,
      z: -addProfile!.directionNormalMm.z
    });
    expect(createMeshPlanarRegionExtrusionPreviewProfile(preview, 'add', 0.1)).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewProfile(preview, 'add', Number.NaN)).toBeNull();

    const reorderedProfile = createMeshPlanarRegionExtrusionPreviewProfile({
      ...preview,
      boundaryLoops: [...preview.boundaryLoops].reverse()
    }, 'add', 2);
    expect(reorderedProfile?.outer).toEqual(addProfile?.outer);
    expect(reorderedProfile?.holes).toEqual(addProfile?.holes);

    expect(createMeshPlanarRegionExtrusionPreviewMetrics(addProfile!)).toEqual({
      outerAreaMm2: 100,
      holeAreaMm2: 4,
      netAreaMm2: 96,
      estimatedVolumeMm3: 192
    });
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({
      ...addProfile!,
      outer: [...addProfile!.outer].reverse(),
      holes: [[...addProfile!.holes[0]].reverse()]
    })).toEqual({
      outerAreaMm2: 100,
      holeAreaMm2: 4,
      netAreaMm2: 96,
      estimatedVolumeMm3: 192
    });
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({
      ...addProfile!,
      holes: [
        ...addProfile!.holes,
        [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1.5, y: 2 }]
      ]
    })).toEqual({
      outerAreaMm2: 100,
      holeAreaMm2: 4.5,
      netAreaMm2: 95.5,
      estimatedVolumeMm3: 191
    });
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({
      ...addProfile!,
      outer: addProfile!.outer.slice(0, 2)
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({
      ...addProfile!,
      outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: Number.NaN, y: 1 }]
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({
      ...addProfile!,
      outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({
      ...addProfile!,
      holes: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]]
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({ ...addProfile!, distanceMm: 0 })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({ ...addProfile!, distanceMm: -2 })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewMetrics({ ...addProfile!, distanceMm: Number.NaN })).toBeNull();

    const guides = createMeshPlanarRegionExtrusionPreviewGuides(addProfile!);
    expect(guides?.loops).toHaveLength(2);
    expect(guides?.loops.map((loop) => loop.kind)).toEqual(['outer', 'hole']);
    expect(guides?.loops[0].startLoopMm).toHaveLength(5);
    expect(guides?.loops[0].endLoopMm).toHaveLength(5);
    expect(guides?.loops[0].sideSegmentsMm).toHaveLength(4);
    expect(guides?.loops[1].startLoopMm).toHaveLength(5);
    expect(guides?.loops[1].endLoopMm).toHaveLength(5);
    expect(guides?.loops[1].sideSegmentsMm).toHaveLength(4);
    for (const loop of guides!.loops) {
      expect(loop.startLoopMm.at(-1)).toEqual(loop.startLoopMm[0]);
      expect(loop.endLoopMm.at(-1)).toEqual(loop.endLoopMm[0]);
      loop.startLoopMm.forEach((startPoint, pointIndex) => {
        const endPoint = loop.endLoopMm[pointIndex];
        const normalDistanceMm = (endPoint.x - startPoint.x) * addProfile!.directionNormalMm.x
          + (endPoint.y - startPoint.y) * addProfile!.directionNormalMm.y
          + (endPoint.z - startPoint.z) * addProfile!.directionNormalMm.z;
        expect(normalDistanceMm).toBeCloseTo(addProfile!.distanceMm, 8);
      });
      loop.sideSegmentsMm.forEach(([startPoint, endPoint], pointIndex) => {
        expect(startPoint).toEqual(loop.startLoopMm[pointIndex]);
        expect(endPoint).toEqual(loop.endLoopMm[pointIndex]);
        const sideLengthMm = Math.hypot(
          endPoint.x - startPoint.x,
          endPoint.y - startPoint.y,
          endPoint.z - startPoint.z
        );
        expect(sideLengthMm).toBeCloseTo(addProfile!.distanceMm, 8);
      });
    }
    const guideCoordinates = [
      ...guides!.loops.flatMap((loop) => [
        ...loop.startLoopMm,
        ...loop.endLoopMm,
        ...loop.sideSegmentsMm.flat()
      ]),
      guides!.directionEndMm,
      ...guides!.endpointMarkerSegmentsMm.flat()
    ].flatMap((point) => [point.x, point.y, point.z]);
    expect(guideCoordinates.every(Number.isFinite)).toBe(true);
    for (const [startPoint, endPoint] of guides!.endpointMarkerSegmentsMm) {
      expect(Math.hypot(
        endPoint.x - startPoint.x,
        endPoint.y - startPoint.y,
        endPoint.z - startPoint.z
      )).toBeGreaterThan(0);
    }

    const multipleHoleGuides = createMeshPlanarRegionExtrusionPreviewGuides({
      ...addProfile!,
      holes: [
        ...addProfile!.holes,
        [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1.5, y: 2 }]
      ]
    });
    expect(multipleHoleGuides?.loops.map((loop) => loop.kind)).toEqual(['outer', 'hole', 'hole']);
    expect(multipleHoleGuides?.loops.map((loop) => loop.sideSegmentsMm.length)).toEqual([4, 4, 3]);
    expect(multipleHoleGuides?.loops.flatMap((loop) => loop.sideSegmentsMm).every(([start, end]) => (
      [start.x, start.y, start.z, end.x, end.y, end.z].every(Number.isFinite)
    ))).toBe(true);

    expect(createMeshPlanarRegionExtrusionPreviewGuides({
      ...addProfile!,
      outer: addProfile!.outer.slice(0, 2)
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewGuides({
      ...addProfile!,
      holes: [[{ x: Number.NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]]
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewGuides({
      ...addProfile!,
      holes: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]]
    })).toBeNull();
    expect(createMeshPlanarRegionExtrusionPreviewGuides({
      ...addProfile!,
      axisU: { x: 0, y: 0, z: 0 }
    })).toBeNull();
  });

  it('使用闭合网格有符号体积把反向绕序种子法线修正为外法线', async () => {
    const { expandMeshPlanarRegion } = await import('./meshElementEdit');
    const preview = expandMeshPlanarRegion('修订-反向四面体', 0, [
      face(0, [0, 0, 0], [1, 0, 0], [0, 1, 0]),
      face(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]),
      face(2, [0, 0, 0], [0, 1, 0], [0, 0, 1]),
      face(3, [1, 0, 0], [0, 0, 1], [0, 1, 0])
    ], 2);
    expect(preview.outwardNormalMm.x).toBeCloseTo(0, 8);
    expect(preview.outwardNormalMm.y).toBeCloseTo(0, 8);
    expect(preview.outwardNormalMm.z).toBeCloseTo(-1, 8);
  });

  it('尺寸辅助线候选可把宽高和摘要翻转到相反轮廓外侧', async () => {
    const {
      createMeshPlanarRegionDimensionGuides,
      expandMeshPlanarRegion,
      MESH_PLANAR_REGION_DIMENSION_LAYOUTS
    } = await import('./meshElementEdit');
    const preview = expandMeshPlanarRegion('修订-翻转', 0, [
      face(0, [0, 0, 0], [10, 0, 0], [10, 8, 0]),
      face(1, [0, 0, 0], [10, 8, 0], [0, 8, 0])
    ], 20);
    const guides = createMeshPlanarRegionDimensionGuides(
      preview.boundaryLoops[0],
      MESH_PLANAR_REGION_DIMENSION_LAYOUTS[3]
    );
    expect(guides.width.dimensionLineMm.every((point) => point.y > 8)).toBe(true);
    expect(guides.width.extensionLinesMm.every(([start]) => start.y === 8)).toBe(true);
    expect(guides.height.dimensionLineMm.every((point) => point.x < 0)).toBe(true);
    expect(guides.height.extensionLinesMm.every(([start]) => start.x === 0)).toBe(true);
    expect(guides.summaryLabelMm.y).toBeLessThan(0);
  });

  it('视口候选优先避开安全区边缘和标签互相重叠', async () => {
    const { selectMeshPlanarRegionDimensionLayout } = await import('./meshElementEdit');
    const anchor = (xPx: number, yPx: number, widthPx = 100, heightPx = 20) => ({
      xPx, yPx, widthPx, heightPx
    });
    const safeArea = { leftPx: 20, topPx: 50, rightPx: 400, bottomPx: 300 };
    expect(selectMeshPlanarRegionDimensionLayout([{
      layoutIndex: 0,
      anchors: [anchor(390, 100), anchor(250, 140), anchor(250, 190, 100, 38)]
    }, {
      layoutIndex: 1,
      anchors: [anchor(160, 100), anchor(250, 140), anchor(250, 190, 100, 38)]
    }], safeArea)).toBe(1);
    expect(selectMeshPlanarRegionDimensionLayout([{
      layoutIndex: 2,
      anchors: [anchor(180, 140), anchor(180, 140), anchor(180, 140, 100, 38)]
    }, {
      layoutIndex: 3,
      anchors: [anchor(120, 90), anchor(250, 140), anchor(180, 220, 100, 38)]
    }], safeArea)).toBe(3);
    expect(selectMeshPlanarRegionDimensionLayout([], safeArea)).toBeNull();
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

describe('连续共面区域执行结果体积对照', () => {
  function extrusionResult(overrides: {
    revision?: string;
    operation?: MeshElementEditResult['operation'];
    mode?: MeshElementEditResult['faceExtrusionMode'];
    toolVolumeMm3?: number;
    volumeDeltaMm3?: number;
    regionAreaMm2?: number;
    distanceMm?: number;
  } = {}): MeshElementEditResult {
    const revision = overrides.revision ?? '修订-结果';
    return {
      status: 'ok',
      revision,
      selectionRevision: '修订-执行前',
      sourcePartId: 'uploaded-model',
      kind: 'face',
      selectionMethod: 'click',
      selectedElementCount: 1,
      operation: overrides.operation ?? 'extrude-face',
      pivotMm: { x: 0, y: 0, z: 0 },
      faceExtrusionMode: overrides.mode === undefined ? 'add' : overrides.mode,
      toolVolumeMm3: overrides.toolVolumeMm3 === undefined ? 200 : overrides.toolVolumeMm3,
      regionAreaMm2: overrides.regionAreaMm2 === undefined ? 100 : overrides.regionAreaMm2,
      distanceMm: overrides.distanceMm === undefined ? 2 : overrides.distanceMm,
      movedCoordinateCount: 0,
      movedVertexOccurrenceCount: 0,
      sourceFile: '任意模型.stl',
      stepFile: '任意模型.step',
      outputs: ['任意模型.stl', '任意模型.step'],
      units: 'mm',
      kernel: 'OpenCascade 测试内核',
      validation: {
        valid: true,
        watertight: true,
        solidCountBefore: 1,
        solidCountAfter: 1,
        volumeBeforeMm3: 1_000,
        volumeAfterMm3: 1_180,
        volumeDeltaMm3: overrides.volumeDeltaMm3 === undefined ? 180 : overrides.volumeDeltaMm3,
        boundsBeforeMm: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10, x: 10, y: 10, z: 10 },
        boundsAfterMm: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 12, x: 10, y: 10, z: 12 }
      },
      updatedModel: {} as MeshElementEditResult['updatedModel'],
      limitations: []
    };
  }

  it('加料与压入都使用模型体积变化绝对值计算实际作用比例', () => {
    expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult(), '修订-结果')).toEqual({
      mode: 'add',
      toolVolumeMm3: 200,
      modelVolumeChangeMm3: 180,
      effectRatioPercent: 90
    });
    expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult({
      mode: 'cut',
      volumeDeltaMm3: -150
    }), '修订-结果')).toEqual({
      mode: 'cut',
      toolVolumeMm3: 200,
      modelVolumeChangeMm3: 150,
      effectRatioPercent: 75
    });
  });

  it('轻微浮点超出会夹紧为百分之百并可稳定格式化', () => {
    const comparison = createMeshPlanarRegionExtrusionResultComparison(extrusionResult({
      toolVolumeMm3: 200,
      volumeDeltaMm3: 200.000_001
    }), '修订-结果');
    expect(comparison?.effectRatioPercent).toBe(100);
    expect(comparison?.effectRatioPercent.toFixed(2)).toBe('100.00');
  });

  it('拒绝非挤出、过期修订、缺失模式和明显异常比例', () => {
    expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult({ operation: 'move' }), '修订-结果')).toBeNull();
    expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult(), '其他修订')).toBeNull();
    const missingMode = extrusionResult();
    missingMode.faceExtrusionMode = undefined;
    expect(createMeshPlanarRegionExtrusionResultComparison(missingMode, '修订-结果')).toBeNull();
    expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult({ volumeDeltaMm3: 201 }), '修订-结果')).toBeNull();
  });

  it('拒绝零值、负值和非有限工具体积以及非有限体积变化', () => {
    for (const toolVolumeMm3 of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult({ toolVolumeMm3 }), '修订-结果')).toBeNull();
    }
    for (const volumeDeltaMm3 of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createMeshPlanarRegionExtrusionResultComparison(extrusionResult({ volumeDeltaMm3 }), '修订-结果')).toBeNull();
    }
  });
});

describe('连续共面区域平面估算与工具体积偏差', () => {
  function result(toolVolumeMm3: number, overrides: Partial<MeshElementEditResult> = {}): MeshElementEditResult {
    return {
      status: 'ok',
      revision: '修订-偏差',
      selectionRevision: '修订-执行前',
      sourcePartId: 'uploaded-model',
      kind: 'face',
      selectionMethod: 'click',
      selectedElementCount: 1,
      affectedTriangleCount: 2,
      regionAreaMm2: 100,
      boundaryLoopCount: 1,
      normalToleranceDegrees: 0.5,
      planeToleranceMm: 0.001,
      operation: 'extrude-face',
      pivotMm: { x: 0, y: 0, z: 0 },
      faceExtrusionMode: 'add',
      distanceMm: 2,
      toolVolumeMm3,
      movedCoordinateCount: 0,
      movedVertexOccurrenceCount: 0,
      sourceFile: '任意模型.stl',
      stepFile: '任意模型.step',
      outputs: ['任意模型.stl', '任意模型.step'],
      units: 'mm',
      kernel: 'OpenCascade 测试内核',
      validation: {
        valid: true,
        watertight: true,
        solidCountBefore: 1,
        solidCountAfter: 1,
        volumeBeforeMm3: 1_000,
        volumeAfterMm3: 1_000 + Math.min(toolVolumeMm3, 180),
        volumeDeltaMm3: Math.min(toolVolumeMm3, 180),
        boundsBeforeMm: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10, x: 10, y: 10, z: 10 },
        boundsAfterMm: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 12, x: 10, y: 10, z: 12 }
      },
      updatedModel: {} as MeshElementEditResult['updatedModel'],
      limitations: [],
      ...overrides
    };
  }

  function resultWithDirection(
    mode: 'add' | 'cut',
    volumeDeltaMm3: number,
    toolVolumeMm3 = 200
  ) {
    const candidate = result(toolVolumeMm3);
    candidate.faceExtrusionMode = mode;
    candidate.validation.volumeAfterMm3 = candidate.validation.volumeBeforeMm3 + volumeDeltaMm3;
    candidate.validation.volumeDeltaMm3 = volumeDeltaMm3;
    return candidate;
  }

  it('识别一致、高于和低于平面估算的工具体积', () => {
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200), '修订-偏差')).toEqual({
      planarEstimatedVolumeMm3: 200,
      toolVolumeMm3: 200,
      differenceMm3: 0,
      differencePercent: 0,
      direction: 'equal'
    });
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200.0000001), '修订-偏差')).toEqual({
      planarEstimatedVolumeMm3: 200,
      toolVolumeMm3: 200.0000001,
      differenceMm3: 0,
      differencePercent: 0,
      direction: 'equal'
    });
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(206), '修订-偏差')).toEqual({
      planarEstimatedVolumeMm3: 200,
      toolVolumeMm3: 206,
      differenceMm3: 6,
      differencePercent: 3,
      direction: 'higher'
    });
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(190), '修订-偏差')).toEqual({
      planarEstimatedVolumeMm3: 200,
      toolVolumeMm3: 190,
      differenceMm3: -10,
      differencePercent: -5,
      direction: 'lower'
    });
  });

  it('对当前修订绑定并拒绝缺失、非正或非有限面积和距离', () => {
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200), '其他修订')).toBeNull();
    for (const regionAreaMm2 of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200, { regionAreaMm2 }), '修订-偏差')).toBeNull();
    }
    for (const distanceMm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200, { distanceMm }), '修订-偏差')).toBeNull();
    }
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200, { regionAreaMm2: undefined }), '修订-偏差')).toBeNull();
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(200, { distanceMm: undefined }), '修订-偏差')).toBeNull();
  });

  it('接受边界值并让明显异常的工具体构造偏差安全降级', () => {
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(300), '修订-偏差')?.differencePercent).toBe(50);
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(100), '修订-偏差')?.differencePercent).toBe(-50);
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(301), '修订-偏差')).toBeNull();
    expect(createMeshPlanarRegionExtrusionToolVolumeComparison(result(99), '修订-偏差')).toBeNull();
  });

  it('复核加料增量和压入减量方向一致', () => {
    const addComparison = createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('add', 180),
      '修订-偏差'
    );
    expect(addComparison).toMatchObject({
      mode: 'add',
      status: 'consistent',
      expectedDirection: 'increase',
      actualDirection: 'increase',
      volumeDeltaMm3: 180
    });
    expect(addComparison?.zeroToleranceMm3).toBeCloseTo(0.0002, 12);
    const cutComparison = createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('cut', -180),
      '修订-偏差'
    );
    expect(cutComparison).toMatchObject({
      mode: 'cut',
      status: 'consistent',
      expectedDirection: 'decrease',
      actualDirection: 'decrease',
      volumeDeltaMm3: -180
    });
    expect(cutComparison?.zeroToleranceMm3).toBeCloseTo(0.0002, 12);
  });

  it('识别加料减量和压入增量的方向矛盾', () => {
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('add', -50),
      '修订-偏差'
    )?.status).toBe('inconsistent');
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('cut', 50),
      '修订-偏差'
    )?.status).toBe('inconsistent');
  });

  it('把工具体百万分之一内的变化归一为近似未变化', () => {
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('add', 0.0001),
      '修订-偏差'
    )).toMatchObject({
      mode: 'add',
      status: 'unchanged',
      actualDirection: 'unchanged',
      volumeDeltaMm3: 0
    });
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('cut', -0.0001),
      '修订-偏差'
    )?.status).toBe('unchanged');
  });

  it('对过期修订、缺失模式、非有限和明显异常体积变化安全降级', () => {
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('add', 180),
      '其他修订'
    )).toBeNull();
    const missingMode = resultWithDirection('add', 180);
    missingMode.faceExtrusionMode = undefined;
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(missingMode, '修订-偏差')).toBeNull();
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('add', Number.NaN),
      '修订-偏差'
    )).toBeNull();
    expect(createMeshPlanarRegionExtrusionDirectionConsistency(
      resultWithDirection('add', 201),
      '修订-偏差'
    )).toBeNull();
  });

  it('生成不包含路径和账号信息的全中文几何诊断摘要', () => {
    const summary = createMeshPlanarRegionExtrusionDiagnosticSummary(
      resultWithDirection('add', 180, 206),
      '修订-偏差'
    );
    expect(summary).toBe([
      '共面区域几何诊断',
      '操作模式：向外加料',
      '区域面积：100.00 平方毫米',
      '作用距离：2.00 毫米',
      '执行前平面估算：200.00 立方毫米',
      '实际工具体积：206.00 立方毫米',
      '工具体构造偏差：高于 6.00 立方毫米（+3.00%）',
      '模型体积变化：+180.00 立方毫米',
      '实际作用比例：87.38%',
      '方向状态：加料增量一致'
    ].join('\n'));
    expect(summary).not.toContain('任意模型.stl');
    expect(summary).not.toContain('sourceFile');
  });

  it('摘要明确写出方向矛盾，不把异常结果描述为正常加料', () => {
    const summary = createMeshPlanarRegionExtrusionDiagnosticSummary(
      resultWithDirection('add', -50),
      '修订-偏差'
    );
    expect(summary).toContain('模型体积变化：-50.00 立方毫米');
    expect(summary).toContain('实际作用比例：25.00%');
    expect(summary).toContain('方向状态：加料却发生减量');
  });

  it('摘要把公差内变化归一为零并标记体积近似未变化', () => {
    const summary = createMeshPlanarRegionExtrusionDiagnosticSummary(
      resultWithDirection('add', 0.0001),
      '修订-偏差'
    );
    expect(summary).toContain('模型体积变化：0.00 立方毫米');
    expect(summary).toContain('实际作用比例：0.00%');
    expect(summary).toContain('方向状态：体积近似未变化');
    expect(summary).not.toContain('+0.00 立方毫米');
  });

  it('摘要在平面数据不可用时保留真实执行结果并安全降级', () => {
    const summary = createMeshPlanarRegionExtrusionDiagnosticSummary(
      resultWithDirection('cut', -180, 200),
      '修订-偏差'
    );
    expect(summary).toContain('方向状态：压入减量一致');
    const missingArea = resultWithDirection('cut', -180, 200);
    missingArea.regionAreaMm2 = undefined;
    expect(createMeshPlanarRegionExtrusionDiagnosticSummary(missingArea, '修订-偏差')).toContain('区域面积：暂不可用');
    expect(createMeshPlanarRegionExtrusionDiagnosticSummary(missingArea, '修订-偏差')).toContain('工具体构造偏差：暂不可用');
    expect(createMeshPlanarRegionExtrusionDiagnosticSummary(missingArea, '其他修订')).toBeNull();
  });

  it('复制边界返回成功并吞掉 Clipboard 写入失败', async () => {
    let copiedText = '';
    await expect(copyMeshPlanarRegionExtrusionDiagnosticSummary('诊断文本', async (text) => {
      copiedText = text;
    })).resolves.toBe('copied');
    expect(copiedText).toBe('诊断文本');
    await expect(copyMeshPlanarRegionExtrusionDiagnosticSummary('', async () => undefined)).resolves.toBe('failed');
    await expect(copyMeshPlanarRegionExtrusionDiagnosticSummary('诊断文本', async () => {
      throw new Error('剪贴板不可用');
    })).resolves.toBe('failed');
  });

  it('生成稳定的全中文 Codex 几何分析请求但不包含自动执行语义', () => {
    const request = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n模型体积变化：+180.00 立方毫米');
    expect(request).toBe([
      '【共面区域几何诊断分析请求】',
      '请分析以下当前模型的共面区域几何诊断：',
      '共面区域几何诊断',
      '模型体积变化：+180.00 立方毫米',
      '请分析几何链路是否合理并提出下一步修改建议。'
    ].join('\n'));
    expect(request).not.toContain('执行建模指令');
    expect(createMeshPlanarRegionCodexAnalysisRequest('   ')).toBeNull();
  });

  it('保留用户已有指令并在后方追加诊断分析块', () => {
    const result = appendMeshPlanarRegionCodexAnalysisDraft(
      '请先保留我写的检查要求。  ',
      '共面区域几何诊断\n方向状态：加料增量一致'
    );
    expect(result.status).toBe('appended');
    expect(result.draft).toBe([
      '请先保留我写的检查要求。',
      '',
      '【共面区域几何诊断分析请求】',
      '请分析以下当前模型的共面区域几何诊断：',
      '共面区域几何诊断',
      '方向状态：加料增量一致',
      '请分析几何链路是否合理并提出下一步修改建议。'
    ].join('\n'));
  });

  it('同一诊断重复追加时保持草稿不变', () => {
    const first = appendMeshPlanarRegionCodexAnalysisDraft('', '共面区域几何诊断\n实际作用比例：90.00%');
    const repeated = appendMeshPlanarRegionCodexAnalysisDraft(first.draft, '共面区域几何诊断\n实际作用比例：90.00%');
    expect(first.status).toBe('appended');
    expect(repeated).toEqual({ draft: first.draft, status: 'duplicate' });
    expect(repeated.draft.match(/【共面区域几何诊断分析请求】/g)).toHaveLength(1);
  });

  it('摘要失效时不改变已有 Codex 指令草稿', () => {
    expect(appendMeshPlanarRegionCodexAnalysisDraft('已有指令', '  ')).toEqual({
      draft: '已有指令',
      status: 'invalid'
    });
  });


  it('按固定业务顺序返回旧诊断到最新诊断的变化字段', () => {
    const oldSummary = [
      '共面区域几何诊断',
      '操作模式：向外加料',
      '区域面积：100.00 平方毫米',
      '作用距离：2.00 毫米',
      '执行前平面估算：200.00 立方毫米',
      '实际工具体积：210.00 立方毫米',
      '工具体构造偏差：高于 10.00 立方毫米（+5.00%）',
      '模型体积变化：+180.00 立方毫米',
      '实际作用比例：85.71%',
      '方向状态：加料增量一致'
    ].join('\n');
    const latestSummary = oldSummary
      .replace('作用距离：2.00 毫米', '作用距离：3.00 毫米')
      .replace('执行前平面估算：200.00 立方毫米', '执行前平面估算：300.00 立方毫米')
      .replace('实际作用比例：85.71%', '实际作用比例：90.00%');
    const oldBlock = createMeshPlanarRegionCodexAnalysisRequest(oldSummary)!;
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(oldBlock, [oldBlock], latestSummary)).toEqual([
      { key: 'distance', label: '作用距离', previousValue: '2.00 毫米', latestValue: '3.00 毫米' },
      { key: 'planar-estimate', label: '执行前平面估算', previousValue: '200.00 立方毫米', latestValue: '300.00 立方毫米' },
      { key: 'effect-ratio', label: '实际作用比例', previousValue: '85.71%', latestValue: '90.00%' }
    ]);
  });

  it('相同字段被过滤且缺失字段不补造差异', () => {
    const oldSummary = '共面区域几何诊断\n操作模式：向外加料\n作用距离：2.00 毫米';
    const oldBlock = createMeshPlanarRegionCodexAnalysisRequest(oldSummary)!;
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(
      oldBlock,
      [oldBlock],
      '共面区域几何诊断\n操作模式：向外加料\n作用距离：3.00 毫米\n实际工具体积：300.00 立方毫米'
    )).toEqual([
      { key: 'distance', label: '作用距离', previousValue: '2.00 毫米', latestValue: '3.00 毫米' }
    ]);
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(oldBlock, [oldBlock], oldSummary)).toEqual([]);
  });

  it('编辑、重复、未登记或空最新摘要不返回诊断字段差异', () => {
    const summary = '共面区域几何诊断\n作用距离：2.00 毫米';
    const block = createMeshPlanarRegionCodexAnalysisRequest(summary)!;
    const latest = '共面区域几何诊断\n作用距离：3.00 毫米';
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(block.replace('2.00', '2.50'), [block], latest)).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(`${block}\n\n${block}`, [block], latest)).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(block, [], latest)).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticFieldDifferences(block, [block], '  ')).toBeNull();
  });

  it('按当前字段顺序生成不含完整诊断正文的简洁差异摘要', () => {
    const differences = [
      { key: 'distance', label: '作用距离', previousValue: '2.00 毫米', latestValue: '3.00 毫米' },
      { key: 'effect-ratio', label: '实际作用比例', previousValue: '85.71%', latestValue: '90.00%' }
    ];
    const summary = createMeshPlanarRegionCodexDiagnosticDifferenceSummary(differences);
    expect(summary).toBe([
      '【共面区域诊断字段差异】',
      '共 2 项变化',
      '作用距离：2.00 毫米 → 3.00 毫米',
      '实际作用比例：85.71% → 90.00%'
    ].join('\n'));
    expect(summary).not.toContain('【共面区域几何诊断分析请求】');
    expect(summary).not.toContain('请分析以下当前模型');
  });

  it('空差异或不完整差异不生成可复制摘要', () => {
    expect(createMeshPlanarRegionCodexDiagnosticDifferenceSummary([])).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticDifferenceSummary([
      { key: 'distance', label: '作用距离', previousValue: ' ', latestValue: '3.00 毫米' }
    ])).toBeNull();
  });

  it('差异复制使用注入写入函数并把失败安全转换为中文界面状态', async () => {
    const differences = [
      { key: 'distance', label: '作用距离', previousValue: '2.00 毫米', latestValue: '3.00 毫米' }
    ];
    let copiedText = '';
    await expect(copyMeshPlanarRegionCodexDiagnosticDifferenceSummary(differences, async (text) => {
      copiedText = text;
    })).resolves.toBe('copied');
    expect(copiedText).toContain('共 1 项变化');
    expect(copiedText).toContain('作用距离：2.00 毫米 → 3.00 毫米');
    await expect(copyMeshPlanarRegionCodexDiagnosticDifferenceSummary([], async () => {
      throw new Error('空差异不应写入剪贴板');
    })).resolves.toBe('failed');
    await expect(copyMeshPlanarRegionCodexDiagnosticDifferenceSummary(differences, async () => {
      throw new Error('剪贴板不可用');
    })).resolves.toBe('failed');
  });

  it('复制内容预览默认收起且使用全中文入口', () => {
    const summary = '【共面区域诊断字段差异】\n共 1 项变化';
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreview(summary, false)).toEqual({
      toggleLabel: '预览复制内容',
      content: null
    });
  });

  it('展开预览直接复用当前复制摘要并保留原始换行', () => {
    const summary = '【共面区域诊断字段差异】\n共 1 项变化\n作用距离：2.00 毫米 → 3.00 毫米';
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreview(summary, true)).toEqual({
      toggleLabel: '收起复制内容',
      content: summary
    });
  });

  it('空摘要不生成预览，避免沿用失效或不安全内容', () => {
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreview(null, false)).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreview('  ', true)).toBeNull();
  });

  it('预览统计拒绝空摘要并统计单行 Unicode 字符', () => {
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics(null)).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics('  ')).toBeNull();
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics('模型😀')).toEqual({
      lineCount: 1,
      characterCount: 3,
      label: '共 1 行 · 3 个字符'
    });
  });

  it('预览统计保留多行换行并兼容 CRLF', () => {
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics('第一行\n第二行')).toEqual({
      lineCount: 2,
      characterCount: 7,
      label: '共 2 行 · 7 个字符'
    });
    expect(createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics('A\r\nB')).toEqual({
      lineCount: 2,
      characterCount: 4,
      label: '共 2 行 · 4 个字符'
    });
  });

  it('一键全选通过注入边界选择当前完整预览正文', () => {
    const previewElement = { textContent: '第一行\n第二行' } as HTMLElement;
    let selectedElement: HTMLElement | null = null;
    expect(selectMeshPlanarRegionCodexDiagnosticDifferencePreviewText(
      previewElement,
      (element) => { selectedElement = element; }
    )).toBe('selected');
    expect(selectedElement).toBe(previewElement);
  });

  it('一键全选在浏览器拒绝时返回非阻断失败状态', () => {
    const previewElement = { textContent: '差异摘要' } as HTMLElement;
    expect(selectMeshPlanarRegionCodexDiagnosticDifferencePreviewText(previewElement, () => {
      throw new Error('Selection 不可用');
    })).toBe('failed');
  });

  it('一键全选拒绝空引用和空正文，不调用选择边界', () => {
    let callCount = 0;
    const selectText = () => { callCount += 1; };
    expect(selectMeshPlanarRegionCodexDiagnosticDifferencePreviewText(null, selectText)).toBe('failed');
    expect(selectMeshPlanarRegionCodexDiagnosticDifferencePreviewText(
      { textContent: '' } as HTMLElement,
      selectText
    )).toBe('failed');
    expect(callCount).toBe(0);
  });

  it('用最新诊断精确替换唯一旧块并原样保留前后用户文字和换行', () => {
    const oldBlock = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n作用距离：2.00 毫米')!;
    const draft = `前方用户文字  \n\n${oldBlock}\n\n  后方用户文字`;
    const result = replaceMeshPlanarRegionCodexAnalysisDraftBlock(
      draft,
      [oldBlock],
      '共面区域几何诊断\n作用距离：3.00 毫米'
    );
    const latestBlock = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n作用距离：3.00 毫米')!;
    expect(result).toEqual({
      draft: `前方用户文字  \n\n${latestBlock}\n\n  后方用户文字`,
      status: 'replaced'
    });
  });

  it('最新诊断与唯一完整块相同时不修改草稿', () => {
    const summary = '共面区域几何诊断\n方向状态：加料增量一致';
    const block = createMeshPlanarRegionCodexAnalysisRequest(summary)!;
    expect(replaceMeshPlanarRegionCodexAnalysisDraftBlock(block, [block], summary)).toEqual({
      draft: block,
      status: 'duplicate'
    });
  });

  it('旧诊断被编辑或重复时拒绝替换', () => {
    const oldBlock = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n作用距离：2.00 毫米')!;
    const edited = oldBlock.replace('2.00', '2.50');
    expect(replaceMeshPlanarRegionCodexAnalysisDraftBlock(
      edited,
      [oldBlock],
      '共面区域几何诊断\n作用距离：3.00 毫米'
    )).toEqual({ draft: edited, status: 'unsafe' });

    const repeated = `${oldBlock}\n\n${oldBlock}`;
    expect(replaceMeshPlanarRegionCodexAnalysisDraftBlock(
      repeated,
      [oldBlock],
      '共面区域几何诊断\n作用距离：3.00 毫米'
    )).toEqual({ draft: repeated, status: 'unsafe' });
  });

  it('最新诊断为空时拒绝替换且保留旧草稿', () => {
    const oldBlock = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n作用距离：2.00 毫米')!;
    expect(replaceMeshPlanarRegionCodexAnalysisDraftBlock(oldBlock, [oldBlock], '  ')).toEqual({
      draft: oldBlock,
      status: 'invalid'
    });
  });

  it('识别唯一完整诊断块并在移除时保留前后用户文字', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n方向状态：加料增量一致')!;
    const draft = `请保留前方要求。  \n\n${block}\n\n  请保留后方补充。`;
    expect(inspectMeshPlanarRegionCodexAnalysisDraft(draft, [block])).toEqual({
      status: 'complete',
      completeBlockCount: 1,
      matchedBlock: block
    });
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock(draft, [block])).toEqual({
      draft: '请保留前方要求。\n\n请保留后方补充。',
      status: 'removed'
    });
  });

  it('只含诊断块时移除为空草稿且不自动保留不可见内容', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n实际作用比例：96.54%')!;
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock(block, [block])).toEqual({ draft: '', status: 'removed' });
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock('', [block])).toEqual({ draft: '', status: 'not-found' });
  });

  it('诊断块被手工编辑或仅剩部分内容时拒绝模糊删除', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n模型体积变化：+180.00 立方毫米')!;
    const edited = block.replace('+180.00', '+200.00');
    expect(inspectMeshPlanarRegionCodexAnalysisDraft(edited, [block])).toMatchObject({ status: 'edited' });
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock(edited, [block])).toEqual({ draft: edited, status: 'unsafe' });

    const partial = '用户要求\n\n【共面区域几何诊断分析请求】\n共面区域几何诊断';
    expect(inspectMeshPlanarRegionCodexAnalysisDraft(partial, [block])).toMatchObject({ status: 'edited' });
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock(partial, [block])).toEqual({ draft: partial, status: 'unsafe' });
  });

  it('重复完整诊断块属于歧义状态并保持草稿不变', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n方向状态：压入减量一致')!;
    const repeated = `${block}\n\n${block}`;
    expect(inspectMeshPlanarRegionCodexAnalysisDraft(repeated, [block])).toEqual({
      status: 'ambiguous',
      completeBlockCount: 2,
      matchedBlock: null
    });
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock(repeated, [block])).toEqual({
      draft: repeated,
      status: 'unsafe'
    });
  });

  it('未登记的相似文本不作为本页系统诊断块删除', () => {
    const pasted = createMeshPlanarRegionCodexAnalysisRequest('用户自己粘贴的诊断')!;
    expect(inspectMeshPlanarRegionCodexAnalysisDraft(pasted, [])).toMatchObject({ status: 'edited' });
    expect(removeMeshPlanarRegionCodexAnalysisDraftBlock(pasted, [])).toEqual({ draft: pasted, status: 'unsafe' });
  });


  it('返回唯一完整诊断块在前后用户文字之间的精确字符范围和摘要', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest([
      '共面区域几何诊断',
      '操作模式：向外加料',
      '方向状态：加料增量一致'
    ].join('\n'))!;
    const draft = `前方用户文字\n\n${block}\n\n后方用户文字`;
    const location = createMeshPlanarRegionCodexDraftBlockLocation(draft, [block]);
    expect(location).toEqual({
      start: '前方用户文字\n\n'.length,
      end: '前方用户文字\n\n'.length + block.length,
      lineCount: 6,
      operationMode: '向外加料',
      directionStatus: '加料增量一致'
    });
    expect(draft.slice(location!.start, location!.end)).toBe(block);
  });

  it('诊断块位于草稿开头或多行文字之后时仍返回稳定范围', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n操作模式：向内压入\n方向状态：压入减量一致')!;
    expect(createMeshPlanarRegionCodexDraftBlockLocation(block, [block])?.start).toBe(0);
    const afterThreeLines = `第一行\n第二行\n第三行\n\n${block}`;
    const location = createMeshPlanarRegionCodexDraftBlockLocation(afterThreeLines, [block])!;
    expect(location.start).toBe('第一行\n第二行\n第三行\n\n'.length);
    expect(location.operationMode).toBe('向内压入');
  });

  it('缺少操作或方向字段时摘要安全降级但范围保持精确', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('用户保留的其他诊断内容')!;
    expect(createMeshPlanarRegionCodexDraftBlockLocation(block, [block])).toMatchObject({
      start: 0,
      end: block.length,
      operationMode: '未识别',
      directionStatus: '未识别'
    });
  });

  it('编辑、残缺或重复诊断块不返回可猜测定位范围', () => {
    const block = createMeshPlanarRegionCodexAnalysisRequest('共面区域几何诊断\n操作模式：向外加料\n方向状态：加料增量一致')!;
    expect(createMeshPlanarRegionCodexDraftBlockLocation(block.replace('向外加料', '手工修改'), [block])).toBeNull();
    expect(createMeshPlanarRegionCodexDraftBlockLocation('【共面区域几何诊断分析请求】', [block])).toBeNull();
    expect(createMeshPlanarRegionCodexDraftBlockLocation(`${block}\n\n${block}`, [block])).toBeNull();
  });
});
