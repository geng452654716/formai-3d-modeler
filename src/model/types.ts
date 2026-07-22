import type { ObjectPresentationMap } from './objectTransform';

export type SceneObjectId = string;

export type InterfaceOpeningShape = 'circle' | 'rectangle' | 'rounded-rectangle' | 'slot';
export type InterfaceOpeningFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export type InterfaceOpeningPositionReference = 'face-center-bottom';

export interface InterfaceOpeningSpec {
  id: string;
  label: string;
  sourceType: string;
  face: InterfaceOpeningFace;
  shape: InterfaceOpeningShape;
  widthMm: number;
  heightMm: number;
  /** 面内水平方向坐标；以接口面中心为 0，单位为毫米。 */
  centerUMm: number;
  /** 面内竖直方向坐标；以接口面中心为 0，单位为毫米。 */
  centerVMm: number;
  /** 照片定位来源。存在时，外壳尺寸变化会根据毫米锚点重新计算中心坐标。 */
  positionReference?: InterfaceOpeningPositionReference;
  /** 相对接口面水平中心的毫米偏移。 */
  horizontalOffsetMm?: number;
  /** 相对接口面底边的毫米偏移。 */
  bottomOffsetMm?: number;
  cornerRadiusMm: number;
  minimumEdgeMarginMm: number;
  minimumSpacingMm: number;
  sourceConfidence: number;
}

export interface EnclosureParameters {
  boardLength: number;
  boardWidth: number;
  boardThickness: number;
  boardComponentHeight: number;
  clearanceXY: number;
  clearanceZ: number;
  wallThickness: number;
  baseThickness: number;
  lidThickness: number;
  cornerRadius: number;
  edgeChamfer: number;
  usbPortWidth: number;
  usbPortHeight: number;
  usbPortBottom: number;
  /** 模板 USB 开孔相对接口面水平中心的毫米偏移。 */
  usbPortOffsetY: number;
  boardOffsetX: number;
  boardOffsetZ: number;
}

export interface CurvedFeatureDiagnostics {
  maximumAbsCurvaturePerMm: number | null;
  minimumCurvatureRadiusMm: number | null;
  curvatureRatio: number | null;
  localWallThicknessMm: number | null;
  remainingWallMm: number | null;
  throughCut: boolean;
  interferenceCheckPassed: boolean | null;
  selfIntersectionDetected: boolean | null;
  adjacentFaceInterferenceDetected: boolean | null;
  interferingFaceCount: number;
  interferingStableFaceIds: string[];
  minimumInterferenceDistanceMm: number | null;
  contactFaceCount: number;
  contactSampleCount: number;
}

export interface VersionCurvedFeature {
  /** 创建修订与零件、操作共同组成的跨参数化重放稳定标识。 */
  id: string;
  operation: 'add-cylinder' | 'cut-cylinder' | 'add-rectangle' | 'cut-rectangle' | 'cut-slot';
  partId: string;
  stableFaceId: string;
  surfaceGeometryType: string;
  radiusMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  lengthMm: number | null;
  rotationDeg: number;
  /** 当前修订中用于解释矩形或槽孔零度方向的 OpenCascade 真实 U 切向。 */
  surfaceTangentU: { x: number; y: number; z: number } | null;
  depthMm: number;
  command: string;
  diagnostics: CurvedFeatureDiagnostics;
}

export interface ModelVersion {
  id: string;
  label: string;
  createdAt: string;
  /** 用于区分几何版本与仅改变视口显示的版本，避免撤销显示变换时错误重建 CAD。 */
  changeKind?: 'geometry' | 'presentation';
  parameters: EnclosureParameters;
  interfaceOpenings?: InterfaceOpeningSpec[] | null;
  /** 该版本中所有稳定对象的用户移动、旋转、均匀缩放与颜色快照。 */
  objectPresentations?: ObjectPresentationMap;
  /** 该版本中非平面受限局部特征的尺寸、曲率、壁厚与干涉诊断快照。 */
  curvedFeatures?: VersionCurvedFeature[];
  /** 版本对应的几何来源；旧项目缺省按参数化 CAD 处理。 */
  modelSource?: 'cad' | 'uploaded-stl';
  /** 上传模型版本绑定的不可变修订号。 */
  importedModelRevision?: string;
  /** CAD 主分支派生出的受管网格分支来源，用于历史列表和安全返回原 CAD。 */
  meshBranchSource?: { cadRevision: string; partId: string; partLabel: string };
  /** 桌面端受管目录中保存的精确 CAD 或上传模型工作文件快照。 */
  snapshotDirectory?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface CommandResult {
  parameters: Partial<EnclosureParameters>;
  summary: string;
}
