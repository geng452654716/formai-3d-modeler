import { normalizeObjectPresentation, type ObjectPresentation, type ObjectVector3 } from './objectTransform';

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
