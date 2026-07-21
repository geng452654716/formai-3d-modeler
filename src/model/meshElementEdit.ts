import type { ModelBoundsMm, ImportedStlModel } from './importedModel';

export type MeshElementKind = 'vertex' | 'edge' | 'face';
export type MeshElementEditMode = 'off' | MeshElementKind;
export type MeshElementSelectionMethod = 'click' | 'box';

export interface MeshPointMm {
  x: number;
  y: number;
  z: number;
}

/** 绑定上传模型当前修订的单个 STL 网格元素。 */
export interface MeshElementSelection {
  revision: string;
  sourcePartId: 'uploaded-model';
  kind: MeshElementKind;
  triangleIndex: number;
  elementIndex: number;
  triangleMm: [MeshPointMm, MeshPointMm, MeshPointMm];
}

/** 同一种类、同一上传模型修订上的去重网格元素集合。 */
export interface MeshElementSelectionSet {
  revision: string;
  sourcePartId: 'uploaded-model';
  kind: MeshElementKind;
  selectionMethod: MeshElementSelectionMethod;
  elements: MeshElementSelection[];
}

export interface MeshElementBoxSelectionRequest {
  id: number;
  rectangle: { left: number; top: number; right: number; bottom: number };
}

export interface MeshElementProjectionTriangle {
  triangleIndex: number;
  triangleMm: [MeshPointMm, MeshPointMm, MeshPointMm];
  triangleWorld: [MeshPointMm, MeshPointMm, MeshPointMm];
}

export interface MeshScreenProjection {
  x: number;
  y: number;
  depth: number;
}

export interface MeshElementMoveRequest {
  selection: MeshElementSelectionSet;
  displacementMm: MeshPointMm;
}

export interface MeshElementEditResult {
  status: 'ok';
  revision: string;
  selectionRevision: string;
  sourcePartId: 'uploaded-model';
  kind: MeshElementKind;
  selectionMethod: MeshElementSelectionMethod;
  selectedElementCount: number;
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
export const MAX_MESH_ELEMENT_SELECTIONS = 512;

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

function coordinateKey(point: MeshPointMm) {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
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

/** 使用源毫米坐标为顶点和边去重，面使用当前修订三角面索引去重。 */
export function meshElementSelectionKey(selection: MeshElementSelection) {
  if (selection.kind === 'vertex') return `vertex:${coordinateKey(selection.triangleMm[selection.elementIndex])}`;
  if (selection.kind === 'edge') {
    const [start, end] = MESH_EDGE_VERTEX_INDEXES[selection.elementIndex];
    return `edge:${[coordinateKey(selection.triangleMm[start]), coordinateKey(selection.triangleMm[end])].sort().join('|')}`;
  }
  return `face:${selection.triangleIndex}`;
}

/** 校验并去重同一修订、同一种类的选择集合。 */
export function createMeshElementSelectionSet(
  elements: MeshElementSelection[],
  selectionMethod: MeshElementSelectionMethod
): MeshElementSelectionSet | null {
  const first = elements[0];
  if (!first) return null;
  const unique = Array.from(new Map(
    elements
      .filter((element) => (
        element.sourcePartId === 'uploaded-model'
        && element.revision === first.revision
        && element.kind === first.kind
      ))
      .map((element) => [meshElementSelectionKey(element), element])
  ).values()).slice(0, MAX_MESH_ELEMENT_SELECTIONS);
  if (!unique.length) return null;
  return {
    revision: first.revision,
    sourcePartId: 'uploaded-model',
    kind: first.kind,
    selectionMethod,
    elements: unique
  };
}

/** 返回单个元素的视口高亮源坐标。 */
export function selectedMeshElementPoints(selection: MeshElementSelection) {
  if (selection.kind === 'vertex') return [selection.triangleMm[selection.elementIndex]];
  if (selection.kind === 'edge') {
    const [start, end] = MESH_EDGE_VERTEX_INDEXES[selection.elementIndex];
    return [selection.triangleMm[start], selection.triangleMm[end]];
  }
  return selection.triangleMm;
}


function averagePoints(points: MeshPointMm[]) {
  const divisor = points.length;
  return {
    x: points.reduce((total, point) => total + point.x, 0) / divisor,
    y: points.reduce((total, point) => total + point.y, 0) / divisor,
    z: points.reduce((total, point) => total + point.z, 0) / divisor
  };
}

/**
 * 按当前视角的归一化屏幕投影收集同类网格元素。
 * 顶点使用顶点投影，边使用三维中点投影，面使用三维重心投影；候选按遍历顺序保留前 512 个。
 */
export function collectMeshElementBoxSelection(
  revision: string,
  kind: MeshElementKind,
  rectangle: MeshElementBoxSelectionRequest['rectangle'],
  triangles: Iterable<MeshElementProjectionTriangle>,
  projectPoint: (point: MeshPointMm) => MeshScreenProjection | null,
  limit = MAX_MESH_ELEMENT_SELECTIONS
) {
  const selected = new Map<string, MeshElementSelection>();
  let limitReached = false;

  selectionLoop: for (const triangle of triangles) {
    const candidates: Array<{ elementIndex: number; point: MeshPointMm }> = kind === 'vertex'
      ? triangle.triangleWorld.map((point, elementIndex) => ({ elementIndex, point }))
      : kind === 'edge'
        ? MESH_EDGE_VERTEX_INDEXES.map(([start, end], elementIndex) => ({
            elementIndex,
            point: averagePoints([triangle.triangleWorld[start], triangle.triangleWorld[end]])
          }))
        : [{ elementIndex: 0, point: averagePoints(triangle.triangleWorld) }];

    for (const candidate of candidates) {
      const projected = projectPoint(candidate.point);
      if (!projected || projected.depth < -1 || projected.depth > 1) continue;
      if (
        projected.x < rectangle.left
        || projected.x > rectangle.right
        || projected.y < rectangle.top
        || projected.y > rectangle.bottom
      ) continue;
      const selection: MeshElementSelection = {
        revision,
        sourcePartId: 'uploaded-model',
        kind,
        triangleIndex: triangle.triangleIndex,
        elementIndex: candidate.elementIndex,
        triangleMm: triangle.triangleMm
      };
      const key = meshElementSelectionKey(selection);
      if (selected.has(key)) continue;
      if (selected.size >= limit) {
        limitReached = true;
        break selectionLoop;
      }
      selected.set(key, selection);
    }
  }

  return {
    selectionSet: createMeshElementSelectionSet([...selected.values()], 'box'),
    limitReached
  };
}
