import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CadGenerationResult } from '../model/cad';
import type { CadFaceSelectionContext } from '../model/cadFaceSelection';
import { useModelStore } from './useModelStore';

const initialState = useModelStore.getState();

const readyCadResult = {
  status: 'ok',
  revision: 'selection-test-revision',
  outputs: ['custom-part-selection.stl', 'custom-part-face-map.json'],
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
  hit: null,
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

describe('稳定 CAD 面选择状态', () => {
  beforeEach(() => {
    useModelStore.setState({
      viewportModelSource: 'cad',
      cadStatus: 'ready',
      cadResult: readyCadResult,
      manufacturingResult: null,
      versionGeometryComparisonMode: 'off',
      cadFaceSelectionMode: 'off',
      cadFaceSelection: null,
      cadFaceBoxRequest: null,
      wallThicknessPicking: true,
      wallThicknessSelection: {} as typeof initialState.wallThicknessSelection
    });
  });

  afterEach(() => {
    useModelStore.setState(initialState, true);
  });

  it('仅在当前精确 CAD 选择网格可用时进入选面模式，并关闭壁厚局部选择', () => {
    useModelStore.getState().setCadFaceSelectionMode('click');
    const state = useModelStore.getState();
    expect(state.cadFaceSelectionMode).toBe('click');
    expect(state.wallThicknessPicking).toBe(false);
    expect(state.wallThicknessSelection).toBeNull();
  });

  it.each([
    ['上传 STL', { viewportModelSource: 'uploaded-stl' as const }],
    ['CAD 尚未就绪', { cadStatus: 'stale' as const }],
    ['正在显示制造拆件', { manufacturingResult: {} as NonNullable<typeof initialState.manufacturingResult> }],
    ['正在进行版本实体对比', { versionGeometryComparisonMode: 'overlay' as const }]
  ])('%s 时拒绝进入稳定 CAD 选面模式', (_label, unavailableState) => {
    useModelStore.setState(unavailableState);
    useModelStore.getState().setCadFaceSelectionMode('box');
    expect(useModelStore.getState().cadFaceSelectionMode).toBe('off');
  });

  it('参数变化和主动清除都会使旧稳定面上下文失效', () => {
    useModelStore.setState({
      cadFaceSelectionMode: 'click',
      cadFaceSelection: selection,
      cadFaceBoxRequest: {
        id: 1,
        rectangle: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
        screenshot: null
      }
    });
    useModelStore.getState().setParameter('wallThickness', 2.4);
    expect(useModelStore.getState().cadFaceSelectionMode).toBe('off');
    expect(useModelStore.getState().cadFaceSelection).toBeNull();
    expect(useModelStore.getState().cadFaceBoxRequest).toBeNull();

    useModelStore.setState({ cadFaceSelectionMode: 'box', cadFaceSelection: selection });
    useModelStore.getState().clearCadFaceSelection();
    expect(useModelStore.getState().cadFaceSelection).toBeNull();
    expect(useModelStore.getState().cadFaceSelectionMode).toBe('box');
  });
});
