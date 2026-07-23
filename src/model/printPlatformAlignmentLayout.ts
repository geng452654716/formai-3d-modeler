import type { PrintPlatformMultiObjectPreview } from './printPlatformMultiObject';
import type { PrintPlatformHorizontalBounds } from './printPlatformOverlay';

export type PrintPlatformAlignmentOperation =
  | 'align-x-min'
  | 'align-x-center'
  | 'align-x-max'
  | 'align-z-min'
  | 'align-z-center'
  | 'align-z-max'
  | 'distribute-x-centers'
  | 'distribute-z-centers';

export type PrintPlatformAlignmentPlacementStatus = 'valid' | 'outside' | 'overlap' | 'too-close' | 'fixed';
export type PrintPlatformAlignmentPlanStatus = 'ready' | 'invalid';

export interface PrintPlatformAlignmentPoint {
  x: number;
  z: number;
}

export interface PrintPlatformAlignmentPlacement {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  selected: boolean;
  locked: boolean;
  reference: boolean;
  distributionEndpoint: boolean;
  currentBoundsMm: PrintPlatformHorizontalBounds;
  targetBoundsMm: PrintPlatformHorizontalBounds;
  currentCenterMm: PrintPlatformAlignmentPoint;
  targetCenterMm: PrintPlatformAlignmentPoint;
  deltaMm: PrintPlatformAlignmentPoint;
  distanceMm: number;
  moved: boolean;
  status: PrintPlatformAlignmentPlacementStatus;
  failureReason: string | null;
  conflictObjectIds: string[];
}

export interface PrintPlatformAlignmentPlan {
  sourceIdentity: string;
  operation: PrintPlatformAlignmentOperation;
  referenceObjectId: string | null;
  clearanceMm: number;
  effectiveBoundsMm: PrintPlatformHorizontalBounds;
  status: PrintPlatformAlignmentPlanStatus;
  placements: PrintPlatformAlignmentPlacement[];
  objectCount: number;
  selectedObjectCount: number;
  lockedObjectCount: number;
  changedObjectCount: number;
  invalidObjectCount: number;
  totalDistanceMm: number;
  canApply: boolean;
  failureReason: string | null;
}

const BOUNDARY_TOLERANCE_MM = 1e-4;

function checkedNumber(value: number, fieldName: string, minimum = Number.NEGATIVE_INFINITY) {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${fieldName}必须是有效毫米值`);
  return value;
}

function checkedBounds(bounds: PrintPlatformHorizontalBounds, fieldName: string) {
  const result = {
    minimumX: checkedNumber(bounds.minimumX, `${fieldName}最小 X`),
    maximumX: checkedNumber(bounds.maximumX, `${fieldName}最大 X`),
    minimumZ: checkedNumber(bounds.minimumZ, `${fieldName}最小 Z`),
    maximumZ: checkedNumber(bounds.maximumZ, `${fieldName}最大 Z`)
  };
  if (result.maximumX < result.minimumX || result.maximumZ < result.minimumZ) {
    throw new Error(`${fieldName}边界无效`);
  }
  return result;
}

function centerOf(bounds: PrintPlatformHorizontalBounds): PrintPlatformAlignmentPoint {
  return {
    x: (bounds.minimumX + bounds.maximumX) / 2,
    z: (bounds.minimumZ + bounds.maximumZ) / 2
  };
}

function shiftBounds(bounds: PrintPlatformHorizontalBounds, delta: PrintPlatformAlignmentPoint) {
  return {
    minimumX: bounds.minimumX + delta.x,
    maximumX: bounds.maximumX + delta.x,
    minimumZ: bounds.minimumZ + delta.z,
    maximumZ: bounds.maximumZ + delta.z
  };
}

function fitsInside(bounds: PrintPlatformHorizontalBounds, effectiveBoundsMm: PrintPlatformHorizontalBounds) {
  return bounds.minimumX >= effectiveBoundsMm.minimumX - BOUNDARY_TOLERANCE_MM
    && bounds.maximumX <= effectiveBoundsMm.maximumX + BOUNDARY_TOLERANCE_MM
    && bounds.minimumZ >= effectiveBoundsMm.minimumZ - BOUNDARY_TOLERANCE_MM
    && bounds.maximumZ <= effectiveBoundsMm.maximumZ + BOUNDARY_TOLERANCE_MM;
}

function axisGap(firstMinimum: number, firstMaximum: number, secondMinimum: number, secondMaximum: number) {
  if (firstMaximum < secondMinimum) return secondMinimum - firstMaximum;
  if (secondMaximum < firstMinimum) return firstMinimum - secondMaximum;
  return 0;
}

function pairStatus(
  first: PrintPlatformHorizontalBounds,
  second: PrintPlatformHorizontalBounds,
  clearanceMm: number
): 'overlap' | 'too-close' | null {
  const gapX = axisGap(first.minimumX, first.maximumX, second.minimumX, second.maximumX);
  const gapZ = axisGap(first.minimumZ, first.maximumZ, second.minimumZ, second.maximumZ);
  const overlapX = Math.min(first.maximumX, second.maximumX) - Math.max(first.minimumX, second.minimumX);
  const overlapZ = Math.min(first.maximumZ, second.maximumZ) - Math.max(first.minimumZ, second.minimumZ);
  if (overlapX > BOUNDARY_TOLERANCE_MM && overlapZ > BOUNDARY_TOLERANCE_MM) return 'overlap';
  if (gapX + BOUNDARY_TOLERANCE_MM < clearanceMm && gapZ + BOUNDARY_TOLERANCE_MM < clearanceMm) return 'too-close';
  return null;
}

function stablePlacementCompare(
  first: Pick<PrintPlatformAlignmentPlacement, 'sourceIdentity' | 'objectId'>,
  second: Pick<PrintPlatformAlignmentPlacement, 'sourceIdentity' | 'objectId'>
) {
  return first.sourceIdentity.localeCompare(second.sourceIdentity, 'zh-CN')
    || first.objectId.localeCompare(second.objectId, 'zh-CN');
}

function isAlignmentOperation(
  operation: PrintPlatformAlignmentOperation
): operation is Exclude<PrintPlatformAlignmentOperation, 'distribute-x-centers' | 'distribute-z-centers'> {
  return operation.startsWith('align-');
}

function operationMinimumSelection(operation: PrintPlatformAlignmentOperation) {
  return isAlignmentOperation(operation) ? 2 : 3;
}

function alignmentTargetCenter(
  operation: Exclude<PrintPlatformAlignmentOperation, 'distribute-x-centers' | 'distribute-z-centers'>,
  bounds: PrintPlatformHorizontalBounds,
  referenceBounds: PrintPlatformHorizontalBounds
): PrintPlatformAlignmentPoint {
  const currentCenter = centerOf(bounds);
  const referenceCenter = centerOf(referenceBounds);
  switch (operation) {
    case 'align-x-min':
      return { x: currentCenter.x + referenceBounds.minimumX - bounds.minimumX, z: currentCenter.z };
    case 'align-x-center':
      return { x: referenceCenter.x, z: currentCenter.z };
    case 'align-x-max':
      return { x: currentCenter.x + referenceBounds.maximumX - bounds.maximumX, z: currentCenter.z };
    case 'align-z-min':
      return { x: currentCenter.x, z: currentCenter.z + referenceBounds.minimumZ - bounds.minimumZ };
    case 'align-z-center':
      return { x: currentCenter.x, z: referenceCenter.z };
    case 'align-z-max':
      return { x: currentCenter.x, z: currentCenter.z + referenceBounds.maximumZ - bounds.maximumZ };
  }
}

function createSourceIdentity(
  preview: PrintPlatformMultiObjectPreview,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number,
  lockedObjectIds: readonly string[],
  selectedObjectIds: readonly string[],
  operation: PrintPlatformAlignmentOperation,
  referenceObjectId: string | null
) {
  return [
    preview.sourceIdentity,
    '打印平台多对象对齐与分布',
    operation,
    `基准:${referenceObjectId ?? '无'}`,
    `已选:${[...new Set(selectedObjectIds)].sort().join(',')}`,
    `锁定:${[...new Set(lockedObjectIds)].sort().join(',')}`,
    `间距:${clearanceMm.toFixed(4)}`,
    `有效:${effectiveBoundsMm.minimumX.toFixed(4)},${effectiveBoundsMm.maximumX.toFixed(4)},${effectiveBoundsMm.minimumZ.toFixed(4)},${effectiveBoundsMm.maximumZ.toFixed(4)}`
  ].join('|');
}

function invalidPlan(
  sourceIdentity: string,
  operation: PrintPlatformAlignmentOperation,
  referenceObjectId: string | null,
  clearanceMm: number,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  placements: PrintPlatformAlignmentPlacement[],
  failureReason: string
): PrintPlatformAlignmentPlan {
  return {
    sourceIdentity,
    operation,
    referenceObjectId,
    clearanceMm,
    effectiveBoundsMm,
    status: 'invalid',
    placements,
    objectCount: placements.length,
    selectedObjectCount: placements.filter((placement) => placement.selected).length,
    lockedObjectCount: placements.filter((placement) => placement.locked).length,
    changedObjectCount: 0,
    invalidObjectCount: 0,
    totalDistanceMm: 0,
    canApply: false,
    failureReason
  };
}

/** 创建只读对齐或等距分布方案；不会修改对象展示状态、几何文件或版本。 */
export function createPrintPlatformAlignmentPlan(
  preview: PrintPlatformMultiObjectPreview,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number,
  lockedObjectIds: readonly string[],
  selectedObjectIds: readonly string[],
  operation: PrintPlatformAlignmentOperation,
  requestedReferenceObjectId: string | null = null
): PrintPlatformAlignmentPlan {
  const effective = checkedBounds(effectiveBoundsMm, '对齐与分布安全有效区域');
  const clearance = checkedNumber(clearanceMm, '对齐与分布安全间距', 0);
  const knownObjectIds = new Set(preview.objects.map((object) => object.objectId));
  const locked = new Set(lockedObjectIds.filter((objectId) => knownObjectIds.has(objectId)));
  const selectedIds = [...new Set(selectedObjectIds)].filter((objectId) => knownObjectIds.has(objectId));
  const selected = new Set(selectedIds);
  const basePlacements = preview.objects.map<PrintPlatformAlignmentPlacement>((object) => {
    const currentCenterMm = centerOf(object.boundsMm);
    return {
      sourceIdentity: object.sourceIdentity,
      objectId: object.objectId,
      objectLabel: object.objectLabel,
      selected: selected.has(object.objectId),
      locked: locked.has(object.objectId),
      reference: false,
      distributionEndpoint: false,
      currentBoundsMm: { ...object.boundsMm },
      targetBoundsMm: { ...object.boundsMm },
      currentCenterMm,
      targetCenterMm: { ...currentCenterMm },
      deltaMm: { x: 0, z: 0 },
      distanceMm: 0,
      moved: false,
      status: selected.has(object.objectId) ? 'valid' : 'fixed',
      failureReason: null,
      conflictObjectIds: []
    };
  });
  const selectedPlacements = basePlacements.filter((placement) => placement.selected).sort(stablePlacementCompare);
  const defaultReferenceObjectId = selectedPlacements[0]?.objectId ?? null;
  const referenceObjectId = requestedReferenceObjectId && selected.has(requestedReferenceObjectId)
    ? requestedReferenceObjectId
    : defaultReferenceObjectId;
  const sourceIdentity = createSourceIdentity(
    preview,
    effective,
    clearance,
    [...locked],
    selectedIds,
    operation,
    referenceObjectId
  );

  const minimumSelection = operationMinimumSelection(operation);
  if (selectedPlacements.length < minimumSelection) {
    return invalidPlan(
      sourceIdentity,
      operation,
      referenceObjectId,
      clearance,
      effective,
      basePlacements,
      operation.startsWith('distribute-')
        ? '等距分布至少需要选择 3 个未锁定打印对象'
        : '对齐至少需要选择 2 个未锁定打印对象'
    );
  }
  const selectedLocked = selectedPlacements.filter((placement) => placement.locked);
  if (selectedLocked.length > 0) {
    return invalidPlan(
      sourceIdentity,
      operation,
      referenceObjectId,
      clearance,
      effective,
      basePlacements,
      `已选对象“${selectedLocked[0].objectLabel}”处于锁定状态，不能作为移动目标`
    );
  }

  const mutable = basePlacements.map((placement) => ({ ...placement }));
  const mutableById = new Map(mutable.map((placement) => [placement.objectId, placement]));
  if (isAlignmentOperation(operation)) {
    const reference = referenceObjectId ? mutableById.get(referenceObjectId) : null;
    if (!reference?.selected) {
      return invalidPlan(sourceIdentity, operation, referenceObjectId, clearance, effective, basePlacements, '所选基准对象已失效，请重新选择');
    }
    reference.reference = true;
    selectedPlacements.forEach((selectedPlacement) => {
      const placement = mutableById.get(selectedPlacement.objectId)!;
      const targetCenterMm = alignmentTargetCenter(operation, placement.currentBoundsMm, reference.currentBoundsMm);
      const deltaMm = {
        x: targetCenterMm.x - placement.currentCenterMm.x,
        z: targetCenterMm.z - placement.currentCenterMm.z
      };
      placement.targetCenterMm = targetCenterMm;
      placement.deltaMm = deltaMm;
      placement.targetBoundsMm = shiftBounds(placement.currentBoundsMm, deltaMm);
      placement.distanceMm = Math.hypot(deltaMm.x, deltaMm.z);
      placement.moved = placement.distanceMm > BOUNDARY_TOLERANCE_MM;
    });
  } else {
    const axis = operation === 'distribute-x-centers' ? 'x' : 'z';
    const spatial = selectedPlacements.slice().sort((first, second) => (
      first.currentCenterMm[axis] - second.currentCenterMm[axis] || stablePlacementCompare(first, second)
    ));
    const first = spatial[0];
    const last = spatial[spatial.length - 1];
    const interval = (last.currentCenterMm[axis] - first.currentCenterMm[axis]) / (spatial.length - 1);
    spatial.forEach((selectedPlacement, index) => {
      const placement = mutableById.get(selectedPlacement.objectId)!;
      placement.distributionEndpoint = index === 0 || index === spatial.length - 1;
      const targetCenterMm = {
        ...placement.currentCenterMm,
        [axis]: first.currentCenterMm[axis] + interval * index
      };
      const deltaMm = {
        x: targetCenterMm.x - placement.currentCenterMm.x,
        z: targetCenterMm.z - placement.currentCenterMm.z
      };
      placement.targetCenterMm = targetCenterMm;
      placement.deltaMm = deltaMm;
      placement.targetBoundsMm = shiftBounds(placement.currentBoundsMm, deltaMm);
      placement.distanceMm = Math.hypot(deltaMm.x, deltaMm.z);
      placement.moved = placement.distanceMm > BOUNDARY_TOLERANCE_MM;
    });
  }

  const conflicts = new Map<string, { overlap: string[]; tooClose: string[] }>();
  mutable.filter((placement) => placement.selected).forEach((placement) => (
    conflicts.set(placement.objectId, { overlap: [], tooClose: [] })
  ));
  for (let firstIndex = 0; firstIndex < mutable.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < mutable.length; secondIndex += 1) {
      const first = mutable[firstIndex];
      const second = mutable[secondIndex];
      if (!first.selected && !second.selected) continue;
      const status = pairStatus(first.targetBoundsMm, second.targetBoundsMm, clearance);
      if (!status) continue;
      if (first.selected) conflicts.get(first.objectId)![status === 'overlap' ? 'overlap' : 'tooClose'].push(second.objectId);
      if (second.selected) conflicts.get(second.objectId)![status === 'overlap' ? 'overlap' : 'tooClose'].push(first.objectId);
    }
  }

  const normalized = mutable.map((placement) => {
    if (!placement.selected) return placement;
    const placementConflicts = conflicts.get(placement.objectId)!;
    const conflictObjectIds = [...placementConflicts.overlap, ...placementConflicts.tooClose].sort();
    if (!fitsInside(placement.targetBoundsMm, effective)) {
      return {
        ...placement,
        status: 'outside' as const,
        failureReason: `${placement.objectLabel}的目标位置超出打印平台安全有效区域`,
        conflictObjectIds
      };
    }
    if (placementConflicts.overlap.length > 0) {
      return {
        ...placement,
        status: 'overlap' as const,
        failureReason: `${placement.objectLabel}的目标位置与 ${placementConflicts.overlap.length} 个对象发生水平重叠`,
        conflictObjectIds
      };
    }
    if (placementConflicts.tooClose.length > 0) {
      return {
        ...placement,
        status: 'too-close' as const,
        failureReason: `${placement.objectLabel}的目标位置与 ${placementConflicts.tooClose.length} 个对象未满足 ${clearance.toFixed(2)} 毫米安全间距`,
        conflictObjectIds
      };
    }
    return { ...placement, status: 'valid' as const, failureReason: null, conflictObjectIds: [] };
  });
  const selectedNormalized = normalized.filter((placement) => placement.selected);
  const changedObjectCount = selectedNormalized.filter((placement) => placement.moved).length;
  const invalidObjectCount = selectedNormalized.filter((placement) => placement.status !== 'valid').length;
  const failureReason = selectedNormalized.find((placement) => placement.failureReason)?.failureReason
    ?? (changedObjectCount === 0 ? '当前操作不会改变任何已选对象的位置' : null);
  const status: PrintPlatformAlignmentPlanStatus = invalidObjectCount === 0 ? 'ready' : 'invalid';
  return {
    sourceIdentity,
    operation,
    referenceObjectId,
    clearanceMm: clearance,
    effectiveBoundsMm: effective,
    status,
    placements: normalized,
    objectCount: normalized.length,
    selectedObjectCount: selectedNormalized.length,
    lockedObjectCount: normalized.filter((placement) => placement.locked).length,
    changedObjectCount,
    invalidObjectCount,
    totalDistanceMm: selectedNormalized.reduce((sum, placement) => sum + placement.distanceMm, 0),
    canApply: status === 'ready' && changedObjectCount > 0,
    failureReason
  };
}
