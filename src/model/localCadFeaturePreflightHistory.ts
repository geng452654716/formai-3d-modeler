import {
  createLocalCadFeatureAdjustment,
  validateLocalCadFeatureAdjustment,
  type LocalCadFeatureAdjustment,
  type LocalCadFeaturePreflightResult,
  type LocalCadFeatureRequest
} from './localCadFeature';

export const LOCAL_CAD_FEATURE_PREFLIGHT_HISTORY_LIMIT = 50;

/** 一次 OpenCascade 精确工具体预检的不可变留档；阻断记录不会伪装成模型版本。 */
export interface LocalCadFeaturePreflightRecord {
  id: string;
  createdAt: string;
  sourceRevision: string;
  request: LocalCadFeatureRequest;
  result: LocalCadFeaturePreflightResult;
  outcome: 'blocked' | 'passed';
  executedRevision: string | null;
}

export interface LocalCadFeaturePreflightDifference {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface LocalCadFeaturePreflightComparison {
  beforeRecordId: string;
  afterRecordId: string;
  outcomeChanged: boolean;
  becamePassed: boolean;
  parameterDifferences: LocalCadFeaturePreflightDifference[];
  diagnosticDifferences: LocalCadFeaturePreflightDifference[];
  addedInterferingStableFaceIds: string[];
  removedInterferingStableFaceIds: string[];
}

export interface LocalCadFeatureRiskSuggestion {
  id: string;
  label: string;
  explanation: string;
  adjustment: LocalCadFeatureAdjustment;
}

export interface LocalCadFeatureRiskSuggestionResult {
  suggestions: LocalCadFeatureRiskSuggestion[];
  explanation: string;
}

function cloneRequest(request: LocalCadFeatureRequest): LocalCadFeatureRequest {
  return {
    ...request,
    center: { ...request.center },
    hitNormal: { ...request.hitNormal },
    surfaceTangentU: request.surfaceTangentU ? { ...request.surfaceTangentU } : null,
    surfaceUv: { ...request.surfaceUv }
  };
}

function clonePreflight(result: LocalCadFeaturePreflightResult): LocalCadFeaturePreflightResult {
  return {
    ...result,
    outputs: [...result.outputs],
    validation: {
      ...result.validation,
      surfaceUv: result.validation.surfaceUv ? { ...result.validation.surfaceUv } : undefined,
      surfaceTangentU: result.validation.surfaceTangentU
        ? { ...result.validation.surfaceTangentU }
        : result.validation.surfaceTangentU,
      interferingStableFaceIds: [...result.validation.interferingStableFaceIds],
      toolBoundsMm: { ...result.validation.toolBoundsMm }
    },
    limitations: [...result.limitations]
  };
}

/** 创建深拷贝预检记录，避免后续预览状态变化污染历史。 */
export function createLocalCadFeaturePreflightRecord(
  request: LocalCadFeatureRequest,
  result: LocalCadFeaturePreflightResult,
  options: { id?: string; createdAt?: string } = {}
): LocalCadFeaturePreflightRecord {
  return {
    id: options.id ?? crypto.randomUUID(),
    createdAt: options.createdAt ?? new Date().toISOString(),
    sourceRevision: request.selectionRevision,
    request: cloneRequest(request),
    result: clonePreflight(result),
    outcome: result.status === 'ok' ? 'passed' : 'blocked',
    executedRevision: null
  };
}

/** 追加预检记录并只保留最近记录，防止桌面会话无限增长。 */
export function appendLocalCadFeaturePreflightRecord(
  history: LocalCadFeaturePreflightRecord[],
  record: LocalCadFeaturePreflightRecord,
  limit = LOCAL_CAD_FEATURE_PREFLIGHT_HISTORY_LIMIT
): LocalCadFeaturePreflightRecord[] {
  const next = history.concat({
    ...record,
    request: cloneRequest(record.request),
    result: clonePreflight(record.result)
  });
  return next.slice(Math.max(0, next.length - Math.max(1, limit)));
}

/** 正式 Worker 成功后把通过的预检记录关联到新 CAD 修订。 */
export function linkLocalCadFeaturePreflightExecution(
  history: LocalCadFeaturePreflightRecord[],
  recordId: string,
  executedRevision: string
): LocalCadFeaturePreflightRecord[] {
  return history.map((record) => record.id === recordId
    ? { ...record, executedRevision }
    : record);
}

/** 寻找同一源修订、零件、稳定面和操作的上一次预检，供修改前后比较。 */
export function findPreviousComparableLocalCadFeaturePreflight(
  history: LocalCadFeaturePreflightRecord[],
  current: LocalCadFeaturePreflightRecord
): LocalCadFeaturePreflightRecord | null {
  const currentIndex = history.findIndex((record) => record.id === current.id);
  const endIndex = currentIndex >= 0 ? currentIndex : history.length;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    if (
      candidate.sourceRevision === current.sourceRevision
      && candidate.request.partId === current.request.partId
      && candidate.request.stableFaceId === current.request.stableFaceId
      && candidate.request.operation === current.request.operation
    ) return candidate;
  }
  return null;
}

function formatNumber(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return `${Number(value.toFixed(4))}${unit}`;
}

function formatBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return value ? '是' : '否';
}

function addDifference(
  target: LocalCadFeaturePreflightDifference[],
  field: string,
  label: string,
  beforeValue: unknown,
  afterValue: unknown,
  formatter: (value: never) => string
) {
  if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) return;
  target.push({
    field,
    label,
    before: formatter(beforeValue as never),
    after: formatter(afterValue as never)
  });
}

/** 比较两次精确预检的受限参数、工具体测量和干涉诊断。 */
export function compareLocalCadFeaturePreflights(
  before: LocalCadFeaturePreflightRecord,
  after: LocalCadFeaturePreflightRecord
): LocalCadFeaturePreflightComparison {
  const beforeAdjustment = createLocalCadFeatureAdjustment(before.request);
  const afterAdjustment = createLocalCadFeatureAdjustment(after.request);
  const parameterDifferences: LocalCadFeaturePreflightDifference[] = [];
  const diagnosticDifferences: LocalCadFeaturePreflightDifference[] = [];
  const addParameter = (field: keyof LocalCadFeatureAdjustment, label: string, unit: string) => {
    addDifference(parameterDifferences, field, label, beforeAdjustment[field], afterAdjustment[field],
      (value) => formatNumber(value as number | null, unit));
  };
  addParameter('diameterMm', '直径', ' 毫米');
  addParameter('widthMm', '宽度', ' 毫米');
  addParameter('heightMm', '高度', ' 毫米');
  addParameter('lengthMm', '长度', ' 毫米');
  addParameter('depthMm', '深度或凸出高度', ' 毫米');
  addParameter('rotationDeg', '旋转角', ' 度');

  const beforeValidation = before.result.validation;
  const afterValidation = after.result.validation;
  const addMetric = (
    field: string,
    label: string,
    beforeValue: unknown,
    afterValue: unknown,
    formatter: (value: never) => string
  ) => addDifference(diagnosticDifferences, field, label, beforeValue, afterValue, formatter);
  addMetric('status', '预检结果', before.outcome, after.outcome,
    (value) => value === 'passed' ? '通过' : '已阻断');
  addMetric('toolVolumeMm3', '工具体积', beforeValidation.toolVolumeMm3, afterValidation.toolVolumeMm3,
    (value) => formatNumber(value as number, ' 立方毫米'));
  addMetric('toolBoundsMm', '工具包围盒', beforeValidation.toolBoundsMm, afterValidation.toolBoundsMm,
    (value) => {
      const bounds = value as { x: number; y: number; z: number };
      return `${formatNumber(bounds.x)} × ${formatNumber(bounds.y)} × ${formatNumber(bounds.z)} 毫米`;
    });
  addMetric('minimumInterferenceDistanceMm', '最近干涉距离', beforeValidation.minimumInterferenceDistanceMm, afterValidation.minimumInterferenceDistanceMm,
    (value) => formatNumber(value as number | null, ' 毫米'));
  addMetric('interferingFaceCount', '干涉面数', beforeValidation.interferingFaceCount, afterValidation.interferingFaceCount,
    (value) => `${value as number} 个`);
  addMetric('contactFaceCount', '接触面数', beforeValidation.contactFaceCount, afterValidation.contactFaceCount,
    (value) => `${value as number} 个`);
  addMetric('contactSampleCount', '接触采样数', beforeValidation.contactSampleCount, afterValidation.contactSampleCount,
    (value) => `${value as number} 个`);
  addMetric('curvatureRatio', '曲率比', beforeValidation.curvatureRatio, afterValidation.curvatureRatio,
    (value) => formatNumber(value as number | null));
  addMetric('localWallThicknessMm', '局部壁厚', beforeValidation.localWallThicknessMm, afterValidation.localWallThicknessMm,
    (value) => formatNumber(value as number | null, ' 毫米'));
  addMetric('remainingWallMm', '剩余壁厚', beforeValidation.remainingWallMm, afterValidation.remainingWallMm,
    (value) => formatNumber(value as number | null, ' 毫米'));
  addMetric('throughCut', '是否通孔', beforeValidation.throughCut, afterValidation.throughCut,
    (value) => formatBoolean(value as boolean | undefined));
  addMetric('selfIntersectionDetected', '目标曲面自交', beforeValidation.selfIntersectionDetected, afterValidation.selfIntersectionDetected,
    (value) => formatBoolean(value as boolean));
  addMetric('adjacentFaceInterferenceDetected', '非目标面干涉', beforeValidation.adjacentFaceInterferenceDetected, afterValidation.adjacentFaceInterferenceDetected,
    (value) => formatBoolean(value as boolean));

  const beforeIds = beforeValidation.interferingStableFaceIds;
  const afterIds = afterValidation.interferingStableFaceIds;
  return {
    beforeRecordId: before.id,
    afterRecordId: after.id,
    outcomeChanged: before.outcome !== after.outcome,
    becamePassed: before.outcome === 'blocked' && after.outcome === 'passed',
    parameterDifferences,
    diagnosticDifferences,
    addedInterferingStableFaceIds: afterIds.filter((id) => !beforeIds.includes(id)),
    removedInterferingStableFaceIds: beforeIds.filter((id) => !afterIds.includes(id))
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

/** 根据已阻断诊断生成确定性的缩小型候选；候选仍必须重新执行 OpenCascade 精确预检。 */
export function suggestLocalCadFeatureRiskAdjustments(
  record: LocalCadFeaturePreflightRecord
): LocalCadFeatureRiskSuggestionResult {
  if (record.outcome !== 'blocked') {
    return { suggestions: [], explanation: '当前预检已经通过，无需生成风险收敛候选。' };
  }

  const request = record.request;
  const base = createLocalCadFeatureAdjustment(request);
  const candidates: Array<Omit<LocalCadFeatureRiskSuggestion, 'id'>> = [];
  const addCandidate = (label: string, explanation: string, adjustment: LocalCadFeatureAdjustment) => {
    try {
      validateLocalCadFeatureAdjustment(request, adjustment);
      if (!candidates.some((candidate) => JSON.stringify(candidate.adjustment) === JSON.stringify(adjustment))) {
        candidates.push({ label, explanation, adjustment });
      }
    } catch {
      // 越界候选不进入界面，也不会绕过现有受限参数校验。
    }
  };
  const operation = request.operation;
  const profileFactors = [0.9, 0.8, 0.7];

  if (operation === 'add-cylinder' || operation === 'cut-cylinder') {
    profileFactors.forEach((factor) => addCandidate(
      `直径缩小 ${Math.round((1 - factor) * 100)}%`,
      '保持点击中心、真实曲面 UV、法线和深度不变，只缩小圆形轮廓。',
      { ...base, diameterMm: base.diameterMm === null ? null : rounded(base.diameterMm * factor) }
    ));
  } else if (operation === 'add-rectangle' || operation === 'cut-rectangle') {
    profileFactors.forEach((factor) => addCandidate(
      `宽高同比缩小 ${Math.round((1 - factor) * 100)}%`,
      '保持中心、旋转角和深度不变，在点击位置切平面上同比缩小矩形安全近似轮廓。',
      {
        ...base,
        widthMm: base.widthMm === null ? null : rounded(base.widthMm * factor),
        heightMm: base.heightMm === null ? null : rounded(base.heightMm * factor)
      }
    ));
  } else if (operation === 'cut-slot') {
    addCandidate('槽孔长度缩短 15%', '先缩短槽孔主轴长度，保持宽度、中心、旋转角和深度不变。', {
      ...base,
      lengthMm: base.lengthMm === null ? null : rounded(Math.max(base.widthMm ?? 0, base.lengthMm * 0.85))
    });
    [0.9, 0.8].forEach((factor) => addCandidate(
      `槽孔宽度和长度缩小 ${Math.round((1 - factor) * 100)}%`,
      '在点击位置切平面上同比缩小槽孔安全近似，并始终保持长度不小于宽度。',
      {
        ...base,
        widthMm: base.widthMm === null ? null : rounded(base.widthMm * factor),
        lengthMm: base.lengthMm === null || base.widthMm === null
          ? base.lengthMm
          : rounded(Math.max(base.widthMm * factor, base.lengthMm * factor))
      }
    ));
  }

  const validation = record.result.validation;
  if (
    base.depthMm > 0.2
    && (validation.adjacentFaceInterferenceDetected || validation.selfIntersectionDetected
      || (validation.remainingWallMm !== null && validation.remainingWallMm !== undefined && validation.remainingWallMm < 0.8))
  ) {
    addCandidate('深度降低 20%', '降低切入或凸出距离，减小穿越邻面、自交或剩余壁厚不足的风险。', {
      ...base,
      depthMm: rounded(base.depthMm * 0.8)
    });
  }

  if (validation.adjacentFaceInterferenceDetected && operation !== 'add-cylinder' && operation !== 'cut-cylinder') {
    [-5, 5].forEach((delta) => addCandidate(
      `旋转角${delta > 0 ? '增加' : '减少'} 5 度`,
      '只做小范围角度试探，不移动点击中心；矩形和槽孔仍是切平面安全近似。',
      { ...base, rotationDeg: Math.max(-180, Math.min(180, base.rotationDeg + delta)) }
    ));
  }

  const suggestions = candidates.slice(0, 5).map((candidate, index) => ({
    ...candidate,
    id: `${record.id}-candidate-${index + 1}`
  }));
  return {
    suggestions,
    explanation: suggestions.length > 0
      ? '候选只收敛受限尺寸、深度或小范围旋转角，不会移动目标稳定面、真实曲面 UV 或当前 CAD。'
      : '当前操作没有可在安全范围内自动收敛的参数，请手工调整或重新选择目标区域。'
  };
}
