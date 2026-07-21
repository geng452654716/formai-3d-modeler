import {
  INTERFACE_OPENING_FACE_LABELS,
  INTERFACE_OPENING_SHAPE_LABELS
} from './interfaceOpenings';
import type {
  EnclosureParameters,
  InterfaceOpeningSpec,
  ModelVersion
} from './types';

const NUMBER_TOLERANCE = 1e-6;

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

export interface ModelVersionComparison {
  parameterDifferences: ParameterDifference[];
  openingModeDifference: OpeningModeDifference | null;
  openingDifferences: OpeningDifference[];
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

  return {
    parameterDifferences,
    openingModeDifference,
    openingDifferences,
    hasDifferences:
      parameterDifferences.length > 0
      || openingModeDifference !== null
      || openingDifferences.length > 0
  };
}
