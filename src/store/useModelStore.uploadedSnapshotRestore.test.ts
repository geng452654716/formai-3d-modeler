import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMETERS } from '../model/defaults';
import type { ImportedStlModel } from '../model/importedModel';
import type { ModelVersion } from '../model/types';

const backendMocks = vi.hoisted(() => ({
  restoreUploadedModelSnapshot: vi.fn()
}));

vi.mock('../platform/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/backend')>();
  return {
    ...actual,
    restoreUploadedModelSnapshot: backendMocks.restoreUploadedModelSnapshot
  };
});

import { useModelStore } from './useModelStore';

const originalState = useModelStore.getState();

function uploadedModel(revision: string, volumeMm3: number): ImportedStlModel {
  return {
    status: 'ok',
    revision,
    id: 'uploaded-model',
    name: '上传测试模型',
    originalFileName: '测试模型.stl',
    sourceFile: 'imported-model-working.stl',
    originalSourceFile: 'imported-model.stl',
    sourceKind: 'uploaded-stl',
    units: 'mm',
    kernel: 'OpenCascade 测试内核',
    outputs: ['imported-model.stl', 'imported-model-working.stl', 'imported-model-working.step'],
    files: {},
    metrics: {
      valid: true,
      watertight: true,
      triangleCount: 12,
      solidCount: 1,
      volumeMm3,
      boundsMm: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10, x: 10, y: 10, z: 10 },
      repair: {
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
      }
    }
  };
}

function version(id: string, revision: string, snapshotDirectory?: string): ModelVersion {
  return {
    id,
    label: `上传版本 ${id}`,
    createdAt: new Date().toISOString(),
    changeKind: 'geometry',
    modelSource: 'uploaded-stl',
    importedModelRevision: revision,
    snapshotDirectory,
    parameters: { ...DEFAULT_PARAMETERS },
    interfaceOpenings: null,
    objectPresentations: {}
  };
}

describe('上传模型精确版本恢复', () => {
  beforeEach(() => {
    backendMocks.restoreUploadedModelSnapshot.mockReset();
    useModelStore.setState({
      versions: [version('old', 'revision-old', '/受管版本/old'), version('new', 'revision-new', '/受管版本/new')],
      versionIndex: 1,
      viewportModelSource: 'uploaded-stl',
      importedStlModel: uploadedModel('revision-new', 1200),
      importedStlStatus: 'ready',
      versionRestoreStatus: 'idle',
      versionRestoreError: null,
      manufacturingResult: {} as never,
      wallThicknessResult: {} as never,
      meshElementSelection: {} as never
    });
  });

  afterEach(() => useModelStore.setState(originalState, true));

  it('只在 Worker 成功后移动版本索引并清理过期分析', async () => {
    const restored = uploadedModel('revision-old', 1000);
    backendMocks.restoreUploadedModelSnapshot.mockResolvedValue({
      status: 'ok',
      operation: 'restore-uploaded-model-snapshot',
      restoredRevision: 'revision-old',
      sourceKind: 'uploaded-stl',
      updatedModel: restored
    });

    await expect(useModelStore.getState().undo()).resolves.toBe(true);

    const state = useModelStore.getState();
    expect(backendMocks.restoreUploadedModelSnapshot).toHaveBeenCalledWith('/受管版本/old', 'revision-old');
    expect(state.versionIndex).toBe(0);
    expect(state.importedStlModel?.revision).toBe('revision-old');
    expect(state.manufacturingResult).toBeNull();
    expect(state.wallThicknessResult).toBeNull();
    expect(state.meshElementSelection).toBeNull();
    expect(state.versionRestoreStatus).toBe('idle');
  });

  it('恢复失败时保持版本位置和最后有效上传模型不变', async () => {
    backendMocks.restoreUploadedModelSnapshot.mockRejectedValue(new Error('快照 STEP 体积不一致'));

    await expect(useModelStore.getState().undo()).resolves.toBe(false);

    const state = useModelStore.getState();
    expect(state.versionIndex).toBe(1);
    expect(state.importedStlModel?.revision).toBe('revision-new');
    expect(state.versionRestoreStatus).toBe('error');
    expect(state.versionRestoreError).toContain('体积不一致');
  });

  it('恢复 CAD 派生网格快照时保留原 CAD 零件来源元数据', async () => {
    const restored = uploadedModel('revision-old', 1000);
    restored.branchSource = {
      kind: 'cad-part',
      cadRevision: 'cad-source-revision',
      partId: 'figure-head',
      partLabel: '头部',
      sourceStlFile: 'figure-head.stl'
    };
    useModelStore.setState({
      versions: [{
        ...version('old', 'revision-old', '/受管版本/old'),
        meshBranchSource: {
          cadRevision: 'cad-source-revision',
          partId: 'figure-head',
          partLabel: '头部'
        }
      }, version('new', 'revision-new', '/受管版本/new')],
      versionIndex: 1
    });
    backendMocks.restoreUploadedModelSnapshot.mockResolvedValue({
      status: 'ok',
      operation: 'restore-uploaded-model-snapshot',
      restoredRevision: 'revision-old',
      sourceKind: 'uploaded-stl',
      updatedModel: restored
    });

    await expect(useModelStore.getState().undo()).resolves.toBe(true);
    expect(useModelStore.getState().importedStlModel?.branchSource).toEqual({
      kind: 'cad-part',
      cadRevision: 'cad-source-revision',
      partId: 'figure-head',
      partLabel: '头部',
      sourceStlFile: 'figure-head.stl'
    });
  });

  it('参数化 CAD 版本恢复不调用上传模型恢复 Worker', async () => {
    useModelStore.setState({
      versions: [{
        id: 'cad-old',
        label: 'CAD 旧版本',
        createdAt: new Date().toISOString(),
        changeKind: 'geometry',
        modelSource: 'cad',
        parameters: { ...DEFAULT_PARAMETERS },
        interfaceOpenings: null,
        objectPresentations: {}
      }, version('new', 'revision-new', '/受管版本/new')],
      versionIndex: 1,
      versionRestoreStatus: 'idle'
    });

    await expect(useModelStore.getState().undo()).resolves.toBe(true);
    expect(backendMocks.restoreUploadedModelSnapshot).not.toHaveBeenCalled();
    expect(useModelStore.getState().versionIndex).toBe(0);
    expect(useModelStore.getState().viewportModelSource).toBe('cad');
  });
});
