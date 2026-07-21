import type { CadFaceMatchingSummary, CadGenerationResult } from './cad';
import type { CadFaceSelectionContext } from './cadFaceSelection';
import { parseLocalStlEditCommand } from './localStlEdit';

export type LocalCadFeatureOperation =
  | 'add-cylinder'
  | 'cut-cylinder'
  | 'add-rectangle'
  | 'cut-rectangle'
  | 'cut-slot'
  | 'offset-face-outward'
  | 'offset-face-inward'
  | 'fillet-edge'
  | 'chamfer-edge';

export interface CodexLocalCadFeaturePlan {
  operation: LocalCadFeatureOperation;
  partId: string;
  stableFaceId: string;
  stableEdgeId?: string | null;
  radiusMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  lengthMm?: number | null;
  depthMm: number;
  rotationDeg?: number;
  reason: string;
}

export interface LocalCadFeatureRequest {
  sourceKind: 'cad-part';
  selectionRevision: string;
  partId: string;
  stableFaceId: string;
  stableEdgeId: string | null;
  operation: LocalCadFeatureOperation;
  center: { xMm: number; yMm: number; zMm: number };
  hitNormal: { x: number; y: number; z: number };
  surfaceGeometryType: string;
  surfaceUv: { u: number; v: number };
  radiusMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  lengthMm: number | null;
  depthMm: number;
  rotationDeg: number;
  summary: string;
  command: string;
}

export type LocalCadFeaturePreviewStatus = 'ready' | 'executing' | 'blocked' | 'failed';

/** 曲面受限局部特征的客户端预览；只绑定当前 CAD 修订、零件和稳定面。 */
export interface LocalCadFeaturePreview {
  request: LocalCadFeatureRequest;
  kind: 'additive' | 'subtractive';
  status: LocalCadFeaturePreviewStatus;
  errorMessage: string | null;
}

export interface LocalCadFeatureResult {
  status: 'ok';
  revision: string;
  operation: LocalCadFeatureOperation;
  command: string;
  partId: string;
  stableFaceId: string;
  stableEdgeId?: string | null;
  stableFaceStatus: 'inherited' | 'disappeared';
  stableEdgeStatus?: 'inherited' | 'disappeared' | null;
  outputs: string[];
  units: 'mm';
  kernel: string;
  validation: {
    valid: boolean;
    watertight: boolean;
    solidCount: number;
    pointDistanceMm: number;
    normalDot: number;
    volumeBeforeMm3: number;
    volumeAfterMm3: number;
    volumeDeltaMm3: number;
    boundsMm: { x: number; y: number; z: number };
    surfaceGeometryType?: string;
    surfaceUv?: { u: number; v: number };
    maximumAbsCurvaturePerMm?: number | null;
    minimumCurvatureRadiusMm?: number | null;
    curvatureRatio?: number | null;
    localWallThicknessMm?: number | null;
    remainingWallMm?: number | null;
    throughCut?: boolean;
    interferenceCheckPassed?: boolean | null;
    selfIntersectionDetected?: boolean | null;
    adjacentFaceInterferenceDetected?: boolean | null;
    interferingFaceCount?: number;
    interferingStableFaceIds?: string[];
    minimumInterferenceDistanceMm?: number | null;
    contactFaceCount?: number;
    contactSampleCount?: number;
  };
  faceMatching: CadFaceMatchingSummary;
  updatedCadResult: CadGenerationResult;
  limitations: string[];
}

/** 第一版为非平面上的圆形凸台、圆孔和切平面槽孔创建确定性三维预览。 */
export function createLocalCadFeaturePreview(
  request: LocalCadFeatureRequest
): LocalCadFeaturePreview | null {
  const circular = request.operation === 'add-cylinder' || request.operation === 'cut-cylinder';
  const slot = request.operation === 'cut-slot';
  if (
    request.surfaceGeometryType === 'PLANE'
    || (!circular && !slot)
    || (circular && request.radiusMm === null)
    || (slot && (request.widthMm === null || request.lengthMm === null))
  ) return null;
  return {
    request,
    kind: request.operation === 'add-cylinder' ? 'additive' : 'subtractive',
    status: 'ready',
    errorMessage: null
  };
}

export function describeLocalCadFeaturePreview(preview: LocalCadFeaturePreview) {
  const request = preview.request;
  if (request.operation === 'cut-slot') {
    return `曲面槽孔预览：宽 ${request.widthMm!.toFixed(2)} 毫米、长 ${request.lengthMm!.toFixed(2)} 毫米、深 ${request.depthMm.toFixed(2)} 毫米，旋转 ${request.rotationDeg.toFixed(2)} 度；沿真实内法线显示。`;
  }
  const diameterMm = request.radiusMm === null ? 0 : request.radiusMm * 2;
  if (preview.kind === 'additive') {
    return `曲面圆形凸台预览：直径 ${diameterMm.toFixed(2)} 毫米，高 ${request.depthMm.toFixed(2)} 毫米；沿真实外法线显示。`;
  }
  return `曲面圆孔预览：直径 ${diameterMm.toFixed(2)} 毫米，深 ${request.depthMm.toFixed(2)} 毫米；沿真实内法线显示。`;
}

const SURFACE_GEOMETRY_LABELS: Record<string, string> = {
  PLANE: '平面',
  CYLINDER: '圆柱面',
  CONE: '圆锥面',
  SPHERE: '球面',
  TORUS: '圆环面',
  BEZIER: '贝塞尔曲面',
  BSPLINE: 'B 样条曲面',
  REVOLUTION: '旋转曲面',
  EXTRUSION: '拉伸曲面',
  OTHER: '其他曲面'
};

const EDGE_GEOMETRY_LABELS: Record<string, string> = {
  LINE: '直线边',
  CIRCLE: '圆弧边',
  ELLIPSE: '椭圆边',
  HYPERBOLA: '双曲线边',
  PARABOLA: '抛物线边',
  BEZIER: '贝塞尔曲线边',
  BSPLINE: 'B 样条曲线边',
  OFFSET: '偏移曲线边',
  OTHER: '其他曲线边'
};

/** 把 OpenCascade 曲面类型转换成界面可读的中文名称。 */
export function describeCadSurfaceGeometryType(geometryType: string) {
  return SURFACE_GEOMETRY_LABELS[geometryType] ?? '未知曲面';
}

/** 把 OpenCascade 边类型转换成界面可读的中文名称。 */
export function describeCadEdgeGeometryType(geometryType: string) {
  return EDGE_GEOMETRY_LABELS[geometryType] ?? '未知曲线边';
}

function finiteVector(vector: { x: number; y: number; z: number }) {
  return [vector.x, vector.y, vector.z].every(Number.isFinite);
}

function validatedSelection(selection: CadFaceSelectionContext) {
  if (!['click', 'edge'].includes(selection.selectionMode) || selection.faces.length !== 1 || !selection.hit) {
    throw new Error('稳定 CAD 局部特征只支持点击选择单个稳定面或单条边，不支持框选多面');
  }
  const face = selection.faces[0];
  const hit = selection.hit;
  if (selection.selectionMode === 'edge' && face.geometryType !== 'PLANE') {
    throw new Error(`当前边所属面是${describeCadSurfaceGeometryType(face.geometryType)}；第一版圆角和倒角只支持平面所属边`);
  }
  if (face.partId !== hit.partId || face.stableId !== hit.stableId) {
    throw new Error('稳定面描述与点击命中不一致，请重新点击目标平面');
  }
  if (!selection.revision.trim()) {
    throw new Error('当前稳定 CAD 局部选择缺少 CAD 修订号，请重新生成并选择目标');
  }
  if (!finiteVector(hit.pointMm) || !finiteVector(hit.normal)) {
    throw new Error('点击坐标或法线无效，请重新点击目标平面');
  }
  if (hit.resolutionStatus !== 'resolved' || hit.precision !== 'opencascade' || !hit.surfaceUv
    || !Number.isFinite(hit.surfaceUv.u) || !Number.isFinite(hit.surfaceUv.v)) {
    throw new Error('当前点击位置尚未完成 OpenCascade 精确解析，请等待解析完成或重新点击目标面');
  }
  if (selection.selectionMode === 'edge') {
    if (!selection.edge || selection.edge.partId !== face.partId || selection.edge.stableFaceId !== face.stableId) {
      throw new Error('稳定边描述与命中面不一致，请重新点击目标边');
    }
    if (selection.edge.stableEdgeId !== hit.stableEdgeId) {
      throw new Error('稳定边描述与点击命中 ID 不一致，请重新点击目标边');
    }
  }
  return { face, hit, edge: selection.edge ?? null };
}

function dimension(value: number | null | undefined) {
  return value ?? null;
}

function validatePlanDimensions(plan: CodexLocalCadFeaturePlan) {
  const supported: LocalCadFeatureOperation[] = [
    'add-cylinder', 'cut-cylinder', 'add-rectangle', 'cut-rectangle', 'cut-slot',
    'offset-face-outward', 'offset-face-inward', 'fillet-edge', 'chamfer-edge'
  ];
  if (!supported.includes(plan.operation)) throw new Error('Codex 返回了未知的稳定 CAD 局部特征操作');
  const edgeOperation = plan.operation === 'fillet-edge' || plan.operation === 'chamfer-edge';
  const maximumDepth = edgeOperation ? 50 : 200;
  if (!Number.isFinite(plan.depthMm) || plan.depthMm < 0.2 || plan.depthMm > maximumDepth) {
    throw new Error(`Codex 返回的${edgeOperation ? '圆角半径或倒角距离' : '局部修改深度'}必须在 0.20 至 ${maximumDepth.toFixed(2)} 毫米之间`);
  }
  const rotationDeg = plan.rotationDeg ?? 0;
  if (!Number.isFinite(rotationDeg) || rotationDeg < -180 || rotationDeg > 180) {
    throw new Error('Codex 返回的局部轮廓旋转角必须在 -180.00 至 180.00 度之间');
  }
  const radius = dimension(plan.radiusMm);
  const width = dimension(plan.widthMm);
  const height = dimension(plan.heightMm);
  const length = dimension(plan.lengthMm);
  if (edgeOperation) {
    if (radius !== null || width !== null || height !== null || length !== null || Math.abs(rotationDeg) > 1e-9) {
      throw new Error('Codex 圆角或倒角计划不能携带平面轮廓尺寸或旋转角');
    }
  } else if (plan.operation === 'offset-face-outward' || plan.operation === 'offset-face-inward') {
    if (radius !== null || width !== null || height !== null || length !== null || Math.abs(rotationDeg) > 1e-9) {
      throw new Error('Codex 整面拉伸或偏移计划不能携带局部轮廓尺寸或旋转角');
    }
  } else if (plan.operation === 'add-cylinder' || plan.operation === 'cut-cylinder') {
    if (radius === null || !Number.isFinite(radius) || radius < 0.5 || radius > 100) {
      throw new Error('Codex 返回的局部圆形区域半径必须在 0.50 至 100.00 毫米之间');
    }
    if (width !== null || height !== null || length !== null || Math.abs(rotationDeg) > 1e-9) {
      throw new Error('Codex 圆柱计划携带了不允许的矩形、槽孔尺寸或旋转角');
    }
  } else {
    if (radius !== null || width === null || !Number.isFinite(width) || width < 0.5 || width > 200) {
      throw new Error('Codex 返回的矩形或槽孔宽度必须在 0.50 至 200.00 毫米之间，且不能携带圆形半径');
    }
    if (plan.operation === 'cut-slot') {
      if (height !== null || length === null || !Number.isFinite(length) || length < Math.max(1, width) || length > 200) {
        throw new Error('Codex 返回的槽孔长度必须在 1.00 至 200.00 毫米之间，且不能小于槽孔宽度');
      }
    } else if (height === null || !Number.isFinite(height) || height < 0.5 || height > 200 || length !== null) {
      throw new Error('Codex 返回的矩形高度必须在 0.50 至 200.00 毫米之间，且不能携带槽孔长度');
    }
  }
}

function requestFromPlan(selection: CadFaceSelectionContext, command: string, plan: CodexLocalCadFeaturePlan, summary: string): LocalCadFeatureRequest {
  const { face, hit, edge } = validatedSelection(selection);
  validatePlanDimensions(plan);
  if (plan.partId !== face.partId || plan.stableFaceId !== face.stableId) {
    throw new Error('Codex 计划试图修改当前选择之外的零件或稳定面，已拒绝执行');
  }
  const edgeOperation = plan.operation === 'fillet-edge' || plan.operation === 'chamfer-edge';
  if (edgeOperation && (!edge || plan.stableEdgeId !== edge.stableEdgeId)) {
    throw new Error('Codex 计划试图修改当前选择之外的稳定边，已拒绝执行');
  }
  if (!edgeOperation && selection.selectionMode === 'edge') {
    throw new Error('当前选择的是稳定边，只允许执行圆角或倒角');
  }
  if (edgeOperation && selection.selectionMode !== 'edge') {
    throw new Error('圆角或倒角必须先使用“点击选边”选择一条稳定 CAD 边');
  }
  const curvedFace = face.geometryType !== 'PLANE';
  if (curvedFace && !['add-cylinder', 'cut-cylinder', 'cut-slot'].includes(plan.operation)) {
    throw new Error(`当前选中的是${describeCadSurfaceGeometryType(face.geometryType)}；第一版曲面局部特征只支持圆形凸台、圆孔或受限槽孔`);
  }
  return {
    sourceKind: 'cad-part', selectionRevision: selection.revision, partId: face.partId,
    stableFaceId: face.stableId, stableEdgeId: edgeOperation ? edge!.stableEdgeId : null, operation: plan.operation,
    center: { xMm: hit.pointMm.x, yMm: hit.pointMm.y, zMm: hit.pointMm.z },
    hitNormal: { ...hit.normal }, surfaceGeometryType: face.geometryType, surfaceUv: { u: hit.surfaceUv!.u, v: hit.surfaceUv!.v }, radiusMm: dimension(plan.radiusMm), widthMm: dimension(plan.widthMm),
    heightMm: dimension(plan.heightMm), lengthMm: dimension(plan.lengthMm), depthMm: plan.depthMm,
    rotationDeg: plan.rotationDeg ?? 0,
    summary: summary.trim() || plan.reason.trim() || '稳定 CAD 局部特征', command: command.trim()
  };
}

export function buildLocalCadFeatureRequestFromPlan(selection: CadFaceSelectionContext, command: string, plan: CodexLocalCadFeaturePlan, summary: string) {
  return requestFromPlan(selection, command, plan, summary);
}

const NUMBER = '(\\d+(?:\\.\\d+)?)';
function numberFor(command: string, labels: string[]) {
  for (const label of labels) {
    const before = command.match(new RegExp(`(?:${label})\\s*${NUMBER}\\s*(?:毫米|mm)?`, 'i'));
    if (before) return Number(before[1]);
    const after = command.match(new RegExp(`${NUMBER}\\s*(?:毫米|mm)?\\s*(?:${label})`, 'i'));
    if (after) return Number(after[1]);
  }
  return null;
}

function parsePlanarCommand(command: string, partId: string, stableFaceId: string): CodexLocalCadFeaturePlan {
  const trimmed = command.trim();
  const isWholeFace = /整面|整个面|这个面|所选面|当前面/.test(trimmed)
    && /拉伸|偏移|外移|内移|抬高|压低|下沉/.test(trimmed);
  if (isWholeFace) {
    const outward = /向外|外移|抬高|拉高|凸出/.test(trimmed);
    const inward = /向内|内移|压低|下沉|降低/.test(trimmed);
    if (outward === inward) throw new Error('请明确说明要将整个面向外拉伸，还是向内偏移');
    const depthMm = numberFor(trimmed, [
      '向外(?:拉伸|偏移|移动)', '向内(?:拉伸|偏移|移动)', '拉伸(?:距离)?',
      '偏移(?:距离)?', '外移', '内移', '抬高', '压低', '下沉'
    ]);
    if (depthMm === null) throw new Error('请提供整面拉伸或偏移距离，例如“整面向外拉伸 2 毫米”');
    return {
      operation: outward ? 'offset-face-outward' : 'offset-face-inward',
      partId, stableFaceId, radiusMm: null, widthMm: null, heightMm: null, lengthMm: null,
      depthMm, rotationDeg: 0, reason: `${outward ? '整面向外拉伸' : '整面向内偏移'} ${depthMm} 毫米`
    };
  }
  const isSlot = /槽孔|长圆孔|腰形孔/.test(trimmed);
  const isRectangle = /矩形|方形|长方形/.test(trimmed);
  if (!isSlot && !isRectangle) {
    const plan = parseLocalStlEditCommand(trimmed);
    return { ...plan, partId, stableFaceId, widthMm: null, heightMm: null, lengthMm: null, rotationDeg: 0, reason: plan.summary };
  }
  const isCut = /开|打|挖|切除|孔/.test(trimmed);
  const isAdd = /凸台|凸起|增加材料|加厚/.test(trimmed) && !isSlot;
  if (isCut === isAdd) throw new Error('请明确说明要增加矩形凸台，还是切除矩形孔或槽孔');
  const widthMm = numberFor(trimmed, ['宽(?:度)?', '槽宽']);
  const rotationDeg = numberFor(trimmed, ['旋转(?:角)?', '角度']) ?? 0;
  const depthMm = numberFor(trimmed, isCut ? ['深(?:度)?', '切入', '切除'] : ['凸出', '加厚', '厚(?:度)?']);
  if (widthMm === null) throw new Error('请提供局部轮廓宽度，例如“宽 8 毫米”');
  if (depthMm === null) throw new Error(isCut ? '请提供切入深度，例如“深 4 毫米”' : '请提供凸台高度，例如“凸出 2 毫米”');
  if (isSlot) {
    const lengthMm = numberFor(trimmed, ['长(?:度)?', '槽长']);
    if (lengthMm === null) throw new Error('请提供槽孔总长度，例如“长 14 毫米”');
    return { operation: 'cut-slot', partId, stableFaceId, radiusMm: null, widthMm, heightMm: null, lengthMm, depthMm, rotationDeg, reason: `切除 ${lengthMm}×${widthMm} 毫米槽孔` };
  }
  const heightMm = numberFor(trimmed, ['高(?:度)?', '长(?:度)?']);
  if (heightMm === null) throw new Error('请提供矩形轮廓高度，例如“高 6 毫米”');
  return { operation: isCut ? 'cut-rectangle' : 'add-rectangle', partId, stableFaceId, radiusMm: null, widthMm, heightMm, lengthMm: null, depthMm, rotationDeg, reason: `${isCut ? '切除矩形孔' : '增加矩形凸台'} ${widthMm}×${heightMm} 毫米` };
}

function parseEdgeCommand(command: string, partId: string, stableFaceId: string, stableEdgeId: string): CodexLocalCadFeaturePlan {
  const trimmed = command.trim();
  const fillet = /圆角|圆滑|倒圆/.test(trimmed);
  const chamfer = /倒角|切角|斜角/.test(trimmed);
  if (fillet === chamfer) throw new Error('请明确说明要对所选边执行圆角还是倒角');
  const depthMm = numberFor(trimmed, fillet ? ['圆角(?:半径)?', '半径', 'R'] : ['倒角(?:距离)?', '距离', '边长']);
  if (depthMm === null) throw new Error(fillet ? '请提供圆角半径，例如“将这条边做 2 毫米圆角”' : '请提供倒角距离，例如“将这条边做 1 毫米倒角”');
  return {
    operation: fillet ? 'fillet-edge' : 'chamfer-edge', partId, stableFaceId, stableEdgeId,
    radiusMm: null, widthMm: null, heightMm: null, lengthMm: null, depthMm, rotationDeg: 0,
    reason: `${fillet ? '圆角' : '倒角'} ${depthMm} 毫米`
  };
}

/** Codex 不可用时使用的确定性中文解析入口。 */
export function buildLocalCadFeatureRequest(selection: CadFaceSelectionContext, command: string): LocalCadFeatureRequest {
  const { face, edge } = validatedSelection(selection);
  const plan = selection.selectionMode === 'edge'
    ? parseEdgeCommand(command, face.partId, face.stableId, edge!.stableEdgeId)
    : parsePlanarCommand(command, face.partId, face.stableId);
  return requestFromPlan(selection, command, plan, plan.reason);
}
