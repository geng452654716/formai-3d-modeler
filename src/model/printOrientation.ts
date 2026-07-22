import { normalizeObjectPresentation, type ObjectPresentation, type ObjectVector3 } from './objectTransform';
import { rotateDisplayPointXyz, sourceToDisplayPoint } from './objectExport';

export type PrintOrientationId = 'positive-x' | 'negative-x' | 'positive-y' | 'negative-y' | 'positive-z' | 'negative-z';

export interface PrintOrientationMeshInput {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number> | null;
}

export interface PrintOrientationCandidate {
  id: PrintOrientationId;
  label: string;
  upAxis: 'X' | 'Y' | 'Z';
  upSign: 1 | -1;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  fitsBuildVolume: boolean;
  contactAreaMm2: number;
  supportAreaMm2: number;
  supportRatio: number;
  score: number | null;
  riskLevel: '低' | '中' | '高' | '不可用';
}

export interface PrintOrientationAnalysis {
  triangleCount: number;
  surfaceAreaMm2: number;
  volumeMm3: number;
  buildVolumeMm: [number, number, number];
  overhangAngleDeg: number;
  uniformScale: number;
  recommendedId: PrintOrientationId | null;
  recommendedReason: string;
  candidates: PrintOrientationCandidate[];
}

export type PrintBedNormalizationSpace = 'object-local' | 'world';

export interface PrintBedPlacementOptions {
  rotationDeg: ObjectVector3;
  positionMm: ObjectVector3;
  uniformScale?: number;
  normalizationSpace: PrintBedNormalizationSpace;
  basePositionDisplayMm?: ObjectVector3;
}

export interface PrintBedPlacementPreview {
  minimumHeightMm: number;
  currentVerticalPositionMm: number;
  requiredVerticalDeltaMm: number;
  targetVerticalPositionMm: number;
  alreadyOnBed: boolean;
}

export interface PrintPlatformBoundaryOptions extends PrintBedPlacementOptions {
  platformSizeMm?: [number, number];
}

export interface PrintPlatformSafetyAreaPreview {
  safetyMarginMm: number;
  effectivePlatformBoundsMm: {
    minimumX: number;
    maximumX: number;
    minimumZ: number;
    maximumZ: number;
    width: number;
    depth: number;
  };
  marginsMm: {
    left: number;
    right: number;
    front: number;
    back: number;
  };
  overflowMm: {
    left: number;
    right: number;
    front: number;
    back: number;
  };
  fitsEffectiveArea: boolean;
  canFitEffectiveArea: boolean;
  minimumMarginMm: number;
  correctionDeltaMm: { x: number; z: number };
}

export interface PrintPlatformBoundaryPreview {
  boundsMm: {
    minimumX: number;
    maximumX: number;
    minimumZ: number;
    maximumZ: number;
    width: number;
    depth: number;
  };
  platformBoundsMm: {
    minimumX: number;
    maximumX: number;
    minimumZ: number;
    maximumZ: number;
  };
  marginsMm: {
    left: number;
    right: number;
    front: number;
    back: number;
  };
  overflowMm: {
    left: number;
    right: number;
    front: number;
    back: number;
  };
  fitsPlatform: boolean;
  minimumMarginMm: number;
  centerDeltaMm: { x: number; z: number };
  targetHorizontalPositionMm: { x: number; z: number };
  alreadyCentered: boolean;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface TriangleMetric {
  points: [Vec3, Vec3, Vec3];
  areaMm2: number;
  normal: Vec3;
}

interface OrientationDefinition {
  id: PrintOrientationId;
  label: string;
  upAxis: 'X' | 'Y' | 'Z';
  upSign: 1 | -1;
  widthAxis: 'x' | 'y' | 'z';
  depthAxis: 'x' | 'y' | 'z';
  heightAxis: 'x' | 'y' | 'z';
}

const ORIENTATIONS: OrientationDefinition[] = [
  { id: 'positive-z', label: 'Z 正方向朝上', upAxis: 'Z', upSign: 1, widthAxis: 'x', depthAxis: 'y', heightAxis: 'z' },
  { id: 'negative-z', label: 'Z 负方向朝上', upAxis: 'Z', upSign: -1, widthAxis: 'x', depthAxis: 'y', heightAxis: 'z' },
  { id: 'positive-y', label: 'Y 正方向朝上', upAxis: 'Y', upSign: 1, widthAxis: 'x', depthAxis: 'z', heightAxis: 'y' },
  { id: 'negative-y', label: 'Y 负方向朝上', upAxis: 'Y', upSign: -1, widthAxis: 'x', depthAxis: 'z', heightAxis: 'y' },
  { id: 'positive-x', label: 'X 正方向朝上', upAxis: 'X', upSign: 1, widthAxis: 'y', depthAxis: 'z', heightAxis: 'x' },
  { id: 'negative-x', label: 'X 负方向朝上', upAxis: 'X', upSign: -1, widthAxis: 'y', depthAxis: 'z', heightAxis: 'x' }
];

const DEFAULT_BUILD_VOLUME_MM: [number, number, number] = [256, 256, 256];
const DEFAULT_OVERHANG_ANGLE_DEG = 45;
const MIN_TRIANGLE_AREA_MM2 = 1e-9;
const ROTATION_EQUIVALENCE_TOLERANCE_DEG = 1e-6;
const BED_PLACEMENT_TOLERANCE_MM = 1e-4;
const PLATFORM_BOUNDARY_TOLERANCE_MM = 1e-4;

const PRINT_ORIENTATION_ROTATIONS_DEG: Record<PrintOrientationId, ObjectVector3> = {
  'positive-z': { x: 0, y: 0, z: 0 },
  'negative-z': { x: 180, y: 0, z: 0 },
  'positive-y': { x: 90, y: 0, z: 0 },
  'negative-y': { x: -90, y: 0, z: 0 },
  'positive-x': { x: 0, y: 0, z: 90 },
  'negative-x': { x: 0, y: 0, z: -90 }
};

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(vector: Vec3) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function scale(vector: Vec3, factor: number): Vec3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

function orientationUpVector(orientation: OrientationDefinition): Vec3 {
  return {
    x: orientation.heightAxis === 'x' ? orientation.upSign : 0,
    y: orientation.heightAxis === 'y' ? orientation.upSign : 0,
    z: orientation.heightAxis === 'z' ? orientation.upSign : 0
  };
}

function axisValue(point: Vec3, axis: 'x' | 'y' | 'z') {
  return point[axis];
}

function readPoint(positions: ArrayLike<number>, vertexIndex: number, uniformScale: number): Vec3 {
  const offset = vertexIndex * 3;
  return {
    x: Number(positions[offset]) * uniformScale,
    y: Number(positions[offset + 1]) * uniformScale,
    z: Number(positions[offset + 2]) * uniformScale
  };
}

function validateBuildVolume(buildVolumeMm: [number, number, number]) {
  if (buildVolumeMm.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('打印机成型空间必须是三个大于 0 的有限毫米值');
  }
}

/** 把索引或非索引三角网格转换为有限几何指标，并用封闭体有向体积统一整体绕序。 */
function collectTriangleMetrics(input: PrintOrientationMeshInput, uniformScale: number) {
  const positions = input.positions;
  if (positions.length < 12 || positions.length % 3 !== 0) {
    throw new Error('打印方向分析至少需要 4 个有效三角面顶点');
  }
  const vertexCount = positions.length / 3;
  const indices = input.indices;
  const triangleVertexCount = indices ? indices.length : vertexCount;
  if (triangleVertexCount < 12 || triangleVertexCount % 3 !== 0) {
    throw new Error('打印方向分析需要完整的三角面索引');
  }

  const rawTriangles: Array<{ points: [Vec3, Vec3, Vec3]; crossVector: Vec3; areaMm2: number }> = [];
  let signedVolumeMm3 = 0;
  const bounds = {
    min: { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY },
    max: { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY }
  };

  for (let offset = 0; offset < triangleVertexCount; offset += 3) {
    const vertexIndices = [0, 1, 2].map((corner) => {
      const value = indices ? Number(indices[offset + corner]) : offset + corner;
      if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
        throw new Error('打印方向分析发现无效三角面索引');
      }
      return value;
    });
    const points = vertexIndices.map((vertexIndex) => readPoint(positions, vertexIndex, uniformScale)) as [Vec3, Vec3, Vec3];
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))) {
      throw new Error('打印方向分析发现非有限毫米坐标');
    }
    points.forEach((point) => {
      bounds.min.x = Math.min(bounds.min.x, point.x);
      bounds.min.y = Math.min(bounds.min.y, point.y);
      bounds.min.z = Math.min(bounds.min.z, point.z);
      bounds.max.x = Math.max(bounds.max.x, point.x);
      bounds.max.y = Math.max(bounds.max.y, point.y);
      bounds.max.z = Math.max(bounds.max.z, point.z);
    });
    const crossVector = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
    const areaMm2 = length(crossVector) / 2;
    if (areaMm2 <= MIN_TRIANGLE_AREA_MM2) continue;
    signedVolumeMm3 += dot(points[0], cross(points[1], points[2])) / 6;
    rawTriangles.push({ points, crossVector, areaMm2 });
  }

  if (rawTriangles.length < 4) {
    throw new Error('打印方向分析没有找到足够的非退化三角面');
  }
  const extents = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z
  };
  if (Object.values(extents).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('打印方向分析需要具有三维体积的封闭模型');
  }
  const boundsVolumeMm3 = extents.x * extents.y * extents.z;
  if (Math.abs(signedVolumeMm3) <= Math.max(1, boundsVolumeMm3) * 1e-9) {
    throw new Error('打印方向分析无法确认封闭模型的体积与整体三角面绕序');
  }

  const windingSign = signedVolumeMm3 < 0 ? -1 : 1;
  const triangles: TriangleMetric[] = rawTriangles.map((triangle) => ({
    points: triangle.points,
    areaMm2: triangle.areaMm2,
    normal: scale(triangle.crossVector, windingSign / (triangle.areaMm2 * 2))
  }));
  return {
    triangles,
    bounds,
    extents,
    surfaceAreaMm2: triangles.reduce((sum, triangle) => sum + triangle.areaMm2, 0),
    volumeMm3: Math.abs(signedVolumeMm3)
  };
}

function riskLevel(supportRatio: number, fitsBuildVolume: boolean): PrintOrientationCandidate['riskLevel'] {
  if (!fitsBuildVolume) return '不可用';
  if (supportRatio <= 0.05) return '低';
  if (supportRatio <= 0.2) return '中';
  return '高';
}

/**
 * 对封闭毫米制三角网格比较六个轴向打印姿态。
 * 结果是切片前的只读几何估算，不生成支撑、G-code，也不修改模型变换。
 */
export function evaluateAxisAlignedPrintOrientations(
  input: PrintOrientationMeshInput,
  options: {
    buildVolumeMm?: [number, number, number];
    overhangAngleDeg?: number;
    uniformScale?: number;
  } = {}
): PrintOrientationAnalysis {
  const buildVolumeMm = options.buildVolumeMm ?? DEFAULT_BUILD_VOLUME_MM;
  validateBuildVolume(buildVolumeMm);
  const overhangAngleDeg = options.overhangAngleDeg ?? DEFAULT_OVERHANG_ANGLE_DEG;
  const uniformScale = options.uniformScale ?? 1;
  if (!Number.isFinite(uniformScale) || uniformScale <= 0) {
    throw new Error('打印方向分析的均匀缩放必须是大于 0 的有限值');
  }
  if (!Number.isFinite(overhangAngleDeg) || overhangAngleDeg <= 0 || overhangAngleDeg >= 90) {
    throw new Error('悬垂阈值必须大于 0° 且小于 90°');
  }

  const mesh = collectTriangleMetrics(input, uniformScale);
  const overhangNormalThreshold = -Math.cos(overhangAngleDeg * Math.PI / 180);
  const contactNormalThreshold = -Math.cos(10 * Math.PI / 180);
  const rawCandidates = ORIENTATIONS.map((orientation) => {
    const up = orientationUpVector(orientation);
    const widthMm = mesh.extents[orientation.widthAxis];
    const depthMm = mesh.extents[orientation.depthAxis];
    const heightMm = mesh.extents[orientation.heightAxis];
    const projectedValues = [mesh.bounds.min, mesh.bounds.max].map((point) => dot(point, up));
    const minimumHeightMm = Math.min(...projectedValues);
    const contactToleranceMm = Math.max(0.05, heightMm * 0.0001);
    let contactAreaMm2 = 0;
    let supportAreaMm2 = 0;

    mesh.triangles.forEach((triangle) => {
      const normalDotUp = dot(triangle.normal, up);
      const maximumTriangleHeight = Math.max(...triangle.points.map((point) => dot(point, up)));
      const touchesBuildPlate = maximumTriangleHeight <= minimumHeightMm + contactToleranceMm
        && normalDotUp <= contactNormalThreshold;
      if (touchesBuildPlate) {
        contactAreaMm2 += triangle.areaMm2;
      } else if (normalDotUp < overhangNormalThreshold) {
        supportAreaMm2 += triangle.areaMm2;
      }
    });

    const fitsBuildVolume = widthMm <= buildVolumeMm[0] + 1e-6
      && depthMm <= buildVolumeMm[1] + 1e-6
      && heightMm <= buildVolumeMm[2] + 1e-6;
    const supportRatio = mesh.surfaceAreaMm2 > 0 ? supportAreaMm2 / mesh.surfaceAreaMm2 : 0;
    return {
      id: orientation.id,
      label: orientation.label,
      upAxis: orientation.upAxis,
      upSign: orientation.upSign,
      widthMm,
      depthMm,
      heightMm,
      fitsBuildVolume,
      contactAreaMm2,
      supportAreaMm2,
      supportRatio,
      score: null,
      riskLevel: riskLevel(supportRatio, fitsBuildVolume)
    } satisfies PrintOrientationCandidate;
  });

  const printableCandidates = rawCandidates.filter((candidate) => candidate.fitsBuildVolume);
  const maximumContactAreaMm2 = Math.max(0, ...printableCandidates.map((candidate) => candidate.contactAreaMm2));
  const candidates = rawCandidates.map((candidate) => {
    if (!candidate.fitsBuildVolume) return candidate;
    const supportPenalty = candidate.supportRatio * 70;
    const heightPenalty = candidate.heightMm / buildVolumeMm[2] * 20;
    const contactPenalty = maximumContactAreaMm2 > 0
      ? (1 - candidate.contactAreaMm2 / maximumContactAreaMm2) * 10
      : 10;
    return { ...candidate, score: supportPenalty + heightPenalty + contactPenalty };
  });
  const recommended = candidates
    .filter((candidate) => candidate.score !== null)
    .sort((left, right) => (
      left.score! - right.score!
      || left.supportAreaMm2 - right.supportAreaMm2
      || right.contactAreaMm2 - left.contactAreaMm2
      || left.heightMm - right.heightMm
      || ORIENTATIONS.findIndex((orientation) => orientation.id === left.id)
        - ORIENTATIONS.findIndex((orientation) => orientation.id === right.id)
    ))[0] ?? null;

  return {
    triangleCount: mesh.triangles.length,
    surfaceAreaMm2: mesh.surfaceAreaMm2,
    volumeMm3: mesh.volumeMm3,
    buildVolumeMm,
    overhangAngleDeg,
    uniformScale,
    recommendedId: recommended?.id ?? null,
    recommendedReason: recommended
      ? `${recommended.label}：需要支撑的悬垂面积约 ${recommended.supportAreaMm2.toFixed(2)} 平方毫米（${(recommended.supportRatio * 100).toFixed(1)}%），底面接触约 ${recommended.contactAreaMm2.toFixed(2)} 平方毫米，打印高度 ${recommended.heightMm.toFixed(2)} 毫米。`
      : `六个轴向候选均超出 ${buildVolumeMm.join(' × ')} 毫米成型空间，建议先拆件或缩小模型。`,
    candidates
  };
}


/** 返回六个轴向朝上候选在 Three.js XYZ 欧拉角语义下的绝对对象旋转。 */
export function getPrintOrientationRotationDeg(id: PrintOrientationId): ObjectVector3 {
  return { ...PRINT_ORIENTATION_ROTATIONS_DEG[id] };
}

function normalizedAngleDeg(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function equivalentAngleDeg(left: number, right: number) {
  const difference = Math.abs(normalizedAngleDeg(left) - normalizedAngleDeg(right));
  return Math.min(difference, 360 - difference) <= ROTATION_EQUIVALENCE_TOLERANCE_DEG;
}

/** 按 360° 模等价判断当前对象是否已经应用指定打印方向，防止重复累计旋转。 */
export function isPrintOrientationRotationApplied(
  rotationDeg: ObjectVector3,
  id: PrintOrientationId
) {
  const target = PRINT_ORIENTATION_ROTATIONS_DEG[id];
  return (['x', 'y', 'z'] as const).every((axis) => (
    Number.isFinite(rotationDeg[axis]) && equivalentAngleDeg(rotationDeg[axis], target[axis])
  ));
}

/** 只替换对象旋转，完整保留当前毫米位置、均匀缩放和颜色。 */
export function createPrintOrientationPresentation(
  current: Partial<ObjectPresentation> | undefined,
  id: PrintOrientationId,
  fallbackColor = '#d9d4c8'
): ObjectPresentation {
  const normalized = normalizeObjectPresentation(current, fallbackColor);
  return {
    ...normalized,
    transform: {
      ...normalized.transform,
      rotationDeg: getPrintOrientationRotationDeg(id)
    }
  };
}

function validatePlacementVector(value: ObjectVector3, message: string) {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new Error(message);
  }
}

interface DisplayBounds {
  minimum: ObjectVector3;
  maximum: ObjectVector3;
}

/** 按视口真实层级变换全部 STL 顶点，统一供落床和平台边界计算复用。 */
function evaluateTransformedDisplayBounds(
  input: PrintOrientationMeshInput,
  options: PrintBedPlacementOptions
): DisplayBounds {
  const positions = input.positions;
  if (positions.length < 3 || positions.length % 3 !== 0) {
    throw new Error('打印平台分析至少需要一个完整的三维顶点');
  }
  const uniformScale = options.uniformScale ?? 1;
  if (!Number.isFinite(uniformScale) || uniformScale <= 0) {
    throw new Error('打印平台分析的均匀缩放必须是大于 0 的有限值');
  }
  validatePlacementVector(options.rotationDeg, '打印平台分析旋转必须是三个有限角度值');
  validatePlacementVector(options.positionMm, '打印平台分析位置必须是三个有限毫米值');
  const basePosition = options.basePositionDisplayMm ?? { x: 0, y: 0, z: 0 };
  validatePlacementVector(basePosition, '打印平台分析基础位置必须是三个有限毫米值');
  if (options.normalizationSpace !== 'object-local' && options.normalizationSpace !== 'world') {
    throw new Error('打印平台分析归一化空间无效');
  }

  const displayPoints: ObjectVector3[] = [];
  const sourceMinimum = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const sourceMaximum = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  for (let offset = 0; offset < positions.length; offset += 3) {
    const sourcePoint = {
      x: Number(positions[offset]),
      y: Number(positions[offset + 1]),
      z: Number(positions[offset + 2])
    };
    validatePlacementVector(sourcePoint, '打印平台分析网格坐标必须是有限毫米值');
    const displayPoint = sourceToDisplayPoint(sourcePoint);
    displayPoints.push(displayPoint);
    (['x', 'y', 'z'] as const).forEach((axis) => {
      sourceMinimum[axis] = Math.min(sourceMinimum[axis], displayPoint[axis]);
      sourceMaximum[axis] = Math.max(sourceMaximum[axis], displayPoint[axis]);
    });
  }

  const normalizationOffset = {
    x: -(sourceMinimum.x + sourceMaximum.x) / 2,
    y: -sourceMinimum.y,
    z: -(sourceMinimum.z + sourceMaximum.z) / 2
  };
  const minimum = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const maximum = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  displayPoints.forEach((displayPoint) => {
    const localPoint = options.normalizationSpace === 'object-local'
      ? {
          x: displayPoint.x + normalizationOffset.x,
          y: displayPoint.y + normalizationOffset.y,
          z: displayPoint.z + normalizationOffset.z
        }
      : displayPoint;
    const rotated = rotateDisplayPointXyz({
      x: localPoint.x * uniformScale,
      y: localPoint.y * uniformScale,
      z: localPoint.z * uniformScale
    }, options.rotationDeg);
    const outsideNormalization = options.normalizationSpace === 'world'
      ? normalizationOffset
      : { x: 0, y: 0, z: 0 };
    const transformed = {
      x: rotated.x + options.positionMm.x + basePosition.x + outsideNormalization.x,
      y: rotated.y + options.positionMm.y + basePosition.y + outsideNormalization.y,
      z: rotated.z + options.positionMm.z + basePosition.z + outsideNormalization.z
    };
    (['x', 'y', 'z'] as const).forEach((axis) => {
      minimum[axis] = Math.min(minimum[axis], transformed[axis]);
      maximum[axis] = Math.max(maximum[axis], transformed[axis]);
    });
  });
  return { minimum, maximum };
}

/**
 * 按视口真实层级计算当前对象最低点：STL 原始 Z 轴先转为 Three.js Y 轴，
 * 再区分 CAD 的对象内归一化与上传 STL 的对象外归一化。
 */
export function evaluatePrintBedPlacement(
  input: PrintOrientationMeshInput,
  options: PrintBedPlacementOptions
): PrintBedPlacementPreview {
  let bounds: DisplayBounds;
  try {
    bounds = evaluateTransformedDisplayBounds(input, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    throw new Error(message
      .replace('打印平台分析至少', '自动落床至少')
      .replace('打印平台分析的均匀缩放', '自动落床的均匀缩放')
      .replace('打印平台分析旋转', '自动落床旋转')
      .replace('打印平台分析位置', '自动落床位置')
      .replace('打印平台分析基础位置', '自动落床基础位置')
      .replace('打印平台分析网格坐标', '自动落床网格坐标')
      .replace('打印平台分析归一化空间', '自动落床归一化空间'));
  }
  const minimumHeightMm = bounds.minimum.y;
  const requiredVerticalDeltaMm = -minimumHeightMm;
  return {
    minimumHeightMm,
    currentVerticalPositionMm: options.positionMm.y,
    requiredVerticalDeltaMm,
    targetVerticalPositionMm: options.positionMm.y + requiredVerticalDeltaMm,
    alreadyOnBed: Math.abs(minimumHeightMm) <= BED_PLACEMENT_TOLERANCE_MM
  };
}

/** 计算当前对象相对居中打印平台的 X/Z 边界、四边余量、越界量和只读居中建议。 */
export function evaluatePrintPlatformBoundary(
  input: PrintOrientationMeshInput,
  options: PrintPlatformBoundaryOptions
): PrintPlatformBoundaryPreview {
  const platformSizeMm = options.platformSizeMm ?? [DEFAULT_BUILD_VOLUME_MM[0], DEFAULT_BUILD_VOLUME_MM[1]];
  if (platformSizeMm.length !== 2 || platformSizeMm.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('打印平台尺寸必须是两个大于 0 的有限毫米值');
  }
  const bounds = evaluateTransformedDisplayBounds(input, options);
  const platformBoundsMm = {
    minimumX: -platformSizeMm[0] / 2,
    maximumX: platformSizeMm[0] / 2,
    minimumZ: -platformSizeMm[1] / 2,
    maximumZ: platformSizeMm[1] / 2
  };
  const marginsMm = {
    left: bounds.minimum.x - platformBoundsMm.minimumX,
    right: platformBoundsMm.maximumX - bounds.maximum.x,
    front: platformBoundsMm.maximumZ - bounds.maximum.z,
    back: bounds.minimum.z - platformBoundsMm.minimumZ
  };
  const overflowMm = {
    left: Math.max(0, -marginsMm.left),
    right: Math.max(0, -marginsMm.right),
    front: Math.max(0, -marginsMm.front),
    back: Math.max(0, -marginsMm.back)
  };
  const centerDeltaMm = {
    x: -(bounds.minimum.x + bounds.maximum.x) / 2,
    z: -(bounds.minimum.z + bounds.maximum.z) / 2
  };
  const minimumMarginMm = Math.min(...Object.values(marginsMm));
  return {
    boundsMm: {
      minimumX: bounds.minimum.x,
      maximumX: bounds.maximum.x,
      minimumZ: bounds.minimum.z,
      maximumZ: bounds.maximum.z,
      width: bounds.maximum.x - bounds.minimum.x,
      depth: bounds.maximum.z - bounds.minimum.z
    },
    platformBoundsMm,
    marginsMm,
    overflowMm,
    fitsPlatform: minimumMarginMm >= -PLATFORM_BOUNDARY_TOLERANCE_MM,
    minimumMarginMm,
    centerDeltaMm,
    targetHorizontalPositionMm: {
      x: options.positionMm.x + centerDeltaMm.x,
      z: options.positionMm.z + centerDeltaMm.z
    },
    alreadyCentered: Math.abs(centerDeltaMm.x) <= PLATFORM_BOUNDARY_TOLERANCE_MM
      && Math.abs(centerDeltaMm.z) <= PLATFORM_BOUNDARY_TOLERANCE_MM
  };
}

/** 在物理平台内缩安全边距，计算单个对象相对有效可打印区域的余量和最小修正量。 */
export function evaluatePrintPlatformSafetyArea(
  preview: PrintPlatformBoundaryPreview,
  safetyMarginMm: number
): PrintPlatformSafetyAreaPreview {
  const platformWidth = preview.platformBoundsMm.maximumX - preview.platformBoundsMm.minimumX;
  const platformDepth = preview.platformBoundsMm.maximumZ - preview.platformBoundsMm.minimumZ;
  if (!Number.isFinite(safetyMarginMm) || safetyMarginMm < 0) {
    throw new Error('平台安全边距必须是大于或等于 0 的有限毫米值');
  }
  if (safetyMarginMm * 2 >= platformWidth || safetyMarginMm * 2 >= platformDepth) {
    throw new Error('平台安全边距过大，必须保留大于 0 的有效可打印区域');
  }

  const effectivePlatformBoundsMm = {
    minimumX: preview.platformBoundsMm.minimumX + safetyMarginMm,
    maximumX: preview.platformBoundsMm.maximumX - safetyMarginMm,
    minimumZ: preview.platformBoundsMm.minimumZ + safetyMarginMm,
    maximumZ: preview.platformBoundsMm.maximumZ - safetyMarginMm,
    width: platformWidth - safetyMarginMm * 2,
    depth: platformDepth - safetyMarginMm * 2
  };
  const marginsMm = {
    left: preview.boundsMm.minimumX - effectivePlatformBoundsMm.minimumX,
    right: effectivePlatformBoundsMm.maximumX - preview.boundsMm.maximumX,
    front: effectivePlatformBoundsMm.maximumZ - preview.boundsMm.maximumZ,
    back: preview.boundsMm.minimumZ - effectivePlatformBoundsMm.minimumZ
  };
  const overflowMm = {
    left: Math.max(0, -marginsMm.left),
    right: Math.max(0, -marginsMm.right),
    front: Math.max(0, -marginsMm.front),
    back: Math.max(0, -marginsMm.back)
  };
  const canFitEffectiveArea = preview.boundsMm.width <= effectivePlatformBoundsMm.width + PLATFORM_BOUNDARY_TOLERANCE_MM
    && preview.boundsMm.depth <= effectivePlatformBoundsMm.depth + PLATFORM_BOUNDARY_TOLERANCE_MM;

  function minimumAxisCorrection(
    objectMinimum: number,
    objectMaximum: number,
    areaMinimum: number,
    areaMaximum: number
  ) {
    if (objectMinimum >= areaMinimum - PLATFORM_BOUNDARY_TOLERANCE_MM
      && objectMaximum <= areaMaximum + PLATFORM_BOUNDARY_TOLERANCE_MM) return 0;
    if (objectMinimum < areaMinimum && objectMaximum <= areaMaximum) return areaMinimum - objectMinimum;
    if (objectMaximum > areaMaximum && objectMinimum >= areaMinimum) return areaMaximum - objectMaximum;
    return (areaMinimum + areaMaximum - objectMinimum - objectMaximum) / 2;
  }

  const minimumMarginMm = Math.min(...Object.values(marginsMm));
  return {
    safetyMarginMm,
    effectivePlatformBoundsMm,
    marginsMm,
    overflowMm,
    fitsEffectiveArea: minimumMarginMm >= -PLATFORM_BOUNDARY_TOLERANCE_MM,
    canFitEffectiveArea,
    minimumMarginMm,
    correctionDeltaMm: {
      x: minimumAxisCorrection(
        preview.boundsMm.minimumX,
        preview.boundsMm.maximumX,
        effectivePlatformBoundsMm.minimumX,
        effectivePlatformBoundsMm.maximumX
      ),
      z: minimumAxisCorrection(
        preview.boundsMm.minimumZ,
        preview.boundsMm.maximumZ,
        effectivePlatformBoundsMm.minimumZ,
        effectivePlatformBoundsMm.maximumZ
      )
    }
  };
}

/** 只修改视口垂直位置，使当前最低点落到平台 0 毫米。 */
export function createPrintBedPlacementPresentation(
  current: Partial<ObjectPresentation> | undefined,
  preview: PrintBedPlacementPreview,
  fallbackColor = '#d9d4c8'
): ObjectPresentation {
  if (!Number.isFinite(preview.targetVerticalPositionMm)) {
    throw new Error('自动落床目标位置不是有限毫米值');
  }
  const normalized = normalizeObjectPresentation(current, fallbackColor);
  return {
    ...normalized,
    transform: {
      ...normalized.transform,
      positionMm: {
        ...normalized.transform.positionMm,
        y: preview.targetVerticalPositionMm
      }
    }
  };
}

/** 只修改视口水平 X/Z 位置，使当前对象的包围范围中心对齐打印平台中心。 */
export function createPrintPlatformCenterPresentation(
  current: Partial<ObjectPresentation> | undefined,
  preview: PrintPlatformBoundaryPreview,
  fallbackColor = '#d9d4c8'
): ObjectPresentation {
  const target = preview.targetHorizontalPositionMm;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
    throw new Error('打印平台居中目标位置必须是两个有限毫米值');
  }
  const normalized = normalizeObjectPresentation(current, fallbackColor);
  return {
    ...normalized,
    transform: {
      ...normalized.transform,
      positionMm: {
        ...normalized.transform.positionMm,
        x: target.x,
        z: target.z
      }
    }
  };
}
