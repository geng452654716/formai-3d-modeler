import { getOuterDimensions } from './defaults';
import type { DetectedInterface } from './imageRecognition';
import {
  getMatchedInterfaceValue,
  type MatchedInterface,
  type MultiViewCalibrationResult
} from './multiViewCalibration';
import type {
  EnclosureParameters,
  InterfaceOpeningFace,
  InterfaceOpeningShape,
  InterfaceOpeningSpec
} from './types';

export interface InterfaceOpeningBuildResult {
  openings: InterfaceOpeningSpec[];
  warnings: string[];
}

export const INTERFACE_OPENING_SHAPE_LABELS: Record<InterfaceOpeningShape, string> = {
  circle: '圆孔',
  rectangle: '矩形孔',
  'rounded-rectangle': '圆角矩形孔',
  slot: '槽孔'
};

export const INTERFACE_OPENING_FACE_LABELS: Record<InterfaceOpeningFace, string> = {
  front: '正面',
  back: '背面',
  left: '左侧',
  right: '右侧',
  top: '顶部',
  bottom: '底部'
};

const SIDE_FACE_PATTERNS: Array<[RegExp, InterfaceOpeningFace]> = [
  [/(正面|前面|前侧|front)/i, 'front'],
  [/(背面|后面|后侧|back)/i, 'back'],
  [/(左侧|左面|left)/i, 'left'],
  [/(右侧|右面|right)/i, 'right'],
  [/(顶部|顶面|上面|top)/i, 'top'],
  [/(底部|底面|下面|bottom)/i, 'bottom']
];

export function inferInterfaceOpeningShape(
  detectedInterface: Pick<DetectedInterface, 'type' | 'widthMm' | 'heightMm' | 'openingShape'>
): InterfaceOpeningShape {
  if (detectedInterface.openingShape) return detectedInterface.openingShape;
  if (detectedInterface.type === '按钮' || detectedInterface.type === 'LED') return 'circle';
  if (detectedInterface.type === '电源接口') {
    const largest = Math.max(detectedInterface.widthMm, detectedInterface.heightMm, 0.1);
    const difference = Math.abs(detectedInterface.widthMm - detectedInterface.heightMm) / largest;
    return difference <= 0.2 ? 'circle' : 'rounded-rectangle';
  }
  if (detectedInterface.type === 'USB-C') return 'rounded-rectangle';
  if (detectedInterface.type === '排针') return 'rectangle';
  return 'rounded-rectangle';
}

function faceFromSide(side: string) {
  return SIDE_FACE_PATTERNS.find(([pattern]) => pattern.test(side))?.[1] ?? null;
}

function chooseOpeningFace(
  matched: MatchedInterface,
  value: DetectedInterface
): InterfaceOpeningFace | null {
  const explicitFace = faceFromSide(value.side);
  if (explicitFace) return explicitFace;

  const usableObservations = matched.observations
    .filter((observation) => observation.viewType !== 'perspective')
    .sort((left, right) => right.interface.confidence - left.interface.confidence);
  const viewType = usableObservations[0]?.viewType;
  return viewType && viewType !== 'perspective' ? viewType : null;
}

function normalizeOpeningDimensions(
  shape: InterfaceOpeningShape,
  widthMm: number,
  heightMm: number
) {
  if (shape !== 'circle') return { widthMm, heightMm };
  const diameter = Math.max(widthMm, heightMm);
  return { widthMm: diameter, heightMm: diameter };
}

function openingCornerRadius(shape: InterfaceOpeningShape, widthMm: number, heightMm: number) {
  if (shape === 'circle') return Math.min(widthMm, heightMm) / 2;
  if (shape === 'slot') return Math.min(widthMm, heightMm) / 2;
  if (shape === 'rounded-rectangle') return Math.min(1.5, widthMm / 2, heightMm / 2);
  return 0;
}

function openingCenterV(
  face: InterfaceOpeningFace,
  value: Pick<DetectedInterface, 'heightMm' | 'bottomOffsetMm'>,
  parameters: EnclosureParameters
) {
  const dimensions = getOuterDimensions(parameters);
  if (face === 'top' || face === 'bottom') {
    return value.bottomOffsetMm + value.heightMm / 2 - dimensions.width / 2;
  }
  return value.bottomOffsetMm + value.heightMm / 2 - dimensions.height / 2;
}

export function resolveInterfaceOpeningForParameters(
  opening: InterfaceOpeningSpec,
  parameters: EnclosureParameters
): InterfaceOpeningSpec {
  if (
    opening.positionReference !== 'face-center-bottom'
    || typeof opening.horizontalOffsetMm !== 'number'
    || !Number.isFinite(opening.horizontalOffsetMm)
    || typeof opening.bottomOffsetMm !== 'number'
    || !Number.isFinite(opening.bottomOffsetMm)
  ) {
    return { ...opening };
  }

  return {
    ...opening,
    centerUMm: opening.horizontalOffsetMm,
    centerVMm: openingCenterV(
      opening.face,
      { heightMm: opening.heightMm, bottomOffsetMm: opening.bottomOffsetMm },
      parameters
    )
  };
}

export function resolveInterfaceOpeningsForParameters(
  openings: InterfaceOpeningSpec[] | null | undefined,
  parameters: EnclosureParameters
) {
  return openings?.map((opening) => resolveInterfaceOpeningForParameters(opening, parameters))
    ?? openings;
}

/**
 * 将已确认接口转换为精确 CAD 开孔。坐标来自已标定二维照片平面，
 * 不代表相机位姿求解或摄影测量结果。
 */
export function buildInterfaceOpenings(
  result: MultiViewCalibrationResult,
  parameters: EnclosureParameters
): InterfaceOpeningBuildResult {
  const warnings: string[] = [];
  const openings = result.matchedInterfaces.flatMap((matched): InterfaceOpeningSpec[] => {
    if (matched.matchStatus === 'ignored') return [];
    const value = getMatchedInterfaceValue(matched);
    if (!value.requiresOpening) return [];
    const face = chooseOpeningFace(matched, value);
    if (!face) {
      warnings.push(`接口“${value.id}”只来自透视照片，缺少可确定开孔面的正交视角，已保留为避让信息。`);
      return [];
    }
    if (!(value.widthMm > 0) || !(value.heightMm > 0)) {
      warnings.push(`接口“${value.id}”尺寸无效，未生成精确开孔。`);
      return [];
    }

    const shape = inferInterfaceOpeningShape(value);
    const dimensions = normalizeOpeningDimensions(shape, value.widthMm, value.heightMm);
    return [{
      id: value.id,
      label: `${value.type} · ${value.id}`,
      sourceType: value.type,
      face,
      shape,
      widthMm: dimensions.widthMm,
      heightMm: dimensions.heightMm,
      centerUMm: value.horizontalOffsetMm,
      centerVMm: openingCenterV(face, { ...value, ...dimensions }, parameters),
      positionReference: 'face-center-bottom',
      horizontalOffsetMm: value.horizontalOffsetMm,
      bottomOffsetMm: value.bottomOffsetMm,
      cornerRadiusMm: openingCornerRadius(shape, dimensions.widthMm, dimensions.heightMm),
      minimumEdgeMarginMm: 1.2,
      minimumSpacingMm: 1.2,
      sourceConfidence: value.confidence
    }];
  });

  return { openings, warnings };
}
