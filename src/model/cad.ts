import { invoke } from '@tauri-apps/api/core';
import {
  isDesktopRuntime,
  loadVersionSnapshot,
  readGeneratedFileUrl,
  readVersionSnapshotFileUrl
} from '../platform/backend';
import type {
  CurvedFeatureDiagnostics,
  EnclosureParameters,
  InterfaceOpeningSpec
} from './types';

export interface CadBounds {
  x: number;
  y: number;
  z: number;
}

export interface CadModelMetrics {
  valid: boolean;
  volumeMm3: number;
  boundsMm: CadBounds;
  fitsP1S: boolean;
}

export interface CadModelInfo {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
}

export interface CadFaceBounds {
  x: number;
  y: number;
  z: number;
}

export interface CadEdgeDescriptor {
  stableId: string;
  geometryType: string;
  lengthMm: number;
  centerMm: [number, number, number];
  startMm: [number, number, number];
  endMm: [number, number, number];
  samplePointsMm: Array<[number, number, number]>;
  normalizedCenter: [number, number, number];
  normalizedLength: number;
  normalizedEndpoints: Array<[number, number, number]>;
  fingerprint: string;
  matchSource: 'inherited' | 'new';
}

export interface CadFaceDescriptor {
  stableId: string;
  geometryType: string;
  areaMm2: number;
  centerMm: [number, number, number];
  normal?: [number, number, number];
  boundsMm: CadFaceBounds;
  normalizedCenter: [number, number, number];
  normalizedBounds: [number, number, number];
  areaRatio: number;
  edgeCount: number;
  edgeGeometryTypes: Record<string, number>;
  edges?: CadEdgeDescriptor[];
  fingerprint: string;
  matchSource: 'inherited' | 'new';
  matchConfidence: number;
  matchedPreviousFingerprint?: string;
}

export interface CadFaceMatchingSummary {
  method: '几何签名匹配第一版' | string;
  previousFaceCount: number;
  currentFaceCount: number;
  inheritedFaceCount: number;
  newFaceCount: number;
  disappearedFaceCount: number;
  averageInheritedConfidence: number | null;
  matchThreshold?: number;
  warning: string;
}

export interface CadFaceTriangleRange {
  stableId: string;
  geometryType: string;
  triangleStart: number;
  triangleCount: number;
  areaMm2: number;
  centerMm: [number, number, number];
  normal?: [number, number, number];
}

export interface CadFaceTessellationMapping {
  status: 'ok';
  version: 1 | number;
  partId: string;
  units: 'mm';
  coordinateSystem: string;
  method: string;
  sourceStlFile: string;
  selectionMeshFile: string;
  mappingFile: string;
  triangleCount: number;
  faceCount: number;
  linearToleranceMm: number;
  angularToleranceRad: number;
  faces: CadFaceTriangleRange[];
  warning: string;
}

export interface CadPartDescriptor {
  id: string;
  label: string;
  role: 'primary' | 'cover' | string;
  stlFile: string;
  stepFile: string;
  metrics: CadModelMetrics;
  faces?: CadFaceDescriptor[];
  faceMatching?: CadFaceMatchingSummary;
  faceTessellation?: CadFaceTessellationMapping;
}

export interface CadLocalFeatureRecord {
  revision: string;
  operation: 'add-cylinder' | 'cut-cylinder' | 'add-rectangle' | 'cut-rectangle' | 'cut-slot' | 'offset-face-outward' | 'offset-face-inward' | 'fillet-edge' | 'chamfer-edge' | 'fillet-edge-loop' | 'chamfer-edge-loop' | 'fillet-edge-chain' | 'chamfer-edge-chain';
  partId: string;
  stableFaceId: string;
  stableEdgeId?: string | null;
  centerMm: { x: number; y: number; z: number };
  outwardNormal: { x: number; y: number; z: number };
  surfaceGeometryType?: string;
  surfaceUv?: { u: number; v: number } | null;
  /** 当前修订中由 OpenCascade 在真实 UV 点击位置计算的单位 U 切向。 */
  surfaceTangentU?: { x: number; y: number; z: number } | null;
  radiusMm: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  lengthMm?: number | null;
  depthMm: number;
  rotationDeg?: number;
  command: string;
  stableFaceStatus: 'inherited' | 'disappeared';
  stableEdgeStatus?: 'inherited' | 'disappeared' | null;
  /** 修改前目标面的几何签名快照，用于目标面在最终实体中消失后的安全重放。 */
  targetFace?: CadFaceDescriptor;
  targetEdge?: CadEdgeDescriptor | null;
  createdRevision?: string;
  replayStatus?: 'recorded' | 'replayed';
  replayedRevision?: string | null;
  failureReason?: string | null;
  curvedDiagnostics?: CurvedFeatureDiagnostics;
}

export interface CadGenerationResult {
  status: 'ok';
  revision: string;
  outputs: string[];
  units: 'mm';
  kernel: string;
  printer: {
    model: string;
    buildVolumeMm: [number, number, number];
    nozzleMm: number;
  };
  model: CadModelInfo;
  parameters: Record<string, number>;
  interfaceOpeningMode: 'legacy-template' | 'custom';
  interfaceOpenings: InterfaceOpeningSpec[];
  faceMatching?: CadFaceMatchingSummary;
  openingValidation: {
    count: number;
    bodyCount: number;
    coverCount: number;
    minimumEdgeMarginMm: number | null;
    minimumSpacingMm: number | null;
  };
  parts: CadPartDescriptor[];
  assemblyFile: string;
  files: Record<string, { bytes: number }>;
  /** 当前实体上已执行、并会在参数化整模重建时按顺序安全重放的确定性局部特征。 */
  localFeatures?: CadLocalFeatureRecord[];
  localFeatureReplay?: {
    status: 'none' | 'ok';
    requestedCount: number;
    replayedCount: number;
    revision: string;
  };
}

export interface CadStableFaceComparison {
  available: boolean;
  baseFaceCount: number;
  currentFaceCount: number;
  sharedStableIdCount: number;
  addedStableIdCount: number;
  disappearedStableIdCount: number;
}

/** Compares first-version geometric face IDs across two manifests without claiming permanent topology naming. */
export function compareCadStableFaceIds(
  baseResult: Pick<CadGenerationResult, 'parts'> | null,
  currentResult: Pick<CadGenerationResult, 'parts'> | null
): CadStableFaceComparison {
  const collect = (result: Pick<CadGenerationResult, 'parts'> | null) => new Set(
    result?.parts.flatMap((part) => part.faces?.map((face) => `${part.id}:${face.stableId}`) ?? []) ?? []
  );
  const baseIds = collect(baseResult);
  const currentIds = collect(currentResult);
  const available = baseIds.size > 0 && currentIds.size > 0;
  if (!available) {
    return {
      available: false,
      baseFaceCount: baseIds.size,
      currentFaceCount: currentIds.size,
      sharedStableIdCount: 0,
      addedStableIdCount: 0,
      disappearedStableIdCount: 0
    };
  }
  const sharedStableIdCount = [...currentIds].filter((stableId) => baseIds.has(stableId)).length;
  return {
    available: true,
    baseFaceCount: baseIds.size,
    currentFaceCount: currentIds.size,
    sharedStableIdCount,
    addedStableIdCount: currentIds.size - sharedStableIdCount,
    disappearedStableIdCount: baseIds.size - sharedStableIdCount
  };
}

/** Finds a generated part by its stable project identifier. */
export function findCadPartById(result: CadGenerationResult | null, partId: string) {
  return result?.parts.find((part) => part.id === partId) ?? null;
}

/** Finds the first generated part assigned to a semantic role. */
export function findCadPartByRole(result: CadGenerationResult | null, role: string) {
  return result?.parts.find((part) => part.role === role) ?? null;
}

export function generatedModelUrl(fileName: string, revision?: string) {
  const query = revision ? `?revision=${encodeURIComponent(revision)}` : '';
  return `/generated/${fileName}${query}`;
}

export function generatedDownloadUrl(fileName: string) {
  return `/generated/${fileName}?download=1`;
}

/** Resolves a generated model to HTTP in web mode or a Rust IPC blob in desktop mode. */
export async function resolveGeneratedModelUrl(fileName: string, revision?: string) {
  if (!isDesktopRuntime()) return generatedModelUrl(fileName, revision);
  const extension = fileName.split('.').at(-1)?.toLowerCase();
  const mimeType = extension === 'stl'
    ? 'model/stl'
    : extension === '3mf'
      ? 'model/3mf'
      : 'application/octet-stream';
  return readGeneratedFileUrl(fileName, mimeType);
}

/** Loads the exact generation manifest preserved for one desktop version. */
export async function loadVersionSnapshotCadResult(snapshotDirectory: string) {
  return loadVersionSnapshot<CadGenerationResult>(snapshotDirectory);
}

/** Resolves an STL declared by a verified desktop version snapshot. */
export async function resolveVersionSnapshotModelUrl(
  snapshotDirectory: string,
  fileName: string
) {
  const extension = fileName.split('.').at(-1)?.toLowerCase();
  const mimeType = extension === 'stl' ? 'model/stl' : 'application/octet-stream';
  return readVersionSnapshotFileUrl(snapshotDirectory, fileName, mimeType);
}

/** Generates an exact solid through Rust IPC in Tauri and the Vite bridge in browser mode. */
export async function generateCadModel(
  parameters: EnclosureParameters,
  interfaceOpenings?: InterfaceOpeningSpec[]
) {
  const payload = interfaceOpenings === undefined
    ? parameters
    : { ...parameters, interfaceOpenings };
  if (isDesktopRuntime()) {
    return invoke<CadGenerationResult>('generate_cad', { parameters: payload });
  }

  const response = await fetch('/api/model/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: payload })
  });
  const result = await response.json() as CadGenerationResult | { message?: string };
  if (!response.ok || !('status' in result) || result.status !== 'ok') {
    throw new Error('message' in result && result.message ? result.message : '精确 CAD 生成失败');
  }
  return result;
}

/** Loads the latest generation summary from the matching runtime backend. */
export async function loadCadGenerationResult() {
  if (isDesktopRuntime()) {
    try {
      const url = await readGeneratedFileUrl('generation-result.json', 'application/json');
      if (!url) return null;
      try {
        const response = await fetch(url);
        return await response.json() as CadGenerationResult;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      return null;
    }
  }

  const response = await fetch(generatedModelUrl('generation-result.json'), { cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
  return response.json() as Promise<CadGenerationResult>;
}
