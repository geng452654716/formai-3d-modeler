import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMETERS } from '../model/defaults';
import type { ImportedStlModel } from '../model/importedModel';
import type { MeshElementEditResult, MeshElementSelection } from '../model/meshElementEdit';
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

function result(): MeshElementEditResult {
  return {
    status: 'ok',
    revision: 'mesh-after',
    selectionRevision: 'mesh-before',
    sourcePartId: 'uploaded-model',
    kind: 'vertex',
    triangleIndex: 4,
    elementIndex: 1,
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
    limitations: ['第一版不改变拓扑连接关系']
  };
}

describe('上传 STL 网格元素手工编辑', () => {
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
      meshElementSelection: null,
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

  it('切换顶点、边、面模式时清除不兼容选择，并退出对象变换', () => {
    useModelStore.getState().selectMeshElement(selection);
    useModelStore.getState().setMeshElementEditMode('vertex');
    expect(useModelStore.getState().meshElementSelection).toEqual(selection);

    useModelStore.getState().setMeshElementEditMode('edge');
    expect(useModelStore.getState().meshElementSelection).toBeNull();
    expect(useModelStore.getState().objectTransformMode).toBe('select');
    expect(useModelStore.getState().wallThicknessPicking).toBe(false);

    useModelStore.getState().setMeshElementEditMode('off');
    expect(useModelStore.getState().meshElementSelection).toBeNull();
  });

  it('调用真实协议并在成功后刷新模型、清除过期分析和创建中文版本', async () => {
    useModelStore.getState().setMeshElementEditMode('vertex');
    useModelStore.getState().selectMeshElement(selection);

    const editResult = await useModelStore.getState().applyMeshElementMove({ x: 1, y: 0, z: 0 });

    expect(editResult?.revision).toBe('mesh-after');
    expect(backendMocks.runMeshElementEdit).toHaveBeenCalledWith({
      selection,
      displacementMm: { x: 1, y: 0, z: 0 }
    });
    const state = useModelStore.getState();
    expect(state.importedStlModel?.revision).toBe('mesh-after');
    expect(state.meshElementSelection).toBeNull();
    expect(state.manufacturingResult).toBeNull();
    expect(state.wallThicknessResult).toBeNull();
    expect(state.wallThicknessVisible).toBe(false);
    expect(state.versions.at(-1)?.label).toBe('移动上传模型顶点');
    expect(state.messages.at(-1)?.content).toContain('同步更新 1 个源坐标、3 个 STL 顶点副本');
  });

  it('Worker 失败时保留最后有效模型并显示中文错误', async () => {
    backendMocks.runMeshElementEdit.mockRejectedValueOnce(new Error('移动后网格不再封闭'));
    useModelStore.getState().setMeshElementEditMode('face');
    useModelStore.getState().selectMeshElement({ ...selection, kind: 'face', elementIndex: 0 });

    const editResult = await useModelStore.getState().applyMeshElementMove({ x: 0, y: 0, z: 1 });

    expect(editResult).toBeNull();
    const state = useModelStore.getState();
    expect(state.importedStlModel?.revision).toBe('mesh-before');
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
