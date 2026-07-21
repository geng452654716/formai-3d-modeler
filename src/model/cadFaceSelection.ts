import type {
  CadFaceDescriptor,
  CadEdgeDescriptor,
  CadFaceTessellationMapping,
  CadGenerationResult,
  CadPartDescriptor
} from './cad';
import type { EnclosureParameters } from './types';

export type CadFaceSelectionMode = 'off' | 'click' | 'edge' | 'box';

export interface CadSelectionVector {
  x: number;
  y: number;
  z: number;
}

export interface CadSurfaceUv {
  u: number;
  v: number;
}

export interface CadSurfaceUvBounds {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface CadSelectedFace {
  partId: string;
  partLabel: string;
  stableId: string;
  geometryType: string;
  areaMm2: number;
  centerMm: [number, number, number];
  normal?: [number, number, number];
}

export interface CadFaceSelectionHit {
  partId: string;
  stableId: string;
  stableEdgeId?: string | null;
  triangleIndex: number;
  pointMm: CadSelectionVector;
  normal: CadSelectionVector;
  /** 选择网格最初命中的毫米坐标，精确解析后仍保留用于诊断。 */
  meshPointMm: CadSelectionVector;
  /** 选择网格三角面的法线，精确解析后仍保留用于一致性复核。 */
  meshNormal: CadSelectionVector;
  surfaceUv: CadSurfaceUv | null;
  uvBounds: CadSurfaceUvBounds | null;
  precision: 'mesh' | 'opencascade';
  resolutionStatus: 'resolving' | 'resolved' | 'failed';
  pointDistanceMm: number | null;
  normalDot: number | null;
  resolutionError: string | null;
}

export interface CadSelectedEdge {
  partId: string;
  partLabel: string;
  stableFaceId: string;
  stableEdgeId: string;
  geometryType: string;
  lengthMm: number;
  centerMm: [number, number, number];
  samplePointsMm: Array<[number, number, number]>;
}

export interface CadSelectionCameraContext {
  positionMm: CadSelectionVector;
  projectionMatrix: number[];
  viewMatrix: number[];
  viewportPixels: { width: number; height: number };
}

export interface CadSelectionScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  crop: { x: number; y: number; width: number; height: number };
}

export interface CadFaceSelectionContext {
  protocol: 'FormAI-CAD-局部编辑上下文';
  protocolVersion: 1;
  sourceKind: 'cad-face';
  selectionMode: Exclude<CadFaceSelectionMode, 'off'>;
  revision: string;
  units: 'mm';
  partBoundsMm: Record<string, { x: number; y: number; z: number }>;
  faces: CadSelectedFace[];
  edge?: CadSelectedEdge | null;
  hit: CadFaceSelectionHit | null;
  camera: CadSelectionCameraContext;
  screenshot: CadSelectionScreenshot | null;
  parameters: EnclosureParameters;
  printer: CadGenerationResult['printer'];
  warning: string;
}

export interface CadSelectionPoint2 {
  x: number;
  y: number;
}

export interface CadSelectionRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CadFaceBoxSelectionRequest {
  id: number;
  /** WebGL 画布客户区中的归一化坐标，范围均为 0–1。 */
  rectangle: CadSelectionRectangle;
  screenshot: CadSelectionScreenshot | null;
}


function pointInsideRectangle(point: CadSelectionPoint2, rectangle: CadSelectionRectangle) {
  return point.x >= rectangle.left
    && point.x <= rectangle.right
    && point.y >= rectangle.top
    && point.y <= rectangle.bottom;
}

function signedTriangleArea(
  a: CadSelectionPoint2,
  b: CadSelectionPoint2,
  c: CadSelectionPoint2
) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInsideTriangle(point: CadSelectionPoint2, triangle: CadSelectionPoint2[]) {
  const [a, b, c] = triangle;
  const first = signedTriangleArea(a, b, point);
  const second = signedTriangleArea(b, c, point);
  const third = signedTriangleArea(c, a, point);
  const hasNegative = first < -1e-9 || second < -1e-9 || third < -1e-9;
  const hasPositive = first > 1e-9 || second > 1e-9 || third > 1e-9;
  return !(hasNegative && hasPositive);
}

function segmentIntersection(
  a: CadSelectionPoint2,
  b: CadSelectionPoint2,
  c: CadSelectionPoint2,
  d: CadSelectionPoint2
): CadSelectionPoint2 | null {
  const denominator = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(denominator) < 1e-9) return null;
  const first = a.x * b.y - a.y * b.x;
  const second = c.x * d.y - c.y * d.x;
  const x = (first * (c.x - d.x) - (a.x - b.x) * second) / denominator;
  const y = (first * (c.y - d.y) - (a.y - b.y) * second) / denominator;
  const inside = (value: number, start: number, end: number) =>
    value >= Math.min(start, end) - 1e-9 && value <= Math.max(start, end) + 1e-9;
  return inside(x, a.x, b.x)
    && inside(y, a.y, b.y)
    && inside(x, c.x, d.x)
    && inside(y, c.y, d.y)
    ? { x, y }
    : null;
}

/**
 * 返回屏幕空间三角形与框选矩形重叠区域中的代表采样点。
 * 第一版不仅检查三角面中心，还覆盖顶点落入、矩形角落落入和边界相交。
 */
export function cadTriangleRectangleSamples(
  triangle: CadSelectionPoint2[],
  rectangle: CadSelectionRectangle,
  maximumSamples = 5
) {
  if (triangle.length !== 3 || maximumSamples <= 0) return [];
  const rectangleCorners: CadSelectionPoint2[] = [
    { x: rectangle.left, y: rectangle.top },
    { x: rectangle.right, y: rectangle.top },
    { x: rectangle.right, y: rectangle.bottom },
    { x: rectangle.left, y: rectangle.bottom }
  ];
  const samples: CadSelectionPoint2[] = [];
  const add = (point: CadSelectionPoint2) => {
    if (!pointInsideRectangle(point, rectangle)) return;
    if (samples.some((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) < 1e-7)) return;
    samples.push(point);
  };

  const center = {
    x: (triangle[0].x + triangle[1].x + triangle[2].x) / 3,
    y: (triangle[0].y + triangle[1].y + triangle[2].y) / 3
  };
  add(center);
  triangle.forEach(add);
  rectangleCorners.filter((corner) => pointInsideTriangle(corner, triangle)).forEach(add);

  const triangleEdges: Array<[CadSelectionPoint2, CadSelectionPoint2]> = [
    [triangle[0], triangle[1]],
    [triangle[1], triangle[2]],
    [triangle[2], triangle[0]]
  ];
  const rectangleEdges: Array<[CadSelectionPoint2, CadSelectionPoint2]> = [
    [rectangleCorners[0], rectangleCorners[1]],
    [rectangleCorners[1], rectangleCorners[2]],
    [rectangleCorners[2], rectangleCorners[3]],
    [rectangleCorners[3], rectangleCorners[0]]
  ];
  triangleEdges.forEach(([start, end]) => {
    rectangleEdges.forEach(([rectangleStart, rectangleEnd]) => {
      const intersection = segmentIntersection(start, end, rectangleStart, rectangleEnd);
      if (intersection) add(intersection);
    });
  });

  return samples.slice(0, maximumSamples);
}

export const CAD_FACE_SELECTION_WARNING =
  '稳定面和面内稳定边 ID 来自几何签名匹配第一版；大幅拓扑变化、对称面或布尔重建仍可能重新编号。三角面索引只对本次生成的选择网格有效。';

function pointSegmentDistance(point: CadSelectionVector, start: number[], end: number[]) {
  const ab = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const ap = [point.x - start[0], point.y - start[1], point.z - start[2]];
  const lengthSquared = ab.reduce((sum, value) => sum + value * value, 0);
  const parameter = lengthSquared > 1e-12
    ? Math.max(0, Math.min(1, ap.reduce((sum, value, index) => sum + value * ab[index], 0) / lengthSquared))
    : 0;
  return Math.hypot(
    point.x - (start[0] + ab[0] * parameter),
    point.y - (start[1] + ab[1] * parameter),
    point.z - (start[2] + ab[2] * parameter)
  );
}

/** 用面内边采样折线识别离点击位置最近的稳定边，Worker 仍会用 OpenCascade 精确复核。 */
export function findNearestCadEdge(edges: CadEdgeDescriptor[] | undefined, point: CadSelectionVector) {
  if (!edges?.length) return null;
  return edges.reduce<{ edge: CadEdgeDescriptor; distanceMm: number } | null>((nearest, edge) => {
    const samples = edge.samplePointsMm?.length >= 2 ? edge.samplePointsMm : [edge.startMm, edge.endMm];
    let distanceMm = Number.POSITIVE_INFINITY;
    for (let index = 1; index < samples.length; index += 1) {
      distanceMm = Math.min(distanceMm, pointSegmentDistance(point, samples[index - 1], samples[index]));
    }
    return !nearest || distanceMm < nearest.distanceMm ? { edge, distanceMm } : nearest;
  }, null);
}

export function findCadFaceRangeByTriangleIndex(
  mapping: CadFaceTessellationMapping | undefined,
  triangleIndex: number | null | undefined
) {
  if (!mapping || typeof triangleIndex !== 'number' || !Number.isInteger(triangleIndex) || triangleIndex < 0) {
    return null;
  }
  let left = 0;
  let right = mapping.faces.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const candidate = mapping.faces[middle];
    if (triangleIndex < candidate.triangleStart) {
      right = middle - 1;
    } else if (triangleIndex >= candidate.triangleStart + candidate.triangleCount) {
      left = middle + 1;
    } else {
      return candidate;
    }
  }
  return null;
}

export function cadSelectedFaceFromDescriptor(
  part: CadPartDescriptor,
  descriptor: Pick<CadFaceDescriptor, 'stableId' | 'geometryType' | 'areaMm2' | 'centerMm' | 'normal'>
): CadSelectedFace {
  return {
    partId: part.id,
    partLabel: part.label,
    stableId: descriptor.stableId,
    geometryType: descriptor.geometryType,
    areaMm2: descriptor.areaMm2,
    centerMm: descriptor.centerMm,
    ...(descriptor.normal ? { normal: descriptor.normal } : {})
  };
}

export function buildCadFaceSelectionCommandContext(selection: CadFaceSelectionContext) {
  const faceList = selection.faces.map((face) =>
    `${face.partLabel}/${face.stableId}(${face.geometryType}，面积 ${face.areaMm2.toFixed(3)} 平方毫米)`
  ).join('、');
  const hitText = selection.hit
    ? selection.hit.resolutionStatus === 'resolved' && selection.hit.surfaceUv
      ? `OpenCascade 精确命中坐标=(${selection.hit.pointMm.x.toFixed(3)}, ${selection.hit.pointMm.y.toFixed(3)}, ${selection.hit.pointMm.z.toFixed(3)}) 毫米；真实外法向=(${selection.hit.normal.x.toFixed(6)}, ${selection.hit.normal.y.toFixed(6)}, ${selection.hit.normal.z.toFixed(6)})；曲面 UV=(${selection.hit.surfaceUv.u.toFixed(9)}, ${selection.hit.surfaceUv.v.toFixed(9)})；选择网格投影距离=${selection.hit.pointDistanceMm?.toFixed(6) ?? '未知'} 毫米；法线点积=${selection.hit.normalDot?.toFixed(6) ?? '未知'}；${selection.edge ? `稳定边=${selection.edge.stableEdgeId}(${selection.edge.geometryType}，长度 ${selection.edge.lengthMm.toFixed(3)} 毫米)；` : ''}本次选择网格三角面索引=${selection.hit.triangleIndex}`
      : `当前仅有选择网格预览坐标=(${selection.hit.meshPointMm.x.toFixed(3)}, ${selection.hit.meshPointMm.y.toFixed(3)}, ${selection.hit.meshPointMm.z.toFixed(3)}) 毫米；网格法线=(${selection.hit.meshNormal.x.toFixed(6)}, ${selection.hit.meshNormal.y.toFixed(6)}, ${selection.hit.meshNormal.z.toFixed(6)})；精确解析状态=${selection.hit.resolutionStatus === 'resolving' ? '解析中' : `失败：${selection.hit.resolutionError ?? '未知错误'}`}；不得把网格坐标、网格法线或三角面索引冒充 OpenCascade 精确值；本次选择网格三角面索引=${selection.hit.triangleIndex}`
    : '框选模式没有唯一命中点，请以所列稳定面及其中心、法线作为局部范围。';
  const bounds = Object.entries(selection.partBoundsMm)
    .map(([partId, value]) => `${partId}=(${value.x.toFixed(3)}, ${value.y.toFixed(3)}, ${value.z.toFixed(3)}) 毫米`)
    .join('、');
  return [
    `局部编辑协议=${selection.protocol} v${selection.protocolVersion}`,
    `选择方式=${selection.selectionMode === 'click' ? '点击单面' : selection.selectionMode === 'edge' ? '点击单边' : '框选多面'}`,
    `模型修订=${selection.revision}`,
    `稳定面=${faceList}`,
    hitText,
    `相关零件包围盒=${bounds}`,
    `截图=${selection.screenshot ? '已随指令附加局部截图' : '未附加截图'}`,
    selection.warning,
    '只修改用户指定的局部区域；如果当前参数化特征无法表达，必须明确说明需要新增的通用 CAD 特征，不得猜测或修改无关区域。'
  ].join('；');
}

export function screenshotDataUrlToBytes(screenshot: CadSelectionScreenshot | null) {
  if (!screenshot?.dataUrl.startsWith('data:image/png;base64,')) return null;
  const binary = atob(screenshot.dataUrl.slice('data:image/png;base64,'.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return Array.from(bytes);
}
