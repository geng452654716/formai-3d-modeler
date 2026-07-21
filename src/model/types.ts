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

export interface ModelVersion {
  id: string;
  label: string;
  createdAt: string;
  parameters: EnclosureParameters;
  interfaceOpenings?: InterfaceOpeningSpec[] | null;
  /** Desktop snapshot directory containing the exact generated artifacts for this version. */
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
