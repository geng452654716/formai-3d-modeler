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
  | 'chamfer-edge'
  | 'fillet-edge-loop'
  | 'chamfer-edge-loop'
  | 'fillet-edge-chain'
  | 'chamfer-edge-chain'
  | 'fillet-edge-manual-chain'
  | 'chamfer-edge-manual-chain';

export interface CodexLocalCadFeaturePlan {
  operation: LocalCadFeatureOperation;
  partId: string;
  stableFaceId: string;
  stableEdgeId?: string | null;
  selectedEdges?: Array<{ stableFaceId: string; stableEdgeId: string }>;
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
  /** 手工边链执行与安全重放使用的逐边精确目标。 */
  edgeTargets: Array<{
    stableFaceId: string;
    stableEdgeId: string;
    center: { xMm: number; yMm: number; zMm: number };
    hitNormal: { x: number; y: number; z: number };
    surfaceGeometryType: string;
    surfaceUv: { u: number; v: number };
  }>;
  operation: LocalCadFeatureOperation;
  center: { xMm: number; yMm: number; zMm: number };
  hitNormal: { x: number; y: number; z: number };
  surfaceTangentU: { x: number; y: number; z: number } | null;
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

export type LocalCadFeaturePreviewStatus = 'checking' | 'ready' | 'executing' | 'blocked' | 'failed';

export interface LocalCadFeaturePreflightResult {
  status: 'ok' | 'blocked';
  revision: string;
  operation: LocalCadFeatureOperation;
  partId: string;
  stableFaceId: string;
  previewFile: string;
  outputs: string[];
  units: 'mm';
  kernel: string;
  message: string;
  validation: {
    pointDistanceMm?: number;
    normalDot?: number;
    surfaceGeometryType?: string;
    surfaceUv?: { u: number; v: number };
    surfaceTangentU?: { x: number; y: number; z: number } | null;
    maximumAbsCurvaturePerMm?: number | null;
    minimumCurvatureRadiusMm?: number | null;
    curvatureRatio?: number | null;
    localWallThicknessMm?: number | null;
    remainingWallMm?: number | null;
    throughCut?: boolean;
    interferenceCheckPassed: boolean;
    selfIntersectionDetected: boolean;
    adjacentFaceInterferenceDetected: boolean;
    interferingFaceCount: number;
    interferingStableFaceIds: string[];
    minimumInterferenceDistanceMm: number | null;
    contactFaceCount: number;
    contactSampleCount: number;
    toolValid: boolean;
    toolWatertight: boolean;
    toolSolidCount: number;
    toolVolumeMm3: number;
    toolBoundsMm: { x: number; y: number; z: number };
  };
  limitations: string[];
}

/** 曲面受限局部特征的客户端预览；只绑定当前 CAD 修订、零件和稳定面。 */
export interface LocalCadFeaturePreview {
  request: LocalCadFeatureRequest;
  kind: 'additive' | 'subtractive';
  status: LocalCadFeaturePreviewStatus;
  errorMessage: string | null;
  /** OpenCascade 在写入模型前导出的真实布尔工具体和结构化安全诊断。 */
  preflight: LocalCadFeaturePreflightResult | null;
  /** 风险面定位只影响视口高亮，不改变原始目标面、曲面 UV 或当前修订。 */
  focusedInterferenceFaceId: string | null;
}

/** 曲面风险参数编辑使用的毫米制数据；不包含零件、面 ID 或执行权限。 */
export interface LocalCadFeatureAdjustment {
  diameterMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  lengthMm: number | null;
  depthMm: number;
  rotationDeg: number;
}

export interface LocalCadFeatureResult {
  status: 'ok';
  revision: string;
  operation: LocalCadFeatureOperation;
  command: string;
  partId: string;
  stableFaceId: string;
  stableEdgeId?: string | null;
  selectedEdges?: Array<{ stableFaceId: string; stableEdgeId: string }>;
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
    /** 点击点到 OpenCascade 按当前修订真实 UV 重新求得曲面点的距离。 */
    surfacePointDistanceMm?: number | null;
    maximumSurfacePointDistanceMm?: number | null;
    /** OpenCascade 实际参与圆角或倒角的边数量。 */
    affectedEdgeCount?: number | null;
    edgeScope?: 'single' | 'loop' | 'tangent-chain' | 'manual-chain' | null;
    /** OpenCascade 在当前曲面 UV 点击位置计算的单位 U 切向。 */
    surfaceTangentU?: { x: number; y: number; z: number } | null;
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

/** 为非平面上的受限圆形、矩形和槽孔切平面特征创建确定性三维预览。 */
export function createLocalCadFeaturePreview(
  request: LocalCadFeatureRequest
): LocalCadFeaturePreview | null {
  const circular = request.operation === 'add-cylinder' || request.operation === 'cut-cylinder';
  const rectangular = request.operation === 'add-rectangle' || request.operation === 'cut-rectangle';
  const slot = request.operation === 'cut-slot';
  if (
    request.surfaceGeometryType === 'PLANE'
    || (!circular && !rectangular && !slot)
    || (circular && request.radiusMm === null)
    || (rectangular && (request.widthMm === null || request.heightMm === null))
    || (slot && (request.widthMm === null || request.lengthMm === null))
  ) return null;
  return {
    request,
    kind: request.operation === 'add-cylinder' || request.operation === 'add-rectangle'
      ? 'additive' : 'subtractive',
    status: 'checking',
    errorMessage: null,
    preflight: null,
    focusedInterferenceFaceId: null
  };
}

/** 从受限曲面请求生成可编辑参数，供风险面板恢复原值。 */
export function createLocalCadFeatureAdjustment(request: LocalCadFeatureRequest): LocalCadFeatureAdjustment {
  return {
    diameterMm: request.radiusMm === null ? null : request.radiusMm * 2,
    widthMm: request.widthMm,
    heightMm: request.heightMm,
    lengthMm: request.lengthMm,
    depthMm: request.depthMm,
    rotationDeg: request.rotationDeg
  };
}

/** 校验用户调整后的风险参数，仍使用与受限 JSON 计划一致的安全范围。 */
export function validateLocalCadFeatureAdjustment(
  request: LocalCadFeatureRequest,
  adjustment: LocalCadFeatureAdjustment
) {
  const circular = request.operation === 'add-cylinder' || request.operation === 'cut-cylinder';
  const rectangular = request.operation === 'add-rectangle' || request.operation === 'cut-rectangle';
  const slot = request.operation === 'cut-slot';
  if (!circular && !rectangular && !slot) throw new Error('当前局部特征不支持风险参数调整');
  const values = [adjustment.depthMm, adjustment.rotationDeg];
  if (circular) values.push(adjustment.diameterMm ?? Number.NaN);
  if (rectangular) values.push(adjustment.widthMm ?? Number.NaN, adjustment.heightMm ?? Number.NaN);
  if (slot) values.push(adjustment.widthMm ?? Number.NaN, adjustment.lengthMm ?? Number.NaN);
  if (!values.every(Number.isFinite)) throw new Error('参数必须是有效数字，不能留空');
  const plan: CodexLocalCadFeaturePlan = {
    operation: request.operation,
    partId: request.partId,
    stableFaceId: request.stableFaceId,
    stableEdgeId: request.stableEdgeId,
    radiusMm: circular ? adjustment.diameterMm! / 2 : null,
    widthMm: rectangular || slot ? adjustment.widthMm : null,
    heightMm: rectangular ? adjustment.heightMm : null,
    lengthMm: slot ? adjustment.lengthMm : null,
    depthMm: adjustment.depthMm,
    rotationDeg: circular ? 0 : adjustment.rotationDeg,
    reason: '用户调整曲面风险参数'
  };
  try {
    validatePlanDimensions(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : '调整后的参数不符合安全范围';
    throw new Error(message.replace(/^Codex 返回的/, '调整后的').replace(/^Codex /, '调整后的'));
  }
}

function formatAdjustmentNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

/** 生成可被现有中文解析器重新验证的指令，复用完整精确预检和自动执行安全门。 */
export function buildAdjustedLocalCadFeatureCommand(
  request: LocalCadFeatureRequest,
  adjustment: LocalCadFeatureAdjustment
) {
  validateLocalCadFeatureAdjustment(request, adjustment);
  const depth = formatAdjustmentNumber(adjustment.depthMm);
  const rotation = formatAdjustmentNumber(adjustment.rotationDeg);
  if (request.operation === 'add-cylinder') {
    return `在这里增加直径 ${formatAdjustmentNumber(adjustment.diameterMm!)} 毫米、高 ${depth} 毫米的圆形凸台`;
  }
  if (request.operation === 'cut-cylinder') {
    return `在这里开一个直径 ${formatAdjustmentNumber(adjustment.diameterMm!)} 毫米、深 ${depth} 毫米的圆孔`;
  }
  if (request.operation === 'add-rectangle') {
    return `在这里增加宽 ${formatAdjustmentNumber(adjustment.widthMm!)} 毫米、高 ${formatAdjustmentNumber(adjustment.heightMm!)} 毫米、凸出 ${depth} 毫米的矩形凸台，旋转 ${rotation} 度`;
  }
  if (request.operation === 'cut-rectangle') {
    return `在这里开一个宽 ${formatAdjustmentNumber(adjustment.widthMm!)} 毫米、高 ${formatAdjustmentNumber(adjustment.heightMm!)} 毫米、深 ${depth} 毫米的矩形孔，旋转 ${rotation} 度`;
  }
  return `在这里开一个宽 ${formatAdjustmentNumber(adjustment.widthMm!)} 毫米、长 ${formatAdjustmentNumber(adjustment.lengthMm!)} 毫米、深 ${depth} 毫米、旋转 ${rotation} 度的槽孔`;
}

export function describeLocalCadFeaturePreview(preview: LocalCadFeaturePreview) {
  const request = preview.request;
  const preflight = preview.preflight;
  const exactSummary = preflight
    ? ` OpenCascade 精确工具体 ${preflight.validation.toolVolumeMm3.toFixed(2)} 立方毫米，包围盒 ${preflight.validation.toolBoundsMm.x.toFixed(2)} × ${preflight.validation.toolBoundsMm.y.toFixed(2)} × ${preflight.validation.toolBoundsMm.z.toFixed(2)} 毫米；检查 ${preflight.validation.contactFaceCount} 个接触面、${preflight.validation.contactSampleCount} 个接触采样。`
    : '';
  if (request.operation === 'cut-slot') {
    return `曲面槽孔预览：宽 ${request.widthMm!.toFixed(2)} 毫米、长 ${request.lengthMm!.toFixed(2)} 毫米、深 ${request.depthMm.toFixed(2)} 毫米，旋转 ${request.rotationDeg.toFixed(2)} 度；0 度沿真实 U 切向，沿真实内法线显示。${exactSummary}`;
  }
  if (request.operation === 'add-rectangle' || request.operation === 'cut-rectangle') {
    const direction = request.operation === 'add-rectangle' ? '外法线' : '内法线';
    const label = request.operation === 'add-rectangle' ? '矩形凸台' : '矩形孔';
    return `曲面${label}预览：宽 ${request.widthMm!.toFixed(2)} 毫米、高 ${request.heightMm!.toFixed(2)} 毫米、深 ${request.depthMm.toFixed(2)} 毫米，旋转 ${request.rotationDeg.toFixed(2)} 度；0 度沿真实 U 切向，沿真实${direction}显示。${exactSummary}`;
  }
  const diameterMm = request.radiusMm === null ? 0 : request.radiusMm * 2;
  if (preview.kind === 'additive') {
    return `曲面圆形凸台预览：直径 ${diameterMm.toFixed(2)} 毫米，高 ${request.depthMm.toFixed(2)} 毫米；沿真实外法线显示。${exactSummary}`;
  }
  return `曲面圆孔预览：直径 ${diameterMm.toFixed(2)} 毫米，深 ${request.depthMm.toFixed(2)} 毫米；沿真实内法线显示。${exactSummary}`;
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
  if (!['click', 'edge', 'edge-chain'].includes(selection.selectionMode)) {
    throw new Error('稳定 CAD 局部特征只支持点击单面、单边或手工多选边链，不支持框选多面');
  }
  if (!selection.revision.trim()) {
    throw new Error('当前稳定 CAD 局部选择缺少 CAD 修订号，请重新生成并选择目标');
  }
  if (selection.selectionMode === 'edge-chain') {
    const targets = selection.edgeSelections ?? [];
    if (targets.length < 2 || targets.length > 64) {
      throw new Error('手工多选边链必须包含 2 至 64 条稳定边');
    }
    const partIds = new Set(targets.map((target) => target.edge.partId));
    if (partIds.size !== 1) throw new Error('手工多选边链只能选择同一个 CAD 零件中的边');
    const keys = new Set<string>();
    targets.forEach((target) => {
      const { face, edge, hit } = target;
      const key = `${face.stableId}::${edge.stableEdgeId}`;
      if (keys.has(key)) throw new Error('手工多选边链包含重复稳定边，请移除重复目标');
      keys.add(key);
      if (face.partId !== edge.partId || face.partId !== hit.partId
        || face.stableId !== edge.stableFaceId || face.stableId !== hit.stableId
        || edge.stableEdgeId !== hit.stableEdgeId) {
        throw new Error('手工边链中的稳定面、稳定边与点击命中不一致，请重新选择');
      }
      if (!finiteVector(hit.pointMm) || !finiteVector(hit.normal)
        || hit.resolutionStatus !== 'resolved' || hit.precision !== 'opencascade'
        || !hit.surfaceUv || !Number.isFinite(hit.surfaceUv.u) || !Number.isFinite(hit.surfaceUv.v)) {
        throw new Error('手工边链中存在尚未完成 OpenCascade 精确解析的边，请等待解析完成');
      }
    });
    const first = targets[0];
    return { face: first.face, hit: first.hit, edge: first.edge, edgeTargets: targets };
  }
  if (selection.faces.length !== 1 || !selection.hit) {
    throw new Error('稳定 CAD 局部特征只支持点击选择单个稳定面或单条边');
  }
  const face = selection.faces[0];
  const hit = selection.hit;
  if (face.partId !== hit.partId || face.stableId !== hit.stableId) {
    throw new Error('稳定面描述与点击命中不一致，请重新点击目标面或目标边');
  }
  if (!finiteVector(hit.pointMm) || !finiteVector(hit.normal)) {
    throw new Error('点击坐标或法线无效，请重新点击目标面或目标边');
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
  return { face, hit, edge: selection.edge ?? null, edgeTargets: [] };
}

function dimension(value: number | null | undefined) {
  return value ?? null;
}

function validatePlanDimensions(plan: CodexLocalCadFeaturePlan) {
  const supported: LocalCadFeatureOperation[] = [
    'add-cylinder', 'cut-cylinder', 'add-rectangle', 'cut-rectangle', 'cut-slot',
    'offset-face-outward', 'offset-face-inward', 'fillet-edge', 'chamfer-edge',
    'fillet-edge-loop', 'chamfer-edge-loop', 'fillet-edge-chain', 'chamfer-edge-chain',
    'fillet-edge-manual-chain', 'chamfer-edge-manual-chain'
  ];
  if (!supported.includes(plan.operation)) throw new Error('Codex 返回了未知的稳定 CAD 局部特征操作');
  const edgeOperation = ['fillet-edge', 'chamfer-edge', 'fillet-edge-loop', 'chamfer-edge-loop', 'fillet-edge-chain', 'chamfer-edge-chain',
    'fillet-edge-manual-chain', 'chamfer-edge-manual-chain'].includes(plan.operation);
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
  const { face, hit, edge, edgeTargets } = validatedSelection(selection);
  validatePlanDimensions(plan);
  if (plan.partId !== face.partId || plan.stableFaceId !== face.stableId) {
    throw new Error('Codex 计划试图修改当前选择之外的零件或首条稳定面，已拒绝执行');
  }
  const manualOperation = ['fillet-edge-manual-chain', 'chamfer-edge-manual-chain'].includes(plan.operation);
  const edgeOperation = manualOperation || ['fillet-edge', 'chamfer-edge', 'fillet-edge-loop', 'chamfer-edge-loop', 'fillet-edge-chain', 'chamfer-edge-chain'].includes(plan.operation);
  if (manualOperation) {
    if (selection.selectionMode !== 'edge-chain') throw new Error('手工边链圆角或倒角必须先使用“多选边链”工具');
    const expected = edgeTargets.map((target) => ({
      stableFaceId: target.face.stableId,
      stableEdgeId: target.edge.stableEdgeId
    }));
    if (JSON.stringify(plan.selectedEdges ?? []) !== JSON.stringify(expected)) {
      throw new Error('Codex 计划增删、排序或替换了手工选择边列表，已拒绝执行');
    }
    if (plan.stableEdgeId !== null && plan.stableEdgeId !== undefined) {
      throw new Error('手工边链计划不能再携带单一种子稳定边 ID');
    }
  } else if (edgeOperation && (!edge || plan.stableEdgeId !== edge.stableEdgeId)) {
    throw new Error('Codex 计划试图修改当前选择之外的稳定边，已拒绝执行');
  }
  if (!edgeOperation && (selection.selectionMode === 'edge' || selection.selectionMode === 'edge-chain')) {
    throw new Error('当前选择的是稳定边，只允许执行单边、自动边链、整圈或手工边链圆角与倒角');
  }
  if (edgeOperation && !manualOperation && selection.selectionMode !== 'edge') {
    throw new Error('单边、自动切线链或整圈圆角倒角必须先使用“点击选边”选择种子边');
  }
  const curvedFace = face.geometryType !== 'PLANE';
  const edgeLoopOperation = plan.operation === 'fillet-edge-loop' || plan.operation === 'chamfer-edge-loop';
  if (curvedFace && edgeLoopOperation) {
    throw new Error('整圈边圆角或倒角第一版只支持平面边界，请重新选择平面所属边');
  }
  if (curvedFace && !edgeOperation && !['add-cylinder', 'cut-cylinder', 'add-rectangle', 'cut-rectangle', 'cut-slot'].includes(plan.operation)) {
    throw new Error(`当前选中的是${describeCadSurfaceGeometryType(face.geometryType)}；当前曲面局部特征只支持圆形凸台、圆孔、矩形凸台、矩形孔或受限槽孔`);
  }
  const directionalProfile = ['add-rectangle', 'cut-rectangle', 'cut-slot'].includes(plan.operation);
  if (curvedFace && directionalProfile && (!hit.surfaceTangentU || !finiteVector(hit.surfaceTangentU))) {
    throw new Error('曲面方向轮廓缺少 OpenCascade 真实 U 切向，请重新点击目标面');
  }
  return {
    sourceKind: 'cad-part', selectionRevision: selection.revision, partId: face.partId,
    stableFaceId: face.stableId, stableEdgeId: edgeOperation && !manualOperation ? edge!.stableEdgeId : null,
    edgeTargets: manualOperation ? edgeTargets.map((target) => ({
      stableFaceId: target.face.stableId,
      stableEdgeId: target.edge.stableEdgeId,
      center: { xMm: target.hit.pointMm.x, yMm: target.hit.pointMm.y, zMm: target.hit.pointMm.z },
      hitNormal: { ...target.hit.normal },
      surfaceGeometryType: target.face.geometryType,
      surfaceUv: { u: target.hit.surfaceUv!.u, v: target.hit.surfaceUv!.v }
    })) : [],
    operation: plan.operation,
    center: { xMm: hit.pointMm.x, yMm: hit.pointMm.y, zMm: hit.pointMm.z },
    hitNormal: { ...hit.normal }, surfaceTangentU: hit.surfaceTangentU ? { ...hit.surfaceTangentU } : null,
    surfaceGeometryType: face.geometryType, surfaceUv: { u: hit.surfaceUv!.u, v: hit.surfaceUv!.v }, radiusMm: dimension(plan.radiusMm), widthMm: dimension(plan.widthMm),
    heightMm: dimension(plan.heightMm), lengthMm: dimension(plan.lengthMm), depthMm: plan.depthMm,
    rotationDeg: plan.rotationDeg ?? 0,
    summary: summary.trim() || plan.reason.trim() || '稳定 CAD 局部特征', command: command.trim()
  };
}

export function buildLocalCadFeatureRequestFromPlan(selection: CadFaceSelectionContext, command: string, plan: CodexLocalCadFeaturePlan, summary: string) {
  return requestFromPlan(selection, command, plan, summary);
}

// 中文局部编辑指令允许旋转角使用正负号；尺寸若为负数会在统一参数校验中被拒绝。
const NUMBER = '([+-]?\\d+(?:\\.\\d+)?)';
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

function parseEdgeCommand(command: string, partId: string, stableFaceId: string, stableEdgeId: string | null, selectedEdges?: Array<{ stableFaceId: string; stableEdgeId: string }>): CodexLocalCadFeaturePlan {
  const trimmed = command.trim();
  const fillet = /圆角|圆滑|倒圆/.test(trimmed);
  const chamfer = /倒角|切角|斜角/.test(trimmed);
  if (fillet === chamfer) throw new Error('请明确说明要对所选边执行圆角还是倒角');
  const depthMm = numberFor(trimmed, fillet ? ['圆角(?:半径)?', '半径', 'R'] : ['倒角(?:距离)?', '距离', '边长']);
  if (depthMm === null) throw new Error(fillet ? '请提供圆角半径，例如“将这条边做 2 毫米圆角”' : '请提供倒角距离，例如“将这条边做 1 毫米倒角”');
  const manualChain = Boolean(selectedEdges?.length);
  const wholeLoop = /这圈|这一圈|整圈|一圈|整周|周边|轮廓边|边界圈/.test(trimmed);
  const tangentChain = /切线链|相切边|切线连续|连续边链|沿切线|顺着切线/.test(trimmed);
  if (wholeLoop && tangentChain) throw new Error('请明确选择“平面边界整圈”或“切线连续边链”，不能同时要求两种传播范围');
  if (manualChain && (wholeLoop || tangentChain)) throw new Error('已使用“多选边链”工具，请不要再要求自动整圈或切线传播');
  const scope = manualChain ? 'manual' : wholeLoop ? 'loop' : tangentChain ? 'chain' : 'single';
  return {
    operation: fillet
      ? scope === 'manual' ? 'fillet-edge-manual-chain' : scope === 'loop' ? 'fillet-edge-loop' : scope === 'chain' ? 'fillet-edge-chain' : 'fillet-edge'
      : scope === 'manual' ? 'chamfer-edge-manual-chain' : scope === 'loop' ? 'chamfer-edge-loop' : scope === 'chain' ? 'chamfer-edge-chain' : 'chamfer-edge',
    partId, stableFaceId, stableEdgeId, selectedEdges,
    radiusMm: null, widthMm: null, heightMm: null, lengthMm: null, depthMm, rotationDeg: 0,
    reason: `${scope === 'manual' ? '手工多选边链' : scope === 'loop' ? '平面边界整圈' : scope === 'chain' ? '切线连续边链' : '单边'}${fillet ? '圆角' : '倒角'} ${depthMm} 毫米`
  };
}

/** Codex 不可用时使用的确定性中文解析入口。 */
export function buildLocalCadFeatureRequest(selection: CadFaceSelectionContext, command: string): LocalCadFeatureRequest {
  const { face, edge, edgeTargets } = validatedSelection(selection);
  const plan = selection.selectionMode === 'edge' || selection.selectionMode === 'edge-chain'
    ? parseEdgeCommand(
        command,
        face.partId,
        face.stableId,
        selection.selectionMode === 'edge' ? edge!.stableEdgeId : null,
        selection.selectionMode === 'edge-chain'
          ? edgeTargets.map((target) => ({ stableFaceId: target.face.stableId, stableEdgeId: target.edge.stableEdgeId }))
          : undefined
      )
    : parsePlanarCommand(command, face.partId, face.stableId);
  return requestFromPlan(selection, command, plan, plan.reason);
}
