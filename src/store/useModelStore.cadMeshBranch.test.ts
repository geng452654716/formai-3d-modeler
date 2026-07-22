import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadGenerationResult } from '../model/cad';
import { DEFAULT_PARAMETERS } from '../model/defaults';
import type { ImportedStlModel } from '../model/importedModel';
import type { ModelVersion } from '../model/types';

const backendMocks = vi.hoisted(() => ({
  createCadMeshBranch: vi.fn(),
  createVersionSnapshot: vi.fn()
}));

vi.mock('../platform/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/backend')>();
  return {
    ...actual,
    createCadMeshBranch: backendMocks.createCadMeshBranch,
    createVersionSnapshot: backendMocks.createVersionSnapshot
  };
});

import { useModelStore } from './useModelStore';

const originalState = useModelStore.getState();
const cadResult = {
  status: 'ok',
  revision: 'cad-revision-43',
  outputs: ['figure-head.stl', 'figure-body.stl'],
  units: 'mm',
  kernel: 'OpenCascade 测试内核',
  printer: { model: 'Bambu Lab P1S', buildVolumeMm: [256, 256, 256], nozzleMm: 0.4 },
  model: { id: 'figure', name: '任意手办', templateId: 'generic', templateName: '通用模型' },
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
  parts: [
    {
      id: 'figure-head',
      label: '头部',
      role: 'component',
      stlFile: 'figure-head.stl',
      stepFile: 'figure-head.step',
      metrics: { valid: true, volumeMm3: 1200, boundsMm: { x: 30, y: 28, z: 35 }, fitsP1S: true }
    },
    {
      id: 'figure-body',
      label: '身体',
      role: 'primary',
      stlFile: 'figure-body.stl',
      stepFile: 'figure-body.step',
      metrics: { valid: true, volumeMm3: 3600, boundsMm: { x: 45, y: 35, z: 80 }, fitsP1S: true }
    }
  ],
  assemblyFile: 'figure.3mf',
  files: {}
} satisfies CadGenerationResult;

const repair = {
  attempted: true,
  repaired: false,
  inputTriangleCount: 120,
  outputTriangleCount: 120,
  removedDegenerateTriangleCount: 0,
  removedDuplicateTriangleCount: 0,
  boundaryEdgeCountBefore: 0,
  boundaryEdgeCountAfter: 0,
  nonManifoldEdgeCount: 0,
  connectedComponentCount: 1,
  repairedHoleCount: 0,
  addedTriangleCount: 0
};

function branchModel(): ImportedStlModel {
  return {
    status: 'ok',
    revision: 'mesh-branch-revision',
    id: 'uploaded-model',
    name: '头部-网格分支',
    originalFileName: '头部-网格分支.stl',
    sourceFile: 'imported-model-working.stl',
    originalSourceFile: 'imported-model.stl',
    sourceKind: 'uploaded-stl',
    branchSource: {
      kind: 'cad-part',
      cadRevision: cadResult.revision,
      partId: 'figure-head',
      partLabel: '头部',
      sourceStlFile: 'figure-head.stl'
    },
    units: 'mm',
    kernel: 'OpenCascade 测试内核',
    outputs: ['imported-model.stl', 'imported-model-working.stl', 'imported-model-working.step'],
    files: {},
    metrics: {
      valid: true,
      watertight: true,
      triangleCount: 120,
      solidCount: 1,
      volumeMm3: 1200,
      boundsMm: { minX: 0, minY: 0, minZ: 0, maxX: 30, maxY: 28, maxZ: 35, x: 30, y: 28, z: 35 },
      repair
    }
  };
}

function cadVersion(): ModelVersion {
  return {
    id: 'cad-main',
    label: '参数化 CAD 主分支',
    createdAt: new Date().toISOString(),
    changeKind: 'geometry',
    modelSource: 'cad',
    parameters: { ...DEFAULT_PARAMETERS },
    interfaceOpenings: null,
    objectPresentations: {}
  };
}

describe('参数化 CAD 零件受管网格分支', () => {
  beforeEach(() => {
    backendMocks.createCadMeshBranch.mockReset().mockResolvedValue(branchModel());
    backendMocks.createVersionSnapshot.mockReset().mockResolvedValue({
      directory: '/受管版本/网格分支',
      createdAt: new Date().toISOString(),
      files: []
    });
    useModelStore.setState({
      ...originalState,
      parameters: { ...DEFAULT_PARAMETERS },
      versions: [cadVersion()],
      versionIndex: 0,
      viewportModelSource: 'cad',
      cadStatus: 'ready',
      cadResult,
      selectedObject: 'figure-head',
      importedStlModel: null,
      importedStlStatus: 'idle',
      importedStlError: null,
      manufacturingStatus: 'ready',
      manufacturingResult: { revision: '旧拆件' } as never,
      wallThicknessStatus: 'ready',
      wallThicknessResult: { revision: '旧壁厚' } as never,
      wallThicknessVisible: true,
      meshElementSelection: {} as never,
      messages: []
    }, true);
  });

  afterEach(() => useModelStore.setState(originalState, true));

  it('可从任意 CAD 零件创建独立网格分支并保留原 CAD 版本', async () => {
    await expect(useModelStore.getState().createCadMeshBranch('figure-head')).resolves.toMatchObject({
      revision: 'mesh-branch-revision',
      branchSource: { partId: 'figure-head', partLabel: '头部' }
    });

    const state = useModelStore.getState();
    expect(backendMocks.createCadMeshBranch).toHaveBeenCalledWith('cad-revision-43', 'figure-head');
    expect(state.viewportModelSource).toBe('uploaded-stl');
    expect(state.importedStlModel?.branchSource?.cadRevision).toBe('cad-revision-43');
    expect(state.selectedObject).toBe('uploaded-model');
    expect(state.manufacturingResult).toBeNull();
    expect(state.wallThicknessResult).toBeNull();
    expect(state.meshElementSelection).toBeNull();
    expect(state.versions).toHaveLength(2);
    expect(state.versions[0]).toMatchObject({ id: 'cad-main', modelSource: 'cad' });
    expect(state.versions[1]).toMatchObject({
      label: '创建“头部”网格分支',
      modelSource: 'uploaded-stl',
      importedModelRevision: 'mesh-branch-revision',
      snapshotDirectory: '/受管版本/网格分支',
      meshBranchSource: { cadRevision: 'cad-revision-43', partId: 'figure-head', partLabel: '头部' }
    });
    expect(state.messages.at(-1)?.content).toContain('原 CAD 分支仍保留');
    expect(state.messages.at(-1)?.content).toContain('不再保证参数化特征可编辑');
  });

  it('CAD 尚未就绪时拒绝创建且不调用后端', async () => {
    useModelStore.setState({ cadStatus: 'stale' });
    await expect(useModelStore.getState().createCadMeshBranch('figure-head')).resolves.toBeNull();
    expect(backendMocks.createCadMeshBranch).not.toHaveBeenCalled();
    expect(useModelStore.getState().importedStlError).toContain('先完成精确 CAD 生成');
  });

  it('当前修订不存在所选零件时拒绝创建', async () => {
    await expect(useModelStore.getState().createCadMeshBranch('固定写死的零件')).resolves.toBeNull();
    expect(backendMocks.createCadMeshBranch).not.toHaveBeenCalled();
    expect(useModelStore.getState().importedStlError).toContain('没有找到所选零件');
  });
});
