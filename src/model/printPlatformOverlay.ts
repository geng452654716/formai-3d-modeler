import type {
  PrintPlatformBoundaryPreview,
  PrintPlatformSafetyAreaPreview
} from './printOrientation';

export type PrintPlatformOverlayStatus = 'inside' | 'overflow' | 'too-large';

export interface PrintPlatformHorizontalBounds {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

export interface PrintPlatformOverlay {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  safetyMarginMm: number;
  platformBoundsMm: PrintPlatformHorizontalBounds;
  effectiveBoundsMm: PrintPlatformHorizontalBounds;
  objectBoundsMm: PrintPlatformHorizontalBounds;
  overflowMm: {
    left: number;
    right: number;
    front: number;
    back: number;
  };
  overflow: {
    left: boolean;
    right: boolean;
    front: boolean;
    back: boolean;
  };
  fitsEffectiveArea: boolean;
  canFitEffectiveArea: boolean;
  status: PrintPlatformOverlayStatus;
}

const OVERFLOW_TOLERANCE_MM = 1e-4;

function assertNonEmptyText(value: string, fieldName: string) {
  if (!value.trim()) throw new Error(`${fieldName}不能为空`);
}

function cloneFiniteBounds(
  bounds: PrintPlatformHorizontalBounds,
  fieldName: string
): PrintPlatformHorizontalBounds {
  const cloned = {
    minimumX: bounds.minimumX,
    maximumX: bounds.maximumX,
    minimumZ: bounds.minimumZ,
    maximumZ: bounds.maximumZ
  };
  Object.entries(cloned).forEach(([key, value]) => {
    if (!Number.isFinite(value)) throw new Error(`${fieldName}${key}必须是有限毫米数值`);
  });
  if (cloned.maximumX < cloned.minimumX || cloned.maximumZ < cloned.minimumZ) {
    throw new Error(`${fieldName}最小值不能大于最大值`);
  }
  return cloned;
}

function finiteOverflow(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${fieldName}必须是非负有限毫米数值`);
  return value;
}

/** 把打印分析结果转换成独立只读视口协议，不携带对象展示状态或可执行修正。 */
export function createPrintPlatformOverlay(
  source: { identity: string; objectId: string; objectLabel: string },
  platformBoundary: PrintPlatformBoundaryPreview,
  safetyArea: PrintPlatformSafetyAreaPreview
): PrintPlatformOverlay {
  assertNonEmptyText(source.identity, '打印平台叠加来源身份');
  assertNonEmptyText(source.objectId, '打印平台叠加对象身份');
  assertNonEmptyText(source.objectLabel, '打印平台叠加对象名称');
  if (!Number.isFinite(safetyArea.safetyMarginMm) || safetyArea.safetyMarginMm < 0) {
    throw new Error('打印平台安全边距必须是非负有限毫米数值');
  }

  const overflowMm = {
    left: finiteOverflow(safetyArea.overflowMm.left, '左侧越界量'),
    right: finiteOverflow(safetyArea.overflowMm.right, '右侧越界量'),
    front: finiteOverflow(safetyArea.overflowMm.front, '前侧越界量'),
    back: finiteOverflow(safetyArea.overflowMm.back, '后侧越界量')
  };
  const overflow = {
    left: overflowMm.left > OVERFLOW_TOLERANCE_MM,
    right: overflowMm.right > OVERFLOW_TOLERANCE_MM,
    front: overflowMm.front > OVERFLOW_TOLERANCE_MM,
    back: overflowMm.back > OVERFLOW_TOLERANCE_MM
  };
  const status: PrintPlatformOverlayStatus = !safetyArea.canFitEffectiveArea
    ? 'too-large'
    : safetyArea.fitsEffectiveArea
      ? 'inside'
      : 'overflow';

  return {
    sourceIdentity: source.identity,
    objectId: source.objectId,
    objectLabel: source.objectLabel,
    safetyMarginMm: safetyArea.safetyMarginMm,
    platformBoundsMm: cloneFiniteBounds(platformBoundary.platformBoundsMm, '物理平台边界'),
    effectiveBoundsMm: cloneFiniteBounds(safetyArea.effectivePlatformBoundsMm, '安全有效区域边界'),
    objectBoundsMm: cloneFiniteBounds(platformBoundary.boundsMm, '当前对象占地边界'),
    overflowMm,
    overflow,
    fitsEffectiveArea: safetyArea.fitsEffectiveArea,
    canFitEffectiveArea: safetyArea.canFitEffectiveArea,
    status
  };
}

/** 生成 X/Z 水平矩形的闭合三维折线点，供视口按真实毫米坐标绘制。 */
export function createPrintPlatformRectanglePoints(
  bounds: PrintPlatformHorizontalBounds,
  heightMm: number
): Array<[number, number, number]> {
  const checked = cloneFiniteBounds(bounds, '视口矩形边界');
  if (!Number.isFinite(heightMm)) throw new Error('视口矩形高度必须是有限毫米数值');
  return [
    [checked.minimumX, heightMm, checked.minimumZ],
    [checked.maximumX, heightMm, checked.minimumZ],
    [checked.maximumX, heightMm, checked.maximumZ],
    [checked.minimumX, heightMm, checked.maximumZ],
    [checked.minimumX, heightMm, checked.minimumZ]
  ];
}

/** 返回安全有效区域指定方向的边段，用于只高亮真实越界方向。 */
export function createPrintPlatformBoundarySegment(
  bounds: PrintPlatformHorizontalBounds,
  side: keyof PrintPlatformOverlay['overflow'],
  heightMm: number
): [[number, number, number], [number, number, number]] {
  const checked = cloneFiniteBounds(bounds, '安全有效区域边界');
  if (!Number.isFinite(heightMm)) throw new Error('安全边界高度必须是有限毫米数值');
  if (side === 'left') {
    return [[checked.minimumX, heightMm, checked.minimumZ], [checked.minimumX, heightMm, checked.maximumZ]];
  }
  if (side === 'right') {
    return [[checked.maximumX, heightMm, checked.minimumZ], [checked.maximumX, heightMm, checked.maximumZ]];
  }
  if (side === 'front') {
    return [[checked.minimumX, heightMm, checked.maximumZ], [checked.maximumX, heightMm, checked.maximumZ]];
  }
  return [[checked.minimumX, heightMm, checked.minimumZ], [checked.maximumX, heightMm, checked.minimumZ]];
}
