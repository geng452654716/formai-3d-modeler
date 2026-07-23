import type {
  PrintPlatformHorizontalBounds,
  PrintPlatformOverlayStatus
} from './printPlatformOverlay';

export type PrintPlatformObjectSourceKind = 'cad' | 'uploaded-stl' | 'reference';

export interface PrintPlatformObjectFootprintCandidate {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  sourceKind: PrintPlatformObjectSourceKind;
  printable: boolean;
  visible: boolean;
  boundsMm: PrintPlatformHorizontalBounds | null;
}

export interface PrintPlatformObjectFootprint {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  sourceKind: Exclude<PrintPlatformObjectSourceKind, 'reference'>;
  boundsMm: PrintPlatformHorizontalBounds;
  widthMm: number;
  depthMm: number;
  fitsPlatform: boolean;
  canFitPlatform: boolean;
  fitsEffectiveArea: boolean;
  canFitEffectiveArea: boolean;
  status: PrintPlatformOverlayStatus;
}

export interface PrintPlatformMultiObjectPreview {
  sourceIdentity: string;
  objects: PrintPlatformObjectFootprint[];
  objectCount: number;
  combinedBoundsMm: PrintPlatformHorizontalBounds | null;
  combinedWidthMm: number;
  combinedDepthMm: number;
  combinedFitsPlatform: boolean;
  combinedCanFitPlatform: boolean;
  combinedFitsEffectiveArea: boolean;
  combinedCanFitEffectiveArea: boolean;
  combinedStatus: PrintPlatformOverlayStatus | null;
  excludedCounts: {
    reference: number;
    hidden: number;
    invalidGeometry: number;
  };
}

const BOUNDARY_TOLERANCE_MM = 1e-4;

function nonEmptyText(value: string, fieldName: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName}不能为空`);
  return trimmed;
}

function checkedBounds(
  bounds: PrintPlatformHorizontalBounds,
  fieldName: string,
  requireArea = true
): PrintPlatformHorizontalBounds {
  const copy = {
    minimumX: bounds.minimumX,
    maximumX: bounds.maximumX,
    minimumZ: bounds.minimumZ,
    maximumZ: bounds.maximumZ
  };
  Object.values(copy).forEach((value) => {
    if (!Number.isFinite(value)) throw new Error(`${fieldName}必须包含有限毫米边界`);
  });
  const widthMm = copy.maximumX - copy.minimumX;
  const depthMm = copy.maximumZ - copy.minimumZ;
  if (widthMm < 0 || depthMm < 0 || (requireArea && (widthMm <= 0 || depthMm <= 0))) {
    throw new Error(`${fieldName}必须具有有效宽度和深度`);
  }
  return copy;
}

function boundsWidth(bounds: PrintPlatformHorizontalBounds) {
  return bounds.maximumX - bounds.minimumX;
}

function boundsDepth(bounds: PrintPlatformHorizontalBounds) {
  return bounds.maximumZ - bounds.minimumZ;
}

function fitsInside(
  bounds: PrintPlatformHorizontalBounds,
  container: PrintPlatformHorizontalBounds
) {
  return bounds.minimumX >= container.minimumX - BOUNDARY_TOLERANCE_MM
    && bounds.maximumX <= container.maximumX + BOUNDARY_TOLERANCE_MM
    && bounds.minimumZ >= container.minimumZ - BOUNDARY_TOLERANCE_MM
    && bounds.maximumZ <= container.maximumZ + BOUNDARY_TOLERANCE_MM;
}

function canFitInside(
  bounds: PrintPlatformHorizontalBounds,
  container: PrintPlatformHorizontalBounds
) {
  return boundsWidth(bounds) <= boundsWidth(container) + BOUNDARY_TOLERANCE_MM
    && boundsDepth(bounds) <= boundsDepth(container) + BOUNDARY_TOLERANCE_MM;
}

function footprintStatus(fitsEffectiveArea: boolean, canFitEffectiveArea: boolean): PrintPlatformOverlayStatus {
  return !canFitEffectiveArea ? 'too-large' : fitsEffectiveArea ? 'inside' : 'overflow';
}

/**
 * 把当前分析来源和全部候选身份冻结为确定性身份。候选顺序不影响身份，
 * 但几何修订、对象变换、可见性或来源类型变化都会产生新身份。
 */
export function createPrintPlatformMultiObjectSourceIdentity(
  analysisSourceIdentity: string,
  candidates: ReadonlyArray<Pick<
    PrintPlatformObjectFootprintCandidate,
    'sourceIdentity' | 'objectId' | 'sourceKind' | 'printable' | 'visible'
  >>
) {
  const baseIdentity = nonEmptyText(analysisSourceIdentity, '多对象占地分析来源身份');
  const candidateIdentities = candidates.map((candidate) => [
    nonEmptyText(candidate.sourceIdentity, '多对象候选来源身份'),
    nonEmptyText(candidate.objectId, '多对象候选对象身份'),
    candidate.sourceKind,
    candidate.printable ? '可打印' : '参考',
    candidate.visible ? '可见' : '隐藏'
  ].join(':')).sort();
  return `${baseIdentity}\u0000多对象联合占地\u0000${candidateIdentities.join('\u0001')}`;
}

/** 聚合任意 CAD、上传 STL 或后续来源的可打印对象，不绑定示例模型名称。 */
export function createPrintPlatformMultiObjectPreview(
  sourceIdentity: string,
  candidates: readonly PrintPlatformObjectFootprintCandidate[],
  platformBoundsMm: PrintPlatformHorizontalBounds,
  effectiveBoundsMm: PrintPlatformHorizontalBounds
): PrintPlatformMultiObjectPreview {
  const checkedSourceIdentity = nonEmptyText(sourceIdentity, '多对象占地预览来源身份');
  const platform = checkedBounds(platformBoundsMm, '物理平台边界');
  const effective = checkedBounds(effectiveBoundsMm, '安全有效区域边界');
  if (!fitsInside(effective, platform)) throw new Error('安全有效区域必须位于物理平台内部');

  const excludedCounts = { reference: 0, hidden: 0, invalidGeometry: 0 };
  const objects: PrintPlatformObjectFootprint[] = [];
  candidates.forEach((candidate) => {
    nonEmptyText(candidate.sourceIdentity, '候选来源身份');
    nonEmptyText(candidate.objectId, '候选对象身份');
    const objectLabel = nonEmptyText(candidate.objectLabel, '候选对象名称');
    if (!candidate.printable || candidate.sourceKind === 'reference') {
      excludedCounts.reference += 1;
      return;
    }
    if (!candidate.visible) {
      excludedCounts.hidden += 1;
      return;
    }
    let bounds: PrintPlatformHorizontalBounds;
    try {
      if (!candidate.boundsMm) throw new Error('无几何边界');
      bounds = checkedBounds(candidate.boundsMm, `“${objectLabel}”占地边界`);
    } catch {
      excludedCounts.invalidGeometry += 1;
      return;
    }
    const fitsPlatform = fitsInside(bounds, platform);
    const canFitPlatform = canFitInside(bounds, platform);
    const fitsEffectiveArea = fitsInside(bounds, effective);
    const canFitEffectiveArea = canFitInside(bounds, effective);
    objects.push({
      sourceIdentity: candidate.sourceIdentity,
      objectId: candidate.objectId,
      objectLabel,
      sourceKind: candidate.sourceKind,
      boundsMm: bounds,
      widthMm: boundsWidth(bounds),
      depthMm: boundsDepth(bounds),
      fitsPlatform,
      canFitPlatform,
      fitsEffectiveArea,
      canFitEffectiveArea,
      status: footprintStatus(fitsEffectiveArea, canFitEffectiveArea)
    });
  });

  const combinedBoundsMm = objects.length === 0 ? null : objects.reduce<PrintPlatformHorizontalBounds>(
    (combined, object) => ({
      minimumX: Math.min(combined.minimumX, object.boundsMm.minimumX),
      maximumX: Math.max(combined.maximumX, object.boundsMm.maximumX),
      minimumZ: Math.min(combined.minimumZ, object.boundsMm.minimumZ),
      maximumZ: Math.max(combined.maximumZ, object.boundsMm.maximumZ)
    }),
    { ...objects[0].boundsMm }
  );
  const combinedWidthMm = combinedBoundsMm ? boundsWidth(combinedBoundsMm) : 0;
  const combinedDepthMm = combinedBoundsMm ? boundsDepth(combinedBoundsMm) : 0;
  const combinedFitsPlatform = combinedBoundsMm ? fitsInside(combinedBoundsMm, platform) : false;
  const combinedCanFitPlatform = combinedBoundsMm ? canFitInside(combinedBoundsMm, platform) : false;
  const combinedFitsEffectiveArea = combinedBoundsMm ? fitsInside(combinedBoundsMm, effective) : false;
  const combinedCanFitEffectiveArea = combinedBoundsMm ? canFitInside(combinedBoundsMm, effective) : false;

  return {
    sourceIdentity: checkedSourceIdentity,
    objects,
    objectCount: objects.length,
    combinedBoundsMm,
    combinedWidthMm,
    combinedDepthMm,
    combinedFitsPlatform,
    combinedCanFitPlatform,
    combinedFitsEffectiveArea,
    combinedCanFitEffectiveArea,
    combinedStatus: combinedBoundsMm
      ? footprintStatus(combinedFitsEffectiveArea, combinedCanFitEffectiveArea)
      : null,
    excludedCounts
  };
}
