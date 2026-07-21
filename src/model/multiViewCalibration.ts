import type {
  DetectedInterface,
  DetectedInterfaceType,
  ImageCalibration,
  ReferenceImageAnalysis
} from './imageRecognition';
import type { EnclosureParameters } from './types';

export type ReferenceViewType =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'perspective';

export interface ReferenceViewRecord {
  id: string;
  fileName: string;
  viewType: ReferenceViewType;
  calibration: ImageCalibration;
  importedAt: string;
  analysis: ReferenceImageAnalysis;
}

export interface CrossViewInterfaceObservation {
  viewId: string;
  fileName: string;
  viewType: ReferenceViewType;
  interface: DetectedInterface;
}

export type InterfaceMatchStatus = 'matched' | 'needs-confirmation' | 'ignored';
export type InterfaceMatchMethod =
  | 'same-id'
  | 'similar-size'
  | 'single-view'
  | 'manual-confirmation'
  | 'manual-edit';

export interface MatchedInterface {
  id: string;
  type: DetectedInterfaceType;
  observations: CrossViewInterfaceObservation[];
  matchStatus: InterfaceMatchStatus;
  matchMethod: InterfaceMatchMethod;
  confidence: number;
  reviewedInterface?: DetectedInterface;
  ignoredFromStatus?: Exclude<InterfaceMatchStatus, 'ignored'>;
}

export interface MultiViewCalibrationResult {
  status: 'insufficient' | 'ready' | 'warning';
  viewCount: number;
  calibratedViewCount: number;
  fusedMmPerPixel: number | null;
  maximumScaleDeviationRatio: number | null;
  matchedInterfaces: MatchedInterface[];
  warnings: string[];
  createdAt: string;
}

export type InterfaceReviewChanges = Partial<Pick<DetectedInterface,
  | 'id'
  | 'type'
  | 'side'
  | 'positionXPercent'
  | 'positionYPercent'
  | 'widthMm'
  | 'heightMm'
  | 'horizontalOffsetMm'
  | 'bottomOffsetMm'
  | 'requiresOpening'
  | 'openingShape'
>>;

const SCALE_WARNING_THRESHOLD = 0.1;
const SIZE_MATCH_THRESHOLD = 0.2;
const PENDING_INTERFACE_WARNING = '部分接口仅按类型和尺寸形成候选对应，或只在单一视角出现，需要人工确认。';

export const REFERENCE_VIEW_LABELS: Record<ReferenceViewType, string> = {
  front: '正面 / 接口面',
  back: '背面',
  left: '左侧',
  right: '右侧',
  top: '顶部',
  bottom: '底部',
  perspective: '透视角度'
};

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clampConfidence(value: number) {
  return Math.max(0, Math.min(1, value));
}

function sizeDifferenceRatio(
  left: DetectedInterface,
  right: DetectedInterface
) {
  const widthBase = Math.max(left.widthMm, right.widthMm, 0.1);
  const heightBase = Math.max(left.heightMm, right.heightMm, 0.1);
  return Math.max(
    Math.abs(left.widthMm - right.widthMm) / widthBase,
    Math.abs(left.heightMm - right.heightMm) / heightBase
  );
}

function buildMatchedInterface(
  id: string,
  observations: CrossViewInterfaceObservation[],
  matchMethod: InterfaceMatchMethod
): MatchedInterface {
  const averageConfidence = observations.reduce(
    (sum, observation) => sum + observation.interface.confidence,
    0
  ) / observations.length;
  const confirmed = observations.length > 1 && matchMethod === 'same-id';

  return {
    id,
    type: observations[0].interface.type,
    observations,
    matchStatus: confirmed ? 'matched' : 'needs-confirmation',
    matchMethod,
    confidence: clampConfidence(averageConfidence * (confirmed ? 1 : 0.82))
  };
}

function strongestObservation(matched: MatchedInterface) {
  return [...matched.observations].sort(
    (left, right) => right.interface.confidence - left.interface.confidence
  )[0].interface;
}

/** 返回人工编辑后的接口；未编辑时返回置信度最高的单视角观测。 */
export function getMatchedInterfaceValue(matched: MatchedInterface): DetectedInterface {
  const strongest = strongestObservation(matched);
  return matched.reviewedInterface ?? {
    ...strongest,
    id: matched.id,
    confidence: Math.min(strongest.confidence, matched.confidence)
  };
}

function refreshPendingWarning(
  result: MultiViewCalibrationResult,
  matchedInterfaces: MatchedInterface[]
): MultiViewCalibrationResult {
  const warnings = result.warnings.filter((warning) => warning !== PENDING_INTERFACE_WARNING);
  if (matchedInterfaces.some((item) => item.matchStatus === 'needs-confirmation')) {
    warnings.push(PENDING_INTERFACE_WARNING);
  }
  return { ...result, matchedInterfaces, warnings };
}

/** 将每个视角识别到的接口按稳定 ID 或尺寸相似度分组，不假装完成相机位姿求解。 */
export function matchInterfacesAcrossViews(
  views: ReferenceViewRecord[]
): MatchedInterface[] {
  const observations = views.flatMap((view) => view.analysis.interfaces.map((item) => ({
    viewId: view.id,
    fileName: view.fileName,
    viewType: view.viewType,
    interface: item
  })));
  const used = new Set<number>();
  const matches: MatchedInterface[] = [];

  observations.forEach((observation, index) => {
    if (used.has(index) || !observation.interface.id) return;
    const sameIdIndexes = observations
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => (
        !used.has(candidateIndex)
        && candidate.interface.id === observation.interface.id
        && candidate.interface.type === observation.interface.type
      ))
      .map(({ candidateIndex }) => candidateIndex);
    if (sameIdIndexes.length < 2) return;
    sameIdIndexes.forEach((candidateIndex) => used.add(candidateIndex));
    matches.push(buildMatchedInterface(
      observation.interface.id,
      sameIdIndexes.map((candidateIndex) => observations[candidateIndex]),
      'same-id'
    ));
  });

  observations.forEach((observation, index) => {
    if (used.has(index)) return;
    const candidateIndex = observations.findIndex((candidate, nextIndex) => (
      nextIndex > index
      && !used.has(nextIndex)
      && candidate.viewId !== observation.viewId
      && candidate.interface.type === observation.interface.type
      && sizeDifferenceRatio(candidate.interface, observation.interface) <= SIZE_MATCH_THRESHOLD
    ));

    if (candidateIndex >= 0) {
      used.add(index);
      used.add(candidateIndex);
      matches.push(buildMatchedInterface(
        `候选-${observation.interface.type}-${matches.length + 1}`,
        [observation, observations[candidateIndex]],
        'similar-size'
      ));
      return;
    }

    used.add(index);
    matches.push(buildMatchedInterface(
      observation.interface.id || `单视角-${observation.interface.type}-${matches.length + 1}`,
      [observation],
      'single-view'
    ));
  });

  return matches.sort((left, right) => right.confidence - left.confidence);
}

/** 使用各视角毫米/像素比例的中位数形成联合尺度，并报告最大相对偏差。 */
export function buildMultiViewCalibrationResult(
  views: ReferenceViewRecord[],
  createdAt = new Date().toISOString()
): MultiViewCalibrationResult {
  const scales = views
    .map((view) => view.calibration.mmPerPixel)
    .filter((value) => Number.isFinite(value) && value > 0);
  const fusedMmPerPixel = median(scales);
  const maximumScaleDeviationRatio = fusedMmPerPixel === null
    ? null
    : Math.max(...scales.map((scale) => Math.abs(scale - fusedMmPerPixel) / fusedMmPerPixel));
  const warnings: string[] = [];

  if (views.length < 2 || scales.length < 2) {
    warnings.push('至少需要两张已完成双点标定和识别的不同视角照片，才能执行联合标定。');
  }
  if (
    maximumScaleDeviationRatio !== null
    && maximumScaleDeviationRatio > SCALE_WARNING_THRESHOLD
  ) {
    warnings.push(
      `不同视角的标定尺度最大偏差为 ${(maximumScaleDeviationRatio * 100).toFixed(1)}%，超过 10% 建议值；请检查标定线是否共面并用卡尺复核。`
    );
  }

  const matchedInterfaces = matchInterfacesAcrossViews(views);
  if (matchedInterfaces.some((item) => item.matchStatus === 'needs-confirmation')) {
    warnings.push(PENDING_INTERFACE_WARNING);
  }

  return {
    status: views.length < 2 || scales.length < 2
      ? 'insufficient'
      : warnings.some((warning) => warning.includes('超过 10%')) ? 'warning' : 'ready',
    viewCount: views.length,
    calibratedViewCount: scales.length,
    fusedMmPerPixel,
    maximumScaleDeviationRatio,
    matchedInterfaces,
    warnings,
    createdAt
  };
}

/** 人工确认接口对应；可同时修正接口 ID、类型、尺寸、偏移和开孔要求。 */
export function reviewMatchedInterface(
  result: MultiViewCalibrationResult,
  targetId: string,
  changes: InterfaceReviewChanges = {}
): MultiViewCalibrationResult {
  const matchedInterfaces = result.matchedInterfaces.map((matched) => {
    if (matched.id !== targetId) return matched;
    const current = getMatchedInterfaceValue(matched);
    const id = changes.id?.trim() || matched.id;
    const reviewedInterface: DetectedInterface = {
      ...current,
      ...changes,
      id,
      confidence: current.confidence
    };
    return {
      ...matched,
      id,
      type: reviewedInterface.type,
      matchStatus: 'matched' as const,
      matchMethod: Object.keys(changes).length > 0 ? 'manual-edit' as const : 'manual-confirmation' as const,
      confidence: clampConfidence(Math.max(matched.confidence, reviewedInterface.confidence)),
      reviewedInterface,
      ignoredFromStatus: undefined
    };
  });
  return refreshPendingWarning(result, matchedInterfaces);
}

/** 将误识别接口标记为忽略；保留原观测，便于在关闭弹窗前恢复。 */
export function ignoreMatchedInterface(
  result: MultiViewCalibrationResult,
  targetId: string
): MultiViewCalibrationResult {
  const matchedInterfaces = result.matchedInterfaces.map((matched) => matched.id === targetId
    ? {
        ...matched,
        ignoredFromStatus: matched.matchStatus === 'ignored'
          ? matched.ignoredFromStatus ?? 'needs-confirmation'
          : matched.matchStatus,
        matchStatus: 'ignored' as const
      }
    : matched);
  return refreshPendingWarning(result, matchedInterfaces);
}

/** 恢复刚才忽略的接口；自动匹配项恢复为已匹配，候选项恢复为待确认。 */
export function restoreIgnoredInterface(
  result: MultiViewCalibrationResult,
  targetId: string
): MultiViewCalibrationResult {
  const matchedInterfaces = result.matchedInterfaces.map((matched) => matched.id === targetId
    ? {
        ...matched,
        matchStatus: matched.ignoredFromStatus ?? 'needs-confirmation',
        ignoredFromStatus: undefined
      }
    : matched);
  return refreshPendingWarning(result, matchedInterfaces);
}

/** 当尺寸相似候选并非同一物理接口时，拆成各自独立的待确认接口。 */
export function splitMatchedInterface(
  result: MultiViewCalibrationResult,
  targetId: string
): MultiViewCalibrationResult {
  const targetIndex = result.matchedInterfaces.findIndex((matched) => matched.id === targetId);
  if (targetIndex < 0) return result;
  const target = result.matchedInterfaces[targetIndex];
  if (target.observations.length < 2) return result;
  const existingIds = new Set(result.matchedInterfaces.map((matched) => matched.id));
  existingIds.delete(target.id);
  const replacements = target.observations.map((observation, index) => {
    const baseId = observation.interface.id?.trim() || `${target.id}-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    existingIds.add(id);
    return buildMatchedInterface(id, [observation], 'single-view');
  });
  const matchedInterfaces = [
    ...result.matchedInterfaces.slice(0, targetIndex),
    ...replacements,
    ...result.matchedInterfaces.slice(targetIndex + 1)
  ];
  return refreshPendingWarning(result, matchedInterfaces);
}

export function countPendingInterfaces(result: MultiViewCalibrationResult | null) {
  return result?.matchedInterfaces.filter((item) => item.matchStatus === 'needs-confirmation').length ?? 0;
}

export function canApplyMultiViewCalibration(result: MultiViewCalibrationResult | null) {
  return Boolean(result && result.status !== 'insufficient' && countPendingInterfaces(result) === 0);
}

/** 为旧接口列表选择每个跨视角分组中置信度最高的一条观测，并排除人工忽略项。 */
export function flattenMatchedInterfaces(
  result: MultiViewCalibrationResult,
  viewType?: ReferenceViewType
): DetectedInterface[] {
  return result.matchedInterfaces
    .filter((matched) => (
      matched.matchStatus !== 'ignored'
      && (!viewType || matched.observations.some((observation) => observation.viewType === viewType))
    ))
    .map(getMatchedInterfaceValue);
}

/** 同一参数在多个视角有估算值时使用中位数，避免按照片顺序覆盖。 */
export function mergeEstimatedParameterChanges(
  views: ReferenceViewRecord[]
): Partial<EnclosureParameters> {
  const grouped = new Map<keyof EnclosureParameters, number[]>();
  views.forEach((view) => view.analysis.estimatedParameters.forEach((change) => {
    const values = grouped.get(change.parameter) ?? [];
    values.push(change.value);
    grouped.set(change.parameter, values);
  }));

  return Object.fromEntries(
    [...grouped.entries()].map(([parameter, values]) => [parameter, median(values)])
  ) as Partial<EnclosureParameters>;
}
