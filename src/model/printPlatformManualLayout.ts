import type { PrintPlatformMultiObjectPreview } from './printPlatformMultiObject';
import type { PrintPlatformHorizontalBounds } from './printPlatformOverlay';

export interface PrintPlatformManualLayoutPoint {
  x: number;
  z: number;
}

export type PrintPlatformManualLayoutPlacementStatus = 'valid' | 'outside' | 'overlap' | 'too-close';

export interface PrintPlatformManualLayoutPlacement {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  locked: boolean;
  currentBoundsMm: PrintPlatformHorizontalBounds;
  targetBoundsMm: PrintPlatformHorizontalBounds;
  rawCenterMm: PrintPlatformManualLayoutPoint;
  targetCenterMm: PrintPlatformManualLayoutPoint;
  deltaMm: PrintPlatformManualLayoutPoint;
  distanceMm: number;
  moved: boolean;
  status: PrintPlatformManualLayoutPlacementStatus;
  failureReason: string | null;
  conflictObjectIds: string[];
}

export interface PrintPlatformManualLayoutSession {
  sourceIdentity: string;
  clearanceMm: number;
  effectiveBoundsMm: PrintPlatformHorizontalBounds;
  gridSizeMm: 1;
  snapToGrid: boolean;
  placements: PrintPlatformManualLayoutPlacement[];
  objectCount: number;
  lockedObjectCount: number;
  adjustableObjectCount: number;
  changedObjectCount: number;
  invalidObjectCount: number;
  canApply: boolean;
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

function centerOf(bounds: PrintPlatformHorizontalBounds): PrintPlatformManualLayoutPoint {
  return {
    x: (bounds.minimumX + bounds.maximumX) / 2,
    z: (bounds.minimumZ + bounds.maximumZ) / 2
  };
}

function shiftBounds(
  bounds: PrintPlatformHorizontalBounds,
  delta: PrintPlatformManualLayoutPoint
): PrintPlatformHorizontalBounds {
  return {
    minimumX: bounds.minimumX + delta.x,
    maximumX: bounds.maximumX + delta.x,
    minimumZ: bounds.minimumZ + delta.z,
    maximumZ: bounds.maximumZ + delta.z
  };
}

function fitsInside(bounds: PrintPlatformHorizontalBounds, effective: PrintPlatformHorizontalBounds) {
  return bounds.minimumX >= effective.minimumX - BOUNDARY_TOLERANCE_MM
    && bounds.maximumX <= effective.maximumX + BOUNDARY_TOLERANCE_MM
    && bounds.minimumZ >= effective.minimumZ - BOUNDARY_TOLERANCE_MM
    && bounds.maximumZ <= effective.maximumZ + BOUNDARY_TOLERANCE_MM;
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
): Exclude<PrintPlatformManualLayoutPlacementStatus, 'valid' | 'outside'> | null {
  const gapX = axisGap(first.minimumX, first.maximumX, second.minimumX, second.maximumX);
  const gapZ = axisGap(first.minimumZ, first.maximumZ, second.minimumZ, second.maximumZ);
  const overlapX = Math.min(first.maximumX, second.maximumX) - Math.max(first.minimumX, second.minimumX);
  const overlapZ = Math.min(first.maximumZ, second.maximumZ) - Math.max(first.minimumZ, second.minimumZ);
  if (overlapX > BOUNDARY_TOLERANCE_MM && overlapZ > BOUNDARY_TOLERANCE_MM) return 'overlap';
  if (gapX + BOUNDARY_TOLERANCE_MM < clearanceMm && gapZ + BOUNDARY_TOLERANCE_MM < clearanceMm) return 'too-close';
  return null;
}

function normalizePlacementStatuses(
  placements: PrintPlatformManualLayoutPlacement[],
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number
) {
  const conflicts = new Map<string, { overlap: string[]; tooClose: string[] }>();
  placements.forEach((placement) => conflicts.set(placement.objectId, { overlap: [], tooClose: [] }));
  for (let firstIndex = 0; firstIndex < placements.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < placements.length; secondIndex += 1) {
      const first = placements[firstIndex];
      const second = placements[secondIndex];
      const status = pairStatus(first.targetBoundsMm, second.targetBoundsMm, clearanceMm);
      if (!status) continue;
      const firstConflicts = conflicts.get(first.objectId)!;
      const secondConflicts = conflicts.get(second.objectId)!;
      if (status === 'overlap') {
        firstConflicts.overlap.push(second.objectId);
        secondConflicts.overlap.push(first.objectId);
      } else {
        firstConflicts.tooClose.push(second.objectId);
        secondConflicts.tooClose.push(first.objectId);
      }
    }
  }

  return placements.map((placement) => {
    const placementConflicts = conflicts.get(placement.objectId)!;
    const conflictIds = [...placementConflicts.overlap, ...placementConflicts.tooClose].sort();
    if (!fitsInside(placement.targetBoundsMm, effectiveBoundsMm)) {
      return {
        ...placement,
        status: 'outside' as const,
        failureReason: `${placement.objectLabel}超出打印平台安全有效区域`,
        conflictObjectIds: conflictIds
      };
    }
    if (placementConflicts.overlap.length > 0) {
      return {
        ...placement,
        status: 'overlap' as const,
        failureReason: `${placement.objectLabel}与 ${placementConflicts.overlap.length} 个对象发生水平重叠`,
        conflictObjectIds: conflictIds
      };
    }
    if (placementConflicts.tooClose.length > 0) {
      return {
        ...placement,
        status: 'too-close' as const,
        failureReason: `${placement.objectLabel}与 ${placementConflicts.tooClose.length} 个对象未满足 ${clearanceMm.toFixed(2)} 毫米安全间距`,
        conflictObjectIds: conflictIds
      };
    }
    return {
      ...placement,
      status: 'valid' as const,
      failureReason: null,
      conflictObjectIds: []
    };
  });
}

function finalizeSession(
  sourceIdentity: string,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number,
  snapToGrid: boolean,
  placements: PrintPlatformManualLayoutPlacement[]
): PrintPlatformManualLayoutSession {
  const normalized = normalizePlacementStatuses(placements, effectiveBoundsMm, clearanceMm);
  const lockedObjectCount = normalized.filter((placement) => placement.locked).length;
  const changedObjectCount = normalized.filter((placement) => !placement.locked && placement.moved).length;
  const invalidObjectCount = normalized.filter((placement) => placement.status !== 'valid').length;
  return {
    sourceIdentity,
    clearanceMm,
    effectiveBoundsMm,
    gridSizeMm: 1,
    snapToGrid,
    placements: normalized,
    objectCount: normalized.length,
    lockedObjectCount,
    adjustableObjectCount: normalized.length - lockedObjectCount,
    changedObjectCount,
    invalidObjectCount,
    canApply: changedObjectCount > 0 && invalidObjectCount === 0
  };
}

function snappedPoint(point: PrintPlatformManualLayoutPoint, snapToGrid: boolean) {
  return snapToGrid
    ? { x: Math.round(point.x), z: Math.round(point.z) }
    : point;
}

/** 创建只存在于当前界面的手工排布会话，不写入对象展示状态或版本。 */
export function createPrintPlatformManualLayoutSession(
  preview: PrintPlatformMultiObjectPreview,
  effectiveBoundsMm: PrintPlatformHorizontalBounds,
  clearanceMm: number,
  lockedObjectIds: readonly string[],
  snapToGrid = true
): PrintPlatformManualLayoutSession {
  const effective = checkedBounds(effectiveBoundsMm, '手工排布安全有效区域');
  const clearance = checkedNumber(clearanceMm, '手工排布安全间距', 0);
  const lockedSet = new Set(lockedObjectIds.map((objectId) => objectId.trim()).filter(Boolean));
  const sourceIdentity = [
    preview.sourceIdentity,
    '手工排布',
    `安全区域:${effective.minimumX},${effective.maximumX},${effective.minimumZ},${effective.maximumZ}`,
    `间距:${clearance}`,
    `锁定:${[...lockedSet].sort().join(',')}`
  ].join('\u0000');
  const placements = [...preview.objects]
    .sort((first, second) => first.sourceIdentity.localeCompare(second.sourceIdentity) || first.objectId.localeCompare(second.objectId))
    .map<PrintPlatformManualLayoutPlacement>((object) => {
      const currentBoundsMm = checkedBounds(object.boundsMm, `${object.objectLabel}当前占地`);
      const currentCenter = centerOf(currentBoundsMm);
      return {
        sourceIdentity: `${sourceIdentity}\u0000${object.sourceIdentity}`,
        objectId: object.objectId,
        objectLabel: object.objectLabel,
        locked: lockedSet.has(object.objectId),
        currentBoundsMm,
        targetBoundsMm: currentBoundsMm,
        rawCenterMm: currentCenter,
        targetCenterMm: currentCenter,
        deltaMm: { x: 0, z: 0 },
        distanceMm: 0,
        moved: false,
        status: 'valid',
        failureReason: null,
        conflictObjectIds: []
      };
    });
  return finalizeSession(sourceIdentity, effective, clearance, snapToGrid, placements);
}

/** 把平台平面射线交点转换为对象中心候选；锁定对象和未知对象保持不变。 */
export function movePrintPlatformManualLayoutObject(
  session: PrintPlatformManualLayoutSession,
  objectId: string,
  rawCenterMm: PrintPlatformManualLayoutPoint
): PrintPlatformManualLayoutSession {
  const raw = {
    x: checkedNumber(rawCenterMm.x, '手工排布候选 X'),
    z: checkedNumber(rawCenterMm.z, '手工排布候选 Z')
  };
  const target = snappedPoint(raw, session.snapToGrid);
  let changed = false;
  const placements = session.placements.map((placement) => {
    if (placement.objectId !== objectId || placement.locked) return placement;
    changed = true;
    const currentCenter = centerOf(placement.currentBoundsMm);
    const deltaMm = { x: target.x - currentCenter.x, z: target.z - currentCenter.z };
    const moved = Math.abs(deltaMm.x) > BOUNDARY_TOLERANCE_MM || Math.abs(deltaMm.z) > BOUNDARY_TOLERANCE_MM;
    return {
      ...placement,
      sourceIdentity: `${session.sourceIdentity}\u0000${placement.objectId}\u0000${target.x.toFixed(4)},${target.z.toFixed(4)}`,
      targetBoundsMm: shiftBounds(placement.currentBoundsMm, deltaMm),
      rawCenterMm: raw,
      targetCenterMm: target,
      deltaMm,
      distanceMm: Math.hypot(deltaMm.x, deltaMm.z),
      moved
    };
  });
  return changed
    ? finalizeSession(session.sourceIdentity, session.effectiveBoundsMm, session.clearanceMm, session.snapToGrid, placements)
    : session;
}

/** 切换固定 1 毫米吸附并基于每个对象最后一次原始交点重新计算目标位置。 */
export function setPrintPlatformManualLayoutSnapToGrid(
  session: PrintPlatformManualLayoutSession,
  snapToGrid: boolean
): PrintPlatformManualLayoutSession {
  if (session.snapToGrid === snapToGrid) return session;
  const base = finalizeSession(
    session.sourceIdentity,
    session.effectiveBoundsMm,
    session.clearanceMm,
    snapToGrid,
    session.placements
  );
  return session.placements.reduce(
    (current, placement) => movePrintPlatformManualLayoutObject(current, placement.objectId, placement.rawCenterMm),
    base
  );
}
