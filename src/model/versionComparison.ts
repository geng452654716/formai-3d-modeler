import {
  INTERFACE_OPENING_FACE_LABELS,
  INTERFACE_OPENING_SHAPE_LABELS
} from './interfaceOpenings';
import type {
  EnclosureParameters,
  InterfaceOpeningSpec,
  ModelVersion,
  VersionCurvedFeature
} from './types';

const NUMBER_TOLERANCE = 1e-6;

const SURFACE_GEOMETRY_TYPE_LABELS: Record<string, string> = {
  PLANE: '平面',
  CYLINDER: '圆柱面',
  CONE: '圆锥面',
  SPHERE: '球面',
  TORUS: '环形面',
  BSPLINE: 'B 样条曲面',
  BEZIER: '贝塞尔曲面',
  REVOLUTION: '旋转曲面',
  EXTRUSION: '拉伸曲面',
  OFFSET: '偏移曲面',
  OTHER: '其他曲面',
  UNKNOWN: '未知曲面'
};

export interface ParameterDifference {
  key: keyof EnclosureParameters;
  label: string;
  before: number;
  after: number;
  delta: number;
  unit: '毫米';
}

export interface OpeningFieldDifference {
  field: keyof InterfaceOpeningSpec;
  label: string;
  before: string;
  after: string;
}

export interface OpeningDifference {
  id: string;
  label: string;
  changeType: 'added' | 'removed' | 'modified';
  changedFields: string[];
  fields: OpeningFieldDifference[];
}

export interface OpeningModeDifference {
  before: string;
  after: string;
}

export type CurvedFeatureField =
  | 'radiusMm'
  | 'diameterMm'
  | 'widthMm'
  | 'lengthMm'
  | 'rotationDeg'
  | 'depthMm'
  | 'surfaceGeometryType'
  | 'maximumAbsCurvaturePerMm'
  | 'minimumCurvatureRadiusMm'
  | 'curvatureRatio'
  | 'localWallThicknessMm'
  | 'remainingWallMm'
  | 'throughCut'
  | 'interferenceCheckPassed'
  | 'selfIntersectionDetected'
  | 'adjacentFaceInterferenceDetected'
  | 'interferingFaceCount'
  | 'interferingStableFaceIds'
  | 'minimumInterferenceDistanceMm'
  | 'contactFaceCount'
  | 'contactSampleCount';

export interface CurvedFeatureFieldDifference {
  field: CurvedFeatureField;
  label: string;
  before: string;
  after: string;
}

export interface CurvedFeatureDifference {
  id: string;
  label: string;
  partId: string;
  stableFaceId: string;
  changeType: 'added' | 'removed' | 'modified';
  changedFields: string[];
  fields: CurvedFeatureFieldDifference[];
}

export interface ModelVersionComparison {
  parameterDifferences: ParameterDifference[];
  openingModeDifference: OpeningModeDifference | null;
  openingDifferences: OpeningDifference[];
  curvedFeatureDifferences: CurvedFeatureDifference[];
  hasDifferences: boolean;
}

export const VERSION_PARAMETER_FIELDS: ReadonlyArray<{
  key: keyof EnclosureParameters;
  label: string;
}> = [
  { key: 'boardLength', label: '参考元件长度' },
  { key: 'boardWidth', label: '参考元件宽度' },
  { key: 'boardThickness', label: '参考元件板厚' },
  { key: 'boardComponentHeight', label: '参考元件高度' },
  { key: 'clearanceXY', label: '水平装配间隙' },
  { key: 'clearanceZ', label: '垂直装配间隙' },
  { key: 'wallThickness', label: '外壳壁厚' },
  { key: 'baseThickness', label: '底板厚度' },
  { key: 'lidThickness', label: '上盖厚度' },
  { key: 'cornerRadius', label: '圆角半径' },
  { key: 'edgeChamfer', label: '倒角宽度' },
  { key: 'usbPortWidth', label: '模板开孔宽度' },
  { key: 'usbPortHeight', label: '模板开孔高度' },
  { key: 'usbPortBottom', label: '模板开孔底部偏移' },
  { key: 'usbPortOffsetY', label: '模板开孔水平偏移' },
  { key: 'boardOffsetX', label: '参考元件 X 偏移' },
  { key: 'boardOffsetZ', label: '参考元件 Z 偏移' }
];

const OPENING_FIELDS: ReadonlyArray<{
  key: keyof InterfaceOpeningSpec;
  label: string;
}> = [
  { key: 'label', label: '名称' },
  { key: 'sourceType', label: '接口类型' },
  { key: 'face', label: '所在面' },
  { key: 'shape', label: '轮廓' },
  { key: 'widthMm', label: '宽度' },
  { key: 'heightMm', label: '高度' },
  { key: 'centerUMm', label: '水平中心坐标' },
  { key: 'centerVMm', label: '竖直中心坐标' },
  { key: 'cornerRadiusMm', label: '圆角半径' },
  { key: 'positionReference', label: '定位方式' },
  { key: 'horizontalOffsetMm', label: '水平锚点偏移' },
  { key: 'bottomOffsetMm', label: '底边锚点偏移' }
];



const CURVED_FEATURE_FIELDS: ReadonlyArray<{
  key: CurvedFeatureField;
  label: string;
  value: (feature: VersionCurvedFeature) => unknown;
}> = [
  { key: 'radiusMm', label: '工具半径', value: (feature) => feature.radiusMm },
  { key: 'diameterMm', label: '工具直径', value: (feature) => feature.radiusMm === null ? null : feature.radiusMm * 2 },
  { key: 'widthMm', label: '槽孔宽度', value: (feature) => feature.widthMm },
  { key: 'lengthMm', label: '槽孔长度', value: (feature) => feature.lengthMm },
  { key: 'rotationDeg', label: '旋转角', value: (feature) => feature.operation === 'cut-slot' ? feature.rotationDeg : null },
  { key: 'depthMm', label: '作用深度', value: (feature) => feature.depthMm },
  { key: 'surfaceGeometryType', label: '曲面类型', value: (feature) => feature.surfaceGeometryType },
  { key: 'maximumAbsCurvaturePerMm', label: '最大绝对曲率', value: (feature) => feature.diagnostics.maximumAbsCurvaturePerMm },
  { key: 'minimumCurvatureRadiusMm', label: '最小曲率半径', value: (feature) => feature.diagnostics.minimumCurvatureRadiusMm },
  { key: 'curvatureRatio', label: '曲率比', value: (feature) => feature.diagnostics.curvatureRatio },
  { key: 'localWallThicknessMm', label: '局部壁厚', value: (feature) => feature.diagnostics.localWallThicknessMm },
  { key: 'remainingWallMm', label: '剩余壁厚', value: (feature) => feature.diagnostics.remainingWallMm },
  { key: 'throughCut', label: '通孔状态', value: (feature) => feature.diagnostics.throughCut },
  { key: 'interferenceCheckPassed', label: '干涉检查', value: (feature) => feature.diagnostics.interferenceCheckPassed },
  { key: 'selfIntersectionDetected', label: '目标曲面自交', value: (feature) => feature.diagnostics.selfIntersectionDetected },
  { key: 'adjacentFaceInterferenceDetected', label: '相邻面干涉', value: (feature) => feature.diagnostics.adjacentFaceInterferenceDetected },
  { key: 'interferingFaceCount', label: '干涉稳定面数量', value: (feature) => feature.diagnostics.interferingFaceCount },
  { key: 'interferingStableFaceIds', label: '干涉稳定面编号', value: (feature) => feature.diagnostics.interferingStableFaceIds },
  { key: 'minimumInterferenceDistanceMm', label: '最近干涉距离', value: (feature) => feature.diagnostics.minimumInterferenceDistanceMm },
  { key: 'contactFaceCount', label: '接触面数量', value: (feature) => feature.diagnostics.contactFaceCount },
  { key: 'contactSampleCount', label: '接触采样数量', value: (feature) => feature.diagnostics.contactSampleCount }
];

function curvedFeatureSummaryFields(feature: VersionCurvedFeature) {
  const dimensionalKeys: CurvedFeatureField[] = feature.operation === 'cut-slot'
    ? ['widthMm', 'lengthMm', 'rotationDeg']
    : ['diameterMm'];
  const summaryKeys = new Set<CurvedFeatureField>([
    ...dimensionalKeys,
    'depthMm',
    'curvatureRatio',
    'localWallThicknessMm',
    'remainingWallMm',
    'throughCut',
    'interferenceCheckPassed'
  ]);
  return CURVED_FEATURE_FIELDS.filter(({ key }) => summaryKeys.has(key));
}

const OPENING_SUMMARY_FIELDS = OPENING_FIELDS.filter(({ key }) => (
  key === 'face'
  || key === 'shape'
  || key === 'widthMm'
  || key === 'heightMm'
  || key === 'centerUMm'
  || key === 'centerVMm'
  || key === 'positionReference'
));

function numbersEqual(left: number, right: number) {
  return Math.abs(left - right) <= NUMBER_TOLERANCE;
}

function openingValueEqual(left: unknown, right: unknown) {
  if (typeof left === 'number' && typeof right === 'number') {
    return numbersEqual(left, right);
  }
  return left === right;
}

function formatNumber(value: number) {
  const normalized = Math.abs(value) <= NUMBER_TOLERANCE ? 0 : value;
  return Number(normalized.toFixed(4)).toString();
}

function formatOpeningValue(
  key: keyof InterfaceOpeningSpec,
  value: InterfaceOpeningSpec[keyof InterfaceOpeningSpec]
) {
  if (key === 'face' && typeof value === 'string') {
    return INTERFACE_OPENING_FACE_LABELS[value as InterfaceOpeningSpec['face']] ?? value;
  }
  if (key === 'shape' && typeof value === 'string') {
    return INTERFACE_OPENING_SHAPE_LABELS[value as InterfaceOpeningSpec['shape']] ?? value;
  }
  if (key === 'positionReference') {
    return value === 'face-center-bottom' ? '接口面中心与底边锚定' : '固定毫米坐标';
  }
  if (typeof value === 'number') return `${formatNumber(value)} 毫米`;
  if (value === undefined || value === null || value === '') return '未设置';
  return String(value);
}

function normalizeOpenings(version: ModelVersion) {
  return version.interfaceOpenings === undefined ? null : version.interfaceOpenings;
}

function openingMode(openings: InterfaceOpeningSpec[] | null) {
  return openings === null ? '模板参数开孔' : '自定义通用开孔';
}

function compareOpeningFields(
  before: InterfaceOpeningSpec,
  after: InterfaceOpeningSpec
): OpeningFieldDifference[] {
  return OPENING_FIELDS.flatMap(({ key, label }) => {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (openingValueEqual(beforeValue, afterValue)) return [];
    return [{
      field: key,
      label,
      before: formatOpeningValue(key, beforeValue),
      after: formatOpeningValue(key, afterValue)
    }];
  });
}

function describeAddedOrRemovedOpening(
  opening: InterfaceOpeningSpec,
  changeType: 'added' | 'removed'
): OpeningFieldDifference[] {
  return OPENING_SUMMARY_FIELDS.map(({ key, label }) => ({
    field: key,
    label,
    before: changeType === 'added' ? '不存在' : formatOpeningValue(key, opening[key]),
    after: changeType === 'added' ? formatOpeningValue(key, opening[key]) : '不存在'
  }));
}

function compareOpenings(
  beforeOpenings: InterfaceOpeningSpec[] | null,
  afterOpenings: InterfaceOpeningSpec[] | null
) {
  const before = beforeOpenings ?? [];
  const after = afterOpenings ?? [];
  const beforeById = new Map(before.map((opening) => [opening.id, opening]));
  const afterById = new Map(after.map((opening) => [opening.id, opening]));
  const differences: OpeningDifference[] = [];

  for (const opening of before) {
    if (afterById.has(opening.id)) continue;
    differences.push({
      id: opening.id,
      label: opening.label,
      changeType: 'removed',
      changedFields: [],
      fields: describeAddedOrRemovedOpening(opening, 'removed')
    });
  }

  for (const opening of after) {
    const previous = beforeById.get(opening.id);
    if (!previous) {
      differences.push({
        id: opening.id,
        label: opening.label,
        changeType: 'added',
        changedFields: [],
        fields: describeAddedOrRemovedOpening(opening, 'added')
      });
      continue;
    }
    const fields = compareOpeningFields(previous, opening);
    if (fields.length === 0) continue;
    differences.push({
      id: opening.id,
      label: opening.label,
      changeType: 'modified',
      changedFields: fields.map((field) => field.label),
      fields
    });
  }

  return differences;
}


function curvedFeatureValueEqual(left: unknown, right: unknown) {
  if (typeof left === 'number' && typeof right === 'number') return numbersEqual(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function formatCurvedFeatureValue(field: CurvedFeatureField, value: unknown) {
  if (value === null || value === undefined) return '未记录';
  if (field === 'throughCut') return value ? '通孔' : '盲孔';
  if (field === 'interferenceCheckPassed') return value ? '通过' : '未通过';
  if (field === 'selfIntersectionDetected' || field === 'adjacentFaceInterferenceDetected') {
    return value ? '已检测到' : '未检测到';
  }
  if (field === 'surfaceGeometryType' && typeof value === 'string') {
    return SURFACE_GEOMETRY_TYPE_LABELS[value] ?? '未知曲面';
  }
  if (field === 'interferingStableFaceIds') {
    return Array.isArray(value) && value.length > 0 ? value.join('、') : '无';
  }
  if (typeof value === 'number') {
    if (field === 'curvatureRatio') return formatNumber(value);
    if (field === 'rotationDeg') return `${formatNumber(value)} 度`;
    if (field === 'maximumAbsCurvaturePerMm') return `${formatNumber(value)} /毫米`;
    if (field === 'interferingFaceCount' || field === 'contactFaceCount' || field === 'contactSampleCount') {
      return `${formatNumber(value)} 个`;
    }
    return `${formatNumber(value)} 毫米`;
  }
  return String(value);
}

function curvedFeatureLabel(feature: VersionCurvedFeature) {
  if (feature.operation === 'add-cylinder') return '曲面圆形凸台';
  return feature.operation === 'cut-slot' ? '曲面槽孔' : '曲面圆孔';
}

function compareCurvedFeatureFields(
  before: VersionCurvedFeature,
  after: VersionCurvedFeature
): CurvedFeatureFieldDifference[] {
  return CURVED_FEATURE_FIELDS.flatMap(({ key, label, value }) => {
    const beforeValue = value(before);
    const afterValue = value(after);
    if (curvedFeatureValueEqual(beforeValue, afterValue)) return [];
    return [{
      field: key,
      label,
      before: formatCurvedFeatureValue(key, beforeValue),
      after: formatCurvedFeatureValue(key, afterValue)
    }];
  });
}

function describeAddedOrRemovedCurvedFeature(
  feature: VersionCurvedFeature,
  changeType: 'added' | 'removed'
): CurvedFeatureFieldDifference[] {
  return curvedFeatureSummaryFields(feature).map(({ key, label, value }) => ({
    field: key,
    label,
    before: changeType === 'added' ? '不存在' : formatCurvedFeatureValue(key, value(feature)),
    after: changeType === 'added' ? formatCurvedFeatureValue(key, value(feature)) : '不存在'
  }));
}

function compareCurvedFeatures(
  beforeFeatures: VersionCurvedFeature[] = [],
  afterFeatures: VersionCurvedFeature[] = []
) {
  const beforeById = new Map(beforeFeatures.map((feature) => [feature.id, feature]));
  const afterById = new Map(afterFeatures.map((feature) => [feature.id, feature]));
  const differences: CurvedFeatureDifference[] = [];

  for (const feature of beforeFeatures) {
    if (afterById.has(feature.id)) continue;
    differences.push({
      id: feature.id,
      label: curvedFeatureLabel(feature),
      partId: feature.partId,
      stableFaceId: feature.stableFaceId,
      changeType: 'removed',
      changedFields: [],
      fields: describeAddedOrRemovedCurvedFeature(feature, 'removed')
    });
  }

  for (const feature of afterFeatures) {
    const previous = beforeById.get(feature.id);
    if (!previous) {
      differences.push({
        id: feature.id,
        label: curvedFeatureLabel(feature),
        partId: feature.partId,
        stableFaceId: feature.stableFaceId,
        changeType: 'added',
        changedFields: [],
        fields: describeAddedOrRemovedCurvedFeature(feature, 'added')
      });
      continue;
    }
    const fields = compareCurvedFeatureFields(previous, feature);
    if (fields.length === 0) continue;
    differences.push({
      id: feature.id,
      label: curvedFeatureLabel(feature),
      partId: feature.partId,
      stableFaceId: feature.stableFaceId,
      changeType: 'modified',
      changedFields: fields.map((field) => field.label),
      fields
    });
  }

  return differences;
}

export function compareModelVersions(
  baseVersion: ModelVersion,
  targetVersion: ModelVersion
): ModelVersionComparison {
  const parameterDifferences = VERSION_PARAMETER_FIELDS.flatMap(({ key, label }) => {
    const before = baseVersion.parameters[key];
    const after = targetVersion.parameters[key];
    if (numbersEqual(before, after)) return [];
    return [{
      key,
      label,
      before,
      after,
      delta: Number((after - before).toFixed(10)),
      unit: '毫米' as const
    }];
  });
  const beforeOpenings = normalizeOpenings(baseVersion);
  const afterOpenings = normalizeOpenings(targetVersion);
  const beforeMode = openingMode(beforeOpenings);
  const afterMode = openingMode(afterOpenings);
  const openingModeDifference = beforeMode === afterMode
    ? null
    : { before: beforeMode, after: afterMode };
  const openingDifferences = compareOpenings(beforeOpenings, afterOpenings);
  const curvedFeatureDifferences = compareCurvedFeatures(
    baseVersion.curvedFeatures,
    targetVersion.curvedFeatures
  );

  return {
    parameterDifferences,
    openingModeDifference,
    openingDifferences,
    curvedFeatureDifferences,
    hasDifferences:
      parameterDifferences.length > 0
      || openingModeDifference !== null
      || openingDifferences.length > 0
      || curvedFeatureDifferences.length > 0
  };
}
