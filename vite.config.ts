import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const artifactsDirectory = resolve(projectRoot, 'artifacts');
const workerPath = resolve(projectRoot, 'modeling/generate_model.py');
const splitWorkerPath = resolve(projectRoot, 'modeling/split_and_cap.py');
const wallThicknessWorkerPath = resolve(projectRoot, 'modeling/wall_thickness_analysis.py');
const localStlEditWorkerPath = resolve(projectRoot, 'modeling/local_stl_edit.py');
const localCadFeatureWorkerPath = resolve(projectRoot, 'modeling/local_cad_feature.py');
const cadSurfaceHitWorkerPath = resolve(projectRoot, 'modeling/resolve_cad_surface_hit.py');
const pythonPath = resolve(projectRoot, 'modeling/.venv/bin/python');
const runtimeParametersPath = resolve(artifactsDirectory, '.runtime-parameters.json');
const resultFileNames = [
  'generation-result.json',
  'manufacturing-result.json',
  'imported-model-result.json',
  'wall-thickness-result.json',
  'local-stl-edit-result.json',
  'local-cad-feature-result.json',
  'local-cad-feature-preflight-result.json'
];
const importedModelFiles = ['imported-model.stl', 'imported-model-working.stl', 'imported-model-working.step'];
const manufacturingFiles = [
  'manufacturing-negative.stl',
  'manufacturing-positive.stl',
  'manufacturing-negative.step',
  'manufacturing-positive.step'
];

interface GenerationManifest {
  outputs?: string[];
  assemblyFile?: string;
  parts?: Array<{ id?: string; stepFile?: string; stlFile?: string }>;
}

const parameterNames: Record<string, string> = {
  boardLength: 'board_length',
  boardWidth: 'board_width',
  boardThickness: 'board_thickness',
  boardComponentHeight: 'board_component_height',
  clearanceXY: 'clearance_xy',
  clearanceZ: 'clearance_z',
  wallThickness: 'wall_thickness',
  baseThickness: 'base_thickness',
  lidThickness: 'lid_thickness',
  cornerRadius: 'corner_radius',
  edgeChamfer: 'edge_chamfer',
  usbPortWidth: 'usb_port_width',
  usbPortHeight: 'usb_port_height',
  usbPortBottom: 'usb_port_bottom',
  usbPortOffsetY: 'usb_port_offset_y'
};

const interfaceOpeningFaces = new Set(['front', 'back', 'left', 'right', 'top', 'bottom']);
const interfaceOpeningShapes = new Set(['circle', 'rectangle', 'rounded-rectangle', 'slot']);
const interfaceOpeningPositionReferences = new Set(['face-center-bottom']);
const maximumInterfaceOpenings = 100;

function writeJson(response: import('node:http').ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new Error('请求内容过大');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function readBinaryBody(
  request: import('node:http').IncomingMessage,
  maximumBytes = 50 * 1024 * 1024
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error('STL 文件不能超过 50 MB');
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('上传的 STL 文件为空');
  return Buffer.concat(chunks);
}

function normalizeParameters(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('缺少模型参数');
  const source = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(parameterNames).map(([clientName, workerName]) => {
      const parameter = source[clientName];
      if (typeof parameter !== 'number' || !Number.isFinite(parameter)) {
        throw new Error(`模型参数无效：${clientName}`);
      }
      return [workerName, parameter];
    })
  );

  if (!Object.prototype.hasOwnProperty.call(source, 'interfaceOpenings')) return normalized;
  if (!Array.isArray(source.interfaceOpenings)) throw new Error('照片精确开孔必须是数组');
  if (source.interfaceOpenings.length > maximumInterfaceOpenings) {
    throw new Error(`照片精确开孔不能超过 ${maximumInterfaceOpenings} 个`);
  }

  const interfaceOpenings = source.interfaceOpenings.map((rawOpening, index) => {
    if (!rawOpening || typeof rawOpening !== 'object') {
      throw new Error(`第 ${index + 1} 个照片精确开孔格式无效`);
    }
    const opening = rawOpening as Record<string, unknown>;
    const readString = (name: string, maximumLength: number) => {
      const text = opening[name];
      if (typeof text !== 'string' || !text.trim() || text.trim().length > maximumLength) {
        throw new Error(`第 ${index + 1} 个开孔的 ${name} 无效`);
      }
      return text.trim();
    };
    const readNumber = (name: string, minimum?: number, maximum?: number) => {
      const number = opening[name];
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new Error(`第 ${index + 1} 个开孔的 ${name} 无效`);
      }
      if (minimum !== undefined && number < minimum) {
        throw new Error(`第 ${index + 1} 个开孔的 ${name} 不能小于 ${minimum}`);
      }
      if (maximum !== undefined && number > maximum) {
        throw new Error(`第 ${index + 1} 个开孔的 ${name} 不能大于 ${maximum}`);
      }
      return number;
    };
    const face = readString('face', 16);
    const shape = readString('shape', 32);
    if (!interfaceOpeningFaces.has(face)) throw new Error(`第 ${index + 1} 个开孔的接口面无效`);
    if (!interfaceOpeningShapes.has(shape)) throw new Error(`第 ${index + 1} 个开孔的轮廓无效`);

    const normalizedOpening: Record<string, string | number> = {
      id: readString('id', 80),
      label: readString('label', 120),
      source_type: readString('sourceType', 80),
      face,
      shape,
      width_mm: readNumber('widthMm', 0.01, 1000),
      height_mm: readNumber('heightMm', 0.01, 1000),
      center_u_mm: readNumber('centerUMm', -1000, 1000),
      center_v_mm: readNumber('centerVMm', -1000, 1000),
      corner_radius_mm: readNumber('cornerRadiusMm', 0, 500),
      minimum_edge_margin_mm: readNumber('minimumEdgeMarginMm', 0, 100),
      minimum_spacing_mm: readNumber('minimumSpacingMm', 0, 100),
      source_confidence: readNumber('sourceConfidence', 0, 1)
    };
    const positionFieldNames = [
      'positionReference',
      'horizontalOffsetMm',
      'bottomOffsetMm'
    ];
    if (positionFieldNames.some((name) => opening[name] !== undefined)) {
      if (positionFieldNames.some((name) => opening[name] === undefined)) {
        throw new Error(`第 ${index + 1} 个开孔的照片定位锚点不完整`);
      }
      const positionReference = readString('positionReference', 40);
      if (!interfaceOpeningPositionReferences.has(positionReference)) {
        throw new Error(`第 ${index + 1} 个开孔的照片定位方式无效`);
      }
      normalizedOpening.position_reference = positionReference;
      normalizedOpening.horizontal_offset_mm = readNumber('horizontalOffsetMm', -1000, 1000);
      normalizedOpening.bottom_offset_mm = readNumber('bottomOffsetMm', -1000, 1000);
    }
    return normalizedOpening;
  });

  return { ...normalized, interface_openings: interfaceOpenings };
}

function readGenerationManifest(): GenerationManifest {
  const manifestPath = resolve(artifactsDirectory, 'generation-result.json');
  if (!existsSync(manifestPath)) throw new Error('没有找到模型清单，请先重建 CAD');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as GenerationManifest;
}

function generatedFiles() {
  const files = new Set([...resultFileNames, ...importedModelFiles, ...manufacturingFiles]);
  try {
    const manifest = readGenerationManifest();
    manifest.outputs?.forEach((fileName) => files.add(basename(fileName)));
    manifest.parts?.forEach((part) => {
      if (part.stlFile) files.add(part.stlFile);
      if (part.stepFile) files.add(part.stepFile);
    });
    if (manifest.assemblyFile) files.add(manifest.assemblyFile);
  } catch {
    // The result manifest is optional before the first model generation.
  }
  for (const resultName of [
    'imported-model-result.json',
    'manufacturing-result.json',
    'local-stl-edit-result.json',
    'local-cad-feature-result.json',
    'local-cad-feature-preflight-result.json'
  ]) {
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(artifactsDirectory, resultName), 'utf8')
      ) as GenerationManifest;
      manifest.outputs?.forEach((fileName) => files.add(basename(fileName)));
    } catch {
      // 上传或拆件结果在首次执行前是可选的。
    }
  }
  return Array.from(files);
}

function readImportedModelSourceFile() {
  const manifestPath = resolve(artifactsDirectory, 'imported-model-result.json');
  if (!existsSync(manifestPath)) throw new Error('没有找到上传模型清单，请先选择 STL 文件');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceFile?: unknown };
  if (typeof manifest.sourceFile !== 'string' || basename(manifest.sourceFile) !== manifest.sourceFile) {
    throw new Error('上传模型工作文件记录无效，请重新选择 STL 文件');
  }
  const sourcePath = resolve(artifactsDirectory, manifest.sourceFile);
  if (!existsSync(sourcePath)) throw new Error(`没有找到上传模型工作文件 ${manifest.sourceFile}，请重新选择 STL 文件`);
  return sourcePath;
}

function runWorker() {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(
      pythonPath,
      [workerPath, '--parameters', runtimeParametersPath, '--output', artifactsDirectory],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `CAD Worker 退出，状态码：${code}`));
    });
  });
}

function runStlInspection(originalFileName: string) {
  const safeOriginalFileName = basename(originalFileName);
  if (!safeOriginalFileName.toLowerCase().endsWith('.stl')) throw new Error('请选择 STL 文件');
  const sourcePath = resolve(artifactsDirectory, 'imported-model.stl');
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(
      pythonPath,
      [
        splitWorkerPath,
        '--input', sourcePath,
        '--output', artifactsDirectory,
        '--stem', 'imported-model',
        '--source-kind', 'uploaded-stl',
        '--inspect-only',
        '--original-file-name', safeOriginalFileName
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `STL 检查 Worker 退出，状态码：${code}`));
    });
  });
}

function runSplitWorker(
  sourceKind: string,
  sourcePartId: string,
  axis: string,
  offsetMm: number,
  jointType: string,
  fastenerType: string,
  screwSize: string,
  clearanceMm: number
) {
  if (!['cad-part', 'uploaded-stl'].includes(sourceKind)) throw new Error('拆件来源类型无效');
  if (!sourcePartId) throw new Error('请选择需要拆分的模型或零件');
  if (!['x', 'y', 'z'].includes(axis)) throw new Error('拆件轴只能是 X、Y 或 Z');
  if (!Number.isFinite(offsetMm)) throw new Error('拆件平面偏移必须是有限毫米数值');
  if (!['round-pin', 'd-pin', 'dovetail', 'ball-socket', 'magnet'].includes(jointType)) {
    throw new Error('连接结构类型无效');
  }
  if (!['screw-boss', 'snap-fit', 'threaded-hole', 'external-thread', 'iso-threaded-hole', 'iso-external-thread'].includes(fastenerType)) {
    throw new Error('精确紧固结构只能选择螺丝柱、可拆卡扣、打印友好近似螺纹或 ISO 60° 螺纹');
  }
  if (!['M2', 'M2.5', 'M3'].includes(screwSize)) throw new Error('螺丝规格只能是 M2、M2.5 或 M3');
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0.1 || clearanceMm > 1) {
    throw new Error('公母间隙必须在 0.10 至 1.00 毫米之间');
  }

  let sourcePath: string;
  if (sourceKind === 'uploaded-stl') {
    sourcePath = readImportedModelSourceFile();
  } else {
    const part = readGenerationManifest().parts?.find((candidate) => candidate.id === sourcePartId);
    if (!part?.stepFile) throw new Error(`模型清单中没有找到零件：${sourcePartId}`);
    sourcePath = resolve(artifactsDirectory, basename(part.stepFile));
    if (!existsSync(sourcePath)) throw new Error(`没有找到精确模型 ${part.stepFile}，请先重建 CAD`);
  }

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(
      pythonPath,
      [
        splitWorkerPath,
        '--input', sourcePath,
        '--output', artifactsDirectory,
        '--axis', axis,
        '--offset', String(offsetMm),
        '--stem', 'manufacturing',
        '--source-kind', sourceKind,
        '--source-part-id', sourcePartId,
        '--joint-type', jointType,
        '--fastener-type', fastenerType,
        '--screw-size', screwSize,
        '--clearance', String(clearanceMm),
        '--apply-features'
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `拆件 Worker 退出，状态码：${code}`));
    });
  });
}

function runWallThicknessWorker(
  sourceKind: string,
  sourcePartId: string,
  minimumWallMm: number,
  sampleLimit: number
) {
  if (!['cad-part', 'uploaded-stl'].includes(sourceKind)) throw new Error('壁厚分析来源类型无效');
  if (!sourcePartId) throw new Error('请选择需要分析的模型或零件');
  if (!Number.isFinite(minimumWallMm) || minimumWallMm < 0.4 || minimumWallMm > 10) {
    throw new Error('最小目标壁厚必须在 0.40 至 10.00 毫米之间');
  }
  if (!Number.isInteger(sampleLimit) || sampleLimit < 12 || sampleLimit > 5000) {
    throw new Error('壁厚采样上限必须在 12 至 5000 之间');
  }

  let sourcePath: string;
  if (sourceKind === 'uploaded-stl') {
    if (sourcePartId !== 'uploaded-model') throw new Error('上传 STL 的来源标识无效');
    sourcePath = readImportedModelSourceFile();
  } else {
    const part = readGenerationManifest().parts?.find((candidate) => candidate.id === sourcePartId);
    if (!part?.stepFile) throw new Error(`模型清单中没有找到零件：${sourcePartId}`);
    sourcePath = resolve(artifactsDirectory, basename(part.stepFile));
    if (!existsSync(sourcePath)) throw new Error(`没有找到精确模型 ${part.stepFile}，请先重建 CAD`);
  }

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(
      pythonPath,
      [
        wallThicknessWorkerPath,
        '--input', sourcePath,
        '--output', artifactsDirectory,
        '--source-kind', sourceKind,
        '--source-part-id', sourcePartId,
        '--minimum-wall', String(minimumWallMm),
        '--sample-limit', String(sampleLimit)
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `壁厚分析 Worker 退出，状态码：${code}`));
    });
  });
}

function runLocalStlEditWorker(body: {
  sourcePartId?: string;
  operation?: string;
  centerXmm?: number;
  centerYmm?: number;
  centerZmm?: number;
  normalX?: number;
  normalY?: number;
  normalZ?: number;
  radiusMm?: number;
  depthMm?: number;
  command?: string;
}) {
  if (body.sourcePartId !== 'uploaded-model') throw new Error('上传 STL 的来源标识无效');
  if (!['add-cylinder', 'cut-cylinder'].includes(body.operation ?? '')) {
    throw new Error('局部 STL 修改操作无效');
  }
  const numericValues = [
    body.centerXmm, body.centerYmm, body.centerZmm,
    body.normalX, body.normalY, body.normalZ, body.radiusMm, body.depthMm
  ];
  if (numericValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('局部 STL 修改坐标、法向和尺寸必须是有限数值');
  }
  if ((body.command ?? '').length > 2000) throw new Error('局部修改指令过长，请控制在 2000 字以内');
  const sourcePath = readImportedModelSourceFile();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(
      pythonPath,
      [
        localStlEditWorkerPath,
        '--input', sourcePath,
        '--output', artifactsDirectory,
        '--operation', body.operation!,
        '--center-x', String(body.centerXmm),
        '--center-y', String(body.centerYmm),
        '--center-z', String(body.centerZmm),
        '--normal-x', String(body.normalX),
        '--normal-y', String(body.normalY),
        '--normal-z', String(body.normalZ),
        '--radius', String(body.radiusMm),
        '--depth', String(body.depthMm),
        '--command', body.command ?? ''
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim() || `局部 STL 修改 Worker 退出，状态码：${code}`));
    });
  });
}

function runLocalCadFeatureWorker(body: {
  selectionRevision?: string;
  partId?: string;
  stableFaceId?: string;
  stableEdgeId?: string | null;
  operation?: string;
  centerXmm?: number;
  centerYmm?: number;
  centerZmm?: number;
  normalX?: number;
  normalY?: number;
  normalZ?: number;
  surfaceGeometryType?: string;
  surfaceU?: number;
  surfaceV?: number;
  surfaceTangentUx?: number | null;
  surfaceTangentUy?: number | null;
  surfaceTangentUz?: number | null;
  radiusMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  lengthMm?: number | null;
  depthMm?: number;
  rotationDeg?: number;
  command?: string;
  previewOnly?: boolean;
}) {
  const operations = ['add-cylinder', 'cut-cylinder', 'add-rectangle', 'cut-rectangle', 'cut-slot', 'offset-face-outward', 'offset-face-inward', 'fillet-edge', 'chamfer-edge', 'fillet-edge-loop', 'chamfer-edge-loop', 'fillet-edge-chain', 'chamfer-edge-chain'];
  if (!operations.includes(body.operation ?? '')) throw new Error('稳定 CAD 局部特征操作无效');
  const identifiers = [body.selectionRevision, body.partId, body.stableFaceId];
  if (identifiers.some((value) => typeof value !== 'string' || !value.trim() || Array.from(value).length > 200)) {
    throw new Error('稳定 CAD 面选择标识无效，请重新选择平面');
  }
  if (typeof body.surfaceGeometryType !== 'string' || !body.surfaceGeometryType.trim() || Array.from(body.surfaceGeometryType).length > 100) {
    throw new Error('稳定 CAD 面曲面类型无效，请重新选择目标面');
  }
  const requiredNumbers = [body.centerXmm, body.centerYmm, body.centerZmm, body.normalX, body.normalY, body.normalZ, body.surfaceU, body.surfaceV, body.depthMm, body.rotationDeg];
  if (requiredNumbers.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('稳定 CAD 面局部特征坐标、法向、深度和旋转角必须是有限数值');
  }
  for (const value of [body.radiusMm, body.widthMm, body.heightMm, body.lengthMm]) {
    if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('稳定 CAD 面局部特征可选尺寸必须是有限数值或空值');
    }
  }
  if (body.depthMm! < 0.2 || body.depthMm! > 200 || body.rotationDeg! < -180 || body.rotationDeg! > 180) {
    throw new Error('稳定 CAD 面局部特征深度或旋转角超出安全范围');
  }
  const cylinder = body.operation === 'add-cylinder' || body.operation === 'cut-cylinder';
  const wholeFace = body.operation === 'offset-face-outward' || body.operation === 'offset-face-inward';
  const edgeFeature = ['fillet-edge', 'chamfer-edge', 'fillet-edge-loop', 'chamfer-edge-loop', 'fillet-edge-chain', 'chamfer-edge-chain'].includes(body.operation!);
  const edgeLoopFeature = body.operation === 'fillet-edge-loop' || body.operation === 'chamfer-edge-loop';
  const curvedFace = body.surfaceGeometryType !== 'PLANE';
  if (body.previewOnly !== undefined && typeof body.previewOnly !== 'boolean') {
    throw new Error('稳定 CAD 精确工具体预演标记无效');
  }
  if (body.previewOnly && !curvedFace) {
    throw new Error('OpenCascade 精确工具体预演第一版只用于非平面曲面局部特征');
  }
  const slot = body.operation === 'cut-slot';
  const rectangle = body.operation === 'add-rectangle' || body.operation === 'cut-rectangle';
  if (curvedFace && edgeLoopFeature) {
    throw new Error('整圈边圆角或倒角第一版只支持平面边界，请重新选择平面所属边');
  }
  if (curvedFace && !cylinder && !rectangle && !slot && !edgeFeature) {
    throw new Error(`当前选中的是 ${body.surfaceGeometryType} 曲面；当前曲面局部特征只支持圆形凸台、圆孔、矩形凸台、矩形孔、受限槽孔，或对所选单条稳定边执行圆角与倒角`);
  }
  const surfaceTangentValues = [body.surfaceTangentUx, body.surfaceTangentUy, body.surfaceTangentUz];
  const tangentValueCount = surfaceTangentValues.filter((value) => value !== null && value !== undefined).length;
  if (tangentValueCount !== 0 && tangentValueCount !== 3) {
    throw new Error('曲面 U 切向必须同时提供三个有限分量，或全部留空');
  }
  if (tangentValueCount === 3 && surfaceTangentValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('曲面 U 切向必须同时提供三个有限分量，或全部留空');
  }
  if (curvedFace && (rectangle || slot)) {
    if (tangentValueCount !== 3) throw new Error('曲面方向轮廓缺少有效的 OpenCascade 真实 U 切向，请重新点击目标面');
    const tangentLength = Math.hypot(body.surfaceTangentUx!, body.surfaceTangentUy!, body.surfaceTangentUz!);
    if (tangentLength < 0.5) throw new Error('曲面方向轮廓的 OpenCascade 真实 U 切向已退化，请重新点击目标面');
  }
  if (edgeFeature) {
    if (typeof body.stableEdgeId !== 'string' || !body.stableEdgeId.trim() || Array.from(body.stableEdgeId).length > 200) {
      throw new Error('稳定 CAD 边选择标识无效，请重新选择目标边');
    }
    if (body.depthMm! > 50 || body.radiusMm != null || body.widthMm != null || body.heightMm != null || body.lengthMm != null || Math.abs(body.rotationDeg!) > 1e-9) {
      throw new Error('圆角或倒角尺寸字段不符合安全协议');
    }
  } else if (body.stableEdgeId != null) {
    throw new Error('平面局部特征不能携带稳定边 ID');
  } else if (wholeFace) {
    if (body.radiusMm != null || body.widthMm != null || body.heightMm != null || body.lengthMm != null || Math.abs(body.rotationDeg!) > 1e-9) {
      throw new Error('整面拉伸或偏移尺寸字段不符合安全协议');
    }
  } else if (cylinder) {
    if (body.radiusMm == null || body.radiusMm < 0.5 || body.radiusMm > 100 || body.widthMm != null || body.heightMm != null || body.lengthMm != null || Math.abs(body.rotationDeg!) > 1e-9) {
      throw new Error('圆柱局部特征尺寸字段不符合安全协议');
    }
  } else if (body.radiusMm != null || body.widthMm == null || body.widthMm < 0.5 || body.widthMm > 200) {
    throw new Error('矩形或槽孔局部特征尺寸字段不符合安全协议');
  } else if (body.operation === 'cut-slot') {
    if (body.heightMm != null || body.lengthMm == null || body.lengthMm < Math.max(1, body.widthMm) || body.lengthMm > 200) throw new Error('槽孔尺寸字段不符合安全协议');
  } else if (body.heightMm == null || body.heightMm < 0.5 || body.heightMm > 200 || body.lengthMm != null) {
    throw new Error('矩形尺寸字段不符合安全协议');
  }
  if (body.command !== undefined && typeof body.command !== 'string') throw new Error('局部特征指令格式无效');
  if (Array.from(body.command ?? '').length > 2000) throw new Error('局部特征指令过长，请控制在 2000 字以内');
  if (!existsSync(localCadFeatureWorkerPath)) throw new Error(`未找到稳定 CAD 面局部特征 Worker：${localCadFeatureWorkerPath}`);
  if (!existsSync(pythonPath)) throw new Error(`CAD Python 环境不可用：${pythonPath}`);

  const arguments_ = [
    localCadFeatureWorkerPath, '--output', artifactsDirectory, '--operation', body.operation!,
    '--selection-revision', body.selectionRevision!.trim(), '--part-id', body.partId!.trim(),
    '--stable-face-id', body.stableFaceId!.trim(), '--center-x', String(body.centerXmm),
    '--center-y', String(body.centerYmm), '--center-z', String(body.centerZmm),
    '--normal-x', String(body.normalX), '--normal-y', String(body.normalY), '--normal-z', String(body.normalZ),
    '--surface-geometry-type', body.surfaceGeometryType!.trim(), '--surface-u', String(body.surfaceU), '--surface-v', String(body.surfaceV),
    '--depth', String(body.depthMm), '--rotation', String(body.rotationDeg), '--command', body.command ?? ''
  ];
  if (edgeFeature) arguments_.push('--stable-edge-id', body.stableEdgeId!.trim());
  if (tangentValueCount === 3) {
    arguments_.push(
      '--surface-tangent-u-x', String(body.surfaceTangentUx),
      '--surface-tangent-u-y', String(body.surfaceTangentUy),
      '--surface-tangent-u-z', String(body.surfaceTangentUz)
    );
  }
  for (const [flag, value] of [['--radius', body.radiusMm], ['--width', body.widthMm], ['--height', body.heightMm], ['--length', body.lengthMm]] as const) {
    if (value !== null && value !== undefined) arguments_.push(flag, String(value));
  }
  if (body.previewOnly) arguments_.push('--preview-only');
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(pythonPath, arguments_, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(stderr.trim() || `稳定 CAD 面局部特征 Worker 退出，状态码：${code}`)));
  });
}

function runCadSurfaceHitWorker(body: {
  selectionRevision?: string;
  partId?: string;
  stableFaceId?: string;
  triangleIndex?: number;
  pointX?: number;
  pointY?: number;
  pointZ?: number;
  normalX?: number;
  normalY?: number;
  normalZ?: number;
}) {
  const identifiers = [body.selectionRevision, body.partId, body.stableFaceId];
  if (identifiers.some((value) => typeof value !== 'string' || !value.trim() || Array.from(value).length > 200)) {
    throw new Error('曲面点击选择标识无效，请重新点击目标面');
  }
  if (!Number.isInteger(body.triangleIndex) || body.triangleIndex! < 0) {
    throw new Error('曲面点击三角面索引无效，请重新点击目标面');
  }
  const values = [body.pointX, body.pointY, body.pointZ, body.normalX, body.normalY, body.normalZ];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('曲面点击坐标和选择网格法线必须是有限数值');
  }
  if (!existsSync(cadSurfaceHitWorkerPath)) {
    throw new Error(`未找到 OpenCascade 曲面点击解析 Worker：${cadSurfaceHitWorkerPath}`);
  }
  if (!existsSync(pythonPath)) throw new Error(`CAD Python 环境不可用：${pythonPath}`);

  const arguments_ = [
    cadSurfaceHitWorkerPath,
    '--output', artifactsDirectory,
    '--selection-revision', body.selectionRevision!.trim(),
    '--part-id', body.partId!.trim(),
    '--stable-face-id', body.stableFaceId!.trim(),
    '--triangle-index', String(body.triangleIndex),
    '--point-x', String(body.pointX),
    '--point-y', String(body.pointY),
    '--point-z', String(body.pointZ),
    '--normal-x', String(body.normalX),
    '--normal-y', String(body.normalY),
    '--normal-z', String(body.normalZ)
  ];
  return new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    const process = spawn(pythonPath, arguments_, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) process.kill();
    });
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `OpenCascade 曲面点击解析 Worker 退出，状态码：${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        rejectPromise(new Error('OpenCascade 曲面点击解析 Worker 返回了无效 JSON'));
      }
    });
  });
}
function contentType(fileName: string) {
  switch (extname(fileName)) {
    case '.stl': return 'model/stl';
    case '.step': return 'application/step';
    case '.3mf': return 'model/3mf';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function cadWorkerPlugin(): Plugin {
  let generating = false;

  return {
    name: 'formai-cad-worker',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');

        if (url.pathname === '/api/model/generate' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const body = await readJsonBody(request) as { parameters?: unknown };
            writeFileSync(runtimeParametersPath, JSON.stringify(normalizeParameters(body.parameters), null, 2), 'utf8');
            await runWorker();
            writeJson(response, 200, readGenerationManifest());
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : 'CAD 生成失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname === '/api/model/import-stl' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const originalFileName = basename(url.searchParams.get('fileName') ?? '');
            if (!originalFileName.toLowerCase().endsWith('.stl')) throw new Error('请选择 STL 文件');
            const fileBytes = await readBinaryBody(request);
            mkdirSync(artifactsDirectory, { recursive: true });
            writeFileSync(resolve(artifactsDirectory, 'imported-model.stl'), fileBytes);
            await runStlInspection(originalFileName);
            const summary = JSON.parse(
              readFileSync(resolve(artifactsDirectory, 'imported-model-result.json'), 'utf8')
            ) as Record<string, unknown>;
            writeJson(response, 200, summary);
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : 'STL 导入失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname === '/api/model/split' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const body = await readJsonBody(request) as {
              sourceKind?: string;
              sourcePartId?: string;
              axis?: string;
              offsetMm?: number;
              jointType?: string;
              fastenerType?: string;
              screwSize?: string;
              clearanceMm?: number;
            };
            await runSplitWorker(
              body.sourceKind ?? '',
              body.sourcePartId ?? '',
              body.axis ?? '',
              body.offsetMm ?? Number.NaN,
              body.jointType ?? '',
              body.fastenerType ?? '',
              body.screwSize ?? '',
              body.clearanceMm ?? Number.NaN
            );
            const summary = JSON.parse(
              readFileSync(resolve(artifactsDirectory, 'manufacturing-result.json'), 'utf8')
            ) as Record<string, unknown>;
            writeJson(response, 200, summary);
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : '精确拆件失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname === '/api/model/local-stl-edit' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const body = await readJsonBody(request) as Parameters<typeof runLocalStlEditWorker>[0];
            await runLocalStlEditWorker(body);
            const summary = JSON.parse(
              readFileSync(resolve(artifactsDirectory, 'local-stl-edit-result.json'), 'utf8')
            ) as Record<string, unknown>;
            writeJson(response, 200, summary);
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : '上传 STL 局部修改失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname === '/api/model/local-cad-feature' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const body = await readJsonBody(request) as Parameters<typeof runLocalCadFeatureWorker>[0];
            await runLocalCadFeatureWorker(body);
            const resultName = body.previewOnly
              ? 'local-cad-feature-preflight-result.json'
              : 'local-cad-feature-result.json';
            const summary = JSON.parse(
              readFileSync(resolve(artifactsDirectory, resultName), 'utf8')
            ) as Record<string, unknown>;
            writeJson(response, 200, summary);
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : '稳定 CAD 面局部特征失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname === '/api/model/cad-surface-hit' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const body = await readJsonBody(request) as Parameters<typeof runCadSurfaceHitWorker>[0];
            writeJson(response, 200, await runCadSurfaceHitWorker(body));
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : 'OpenCascade 曲面点击精确解析失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname === '/api/model/wall-thickness' && request.method === 'POST') {
          while (generating) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          generating = true;
          try {
            const body = await readJsonBody(request) as {
              sourceKind?: string;
              sourcePartId?: string;
              minimumWallMm?: number;
              sampleLimit?: number;
            };
            await runWallThicknessWorker(
              body.sourceKind ?? '',
              body.sourcePartId ?? '',
              body.minimumWallMm ?? 1.2,
              body.sampleLimit ?? 1200
            );
            const summary = JSON.parse(
              readFileSync(resolve(artifactsDirectory, 'wall-thickness-result.json'), 'utf8')
            ) as Record<string, unknown>;
            writeJson(response, 200, summary);
          } catch (error) {
            writeJson(response, 400, {
              status: 'error',
              message: error instanceof Error ? error.message : '壁厚分析失败'
            });
          } finally {
            generating = false;
          }
          return;
        }

        if (url.pathname.startsWith('/generated/')) {
          const fileName = basename(url.pathname);
          if (!generatedFiles().includes(fileName)) {
            writeJson(response, 404, { status: 'error', message: '不允许访问该生成文件' });
            return;
          }
          const filePath = resolve(artifactsDirectory, fileName);
          if (!existsSync(filePath)) {
            writeJson(response, 404, { status: 'error', message: '生成文件不存在' });
            return;
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', contentType(fileName));
          response.setHeader('Cache-Control', 'no-store');
          if (url.searchParams.get('download') === '1') {
            response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          }
          createReadStream(filePath).pipe(response);
          return;
        }

        next();
      });
    },
    generateBundle() {
      generatedFiles().forEach((fileName) => {
        const filePath = resolve(artifactsDirectory, fileName);
        if (!existsSync(filePath)) return;
        this.emitFile({
          type: 'asset',
          fileName: `generated/${fileName}`,
          source: readFileSync(filePath)
        });
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), cadWorkerPlugin()],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true
  },
  clearScreen: false
});
