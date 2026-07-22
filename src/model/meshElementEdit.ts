import type { ModelBoundsMm, ImportedStlModel } from './importedModel';

export type MeshElementKind = 'vertex' | 'edge' | 'face';
export type MeshElementEditMode = 'off' | MeshElementKind;
export type MeshElementSelectionMethod = 'click' | 'box';
export type MeshTransformAxis = 'x' | 'y' | 'z';
export type MeshElementTransformKind = 'move' | 'rotate' | 'scale' | 'extrude-face';
export type MeshFaceExtrusionMode = 'add' | 'cut';

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

/** 视口从上传 STL 恢复出的单个源毫米三角面。 */
export interface MeshPlanarRegionTriangle {
  triangleIndex: number;
  triangleMm: [MeshPointMm, MeshPointMm, MeshPointMm];
}

/** 上传模型当前修订可复用的三角面索引、共享边和源坐标拓扑。 */
export interface MeshPlanarRegionTopology {
  triangleByIndex: Map<number, MeshPlanarRegionTriangle>;
  edgeOwners: Map<string, number[]>;
  pointByKey: Map<string, MeshPointMm>;
}

/** 连续共面区域在正式调用 Worker 前的只读预览和测量结果。 */
export interface MeshPlanarRegionPreview {
  revision: string;
  seedTriangleIndex: number;
  triangleIndexes: number[];
  affectedTriangleCount: number;
  regionAreaMm2: number;
  boundaryLoopCount: number;
  boundaryLoopsMm: MeshPointMm[][];
  normalToleranceDegrees: number;
  planeToleranceMm: number;
}

export interface MeshScreenProjection {
  x: number;
  y: number;
  depth: number;
}

export type MeshElementTransformOperation =
  | { kind: 'move'; displacementMm: MeshPointMm }
  | { kind: 'rotate'; axis: MeshTransformAxis; angleDegrees: number }
  | { kind: 'scale'; scaleFactor: number }
  | { kind: 'extrude-face'; mode: MeshFaceExtrusionMode; distanceMm: number };

export interface MeshElementTransformRequest {
  selection: MeshElementSelectionSet;
  operation: MeshElementTransformOperation;
}

/** 兼容既有位移调用的请求别名。 */
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
  affectedTriangleCount?: number;
  regionAreaMm2?: number;
  boundaryLoopCount?: number;
  normalToleranceDegrees?: number;
  planeToleranceMm?: number;
  operation: MeshElementTransformKind;
  pivotMm: MeshPointMm;
  displacementMm?: MeshPointMm;
  rotationAxis?: MeshTransformAxis;
  rotationDegrees?: number;
  scaleFactor?: number;
  faceExtrusionMode?: MeshFaceExtrusionMode;
  distanceMm?: number;
  outwardNormal?: MeshPointMm;
  toolVolumeMm3?: number;
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
export const MAX_PLANAR_REGION_TRIANGLES = 20_000;
export const MAX_PLANAR_REGION_AREA_MM2 = 200_000;
export const PLANAR_REGION_NORMAL_TOLERANCE_DEGREES = 0.5;

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

function planarRegionEdgeKey(start: MeshPointMm, end: MeshPointMm) {
  return [coordinateKey(start), coordinateKey(end)].sort().join('|');
}

function triangleArea(triangle: [MeshPointMm, MeshPointMm, MeshPointMm]) {
  const [a, b, c] = triangle;
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return Math.hypot(
    ab.y * ac.z - ab.z * ac.y,
    ab.z * ac.x - ab.x * ac.z,
    ab.x * ac.y - ab.y * ac.x
  ) / 2;
}

function triangleUnitNormal(triangle: [MeshPointMm, MeshPointMm, MeshPointMm]) {
  const [a, b, c] = triangle;
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const normal = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x
  };
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (length <= 1e-9) throw new Error('共面区域预览遇到退化三角面，请先修复网格');
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

/** 为同一上传模型修订构建可复用的三角面索引和共享边拓扑。 */
export function createMeshPlanarRegionTopology(
  triangles: Iterable<MeshPlanarRegionTriangle>
): MeshPlanarRegionTopology {
  const triangleByIndex = new Map<number, MeshPlanarRegionTriangle>();
  const edgeOwners = new Map<string, number[]>();
  const pointByKey = new Map<string, MeshPointMm>();
  for (const triangle of triangles) triangleByIndex.set(triangle.triangleIndex, triangle);
  for (const triangle of triangleByIndex.values()) {
    for (const point of triangle.triangleMm) {
      const key = coordinateKey(point);
      if (!pointByKey.has(key)) pointByKey.set(key, { ...point });
    }
    for (const [start, end] of MESH_EDGE_VERTEX_INDEXES) {
      const key = planarRegionEdgeKey(triangle.triangleMm[start], triangle.triangleMm[end]);
      const owners = edgeOwners.get(key);
      if (owners) owners.push(triangle.triangleIndex);
      else edgeOwners.set(key, [triangle.triangleIndex]);
    }
  }
  return { triangleByIndex, edgeOwners, pointByKey };
}

function isMeshPlanarRegionTopology(
  value: Iterable<MeshPlanarRegionTriangle> | MeshPlanarRegionTopology
): value is MeshPlanarRegionTopology {
  return 'triangleByIndex' in value && 'edgeOwners' in value && 'pointByKey' in value;
}

/** 使用与桌面 Worker 一致的拓扑、公差和资源上限扩展连续共面区域。 */
export function expandMeshPlanarRegion(
  revision: string,
  seedTriangleIndex: number,
  trianglesOrTopology: Iterable<MeshPlanarRegionTriangle> | MeshPlanarRegionTopology,
  modelDiagonalMm: number
): MeshPlanarRegionPreview {
  const topology = isMeshPlanarRegionTopology(trianglesOrTopology)
    ? trianglesOrTopology
    : createMeshPlanarRegionTopology(trianglesOrTopology);
  const { triangleByIndex, edgeOwners, pointByKey } = topology;
  const seed = triangleByIndex.get(seedTriangleIndex);
  if (!seed) throw new Error('没有找到种子三角面，请重新点击模型');
  const seedNormal = triangleUnitNormal(seed.triangleMm);
  const seedOrigin = seed.triangleMm[0];
  const cosineLimit = Math.cos(PLANAR_REGION_NORMAL_TOLERANCE_DEGREES * Math.PI / 180);
  const planeToleranceMm = Math.max(0.00001, Math.min(0.02, modelDiagonalMm * 0.000001));
  const isCoplanar = (triangle: MeshPlanarRegionTriangle) => {
    const normal = triangleUnitNormal(triangle.triangleMm);
    const dot = Math.abs(normal.x * seedNormal.x + normal.y * seedNormal.y + normal.z * seedNormal.z);
    if (dot < cosineLimit) return false;
    return triangle.triangleMm.every((point) => Math.abs(
      (point.x - seedOrigin.x) * seedNormal.x
      + (point.y - seedOrigin.y) * seedNormal.y
      + (point.z - seedOrigin.z) * seedNormal.z
    ) <= planeToleranceMm);
  };

  const region = new Set([seedTriangleIndex]);
  const pending = [seedTriangleIndex];
  let regionAreaMm2 = triangleArea(seed.triangleMm);
  if (regionAreaMm2 > MAX_PLANAR_REGION_AREA_MM2) {
    throw new Error(`共面区域预览面积超过 ${MAX_PLANAR_REGION_AREA_MM2} 平方毫米上限，请先拆分模型`);
  }
  while (pending.length) {
    const current = triangleByIndex.get(pending.pop()!)!;
    for (const [start, end] of MESH_EDGE_VERTEX_INDEXES) {
      const owners = edgeOwners.get(planarRegionEdgeKey(current.triangleMm[start], current.triangleMm[end])) ?? [];
      if (owners.length > 2) throw new Error('共面区域预览遇到非流形共享边，无法安全扩展');
      for (const neighborIndex of owners) {
        const neighbor = triangleByIndex.get(neighborIndex);
        if (!neighbor || region.has(neighborIndex) || !isCoplanar(neighbor)) continue;
        const nextArea = regionAreaMm2 + triangleArea(neighbor.triangleMm);
        if (region.size + 1 > MAX_PLANAR_REGION_TRIANGLES) {
          throw new Error(`共面区域预览超过 ${MAX_PLANAR_REGION_TRIANGLES} 个三角面上限，请先简化网格或缩小平面区域`);
        }
        if (nextArea > MAX_PLANAR_REGION_AREA_MM2) {
          throw new Error(`共面区域预览面积超过 ${MAX_PLANAR_REGION_AREA_MM2} 平方毫米上限，请先拆分模型`);
        }
        region.add(neighborIndex);
        pending.push(neighborIndex);
        regionAreaMm2 = nextArea;
      }
    }
  }

  const edgeCounts = new Map<string, number>();
  for (const triangleIndex of region) {
    const triangle = triangleByIndex.get(triangleIndex)!;
    for (const [start, end] of MESH_EDGE_VERTEX_INDEXES) {
      const key = planarRegionEdgeKey(triangle.triangleMm[start], triangle.triangleMm[end]);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  if ([...edgeCounts.values()].some((count) => count > 2)) {
    throw new Error('共面区域预览包含非流形共享边，无法构造单一封闭工具体');
  }
  const boundaryEdges = [...edgeCounts].filter(([, count]) => count === 1).map(([key]) => key);
  if (!boundaryEdges.length) throw new Error('共面区域预览没有可识别的闭合边界');
  const adjacency = new Map<string, string[]>();
  for (const edge of boundaryEdges) {
    const [start, end] = edge.split('|');
    adjacency.set(start, [...(adjacency.get(start) ?? []), end]);
    adjacency.set(end, [...(adjacency.get(end) ?? []), start]);
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.length !== 2)) {
    throw new Error('共面区域预览边界存在分叉或开口');
  }
  const unused = new Set(boundaryEdges);
  const boundaryLoopsMm: MeshPointMm[][] = [];
  while (unused.size) {
    const firstEdge = unused.values().next().value as string;
    const [start, first] = firstEdge.split('|');
    const loopKeys = [start];
    let current = first;
    let previous = start;
    unused.delete(firstEdge);
    while (current !== start) {
      loopKeys.push(current);
      const following = (adjacency.get(current) ?? []).find((candidate) => {
        const key = [current, candidate].sort().join('|');
        return candidate !== previous && unused.has(key);
      });
      if (!following) throw new Error('共面区域预览边界未闭合');
      unused.delete([current, following].sort().join('|'));
      previous = current;
      current = following;
      if (loopKeys.length > boundaryEdges.length + 1) throw new Error('共面区域预览边界遍历异常');
    }
    if (loopKeys.length < 3) throw new Error('共面区域预览边界退化');
    boundaryLoopsMm.push(loopKeys.map((key) => {
      const point = pointByKey.get(key);
      if (!point) throw new Error('共面区域预览边界坐标缺失');
      return { ...point };
    }));
  }
  const triangleIndexes = [...region].sort((left, right) => left - right);
  return {
    revision,
    seedTriangleIndex,
    triangleIndexes,
    affectedTriangleCount: triangleIndexes.length,
    regionAreaMm2,
    boundaryLoopCount: boundaryLoopsMm.length,
    boundaryLoopsMm,
    normalToleranceDegrees: PLANAR_REGION_NORMAL_TOLERANCE_DEGREES,
    planeToleranceMm
  };
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

/** 汇总选择集合中的唯一源坐标，作为统一旋转和缩放的稳定输入。 */
export function uniqueMeshElementSelectionPoints(selection: MeshElementSelectionSet) {
  return Array.from(new Map(
    selection.elements.flatMap(selectedMeshElementPoints).map((point) => [coordinateKey(point), point])
  ).values());
}

/** 计算选择集合唯一源坐标的几何中心。 */
export function meshElementSelectionPivot(selection: MeshElementSelectionSet) {
  const points = uniqueMeshElementSelectionPoints(selection);
  return points.length ? averagePoints(points) : null;
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
