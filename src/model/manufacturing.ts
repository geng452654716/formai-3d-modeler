import { getOuterDimensions } from './defaults';
import type { EnclosureParameters } from './types';

export type SplitAxis = 'x' | 'y' | 'z';
export type ManufacturingSourceKind = 'cad-part' | 'uploaded-stl';

export type ExactFastenerType =
  | 'none'
  | 'snap-fit'
  | 'screw-boss'
  | 'threaded-hole'
  | 'external-thread'
  | 'iso-threaded-hole'
  | 'iso-external-thread';
export type ScrewSize = 'M2' | 'M2.5' | 'M3';

export interface ManufacturingSplitRequest {
  sourceKind: ManufacturingSourceKind;
  sourcePartId: string;
  axis: SplitAxis;
  offsetMm: number;
  jointType: JointType;
  fastenerType: ExactFastenerType;
  screwSize: ScrewSize;
  clearanceMm: number;
}

export interface ManufacturingSplitValidation {
  axis: SplitAxis;
  offsetMm: number;
  originalVolumeMm3: number;
  negativeVolumeMm3: number;
  positiveVolumeMm3: number;
  volumeErrorMm3: number;
  negativeSolidCount: number;
  positiveSolidCount: number;
  negativeCapFaces: number;
  positiveCapFaces: number;
}

export interface ManufacturingFeaturePlacement {
  label: string;
  role: 'joint' | 'fastener';
  uMm: number;
  vMm: number;
  diameterMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  lengthMm?: number | null;
  pitchMm?: number | null;
  threadStandard?: string | null;
  profileAngleDeg?: number | null;
}

export interface ManufacturingFeatureResult {
  status: 'exact';
  jointType: JointType;
  fastenerType: ExactFastenerType;
  screwSize: ScrewSize;
  clearanceMm: number;
  jointCount: number;
  fastenerCount: number;
  minimumDesignedWallMm: number;
  interferenceVolumeMm3: number;
  negativeFinalVolumeMm3: number;
  positiveFinalVolumeMm3: number;
  placementAxes: [string, string];
  placements: ManufacturingFeaturePlacement[];
}

export interface ManufacturingSplitResult {
  status: 'ok';
  revision: string;
  sourcePartId: string;
  sourceKind: ManufacturingSourceKind;
  sourceFormat: 'step' | 'stl';
  sourceFile: string;
  units: 'mm';
  kernel: string;
  outputs: string[];
  files: Record<string, { bytes: number }>;
  validation: ManufacturingSplitValidation;
  features: ManufacturingFeatureResult;
}

export type SplitStrategy = 'print-volume' | 'support-minimization' | 'manual-plane';
export type JointType = 'round-pin' | 'd-pin' | 'dovetail' | 'ball-socket' | 'magnet';
export type FastenerType =
  | 'snap-fit'
  | 'screw-boss'
  | 'threaded-hole'
  | 'external-thread'
  | 'iso-threaded-hole'
  | 'iso-external-thread';

export interface ManufacturingPlanOptions {
  splitStrategy: SplitStrategy;
  jointType: JointType;
  clearanceMm: number;
  fastenerType: FastenerType;
  screwSize: ScrewSize;
}

export interface ConnectorPlacement {
  label: string;
  xMm: number;
  yMm: number;
  diameterMm: number;
  clearanceMm: number;
}

export interface ManufacturingPlan {
  parts: string[];
  splitDescription: string;
  connectors: ConnectorPlacement[];
  /** 候选连接位显示使用的两个局部平面坐标轴。 */
  connectorAxes: [string, string];
  fastenerDescription: string;
  warnings: string[];
}

export interface ManufacturingPlanContext {
  sourceKind?: ManufacturingSourceKind;
  splitAxis?: SplitAxis;
  boundsMm?: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
}

const jointDiameter: Record<JointType, number> = {
  'round-pin': 4,
  'd-pin': 5,
  dovetail: 6,
  'ball-socket': 7,
  magnet: 6.2
};

/** 为当前参数模型生成确定性的打印拆件、连接和紧固规划。 */
export function createManufacturingPlan(
  parameters: EnclosureParameters,
  options: ManufacturingPlanOptions,
  context: ManufacturingPlanContext = {}
): ManufacturingPlan {
  const dimensions = getOuterDimensions(parameters);
  const uploadedModel = context.sourceKind === 'uploaded-stl' && context.boundsMm;
  const bounds = uploadedModel
    ? {
        x: [context.boundsMm!.minX, context.boundsMm!.maxX] as const,
        y: [context.boundsMm!.minY, context.boundsMm!.maxY] as const,
        z: [context.boundsMm!.minZ, context.boundsMm!.maxZ] as const
      }
    : {
        x: [-dimensions.length / 2, dimensions.length / 2] as const,
        y: [-dimensions.width / 2, dimensions.width / 2] as const,
        z: [0, dimensions.height] as const
      };
  const splitAxis = context.splitAxis ?? 'z';
  const connectorAxes: [keyof typeof bounds, keyof typeof bounds] = splitAxis === 'x'
    ? ['y', 'z']
    : splitAxis === 'y'
      ? ['x', 'z']
      : ['x', 'y'];
  const [firstBounds, secondBounds] = connectorAxes.map((axis) => bounds[axis]) as [readonly [number, number], readonly [number, number]];
  const firstCenter = (firstBounds[0] + firstBounds[1]) / 2;
  const secondCenter = (secondBounds[0] + secondBounds[1]) / 2;
  const firstInset = Math.max(2, (firstBounds[1] - firstBounds[0]) * 0.28);
  const secondInset = Math.max(2, (secondBounds[1] - secondBounds[0]) * 0.28);
  const diameterMm = jointDiameter[options.jointType];
  const connectors: ConnectorPlacement[] = [
    { label: '候选连接位 1', xMm: firstCenter - firstInset, yMm: secondCenter - secondInset, diameterMm, clearanceMm: options.clearanceMm },
    { label: '候选连接位 2', xMm: firstCenter + firstInset, yMm: secondCenter - secondInset, diameterMm, clearanceMm: options.clearanceMm },
    { label: '候选连接位 3', xMm: firstCenter - firstInset, yMm: secondCenter + secondInset, diameterMm, clearanceMm: options.clearanceMm },
    { label: '候选连接位 4', xMm: firstCenter + firstInset, yMm: secondCenter + secondInset, diameterMm, clearanceMm: options.clearanceMm }
  ];

  const splitDescription = uploadedModel
    ? {
        'print-volume': '按 P1S 256 × 256 × 256 毫米成型空间检查当前上传模型，并使用所选平面生成两个通用拆件。',
        'support-minimization': '使用当前切割轴和平面拆分上传模型；可继续调整平面以减少支撑并避开表面细节。',
        'manual-plane': '使用当前手动分型平面拆分上传模型，不假设模型属于外壳、手办或其他固定类别。'
      }[options.splitStrategy]
    : {
        'print-volume': '按 P1S 256 × 256 × 256 毫米成型空间检查当前 CAD 模型并规划两个打印零件。',
        'support-minimization': '优先减少支撑，将当前 CAD 零件沿所选平面拆分。',
        'manual-plane': '使用当前手动分型平面拆分 CAD 零件。'
      }[options.splitStrategy];

  const fastenerDescription = {
    'snap-fit': `精确生成 PLA/PETG 可拆悬臂卡扣、导入斜面和配合槽，并检查设计壁厚、间隙与装配干涉。`,
    'screw-boss': `精确生成 ${options.screwSize} 螺丝柱、通孔和打印友好沉孔，并检查最小设计壁厚。`,
    'threaded-hole': `精确生成 ${options.screwSize} 打印友好近似内螺纹、通孔和沉孔，并检查最小设计壁厚。`,
    'external-thread': `精确生成 ${options.screwSize} 一体式近似外螺纹和带打印补偿的配合内螺纹孔。`,
    'iso-threaded-hole': `精确生成 ${options.screwSize} ISO 公制粗牙 60° 内螺纹、通孔和沉孔，并保留打印装配间隙。`,
    'iso-external-thread': `精确生成 ${options.screwSize} ISO 公制粗牙 60° 外螺纹和同牙型配合内螺纹孔。`
  }[options.fastenerType];

  const warnings: string[] = [];
  if (uploadedModel) warnings.push('界面候选位仅用于预览；精确生成时会根据两侧实体的实际相交体积自动避让并确定可附着位置。');
  if (options.clearanceMm < 0.15) warnings.push('连接间隙小于 0.15 毫米，PETG 装配时可能过紧。');
  if (!uploadedModel && options.jointType === 'ball-socket' && parameters.wallThickness < 2.4) {
    warnings.push('球头连接建议将局部壁厚增加到至少 2.4 毫米。');
  }
  if (options.fastenerType.includes('thread') && options.screwSize === 'M2') {
    warnings.push('M2 打印螺纹较细，建议优先使用热熔铜螺母或直接攻丝。');
  }

  return {
    parts: uploadedModel ? ['负方向拆件', '正方向拆件'] : ['下壳体', '顶盖'],
    splitDescription,
    connectors,
    connectorAxes: connectorAxes.map((axis) => axis.toUpperCase()) as [string, string],
    fastenerDescription,
    warnings
  };
}
