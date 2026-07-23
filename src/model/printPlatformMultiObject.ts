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

export type PrintPlatformObjectPairStatus = 'overlap' | 'too-close' | 'safe';

export interface PrintPlatformHorizontalPoint {
  x: number;
  z: number;
}

export interface PrintPlatformObjectPairDiagnostic {
  sourceIdentity: string;
  firstObjectId: string;
  firstObjectLabel: string;
  secondObjectId: string;
  secondObjectLabel: string;
  status: PrintPlatformObjectPairStatus;
  gapXMm: number;
  gapZMm: number;
  distanceMm: number;
  overlapXMm: number;
  overlapZMm: number;
  overlapAreaMm2: number;
  requiredAdditionalMm: number;
  connectionStartMm: PrintPlatformHorizontalPoint;
  connectionEndMm: PrintPlatformHorizontalPoint;
  overlapBoundsMm: PrintPlatformHorizontalBounds | null;
}

export interface PrintPlatformMultiObjectSpacingDiagnostic {
  sourceIdentity: string;
  clearanceMm: number;
  pairs: PrintPlatformObjectPairDiagnostic[];
  pairCount: number;
  overlapCount: number;
  tooCloseCount: number;
  safeCount: number;
  riskCount: number;
  status: PrintPlatformObjectPairStatus | 'empty';
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

function axisRelationship(
  firstMinimum: number,
  firstMaximum: number,
  secondMinimum: number,
  secondMaximum: number
) {
  if (firstMaximum < secondMinimum - BOUNDARY_TOLERANCE_MM) {
    return {
      gapMm: secondMinimum - firstMaximum,
      overlapMm: 0,
      firstCoordinateMm: firstMaximum,
      secondCoordinateMm: secondMinimum
    };
  }
  if (secondMaximum < firstMinimum - BOUNDARY_TOLERANCE_MM) {
    return {
      gapMm: firstMinimum - secondMaximum,
      overlapMm: 0,
      firstCoordinateMm: firstMinimum,
      secondCoordinateMm: secondMaximum
    };
  }
  const overlapMinimum = Math.max(firstMinimum, secondMinimum);
  const overlapMaximum = Math.min(firstMaximum, secondMaximum);
  const overlapMm = Math.max(0, overlapMaximum - overlapMinimum);
  const sharedCoordinateMm = (overlapMinimum + overlapMaximum) / 2;
  return {
    gapMm: 0,
    overlapMm,
    firstCoordinateMm: sharedCoordinateMm,
    secondCoordinateMm: sharedCoordinateMm
  };
}

/**
 * 基于第 82 阶段的水平占地进行对象对诊断，不重新读取网格，也不修改对象位置。
 * 对象顺序不影响来源身份和输出顺序。
 */
export function createPrintPlatformMultiObjectSpacingDiagnostic(
  preview: PrintPlatformMultiObjectPreview,
  clearanceMm: number
): PrintPlatformMultiObjectSpacingDiagnostic {
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) {
    throw new Error('对象安全间距必须是大于或等于 0 的有限毫米值');
  }
  const checkedPreviewIdentity = nonEmptyText(preview.sourceIdentity, '多对象间距诊断来源身份');
  const objects = [...preview.objects].sort((first, second) => (
    first.sourceIdentity.localeCompare(second.sourceIdentity)
      || first.objectId.localeCompare(second.objectId)
  ));
  const pairs: PrintPlatformObjectPairDiagnostic[] = [];
  for (let firstIndex = 0; firstIndex < objects.length; firstIndex += 1) {
    const first = objects[firstIndex];
    const firstBounds = checkedBounds(first.boundsMm, `“${first.objectLabel}”占地边界`);
    for (let secondIndex = firstIndex + 1; secondIndex < objects.length; secondIndex += 1) {
      const second = objects[secondIndex];
      const secondBounds = checkedBounds(second.boundsMm, `“${second.objectLabel}”占地边界`);
      const x = axisRelationship(
        firstBounds.minimumX,
        firstBounds.maximumX,
        secondBounds.minimumX,
        secondBounds.maximumX
      );
      const z = axisRelationship(
        firstBounds.minimumZ,
        firstBounds.maximumZ,
        secondBounds.minimumZ,
        secondBounds.maximumZ
      );
      const overlapping = x.overlapMm > BOUNDARY_TOLERANCE_MM
        && z.overlapMm > BOUNDARY_TOLERANCE_MM;
      const distanceMm = Math.hypot(x.gapMm, z.gapMm);
      const status: PrintPlatformObjectPairStatus = overlapping
        ? 'overlap'
        : distanceMm + BOUNDARY_TOLERANCE_MM < clearanceMm
          ? 'too-close'
          : 'safe';
      const overlapBoundsMm = overlapping
        ? {
            minimumX: Math.max(firstBounds.minimumX, secondBounds.minimumX),
            maximumX: Math.min(firstBounds.maximumX, secondBounds.maximumX),
            minimumZ: Math.max(firstBounds.minimumZ, secondBounds.minimumZ),
            maximumZ: Math.min(firstBounds.maximumZ, secondBounds.maximumZ)
          }
        : null;
      const overlapAreaMm2 = overlapping ? x.overlapMm * z.overlapMm : 0;
      const requiredAdditionalMm = overlapping
        ? Math.min(x.overlapMm, z.overlapMm) + clearanceMm
        : Math.max(0, clearanceMm - distanceMm);
      pairs.push({
        sourceIdentity: `${checkedPreviewIdentity}\u0000对象间距\u0000${first.sourceIdentity}\u0001${second.sourceIdentity}\u0000${clearanceMm}`,
        firstObjectId: first.objectId,
        firstObjectLabel: first.objectLabel,
        secondObjectId: second.objectId,
        secondObjectLabel: second.objectLabel,
        status,
        gapXMm: x.gapMm,
        gapZMm: z.gapMm,
        distanceMm,
        overlapXMm: overlapping ? x.overlapMm : 0,
        overlapZMm: overlapping ? z.overlapMm : 0,
        overlapAreaMm2,
        requiredAdditionalMm,
        connectionStartMm: { x: x.firstCoordinateMm, z: z.firstCoordinateMm },
        connectionEndMm: { x: x.secondCoordinateMm, z: z.secondCoordinateMm },
        overlapBoundsMm
      });
    }
  }
  const overlapCount = pairs.filter((pair) => pair.status === 'overlap').length;
  const tooCloseCount = pairs.filter((pair) => pair.status === 'too-close').length;
  const safeCount = pairs.filter((pair) => pair.status === 'safe').length;
  return {
    sourceIdentity: `${checkedPreviewIdentity}\u0000对象间距诊断\u0000${clearanceMm}`,
    clearanceMm,
    pairs,
    pairCount: pairs.length,
    overlapCount,
    tooCloseCount,
    safeCount,
    riskCount: overlapCount + tooCloseCount,
    status: pairs.length === 0
      ? 'empty'
      : overlapCount > 0
        ? 'overlap'
        : tooCloseCount > 0
          ? 'too-close'
          : 'safe'
  };
}
