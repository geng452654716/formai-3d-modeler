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
  /** 当前对象展示状态中的绕 Y 轴角度；旧调用未提供时按 0 度处理。 */
  currentRotationYDeg?: number;
  /** 在当前位置把当前绕 Y 轴角度增加 90 度后的精确占地。 */
  rotated90BoundsMm?: PrintPlatformHorizontalBounds | null;
}

export interface PrintPlatformObjectFootprint {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  sourceKind: Exclude<PrintPlatformObjectSourceKind, 'reference'>;
  boundsMm: PrintPlatformHorizontalBounds;
  widthMm: number;
  depthMm: number;
  currentRotationYDeg: number;
  rotated90BoundsMm: PrintPlatformHorizontalBounds;
  rotated90WidthMm: number;
  rotated90DepthMm: number;
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

export type PrintPlatformMultiObjectLayoutStatus = 'empty' | 'ready' | 'unplaceable';

export interface PrintPlatformObjectLayoutPlacement {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  currentBoundsMm: PrintPlatformHorizontalBounds;
  targetBoundsMm: PrintPlatformHorizontalBounds;
  deltaMm: PrintPlatformHorizontalPoint;
  distanceMm: number;
  moved: boolean;
  rowIndex: number;
}

export interface PrintPlatformMultiObjectLayoutPlan {
  sourceIdentity: string;
  clearanceMm: number;
  effectiveBoundsMm: PrintPlatformHorizontalBounds;
  status: PrintPlatformMultiObjectLayoutStatus;
  placements: PrintPlatformObjectLayoutPlacement[];
  objectCount: number;
  movedObjectCount: number;
  rowCount: number;
  combinedTargetBoundsMm: PrintPlatformHorizontalBounds | null;
  combinedTargetWidthMm: number;
  combinedTargetDepthMm: number;
  fitsEffectiveArea: boolean;
  failureReason: string | null;
}

export interface PrintPlatformObjectRotationLayoutPlacement extends PrintPlatformObjectLayoutPlacement {
  currentRotationYDeg: number;
  targetRotationYDeg: number;
  rotationDeltaYDeg: 0 | 90;
  rotated: boolean;
  changed: boolean;
}

export interface PrintPlatformMultiObjectRotationLayoutPlan {
  sourceIdentity: string;
  clearanceMm: number;
  effectiveBoundsMm: PrintPlatformHorizontalBounds;
  status: PrintPlatformMultiObjectLayoutStatus;
  placements: PrintPlatformObjectRotationLayoutPlacement[];
  objectCount: number;
  movedObjectCount: number;
  rotatedObjectCount: number;
  changedObjectCount: number;
  rowCount: number;
  combinedTargetBoundsMm: PrintPlatformHorizontalBounds | null;
  combinedTargetWidthMm: number;
  combinedTargetDepthMm: number;
  combinedTargetAreaMm2: number;
  totalDistanceMm: number;
  fitsEffectiveArea: boolean;
  failureReason: string | null;
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

function rotateBounds90AroundCenter(bounds: PrintPlatformHorizontalBounds): PrintPlatformHorizontalBounds {
  const centerX = (bounds.minimumX + bounds.maximumX) / 2;
  const centerZ = (bounds.minimumZ + bounds.maximumZ) / 2;
  const halfWidth = boundsDepth(bounds) / 2;
  const halfDepth = boundsWidth(bounds) / 2;
  return {
    minimumX: centerX - halfWidth,
    maximumX: centerX + halfWidth,
    minimumZ: centerZ - halfDepth,
    maximumZ: centerZ + halfDepth
  };
}

function addQuarterTurnDegrees(value: number) {
  const normalized = (value + 90) % 360;
  return normalized > 180 ? normalized - 360 : normalized <= -180 ? normalized + 360 : normalized;
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
    let currentRotationYDeg: number;
    let rotated90BoundsMm: PrintPlatformHorizontalBounds;
    try {
      if (!candidate.boundsMm) throw new Error('无几何边界');
      bounds = checkedBounds(candidate.boundsMm, `“${objectLabel}”占地边界`);
      currentRotationYDeg = candidate.currentRotationYDeg ?? 0;
      if (!Number.isFinite(currentRotationYDeg)) throw new Error('当前绕 Y 轴角度无效');
      rotated90BoundsMm = candidate.rotated90BoundsMm
        ? checkedBounds(candidate.rotated90BoundsMm, `“${objectLabel}”旋转 90 度占地边界`)
        : rotateBounds90AroundCenter(bounds);
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
      currentRotationYDeg,
      rotated90BoundsMm,
      rotated90WidthMm: boundsWidth(rotated90BoundsMm),
      rotated90DepthMm: boundsDepth(rotated90BoundsMm),
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

/**
 * 在安全有效区域内生成不旋转对象的确定性行式排布。该函数只输出目标 X/Z，
 * 不重新读取网格、不修改对象展示状态，也不依赖 CAD、上传 STL 或示例模型名称。
 */
export function createPrintPlatformMultiObjectLayoutPlan(
  preview: PrintPlatformMultiObjectPreview,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number
): PrintPlatformMultiObjectLayoutPlan {
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) {
    throw new Error('自动排布安全间距必须是大于或等于 0 的有限毫米值');
  }
  const checkedPreviewIdentity = nonEmptyText(preview.sourceIdentity, '自动排布来源身份');
  const effective = checkedBounds(effectiveBoundsMm, '自动排布安全有效区域');
  const objects = [...preview.objects].sort((first, second) => (
    first.sourceIdentity.localeCompare(second.sourceIdentity)
      || first.objectId.localeCompare(second.objectId)
  ));
  const sourceIdentity = [
    checkedPreviewIdentity,
    '多对象自动排布',
    `${effective.minimumX},${effective.maximumX},${effective.minimumZ},${effective.maximumZ}`,
    `${clearanceMm}`,
    ...objects.map((object) => object.sourceIdentity)
  ].join('\u0000');
  const emptyPlan = (failureReason: string | null = null): PrintPlatformMultiObjectLayoutPlan => ({
    sourceIdentity,
    clearanceMm,
    effectiveBoundsMm: effective,
    status: failureReason ? 'unplaceable' : 'empty',
    placements: [],
    objectCount: objects.length,
    movedObjectCount: 0,
    rowCount: 0,
    combinedTargetBoundsMm: null,
    combinedTargetWidthMm: 0,
    combinedTargetDepthMm: 0,
    fitsEffectiveArea: false,
    failureReason
  });
  if (objects.length === 0) return emptyPlan();

  const effectiveWidthMm = boundsWidth(effective);
  const effectiveDepthMm = boundsDepth(effective);
  for (const object of objects) {
    const bounds = checkedBounds(object.boundsMm, `“${object.objectLabel}”自动排布占地边界`);
    const widthMm = boundsWidth(bounds);
    const depthMm = boundsDepth(bounds);
    if (
      widthMm > effectiveWidthMm + BOUNDARY_TOLERANCE_MM
      || depthMm > effectiveDepthMm + BOUNDARY_TOLERANCE_MM
    ) {
      return emptyPlan(
        `“${object.objectLabel}”占地 ${widthMm.toFixed(2)} × ${depthMm.toFixed(2)} 毫米，大于安全有效区域 ${effectiveWidthMm.toFixed(2)} × ${effectiveDepthMm.toFixed(2)} 毫米，无法在不旋转对象的前提下排布。`
      );
    }
  }

  const placements: PrintPlatformObjectLayoutPlacement[] = [];
  let cursorX = effective.minimumX;
  let cursorZ = effective.minimumZ;
  let rowDepthMm = 0;
  let rowIndex = 0;

  for (const object of objects) {
    const currentBounds = checkedBounds(object.boundsMm, `“${object.objectLabel}”自动排布占地边界`);
    const widthMm = boundsWidth(currentBounds);
    const depthMm = boundsDepth(currentBounds);
    if (
      placements.length > 0
      && cursorX > effective.minimumX + BOUNDARY_TOLERANCE_MM
      && cursorX + widthMm > effective.maximumX + BOUNDARY_TOLERANCE_MM
    ) {
      cursorX = effective.minimumX;
      cursorZ += rowDepthMm + clearanceMm;
      rowDepthMm = 0;
      rowIndex += 1;
    }
    if (cursorZ + depthMm > effective.maximumZ + BOUNDARY_TOLERANCE_MM) {
      return emptyPlan(
        `安全有效区域无法容纳全部 ${objects.length} 个对象。确定性行式排布在第 ${rowIndex + 1} 行放置“${object.objectLabel}”时空间不足，请减小对象安全间距、缩小对象或改用更大的打印平台。`
      );
    }
    const targetBoundsMm = {
      minimumX: cursorX,
      maximumX: cursorX + widthMm,
      minimumZ: cursorZ,
      maximumZ: cursorZ + depthMm
    };
    const deltaMm = {
      x: targetBoundsMm.minimumX - currentBounds.minimumX,
      z: targetBoundsMm.minimumZ - currentBounds.minimumZ
    };
    const moved = Math.abs(deltaMm.x) > BOUNDARY_TOLERANCE_MM
      || Math.abs(deltaMm.z) > BOUNDARY_TOLERANCE_MM;
    placements.push({
      sourceIdentity: `${sourceIdentity}\u0001${object.sourceIdentity}`,
      objectId: object.objectId,
      objectLabel: object.objectLabel,
      currentBoundsMm: currentBounds,
      targetBoundsMm,
      deltaMm,
      distanceMm: Math.hypot(deltaMm.x, deltaMm.z),
      moved,
      rowIndex
    });
    cursorX = targetBoundsMm.maximumX + clearanceMm;
    rowDepthMm = Math.max(rowDepthMm, depthMm);
  }

  const combinedTargetBoundsMm = placements.reduce<PrintPlatformHorizontalBounds>(
    (combined, placement) => ({
      minimumX: Math.min(combined.minimumX, placement.targetBoundsMm.minimumX),
      maximumX: Math.max(combined.maximumX, placement.targetBoundsMm.maximumX),
      minimumZ: Math.min(combined.minimumZ, placement.targetBoundsMm.minimumZ),
      maximumZ: Math.max(combined.maximumZ, placement.targetBoundsMm.maximumZ)
    }),
    { ...placements[0].targetBoundsMm }
  );
  return {
    sourceIdentity,
    clearanceMm,
    effectiveBoundsMm: effective,
    status: 'ready',
    placements,
    objectCount: objects.length,
    movedObjectCount: placements.filter((placement) => placement.moved).length,
    rowCount: rowIndex + 1,
    combinedTargetBoundsMm,
    combinedTargetWidthMm: boundsWidth(combinedTargetBoundsMm),
    combinedTargetDepthMm: boundsDepth(combinedTargetBoundsMm),
    fitsEffectiveArea: fitsInside(combinedTargetBoundsMm, effective),
    failureReason: null
  };
}

interface RotationLayoutSearchState {
  placements: PrintPlatformObjectRotationLayoutPlacement[];
  cursorX: number;
  cursorZ: number;
  rowDepthMm: number;
  rowIndex: number;
  combinedTargetBoundsMm: PrintPlatformHorizontalBounds | null;
  totalDistanceMm: number;
  rotatedObjectCount: number;
  orientationSignature: string;
}

const MAX_ROTATION_LAYOUT_SEARCH_STATES = 8192;

function compareLayoutNumber(first: number, second: number) {
  return Math.abs(first - second) <= BOUNDARY_TOLERANCE_MM ? 0 : first - second;
}

function layoutArea(bounds: PrintPlatformHorizontalBounds | null) {
  return bounds ? boundsWidth(bounds) * boundsDepth(bounds) : 0;
}

function compareRotationLayoutStates(
  first: RotationLayoutSearchState,
  second: RotationLayoutSearchState
) {
  return first.rowIndex - second.rowIndex
    || compareLayoutNumber(layoutArea(first.combinedTargetBoundsMm), layoutArea(second.combinedTargetBoundsMm))
    || compareLayoutNumber(first.totalDistanceMm, second.totalDistanceMm)
    || first.rotatedObjectCount - second.rotatedObjectCount
    || first.orientationSignature.localeCompare(second.orientationSignature);
}

function rotationLayoutStateKey(state: RotationLayoutSearchState) {
  const values = [state.cursorX, state.cursorZ, state.rowDepthMm].map((value) => value.toFixed(4));
  return `${state.rowIndex}:${values.join(':')}`;
}

/**
 * 比较每个对象当前朝向与绕 Y 轴增加 90 度后的占地，并在确定性行式排布中
 * 按行数、整体占地面积、总位移、旋转对象数和稳定身份顺序选择唯一方案。
 */
export function createPrintPlatformMultiObjectRotationLayoutPlan(
  preview: PrintPlatformMultiObjectPreview,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number
): PrintPlatformMultiObjectRotationLayoutPlan {
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) {
    throw new Error('旋转寻优排布安全间距必须是大于或等于 0 的有限毫米值');
  }
  const checkedPreviewIdentity = nonEmptyText(preview.sourceIdentity, '旋转寻优排布来源身份');
  const effective = checkedBounds(effectiveBoundsMm, '旋转寻优排布安全有效区域');
  const objects = [...preview.objects].sort((first, second) => (
    first.sourceIdentity.localeCompare(second.sourceIdentity)
      || first.objectId.localeCompare(second.objectId)
  ));
  const sourceIdentity = [
    checkedPreviewIdentity,
    '多对象90度旋转寻优排布',
    `${effective.minimumX},${effective.maximumX},${effective.minimumZ},${effective.maximumZ}`,
    `${clearanceMm}`,
    ...objects.map((object) => [
      object.sourceIdentity,
      object.currentRotationYDeg,
      object.boundsMm.minimumX,
      object.boundsMm.maximumX,
      object.boundsMm.minimumZ,
      object.boundsMm.maximumZ,
      object.rotated90BoundsMm.minimumX,
      object.rotated90BoundsMm.maximumX,
      object.rotated90BoundsMm.minimumZ,
      object.rotated90BoundsMm.maximumZ
    ].join(','))
  ].join('\u0000');
  const emptyPlan = (failureReason: string | null = null): PrintPlatformMultiObjectRotationLayoutPlan => ({
    sourceIdentity,
    clearanceMm,
    effectiveBoundsMm: effective,
    status: failureReason ? 'unplaceable' : 'empty',
    placements: [],
    objectCount: objects.length,
    movedObjectCount: 0,
    rotatedObjectCount: 0,
    changedObjectCount: 0,
    rowCount: 0,
    combinedTargetBoundsMm: null,
    combinedTargetWidthMm: 0,
    combinedTargetDepthMm: 0,
    combinedTargetAreaMm2: 0,
    totalDistanceMm: 0,
    fitsEffectiveArea: false,
    failureReason
  });
  if (objects.length === 0) return emptyPlan();

  const effectiveWidthMm = boundsWidth(effective);
  const effectiveDepthMm = boundsDepth(effective);
  for (const object of objects) {
    const currentBounds = checkedBounds(object.boundsMm, `“${object.objectLabel}”当前占地边界`);
    const rotatedBounds = checkedBounds(object.rotated90BoundsMm, `“${object.objectLabel}”旋转 90 度占地边界`);
    const currentFits = canFitInside(currentBounds, effective);
    const rotatedFits = canFitInside(rotatedBounds, effective);
    if (!currentFits && !rotatedFits) {
      return emptyPlan(
        `“${object.objectLabel}”当前占地 ${boundsWidth(currentBounds).toFixed(2)} × ${boundsDepth(currentBounds).toFixed(2)} 毫米，绕 Y 轴增加 90 度后占地 ${boundsWidth(rotatedBounds).toFixed(2)} × ${boundsDepth(rotatedBounds).toFixed(2)} 毫米，两种朝向都大于安全有效区域 ${effectiveWidthMm.toFixed(2)} × ${effectiveDepthMm.toFixed(2)} 毫米。`
      );
    }
  }

  let states: RotationLayoutSearchState[] = [{
    placements: [],
    cursorX: effective.minimumX,
    cursorZ: effective.minimumZ,
    rowDepthMm: 0,
    rowIndex: 0,
    combinedTargetBoundsMm: null,
    totalDistanceMm: 0,
    rotatedObjectCount: 0,
    orientationSignature: ''
  }];

  objects.forEach((object) => {
    const orientationCandidates = ([false, true] as const).map((rotated) => {
      const boundsMm = checkedBounds(
        rotated ? object.rotated90BoundsMm : object.boundsMm,
        `“${object.objectLabel}”${rotated ? '旋转 90 度' : '当前'}占地边界`
      );
      return {
        rotated,
        boundsMm,
        widthMm: boundsWidth(boundsMm),
        depthMm: boundsDepth(boundsMm)
      };
    });
    const nextStates: RotationLayoutSearchState[] = [];
    states.forEach((state) => {
      orientationCandidates.forEach((orientation) => {
        if (
          orientation.widthMm > effectiveWidthMm + BOUNDARY_TOLERANCE_MM
          || orientation.depthMm > effectiveDepthMm + BOUNDARY_TOLERANCE_MM
        ) return;
        let cursorX = state.cursorX;
        let cursorZ = state.cursorZ;
        let rowDepthMm = state.rowDepthMm;
        let rowIndex = state.rowIndex;
        if (
          state.placements.length > 0
          && cursorX > effective.minimumX + BOUNDARY_TOLERANCE_MM
          && cursorX + orientation.widthMm > effective.maximumX + BOUNDARY_TOLERANCE_MM
        ) {
          cursorX = effective.minimumX;
          cursorZ += rowDepthMm + clearanceMm;
          rowDepthMm = 0;
          rowIndex += 1;
        }
        if (cursorZ + orientation.depthMm > effective.maximumZ + BOUNDARY_TOLERANCE_MM) return;
        const targetBoundsMm = {
          minimumX: cursorX,
          maximumX: cursorX + orientation.widthMm,
          minimumZ: cursorZ,
          maximumZ: cursorZ + orientation.depthMm
        };
        const deltaMm = {
          x: targetBoundsMm.minimumX - orientation.boundsMm.minimumX,
          z: targetBoundsMm.minimumZ - orientation.boundsMm.minimumZ
        };
        const moved = Math.abs(deltaMm.x) > BOUNDARY_TOLERANCE_MM
          || Math.abs(deltaMm.z) > BOUNDARY_TOLERANCE_MM;
        const distanceMm = Math.hypot(deltaMm.x, deltaMm.z);
        const placement: PrintPlatformObjectRotationLayoutPlacement = {
          sourceIdentity: `${sourceIdentity}\u0001${object.sourceIdentity}\u0001${orientation.rotated ? '旋转90度' : '保持当前角度'}`,
          objectId: object.objectId,
          objectLabel: object.objectLabel,
          currentBoundsMm: checkedBounds(object.boundsMm, `“${object.objectLabel}”当前占地边界`),
          targetBoundsMm,
          deltaMm,
          distanceMm,
          moved,
          rowIndex,
          currentRotationYDeg: object.currentRotationYDeg,
          targetRotationYDeg: orientation.rotated
            ? addQuarterTurnDegrees(object.currentRotationYDeg)
            : object.currentRotationYDeg,
          rotationDeltaYDeg: orientation.rotated ? 90 : 0,
          rotated: orientation.rotated,
          changed: moved || orientation.rotated
        };
        const combinedTargetBoundsMm = state.combinedTargetBoundsMm
          ? {
              minimumX: Math.min(state.combinedTargetBoundsMm.minimumX, targetBoundsMm.minimumX),
              maximumX: Math.max(state.combinedTargetBoundsMm.maximumX, targetBoundsMm.maximumX),
              minimumZ: Math.min(state.combinedTargetBoundsMm.minimumZ, targetBoundsMm.minimumZ),
              maximumZ: Math.max(state.combinedTargetBoundsMm.maximumZ, targetBoundsMm.maximumZ)
            }
          : { ...targetBoundsMm };
        nextStates.push({
          placements: [...state.placements, placement],
          cursorX: targetBoundsMm.maximumX + clearanceMm,
          cursorZ,
          rowDepthMm: Math.max(rowDepthMm, orientation.depthMm),
          rowIndex,
          combinedTargetBoundsMm,
          totalDistanceMm: state.totalDistanceMm + distanceMm,
          rotatedObjectCount: state.rotatedObjectCount + (orientation.rotated ? 1 : 0),
          orientationSignature: `${state.orientationSignature}${orientation.rotated ? '1' : '0'}`
        });
      });
    });
    const deduplicated = new Map<string, RotationLayoutSearchState>();
    nextStates.forEach((state) => {
      const key = rotationLayoutStateKey(state);
      const existing = deduplicated.get(key);
      if (!existing || compareRotationLayoutStates(state, existing) < 0) deduplicated.set(key, state);
    });
    states = [...deduplicated.values()]
      .sort(compareRotationLayoutStates)
      .slice(0, MAX_ROTATION_LAYOUT_SEARCH_STATES);
  });

  const best = [...states].sort(compareRotationLayoutStates)[0];
  if (!best?.combinedTargetBoundsMm || best.placements.length !== objects.length) {
    return emptyPlan(
      `安全有效区域无法容纳全部 ${objects.length} 个对象。即使逐个比较当前朝向与绕 Y 轴增加 90 度后的候选，确定性行式排布仍然空间不足；请减小对象安全间距、缩小对象或改用更大的打印平台。`
    );
  }
  const combinedTargetBoundsMm = best.combinedTargetBoundsMm;
  const movedObjectCount = best.placements.filter((placement) => placement.moved).length;
  const changedObjectCount = best.placements.filter((placement) => placement.changed).length;
  return {
    sourceIdentity,
    clearanceMm,
    effectiveBoundsMm: effective,
    status: 'ready',
    placements: best.placements,
    objectCount: objects.length,
    movedObjectCount,
    rotatedObjectCount: best.rotatedObjectCount,
    changedObjectCount,
    rowCount: best.rowIndex + 1,
    combinedTargetBoundsMm,
    combinedTargetWidthMm: boundsWidth(combinedTargetBoundsMm),
    combinedTargetDepthMm: boundsDepth(combinedTargetBoundsMm),
    combinedTargetAreaMm2: layoutArea(combinedTargetBoundsMm),
    totalDistanceMm: best.totalDistanceMm,
    fitsEffectiveArea: fitsInside(combinedTargetBoundsMm, effective),
    failureReason: null
  };
}
