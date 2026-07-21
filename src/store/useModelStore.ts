import { create } from 'zustand';
import {
  findCadPartByRole,
  generateCadModel,
  loadCadGenerationResult,
  loadVersionSnapshotCadResult,
  type CadGenerationResult
} from '../model/cad';
import { analyzeModelCommand } from '../model/commands';
import { DEFAULT_PARAMETERS, PARAMETER_LIMITS } from '../model/defaults';
import { resolveInterfaceOpeningsForParameters } from '../model/interfaceOpenings';
import {
  analyzeWallThickness as analyzeWallThicknessBackend,
  createVersionSnapshot,
  importStlModel as importStlModelBackend,
  loadBackendStatus,
  preflightLocalCadFeature,
  runCodexModelCommand,
  runLocalCadFeature,
  runLocalStlEdit,
  runManufacturingSplit,
  resolveCadSurfaceHit,
  runVersionGeometryDifference,
  type BackendStatus
} from '../platform/backend';
import type { DetectedInterface, ReferenceImageMetadata } from '../model/imageRecognition';
import type { MultiViewCalibrationResult, ReferenceViewRecord } from '../model/multiViewCalibration';
import { describeMeshRepair, type ImportedStlModel } from '../model/importedModel';
import {
  buildCadFaceSelectionCommandContext,
  type CadFaceBoxSelectionRequest,
  type CadFaceSelectionContext,
  type CadFaceSelectionMode,
  type CadSelectedEdgeTarget
} from '../model/cadFaceSelection';
import {
  applyCadSurfaceHitResult,
  applyCadSurfaceHitResultToEdgeTarget,
  buildCadSurfaceHitRequest,
  buildCadSurfaceHitRequestForEdgeTarget,
  failCadSurfaceHitEdgeTarget,
  failCadSurfaceHitSelection
} from '../model/cadSurfaceHit';
import { parseLocalStlEditCommand, type LocalStlEditResult } from '../model/localStlEdit';
import {
  buildLocalCadFeatureRequest,
  buildLocalCadFeatureRequestFromPlan,
  createLocalCadFeaturePreview,
  describeCadSurfaceGeometryType,
  type LocalCadFeaturePreview
} from '../model/localCadFeature';
import {
  appendLocalCadFeaturePreflightRecord,
  createLocalCadFeaturePreflightRecord,
  linkLocalCadFeaturePreflightExecution,
  type LocalCadFeaturePreflightRecord
} from '../model/localCadFeaturePreflightHistory';
import type { VersionGeometryComparisonMode } from '../model/versionGeometryComparison';
import type { VersionGeometryDifferenceResult } from '../model/versionGeometryDifference';
import { captureVersionCurvedFeatures } from '../model/versionCurvedFeatures';
import type {
  ManufacturingSplitRequest,
  ManufacturingSplitResult
} from '../model/manufacturing';
import {
  buildWallThicknessCommandContext,
  describeWallThicknessRisk,
  findNearestWallThicknessSample,
  findThinnestWallThicknessSample,
  type WallThicknessAnalysisResult,
  type WallThicknessRequest,
  type WallThicknessSample,
  type WallThicknessSelection
} from '../model/wallThickness';
import type {
  ChatMessage,
  EnclosureParameters,
  InterfaceOpeningSpec,
  ModelVersion,
  SceneObjectId
} from '../model/types';

export type ViewportModelSource = 'cad' | 'preview' | 'uploaded-stl';
export type CadStatus = 'loading' | 'ready' | 'stale' | 'generating' | 'error';
export type AiStatus = 'checking' | 'ready' | 'local' | 'running' | 'error';
export type ManufacturingStatus = 'idle' | 'generating' | 'ready' | 'error';
export type ImportedStlStatus = 'idle' | 'importing' | 'ready' | 'error';
export type WallThicknessStatus = 'idle' | 'analyzing' | 'ready' | 'error';
export type VersionGeometryComparisonStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ModelStore {
  parameters: EnclosureParameters;
  versions: ModelVersion[];
  versionIndex: number;
  selectedObject: SceneObjectId;
  exploded: boolean;
  showBoard: boolean;
  messages: ChatMessage[];
  viewportModelSource: ViewportModelSource;
  cadStatus: CadStatus;
  cadResult: CadGenerationResult | null;
  cadError: string | null;
  backendStatus: BackendStatus | null;
  aiStatus: AiStatus;
  aiActivity: string | null;
  aiError: string | null;
  referenceImage: ReferenceImageMetadata | null;
  referenceImages: ReferenceViewRecord[];
  multiViewCalibration: MultiViewCalibrationResult | null;
  detectedInterfaces: DetectedInterface[];
  /** null 表示继续使用模板默认 USB 开孔；数组表示照片/人工确认后的通用开孔覆盖。 */
  interfaceOpenings: InterfaceOpeningSpec[] | null;
  importedStlModel: ImportedStlModel | null;
  importedStlStatus: ImportedStlStatus;
  importedStlError: string | null;
  localStlEditResult: LocalStlEditResult | null;
  manufacturingStatus: ManufacturingStatus;
  manufacturingResult: ManufacturingSplitResult | null;
  manufacturingError: string | null;
  wallThicknessStatus: WallThicknessStatus;
  wallThicknessResult: WallThicknessAnalysisResult | null;
  wallThicknessError: string | null;
  wallThicknessVisible: boolean;
  wallThicknessPicking: boolean;
  wallThicknessSelection: WallThicknessSelection | null;
  cadFaceSelectionMode: CadFaceSelectionMode;
  cadFaceSelection: CadFaceSelectionContext | null;
  localCadFeaturePreview: LocalCadFeaturePreview | null;
  /** 独立于模型版本的精确预检留档，包含被阻断且没有写入模型的尝试。 */
  localCadFeaturePreflightHistory: LocalCadFeaturePreflightRecord[];
  cadFaceBoxRequest: CadFaceBoxSelectionRequest | null;
  versionGeometryComparisonMode: VersionGeometryComparisonMode;
  versionGeometryComparisonBaseId: string | null;
  versionGeometryComparisonSnapshot: CadGenerationResult | null;
  versionGeometryDifferenceResult: VersionGeometryDifferenceResult | null;
  versionGeometryComparisonStatus: VersionGeometryComparisonStatus;
  versionGeometryComparisonError: string | null;
  setParameter: (key: keyof EnclosureParameters, value: number) => void;
  commitVersion: (label: string) => void;
  undo: () => void;
  redo: () => void;
  restoreVersion: (versionId: string) => void;
  selectObject: (id: SceneObjectId) => void;
  setExploded: (value: boolean) => void;
  setShowBoard: (value: boolean) => void;
  setViewportModelSource: (source: ViewportModelSource) => void;
  resetProject: () => void;
  addAssistantMessage: (content: string) => void;
  setReferenceImage: (image: ReferenceImageMetadata | null) => void;
  setReferenceImages: (images: ReferenceViewRecord[]) => void;
  upsertReferenceImage: (image: ReferenceViewRecord) => void;
  removeReferenceImage: (id: string) => void;
  setMultiViewCalibration: (result: MultiViewCalibrationResult | null) => void;
  setDetectedInterfaces: (interfaces: DetectedInterface[]) => void;
  setInterfaceOpenings: (openings: InterfaceOpeningSpec[] | null) => void;
  importStlModel: (file: File) => Promise<ImportedStlModel | null>;
  clearImportedStlModel: () => void;
  runManufacturingSplit: (request: ManufacturingSplitRequest) => Promise<ManufacturingSplitResult | null>;
  clearManufacturingSplit: () => void;
  analyzeWallThickness: (request: WallThicknessRequest) => Promise<WallThicknessAnalysisResult | null>;
  setWallThicknessVisible: (visible: boolean) => void;
  setWallThicknessPicking: (picking: boolean) => void;
  selectWallThicknessSample: (sample: WallThicknessSample) => void;
  selectThinnestWallThicknessSample: () => void;
  clearWallThicknessSelection: () => void;
  clearWallThicknessAnalysis: () => void;
  setCadFaceSelectionMode: (mode: CadFaceSelectionMode) => void;
  selectCadFaces: (selection: CadFaceSelectionContext) => void;
  resolveCadSurfaceHitSelection: (selection: CadFaceSelectionContext, edgeTarget?: CadSelectedEdgeTarget) => Promise<void>;
  requestCadFaceBoxSelection: (request: CadFaceBoxSelectionRequest) => void;
  clearCadFaceSelection: () => void;
  clearLocalCadFeaturePreview: () => void;
  clearLocalCadFeaturePreflightHistory: () => void;
  focusLocalCadFeatureInterferenceFace: (stableFaceId: string) => void;
  openVersionGeometryComparison: (
    versionId: string,
    mode: Exclude<VersionGeometryComparisonMode, 'off'>
  ) => Promise<boolean>;
  setVersionGeometryComparisonMode: (
    mode: Exclude<VersionGeometryComparisonMode, 'off'>
  ) => void;
  closeVersionGeometryComparison: () => void;
  initializeBackend: () => Promise<void>;
  saveCurrentVersion: (label?: string) => Promise<void>;
  hydrateCadResult: () => Promise<void>;
  generateCad: (parameters?: EnclosureParameters) => Promise<CadGenerationResult | null>;
  executeCommand: (command: string) => Promise<void>;
}

const initialVersion: ModelVersion = {
  id: crypto.randomUUID(),
  label: '初始模型',
  createdAt: new Date().toISOString(),
  parameters: { ...DEFAULT_PARAMETERS },
  interfaceOpenings: null
};

let generationSerial = 0;
let versionComparisonSerial = 0;

/** 给 React 和 WebGL 至少一个浏览器任务周期来显示自动执行前预览。 */
function waitForLocalCadFeaturePreviewFrame() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const cadParameterNames: Record<keyof EnclosureParameters, string> = {
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
  usbPortOffsetY: 'usb_port_offset_y',
  boardOffsetX: 'board_offset_x',
  boardOffsetZ: 'board_offset_z'
};

function cadResultMatchesParameters(result: CadGenerationResult, parameters: EnclosureParameters) {
  return (Object.keys(parameters) as Array<keyof EnclosureParameters>).every((key) => {
    const workerName = cadParameterNames[key];
    return !(workerName in result.parameters) || result.parameters[workerName] === parameters[key];
  });
}

function clampParameter(key: keyof EnclosureParameters, value: number) {
  const [minimum, maximum] = PARAMETER_LIMITS[key];
  return Math.min(maximum, Math.max(minimum, value));
}

function withStaleCad(state: Pick<ModelStore, 'cadStatus'>) {
  return state.cadStatus === 'generating' ? state.cadStatus : 'stale';
}

function isParameterName(value: string): value is keyof EnclosureParameters {
  return value in PARAMETER_LIMITS;
}

const REFERENCE_STATE_STORAGE_KEY = 'formai-multi-view-reference-state-v1';

interface PersistedReferenceState {
  referenceImages: ReferenceViewRecord[];
  multiViewCalibration: MultiViewCalibrationResult | null;
}

function loadPersistedReferenceState(): PersistedReferenceState {
  if (typeof window === 'undefined') {
    return { referenceImages: [], multiViewCalibration: null };
  }
  try {
    const stored = window.localStorage.getItem(REFERENCE_STATE_STORAGE_KEY);
    if (!stored) return { referenceImages: [], multiViewCalibration: null };
    const parsed = JSON.parse(stored) as Partial<PersistedReferenceState>;
    return {
      referenceImages: Array.isArray(parsed.referenceImages) ? parsed.referenceImages : [],
      multiViewCalibration: parsed.multiViewCalibration ?? null
    };
  } catch {
    return { referenceImages: [], multiViewCalibration: null };
  }
}

function persistReferenceState(state: PersistedReferenceState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REFERENCE_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 本地存储不可用时仍保留当前运行会话中的联合标定状态。
  }
}

const persistedReferenceState = loadPersistedReferenceState();

export const useModelStore = create<ModelStore>((set, get) => ({
  parameters: { ...DEFAULT_PARAMETERS },
  versions: [initialVersion],
  versionIndex: 0,
  selectedObject: 'body',
  exploded: false,
  showBoard: true,
  viewportModelSource: 'cad',
  cadStatus: 'loading',
  cadResult: null,
  cadError: null,
  backendStatus: null,
  aiStatus: 'checking',
  aiActivity: '正在检查本机建模环境',
  aiError: null,
  referenceImage: persistedReferenceState.referenceImages[0]
    ? {
        fileName: persistedReferenceState.referenceImages[0].fileName,
        viewType: persistedReferenceState.referenceImages[0].viewType,
        calibration: persistedReferenceState.referenceImages[0].calibration,
        importedAt: persistedReferenceState.referenceImages[0].importedAt
      }
    : null,
  referenceImages: persistedReferenceState.referenceImages,
  multiViewCalibration: persistedReferenceState.multiViewCalibration,
  detectedInterfaces: [],
  interfaceOpenings: null,
  importedStlModel: null,
  importedStlStatus: 'idle',
  importedStlError: null,
  localStlEditResult: null,
  manufacturingStatus: 'idle',
  manufacturingResult: null,
  manufacturingError: null,
  wallThicknessStatus: 'idle',
  wallThicknessResult: null,
  wallThicknessError: null,
  wallThicknessVisible: false,
  wallThicknessPicking: false,
  wallThicknessSelection: null,
  cadFaceSelectionMode: 'off',
  cadFaceSelection: null,
  localCadFeaturePreview: null,
  localCadFeaturePreflightHistory: [],
  cadFaceBoxRequest: null,
  versionGeometryComparisonMode: 'off',
  versionGeometryComparisonBaseId: null,
  versionGeometryComparisonSnapshot: null,
  versionGeometryDifferenceResult: null,
  versionGeometryComparisonStatus: 'idle',
  versionGeometryComparisonError: null,
  messages: [
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '基础模型已生成。桌面模式会通过本机 Codex 规划修改，再由 OpenCascade 自动重建。'
    }
  ],
  setParameter: (key, value) => {
    versionComparisonSerial += 1;
    set((state) => {
      const parameters = {
        ...state.parameters,
        [key]: clampParameter(key, value)
      };
      return {
        parameters,
        interfaceOpenings: resolveInterfaceOpeningsForParameters(state.interfaceOpenings, parameters),
        cadStatus: withStaleCad(state),
        cadError: null,
        manufacturingStatus: 'idle',
        manufacturingResult: null,
        manufacturingError: null,
        wallThicknessStatus: 'idle',
        wallThicknessResult: null,
        wallThicknessError: null,
        wallThicknessVisible: false,
        wallThicknessPicking: false,
        wallThicknessSelection: null,
        cadFaceSelectionMode: 'off',
        cadFaceSelection: null,
        localCadFeaturePreview: null,
        cadFaceBoxRequest: null,
        versionGeometryComparisonMode: 'off',
        versionGeometryComparisonBaseId: null,
        versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
        versionGeometryComparisonStatus: 'idle',
        versionGeometryComparisonError: null
      };
    });
  },
  commitVersion: (label) => {
    const state = get();
    const nextVersion: ModelVersion = {
      id: crypto.randomUUID(),
      label,
      createdAt: new Date().toISOString(),
      parameters: { ...state.parameters },
      interfaceOpenings: state.interfaceOpenings?.map((opening) => ({ ...opening })) ?? state.interfaceOpenings,
      curvedFeatures: captureVersionCurvedFeatures(state.cadResult)
    };
    const versions = state.versions.slice(0, state.versionIndex + 1).concat(nextVersion);
    set({ versions, versionIndex: versions.length - 1 });
  },
  undo: () => {
    const state = get();
    if (state.versionIndex === 0) return;
    get().restoreVersion(state.versions[state.versionIndex - 1].id);
  },
  redo: () => {
    const state = get();
    if (state.versionIndex >= state.versions.length - 1) return;
    get().restoreVersion(state.versions[state.versionIndex + 1].id);
  },
  restoreVersion: (versionId) => {
    versionComparisonSerial += 1;
    const state = get();
    const versionIndex = state.versions.findIndex((version) => version.id === versionId);
    if (versionIndex < 0 || versionIndex === state.versionIndex) return;
    const version = state.versions[versionIndex];
    set({
      versionIndex,
      parameters: { ...version.parameters },
      interfaceOpenings: version.interfaceOpenings?.map((opening) => ({ ...opening }))
        ?? version.interfaceOpenings
        ?? null,
      viewportModelSource: 'cad',
      cadStatus: 'stale',
      cadError: null,
      manufacturingStatus: 'idle',
      manufacturingResult: null,
      manufacturingError: null,
      wallThicknessStatus: 'idle',
      wallThicknessResult: null,
      wallThicknessError: null,
      wallThicknessVisible: false,
      wallThicknessPicking: false,
      wallThicknessSelection: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null,
      versionGeometryComparisonMode: 'off',
      versionGeometryComparisonBaseId: null,
      versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
      versionGeometryComparisonStatus: 'idle',
      versionGeometryComparisonError: null
    });
  },
  selectObject: (selectedObject) => set((state) => ({
    selectedObject,
    localCadFeaturePreview: state.localCadFeaturePreview?.request.partId === selectedObject
      ? state.localCadFeaturePreview
      : null
  })),
  setExploded: (exploded) => set({ exploded }),
  setShowBoard: (showBoard) => set({ showBoard }),
  setViewportModelSource: (viewportModelSource) => {
    versionComparisonSerial += 1;
    set({
      viewportModelSource,
      wallThicknessVisible: false,
      wallThicknessPicking: false,
      wallThicknessSelection: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null,
      versionGeometryComparisonMode: 'off',
      versionGeometryComparisonBaseId: null,
      versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
      versionGeometryComparisonStatus: 'idle',
      versionGeometryComparisonError: null
    });
  },
  resetProject: () => {
    generationSerial += 1;
    versionComparisonSerial += 1;
    persistReferenceState({ referenceImages: [], multiViewCalibration: null });
    const version: ModelVersion = {
      id: crypto.randomUUID(),
      label: '新模型画布',
      createdAt: new Date().toISOString(),
      parameters: { ...DEFAULT_PARAMETERS },
      interfaceOpenings: null
    };
    set({
      parameters: { ...DEFAULT_PARAMETERS },
      versions: [version],
      versionIndex: 0,
      selectedObject: 'body',
      exploded: false,
      showBoard: true,
      viewportModelSource: 'cad',
      cadStatus: 'stale',
      cadResult: null,
      cadError: null,
      aiError: null,
      referenceImage: null,
      referenceImages: [],
      multiViewCalibration: null,
      detectedInterfaces: [],
      interfaceOpenings: null,
      localCadFeaturePreflightHistory: [],
      importedStlModel: null,
      importedStlStatus: 'idle',
      importedStlError: null,
      localStlEditResult: null,
      manufacturingStatus: 'idle',
      manufacturingResult: null,
      manufacturingError: null,
      wallThicknessStatus: 'idle',
      wallThicknessResult: null,
      wallThicknessError: null,
      wallThicknessVisible: false,
      wallThicknessPicking: false,
      wallThicknessSelection: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null,
      versionGeometryComparisonMode: 'off',
      versionGeometryComparisonBaseId: null,
      versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
      versionGeometryComparisonStatus: 'idle',
      versionGeometryComparisonError: null,
      messages: [{
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '已创建新模型画布。可以导入照片、输入元件尺寸，或直接让 Codex 开始建模。'
      }]
    });
  },
  addAssistantMessage: (content) =>
    set((state) => ({
      messages: state.messages.concat({ id: crypto.randomUUID(), role: 'assistant', content })
    })),
  setReferenceImage: (referenceImage) => set({ referenceImage }),
  setReferenceImages: (referenceImages) => {
    persistReferenceState({ referenceImages, multiViewCalibration: get().multiViewCalibration });
    set({ referenceImages });
  },
  upsertReferenceImage: (image) => set((state) => {
    const referenceImages = state.referenceImages.some((item) => item.id === image.id)
      ? state.referenceImages.map((item) => item.id === image.id ? image : item)
      : state.referenceImages.concat(image);
    persistReferenceState({ referenceImages, multiViewCalibration: state.multiViewCalibration });
    return { referenceImages };
  }),
  removeReferenceImage: (id) => set((state) => {
    const referenceImages = state.referenceImages.filter((item) => item.id !== id);
    persistReferenceState({ referenceImages, multiViewCalibration: null });
    return { referenceImages, multiViewCalibration: null };
  }),
  setMultiViewCalibration: (multiViewCalibration) => {
    persistReferenceState({ referenceImages: get().referenceImages, multiViewCalibration });
    set({ multiViewCalibration });
  },
  setDetectedInterfaces: (detectedInterfaces) => set({ detectedInterfaces }),
  setInterfaceOpenings: (interfaceOpenings) => set((state) => ({
    interfaceOpenings: resolveInterfaceOpeningsForParameters(interfaceOpenings, state.parameters),
    cadStatus: withStaleCad(state),
    cadError: null,
    manufacturingStatus: 'idle',
    manufacturingResult: null,
    manufacturingError: null,
    wallThicknessStatus: 'idle',
    wallThicknessResult: null,
    wallThicknessError: null,
    wallThicknessVisible: false,
    wallThicknessPicking: false,
    wallThicknessSelection: null,
    cadFaceSelectionMode: 'off',
    cadFaceSelection: null,
    localCadFeaturePreview: null,
    cadFaceBoxRequest: null
  })),
  importStlModel: async (file) => {
    set({
      importedStlStatus: 'importing',
      importedStlError: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null
    });
    try {
      const importedStlModel = await importStlModelBackend(file);
      const bounds = importedStlModel.metrics.boundsMm;
      set((state) => ({
        importedStlModel,
        importedStlStatus: 'ready',
        importedStlError: null,
        localStlEditResult: null,
        manufacturingStatus: 'idle',
        manufacturingResult: null,
        manufacturingError: null,
        wallThicknessStatus: 'idle',
        wallThicknessResult: null,
        wallThicknessError: null,
        wallThicknessVisible: false,
        wallThicknessPicking: false,
        wallThicknessSelection: null,
        cadFaceSelectionMode: 'off',
        cadFaceSelection: null,
        localCadFeaturePreview: null,
        cadFaceBoxRequest: null,
        viewportModelSource: 'uploaded-stl',
        selectedObject: importedStlModel.id,
        exploded: false,
        messages: state.messages.concat({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `已导入 STL“${importedStlModel.originalFileName}”，识别到 ${importedStlModel.metrics.triangleCount.toLocaleString()} 个三角面、${importedStlModel.metrics.solidCount} 个封闭实体；尺寸 ${bounds.x.toFixed(2)} × ${bounds.y.toFixed(2)} × ${bounds.z.toFixed(2)} 毫米，体积 ${importedStlModel.metrics.volumeMm3.toFixed(2)} 立方毫米。${describeMeshRepair(importedStlModel.metrics.repair)}。现在可以选择任意轴和平面执行拆件与切割面自动补面。`
        })
      }));
      return importedStlModel;
    } catch (error) {
      set({
        importedStlStatus: 'error',
        importedStlError: error instanceof Error ? error.message : 'STL 导入失败'
      });
      return null;
    }
  },
  clearImportedStlModel: () => set({
    importedStlModel: null,
    importedStlStatus: 'idle',
    importedStlError: null,
    localStlEditResult: null,
    manufacturingStatus: 'idle',
    manufacturingResult: null,
    manufacturingError: null,
    wallThicknessStatus: 'idle',
    wallThicknessResult: null,
    wallThicknessError: null,
    wallThicknessVisible: false,
    wallThicknessPicking: false,
    wallThicknessSelection: null,
    cadFaceSelectionMode: 'off',
    cadFaceSelection: null,
    localCadFeaturePreview: null,
    cadFaceBoxRequest: null,
    viewportModelSource: 'cad',
    exploded: false
  }),
  runManufacturingSplit: async (request) => {
    set({
      manufacturingStatus: 'generating',
      manufacturingError: null,
      wallThicknessStatus: 'idle',
      wallThicknessResult: null,
      wallThicknessError: null,
      wallThicknessVisible: false,
      wallThicknessPicking: false,
      wallThicknessSelection: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null
    });
    try {
      const manufacturingResult = await runManufacturingSplit(request);
      set({
        manufacturingStatus: 'ready',
        manufacturingResult,
        manufacturingError: null,
        viewportModelSource: request.sourceKind === 'uploaded-stl' ? 'uploaded-stl' : 'cad',
        exploded: true
      });
      return manufacturingResult;
    } catch (error) {
      set({
        manufacturingStatus: 'error',
        manufacturingResult: null,
        manufacturingError: error instanceof Error ? error.message : '精确拆件失败'
      });
      return null;
    }
  },
  clearManufacturingSplit: () => set({
    manufacturingStatus: 'idle',
    manufacturingResult: null,
    manufacturingError: null,
    wallThicknessStatus: 'idle',
    wallThicknessResult: null,
    wallThicknessError: null,
    wallThicknessVisible: false,
    wallThicknessPicking: false,
    wallThicknessSelection: null,
    cadFaceSelectionMode: 'off',
    cadFaceSelection: null,
    localCadFeaturePreview: null,
    cadFaceBoxRequest: null
  }),
  analyzeWallThickness: async (request) => {
    set({
      wallThicknessStatus: 'analyzing',
      wallThicknessError: null,
      wallThicknessVisible: false,
      wallThicknessPicking: false,
      wallThicknessSelection: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null,
      manufacturingStatus: 'idle',
      manufacturingResult: null,
      manufacturingError: null
    });
    try {
      const wallThicknessResult = await analyzeWallThicknessBackend(request);
      set((state) => ({
        wallThicknessStatus: 'ready',
        wallThicknessResult,
        wallThicknessError: null,
        wallThicknessVisible: true,
        wallThicknessPicking: true,
        wallThicknessSelection: null,
        viewportModelSource: request.sourceKind === 'uploaded-stl' ? 'uploaded-stl' : 'cad',
        exploded: false,
        messages: state.messages.concat({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `全局壁厚分析完成：${describeWallThicknessRisk(wallThicknessResult)}。有效采样 ${wallThicknessResult.sampleCount.toLocaleString()} 个，覆盖率 ${(wallThicknessResult.coverageRatio * 100).toFixed(1)}%。结果是表面法向射线采样估算，不是受力或疲劳仿真。`
        })
      }));
      return wallThicknessResult;
    } catch (error) {
      set({
        wallThicknessStatus: 'error',
        wallThicknessResult: null,
        wallThicknessError: error instanceof Error ? error.message : '壁厚分析失败',
        wallThicknessVisible: false,
        wallThicknessPicking: false,
        wallThicknessSelection: null,
        cadFaceSelectionMode: 'off',
        cadFaceSelection: null,
        localCadFeaturePreview: null,
        cadFaceBoxRequest: null
      });
      return null;
    }
  },
  setWallThicknessVisible: (wallThicknessVisible) => set({
    wallThicknessVisible,
    wallThicknessPicking: wallThicknessVisible ? get().wallThicknessPicking : false
  }),
  setWallThicknessPicking: (wallThicknessPicking) => set({
    wallThicknessPicking: get().wallThicknessVisible && wallThicknessPicking
  }),
  selectWallThicknessSample: (sample) => {
    const result = get().wallThicknessResult;
    if (!result || !get().wallThicknessVisible || !get().wallThicknessPicking) return;
    set({
      wallThicknessSelection: {
        sourceKind: result.sourceKind,
        sourcePartId: result.sourcePartId,
        sample
      }
    });
  },
  selectThinnestWallThicknessSample: () => {
    const result = get().wallThicknessResult;
    if (!result) return;
    const sample = findThinnestWallThicknessSample(result);
    if (!sample) return;
    set({
      wallThicknessVisible: true,
      wallThicknessPicking: true,
      wallThicknessSelection: {
        sourceKind: result.sourceKind,
        sourcePartId: result.sourcePartId,
        sample
      }
    });
  },
  clearWallThicknessSelection: () => set({ wallThicknessSelection: null }),
  clearWallThicknessAnalysis: () => set({
    wallThicknessStatus: 'idle',
    wallThicknessResult: null,
    wallThicknessError: null,
    wallThicknessVisible: false,
    wallThicknessPicking: false,
    wallThicknessSelection: null
  }),
  setCadFaceSelectionMode: (cadFaceSelectionMode) => {
    const state = get();
    const available = state.viewportModelSource === 'cad'
      && state.cadStatus === 'ready'
      && state.cadResult?.parts.some((part) => part.faceTessellation?.status === 'ok')
      && !state.manufacturingResult
      && state.versionGeometryComparisonMode === 'off';
    if (cadFaceSelectionMode !== 'off' && !available) return;
    set({
      cadFaceSelectionMode,
      cadFaceSelection: cadFaceSelectionMode === 'off' || cadFaceSelectionMode !== state.cadFaceSelectionMode
        ? null
        : state.cadFaceSelection,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null,
      wallThicknessPicking: cadFaceSelectionMode === 'off' ? state.wallThicknessPicking : false,
      wallThicknessSelection: cadFaceSelectionMode === 'off' ? state.wallThicknessSelection : null
    });
  },
  selectCadFaces: (cadFaceSelection) => set({
    cadFaceSelection,
    localCadFeaturePreview: null,
    cadFaceBoxRequest: null,
    wallThicknessPicking: false,
    wallThicknessSelection: null
  }),
  resolveCadSurfaceHitSelection: async (selection, edgeTarget) => {
    if (edgeTarget && selection.selectionMode !== 'edge-chain') return;
    if (!edgeTarget && (!selection.hit || !['click', 'edge'].includes(selection.selectionMode))) return;
    try {
      const request = edgeTarget
        ? buildCadSurfaceHitRequestForEdgeTarget(selection, edgeTarget)
        : buildCadSurfaceHitRequest(selection);
      const result = await resolveCadSurfaceHit(request);
      set((state) => {
        const current = state.cadFaceSelection;
        if (edgeTarget) {
          if (!current || current.selectionMode !== 'edge-chain' || current.revision !== selection.revision) return {};
          try {
            return { cadFaceSelection: applyCadSurfaceHitResultToEdgeTarget(current, edgeTarget, result) };
          } catch {
            return {};
          }
        }
        return current === selection
          ? { cadFaceSelection: applyCadSurfaceHitResult(selection, result) }
          : {};
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenCascade 曲面点击精确解析失败';
      set((state) => {
        const current = state.cadFaceSelection;
        if (edgeTarget) {
          return current?.selectionMode === 'edge-chain' && current.revision === selection.revision
            ? { cadFaceSelection: failCadSurfaceHitEdgeTarget(current, edgeTarget, message) }
            : {};
        }
        return current === selection
          ? { cadFaceSelection: failCadSurfaceHitSelection(selection, message) }
          : {};
      });
    }
  },
  requestCadFaceBoxSelection: (cadFaceBoxRequest) => set({ cadFaceBoxRequest }),
  clearCadFaceSelection: () => set({
    cadFaceSelection: null,
    localCadFeaturePreview: null,
    cadFaceBoxRequest: null
  }),
  clearLocalCadFeaturePreview: () => set({ localCadFeaturePreview: null }),
  clearLocalCadFeaturePreflightHistory: () => set({ localCadFeaturePreflightHistory: [] }),
  focusLocalCadFeatureInterferenceFace: (stableFaceId) => set((state) => {
    const preview = state.localCadFeaturePreview;
    if (
      preview?.status !== 'blocked'
      || !preview.preflight?.validation.interferingStableFaceIds.includes(stableFaceId)
    ) return state;
    return {
      localCadFeaturePreview: { ...preview, focusedInterferenceFaceId: stableFaceId }
    };
  }),
  openVersionGeometryComparison: async (versionId, mode) => {
    const state = get();
    const baseVersion = state.versions.find((version) => version.id === versionId);
    const currentVersion = state.versions[state.versionIndex];
    const fail = (message: string) => {
      set({
        versionGeometryComparisonMode: 'off',
        versionGeometryComparisonBaseId: versionId,
        versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
        versionGeometryComparisonStatus: 'error',
        versionGeometryComparisonError: message
      });
      return false;
    };
    if (!baseVersion) return fail('没有找到所选历史版本');
    if (baseVersion.id === currentVersion?.id) return fail('请选择当前版本之前的版本作为基准');
    if (!baseVersion.snapshotDirectory) {
      return fail('该版本没有本机精确快照，无法加载旧实体');
    }
    if (state.viewportModelSource !== 'cad' || state.cadStatus !== 'ready' || !state.cadResult) {
      return fail('当前精确 CAD 尚未完成重建，请等待状态变为“OpenCascade 实体有效”后再对比');
    }

    const serial = ++versionComparisonSerial;
    set({
      versionGeometryComparisonMode: 'off',
      versionGeometryComparisonBaseId: versionId,
      versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
      versionGeometryComparisonStatus: 'loading',
      versionGeometryComparisonError: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null
    });
    try {
      const snapshotPromise = loadVersionSnapshotCadResult(baseVersion.snapshotDirectory);
      const differencePromise = mode === 'difference'
        ? runVersionGeometryDifference(baseVersion.snapshotDirectory)
        : Promise.resolve<VersionGeometryDifferenceResult | null>(null);
      const [snapshot, difference] = await Promise.all([snapshotPromise, differencePromise]);
      if (serial !== versionComparisonSerial) return false;
      if (snapshot.revision === state.cadResult.revision) {
        throw new Error('所选基准快照与当前精确模型相同，无需计算版本差异');
      }
      if (difference && (
        difference.baseRevision !== snapshot.revision
        || difference.currentRevision !== state.cadResult.revision
      )) {
        throw new Error('精确差异结果与当前版本不一致，请重新计算');
      }
      set({
        versionGeometryComparisonMode: mode,
        versionGeometryComparisonBaseId: versionId,
        versionGeometryComparisonSnapshot: snapshot,
        versionGeometryDifferenceResult: difference,
        versionGeometryComparisonStatus: 'ready',
        versionGeometryComparisonError: null,
        wallThicknessVisible: false,
        wallThicknessPicking: false,
        wallThicknessSelection: null
      });
      return true;
    } catch (error) {
      if (serial !== versionComparisonSerial) return false;
      return fail(error instanceof Error ? error.message : '无法加载版本精确实体');
    }
  },
  setVersionGeometryComparisonMode: (versionGeometryComparisonMode) => {
    if (get().versionGeometryComparisonStatus !== 'ready') return;
    set({ versionGeometryComparisonMode });
  },
  closeVersionGeometryComparison: () => {
    versionComparisonSerial += 1;
    set({
      versionGeometryComparisonMode: 'off',
      versionGeometryComparisonBaseId: null,
      versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
      versionGeometryComparisonStatus: 'idle',
      versionGeometryComparisonError: null
    });
  },
  initializeBackend: async () => {
    set({ aiStatus: 'checking', aiActivity: '正在检查本机 Codex 和 CAD 运行环境', aiError: null });
    try {
      const backendStatus = await loadBackendStatus();
      set({
        backendStatus,
        aiStatus: backendStatus.codexAuthenticated ? 'ready' : 'local',
        aiActivity: null,
        aiError: null
      });
    } catch (error) {
      set({
        backendStatus: null,
        aiStatus: 'error',
        aiActivity: null,
        aiError: error instanceof Error ? error.message : '无法检查桌面后端'
      });
    }
  },
  saveCurrentVersion: async (label = '手动保存') => {
    const state = get();
    try {
      const snapshot = await createVersionSnapshot(label, {
        ...state.parameters,
        interfaceOpenings: state.interfaceOpenings
      });
      if (!snapshot) return;
      set((current) => ({
        versions: current.versions.map((version, index) =>
          index === current.versionIndex
            ? { ...version, snapshotDirectory: snapshot.directory }
            : version
        ),
        messages: current.messages.concat({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `当前版本已保存到本机快照：${snapshot.id}`
        })
      }));
    } catch (error) {
      set({ aiError: error instanceof Error ? error.message : '版本保存失败' });
    }
  },
  hydrateCadResult: async () => {
    try {
      const cadResult = await loadCadGenerationResult();
      if (!cadResult) {
        set({ cadStatus: 'stale' });
        await get().generateCad();
        return;
      }
      const matches = cadResultMatchesParameters(cadResult, get().parameters);
      set({
        cadResult,
        interfaceOpenings: cadResult.interfaceOpeningMode === 'custom'
          ? (cadResult.interfaceOpenings ?? []).map((opening) => ({ ...opening }))
          : null,
        cadStatus: matches ? 'ready' : 'stale',
        cadError: null
      });
      if (!matches) await get().generateCad();
    } catch {
      set({ cadStatus: 'stale' });
      await get().generateCad();
    }
  },
  generateCad: async (parametersOverride) => {
    const parameters = { ...(parametersOverride ?? get().parameters) };
    const interfaceOpenings = resolveInterfaceOpeningsForParameters(
      get().interfaceOpenings,
      parameters
    );
    const serial = ++generationSerial;
    versionComparisonSerial += 1;
    set({
      cadStatus: 'generating',
      cadError: null,
      versionGeometryComparisonMode: 'off',
      versionGeometryComparisonBaseId: null,
      versionGeometryComparisonSnapshot: null,
      versionGeometryDifferenceResult: null,
      versionGeometryComparisonStatus: 'idle',
      versionGeometryComparisonError: null,
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      localCadFeaturePreview: null,
      cadFaceBoxRequest: null
    });
    try {
      const cadResult = await generateCadModel(parameters, interfaceOpenings ?? undefined);
      if (serial !== generationSerial) return null;
      const currentParameters = get().parameters;
      const isCurrent = Object.keys(parameters).every((key) => {
        const parameter = key as keyof EnclosureParameters;
        return parameters[parameter] === currentParameters[parameter];
      });
      set({
        cadResult,
        cadStatus: isCurrent ? 'ready' : 'stale',
        cadError: null,
        manufacturingStatus: 'idle',
        manufacturingResult: null,
        manufacturingError: null,
        wallThicknessStatus: 'idle',
        wallThicknessResult: null,
        wallThicknessError: null,
        wallThicknessVisible: false,
        wallThicknessPicking: false,
        wallThicknessSelection: null
      });
      return cadResult;
    } catch (error) {
      if (serial !== generationSerial) return null;
      set({
        cadStatus: 'error',
        cadError: error instanceof Error ? error.message : '精确 CAD 生成失败'
      });
      return null;
    }
  },
  executeCommand: async (command) => {
    const trimmed = command.trim();
    if (!trimmed || get().aiStatus === 'running') return;
    const faceSelection = get().cadFaceSelection;
    const selectedRegion = get().wallThicknessSelection;
    const previousWallThickness = get().wallThicknessResult;
    if (faceSelection) {
      generationSerial += 1;
      versionComparisonSerial += 1;
      const backendStatus = get().backendStatus;
      const currentParameters = { ...get().parameters };
      const currentInterfaceOpenings = get().interfaceOpenings?.map((opening) => ({ ...opening }))
        ?? get().interfaceOpenings;
      set((state) => ({
        aiStatus: 'running',
        aiActivity: backendStatus?.codexAuthenticated
          ? 'Codex 正在生成受限的稳定 CAD 局部特征计划'
          : '正在使用本地规则解析稳定 CAD 局部特征',
        aiError: null,
        localCadFeaturePreview: null,
        messages: state.messages.concat({ id: crypto.randomUUID(), role: 'user', content: trimmed })
      }));

      let request;
      let preflightRecordId: string | null = null;
      try {
        if (backendStatus?.codexAuthenticated) {
          const planResult = await runCodexModelCommand(trimmed, currentParameters, faceSelection);
          if (!planResult.localFeature) {
            throw new Error(planResult.summary || 'Codex 没有返回可执行的稳定 CAD 局部特征计划');
          }
          request = buildLocalCadFeatureRequestFromPlan(
            faceSelection,
            trimmed,
            planResult.localFeature,
            planResult.summary
          );
        } else {
          request = buildLocalCadFeatureRequest(faceSelection, trimmed);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '稳定 CAD 局部特征指令无法解析';
        set((state) => ({
          aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
          aiActivity: null,
          aiError: message,
          messages: state.messages.concat({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `${message}。已保留当前模型和稳定 CAD 局部选择；支持点击稳定平面后生成局部轮廓或整面拉伸/偏移、点击曲面后生成受限圆形、矩形或槽孔特征，也支持点击稳定面所属单条稳定边后执行圆角或倒角。`
          })
        }));
        return;
      }

      const preview = createLocalCadFeaturePreview(request);
      if (preview) {
        set({
          localCadFeaturePreview: preview,
          aiActivity: `OpenCascade 正在生成${preview.request.operation === 'cut-slot'
            ? '曲面槽孔'
            : preview.request.operation === 'add-rectangle'
              ? '曲面矩形凸台'
              : preview.request.operation === 'cut-rectangle'
                ? '曲面矩形孔'
                : preview.kind === 'additive' ? '曲面圆形凸台' : '曲面圆孔'}精确工具体预演并检查干涉`
        });
        try {
          const preflight = await preflightLocalCadFeature(request);
          const preflightRecord = createLocalCadFeaturePreflightRecord(request, preflight);
          preflightRecordId = preflightRecord.id;
          if (preflight.status === 'blocked') {
            set((state) => ({
              aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
              aiActivity: null,
              aiError: preflight.message,
              localCadFeaturePreview: state.localCadFeaturePreview?.request === request
                ? {
                    ...state.localCadFeaturePreview,
                    status: 'blocked',
                    errorMessage: preflight.message,
                    preflight,
                    focusedInterferenceFaceId: preflight.validation.interferingStableFaceIds[0] ?? null
                  }
                : state.localCadFeaturePreview,
              localCadFeaturePreflightHistory: appendLocalCadFeaturePreflightRecord(
                state.localCadFeaturePreflightHistory,
                preflightRecord
              ),
              messages: state.messages.concat({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `OpenCascade 精确工具体预演已阻止自动执行：${preflight.message}。已显示真实布尔工具体，并标出 ${preflight.validation.interferingFaceCount} 个非目标稳定面；最近干涉距离 ${preflight.validation.minimumInterferenceDistanceMm?.toFixed(3) ?? '未知'} 毫米。当前模型未写入任何修改。`
              })
            }));
            return;
          }
          set((state) => ({
            aiActivity: 'OpenCascade 精确工具体预演和曲面干涉检查已通过，准备自动执行',
            localCadFeaturePreview: state.localCadFeaturePreview?.request === request
              ? { ...state.localCadFeaturePreview, status: 'ready', errorMessage: null, preflight }
              : state.localCadFeaturePreview,
            localCadFeaturePreflightHistory: appendLocalCadFeaturePreflightRecord(
              state.localCadFeaturePreflightHistory,
              preflightRecord
            )
          }));
          await waitForLocalCadFeaturePreviewFrame();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'OpenCascade 精确工具体预演失败';
          set((state) => ({
            aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
            aiActivity: null,
            aiError: message,
            localCadFeaturePreview: state.localCadFeaturePreview?.request === request
              ? { ...state.localCadFeaturePreview, status: 'failed', errorMessage: message }
              : state.localCadFeaturePreview,
            messages: state.messages.concat({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `OpenCascade 精确工具体预演失败，已停止自动执行并保留当前模型：${message}`
            })
          }));
          return;
        }
      }

      set({ aiActivity: '正在保存稳定 CAD 局部修改前快照' });
      try {
        const snapshot = await createVersionSnapshot(`稳定 CAD 局部修改前-${trimmed}`, {
          ...currentParameters,
          interfaceOpenings: currentInterfaceOpenings
        });
        if (snapshot) {
          set((state) => ({
            versions: state.versions.map((version, index) =>
              index === state.versionIndex ? { ...version, snapshotDirectory: snapshot.directory } : version
            )
          }));
        }
      } catch {
        // Worker 还会使用临时文件和批量回滚保护当前 CAD；快照失败不阻断合法修改。
      }

      try {
        const operationLabel = ({
          'add-cylinder': '生成圆形凸台',
          'cut-cylinder': '切除圆孔',
          'add-rectangle': '生成矩形凸台',
          'cut-rectangle': '切除矩形孔',
          'cut-slot': '切除槽孔',
          'offset-face-outward': '将整个平面向外拉伸',
          'offset-face-inward': '将整个平面向内偏移',
          'fillet-edge': '生成单边圆角',
          'chamfer-edge': '生成单边倒角',
          'fillet-edge-loop': '生成平面边界整圈圆角',
          'chamfer-edge-loop': '生成平面边界整圈倒角',
          'fillet-edge-chain': '生成切线连续边链圆角',
          'chamfer-edge-chain': '生成切线连续边链倒角',
          'fillet-edge-manual-chain': '生成手工多选边链圆角',
          'chamfer-edge-manual-chain': '生成手工多选边链倒角'
        } as const)[request.operation];
        const edgeOperation = request.operation === 'fillet-edge'
          || request.operation === 'chamfer-edge'
          || request.operation === 'fillet-edge-loop'
          || request.operation === 'chamfer-edge-loop'
          || request.operation === 'fillet-edge-chain'
          || request.operation === 'chamfer-edge-chain'
          || request.operation === 'fillet-edge-manual-chain'
          || request.operation === 'chamfer-edge-manual-chain';
        const edgeLoopOperation = request.operation === 'fillet-edge-loop'
          || request.operation === 'chamfer-edge-loop';
        const edgeChainOperation = request.operation === 'fillet-edge-chain'
          || request.operation === 'chamfer-edge-chain';
        const manualEdgeChainOperation = request.operation === 'fillet-edge-manual-chain'
          || request.operation === 'chamfer-edge-manual-chain';
        const targetSurfaceLabel = edgeOperation
          ? '边'
          : describeCadSurfaceGeometryType(request.surfaceGeometryType);
        set((state) => ({
          aiActivity: `OpenCascade 正在沿稳定${targetSurfaceLabel}${operationLabel}`,
          localCadFeaturePreview: state.localCadFeaturePreview?.request === request
            ? { ...state.localCadFeaturePreview, status: 'executing', errorMessage: null }
            : state.localCadFeaturePreview
        }));
        const featureResult = await runLocalCadFeature(request);
        set((state) => ({
          cadResult: featureResult.updatedCadResult,
          cadStatus: 'ready',
          cadError: null,
          selectedObject: request.partId,
          viewportModelSource: 'cad',
          manufacturingStatus: 'idle',
          manufacturingResult: null,
          manufacturingError: null,
          wallThicknessStatus: 'idle',
          wallThicknessResult: null,
          wallThicknessError: null,
          wallThicknessVisible: false,
          wallThicknessPicking: false,
          wallThicknessSelection: null,
          cadFaceSelectionMode: 'off',
          cadFaceSelection: null,
          localCadFeaturePreview: null,
          cadFaceBoxRequest: null,
          versionGeometryComparisonMode: 'off',
          versionGeometryComparisonBaseId: null,
          versionGeometryComparisonSnapshot: null,
          versionGeometryDifferenceResult: null,
          versionGeometryComparisonStatus: 'idle',
          versionGeometryComparisonError: null,
          localCadFeaturePreflightHistory: preflightRecordId
            ? linkLocalCadFeaturePreflightExecution(
                state.localCadFeaturePreflightHistory,
                preflightRecordId,
                featureResult.revision
              )
            : state.localCadFeaturePreflightHistory
        }));
        get().commitVersion(request.summary);
        try {
          const resultSnapshot = await createVersionSnapshot(`稳定 CAD 局部修改后-${trimmed}`, {
            ...currentParameters,
            interfaceOpenings: currentInterfaceOpenings
          });
          if (resultSnapshot) {
            set((state) => ({
              versions: state.versions.map((version, index) =>
                index === state.versionIndex
                  ? { ...version, snapshotDirectory: resultSnapshot.directory }
                  : version
              )
            }));
          }
        } catch {
          // 修改结果已经通过 Worker 校验并写回；后置快照失败只影响版本留档。
        }

        const delta = featureResult.validation.volumeDeltaMm3;
        const stableFaceText = featureResult.stableFaceStatus === 'inherited'
          ? '目标稳定面 ID 已继承'
          : '目标面因拓扑变化已失效，需重新选择';
        const curvedEdge = edgeOperation && request.surfaceGeometryType !== 'PLANE';
        const curvedEdgeUv = featureResult.validation.surfaceUv;
        const affectedEdgeCount = featureResult.validation.affectedEdgeCount ?? (edgeOperation ? 1 : 0);
        const seedEdgeStatusText = `种子稳定边状态为${featureResult.stableEdgeStatus === 'inherited' ? '已继承' : '已失效'}`;
        const edgeResultText = manualEdgeChainOperation
          ? `已对手工选择的 ${affectedEdgeCount} 条连续边执行${request.operation === 'fillet-edge-manual-chain' ? '圆角' : '倒角'}；OpenCascade 已验证其构成一条无分叉的开放或闭合边链。`
          : edgeLoopOperation
          ? `已从种子稳定边 ${request.stableEdgeId} 定位唯一平面边界，共对 ${affectedEdgeCount} 条边执行${request.operation === 'fillet-edge-loop' ? '整圈圆角' : '整圈倒角'}；${seedEdgeStatusText}。`
          : edgeChainOperation
            ? `已从种子稳定边 ${request.stableEdgeId} 的两端自动传播到唯一切线连续边链，共对 ${affectedEdgeCount} 条边执行${request.operation === 'fillet-edge-chain' ? '圆角' : '倒角'}；${seedEdgeStatusText}。`
            : edgeOperation
              ? `目标稳定边 ${request.stableEdgeId} 状态为${featureResult.stableEdgeStatus === 'inherited' ? '已继承' : '已失效'}；点击点到 OpenCascade 目标边的距离 ${featureResult.validation.pointDistanceMm.toFixed(3)} 毫米已通过复核。${curvedEdge ? `所属${describeCadSurfaceGeometryType(request.surfaceGeometryType)}已按当前修订真实 UV${curvedEdgeUv ? `（${curvedEdgeUv.u.toFixed(4)}，${curvedEdgeUv.v.toFixed(4)}）` : ''}重新求点，点击点到真实 UV 点的距离 ${featureResult.validation.surfacePointDistanceMm?.toFixed(3) ?? '未知'} 毫米，真实外法线点积 ${featureResult.validation.normalDot.toFixed(3)}，均已通过复核。` : ''}`
              : '';
        const curvedValidationText = !edgeOperation && request.surfaceGeometryType !== 'PLANE'
          ? `曲率比 ${featureResult.validation.curvatureRatio?.toFixed(3) ?? '未知'}；局部壁厚约 ${featureResult.validation.localWallThicknessMm?.toFixed(3) ?? '未知'} 毫米${featureResult.validation.throughCut ? '，本次为通孔' : featureResult.validation.remainingWallMm != null ? `，剩余壁厚约 ${featureResult.validation.remainingWallMm.toFixed(3)} 毫米` : ''}。${featureResult.validation.interferenceCheckPassed ? `曲面干涉检查通过，检查 ${featureResult.validation.contactFaceCount ?? 0} 个接触面和 ${featureResult.validation.contactSampleCount ?? 0} 个接触采样，未发现目标曲面自交或非目标面干涉。` : ''}`
          : '';
        const invalidatedSelectionText = curvedEdge || manualEdgeChainOperation
          ? '原三角面索引（triangleIndex）、曲面 UV 和稳定边选择全部失效'
          : `原三角面索引（triangleIndex）${edgeOperation ? '和稳定边选择' : ''}已失效`;
        set((state) => ({
          aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
          aiActivity: null,
          messages: state.messages.concat({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `${request.summary}已完成；零件体积 ${featureResult.validation.volumeBeforeMm3.toFixed(2)} → ${featureResult.validation.volumeAfterMm3.toFixed(2)} 立方毫米（${delta >= 0 ? '+' : ''}${delta.toFixed(2)}）。结果已通过有效性、封闭性、单 Solid、点击坐标和法线一致性检查；${stableFaceText}。${edgeResultText}${curvedValidationText}局部特征已记录，后续参数化整模重建会从基础实体开始按顺序安全重放；修改后选择网格已重新生成，${invalidatedSelectionText}，继续修改前请重新选择。${manualEdgeChainOperation ? '手工边链第一版只支持无分叉的开放链或闭合链，不支持可变半径、连续性等级控制或永久拓扑命名。' : edgeLoopOperation ? '本次只传播到种子边所属的唯一平面边界，不支持可变半径。' : edgeChainOperation ? '本次只传播到两端唯一且夹角不超过 5 度的切线连续边，不支持分叉链或可变半径。' : edgeOperation ? '当前为单条稳定边；如需切线传播请明确写“切线链”，如需平面边界整圈请明确写“整圈”，如需逐条指定请切换“多选边链”。' : ''}`
          })
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : '稳定 CAD 局部特征失败';
        const interferenceBlocked = message.includes('曲面作用区域') && message.includes('干涉检查未通过');
        set((state) => ({
          aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
          aiActivity: null,
          aiError: message,
          localCadFeaturePreview: state.localCadFeaturePreview?.request === request
            ? { ...state.localCadFeaturePreview, status: interferenceBlocked ? 'blocked' : 'failed', errorMessage: message }
            : state.localCadFeaturePreview,
          messages: state.messages.concat({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `稳定 CAD 局部特征未通过 OpenCascade 校验，已保留修改前模型：${message}${preview ? interferenceBlocked ? '。三维预览已标记为干涉风险，已阻止写入模型。' : '。三维预览已保留，可调整尺寸后重试。' : ''}`
          })
        }));
      }
      return;
    }
    if (selectedRegion?.sourceKind === 'uploaded-stl') {
      const importedModel = get().importedStlModel;
      const backendStatus = get().backendStatus;
      if (!importedModel) {
        set((state) => ({
          messages: state.messages.concat(
            { id: crypto.randomUUID(), role: 'user', content: trimmed },
            { id: crypto.randomUUID(), role: 'assistant', content: '没有找到当前上传模型，请重新选择 STL 文件。' }
          )
        }));
        return;
      }

      let plan;
      try {
        plan = parseLocalStlEditCommand(trimmed);
      } catch (error) {
        set((state) => ({
          messages: state.messages.concat(
            { id: crypto.randomUUID(), role: 'user', content: trimmed },
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `${error instanceof Error ? error.message : '局部修改指令无法解析'}。第一版只支持沿选中表面法向的圆形凸台加厚和圆孔切除。`
            }
          )
        }));
        return;
      }

      set((state) => ({
        aiStatus: 'running',
        aiActivity: '正在保存上传 STL 修改前快照',
        aiError: null,
        messages: state.messages.concat({ id: crypto.randomUUID(), role: 'user', content: trimmed })
      }));
      try {
        const snapshot = await createVersionSnapshot(`上传-STL-修改前-${trimmed}`, get().parameters);
        if (snapshot) {
          set((state) => ({
            versions: state.versions.map((version, index) =>
              index === state.versionIndex ? { ...version, snapshotDirectory: snapshot.directory } : version
            )
          }));
        }
      } catch {
        // 快照失败不覆盖工作文件，后续 OpenCascade 校验仍负责保护当前模型。
      }

      try {
        set({ aiActivity: `OpenCascade 正在执行${plan.operation === 'add-cylinder' ? '局部圆形凸台加厚' : '局部圆孔切除'}` });
        const editResult = await runLocalStlEdit({
          sourcePartId: 'uploaded-model',
          operation: plan.operation,
          center: {
            xMm: selectedRegion.sample.xMm,
            yMm: selectedRegion.sample.yMm,
            zMm: selectedRegion.sample.zMm
          },
          inwardNormal: selectedRegion.sample.inwardNormal,
          radiusMm: plan.radiusMm,
          depthMm: plan.depthMm,
          summary: plan.summary,
          command: trimmed
        });
        set({
          importedStlModel: editResult.updatedModel,
          importedStlStatus: 'ready',
          importedStlError: null,
          localStlEditResult: editResult,
          manufacturingStatus: 'idle',
          manufacturingResult: null,
          manufacturingError: null,
          wallThicknessStatus: 'analyzing',
          wallThicknessResult: null,
          wallThicknessError: null,
          wallThicknessVisible: false,
          wallThicknessPicking: false,
          wallThicknessSelection: null,
          viewportModelSource: 'uploaded-stl',
          exploded: false,
          aiActivity: '正在对修改后的上传 STL 自动复查壁厚'
        });

        let localReviewText = '';
        if (previousWallThickness?.sourceKind === 'uploaded-stl') {
          try {
            const reviewedResult = await analyzeWallThicknessBackend({
              sourceKind: 'uploaded-stl',
              sourcePartId: 'uploaded-model',
              minimumWallMm: previousWallThickness.minimumWallMm,
              sampleLimit: previousWallThickness.requestedSampleCount
            });
            const reviewedSample = findNearestWallThicknessSample(reviewedResult.samples, selectedRegion.sample);
            set({
              wallThicknessStatus: 'ready',
              wallThicknessResult: reviewedResult,
              wallThicknessError: null,
              wallThicknessVisible: true,
              wallThicknessPicking: true,
              wallThicknessSelection: reviewedSample ? {
                sourceKind: 'uploaded-stl',
                sourcePartId: 'uploaded-model',
                sample: reviewedSample
              } : null
            });
            if (reviewedSample) {
              const delta = reviewedSample.thicknessMm - selectedRegion.sample.thicknessMm;
              localReviewText = ` 自动复查：原位置最近采样的估算壁厚 ${selectedRegion.sample.thicknessMm.toFixed(2)} → ${reviewedSample.thicknessMm.toFixed(2)} 毫米（${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 毫米）。`;
            } else {
              localReviewText = ' 自动复查完成，但原坐标附近没有有效采样点，请重新点击热力图定位。';
            }
          } catch (error) {
            set({
              wallThicknessStatus: 'error',
              wallThicknessError: error instanceof Error ? error.message : '壁厚自动复查失败',
              wallThicknessVisible: false,
              wallThicknessPicking: false,
              wallThicknessSelection: null
            });
            localReviewText = ` 壁厚自动复查失败：${error instanceof Error ? error.message : '未知错误'}。`;
          }
        } else {
          set({ wallThicknessStatus: 'idle' });
        }

        const volumeDelta = editResult.validation.volumeDeltaMm3;
        set((state) => ({
          aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
          aiActivity: null,
          messages: state.messages.concat({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `${plan.summary}已完成并写回当前上传模型；体积 ${editResult.validation.volumeBeforeMm3.toFixed(2)} → ${editResult.validation.volumeAfterMm3.toFixed(2)} 立方毫米（${volumeDelta >= 0 ? '+' : ''}${volumeDelta.toFixed(2)}）。结果已通过有效性、封闭性、单 Solid 和体积方向检查。${localReviewText}`
          })
        }));
      } catch (error) {
        set((state) => ({
          aiStatus: backendStatus?.codexAuthenticated ? 'ready' : 'local',
          aiActivity: null,
          aiError: error instanceof Error ? error.message : '上传 STL 局部修改失败',
          messages: state.messages.concat({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `局部修改未通过 OpenCascade 校验，已保留修改前工作模型：${error instanceof Error ? error.message : '未知错误'}`
          })
        }));
      }
      return;
    }
    const currentParameters = { ...get().parameters };
    const currentInterfaceOpenings = get().interfaceOpenings?.map((opening) => ({ ...opening }))
      ?? get().interfaceOpenings;
    const codexCommand = faceSelection
      ? `${trimmed}\n${buildCadFaceSelectionCommandContext(faceSelection)}`
      : selectedRegion
        ? `${trimmed}\n${buildWallThicknessCommandContext(selectedRegion)}`
        : trimmed;
    set((state) => ({
      aiStatus: 'running',
      aiActivity: '正在保存修改前版本',
      aiError: null,
      messages: state.messages.concat({
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed
      })
    }));

    try {
      const snapshot = await createVersionSnapshot(`修改前-${trimmed}`, {
        ...currentParameters,
        interfaceOpenings: currentInterfaceOpenings
      });
      if (snapshot) {
        set((state) => ({
          versions: state.versions.map((version, index) =>
            index === state.versionIndex
              ? { ...version, snapshotDirectory: snapshot.directory }
              : version
          )
        }));
      }
    } catch {
      // A snapshot failure must not block an otherwise valid modeling command.
    }

    let summary: string;
    let changes: Array<[keyof EnclosureParameters, number]>;
    let usedCodex = false;
    const backendStatus = get().backendStatus;

    if (backendStatus?.codexAuthenticated) {
      try {
        set({ aiActivity: 'Codex 正在分析建模指令' });
        const result = await runCodexModelCommand(codexCommand, currentParameters, faceSelection);
        summary = result.summary;
        changes = result.changes
          .filter((change) => isParameterName(change.parameter) && Number.isFinite(change.value))
          .map((change) => [change.parameter, change.value]);
        usedCodex = true;
      } catch (error) {
        const fallback = analyzeModelCommand(trimmed);
        summary = `Codex 执行失败，已回退本地解析：${fallback.summary}`;
        changes = Object.entries(fallback.parameters) as Array<
          [keyof EnclosureParameters, number]
        >;
        set({ aiError: error instanceof Error ? error.message : 'Codex 执行失败' });
      }
    } else {
      set({ aiActivity: '正在使用本地规则解析建模指令' });
      const result = analyzeModelCommand(trimmed);
      summary = result.summary;
      changes = Object.entries(result.parameters) as Array<
        [keyof EnclosureParameters, number]
      >;
    }

    const parameters = changes.reduce<EnclosureParameters>(
        (current, [key, value]) => ({
          ...current,
          [key]: clampParameter(key, value)
        }),
        currentParameters
      );
    const interfaceOpenings = resolveInterfaceOpeningsForParameters(
      currentInterfaceOpenings,
      parameters
    );

    if (changes.length === 0) {
      set((state) => ({
        aiStatus: backendStatus?.codexAuthenticated && usedCodex ? 'ready' : 'local',
        aiActivity: null,
        messages: state.messages.concat({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: summary
        })
      }));
      return;
    }

    set({
        parameters,
        interfaceOpenings,
        cadStatus: 'stale',
        cadError: null,
        aiActivity: 'OpenCascade 正在重建并检查精确实体'
    });

    const cadResult = await get().generateCad(parameters);
    if (!cadResult) {
      const failure = get().cadError ?? '精确实体生成失败';
      set((state) => ({
        parameters: currentParameters,
        interfaceOpenings: currentInterfaceOpenings,
        aiStatus: backendStatus?.codexAuthenticated && usedCodex ? 'ready' : 'local',
        aiActivity: null,
        messages: state.messages.concat({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `修改未通过实体校验，已保留修改前版本：${failure}`
        })
      }));
      return;
    }

    get().commitVersion(`${usedCodex ? 'Codex' : '智能建模'}：${trimmed}`);
    const primaryPart = findCadPartByRole(cadResult, 'primary') ?? cadResult.parts[0];
    const volumeText = primaryPart
      ? `${primaryPart.label}体积 ${Math.round(primaryPart.metrics.volumeMm3).toLocaleString()} 立方毫米，`
      : '';
    let localReviewText = '';
    if (
      selectedRegion
      && previousWallThickness
      && previousWallThickness.sourceKind === 'cad-part'
      && previousWallThickness.sourcePartId === selectedRegion.sourcePartId
    ) {
      try {
        set({ aiActivity: '正在复查选中区域的壁厚变化' });
        const reviewedResult = await analyzeWallThicknessBackend({
          sourceKind: 'cad-part',
          sourcePartId: selectedRegion.sourcePartId,
          minimumWallMm: previousWallThickness.minimumWallMm,
          sampleLimit: previousWallThickness.requestedSampleCount
        });
        const reviewedSample = findNearestWallThicknessSample(
          reviewedResult.samples,
          selectedRegion.sample
        );
        if (reviewedSample) {
          const delta = reviewedSample.thicknessMm - selectedRegion.sample.thicknessMm;
          const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
          set({
            wallThicknessStatus: 'ready',
            wallThicknessResult: reviewedResult,
            wallThicknessError: null,
            wallThicknessVisible: true,
            wallThicknessPicking: true,
            wallThicknessSelection: {
              sourceKind: reviewedResult.sourceKind,
              sourcePartId: reviewedResult.sourcePartId,
              sample: reviewedSample
            }
          });
          localReviewText = ` 局部复查：估算壁厚 ${selectedRegion.sample.thicknessMm.toFixed(2)} → ${reviewedSample.thicknessMm.toFixed(2)} 毫米（${deltaText} 毫米）。`;
        } else {
          localReviewText = ' 局部复查未找到足够接近的有效采样点，请重新点击热力图定位。';
        }
      } catch (error) {
        localReviewText = ` 局部壁厚自动复查失败：${error instanceof Error ? error.message : '未知错误'}。`;
      }
    }
    set((state) => ({
      aiStatus: backendStatus?.codexAuthenticated && usedCodex ? 'ready' : 'local',
      aiActivity: null,
      messages: state.messages.concat({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `${summary} 已完成精确实体重建；${volumeText}P1S 成型尺寸校验通过。${localReviewText}`
      })
    }));
  }
}));
