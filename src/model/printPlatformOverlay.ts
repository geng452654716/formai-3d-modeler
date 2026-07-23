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

export interface PrintPlatformBedGuide {
  sourceIdentity: string;
  centerMm: { x: number; y: number; z: number };
  widthMm: number;
  depthMm: number;
  centerCrossHalfLengthMm: number;
  centerCrossSegments: [
    [[number, number, number], [number, number, number]],
    [[number, number, number], [number, number, number]]
  ];
  frontLabel: '前侧（Z 正）';
  frontLabelPositionMm: { x: number; y: number; z: number };
}

export interface PrintPlatformGridLine {
  axis: 'x' | 'z';
  coordinateMm: number;
  kind: 'minor' | 'major';
  points: [[number, number, number], [number, number, number]];
}

export interface PrintPlatformGridTick {
  axis: 'x' | 'z';
  coordinateMm: number;
  text: string;
  positionMm: { x: number; y: number; z: number };
}

export interface PrintPlatformGridGuide {
  sourceIdentity: string;
  minorSpacingMm: 10;
  majorSpacingMm: 50;
  minorLines: PrintPlatformGridLine[];
  majorLines: PrintPlatformGridLine[];
  ticks: PrintPlatformGridTick[];
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

const PRINT_PLATFORM_BED_HEIGHT_MM = 0.015;
const PRINT_PLATFORM_CENTER_CROSS_HEIGHT_MM = 0.04;
const PRINT_PLATFORM_FRONT_LABEL_HEIGHT_MM = 0.24;
const PRINT_PLATFORM_FRONT_LABEL_MAX_RIGHT_INSET_MM = 24;
const PRINT_PLATFORM_FRONT_LABEL_MAX_BACK_INSET_MM = 8;

/**
 * 从物理平台边界派生只读床面、中心十字和前向标识坐标。
 * 前侧固定对应最大 Z，与打印方向分析中的“前侧越界”语义保持一致。
 */
export function createPrintPlatformBedGuide(
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm'>
): PrintPlatformBedGuide {
  assertNonEmptyText(overlay.sourceIdentity, '打印平台床面来源身份');
  const bounds = cloneFiniteBounds(overlay.platformBoundsMm, '打印平台床面边界');
  const widthMm = bounds.maximumX - bounds.minimumX;
  const depthMm = bounds.maximumZ - bounds.minimumZ;
  if (widthMm <= 0 || depthMm <= 0) throw new Error('打印平台床面边界必须具有正宽度和正深度');

  const centerX = (bounds.minimumX + bounds.maximumX) / 2;
  const centerZ = (bounds.minimumZ + bounds.maximumZ) / 2;
  const minimumPlatformSpanMm = Math.min(widthMm, depthMm);
  const centerCrossHalfLengthMm = Math.min(
    minimumPlatformSpanMm * 0.45,
    Math.max(6, minimumPlatformSpanMm * 0.08)
  );
  const frontLabelRightInsetMm = Math.min(PRINT_PLATFORM_FRONT_LABEL_MAX_RIGHT_INSET_MM, widthMm * 0.1);
  const frontLabelBackInsetMm = Math.min(PRINT_PLATFORM_FRONT_LABEL_MAX_BACK_INSET_MM, depthMm * 0.04);

  return {
    sourceIdentity: overlay.sourceIdentity,
    centerMm: { x: centerX, y: PRINT_PLATFORM_BED_HEIGHT_MM, z: centerZ },
    widthMm,
    depthMm,
    centerCrossHalfLengthMm,
    centerCrossSegments: [
      [
        [centerX - centerCrossHalfLengthMm, PRINT_PLATFORM_CENTER_CROSS_HEIGHT_MM, centerZ],
        [centerX + centerCrossHalfLengthMm, PRINT_PLATFORM_CENTER_CROSS_HEIGHT_MM, centerZ]
      ],
      [
        [centerX, PRINT_PLATFORM_CENTER_CROSS_HEIGHT_MM, centerZ - centerCrossHalfLengthMm],
        [centerX, PRINT_PLATFORM_CENTER_CROSS_HEIGHT_MM, centerZ + centerCrossHalfLengthMm]
      ]
    ],
    frontLabel: '前侧（Z 正）',
    frontLabelPositionMm: {
      x: bounds.maximumX - frontLabelRightInsetMm,
      y: PRINT_PLATFORM_FRONT_LABEL_HEIGHT_MM,
      z: bounds.maximumZ - frontLabelBackInsetMm
    }
  };
}

/** 无有效来源或非法、非有限、退化边界时不创建任何床面几何。 */
export function resolvePrintPlatformBedGuide(
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm'> | null
): PrintPlatformBedGuide | null {
  if (!overlay) return null;
  try {
    return createPrintPlatformBedGuide(overlay);
  } catch {
    return null;
  }
}


const PRINT_PLATFORM_GRID_MINOR_SPACING_MM = 10 as const;
const PRINT_PLATFORM_GRID_MAJOR_SPACING_MM = 50 as const;
const PRINT_PLATFORM_GRID_HEIGHT_MM = 0.025;
const PRINT_PLATFORM_GRID_TICK_HEIGHT_MM = 0.22;
const PRINT_PLATFORM_GRID_TICK_MAX_EDGE_INSET_MM = 6;
const PRINT_PLATFORM_GRID_MAX_COORDINATES_PER_AXIS = 1024;

function createPrintPlatformGridCoordinates(minimumMm: number, maximumMm: number): number[] {
  const firstIndex = Math.ceil(minimumMm / PRINT_PLATFORM_GRID_MINOR_SPACING_MM);
  const lastIndex = Math.floor(maximumMm / PRINT_PLATFORM_GRID_MINOR_SPACING_MM);
  const coordinateCount = Math.max(0, lastIndex - firstIndex + 1);
  if (coordinateCount > PRINT_PLATFORM_GRID_MAX_COORDINATES_PER_AXIS) {
    throw new Error('打印平台网格线数量超过安全上限');
  }
  return Array.from({ length: coordinateCount }, (_, offset) => {
    const coordinateMm = (firstIndex + offset) * PRINT_PLATFORM_GRID_MINOR_SPACING_MM;
    return Object.is(coordinateMm, -0) ? 0 : coordinateMm;
  });
}

function createPrintPlatformGridTickText(axis: 'x' | 'z', coordinateMm: number) {
  const signedCoordinate = coordinateMm > 0 ? `+${coordinateMm}` : `${coordinateMm}`;
  return `${axis === 'x' ? 'X' : 'Z'} 轴 ${signedCoordinate} 毫米${coordinateMm === 0 ? '（原点）' : ''}`;
}

/**
 * 从物理平台边界派生固定 10/50 毫米只读网格和坐标刻度。
 * X 坐标线沿 Z 方向、Z 坐标线沿 X 方向，所有线段严格裁剪在平台边界内。
 */
export function createPrintPlatformGridGuide(
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm'>
): PrintPlatformGridGuide {
  assertNonEmptyText(overlay.sourceIdentity, '打印平台网格来源身份');
  const bounds = cloneFiniteBounds(overlay.platformBoundsMm, '打印平台网格边界');
  const widthMm = bounds.maximumX - bounds.minimumX;
  const depthMm = bounds.maximumZ - bounds.minimumZ;
  if (widthMm <= 0 || depthMm <= 0) throw new Error('打印平台网格边界必须具有正宽度和正深度');

  const xCoordinates = createPrintPlatformGridCoordinates(bounds.minimumX, bounds.maximumX);
  const zCoordinates = createPrintPlatformGridCoordinates(bounds.minimumZ, bounds.maximumZ);
  const xTickZ = bounds.minimumZ + Math.min(PRINT_PLATFORM_GRID_TICK_MAX_EDGE_INSET_MM, depthMm * 0.03);
  const zTickX = bounds.minimumX + Math.min(PRINT_PLATFORM_GRID_TICK_MAX_EDGE_INSET_MM, widthMm * 0.03);
  const lines = [
    ...xCoordinates.map((coordinateMm): PrintPlatformGridLine => ({
      axis: 'x',
      coordinateMm,
      kind: coordinateMm % PRINT_PLATFORM_GRID_MAJOR_SPACING_MM === 0 ? 'major' : 'minor',
      points: [
        [coordinateMm, PRINT_PLATFORM_GRID_HEIGHT_MM, bounds.minimumZ],
        [coordinateMm, PRINT_PLATFORM_GRID_HEIGHT_MM, bounds.maximumZ]
      ]
    })),
    ...zCoordinates.map((coordinateMm): PrintPlatformGridLine => ({
      axis: 'z',
      coordinateMm,
      kind: coordinateMm % PRINT_PLATFORM_GRID_MAJOR_SPACING_MM === 0 ? 'major' : 'minor',
      points: [
        [bounds.minimumX, PRINT_PLATFORM_GRID_HEIGHT_MM, coordinateMm],
        [bounds.maximumX, PRINT_PLATFORM_GRID_HEIGHT_MM, coordinateMm]
      ]
    }))
  ];
  const majorLines = lines.filter((line) => line.kind === 'major');

  return {
    sourceIdentity: overlay.sourceIdentity,
    minorSpacingMm: PRINT_PLATFORM_GRID_MINOR_SPACING_MM,
    majorSpacingMm: PRINT_PLATFORM_GRID_MAJOR_SPACING_MM,
    minorLines: lines.filter((line) => line.kind === 'minor'),
    majorLines,
    ticks: majorLines.map((line) => ({
      axis: line.axis,
      coordinateMm: line.coordinateMm,
      text: createPrintPlatformGridTickText(line.axis, line.coordinateMm),
      positionMm: line.axis === 'x'
        ? { x: line.coordinateMm, y: PRINT_PLATFORM_GRID_TICK_HEIGHT_MM, z: xTickZ }
        : { x: zTickX, y: PRINT_PLATFORM_GRID_TICK_HEIGHT_MM, z: line.coordinateMm }
    }))
  };
}

/** 无有效来源或非法、非有限、退化、超大边界时不创建任何网格几何。 */
export function resolvePrintPlatformGridGuide(
  overlay: Pick<PrintPlatformOverlay, 'sourceIdentity' | 'platformBoundsMm'> | null
): PrintPlatformGridGuide | null {
  if (!overlay) return null;
  try {
    return createPrintPlatformGridGuide(overlay);
  } catch {
    return null;
  }
}
