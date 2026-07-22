import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMETERS } from '../model/defaults';
import type { ImportedStlModel } from '../model/importedModel';
import {
  createMeshElementSelectionSet,
  type MeshElementEditResult,
  type MeshElementSelection
} from '../model/meshElementEdit';
import type { ModelVersion } from '../model/types';

const backendMocks = vi.hoisted(() => ({
  createVersionSnapshot: vi.fn(),
  runMeshElementEdit: vi.fn()
}));

vi.mock('../platform/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/backend')>();
  return {
    ...actual,
    createVersionSnapshot: backendMocks.createVersionSnapshot,
    runMeshElementEdit: backendMocks.runMeshElementEdit
  };
});

import { useModelStore } from './useModelStore';

const originalState = useModelStore.getState();
const repair = {
  attempted: true,
  repaired: false,
  inputTriangleCount: 12,
  outputTriangleCount: 12,
  removedDegenerateTriangleCount: 0,
  removedDuplicateTriangleCount: 0,
  boundaryEdgeCountBefore: 0,
  boundaryEdgeCountAfter: 0,
  nonManifoldEdgeCount: 0,
  connectedComponentCount: 1,
  repairedHoleCount: 0,
  addedTriangleCount: 0
};
const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10, x: 10, y: 10, z: 10 };

function model(revision: string): ImportedStlModel {
  return {
    status: 'ok',
    revision,
    id: 'uploaded-model',
    name: '任意上传模型',
    originalFileName: 'custom.stl',
    sourceFile: 'imported-model-working.stl',
    originalSourceFile: 'custom.stl',
    sourceKind: 'uploaded-stl',
    units: 'mm',
    kernel: 'OpenCascade 测试内核',
    outputs: ['imported-model-working.stl', 'imported-model-working.step'],
    files: {
      'imported-model-working.stl': { bytes: 128 },
      'imported-model-working.step': { bytes: 256 }
    },
    metrics: {
      valid: true,
      watertight: true,
      triangleCount: 12,
      solidCount: 1,
      volumeMm3: 1000,
      boundsMm: bounds,
      repair
    }
  };
}

function version(): ModelVersion {
  return {
    id: crypto.randomUUID(),
    label: '测试初始模型',
    createdAt: new Date().toISOString(),
    parameters: { ...DEFAULT_PARAMETERS },
    interfaceOpenings: null,
    objectPresentations: {}
  };
}

const selection: MeshElementSelection = {
  revision: 'mesh-before',
  sourcePartId: 'uploaded-model',
  kind: 'vertex',
  triangleIndex: 4,
  elementIndex: 1,
  triangleMm: [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 }
  ]
};

function result(overrides: Partial<MeshElementEditResult> = {}): MeshElementEditResult {
  return {
    status: 'ok',
    revision: 'mesh-after',
    selectionRevision: 'mesh-before',
    sourcePartId: 'uploaded-model',
    kind: 'vertex',
    selectionMethod: 'click',
    selectedElementCount: 1,
    operation: 'move',
    pivotMm: { x: 10, y: 0, z: 0 },
    displacementMm: { x: 1, y: 0, z: 0 },
    movedCoordinateCount: 1,
    movedVertexOccurrenceCount: 3,
    sourceFile: 'imported-model-working.stl',
    stepFile: 'imported-model-working.step',
    outputs: ['imported-model-working.stl', 'imported-model-working.step'],
    units: 'mm',
    kernel: 'OpenCascade 测试内核',
    validation: {
      valid: true,
      watertight: true,
      solidCountBefore: 1,
      solidCountAfter: 1,
      volumeBeforeMm3: 1000,
      volumeAfterMm3: 1010,
      volumeDeltaMm3: 10,
      boundsBeforeMm: bounds,
      boundsAfterMm: { ...bounds, maxX: 11, x: 11 }
    },
    updatedModel: model('mesh-after'),
    limitations: ['第一版不改变拓扑连接关系'],
    ...overrides
  };
}

describe('上传 STL 网格元素批量编辑', () => {
  beforeEach(() => {
    backendMocks.createVersionSnapshot.mockReset().mockResolvedValue(null);
    backendMocks.runMeshElementEdit.mockReset().mockResolvedValue(result());
    useModelStore.setState({
      parameters: { ...DEFAULT_PARAMETERS },
      versions: [version()],
      versionIndex: 0,
      importedStlModel: model('mesh-before'),
      importedStlStatus: 'ready',
      viewportModelSource: 'uploaded-stl',
      meshElementEditMode: 'off',
      meshElementSelectionMethod: 'click',
      meshElementSelection: null,
      meshElementBoxRequest: null,
      meshElementTransformKind: 'move',
      meshPlanarRegionPreview: null,
      meshPlanarRegionPreviewError: null,
      meshElementEditStatus: 'idle',
      meshElementEditError: null,
      meshElementEditResult: null,
      manufacturingStatus: 'ready',
      manufacturingResult: { revision: '旧拆件' } as never,
      wallThicknessStatus: 'ready',
      wallThicknessResult: { revision: '旧壁厚' } as never,
      wallThicknessVisible: true,
      wallThicknessPicking: true,
      wallThicknessSelection: null,
      messages: []
    });
  });

  afterEach(() => {
    useModelStore.setState(originalState, true);
  });

  it('切换元素种类或选择方式时清除不兼容集合，并退出对象变换', () => {
    useModelStore.getState().selectMeshElement(selection);
    useModelStore.getState().setMeshElementEditMode('vertex');
    expect(useModelStore.getState().meshElementSelection?.elements).toEqual([selection]);

    useModelStore.getState().setMeshElementSelectionMethod('box');
    expect(useModelStore.getState().meshElementSelection).toBeNull();
    expect(useModelStore.getState().meshElementSelectionMethod).toBe('box');

    useModelStore.getState().selectMeshElement(selection);
    useModelStore.getState().setMeshElementEditMode('edge');
    expect(useModelStore.getState().meshElementSelection).toBeNull();
    expect(useModelStore.getState().objectTransformMode).toBe('select');
    expect(useModelStore.getState().wallThicknessPicking).toBe(false);

    useModelStore.getState().setMeshElementEditMode('off');
    expect(useModelStore.getState().meshElementSelection).toBeNull();
  });

  it('切换元素、选择方式或变换操作时清除连续共面区域预览', () => {
    const preview = {
      revision: 'mesh-before', seedTriangleIndex: 4, triangleIndexes: [4, 5],
      affectedTriangleCount: 2, regionAreaMm2: 100, boundaryLoopCount: 1,
      boundaryLoopsMm: [[{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }]],
      normalToleranceDegrees: 0.5, planeToleranceMm: 0.00002
    };
    useModelStore.getState().setMeshPlanarRegionPreview(preview);
    useModelStore.getState().setMeshElementEditMode('edge');
    expect(useModelStore.getState().meshPlanarRegionPreview).toBeNull();

    useModelStore.getState().setMeshPlanarRegionPreview(preview);
    useModelStore.getState().setMeshElementSelectionMethod('box');
    expect(useModelStore.getState().meshPlanarRegionPreview).toBeNull();

    useModelStore.getState().setMeshPlanarRegionPreview(preview);
    useModelStore.getState().setMeshElementTransformKind('extrude-face');
    expect(useModelStore.getState().meshPlanarRegionPreview).toBeNull();
    expect(useModelStore.getState().meshElementEditMode).toBe('face');
    expect(useModelStore.getState().meshElementSelectionMethod).toBe('click');
  });


  it('切换 CAD 或上传模型视图时清除过期框选状态', () => {
    const selectionSet = createMeshElementSelectionSet([selection], 'box');
    useModelStore.getState().setMeshElementEditMode('vertex');
    useModelStore.getState().setMeshElementSelectionMethod('box');
    useModelStore.getState().selectMeshElements(selectionSet!);
    useModelStore.getState().requestMeshElementBoxSelection({
      id: 1,
      rectangle: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 }
    });

    useModelStore.getState().setViewportModelSource('cad');

    const state = useModelStore.getState();
    expect(state.meshElementEditMode).toBe('off');
    expect(state.meshElementSelectionMethod).toBe('click');
    expect(state.meshElementSelection).toBeNull();
    expect(state.meshElementBoxRequest).toBeNull();
  });

  it('点击单选调用集合协议并在成功后刷新模型和创建中文版本', async () => {
    useModelStore.getState().setMeshElementEditMode('vertex');
    useModelStore.getState().selectMeshElement(selection);

    const editResult = await useModelStore.getState().applyMeshElementMove({ x: 1, y: 0, z: 0 });

    expect(editResult?.revision).toBe('mesh-after');
    expect(backendMocks.runMeshElementEdit).toHaveBeenCalledWith({
      selection: {
        revision: 'mesh-before',
        sourcePartId: 'uploaded-model',
        kind: 'vertex',
        selectionMethod: 'click',
        elements: [selection]
      },
      operation: { kind: 'move', displacementMm: { x: 1, y: 0, z: 0 } }
    });
    const state = useModelStore.getState();
    expect(state.importedStlModel?.revision).toBe('mesh-after');
    expect(state.meshElementSelection).toBeNull();
    expect(state.manufacturingResult).toBeNull();
    expect(state.wallThicknessResult).toBeNull();
    expect(state.wallThicknessVisible).toBe(false);
    expect(state.versions.at(-1)?.label).toBe('批量移动上传模型顶点');
    expect(state.messages.at(-1)?.content).toContain('批量移动 1 个顶点');
    expect(state.messages.at(-1)?.content).toContain('同步更新 1 个源坐标、3 个 STL 顶点副本');
  });

  it('框选集合一次调用 Worker，并保留选择方式和元素数量', async () => {
    const second = { ...selection, triangleIndex: 5, elementIndex: 2 };
    const selectionSet = createMeshElementSelectionSet([selection, second], 'box');
    expect(selectionSet).not.toBeNull();
    backendMocks.runMeshElementEdit.mockResolvedValueOnce(result({
      selectionMethod: 'box',
      selectedElementCount: 2,
      movedCoordinateCount: 2,
      movedVertexOccurrenceCount: 6
    }));
    useModelStore.getState().setMeshElementEditMode('vertex');
    useModelStore.getState().selectMeshElements(selectionSet!);

    await useModelStore.getState().applyMeshElementMove({ x: 0.2, y: 0, z: 0 });

    expect(backendMocks.runMeshElementEdit).toHaveBeenCalledWith({
      selection: selectionSet,
      operation: { kind: 'move', displacementMm: { x: 0.2, y: 0, z: 0 } }
    });
    expect(useModelStore.getState().messages.at(-1)?.content).toContain('批量移动 2 个顶点');
  });

  it('统一旋转和均匀缩放沿用选择集合、中文版本和结果消息', async () => {
    const edgeSelection = createMeshElementSelectionSet([{ ...selection, kind: 'edge', elementIndex: 0 }], 'click')!;
    useModelStore.getState().setMeshElementEditMode('edge');
    useModelStore.getState().selectMeshElements(edgeSelection);
    backendMocks.runMeshElementEdit.mockResolvedValueOnce(result({
      kind: 'edge',
      operation: 'rotate',
      pivotMm: { x: 5, y: 0, z: 0 },
      displacementMm: undefined,
      rotationAxis: 'z',
      rotationDegrees: 30,
      movedCoordinateCount: 2
    }));

    await useModelStore.getState().applyMeshElementTransform({ kind: 'rotate', axis: 'z', angleDegrees: 30 });

    expect(backendMocks.runMeshElementEdit).toHaveBeenCalledWith({
      selection: edgeSelection,
      operation: { kind: 'rotate', axis: 'z', angleDegrees: 30 }
    });
    expect(useModelStore.getState().versions.at(-1)?.label).toBe('统一旋转上传模型边');
    expect(useModelStore.getState().messages.at(-1)?.content).toContain('绕几何中心的 Z 轴旋转 30°');

    useModelStore.setState({ importedStlModel: model('mesh-before'), meshElementSelection: edgeSelection });
    backendMocks.runMeshElementEdit.mockResolvedValueOnce(result({
      kind: 'edge',
      operation: 'scale',
      pivotMm: { x: 5, y: 0, z: 0 },
      displacementMm: undefined,
      scaleFactor: 1.2,
      movedCoordinateCount: 2
    }));
    await useModelStore.getState().applyMeshElementTransform({ kind: 'scale', scaleFactor: 1.2 });
    expect(useModelStore.getState().versions.at(-1)?.label).toBe('均匀缩放上传模型边');
    expect(useModelStore.getState().messages.at(-1)?.content).toContain('按 1.2 倍均匀缩放');
  });

  it('点击种子三角面可扩展连续共面区域并沿真实外法线加料', async () => {
    const faceSelection = createMeshElementSelectionSet([
      { ...selection, kind: 'face', elementIndex: 0 }
    ], 'click')!;
    backendMocks.runMeshElementEdit.mockResolvedValueOnce(result({
      kind: 'face',
      operation: 'extrude-face',
      faceExtrusionMode: 'add',
      distanceMm: 2,
      outwardNormal: { x: 0, y: 0, z: 1 },
      affectedTriangleCount: 2,
      regionAreaMm2: 100,
      boundaryLoopCount: 1,
      normalToleranceDegrees: 0.5,
      planeToleranceMm: 0.001,
      toolVolumeMm3: 202,
      movedCoordinateCount: 0,
      movedVertexOccurrenceCount: 0,
      validation: {
        valid: true,
        watertight: true,
        solidCountBefore: 1,
        solidCountAfter: 1,
        volumeBeforeMm3: 1000,
        volumeAfterMm3: 1040,
        volumeDeltaMm3: 40,
        boundsBeforeMm: bounds,
        boundsAfterMm: { ...bounds, maxZ: 12, z: 12 }
      }
    }));
    useModelStore.getState().setMeshElementEditMode('face');
    useModelStore.getState().selectMeshElements(faceSelection);

    const editResult = await useModelStore.getState().applyMeshElementTransform({
      kind: 'extrude-face',
      mode: 'add',
      distanceMm: 2
    });

    expect(editResult?.operation).toBe('extrude-face');
    expect(backendMocks.runMeshElementEdit).toHaveBeenCalledWith({
      selection: faceSelection,
      operation: { kind: 'extrude-face', mode: 'add', distanceMm: 2 }
    });
    expect(useModelStore.getState().versions.at(-1)?.label).toBe('共面区域向外加料上传模型');
    expect(useModelStore.getState().messages.at(-1)?.content).toContain('沿真实外法线加料 2 毫米');
    expect(useModelStore.getState().messages.at(-1)?.content).toContain('自动扩展 2 个连续共面三角面、区域面积 100.00 平方毫米、工具体积 202.00 立方毫米');
  });

  it('连续共面区域法向编辑在 Store 直接拒绝框选、多种子或非面请求', async () => {
    const boxedFaces = createMeshElementSelectionSet([
      { ...selection, kind: 'face', elementIndex: 0 },
      { ...selection, kind: 'face', triangleIndex: 5, elementIndex: 0 }
    ], 'box')!;
    useModelStore.getState().setMeshElementEditMode('face');
    useModelStore.getState().setMeshElementSelectionMethod('box');
    useModelStore.getState().selectMeshElements(boxedFaces);

    expect(await useModelStore.getState().applyMeshElementTransform({
      kind: 'extrude-face',
      mode: 'cut',
      distanceMm: 2
    })).toBeNull();
    expect(backendMocks.runMeshElementEdit).not.toHaveBeenCalled();
    expect(useModelStore.getState().meshElementEditError)
      .toBe('连续共面区域法向编辑必须且只能点击选择一个种子三角面');

    backendMocks.runMeshElementEdit.mockClear();
    useModelStore.getState().setMeshElementEditMode('vertex');
    useModelStore.getState().selectMeshElement(selection);
    expect(await useModelStore.getState().applyMeshElementTransform({
      kind: 'extrude-face',
      mode: 'add',
      distanceMm: 2
    })).toBeNull();
    expect(backendMocks.runMeshElementEdit).not.toHaveBeenCalled();
    expect(useModelStore.getState().meshElementEditError)
      .toBe('连续共面区域法向编辑必须且只能点击选择一个种子三角面');
  });

  it('Worker 失败时保留最后有效模型和整个集合并显示中文错误', async () => {
    backendMocks.runMeshElementEdit.mockRejectedValueOnce(new Error('移动后网格不再封闭'));
    useModelStore.getState().setMeshElementEditMode('face');
    useModelStore.getState().selectMeshElement({ ...selection, kind: 'face', elementIndex: 0 });

    const editResult = await useModelStore.getState().applyMeshElementMove({ x: 0, y: 0, z: 1 });

    expect(editResult).toBeNull();
    const state = useModelStore.getState();
    expect(state.importedStlModel?.revision).toBe('mesh-before');
    expect(state.meshElementSelection?.elements).toHaveLength(1);
    expect(state.meshElementEditStatus).toBe('error');
    expect(state.meshElementEditError).toBe('移动后网格不再封闭');
    expect(state.messages.at(-1)?.content).toContain('最后有效模型未被覆盖');
  });

  it('过期修订选择会在前端直接拒绝且不调用 Worker', async () => {
    useModelStore.getState().setMeshElementEditMode('vertex');
    useModelStore.getState().selectMeshElement({ ...selection, revision: '过期修订' });

    const editResult = await useModelStore.getState().applyMeshElementMove({ x: 1, y: 0, z: 0 });

    expect(editResult).toBeNull();
    expect(backendMocks.runMeshElementEdit).not.toHaveBeenCalled();
    expect(useModelStore.getState().meshElementSelection).toBeNull();
    expect(useModelStore.getState().meshElementEditError).toBe('模型已变化，请重新选择网格元素');
  });
});
