export type ObjectTransformMode = 'select' | 'translate' | 'rotate' | 'scale';

export interface ObjectVector3 {
  x: number;
  y: number;
  z: number;
}

export interface ObjectTransform {
  positionMm: ObjectVector3;
  rotationDeg: ObjectVector3;
  /** 第一版只允许均匀缩放，避免打印尺寸在三个轴上被意外拉伸。 */
  scale: number;
}

export interface ObjectPresentation {
  transform: ObjectTransform;
  color: string;
}

export type ObjectPresentationMap = Record<string, ObjectPresentation>;

export const DEFAULT_OBJECT_TRANSFORM: ObjectTransform = {
  positionMm: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 },
  scale: 1
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const POSITION_LIMIT_MM = 1000;
const ROTATION_LIMIT_DEG = 36000;
const MINIMUM_SCALE = 0.05;
const MAXIMUM_SCALE = 20;

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeVector(
  value: Partial<ObjectVector3> | undefined,
  fallback: ObjectVector3,
  limit: number
): ObjectVector3 {
  return {
    x: clamp(finite(value?.x ?? fallback.x, fallback.x), -limit, limit),
    y: clamp(finite(value?.y ?? fallback.y, fallback.y), -limit, limit),
    z: clamp(finite(value?.z ?? fallback.z, fallback.z), -limit, limit)
  };
}

/** 统一校验视口、历史记录、持久化和导出共同使用的零件显示状态。 */
export function normalizeObjectPresentation(
  value: Partial<ObjectPresentation> | undefined,
  fallbackColor = '#d9d4c8'
): ObjectPresentation {
  const transform = value?.transform;
  const color = typeof value?.color === 'string' && HEX_COLOR.test(value.color)
    ? value.color.toLowerCase()
    : fallbackColor.toLowerCase();
  return {
    transform: {
      positionMm: normalizeVector(transform?.positionMm, DEFAULT_OBJECT_TRANSFORM.positionMm, POSITION_LIMIT_MM),
      rotationDeg: normalizeVector(transform?.rotationDeg, DEFAULT_OBJECT_TRANSFORM.rotationDeg, ROTATION_LIMIT_DEG),
      scale: clamp(finite(transform?.scale ?? 1, 1), MINIMUM_SCALE, MAXIMUM_SCALE)
    },
    color
  };
}

export function cloneObjectPresentations(value: ObjectPresentationMap): ObjectPresentationMap {
  return Object.fromEntries(
    Object.entries(value).map(([id, presentation]) => [id, normalizeObjectPresentation(presentation, presentation.color)])
  );
}

export function sameObjectPresentation(left: ObjectPresentation, right: ObjectPresentation) {
  return left.color === right.color
    && left.transform.scale === right.transform.scale
    && (['x', 'y', 'z'] as const).every((axis) => (
      left.transform.positionMm[axis] === right.transform.positionMm[axis]
      && left.transform.rotationDeg[axis] === right.transform.rotationDeg[axis]
    ));
}

export function describeObjectTransformChange(mode: ObjectTransformMode, objectLabel: string) {
  if (mode === 'translate') return `移动${objectLabel}`;
  if (mode === 'rotate') return `旋转${objectLabel}`;
  if (mode === 'scale') return `缩放${objectLabel}`;
  return `调整${objectLabel}`;
}

export function degreesToRadians(value: ObjectVector3): [number, number, number] {
  const factor = Math.PI / 180;
  return [value.x * factor, value.y * factor, value.z * factor];
}
