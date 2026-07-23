import type { PrintPlatformHorizontalBounds, PrintPlatformOverlay } from './printPlatformOverlay';

export interface PrintPlatformTopView {
  sourceIdentity: string;
  boundsMm: PrintPlatformHorizontalBounds;
  targetMm: { x: number; y: number; z: number };
  cameraPositionMm: { x: number; y: number; z: number };
  distanceMm: number;
  viewportAspect: number;
}

export interface PrintPlatformViewRequest {
  id: number;
  sourceIdentity: string;
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm' | 'objectBoundsMm'>;
}

const MINIMUM_CAMERA_DISTANCE_MM = 55;
const DEFAULT_PADDING_RATIO = 1.18;
const TOP_VIEW_FORWARD_OFFSET_RATIO = 0.001;

function finitePositive(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${fieldName}必须是正有限数值`);
  return value;
}

function finiteBounds(bounds: PrintPlatformHorizontalBounds, fieldName: string) {
  const result = {
    minimumX: bounds.minimumX,
    maximumX: bounds.maximumX,
    minimumZ: bounds.minimumZ,
    maximumZ: bounds.maximumZ
  };
  const fields: Array<[string, number]> = [
    ['最小 X', result.minimumX],
    ['最大 X', result.maximumX],
    ['最小 Z', result.minimumZ],
    ['最大 Z', result.maximumZ]
  ];
  fields.forEach(([label, value]) => {
    if (!Number.isFinite(value)) throw new Error(`${fieldName}${label} 必须是有限毫米数值`);
  });
  if (result.maximumX <= result.minimumX || result.maximumZ <= result.minimumZ) {
    throw new Error(`${fieldName}必须具有正宽度和正深度`);
  }
  return result;
}

function copiedBounds(bounds: PrintPlatformHorizontalBounds): PrintPlatformHorizontalBounds {
  return {
    minimumX: bounds.minimumX,
    maximumX: bounds.maximumX,
    minimumZ: bounds.minimumZ,
    maximumZ: bounds.maximumZ
  };
}

/** 创建仅属于视口的递增请求，并冻结本次分析使用的平台与对象边界。 */
export function createNextPrintPlatformViewRequest(
  previous: PrintPlatformViewRequest | null,
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm' | 'objectBoundsMm'>
): PrintPlatformViewRequest {
  if (!overlay.sourceIdentity.trim()) throw new Error('打印平台视角来源身份不能为空');
  return {
    id: (previous?.id ?? 0) + 1,
    sourceIdentity: overlay.sourceIdentity,
    overlay: {
      sourceIdentity: overlay.sourceIdentity,
      platformBoundsMm: copiedBounds(overlay.platformBoundsMm),
      objectBoundsMm: copiedBounds(overlay.objectBoundsMm)
    }
  };
}

/** 只允许仍与当前打印分析来源一致的临时请求驱动相机。 */
export function resolvePrintPlatformTopViewRequest(
  request: PrintPlatformViewRequest,
  currentOverlay: Pick<PrintPlatformOverlay, 'sourceIdentity'> | null,
  viewport: { widthPx: number; heightPx: number },
  verticalFovDeg = 34,
  paddingRatio = DEFAULT_PADDING_RATIO
): PrintPlatformTopView | null {
  if (!currentOverlay || currentOverlay.sourceIdentity !== request.sourceIdentity) return null;
  return createPrintPlatformTopView(request.overlay, viewport, verticalFovDeg, paddingRatio);
}

/** 合并物理平台与对象占地，确保越界对象也会进入俯视安全范围。 */
export function mergePrintPlatformViewBounds(
  platformBounds: PrintPlatformHorizontalBounds,
  objectBounds: PrintPlatformHorizontalBounds
): PrintPlatformHorizontalBounds {
  const platform = finiteBounds(platformBounds, '物理平台边界');
  const object = finiteBounds(objectBounds, '对象占地边界');
  return {
    minimumX: Math.min(platform.minimumX, object.minimumX),
    maximumX: Math.max(platform.maximumX, object.maximumX),
    minimumZ: Math.min(platform.minimumZ, object.minimumZ),
    maximumZ: Math.max(platform.maximumZ, object.maximumZ)
  };
}

/**
 * 根据当前透视视口计算近似正俯视相机目标。
 * 轻微 Z 偏移避免相机视线与 Three.js 默认 Y 向上向量完全共线，切换后仍可继续使用 OrbitControls。
 */
export function createPrintPlatformTopView(
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm' | 'objectBoundsMm'>,
  viewport: { widthPx: number; heightPx: number },
  verticalFovDeg = 34,
  paddingRatio = DEFAULT_PADDING_RATIO
): PrintPlatformTopView {
  if (!overlay.sourceIdentity.trim()) throw new Error('打印平台视角来源身份不能为空');
  const widthPx = finitePositive(viewport.widthPx, '视口宽度');
  const heightPx = finitePositive(viewport.heightPx, '视口高度');
  const fov = finitePositive(verticalFovDeg, '垂直视场角');
  if (fov >= 179) throw new Error('垂直视场角必须小于 179 度');
  const padding = finitePositive(paddingRatio, '视野安全倍率');
  if (padding < 1) throw new Error('视野安全倍率不能小于 1');

  const boundsMm = mergePrintPlatformViewBounds(overlay.platformBoundsMm, overlay.objectBoundsMm);
  const widthMm = boundsMm.maximumX - boundsMm.minimumX;
  const depthMm = boundsMm.maximumZ - boundsMm.minimumZ;
  const centerX = (boundsMm.minimumX + boundsMm.maximumX) / 2;
  const centerZ = (boundsMm.minimumZ + boundsMm.maximumZ) / 2;
  const viewportAspect = widthPx / heightPx;
  const tangent = Math.tan(fov * Math.PI / 360);
  const verticalDistance = depthMm * padding / 2 / tangent;
  const horizontalDistance = widthMm * padding / 2 / (tangent * viewportAspect);
  const distanceMm = Math.max(MINIMUM_CAMERA_DISTANCE_MM, verticalDistance, horizontalDistance);

  return {
    sourceIdentity: overlay.sourceIdentity,
    boundsMm,
    targetMm: { x: centerX, y: 0, z: centerZ },
    cameraPositionMm: {
      x: centerX,
      y: distanceMm,
      z: centerZ + distanceMm * TOP_VIEW_FORWARD_OFFSET_RATIO
    },
    distanceMm,
    viewportAspect
  };
}
