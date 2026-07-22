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

export type MeshPlanarRegionBoundaryKind = 'outer' | 'hole';

/** 单个平面边界环的语义和二维测量结果。 */
export interface MeshPlanarRegionMeasurementFrame {
  originMm: MeshPointMm;
  axisU: MeshPointMm;
  axisV: MeshPointMm;
  minUMm: number;
  maxUMm: number;
  minVMm: number;
  maxVMm: number;
}

export interface MeshPlanarRegionBoundaryLoop {
  kind: MeshPlanarRegionBoundaryKind;
  pointsMm: MeshPointMm[];
  perimeterMm: number;
  boundsMm: { widthMm: number; heightMm: number };
  measurementFrame: MeshPlanarRegionMeasurementFrame;
  nestingDepth: number;
}

export type MeshPlanarDimensionSegmentMm = [MeshPointMm, MeshPointMm];

export interface MeshPlanarDimensionAxisGuide {
  valueMm: number;
  dimensionLineMm: MeshPlanarDimensionSegmentMm;
  extensionLinesMm: [MeshPlanarDimensionSegmentMm, MeshPlanarDimensionSegmentMm];
  capLinesMm: [MeshPlanarDimensionSegmentMm, MeshPlanarDimensionSegmentMm];
  labelMm: MeshPointMm;
}

export interface MeshPlanarRegionDimensionGuides {
  offsetMm: number;
  width: MeshPlanarDimensionAxisGuide;
  height: MeshPlanarDimensionAxisGuide;
  summaryLabelMm: MeshPointMm;
}

export type MeshPlanarDimensionSide = 'negative' | 'positive';

export interface MeshPlanarRegionDimensionLayout {
  widthSide: MeshPlanarDimensionSide;
  heightSide: MeshPlanarDimensionSide;
  summarySide: MeshPlanarDimensionSide;
}

export interface MeshPlanarDimensionViewportAnchor {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

export interface MeshPlanarDimensionViewportCandidate {
  layoutIndex: number;
  anchors: [
    MeshPlanarDimensionViewportAnchor,
    MeshPlanarDimensionViewportAnchor,
    MeshPlanarDimensionViewportAnchor
  ];
}

export interface MeshPlanarDimensionViewportSafeArea {
  leftPx: number;
  topPx: number;
  rightPx: number;
  bottomPx: number;
}

/** 宽度与摘要保持相反侧，高度可左右翻转，形成稳定且有限的四组视口候选。 */
export const MESH_PLANAR_REGION_DIMENSION_LAYOUTS: readonly MeshPlanarRegionDimensionLayout[] = [
  { widthSide: 'negative', heightSide: 'positive', summarySide: 'positive' },
  { widthSide: 'positive', heightSide: 'positive', summarySide: 'negative' },
  { widthSide: 'negative', heightSide: 'negative', summarySide: 'positive' },
  { widthSide: 'positive', heightSide: 'negative', summarySide: 'negative' }
];

/** 连续共面区域在正式调用 Worker 前的只读预览和测量结果。 */
export interface MeshPlanarRegionPreview {
  revision: string;
  seedTriangleIndex: number;
  triangleIndexes: number[];
  affectedTriangleCount: number;
  regionAreaMm2: number;
  boundaryLoopCount: number;
  outerBoundaryLoopCount: number;
  holeBoundaryLoopCount: number;
  boundaryLoopsMm: MeshPointMm[][];
  boundaryLoops: MeshPlanarRegionBoundaryLoop[];
  /** 前端预演使用的网格绕序推断外法线；桌面 Worker 仍会独立确认真实实体内外。 */
  outwardNormalMm: MeshPointMm;
  normalToleranceDegrees: number;
  planeToleranceMm: number;
}

export interface MeshPlanarRegionExtrusionPreviewProfile {
  originMm: MeshPointMm;
  axisU: MeshPointMm;
  axisV: MeshPointMm;
  directionNormalMm: MeshPointMm;
  distanceMm: number;
  outer: { x: number; y: number }[];
  holes: { x: number; y: number }[][];
  directionStartMm: MeshPointMm;
  directionEndMm: MeshPointMm;
  labelPointMm: MeshPointMm;
}

export interface MeshPlanarRegionExtrusionPreviewLoopGuide {
  kind: MeshPlanarRegionBoundaryKind;
  startLoopMm: MeshPointMm[];
  endLoopMm: MeshPointMm[];
  sideSegmentsMm: MeshPlanarDimensionSegmentMm[];
}

export interface MeshPlanarRegionExtrusionPreviewGuides {
  loops: MeshPlanarRegionExtrusionPreviewLoopGuide[];
  directionEndMm: MeshPointMm;
  endpointMarkerSegmentsMm: [MeshPlanarDimensionSegmentMm, MeshPlanarDimensionSegmentMm];
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

/** 在当前边界环列表中按指定方向循环定位，空列表返回未聚焦。 */
export function cycleMeshPlanarRegionLoopIndex(
  currentIndex: number | null,
  loopCount: number,
  direction: 'previous' | 'next'
) {
  if (!Number.isInteger(loopCount) || loopCount <= 0) return null;
  if (currentIndex === null || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= loopCount) {
    return direction === 'next' ? 0 : loopCount - 1;
  }
  return direction === 'next'
    ? (currentIndex + 1) % loopCount
    : (currentIndex - 1 + loopCount) % loopCount;
}

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

/** 通过闭合 STL 的有符号体积修正种子三角面绕序，开口或近零体积网格保持种子方向作为安全回退。 */
function meshOutwardNormal(
  seedNormal: MeshPointMm,
  triangles: Iterable<MeshPlanarRegionTriangle>
) {
  let signedVolumeTimesSix = 0;
  for (const { triangleMm: [a, b, c] } of triangles) {
    signedVolumeTimesSix += a.x * (b.y * c.z - b.z * c.y)
      + a.y * (b.z * c.x - b.x * c.z)
      + a.z * (b.x * c.y - b.y * c.x);
  }
  if (!Number.isFinite(signedVolumeTimesSix) || Math.abs(signedVolumeTimesSix) < 1e-9) {
    return { ...seedNormal };
  }
  return signedVolumeTimesSix < 0
    ? { x: -seedNormal.x, y: -seedNormal.y, z: -seedNormal.z }
    : { ...seedNormal };
}

function meshPointAlong(start: MeshPointMm, direction: MeshPointMm, distanceMm: number) {
  return {
    x: start.x + direction.x * distanceMm,
    y: start.y + direction.y * distanceMm,
    z: start.z + direction.z * distanceMm
  };
}

/** 把当前带孔共面区域转换为法向加料或压入的只读二维工具体轮廓。 */
export function createMeshPlanarRegionExtrusionPreviewProfile(
  preview: MeshPlanarRegionPreview,
  mode: MeshFaceExtrusionMode,
  distanceMm: number
): MeshPlanarRegionExtrusionPreviewProfile | null {
  if (!Number.isFinite(distanceMm) || distanceMm < 0.2 || distanceMm > 100) return null;
  const outerLoops = preview.boundaryLoops.filter((loop) => loop.kind === 'outer' && loop.pointsMm.length >= 3);
  if (outerLoops.length !== 1) return null;
  const outerLoop = outerLoops[0];
  const frame = outerLoop.measurementFrame;
  const normalLength = Math.hypot(
    preview.outwardNormalMm.x,
    preview.outwardNormalMm.y,
    preview.outwardNormalMm.z
  );
  if (!Number.isFinite(normalLength) || normalLength < 1e-9) return null;
  const outwardNormal = {
    x: preview.outwardNormalMm.x / normalLength,
    y: preview.outwardNormalMm.y / normalLength,
    z: preview.outwardNormalMm.z / normalLength
  };
  const directionNormalMm = mode === 'add'
    ? outwardNormal
    : { x: -outwardNormal.x, y: -outwardNormal.y, z: -outwardNormal.z };
  const projectLoop = (loop: MeshPlanarRegionBoundaryLoop) => loop.pointsMm.map((point) => {
    const offset = {
      x: point.x - frame.originMm.x,
      y: point.y - frame.originMm.y,
      z: point.z - frame.originMm.z
    };
    return {
      x: offset.x * frame.axisU.x + offset.y * frame.axisU.y + offset.z * frame.axisU.z,
      y: offset.x * frame.axisV.x + offset.y * frame.axisV.y + offset.z * frame.axisV.z
    };
  });
  const outer = projectLoop(outerLoop);
  const holes = preview.boundaryLoops
    .filter((loop) => loop.kind === 'hole' && loop.pointsMm.length >= 3)
    .map(projectLoop);
  if ([...outer, ...holes.flat()].some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return null;
  }
  const centerUMm = (frame.minUMm + frame.maxUMm) / 2;
  const centerVMm = (frame.minVMm + frame.maxVMm) / 2;
  const directionStartMm = {
    x: frame.originMm.x + frame.axisU.x * centerUMm + frame.axisV.x * centerVMm,
    y: frame.originMm.y + frame.axisU.y * centerUMm + frame.axisV.y * centerVMm,
    z: frame.originMm.z + frame.axisU.z * centerUMm + frame.axisV.z * centerVMm
  };
  const directionEndMm = meshPointAlong(directionStartMm, directionNormalMm, distanceMm);
  const labelClearanceMm = Math.max(1.5, Math.min(5, distanceMm * 0.25));
  return {
    originMm: { ...frame.originMm },
    axisU: { ...frame.axisU },
    axisV: { ...frame.axisV },
    directionNormalMm,
    distanceMm,
    outer,
    holes,
    directionStartMm,
    directionEndMm,
    labelPointMm: meshPointAlong(directionEndMm, directionNormalMm, labelClearanceMm)
  };
}

/** 从二维 profile 派生工具体起止端闭合轮廓和只读方向端点十字，不参与布尔计算。 */
export function createMeshPlanarRegionExtrusionPreviewGuides(
  profile: MeshPlanarRegionExtrusionPreviewProfile
): MeshPlanarRegionExtrusionPreviewGuides | null {
  const loops2d = [profile.outer, ...profile.holes];
  const allPlanePoints = loops2d.flat();
  const sourceBasisPoints = [
    profile.originMm,
    profile.axisU,
    profile.axisV,
    profile.directionNormalMm,
    profile.directionEndMm
  ];
  const signedAreaTwice = (loop: { x: number; y: number }[]) => loop.reduce((area, point, index) => {
    const next = loop[(index + 1) % loop.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  if (
    !Number.isFinite(profile.distanceMm)
    || profile.distanceMm <= 0
    || loops2d.some((loop) => loop.length < 3 || Math.abs(signedAreaTwice(loop)) <= 1e-9)
    || allPlanePoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    || sourceBasisPoints.some((point) => (
      !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)
    ))
    || Math.hypot(profile.axisU.x, profile.axisU.y, profile.axisU.z) <= 1e-9
    || Math.hypot(profile.axisV.x, profile.axisV.y, profile.axisV.z) <= 1e-9
    || Math.hypot(
      profile.directionNormalMm.x,
      profile.directionNormalMm.y,
      profile.directionNormalMm.z
    ) <= 1e-9
  ) return null;
  const planePointToSource = (point: { x: number; y: number }, depthMm: number) => ({
    x: profile.originMm.x
      + profile.axisU.x * point.x
      + profile.axisV.x * point.y
      + profile.directionNormalMm.x * depthMm,
    y: profile.originMm.y
      + profile.axisU.y * point.x
      + profile.axisV.y * point.y
      + profile.directionNormalMm.y * depthMm,
    z: profile.originMm.z
      + profile.axisU.z * point.x
      + profile.axisV.z * point.y
      + profile.directionNormalMm.z * depthMm
  });
  const closeLoop = (points: { x: number; y: number }[], depthMm: number) => {
    const sourcePoints = points.map((point) => planePointToSource(point, depthMm));
    return [...sourcePoints, { ...sourcePoints[0] }];
  };
  /** 为每个唯一环顶点建立一条起止端连接线，不重复闭合点。 */
  const createLoopGuide = (
    kind: MeshPlanarRegionBoundaryKind,
    points: { x: number; y: number }[]
  ): MeshPlanarRegionExtrusionPreviewLoopGuide => {
    const startLoopMm = closeLoop(points, 0);
    const endLoopMm = closeLoop(points, profile.distanceMm);
    return {
      kind,
      startLoopMm,
      endLoopMm,
      sideSegmentsMm: points.map((_, pointIndex) => [
        { ...startLoopMm[pointIndex] },
        { ...endLoopMm[pointIndex] }
      ])
    };
  };
  const loops: MeshPlanarRegionExtrusionPreviewLoopGuide[] = [
    createLoopGuide('outer', profile.outer),
    ...profile.holes.map((hole) => createLoopGuide('hole', hole))
  ];
  const minX = Math.min(...profile.outer.map((point) => point.x));
  const maxX = Math.max(...profile.outer.map((point) => point.x));
  const minY = Math.min(...profile.outer.map((point) => point.y));
  const maxY = Math.max(...profile.outer.map((point) => point.y));
  const markerHalfMm = Math.max(0.35, Math.min(2, Math.min(maxX - minX, maxY - minY) * 0.08));
  const markerPoint = (axis: MeshPointMm, sign: number) => ({
    x: profile.directionEndMm.x + axis.x * markerHalfMm * sign,
    y: profile.directionEndMm.y + axis.y * markerHalfMm * sign,
    z: profile.directionEndMm.z + axis.z * markerHalfMm * sign
  });
  return {
    loops,
    directionEndMm: { ...profile.directionEndMm },
    endpointMarkerSegmentsMm: [
      [markerPoint(profile.axisU, -1), markerPoint(profile.axisU, 1)],
      [markerPoint(profile.axisV, -1), markerPoint(profile.axisV, 1)]
    ]
  };
}


interface MeshPlanePoint {
  x: number;
  y: number;
}

/** 使用全局轴投影创建稳定的种子平面二维坐标系，避免测量随种子边方向变化。 */
function createMeshPlanarBasis(normal: MeshPointMm) {
  const axes: MeshPointMm[] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }
  ];
  const projected = axes.map((axis) => {
    const dot = axis.x * normal.x + axis.y * normal.y + axis.z * normal.z;
    const vector = {
      x: axis.x - normal.x * dot,
      y: axis.y - normal.y * dot,
      z: axis.z - normal.z * dot
    };
    return { vector, length: Math.hypot(vector.x, vector.y, vector.z) };
  }).sort((left, right) => right.length - left.length)[0];
  if (!projected || projected.length <= 1e-9) throw new Error('共面区域预览无法建立稳定的平面测量坐标系');
  const u = {
    x: projected.vector.x / projected.length,
    y: projected.vector.y / projected.length,
    z: projected.vector.z / projected.length
  };
  const v = {
    x: normal.y * u.z - normal.z * u.y,
    y: normal.z * u.x - normal.x * u.z,
    z: normal.x * u.y - normal.y * u.x
  };
  return { u, v };
}

function meshPlanarFramePoint(
  frame: MeshPlanarRegionMeasurementFrame,
  uMm: number,
  vMm: number
): MeshPointMm {
  return {
    x: frame.originMm.x + frame.axisU.x * uMm + frame.axisV.x * vMm,
    y: frame.originMm.y + frame.axisU.y * uMm + frame.axisV.y * vMm,
    z: frame.originMm.z + frame.axisU.z * uMm + frame.axisV.z * vMm
  };
}

/** 为聚焦边界环生成轮廓外的宽高尺寸线、延伸线、端点短线与标签锚点。 */
export function createMeshPlanarRegionDimensionGuides(
  loop: MeshPlanarRegionBoundaryLoop,
  layout: MeshPlanarRegionDimensionLayout = MESH_PLANAR_REGION_DIMENSION_LAYOUTS[0]
): MeshPlanarRegionDimensionGuides {
  const frame = loop.measurementFrame;
  const widthMm = frame.maxUMm - frame.minUMm;
  const heightMm = frame.maxVMm - frame.minVMm;
  if (![widthMm, heightMm].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('共面边界环尺寸无效，无法生成尺寸辅助线');
  }
  const offsetMm = Math.max(1.5, Math.min(6, Math.max(widthMm, heightMm) * 0.08));
  const extensionOverrunMm = Math.max(0.45, Math.min(1.5, offsetMm * 0.24));
  const capHalfLengthMm = Math.max(0.45, Math.min(1.25, offsetMm * 0.32));
  const labelClearanceMm = Math.max(0.75, Math.min(2.2, offsetMm * 0.45));
  const centerUMm = (frame.minUMm + frame.maxUMm) / 2;
  const centerVMm = (frame.minVMm + frame.maxVMm) / 2;
  const widthDirection = layout.widthSide === 'negative' ? -1 : 1;
  const heightDirection = layout.heightSide === 'negative' ? -1 : 1;
  const summaryDirection = layout.summarySide === 'negative' ? -1 : 1;
  const widthEdgeVMm = layout.widthSide === 'negative' ? frame.minVMm : frame.maxVMm;
  const heightEdgeUMm = layout.heightSide === 'negative' ? frame.minUMm : frame.maxUMm;
  const summaryEdgeVMm = layout.summarySide === 'negative' ? frame.minVMm : frame.maxVMm;
  const widthLineVMm = widthEdgeVMm + widthDirection * offsetMm;
  const heightLineUMm = heightEdgeUMm + heightDirection * offsetMm;
  return {
    offsetMm,
    width: {
      valueMm: widthMm,
      dimensionLineMm: [
        meshPlanarFramePoint(frame, frame.minUMm, widthLineVMm),
        meshPlanarFramePoint(frame, frame.maxUMm, widthLineVMm)
      ],
      extensionLinesMm: [
        [
          meshPlanarFramePoint(frame, frame.minUMm, widthEdgeVMm),
          meshPlanarFramePoint(frame, frame.minUMm, widthLineVMm + widthDirection * extensionOverrunMm)
        ],
        [
          meshPlanarFramePoint(frame, frame.maxUMm, widthEdgeVMm),
          meshPlanarFramePoint(frame, frame.maxUMm, widthLineVMm + widthDirection * extensionOverrunMm)
        ]
      ],
      capLinesMm: [
        [
          meshPlanarFramePoint(frame, frame.minUMm, widthLineVMm - capHalfLengthMm),
          meshPlanarFramePoint(frame, frame.minUMm, widthLineVMm + capHalfLengthMm)
        ],
        [
          meshPlanarFramePoint(frame, frame.maxUMm, widthLineVMm - capHalfLengthMm),
          meshPlanarFramePoint(frame, frame.maxUMm, widthLineVMm + capHalfLengthMm)
        ]
      ],
      labelMm: meshPlanarFramePoint(frame, centerUMm, widthLineVMm + widthDirection * labelClearanceMm)
    },
    height: {
      valueMm: heightMm,
      dimensionLineMm: [
        meshPlanarFramePoint(frame, heightLineUMm, frame.minVMm),
        meshPlanarFramePoint(frame, heightLineUMm, frame.maxVMm)
      ],
      extensionLinesMm: [
        [
          meshPlanarFramePoint(frame, heightEdgeUMm, frame.minVMm),
          meshPlanarFramePoint(frame, heightLineUMm + heightDirection * extensionOverrunMm, frame.minVMm)
        ],
        [
          meshPlanarFramePoint(frame, heightEdgeUMm, frame.maxVMm),
          meshPlanarFramePoint(frame, heightLineUMm + heightDirection * extensionOverrunMm, frame.maxVMm)
        ]
      ],
      capLinesMm: [
        [
          meshPlanarFramePoint(frame, heightLineUMm - capHalfLengthMm, frame.minVMm),
          meshPlanarFramePoint(frame, heightLineUMm + capHalfLengthMm, frame.minVMm)
        ],
        [
          meshPlanarFramePoint(frame, heightLineUMm - capHalfLengthMm, frame.maxVMm),
          meshPlanarFramePoint(frame, heightLineUMm + capHalfLengthMm, frame.maxVMm)
        ]
      ],
      labelMm: meshPlanarFramePoint(frame, heightLineUMm + heightDirection * labelClearanceMm, centerVMm)
    },
    summaryLabelMm: meshPlanarFramePoint(
      frame,
      centerUMm,
      summaryEdgeVMm + summaryDirection * (offsetMm + labelClearanceMm)
    )
  };
}

function meshPlanarViewportOverflowScore(
  anchor: MeshPlanarDimensionViewportAnchor,
  safeArea: MeshPlanarDimensionViewportSafeArea
) {
  const halfWidth = anchor.widthPx / 2;
  const halfHeight = anchor.heightPx / 2;
  const leftOverflow = Math.max(0, safeArea.leftPx - (anchor.xPx - halfWidth));
  const rightOverflow = Math.max(0, anchor.xPx + halfWidth - safeArea.rightPx);
  const topOverflow = Math.max(0, safeArea.topPx - (anchor.yPx - halfHeight));
  const bottomOverflow = Math.max(0, anchor.yPx + halfHeight - safeArea.bottomPx);
  return (leftOverflow ** 2 + rightOverflow ** 2 + topOverflow ** 2 + bottomOverflow ** 2) * 1000;
}

function meshPlanarViewportOverlapArea(
  left: MeshPlanarDimensionViewportAnchor,
  right: MeshPlanarDimensionViewportAnchor
) {
  const overlapWidth = Math.max(0, Math.min(
    left.xPx + left.widthPx / 2,
    right.xPx + right.widthPx / 2
  ) - Math.max(
    left.xPx - left.widthPx / 2,
    right.xPx - right.widthPx / 2
  ));
  const overlapHeight = Math.max(0, Math.min(
    left.yPx + left.heightPx / 2,
    right.yPx + right.heightPx / 2
  ) - Math.max(
    left.yPx - left.heightPx / 2,
    right.yPx - right.heightPx / 2
  ));
  return overlapWidth * overlapHeight;
}

/** 按安全区溢出和标签重叠评分选择最稳定的视口候选；同分时保留输入顺序。 */
export function selectMeshPlanarRegionDimensionLayout(
  candidates: MeshPlanarDimensionViewportCandidate[],
  safeArea: MeshPlanarDimensionViewportSafeArea
) {
  if (!candidates.length) return null;
  return candidates.reduce<{ layoutIndex: number; score: number } | null>((best, candidate) => {
    const overflowScore = candidate.anchors.reduce(
      (sum, anchor) => sum + meshPlanarViewportOverflowScore(anchor, safeArea),
      0
    );
    const overlapScore = candidate.anchors.reduce((sum, anchor, index) => (
      sum + candidate.anchors.slice(index + 1).reduce(
        (pairSum, other) => pairSum + meshPlanarViewportOverlapArea(anchor, other) * 10,
        0
      )
    ), 0);
    const score = overflowScore + overlapScore;
    return !best || score < best.score ? { layoutIndex: candidate.layoutIndex, score } : best;
  }, null)?.layoutIndex ?? null;
}

function projectMeshPlanarPoint(
  point: MeshPointMm,
  origin: MeshPointMm,
  basis: ReturnType<typeof createMeshPlanarBasis>
): MeshPlanePoint {
  const offset = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
  return {
    x: offset.x * basis.u.x + offset.y * basis.u.y + offset.z * basis.u.z,
    y: offset.x * basis.v.x + offset.y * basis.v.y + offset.z * basis.v.z
  };
}

/** 用二维射线法判断一个边界顶点是否位于另一个闭合环内部。 */
function meshPlanarPointInsideLoop(point: MeshPlanePoint, loop: MeshPlanePoint[]) {
  let inside = false;
  for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index++) {
    const start = loop[previous];
    const end = loop[index];
    const crosses = (start.y > point.y) !== (end.y > point.y)
      && point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** 基于二维环包含关系分类外环与孔洞，并计算周长和包围尺寸。 */
function measureMeshPlanarBoundaryLoops(
  loopsMm: MeshPointMm[][],
  origin: MeshPointMm,
  normal: MeshPointMm
): MeshPlanarRegionBoundaryLoop[] {
  const basis = createMeshPlanarBasis(normal);
  const projectedLoops = loopsMm.map((loop) => loop.map((point) => projectMeshPlanarPoint(point, origin, basis)));
  return loopsMm.map((pointsMm, loopIndex) => {
    const projected = projectedLoops[loopIndex];
    const nestingDepth = projectedLoops.reduce((depth, candidate, candidateIndex) => (
      candidateIndex !== loopIndex && meshPlanarPointInsideLoop(projected[0], candidate) ? depth + 1 : depth
    ), 0);
    if (nestingDepth > 1) throw new Error('共面区域预览暂不支持嵌套岛结构，请先拆分平面区域');
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const minUMm = Math.min(...xs);
    const maxUMm = Math.max(...xs);
    const minVMm = Math.min(...ys);
    const maxVMm = Math.max(...ys);
    const perimeterMm = pointsMm.reduce((sum, point, index) => {
      const next = pointsMm[(index + 1) % pointsMm.length];
      return sum + Math.hypot(next.x - point.x, next.y - point.y, next.z - point.z);
    }, 0);
    return {
      kind: nestingDepth === 0 ? 'outer' : 'hole',
      pointsMm: pointsMm.map((point) => ({ ...point })),
      perimeterMm,
      boundsMm: {
        widthMm: maxUMm - minUMm,
        heightMm: maxVMm - minVMm
      },
      measurementFrame: {
        originMm: { ...origin },
        axisU: { ...basis.u },
        axisV: { ...basis.v },
        minUMm,
        maxUMm,
        minVMm,
        maxVMm
      },
      nestingDepth
    };
  });
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
  const boundaryLoops = measureMeshPlanarBoundaryLoops(boundaryLoopsMm, seedOrigin, seedNormal);
  const outwardNormalMm = meshOutwardNormal(seedNormal, triangleByIndex.values());
  const triangleIndexes = [...region].sort((left, right) => left - right);
  return {
    revision,
    seedTriangleIndex,
    triangleIndexes,
    affectedTriangleCount: triangleIndexes.length,
    regionAreaMm2,
    boundaryLoopCount: boundaryLoops.length,
    outerBoundaryLoopCount: boundaryLoops.filter((loop) => loop.kind === 'outer').length,
    holeBoundaryLoopCount: boundaryLoops.filter((loop) => loop.kind === 'hole').length,
    boundaryLoopsMm,
    boundaryLoops,
    outwardNormalMm,
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
