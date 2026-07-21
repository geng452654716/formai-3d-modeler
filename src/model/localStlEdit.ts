import type { ModelBoundsMm, ImportedStlModel } from './importedModel';

export type LocalStlEditOperation = 'add-cylinder' | 'cut-cylinder';

/** Codex 或本地中文解析器输出的局部表面修改计划，不包含三维选择坐标。 */
export interface LocalStlEditPlan {
  operation: LocalStlEditOperation;
  radiusMm: number;
  depthMm: number;
  summary: string;
}

/** 交给 OpenCascade Worker 的完整局部实体修改请求。 */
export interface LocalStlEditRequest extends LocalStlEditPlan {
  sourcePartId: 'uploaded-model';
  center: { xMm: number; yMm: number; zMm: number };
  inwardNormal: { x: number; y: number; z: number };
  command: string;
}

export interface LocalStlEditResult {
  status: 'ok';
  revision: string;
  operation: LocalStlEditOperation;
  sourceFile: string;
  stepFile: string;
  outputs: string[];
  units: 'mm';
  kernel: string;
  validation: {
    valid: boolean;
    watertight: boolean;
    solidCount: number;
    volumeBeforeMm3: number;
    volumeAfterMm3: number;
    volumeDeltaMm3: number;
    boundsMm: ModelBoundsMm;
  };
  updatedModel: ImportedStlModel;
  limitations: string[];
}

const NUMBER = '(\\d+(?:\\.\\d+)?)';
const DIAMETER_PATTERNS = [
  new RegExp(`(?:直径|φ|Φ)\\s*${NUMBER}\\s*(?:毫米|mm)?`, 'i'),
  new RegExp(`${NUMBER}\\s*(?:毫米|mm)?\\s*(?:直径|圆孔|孔径)`, 'i')
];
const RADIUS_PATTERNS = [
  new RegExp(`(?:半径|R)\\s*${NUMBER}\\s*(?:毫米|mm)?`, 'i')
];
const DEPTH_PATTERNS = [
  new RegExp(`(?:高(?:度)?|凸出|增加|加厚|深(?:度)?|切入|切除)\\s*${NUMBER}\\s*(?:毫米|mm)?`, 'i'),
  new RegExp(`${NUMBER}\\s*(?:毫米|mm)?\\s*(?:高|高度|深|深度)`, 'i')
];

function firstNumber(command: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * 解析第一版明确支持的局部表面圆柱操作。
 * 只接受沿选中表面法向的圆形凸台加厚与圆柱切孔，模糊命令会中文拒绝。
 */
export function parseLocalStlEditCommand(command: string): LocalStlEditPlan {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('局部修改指令不能为空');

  const isCut = /(?:开(?:一个)?[^，。；]*孔|打(?:一个)?[^，。；]*孔|钻(?:一个)?[^，。；]*孔|挖(?:一个)?[^，。；]*孔|圆孔|孔径|切除)/.test(trimmed);
  const isAdd = /(?:凸台|加厚|增厚|凸起|增加材料)/.test(trimmed);
  if (isCut === isAdd) {
    throw new Error('请明确说明“局部圆形凸台加厚”或“局部圆孔切除”');
  }

  const diameterMm = firstNumber(trimmed, DIAMETER_PATTERNS);
  const radiusMm = diameterMm !== null ? diameterMm / 2 : firstNumber(trimmed, RADIUS_PATTERNS);
  if (radiusMm === null) {
    throw new Error('请提供圆形区域的直径或半径，例如“直径 8 毫米”');
  }
  const depthMm = firstNumber(trimmed, DEPTH_PATTERNS);
  if (depthMm === null) {
    throw new Error(isCut
      ? '请提供圆孔切入深度，例如“深 6 毫米”'
      : '请提供凸台高度或加厚量，例如“高 2 毫米”');
  }
  if (!Number.isFinite(radiusMm) || radiusMm < 0.5 || radiusMm > 100) {
    throw new Error('局部圆形区域半径必须在 0.50 至 100.00 毫米之间');
  }
  if (!Number.isFinite(depthMm) || depthMm < 0.2 || depthMm > 200) {
    throw new Error('局部修改深度必须在 0.20 至 200.00 毫米之间');
  }

  const operation: LocalStlEditOperation = isCut ? 'cut-cylinder' : 'add-cylinder';
  return {
    operation,
    radiusMm,
    depthMm,
    summary: operation === 'cut-cylinder'
      ? `沿选中表面内法向切除直径 ${(radiusMm * 2).toFixed(2)} 毫米、深 ${depthMm.toFixed(2)} 毫米的圆孔`
      : `沿选中表面外法向增加直径 ${(radiusMm * 2).toFixed(2)} 毫米、高 ${depthMm.toFixed(2)} 毫米的圆形凸台`
  };
}
