import type {
  CadFaceSelectionContext,
  CadFaceSelectionHit,
  CadSelectedEdgeTarget,
  CadSelectionVector,
  CadSurfaceUv,
  CadSurfaceUvBounds
} from './cadFaceSelection';

export interface CadSurfaceHitRequest {
  selectionRevision: string;
  partId: string;
  stableFaceId: string;
  triangleIndex: number;
  pointMm: CadSelectionVector;
  meshNormal: CadSelectionVector;
}

export interface CadSurfaceHitResult {
  status: 'ok';
  selectionRevision: string;
  partId: string;
  stableFaceId: string;
  triangleIndex: number;
  geometryType: string;
  projectedPointMm: CadSelectionVector;
  pointDistanceMm: number;
  maximumPointDistanceMm: number;
  surfaceUv: CadSurfaceUv;
  uvBounds: CadSurfaceUvBounds;
  outwardNormal: CadSelectionVector;
  surfaceTangentU: CadSelectionVector;
  normalDot: number;
  trimmedFaceState: 'inside' | 'on-boundary';
  units: 'mm';
  kernel: string;
  limitations: string[];
}

function finiteVector(value: CadSelectionVector) {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteUv(value: CadSurfaceUv) {
  return Number.isFinite(value.u) && Number.isFinite(value.v);
}

function finiteUvBounds(value: CadSurfaceUvBounds) {
  return [value.uMin, value.uMax, value.vMin, value.vMax].every(Number.isFinite)
    && value.uMin <= value.uMax
    && value.vMin <= value.vMax;
}

/** 从当前点击选择创建只读 OpenCascade 曲面命中请求。 */
function requestFromHit(selection: CadFaceSelectionContext, hit: CadFaceSelectionHit): CadSurfaceHitRequest {
  return {
    selectionRevision: selection.revision,
    partId: hit.partId,
    stableFaceId: hit.stableId,
    triangleIndex: hit.triangleIndex,
    pointMm: hit.meshPointMm,
    meshNormal: hit.meshNormal
  };
}

export function buildCadSurfaceHitRequest(selection: CadFaceSelectionContext): CadSurfaceHitRequest {
  const hit = selection.hit;
  if (!hit || !['click', 'edge'].includes(selection.selectionMode)) {
    throw new Error('当前选择没有可解析的 CAD 点击位置');
  }
  return requestFromHit(selection, hit);
}

/** 为手工边链中的一条独立目标创建精确命中请求。 */
export function buildCadSurfaceHitRequestForEdgeTarget(
  selection: CadFaceSelectionContext,
  target: CadSelectedEdgeTarget
): CadSurfaceHitRequest {
  if (selection.selectionMode !== 'edge-chain') {
    throw new Error('当前选择不是手工多选边链');
  }
  return requestFromHit(selection, target.hit);
}

function resolvedHit(hit: CadFaceSelectionHit, result: CadSurfaceHitResult) {
  if (hit.partId !== result.partId || hit.stableId !== result.stableFaceId
    || hit.triangleIndex !== result.triangleIndex) {
    throw new Error('OpenCascade 曲面命中结果与当前选择不一致，已忽略过期结果');
  }
  if (!finiteVector(result.projectedPointMm) || !finiteVector(result.outwardNormal)
    || !finiteVector(result.surfaceTangentU)
    || !finiteUv(result.surfaceUv) || !finiteUvBounds(result.uvBounds)
    || !Number.isFinite(result.pointDistanceMm)
    || !Number.isFinite(result.maximumPointDistanceMm)
    || !Number.isFinite(result.normalDot)
    || result.pointDistanceMm < 0
    || result.maximumPointDistanceMm < result.pointDistanceMm
    || result.normalDot < 0.5) {
    throw new Error('OpenCascade 曲面命中结果包含无效数值，未更新精确选择');
  }
  return {
    ...hit,
    pointMm: result.projectedPointMm,
    normal: result.outwardNormal,
    surfaceUv: result.surfaceUv,
    uvBounds: result.uvBounds,
    surfaceTangentU: result.surfaceTangentU,
    precision: 'opencascade' as const,
    resolutionStatus: 'resolved' as const,
    pointDistanceMm: result.pointDistanceMm,
    normalDot: result.normalDot,
    resolutionError: null
  };
}

/** 仅把完全绑定当前 revision、零件、稳定面和三角索引的精确结果应用到选择。 */
export function applyCadSurfaceHitResult(
  selection: CadFaceSelectionContext,
  result: CadSurfaceHitResult
): CadFaceSelectionContext {
  const hit = selection.hit;
  const face = selection.faces[0];
  if (!hit || selection.revision !== result.selectionRevision
    || hit.partId !== result.partId
    || hit.stableId !== result.stableFaceId
    || hit.triangleIndex !== result.triangleIndex) {
    throw new Error('OpenCascade 曲面命中结果与当前选择不一致，已忽略过期结果');
  }
  if (face && (face.partId !== result.partId || face.stableId !== result.stableFaceId)) {
    throw new Error('OpenCascade 曲面命中结果与稳定面描述不一致');
  }
  if (face && face.geometryType !== result.geometryType) {
    throw new Error('OpenCascade 曲面命中结果与稳定面几何类型不一致');
  }
  return { ...selection, hit: resolvedHit(hit, result) };
}

/** 把精确结果应用到手工边链中的指定目标，不依赖选择对象引用保持不变。 */
export function applyCadSurfaceHitResultToEdgeTarget(
  selection: CadFaceSelectionContext,
  target: CadSelectedEdgeTarget,
  result: CadSurfaceHitResult
): CadFaceSelectionContext {
  if (selection.selectionMode !== 'edge-chain' || selection.revision !== result.selectionRevision) {
    throw new Error('OpenCascade 手工边链命中结果与当前选择修订不一致');
  }
  if (target.face.geometryType !== result.geometryType) {
    throw new Error('OpenCascade 手工边链命中结果与稳定面几何类型不一致');
  }
  const key = `${target.face.stableId}::${target.edge.stableEdgeId}`;
  const edgeSelections = selection.edgeSelections?.map((candidate) =>
    `${candidate.face.stableId}::${candidate.edge.stableEdgeId}` === key
      ? { ...candidate, hit: resolvedHit(candidate.hit, result) }
      : candidate
  ) ?? [];
  if (!edgeSelections.some((candidate) => `${candidate.face.stableId}::${candidate.edge.stableEdgeId}` === key)) {
    throw new Error('目标边已从手工边链中移除，已忽略过期解析结果');
  }
  const first = edgeSelections[0];
  return {
    ...selection,
    faces: Array.from(new Map(edgeSelections.map((candidate) => [candidate.face.stableId, candidate.face])).values()),
    edgeSelections,
    edge: first?.edge ?? null,
    hit: first?.hit ?? null
  };
}

/** 保留原始选择网格命中，但明确标记其不能作为精确建模依据。 */
export function failCadSurfaceHitSelection(
  selection: CadFaceSelectionContext,
  message: string
): CadFaceSelectionContext {
  if (!selection.hit) return selection;
  return {
    ...selection,
    hit: {
      ...selection.hit,
      pointMm: selection.hit.meshPointMm,
      normal: selection.hit.meshNormal,
      surfaceUv: null,
      uvBounds: null,
      surfaceTangentU: null,
      precision: 'mesh',
      resolutionStatus: 'failed',
      pointDistanceMm: null,
      normalDot: null,
      resolutionError: message
    }
  };
}


/** 只把手工边链中的指定目标标记为解析失败。 */
export function failCadSurfaceHitEdgeTarget(
  selection: CadFaceSelectionContext,
  target: CadSelectedEdgeTarget,
  message: string
): CadFaceSelectionContext {
  const key = `${target.face.stableId}::${target.edge.stableEdgeId}`;
  const edgeSelections = selection.edgeSelections?.map((candidate) => {
    if (`${candidate.face.stableId}::${candidate.edge.stableEdgeId}` !== key) return candidate;
    return {
      ...candidate,
      hit: {
        ...candidate.hit,
        pointMm: candidate.hit.meshPointMm,
        normal: candidate.hit.meshNormal,
        surfaceUv: null,
        uvBounds: null,
        surfaceTangentU: null,
        precision: 'mesh' as const,
        resolutionStatus: 'failed' as const,
        pointDistanceMm: null,
        normalDot: null,
        resolutionError: message
      }
    };
  }) ?? [];
  const first = edgeSelections[0];
  return { ...selection, edgeSelections, edge: first?.edge ?? null, hit: first?.hit ?? null };
}
