import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadFaceDescriptor, CadGenerationResult } from '../model/cad';
import type { CadFaceSelectionContext } from '../model/cadFaceSelection';
import type { LocalCadFeatureResult } from '../model/localCadFeature';

const backendMocks = vi.hoisted(() => ({
  createVersionSnapshot: vi.fn(),
  runCodexModelCommand: vi.fn(),
  runLocalCadFeature: vi.fn()
}));

vi.mock('../platform/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/backend')>();
  return {
    ...actual,
    createVersionSnapshot: backendMocks.createVersionSnapshot,
    runCodexModelCommand: backendMocks.runCodexModelCommand,
    runLocalCadFeature: backendMocks.runLocalCadFeature
  };
});

import { useModelStore } from './useModelStore';

const initialState = useModelStore.getState();

const readyCadResult = {
  status: 'ok',
  revision: 'local-feature-before',
  outputs: ['custom-part.stl', 'custom-part.step', 'custom-part-selection.stl', 'custom-part-face-map.json'],
  units: 'mm',
  kernel: 'OpenCascade 测试内核',
  printer: {
    model: 'Bambu Lab P1S',
    buildVolumeMm: [256, 256, 256],
    nozzleMm: 0.4
  },
  model: {
    id: 'generic-model',
    name: '通用测试模型',
    templateId: 'generic',
    templateName: '通用模型'
  },
  parameters: {},
  interfaceOpeningMode: 'custom',
  interfaceOpenings: [],
  faceMatching: {
    method: '几何签名匹配第一版',
    previousFaceCount: 1,
    currentFaceCount: 1,
    inheritedFaceCount: 1,
    newFaceCount: 0,
    disappearedFaceCount: 0,
    averageInheritedConfidence: 1,
    warning: '测试稳定面匹配'
  },
  openingValidation: {
    count: 0,
    bodyCount: 0,
    coverCount: 0,
    minimumEdgeMarginMm: null,
    minimumSpacingMm: null
  },
  parts: [{
    id: 'custom-part',
    label: '自定义零件',
    role: 'primary',
    stlFile: 'custom-part.stl',
    stepFile: 'custom-part.step',
    metrics: {
      valid: true,
      volumeMm3: 100,
      boundsMm: { x: 10, y: 20, z: 30 },
      fitsP1S: true
    },
    faceTessellation: {
      status: 'ok',
      version: 1,
      partId: 'custom-part',
      units: 'mm',
      coordinateSystem: 'OpenCascade 原始毫米坐标',
      method: '逐面三角化',
      sourceStlFile: 'custom-part.stl',
      selectionMeshFile: 'custom-part-selection.stl',
      mappingFile: 'custom-part-face-map.json',
      triangleCount: 2,
      faceCount: 1,
      linearToleranceMm: 0.05,
      angularToleranceRad: 0.1,
      faces: [{
        stableId: 'face-test',
        geometryType: 'PLANE',
        triangleStart: 0,
        triangleCount: 2,
        areaMm2: 100,
        centerMm: [0, 0, 0],
        normal: [0, 0, 1]
      }],
      warning: '测试映射只对本次选择网格有效'
    }
  }],
  assemblyFile: 'custom-model.3mf',
  files: {}
} satisfies CadGenerationResult;

const updatedCadResult = {
  ...readyCadResult,
  revision: 'local-feature-after',
  localFeatures: [{
    revision: 'local-feature-after',
    operation: 'cut-cylinder',
    partId: 'custom-part',
    stableFaceId: 'face-test',
    centerMm: { x: 1, y: 2, z: 3 },
    outwardNormal: { x: 0, y: 0, z: 1 },
    radiusMm: 2,
    depthMm: 6,
    command: '在这里开一个直径 4 毫米、深 6 毫米的圆孔',
    stableFaceStatus: 'inherited'
  }]
} satisfies CadGenerationResult;

const selection = {
  protocol: 'FormAI-CAD-局部编辑上下文',
  protocolVersion: 1,
  sourceKind: 'cad-face',
  selectionMode: 'click',
  revision: readyCadResult.revision,
  units: 'mm',
  partBoundsMm: { 'custom-part': { x: 10, y: 20, z: 30 } },
  faces: [{
    partId: 'custom-part',
    partLabel: '自定义零件',
    stableId: 'face-test',
    geometryType: 'PLANE',
    areaMm2: 100,
    centerMm: [0, 0, 0]
  }],
  hit: {
    partId: 'custom-part',
    stableId: 'face-test',
    triangleIndex: 1,
    pointMm: { x: 1, y: 2, z: 3 },
    normal: { x: 0, y: 0, z: 1 },
    meshPointMm: { x: 1, y: 2, z: 3 },
    meshNormal: { x: 0, y: 0, z: 1 },
    surfaceUv: { u: 1, v: 2 },
    uvBounds: { uMin: 0, uMax: 10, vMin: 0, vMax: 20 },
    precision: 'opencascade',
    resolutionStatus: 'resolved',
    pointDistanceMm: 0,
    normalDot: 1,
    resolutionError: null
  },
  camera: {
    positionMm: { x: 10, y: 20, z: 30 },
    projectionMatrix: [],
    viewMatrix: [],
    viewportPixels: { width: 800, height: 600 }
  },
  screenshot: null,
  parameters: initialState.parameters,
  printer: readyCadResult.printer,
  warning: '测试稳定面能力边界'
} satisfies CadFaceSelectionContext;

const edgeSelection = {
  ...selection,
  selectionMode: 'edge',
  edge: {
    partId: 'custom-part',
    partLabel: '自定义零件',
    stableFaceId: 'face-test',
    stableEdgeId: 'edge-test',
    geometryType: 'LINE',
    lengthMm: 10,
    centerMm: [1, 2, 3],
    samplePointsMm: [[-4, 2, 3], [6, 2, 3]]
  },
  hit: {
    ...selection.hit,
    stableEdgeId: 'edge-test'
  }
} satisfies CadFaceSelectionContext;

const updatedEdgeCadResult = {
  ...readyCadResult,
  revision: 'edge-feature-after',
  localFeatures: [{
    revision: 'edge-feature-after',
    operation: 'fillet-edge',
    partId: 'custom-part',
    stableFaceId: 'face-test',
    stableEdgeId: 'edge-test',
    centerMm: { x: 1, y: 2, z: 3 },
    outwardNormal: { x: 0, y: 0, z: 1 },
    radiusMm: null,
    depthMm: 0.8,
    command: '将这条边做 0.8 毫米圆角',
    stableFaceStatus: 'inherited',
    stableEdgeStatus: 'inherited'
  }]
} satisfies CadGenerationResult;

function featureResult(): LocalCadFeatureResult {
  return {
    status: 'ok',
    revision: updatedCadResult.revision,
    operation: 'cut-cylinder',
    command: '在这里开一个直径 4 毫米、深 6 毫米的圆孔',
    partId: 'custom-part',
    stableFaceId: 'face-test',
    stableFaceStatus: 'inherited',
    outputs: updatedCadResult.outputs,
    units: 'mm',
    kernel: updatedCadResult.kernel,
    validation: {
      valid: true,
      watertight: true,
      solidCount: 1,
      pointDistanceMm: 0,
      normalDot: 1,
      volumeBeforeMm3: 100,
      volumeAfterMm3: 80,
      volumeDeltaMm3: -20,
      boundsMm: { x: 10, y: 20, z: 30 }
    },
    faceMatching: updatedCadResult.faceMatching!,
    updatedCadResult,
    limitations: ['测试能力边界']
  };
}

const curvedFaceDescriptor = {
  stableId: 'face-curved',
  geometryType: 'CYLINDER',
  areaMm2: 1_000,
  centerMm: [0, 0, 0],
  normal: [1, 0, 0],
  boundsMm: { x: 20, y: 20, z: 20 },
  normalizedCenter: [0, 0, 0],
  normalizedBounds: [1, 1, 1],
  areaRatio: 0.8,
  edgeCount: 2,
  edgeGeometryTypes: { CIRCLE: 2 },
  fingerprint: 'curved-face-fingerprint',
  matchSource: 'inherited',
  matchConfidence: 1,
  matchedPreviousFingerprint: 'curved-face-fingerprint'
} satisfies CadFaceDescriptor;

const curvedCadResult = {
  ...readyCadResult,
  revision: 'curved-feature-before',
  parts: [{
    ...readyCadResult.parts[0],
    faces: [curvedFaceDescriptor],
    faceTessellation: {
      ...readyCadResult.parts[0].faceTessellation,
      faces: [{
        stableId: 'face-curved',
        geometryType: 'CYLINDER',
        triangleStart: 0,
        triangleCount: 2,
        areaMm2: 1_000,
        centerMm: [0, 0, 0],
        normal: [1, 0, 0]
      }]
    }
  }]
} satisfies CadGenerationResult;

const curvedSelection = {
  ...selection,
  revision: curvedCadResult.revision,
  faces: [{
    partId: 'custom-part',
    partLabel: '自定义零件',
    stableId: 'face-curved',
    geometryType: 'CYLINDER',
    areaMm2: 1_000,
    centerMm: [0, 0, 0]
  }],
  hit: {
    ...selection.hit,
    stableId: 'face-curved',
    pointMm: { x: 10, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    meshPointMm: { x: 10, y: 0, z: 0 },
    meshNormal: { x: 1, y: 0, z: 0 },
    surfaceUv: { u: 0, v: 10 },
    uvBounds: { uMin: 0, uMax: Math.PI * 2, vMin: 0, vMax: 20 }
  }
} satisfies CadFaceSelectionContext;

const updatedCurvedCadResult = {
  ...curvedCadResult,
  revision: 'curved-feature-after',
  localFeatures: [{
    revision: 'curved-feature-after',
    operation: 'cut-cylinder',
    partId: 'custom-part',
    stableFaceId: 'face-curved',
    centerMm: { x: 10, y: 0, z: 0 },
    outwardNormal: { x: 1, y: 0, z: 0 },
    surfaceGeometryType: 'CYLINDER',
    surfaceUv: { u: 0, v: 10 },
    radiusMm: 2,
    depthMm: 4,
    command: '在这里开一个直径 4 毫米、深 4 毫米的圆孔',
    stableFaceStatus: 'inherited'
  }]
} satisfies CadGenerationResult;

function curvedFeatureResult(): LocalCadFeatureResult {
  return {
    status: 'ok',
    revision: updatedCurvedCadResult.revision,
    operation: 'cut-cylinder',
    command: '在这里开一个直径 4 毫米、深 4 毫米的圆孔',
    partId: 'custom-part',
    stableFaceId: 'face-curved',
    stableFaceStatus: 'inherited',
    outputs: updatedCurvedCadResult.outputs,
    units: 'mm',
    kernel: updatedCurvedCadResult.kernel,
    validation: {
      valid: true,
      watertight: true,
      solidCount: 1,
      pointDistanceMm: 0,
      normalDot: 1,
      volumeBeforeMm3: 6_283.19,
      volumeAfterMm3: 6_232.92,
      volumeDeltaMm3: -50.27,
      boundsMm: { x: 20, y: 20, z: 20 },
      surfaceGeometryType: 'CYLINDER',
      surfaceUv: { u: 0, v: 10 },
      maximumAbsCurvaturePerMm: 0.1,
      minimumCurvatureRadiusMm: 10,
      curvatureRatio: 0.2,
      localWallThicknessMm: 20,
      remainingWallMm: 16,
      throughCut: false,
      interferenceCheckPassed: true,
      selfIntersectionDetected: false,
      adjacentFaceInterferenceDetected: false,
      interferingFaceCount: 0,
      interferingStableFaceIds: [],
      minimumInterferenceDistanceMm: null,
      contactFaceCount: 1,
      contactSampleCount: 7
    },
    faceMatching: updatedCurvedCadResult.faceMatching!,
    updatedCadResult: updatedCurvedCadResult,
    limitations: ['第一版曲面局部特征只支持圆形凸台或圆孔']
  };
}

function edgeFeatureResult(): LocalCadFeatureResult {
  return {
    status: 'ok',
    revision: updatedEdgeCadResult.revision,
    operation: 'fillet-edge',
    command: '将这条边做 0.8 毫米圆角',
    partId: 'custom-part',
    stableFaceId: 'face-test',
    stableEdgeId: 'edge-test',
    stableFaceStatus: 'inherited',
    stableEdgeStatus: 'inherited',
    outputs: updatedEdgeCadResult.outputs,
    units: 'mm',
    kernel: updatedEdgeCadResult.kernel,
    validation: {
      valid: true,
      watertight: true,
      solidCount: 1,
      pointDistanceMm: 0.03,
      normalDot: 1,
      volumeBeforeMm3: 100,
      volumeAfterMm3: 98,
      volumeDeltaMm3: -2,
      boundsMm: { x: 10, y: 20, z: 30 }
    },
    faceMatching: updatedEdgeCadResult.faceMatching!,
    updatedCadResult: updatedEdgeCadResult,
    limitations: ['第一版只支持平面所属单条稳定边']
  };
}

describe('稳定 CAD 局部特征命令链', () => {
  beforeEach(() => {
    backendMocks.createVersionSnapshot.mockReset().mockResolvedValue(null);
    backendMocks.runCodexModelCommand.mockReset();
    backendMocks.runLocalCadFeature.mockReset();
    useModelStore.setState({
      ...initialState,
      viewportModelSource: 'cad',
      cadStatus: 'ready',
      cadResult: readyCadResult,
      backendStatus: {
        mode: 'web',
        projectRoot: '',
        cadWorkerAvailable: true,
        codexInstalled: false,
        codexAuthenticated: false,
        codexVersion: null
      },
      aiStatus: 'local',
      aiActivity: null,
      cadFaceSelectionMode: 'click',
      cadFaceSelection: selection,
      manufacturingStatus: 'ready',
      manufacturingResult: {} as NonNullable<typeof initialState.manufacturingResult>,
      wallThicknessStatus: 'ready',
      wallThicknessResult: {} as NonNullable<typeof initialState.wallThicknessResult>,
      wallThicknessVisible: true,
      wallThicknessPicking: true,
      versionGeometryComparisonMode: 'overlay'
    });
  });

  afterEach(() => {
    useModelStore.setState(initialState, true);
  });

  it('成功后刷新 CAD、清除旧选择和派生结果，并记录新版本', async () => {
    backendMocks.runLocalCadFeature.mockResolvedValue(featureResult());
    const previousVersionCount = useModelStore.getState().versions.length;

    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 6 毫米的圆孔');

    expect(backendMocks.runLocalCadFeature).toHaveBeenCalledWith(expect.objectContaining({
      selectionRevision: 'local-feature-before',
      partId: 'custom-part',
      stableFaceId: 'face-test',
      operation: 'cut-cylinder',
      radiusMm: 2,
      depthMm: 6
    }));
    const state = useModelStore.getState();
    expect(state.cadResult).toBe(updatedCadResult);
    expect(state.cadFaceSelection).toBeNull();
    expect(state.cadFaceSelectionMode).toBe('off');
    expect(state.manufacturingResult).toBeNull();
    expect(state.wallThicknessResult).toBeNull();
    expect(state.versionGeometryComparisonMode).toBe('off');
    expect(state.versions).toHaveLength(previousVersionCount + 1);
    expect(state.messages.at(-1)?.content).toContain('原三角面索引（triangleIndex）已失效');
  });

  it('Worker 失败时保留原 CAD 和稳定面选择并给出中文错误', async () => {
    backendMocks.runLocalCadFeature.mockRejectedValue(new Error('测试布尔失败'));

    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 6 毫米的圆孔');

    const state = useModelStore.getState();
    expect(state.cadResult).toBe(readyCadResult);
    expect(state.cadFaceSelection).toBe(selection);
    expect(state.cadFaceSelectionMode).toBe('click');
    expect(state.aiError).toBe('测试布尔失败');
    expect(state.messages.at(-1)?.content).toContain('已保留修改前模型：测试布尔失败');
  });

  it('曲面圆孔成功后传递真实 UV、刷新 CAD 并显示曲率和壁厚诊断', async () => {
    useModelStore.setState({
      cadResult: curvedCadResult,
      cadFaceSelection: curvedSelection
    });
    backendMocks.runLocalCadFeature.mockResolvedValue(curvedFeatureResult());

    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 4 毫米的圆孔');

    expect(backendMocks.runLocalCadFeature).toHaveBeenCalledWith(expect.objectContaining({
      selectionRevision: 'curved-feature-before',
      partId: 'custom-part',
      stableFaceId: 'face-curved',
      operation: 'cut-cylinder',
      center: { xMm: 10, yMm: 0, zMm: 0 },
      hitNormal: { x: 1, y: 0, z: 0 },
      surfaceGeometryType: 'CYLINDER',
      surfaceUv: { u: 0, v: 10 },
      radiusMm: 2,
      depthMm: 4
    }));
    const state = useModelStore.getState();
    expect(state.cadResult).toBe(updatedCurvedCadResult);
    expect(state.cadFaceSelection).toBeNull();
    expect(state.cadFaceSelectionMode).toBe('off');
    expect(state.localCadFeaturePreview).toBeNull();
    expect(state.messages.at(-1)?.content).toContain('曲率比 0.200');
    expect(state.messages.at(-1)?.content).toContain('局部壁厚约 20.000 毫米');
    expect(state.messages.at(-1)?.content).toContain('剩余壁厚约 16.000 毫米');
    expect(state.messages.at(-1)?.content).toContain('曲面干涉检查通过');
    expect(state.messages.at(-1)?.content).toContain('检查 1 个接触面和 7 个接触采样');
    expect(state.messages.at(-1)?.content).toContain('未发现目标曲面自交或非目标面干涉');
  });

  it('曲面 Worker 失败时保留原模型、真实 UV 选择和中文错误', async () => {
    useModelStore.setState({
      cadResult: curvedCadResult,
      cadFaceSelection: curvedSelection
    });
    backendMocks.runLocalCadFeature.mockRejectedValue(new Error('曲面圆孔越过裁剪边界'));

    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 4 毫米的圆孔');

    const state = useModelStore.getState();
    expect(state.cadResult).toBe(curvedCadResult);
    expect(state.cadFaceSelection).toBe(curvedSelection);
    expect(state.cadFaceSelection?.hit?.surfaceUv).toEqual({ u: 0, v: 10 });
    expect(state.cadFaceSelectionMode).toBe('click');
    expect(state.aiError).toBe('曲面圆孔越过裁剪边界');
    expect(state.messages.at(-1)?.content).toContain('已保留修改前模型：曲面圆孔越过裁剪边界');
    expect(state.messages.at(-1)?.content).toContain('三维预览已保留，可调整尺寸后重试');
    expect(state.localCadFeaturePreview).toMatchObject({
      kind: 'subtractive',
      status: 'failed',
      errorMessage: '曲面圆孔越过裁剪边界',
      request: {
        selectionRevision: 'curved-feature-before',
        partId: 'custom-part',
        stableFaceId: 'face-curved',
        surfaceUv: { u: 0, v: 10 }
      }
    });
  });

  it('曲面干涉检查失败时阻止写入并保留橙色风险预览', async () => {
    useModelStore.setState({
      cadResult: curvedCadResult,
      cadFaceSelection: curvedSelection
    });
    const interferenceError = '曲面作用区域干涉检查未通过：圆形工具在距离点击位置约 2.000 毫米处碰到 1 个非目标稳定面（face-blocking）。已阻止写入模型，请减小半径或深度，或更换点击位置';
    backendMocks.runLocalCadFeature.mockRejectedValue(new Error(interferenceError));

    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 4 毫米的圆孔');

    const state = useModelStore.getState();
    expect(state.cadResult).toBe(curvedCadResult);
    expect(state.cadFaceSelection).toBe(curvedSelection);
    expect(state.cadFaceSelection?.hit?.surfaceUv).toEqual({ u: 0, v: 10 });
    expect(state.localCadFeaturePreview).toMatchObject({
      kind: 'subtractive',
      status: 'blocked',
      errorMessage: interferenceError,
      request: {
        selectionRevision: 'curved-feature-before',
        partId: 'custom-part',
        stableFaceId: 'face-curved'
      }
    });
    expect(state.messages.at(-1)?.content).toContain('已保留修改前模型');
    expect(state.messages.at(-1)?.content).toContain('三维预览已标记为干涉风险，已阻止写入模型');
  });

  it('曲面 Worker 执行期间保留绑定当前修订的三维预览并在成功后清除', async () => {
    useModelStore.setState({
      cadResult: curvedCadResult,
      cadFaceSelection: curvedSelection
    });
    let resolveWorker!: (result: LocalCadFeatureResult) => void;
    backendMocks.runLocalCadFeature.mockReturnValue(new Promise((resolve) => {
      resolveWorker = resolve;
    }));

    const execution = useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 4 毫米的圆孔');
    await vi.waitFor(() => expect(backendMocks.runLocalCadFeature).toHaveBeenCalledOnce());

    expect(useModelStore.getState().localCadFeaturePreview).toMatchObject({
      kind: 'subtractive',
      status: 'executing',
      request: {
        selectionRevision: 'curved-feature-before',
        partId: 'custom-part',
        stableFaceId: 'face-curved',
        center: { xMm: 10, yMm: 0, zMm: 0 },
        hitNormal: { x: 1, y: 0, z: 0 }
      }
    });

    resolveWorker(curvedFeatureResult());
    await execution;
    expect(useModelStore.getState().localCadFeaturePreview).toBeNull();
  });

  it('重新选择、关闭选择模式或修改参数时立即使失败预览失效', async () => {
    useModelStore.setState({
      cadResult: curvedCadResult,
      cadFaceSelection: curvedSelection
    });
    backendMocks.runLocalCadFeature.mockRejectedValue(new Error('测试预览失效'));
    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米、深 4 毫米的圆孔');
    const failedPreview = useModelStore.getState().localCadFeaturePreview;
    expect(failedPreview?.status).toBe('failed');

    useModelStore.getState().selectCadFaces(curvedSelection);
    expect(useModelStore.getState().localCadFeaturePreview).toBeNull();

    useModelStore.setState({ localCadFeaturePreview: failedPreview });
    useModelStore.getState().setCadFaceSelectionMode('off');
    expect(useModelStore.getState().localCadFeaturePreview).toBeNull();

    useModelStore.setState({ localCadFeaturePreview: failedPreview });
    useModelStore.getState().setParameter('wallThickness', 2.4);
    expect(useModelStore.getState().localCadFeaturePreview).toBeNull();
  });

  it('Codex 登录时只执行绑定当前选择的合法结构化圆孔计划', async () => {
    useModelStore.setState((state) => ({
      backendStatus: {
        ...state.backendStatus!,
        mode: 'tauri',
        codexInstalled: true,
        codexAuthenticated: true,
        codexVersion: '测试版本'
      }
    }));
    backendMocks.runCodexModelCommand.mockResolvedValue({
      summary: '按当前点击平面生成圆孔。',
      changes: [],
      localFeature: {
        operation: 'cut-cylinder',
        partId: 'custom-part',
        stableFaceId: 'face-test',
        radiusMm: 2.5,
        depthMm: 7,
        reason: '用户要求在当前点击位置开孔'
      }
    });
    backendMocks.runLocalCadFeature.mockResolvedValue(featureResult());

    await useModelStore.getState().executeCommand('在这里开一个直径 5 毫米、深 7 毫米的圆孔');

    expect(backendMocks.runCodexModelCommand).toHaveBeenCalledWith(
      '在这里开一个直径 5 毫米、深 7 毫米的圆孔',
      initialState.parameters,
      selection
    );
    expect(backendMocks.runLocalCadFeature).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'cut-cylinder',
      partId: 'custom-part',
      stableFaceId: 'face-test',
      radiusMm: 2.5,
      depthMm: 7,
      center: { xMm: 1, yMm: 2, zMm: 3 },
      hitNormal: { x: 0, y: 0, z: 1 }
    }));
    expect(useModelStore.getState().aiStatus).toBe('ready');
  });

  it('Codex 试图修改其他零件或稳定面时拒绝执行并保留选择', async () => {
    useModelStore.setState((state) => ({
      backendStatus: {
        ...state.backendStatus!,
        mode: 'tauri',
        codexInstalled: true,
        codexAuthenticated: true
      }
    }));
    backendMocks.runCodexModelCommand.mockResolvedValue({
      summary: '尝试修改其他面。',
      changes: [],
      localFeature: {
        operation: 'add-cylinder',
        partId: 'other-part',
        stableFaceId: 'face-other',
        radiusMm: 2,
        depthMm: 3,
        reason: '错误目标测试'
      }
    });

    await useModelStore.getState().executeCommand('在这里增加一个凸台');

    const state = useModelStore.getState();
    expect(backendMocks.runLocalCadFeature).not.toHaveBeenCalled();
    expect(state.cadResult).toBe(readyCadResult);
    expect(state.cadFaceSelection).toBe(selection);
    expect(state.cadFaceSelectionMode).toBe('click');
    expect(state.aiError).toContain('当前选择之外');
    expect(state.messages.at(-1)?.content).toContain('已保留当前模型和稳定 CAD 局部选择');
  });

  it('成功执行单边圆角后绑定稳定边、清除过期选择并提示精确复核结果', async () => {
    useModelStore.setState({
      cadFaceSelectionMode: 'edge',
      cadFaceSelection: edgeSelection
    });
    backendMocks.runLocalCadFeature.mockResolvedValue(edgeFeatureResult());

    await useModelStore.getState().executeCommand('将这条边做 0.8 毫米圆角');

    expect(backendMocks.runLocalCadFeature).toHaveBeenCalledWith(expect.objectContaining({
      selectionRevision: 'local-feature-before',
      partId: 'custom-part',
      stableFaceId: 'face-test',
      stableEdgeId: 'edge-test',
      operation: 'fillet-edge',
      depthMm: 0.8,
      radiusMm: null,
      widthMm: null,
      heightMm: null,
      lengthMm: null,
      rotationDeg: 0
    }));
    const state = useModelStore.getState();
    expect(state.cadResult).toBe(updatedEdgeCadResult);
    expect(state.cadFaceSelection).toBeNull();
    expect(state.cadFaceSelectionMode).toBe('off');
    expect(state.messages.at(-1)?.content).toContain('目标稳定边 edge-test 状态为已继承');
    expect(state.messages.at(-1)?.content).toContain('距离 0.030 毫米已通过复核');
    expect(state.messages.at(-1)?.content).toContain('原三角面索引（triangleIndex）和稳定边选择已失效');
    expect(state.messages.at(-1)?.content).toContain('继续修改前请重新选择');
  });

  it('Codex 试图切换稳定边时拒绝调用 Worker并保留当前边选择', async () => {
    useModelStore.setState((state) => ({
      backendStatus: {
        ...state.backendStatus!,
        mode: 'tauri',
        codexInstalled: true,
        codexAuthenticated: true
      },
      cadFaceSelectionMode: 'edge',
      cadFaceSelection: edgeSelection
    }));
    backendMocks.runCodexModelCommand.mockResolvedValue({
      summary: '尝试切换到其他稳定边。',
      changes: [],
      localFeature: {
        operation: 'fillet-edge',
        partId: 'custom-part',
        stableFaceId: 'face-test',
        stableEdgeId: 'edge-other',
        radiusMm: null,
        widthMm: null,
        heightMm: null,
        lengthMm: null,
        depthMm: 0.8,
        rotationDeg: 0,
        reason: '错误稳定边测试'
      }
    });

    await useModelStore.getState().executeCommand('将这条边做 0.8 毫米圆角');

    const state = useModelStore.getState();
    expect(backendMocks.runLocalCadFeature).not.toHaveBeenCalled();
    expect(state.cadResult).toBe(readyCadResult);
    expect(state.cadFaceSelection).toBe(edgeSelection);
    expect(state.cadFaceSelectionMode).toBe('edge');
    expect(state.aiError).toContain('当前选择之外的稳定边');
    expect(state.messages.at(-1)?.content).toContain('已保留当前模型和稳定 CAD 局部选择');
  });

  it('单边 Worker 失败时保留原 CAD 和当前边选择', async () => {
    useModelStore.setState({
      cadFaceSelectionMode: 'edge',
      cadFaceSelection: edgeSelection
    });
    backendMocks.runLocalCadFeature.mockRejectedValue(new Error('测试圆角失败'));

    await useModelStore.getState().executeCommand('将这条边做 0.8 毫米圆角');

    const state = useModelStore.getState();
    expect(state.cadResult).toBe(readyCadResult);
    expect(state.cadFaceSelection).toBe(edgeSelection);
    expect(state.cadFaceSelectionMode).toBe('edge');
    expect(state.aiError).toBe('测试圆角失败');
    expect(state.messages.at(-1)?.content).toContain('已保留修改前模型：测试圆角失败');
  });

  it('Codex 返回空局部计划时显示摘要但不执行 Worker', async () => {
    useModelStore.setState((state) => ({
      backendStatus: {
        ...state.backendStatus!,
        mode: 'tauri',
        codexInstalled: true,
        codexAuthenticated: true
      }
    }));
    backendMocks.runCodexModelCommand.mockResolvedValue({
      summary: '当前要求需要矩形拉伸，第一版稳定面圆柱特征暂不支持。',
      changes: [],
      localFeature: null
    });

    await useModelStore.getState().executeCommand('在这里做一个矩形凸台');

    const state = useModelStore.getState();
    expect(backendMocks.runLocalCadFeature).not.toHaveBeenCalled();
    expect(state.cadResult).toBe(readyCadResult);
    expect(state.cadFaceSelection).toBe(selection);
    expect(state.aiError).toContain('矩形拉伸');
    expect(state.messages.at(-1)?.content).toContain('矩形拉伸');
  });

  it('Codex 调用失败时不回退执行未经验证的局部修改', async () => {
    useModelStore.setState((state) => ({
      backendStatus: {
        ...state.backendStatus!,
        mode: 'tauri',
        codexInstalled: true,
        codexAuthenticated: true
      }
    }));
    backendMocks.runCodexModelCommand.mockRejectedValue(new Error('Codex 连接失败'));

    await useModelStore.getState().executeCommand('在这里开一个直径 4 毫米的圆孔');

    const state = useModelStore.getState();
    expect(backendMocks.runLocalCadFeature).not.toHaveBeenCalled();
    expect(state.cadResult).toBe(readyCadResult);
    expect(state.cadFaceSelection).toBe(selection);
    expect(state.aiError).toBe('Codex 连接失败');
    expect(state.messages.at(-1)?.content).toContain('已保留当前模型和稳定 CAD 局部选择');
  });
});
