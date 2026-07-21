import {
  normalizeObjectPresentation,
  type ObjectPresentation,
  type ObjectTransform,
  type ObjectVector3
} from './objectTransform';

export type TransformedExportFormat = 'stl' | '3mf';

export interface TransformedExportObject {
  id: string;
  name: string;
  sourceFile: string;
  color: string;
  transform: ObjectTransform;
  /** 装配状态中的基础位置；拆分视图的临时展开偏移不得写入导出。 */
  basePositionDisplayMm?: ObjectVector3;
}

export interface TransformedExportRequest {
  outputFileName: string;
  format: TransformedExportFormat;
  objects: TransformedExportObject[];
}

/** 拆件导出必须复用视口中的对象标识，确保 CAD 拆件和上传 STL 拆件都能带上实际变换。 */
export function manufacturingSplitPresentationId(
  sourceKind: 'cad-part' | 'uploaded-stl',
  sourcePartId: string,
  direction: 'negative' | 'positive'
) {
  return sourceKind === 'cad-part' ? sourcePartId : `uploaded-model-${direction}`;
}

export function sourceToDisplayPoint(point: ObjectVector3): ObjectVector3 {
  return { x: point.x, y: point.z, z: -point.y };
}

export function displayToSourcePoint(point: ObjectVector3): ObjectVector3 {
  return { x: point.x, y: -point.z, z: point.y };
}

/** 与 Three.js Euler XYZ 保持一致：列向量依次绕 X、Y、Z 旋转。 */
export function rotateDisplayPointXyz(point: ObjectVector3, rotationDeg: ObjectVector3): ObjectVector3 {
  const factor = Math.PI / 180;
  const x = rotationDeg.x * factor;
  const y = rotationDeg.y * factor;
  const z = rotationDeg.z * factor;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);

  const afterX = { x: point.x, y: point.y * cx - point.z * sx, z: point.y * sx + point.z * cx };
  const afterY = { x: afterX.x * cy + afterX.z * sy, y: afterX.y, z: -afterX.x * sy + afterX.z * cy };
  return {
    x: afterY.x * cz - afterY.y * sz,
    y: afterY.x * sz + afterY.y * cz,
    z: afterY.z
  };
}

/** 把视口中看到的用户变换准确应用到 OpenCascade/STL 原始 Z 向上坐标。 */
export function transformSourcePointForExport(
  sourcePoint: ObjectVector3,
  transform: ObjectTransform,
  basePositionDisplayMm: ObjectVector3 = { x: 0, y: 0, z: 0 }
): ObjectVector3 {
  const display = sourceToDisplayPoint(sourcePoint);
  const scaled = {
    x: display.x * transform.scale,
    y: display.y * transform.scale,
    z: display.z * transform.scale
  };
  const rotated = rotateDisplayPointXyz(scaled, transform.rotationDeg);
  return displayToSourcePoint({
    x: rotated.x + transform.positionMm.x + basePositionDisplayMm.x,
    y: rotated.y + transform.positionMm.y + basePositionDisplayMm.y,
    z: rotated.z + transform.positionMm.z + basePositionDisplayMm.z
  });
}

export function createTransformedExportObject(
  id: string,
  name: string,
  sourceFile: string,
  presentation: Partial<ObjectPresentation> | undefined,
  fallbackColor: string,
  basePositionDisplayMm?: ObjectVector3
): TransformedExportObject {
  const normalized = normalizeObjectPresentation(presentation, fallbackColor);
  return {
    id,
    name,
    sourceFile,
    color: normalized.color,
    transform: normalized.transform,
    ...(basePositionDisplayMm ? { basePositionDisplayMm } : {})
  };
}

export function validateTransformedExportRequest(request: TransformedExportRequest): string | null {
  if (!/^[\w\-.\u4e00-\u9fff]{1,120}\.(stl|3mf)$/i.test(request.outputFileName)) return '导出文件名不合法';
  if (request.format === 'stl' && !request.outputFileName.toLowerCase().endsWith('.stl')) return 'STL 导出必须使用 .stl 扩展名';
  if (request.format === '3mf' && !request.outputFileName.toLowerCase().endsWith('.3mf')) return '3MF 导出必须使用 .3mf 扩展名';
  if (request.objects.length < 1 || request.objects.length > 64) return '导出对象数量必须在 1 到 64 之间';
  if (request.format === 'stl' && request.objects.length !== 1) return 'STL 一次只能导出一个对象';
  for (const object of request.objects) {
    if (!/^[\w\-.]{1,160}\.stl$/i.test(object.sourceFile)) return `对象“${object.name}”的源 STL 文件名不合法`;
    if (!object.id || !object.name) return '导出对象缺少名称或标识';
    const normalized = normalizeObjectPresentation({ transform: object.transform, color: object.color }, object.color);
    if (normalized.color !== object.color.toLowerCase()) return `对象“${object.name}”的颜色不合法`;
  }
  return null;
}
