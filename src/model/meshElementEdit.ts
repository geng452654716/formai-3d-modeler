import type { ModelBoundsMm, ImportedStlModel } from './importedModel';

export type MeshElementKind = 'vertex' | 'edge' | 'face';
export type MeshElementEditMode = 'off' | MeshElementKind;

export interface MeshPointMm {
  x: number;
  y: number;
  z: number;
}

/** 绑定上传模型当前修订的单个 STL 网格元素选择。 */
export interface MeshElementSelection {
  revision: string;
  sourcePartId: 'uploaded-model';
  kind: MeshElementKind;
  triangleIndex: number;
  elementIndex: number;
  triangleMm: [MeshPointMm, MeshPointMm, MeshPointMm];
}

export interface MeshElementMoveRequest {
  selection: MeshElementSelection;
  displacementMm: MeshPointMm;
}

export interface MeshElementEditResult {
  status: 'ok';
  revision: string;
  selectionRevision: string;
  sourcePartId: 'uploaded-model';
  kind: MeshElementKind;
  triangleIndex: number;
  elementIndex: number;
  displacementMm: MeshPointMm;
  movedCoordinateCount: number;
  movedVertexOccurrenceCount: number;
  sourceFile: string;
  stepFile: string;
  outputs: string[];
  units: 'mm';
  kernel: string;
  validation: {
    valid: boolean;
    watertight: boolean;
    solidCountBefore: number;
    solidCountAfter: number;
    volumeBeforeMm3: number;
    volumeAfterMm3: number;
    volumeDeltaMm3: number;
    boundsBeforeMm: ModelBoundsMm;
    boundsAfterMm: ModelBoundsMm;
  };
  updatedModel: ImportedStlModel;
  limitations: string[];
}

export const MESH_ELEMENT_LABELS: Record<MeshElementKind, string> = {
  vertex: '顶点',
  edge: '边',
  face: '面'
};

export const MESH_EDGE_VERTEX_INDEXES = [[0, 1], [1, 2], [2, 0]] as const;

function squaredDistance(left: MeshPointMm, right: MeshPointMm) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function squaredDistanceToSegment(point: MeshPointMm, start: MeshPointMm, end: MeshPointMm) {
  const segment = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const lengthSquared = segment.x ** 2 + segment.y ** 2 + segment.z ** 2;
  if (lengthSquared <= 1e-16) return squaredDistance(point, start);
  const ratio = Math.max(0, Math.min(1, (
    (point.x - start.x) * segment.x
    + (point.y - start.y) * segment.y
    + (point.z - start.z) * segment.z
  ) / lengthSquared));
  return squaredDistance(point, {
    x: start.x + segment.x * ratio,
    y: start.y + segment.y * ratio,
    z: start.z + segment.z * ratio
  });
}

/** 根据点击点在命中三角面内选择最近顶点或最近边。 */
export function nearestMeshElementIndex(
  kind: MeshElementKind,
  triangle: [MeshPointMm, MeshPointMm, MeshPointMm],
  point: MeshPointMm
) {
  if (kind === 'face') return 0;
  if (kind === 'vertex') {
    return triangle.reduce((best, candidate, index) => (
      squaredDistance(candidate, point) < squaredDistance(triangle[best], point) ? index : best
    ), 0);
  }
  return MESH_EDGE_VERTEX_INDEXES.reduce((best, [start, end], index) => (
    squaredDistanceToSegment(point, triangle[start], triangle[end])
      < squaredDistanceToSegment(point, triangle[MESH_EDGE_VERTEX_INDEXES[best][0]], triangle[MESH_EDGE_VERTEX_INDEXES[best][1]])
      ? index
      : best
  ), 0);
}

/** 返回视口高亮所需的选中元素源坐标。 */
export function selectedMeshElementPoints(selection: MeshElementSelection) {
  if (selection.kind === 'vertex') return [selection.triangleMm[selection.elementIndex]];
  if (selection.kind === 'edge') {
    const [start, end] = MESH_EDGE_VERTEX_INDEXES[selection.elementIndex];
    return [selection.triangleMm[start], selection.triangleMm[end]];
  }
  return selection.triangleMm;
}
