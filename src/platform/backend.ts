import { invoke } from '@tauri-apps/api/core';
import type { ImageCalibration, ReferenceImageAnalysis } from '../model/imageRecognition';
import type { ImportedStlModel } from '../model/importedModel';
import type { LocalStlEditRequest, LocalStlEditResult } from '../model/localStlEdit';
import type { MeshElementEditResult, MeshElementMoveRequest } from '../model/meshElementEdit';
import type {
  CodexLocalCadFeaturePlan,
  LocalCadFeaturePreflightResult,
  LocalCadFeatureRequest,
  LocalCadFeatureResult
} from '../model/localCadFeature';
import type { ManufacturingSplitRequest, ManufacturingSplitResult } from '../model/manufacturing';
import type { WallThicknessAnalysisResult, WallThicknessRequest } from '../model/wallThickness';
import type { VersionGeometryDifferenceResult } from '../model/versionGeometryDifference';
import type { CadSurfaceHitRequest, CadSurfaceHitResult } from '../model/cadSurfaceHit';
import {
  screenshotDataUrlToBytes,
  type CadFaceSelectionContext
} from '../model/cadFaceSelection';
import type { TransformedExportRequest } from '../model/objectExport';
import type { EnclosureParameters, InterfaceOpeningSpec } from '../model/types';

export interface BackendStatus {
  mode: 'tauri' | 'web';
  projectRoot: string;
  cadWorkerAvailable: boolean;
  codexInstalled: boolean;
  codexAuthenticated: boolean;
  codexVersion: string | null;
}

export type VersionSnapshotModelSource = 'cad' | 'uploaded-stl';

export interface VersionSnapshot {
  id: string;
  label: string;
  directory: string;
  files: string[];
  modelSource: VersionSnapshotModelSource;
  modelRevision: string | null;
}

export interface UploadedModelSnapshotRestoreResult {
  status: 'ok';
  operation: 'restore-uploaded-model-snapshot';
  restoredRevision: string;
  sourceKind: 'uploaded-stl';
  updatedModel: ImportedStlModel;
}

function createBinaryObjectUrl(
  response: ArrayBuffer | Uint8Array | number[],
  mimeType: string
) {
  const bytes = response instanceof ArrayBuffer
    ? new Uint8Array(response)
    : response instanceof Uint8Array
      ? response
      : new Uint8Array(response);
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return URL.createObjectURL(new Blob([ownedBytes.buffer], { type: mimeType }));
}

export interface CodexParameterChange {
  parameter: keyof EnclosureParameters;
  value: number;
  reason: string;
}

export interface CodexModelCommandResult {
  summary: string;
  changes: CodexParameterChange[];
  /** 只有已验证的点击单平面上下文才允许返回；后端仍会强制绑定当前 partId/stableFaceId。 */
  localFeature: CodexLocalCadFeaturePlan | null;
}

export type ImageAnalysisResult = ReferenceImageAnalysis;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Returns true only inside the Tauri desktop WebView. */
export function isDesktopRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

/** Reads local CAD/Codex availability without exposing authentication details. */
export async function loadBackendStatus(): Promise<BackendStatus> {
  if (!isDesktopRuntime()) {
    return {
      mode: 'web',
      projectRoot: '',
      cadWorkerAvailable: true,
      codexInstalled: false,
      codexAuthenticated: false,
      codexVersion: null
    };
  }
  return invoke<BackendStatus>('backend_status');
}

/** Sends a modeling instruction to the locally authenticated Codex CLI. */
export async function runCodexModelCommand(
  command: string,
  parameters: EnclosureParameters,
  selectionContext?: CadFaceSelectionContext | null
) {
  const screenshotBytes = screenshotDataUrlToBytes(selectionContext?.screenshot ?? null);
  const serializableContext = selectionContext
    ? {
        ...selectionContext,
        screenshot: selectionContext.screenshot
          ? { ...selectionContext.screenshot, dataUrl: undefined }
          : null
      }
    : null;
  return invoke<CodexModelCommandResult>('run_codex_model_command', {
    command,
    parameters,
    selectionContext: serializableContext,
    screenshotBytes
  });
}


/** Uses the locally authenticated Codex vision input to inspect one reference photo. */
export async function analyzeReferenceImage(
  file: File,
  viewType: string,
  calibration: ImageCalibration,
  parameters: EnclosureParameters
) {
  if (!isDesktopRuntime()) {
    throw new Error('图片识别需要在 FormAI 桌面应用中运行');
  }
  const imageBytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<ImageAnalysisResult>('analyze_reference_image', {
    fileName: file.name,
    imageBytes,
    viewType,
    calibration,
    parameters
  });
}

/** Persists parameters and current CAD outputs before an AI mutation. */
export async function createVersionSnapshot(
  label: string,
  parameters: EnclosureParameters & { interfaceOpenings?: InterfaceOpeningSpec[] | null },
  options: {
    modelSource?: VersionSnapshotModelSource;
    modelRevision?: string | null;
  } = {}
) {
  if (!isDesktopRuntime()) return null;
  return invoke<VersionSnapshot>('create_version_snapshot', {
    label,
    parameters,
    modelSource: options.modelSource ?? 'cad',
    modelRevision: options.modelRevision ?? null
  });
}

/** 从受管版本目录原子恢复上传 STL 的完整工作 STL、STEP 和清单。 */
export async function restoreUploadedModelSnapshot(
  snapshotDirectory: string,
  expectedRevision: string
) {
  if (!isDesktopRuntime()) {
    throw new Error('上传模型精确版本恢复只能在 FormAI 桌面应用中执行');
  }
  return invoke<UploadedModelSnapshotRestoreResult>('restore_uploaded_model_snapshot', {
    snapshotDirectory,
    expectedRevision
  });
}

/** Copies one generated model into the user's Downloads directory in desktop mode. */
export async function exportGeneratedFile(fileName: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('export_generated_file', { fileName });
}

/** 将视口中的对象变换与颜色烘焙到 STL/3MF，并复制到用户下载目录。 */
export async function exportTransformedModel(request: TransformedExportRequest) {
  if (!isDesktopRuntime()) throw new Error('变换后的 STL/3MF 只能在 FormAI 桌面应用中导出');
  return invoke<string>('export_transformed_model', { request });
}

/** Loads a generated CAD file from the Rust backend as a temporary object URL. */
export async function readGeneratedFileUrl(fileName: string, mimeType: string) {
  if (!isDesktopRuntime()) return null;
  const response = await invoke<ArrayBuffer | Uint8Array | number[]>('read_generated_file', {
    fileName
  });
  return createBinaryObjectUrl(response, mimeType);
}

/** Loads the generation manifest saved inside one verified desktop version snapshot. */
export async function loadVersionSnapshot<T>(snapshotDirectory: string) {
  if (!isDesktopRuntime()) {
    throw new Error('精确版本实体只能在 FormAI 桌面应用中读取');
  }
  return invoke<T>('load_version_snapshot', { snapshotDirectory });
}

/** Reads a manifest-declared file from one verified desktop version snapshot. */
export async function readVersionSnapshotFileUrl(
  snapshotDirectory: string,
  fileName: string,
  mimeType: string
) {
  if (!isDesktopRuntime()) {
    throw new Error('精确版本实体只能在 FormAI 桌面应用中读取');
  }
  const response = await invoke<ArrayBuffer | Uint8Array | number[]>('read_version_snapshot_file', {
    snapshotDirectory,
    fileName
  });
  return createBinaryObjectUrl(response, mimeType);
}

/** 上传并校验一个用户自定义 STL；磁盘端始终使用安全的内部文件名。 */
export async function importStlModel(file: File) {
  if (!file.name.toLowerCase().endsWith('.stl')) {
    throw new Error('请选择 STL 文件');
  }
  if (file.size === 0) throw new Error('上传的 STL 文件为空');
  if (file.size > 50 * 1024 * 1024) throw new Error('STL 文件不能超过 50 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isDesktopRuntime()) {
    return invoke<ImportedStlModel>('import_stl_model', {
      fileName: file.name,
      fileBytes: Array.from(bytes)
    });
  }

  const response = await fetch(`/api/model/import-stl?fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'model/stl' },
    body: bytes
  });
  const result = await response.json() as ImportedStlModel | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : 'STL 导入失败');
  }
  return result;
}

/** 对当前 CAD 零件或上传 STL 执行 OpenCascade 平面拆件与补面校验。 */
export async function runManufacturingSplit(request: ManufacturingSplitRequest) {
  if (isDesktopRuntime()) {
    return invoke<ManufacturingSplitResult>('run_manufacturing_split', {
      sourceKind: request.sourceKind,
      sourcePartId: request.sourcePartId,
      axis: request.axis,
      offsetMm: request.offsetMm,
      jointType: request.jointType,
      fastenerType: request.fastenerType,
      screwSize: request.screwSize,
      clearanceMm: request.clearanceMm
    });
  }

  const response = await fetch('/api/model/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  const result = await response.json() as ManufacturingSplitResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : '精确拆件失败');
  }
  return result;
}

/** 对当前任意封闭 CAD 零件或上传 STL 执行全局壁厚采样估算。 */
export async function analyzeWallThickness(request: WallThicknessRequest) {
  const payload = {
    ...request,
    minimumWallMm: request.minimumWallMm ?? 1.2,
    sampleLimit: request.sampleLimit ?? 1200
  };
  if (isDesktopRuntime()) {
    return invoke<WallThicknessAnalysisResult>('analyze_wall_thickness', payload);
  }

  const response = await fetch('/api/model/wall-thickness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as WallThicknessAnalysisResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : '壁厚分析失败');
  }
  return result;
}


/** 对上传 STL 的选中表面执行第一版可验证局部圆柱加料或切除。 */
export async function runLocalStlEdit(request: LocalStlEditRequest) {
  const payload = {
    sourcePartId: request.sourcePartId,
    operation: request.operation,
    centerXmm: request.center.xMm,
    centerYmm: request.center.yMm,
    centerZmm: request.center.zMm,
    normalX: request.inwardNormal.x,
    normalY: request.inwardNormal.y,
    normalZ: request.inwardNormal.z,
    radiusMm: request.radiusMm,
    depthMm: request.depthMm,
    command: request.command
  };
  if (isDesktopRuntime()) {
    return invoke<LocalStlEditResult>('run_local_stl_edit', payload);
  }

  const response = await fetch('/api/model/local-stl-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as LocalStlEditResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : '上传 STL 局部修改失败');
  }
  return result;
}


/** 对任意上传 STL 的同类顶点、边或三角面集合执行安全批量位移。 */
export async function runMeshElementEdit(request: MeshElementMoveRequest) {
  const payload = {
    sourcePartId: request.selection.sourcePartId,
    selectionRevision: request.selection.revision,
    elementKind: request.selection.kind,
    selectionMethod: request.selection.selectionMethod,
    selections: request.selection.elements.map(({ triangleIndex, elementIndex, triangleMm }) => ({
      triangleIndex,
      elementIndex,
      triangleMm
    })),
    deltaXmm: request.displacementMm.x,
    deltaYmm: request.displacementMm.y,
    deltaZmm: request.displacementMm.z
  };
  if (isDesktopRuntime()) {
    return invoke<MeshElementEditResult>('run_mesh_element_edit', payload);
  }

  const response = await fetch('/api/model/mesh-element-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as MeshElementEditResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : '上传 STL 网格元素位移失败');
  }
  return result;
}

function localCadFeaturePayload(request: LocalCadFeatureRequest, previewOnly: boolean) {
  return {
    selectionRevision: request.selectionRevision,
    partId: request.partId,
    stableFaceId: request.stableFaceId,
    stableEdgeId: request.stableEdgeId,
    edgeTargets: request.edgeTargets,
    operation: request.operation,
    centerXmm: request.center.xMm,
    centerYmm: request.center.yMm,
    centerZmm: request.center.zMm,
    normalX: request.hitNormal.x,
    normalY: request.hitNormal.y,
    normalZ: request.hitNormal.z,
    surfaceTangentUx: request.surfaceTangentU?.x ?? null,
    surfaceTangentUy: request.surfaceTangentU?.y ?? null,
    surfaceTangentUz: request.surfaceTangentU?.z ?? null,
    surfaceGeometryType: request.surfaceGeometryType,
    surfaceU: request.surfaceUv.u,
    surfaceV: request.surfaceUv.v,
    radiusMm: request.radiusMm,
    widthMm: request.widthMm,
    heightMm: request.heightMm,
    lengthMm: request.lengthMm,
    depthMm: request.depthMm,
    rotationDeg: request.rotationDeg,
    command: request.command,
    previewOnly
  };
}

/** 在写入模型前生成 OpenCascade 精确工具体并执行结构化曲面干涉预检。 */
export async function preflightLocalCadFeature(request: LocalCadFeatureRequest) {
  const payload = localCadFeaturePayload(request, true);
  if (isDesktopRuntime()) {
    return invoke<LocalCadFeaturePreflightResult>('run_local_cad_feature', payload);
  }

  const response = await fetch('/api/model/local-cad-feature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as LocalCadFeaturePreflightResult | { message?: string };
  if (!response.ok || !('status' in result) || !['ok', 'blocked'].includes(result.status)) {
    throw new Error('message' in result && result.message ? result.message : '稳定 CAD 精确工具体预演失败');
  }
  return result as LocalCadFeaturePreflightResult;
}

/** 对点击选中的稳定 CAD 面执行受限局部特征；曲面允许圆形、矩形或受限槽孔。 */
export async function runLocalCadFeature(request: LocalCadFeatureRequest) {
  const payload = localCadFeaturePayload(request, false);
  if (isDesktopRuntime()) {
    return invoke<LocalCadFeatureResult>('run_local_cad_feature', payload);
  }

  const response = await fetch('/api/model/local-cad-feature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as LocalCadFeatureResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : '稳定 CAD 局部特征失败');
  }
  return result;
}

/** 把选择网格命中只读解析为当前 STEP 裁剪面上的真实 UV、投影点和外法线。 */
export async function resolveCadSurfaceHit(request: CadSurfaceHitRequest) {
  const payload = {
    selectionRevision: request.selectionRevision,
    partId: request.partId,
    stableFaceId: request.stableFaceId,
    triangleIndex: request.triangleIndex,
    pointX: request.pointMm.x,
    pointY: request.pointMm.y,
    pointZ: request.pointMm.z,
    normalX: request.meshNormal.x,
    normalY: request.meshNormal.y,
    normalZ: request.meshNormal.z
  };
  if (isDesktopRuntime()) {
    return invoke<CadSurfaceHitResult>('resolve_cad_surface_hit', payload);
  }

  const response = await fetch('/api/model/cad-surface-hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as CadSurfaceHitResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : 'OpenCascade 曲面点击精确解析失败');
  }
  return result;
}

/** 对一个本机版本快照与当前 CAD 执行 OpenCascade 精确布尔差集。 */
export async function runVersionGeometryDifference(snapshotDirectory: string) {
  if (!isDesktopRuntime()) {
    throw new Error('精确版本布尔差异只能在 FormAI 桌面应用中计算');
  }
  return invoke<VersionGeometryDifferenceResult>('run_version_geometry_difference', {
    snapshotDirectory
  });
}
