import { useMemo, useState } from 'react';
import { BoxSelect, GitBranch, Layers3, Move3d, MousePointer2, Rotate3d, Scaling, X } from 'lucide-react';
import {
  copyMeshPlanarRegionCodexDiagnosticDifferenceSummary,
  copyMeshPlanarRegionExtrusionDiagnosticSummary,
  createMeshPlanarRegionCodexDiagnosticDifferenceSummary,
  createMeshPlanarRegionExtrusionDiagnosticSummary,
  createMeshPlanarRegionExtrusionDirectionConsistency,
  createMeshPlanarRegionExtrusionResultComparison,
  createMeshPlanarRegionExtrusionToolVolumeComparison,
  createMeshPlanarRegionExtrusionPreviewMetrics,
  createMeshPlanarRegionExtrusionPreviewProfile,
  cycleMeshPlanarRegionLoopIndex,
  MAX_MESH_ELEMENT_SELECTIONS,
  MESH_ELEMENT_LABELS,
  type MeshElementEditMode,
  type MeshPlanarRegionCodexDiagnosticFieldDifference,
  type MeshElementSelectionMethod,
  type MeshElementTransformKind,
  type MeshElementTransformOperation,
  type MeshFaceExtrusionMode,
  type MeshPointMm,
  type MeshTransformAxis
} from '../model/meshElementEdit';
import { useModelStore } from '../store/useModelStore';

const EDIT_MODES: Array<{ mode: Exclude<MeshElementEditMode, 'off'>; label: string }> = [
  { mode: 'vertex', label: '选择顶点' },
  { mode: 'edge', label: '选择边' },
  { mode: 'face', label: '选择面' }
];

const SELECTION_METHODS: Array<{
  method: MeshElementSelectionMethod;
  label: string;
  icon: typeof MousePointer2;
}> = [
  { method: 'click', label: '点击单选', icon: MousePointer2 },
  { method: 'box', label: '框选多选', icon: BoxSelect }
];

const TRANSFORM_MODES: Array<{
  kind: MeshElementTransformKind;
  label: string;
  icon: typeof Move3d;
}> = [
  { kind: 'move', label: '位移', icon: Move3d },
  { kind: 'rotate', label: '旋转', icon: Rotate3d },
  { kind: 'scale', label: '缩放', icon: Scaling },
  { kind: 'extrude-face', label: '共面区域', icon: Layers3 }
];

function parseFinite(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 在用户点击后优先使用 Clipboard API；受限预览环境超时或拒绝时退回本地选择复制。 */
async function writeDiagnosticTextToClipboard(text: string) {
  const clipboardWrite = typeof navigator !== 'undefined'
    ? navigator.clipboard?.writeText?.bind(navigator.clipboard)
    : undefined;
  if (clipboardWrite) {
    try {
      await Promise.race([
        clipboardWrite(text),
        new Promise<never>((_, reject) => window.setTimeout(
          () => reject(new Error('剪贴板写入超时')),
          1200
        ))
      ]);
      return;
    } catch {
      // 继续尝试只在当前页面存活的兼容复制，不保存诊断文本。
    }
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  textArea.remove();
  if (!copied) throw new Error('当前环境拒绝复制诊断文本');
}

type CodexDiagnosticDraftAction = 'append' | 'replace' | 'duplicate' | 'unsafe';
type CodexDiagnosticDraftApplyStatus = 'appended' | 'replaced' | 'duplicate' | 'unsafe' | 'invalid';

interface MeshElementEditPanelProps {
  codexDiagnosticDraftAction: CodexDiagnosticDraftAction;
  codexDiagnosticFieldDifferences: MeshPlanarRegionCodexDiagnosticFieldDifference[] | null;
  onApplyCodexDiagnostic: (summary: string) => CodexDiagnosticDraftApplyStatus;
}

/** 为精确 CAD 创建受管网格分支，并提供网格选择集合的受限变换入口。 */
export function MeshElementEditPanel({
  codexDiagnosticDraftAction,
  codexDiagnosticFieldDifferences,
  onApplyCodexDiagnostic
}: MeshElementEditPanelProps) {
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const importedStlStatus = useModelStore((state) => state.importedStlStatus);
  const importedStlError = useModelStore((state) => state.importedStlError);
  const cadStatus = useModelStore((state) => state.cadStatus);
  const cadResult = useModelStore((state) => state.cadResult);
  const selectedObject = useModelStore((state) => state.selectedObject);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const meshElementSelectionMethod = useModelStore((state) => state.meshElementSelectionMethod);
  const meshElementSelection = useModelStore((state) => state.meshElementSelection);
  const meshElementEditStatus = useModelStore((state) => state.meshElementEditStatus);
  const meshElementEditError = useModelStore((state) => state.meshElementEditError);
  const meshElementEditResult = useModelStore((state) => state.meshElementEditResult);
  const setMeshElementEditMode = useModelStore((state) => state.setMeshElementEditMode);
  const setMeshElementSelectionMethod = useModelStore((state) => state.setMeshElementSelectionMethod);
  const clearMeshElementSelection = useModelStore((state) => state.clearMeshElementSelection);
  const applyMeshElementTransform = useModelStore((state) => state.applyMeshElementTransform);
  const createCadMeshBranch = useModelStore((state) => state.createCadMeshBranch);
  const clearManufacturingSplit = useModelStore((state) => state.clearManufacturingSplit);
  const [cadPartSelection, setCadPartSelection] = useState('');
  const transformKind = useModelStore((state) => state.meshElementTransformKind);
  const faceExtrusionMode = useModelStore((state) => state.meshFaceExtrusionMode);
  const faceExtrusionDistance = useModelStore((state) => state.meshFaceExtrusionDistanceText);
  const meshPlanarRegionPreview = useModelStore((state) => state.meshPlanarRegionPreview);
  const meshPlanarRegionFocusedLoopIndex = useModelStore((state) => state.meshPlanarRegionFocusedLoopIndex);
  const meshPlanarRegionPreviewError = useModelStore((state) => state.meshPlanarRegionPreviewError);
  const setMeshPlanarRegionFocusedLoopIndex = useModelStore((state) => state.setMeshPlanarRegionFocusedLoopIndex);
  const setMeshElementTransformKind = useModelStore((state) => state.setMeshElementTransformKind);
  const setFaceExtrusionMode = useModelStore((state) => state.setMeshFaceExtrusionMode);
  const setFaceExtrusionDistance = useModelStore((state) => state.setMeshFaceExtrusionDistanceText);
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [z, setZ] = useState('0');
  const [rotationAxis, setRotationAxis] = useState<MeshTransformAxis>('z');
  const [rotationDegrees, setRotationDegrees] = useState('15');
  const [scaleFactor, setScaleFactor] = useState('1.1');
  const [diagnosticCopyFeedback, setDiagnosticCopyFeedback] = useState<{
    summary: string;
    status: 'copied' | 'failed';
  } | null>(null);
  const [diagnosticDifferenceCopyFeedback, setDiagnosticDifferenceCopyFeedback] = useState<{
    summary: string;
    status: 'copied' | 'failed';
  } | null>(null);
  const [diagnosticDraftFeedback, setDiagnosticDraftFeedback] = useState<{
    summary: string;
    status: CodexDiagnosticDraftApplyStatus;
  } | null>(null);

  const displacement = useMemo<MeshPointMm | null>(() => {
    const values = [parseFinite(x), parseFinite(y), parseFinite(z)];
    if (values.some((value) => value === null)) return null;
    return { x: values[0]!, y: values[1]!, z: values[2]! };
  }, [x, y, z]);
  const parsedRotation = parseFinite(rotationDegrees);
  const parsedScale = parseFinite(scaleFactor);
  const parsedFaceExtrusionDistance = parseFinite(faceExtrusionDistance);
  const meshPlanarRegionExtrusionMetrics = useMemo(() => {
    if (
      !meshPlanarRegionPreview
      || !importedStlModel
      || meshPlanarRegionPreview.revision !== importedStlModel.revision
      || parsedFaceExtrusionDistance === null
    ) return null;
    const profile = createMeshPlanarRegionExtrusionPreviewProfile(
      meshPlanarRegionPreview,
      faceExtrusionMode,
      parsedFaceExtrusionDistance
    );
    return profile ? createMeshPlanarRegionExtrusionPreviewMetrics(profile) : null;
  }, [
    faceExtrusionMode,
    importedStlModel,
    meshPlanarRegionPreview,
    parsedFaceExtrusionDistance
  ]);
  const meshPlanarRegionExtrusionResultComparison = useMemo(() => (
    meshElementEditResult && importedStlModel
      ? createMeshPlanarRegionExtrusionResultComparison(meshElementEditResult, importedStlModel.revision)
      : null
  ), [importedStlModel, meshElementEditResult]);
  const meshPlanarRegionExtrusionToolVolumeComparison = useMemo(() => (
    meshElementEditResult && importedStlModel
      ? createMeshPlanarRegionExtrusionToolVolumeComparison(meshElementEditResult, importedStlModel.revision)
      : null
  ), [importedStlModel, meshElementEditResult]);
  const meshPlanarRegionExtrusionDirectionConsistency = useMemo(() => (
    meshElementEditResult && importedStlModel
      ? createMeshPlanarRegionExtrusionDirectionConsistency(meshElementEditResult, importedStlModel.revision)
      : null
  ), [importedStlModel, meshElementEditResult]);
  const meshPlanarRegionExtrusionDiagnosticSummary = useMemo(() => (
    meshElementEditResult && importedStlModel
      ? createMeshPlanarRegionExtrusionDiagnosticSummary(meshElementEditResult, importedStlModel.revision)
      : null
  ), [importedStlModel, meshElementEditResult]);
  const diagnosticCopyStatus = diagnosticCopyFeedback?.summary === meshPlanarRegionExtrusionDiagnosticSummary
    ? diagnosticCopyFeedback.status
    : 'idle';
  const diagnosticDifferenceSummary = useMemo(() => (
    codexDiagnosticDraftAction === 'replace' && codexDiagnosticFieldDifferences?.length
      ? createMeshPlanarRegionCodexDiagnosticDifferenceSummary(codexDiagnosticFieldDifferences)
      : null
  ), [codexDiagnosticDraftAction, codexDiagnosticFieldDifferences]);
  const diagnosticDifferenceCopyStatus = diagnosticDifferenceCopyFeedback?.summary === diagnosticDifferenceSummary
    ? diagnosticDifferenceCopyFeedback.status
    : 'idle';
  const diagnosticDraftCurrent = diagnosticDraftFeedback?.summary === meshPlanarRegionExtrusionDiagnosticSummary
    && (
      !['appended', 'replaced'].includes(diagnosticDraftFeedback.status)
      || codexDiagnosticDraftAction === 'duplicate'
    )
    ? diagnosticDraftFeedback.status
    : null;
  const meshPlanarRegionChainStatus = meshPlanarRegionExtrusionDirectionConsistency
    ? {
        planar: meshPlanarRegionExtrusionToolVolumeComparison ? '平面估算已计算' : '平面估算不可用',
        tool: meshPlanarRegionExtrusionToolVolumeComparison
          ? meshPlanarRegionExtrusionToolVolumeComparison.direction === 'equal'
            ? '与平面估算一致'
            : `${meshPlanarRegionExtrusionToolVolumeComparison.direction === 'higher' ? '高于' : '低于'}平面估算`
          : '实际体积已测量',
        boolean: meshPlanarRegionExtrusionDirectionConsistency.status === 'consistent'
          ? meshPlanarRegionExtrusionDirectionConsistency.mode === 'add' ? '加料增量一致' : '压入减量一致'
          : meshPlanarRegionExtrusionDirectionConsistency.status === 'unchanged'
            ? '体积近似未变化'
            : meshPlanarRegionExtrusionDirectionConsistency.mode === 'add' ? '加料却发生减量' : '压入却发生增量'
      }
    : null;
  const moveInvalid = !displacement
    || [displacement.x, displacement.y, displacement.z].every((value) => value === 0)
    || [displacement.x, displacement.y, displacement.z].some((value) => Math.abs(value) > 500);
  const rotationInvalid = parsedRotation === null || parsedRotation === 0 || Math.abs(parsedRotation) > 180;
  const scaleInvalid = parsedScale === null || parsedScale === 1 || parsedScale < 0.25 || parsedScale > 4;
  const faceExtrusionDistanceInvalid = parsedFaceExtrusionDistance === null
    || parsedFaceExtrusionDistance < 0.2
    || parsedFaceExtrusionDistance > 100;
  const faceExtrusionSelectionInvalid = transformKind === 'extrude-face' && (
    meshElementSelection?.kind !== 'face'
    || meshElementSelection.selectionMethod !== 'click'
    || meshElementSelection.elements.length !== 1
  );
  const focusedPlanarRegionLoop = meshPlanarRegionFocusedLoopIndex === null
    ? null
    : meshPlanarRegionPreview?.boundaryLoops[meshPlanarRegionFocusedLoopIndex] ?? null;
  const focusedPlanarRegionLoopLabel = focusedPlanarRegionLoop && meshPlanarRegionPreview
    ? `${focusedPlanarRegionLoop.kind === 'outer' ? '外环' : '孔洞'} ${meshPlanarRegionPreview.boundaryLoops
      .slice(0, meshPlanarRegionFocusedLoopIndex! + 1)
      .filter((candidate) => candidate.kind === focusedPlanarRegionLoop.kind).length}`
    : '尚未聚焦';
  const operationInvalid = transformKind === 'move'
    ? moveInvalid
    : transformKind === 'rotate'
      ? rotationInvalid
      : transformKind === 'scale'
        ? scaleInvalid
        : faceExtrusionDistanceInvalid || faceExtrusionSelectionInvalid
          || !meshPlanarRegionPreview || Boolean(meshPlanarRegionPreviewError);
  const isEditing = meshElementEditStatus === 'editing';
  const selectionCurrent = Boolean(
    meshElementSelection
    && importedStlModel
    && meshElementSelection.revision === importedStlModel.revision
  );
  const selectedCadPartId = cadPartSelection && cadResult?.parts.some((part) => part.id === cadPartSelection)
    ? cadPartSelection
    : cadResult?.parts.find((part) => part.id === selectedObject)?.id ?? cadResult?.parts[0]?.id ?? '';
  const selectedCadPart = cadResult?.parts.find((part) => part.id === selectedCadPartId) ?? null;
  const isCreatingBranch = importedStlStatus === 'importing';
  const cadBranchBlockedReason = cadStatus !== 'ready' || !cadResult
    ? '请先等待精确 CAD 生成和实体校验完成。'
    : !selectedCadPart
      ? '当前 CAD 修订没有可转换的零件。'
      : null;

  /** 仅在用户主动点击时把当前几何诊断写入系统剪贴板，不保存或发送文本。 */
  async function copyPlanarRegionDiagnostic() {
    if (!meshPlanarRegionExtrusionDiagnosticSummary) return;
    const status = await copyMeshPlanarRegionExtrusionDiagnosticSummary(
      meshPlanarRegionExtrusionDiagnosticSummary,
      writeDiagnosticTextToClipboard
    );
    setDiagnosticCopyFeedback({ summary: meshPlanarRegionExtrusionDiagnosticSummary, status });
  }

  /** 仅在安全替换状态下复制有限字段变化，不读取或复制完整诊断正文。 */
  async function copyPlanarRegionDiagnosticDifferences() {
    if (!codexDiagnosticFieldDifferences?.length || !diagnosticDifferenceSummary) return;
    const status = await copyMeshPlanarRegionCodexDiagnosticDifferenceSummary(
      codexDiagnosticFieldDifferences,
      writeDiagnosticTextToClipboard
    );
    setDiagnosticDifferenceCopyFeedback({ summary: diagnosticDifferenceSummary, status });
  }

  /** 仅把当前有效诊断追加或安全替换到页面草稿，仍由用户检查并手动执行。 */
  function applyPlanarRegionDiagnosticToCodexDraft() {
    if (!meshPlanarRegionExtrusionDiagnosticSummary) return;
    const status = onApplyCodexDiagnostic(meshPlanarRegionExtrusionDiagnosticSummary);
    setDiagnosticDraftFeedback({ summary: meshPlanarRegionExtrusionDiagnosticSummary, status });
  }

  async function submitCadMeshBranch() {
    if (!selectedCadPart || cadBranchBlockedReason || isCreatingBranch) return;
    const confirmed = window.confirm(
      `要从“${selectedCadPart.label}”创建网格分支吗？\n\n`
      + '原参数化 CAD 分支会保留在版本历史中；新网格分支可以编辑顶点、边和面；'
      + '网格修改后不再保证参数化特征可编辑。'
    );
    if (!confirmed) return;
    await createCadMeshBranch(selectedCadPart.id);
  }

  if (viewportModelSource === 'cad') {
    return (
      <aside className="mesh-element-edit-panel mesh-cad-branch-panel" aria-label="创建 CAD 网格分支">
        <header>
          <div>
            <strong><GitBranch size={14} /> CAD 转网格分支</strong>
            <span>保留参数化原版 · 独立编辑当前零件</span>
          </div>
        </header>
        <div className="mesh-cad-branch-content">
          <strong>选择要转换的 CAD 零件</strong>
          <span>系统会读取当前修订的真实毫米 STL，创建独立受管工作集，不会合并其他零件。</span>
          <label>
            <span>当前零件</span>
            <select
              value={selectedCadPartId}
              onChange={(event) => setCadPartSelection(event.target.value)}
              disabled={isCreatingBranch || !cadResult?.parts.length}
            >
              {cadResult?.parts.map((part) => (
                <option key={part.id} value={part.id}>{part.label}</option>
              ))}
            </select>
          </label>
          {selectedCadPart && (
            <small>尺寸：{selectedCadPart.metrics.boundsMm.x.toFixed(2)} × {selectedCadPart.metrics.boundsMm.y.toFixed(2)} × {selectedCadPart.metrics.boundsMm.z.toFixed(2)} 毫米</small>
          )}
          {cadBranchBlockedReason && <p className="mesh-element-error">{cadBranchBlockedReason}</p>}
          {importedStlError && <p className="mesh-element-error">{importedStlError}</p>}
          <button
            type="button"
            className="mesh-cad-branch-create"
            onClick={submitCadMeshBranch}
            disabled={Boolean(cadBranchBlockedReason) || isCreatingBranch}
          >
            <GitBranch size={12} />
            {isCreatingBranch ? '正在校验并创建网格分支…' : '创建网格分支'}
          </button>
        </div>
        <footer>
          <span>原参数化 CAD 版本仍可从版本历史恢复；网格分支会单独保存精确快照。</span>
          <span>第一版支持点击或框选顶点、边、面，并执行位移、单轴旋转和均匀缩放。</span>
        </footer>
      </aside>
    );
  }

  if (viewportModelSource !== 'uploaded-stl' || !importedStlModel) return null;

  const selectionSummary = selectionCurrent && meshElementSelection
    ? `已${meshElementSelection.selectionMethod === 'box' ? '框选' : '点击选择'} ${meshElementSelection.elements.length} 个${MESH_ELEMENT_LABELS[meshElementSelection.kind]}`
    : meshElementEditMode === 'off'
      ? '请选择一种编辑元素'
      : transformKind === 'extrude-face'
        ? '请点击一个种子三角面；系统会自动扩展同一连续共面区域并确认真实外法线'
        : meshElementSelectionMethod === 'box'
          ? `请按住鼠标拖动框选要变换的${MESH_ELEMENT_LABELS[meshElementEditMode]}`
          : `请在模型上点击要变换的${MESH_ELEMENT_LABELS[meshElementEditMode]}`;

  async function submitTransform() {
    if (operationInvalid || !selectionCurrent || isEditing) return;
    const operation: MeshElementTransformOperation = transformKind === 'move'
      ? { kind: 'move', displacementMm: displacement! }
      : transformKind === 'rotate'
        ? { kind: 'rotate', axis: rotationAxis, angleDegrees: parsedRotation! }
        : transformKind === 'scale'
          ? { kind: 'scale', scaleFactor: parsedScale! }
          : { kind: 'extrude-face', mode: faceExtrusionMode, distanceMm: parsedFaceExtrusionDistance! };
    const result = await applyMeshElementTransform(operation);
    if (result?.operation === 'move') {
      setX('0');
      setY('0');
      setZ('0');
    }
  }

  const actionText = transformKind === 'move'
    ? '批量应用位移'
    : transformKind === 'rotate'
      ? '统一应用旋转'
      : transformKind === 'scale'
        ? '统一应用缩放'
        : faceExtrusionMode === 'add' ? '沿真实外法线加料' : '沿真实内法线压入';

  return (
    <aside className="mesh-element-edit-panel" aria-label="网格元素编辑">
      <header>
        <div>
          <strong><Move3d size={14} /> 网格元素编辑</strong>
          <span>{importedStlModel.branchSource ? 'CAD 派生网格分支' : '任意上传 STL'} · 源模型毫米坐标</span>
        </div>
        {meshElementEditMode !== 'off' && (
          <button type="button" className="mesh-element-exit" onClick={() => setMeshElementEditMode('off')} title="退出编辑">
            <X size={14} />
          </button>
        )}
      </header>

      {manufacturingResult ? (
        <div className="mesh-element-blocked">
          <strong>当前正在查看拆件结果</strong>
          <span>请先返回原始上传模型，再选择顶点、边或面。</span>
          <button type="button" onClick={clearManufacturingSplit}>返回原始上传模型</button>
        </div>
      ) : (
        <>
          <div className="mesh-element-mode-row">
            {EDIT_MODES.map(({ mode, label }) => (
              <button key={mode} type="button" className={meshElementEditMode === mode ? 'is-active' : ''} onClick={() => setMeshElementEditMode(mode)} disabled={isEditing || (transformKind === 'extrude-face' && mode !== 'face')}>
                <MousePointer2 size={11} /> {label}
              </button>
            ))}
          </div>

          <div className="mesh-element-mode-row mesh-element-selection-methods">
            {SELECTION_METHODS.map(({ method, label, icon: Icon }) => (
              <button key={method} type="button" className={meshElementSelectionMethod === method ? 'is-active' : ''} onClick={() => setMeshElementSelectionMethod(method)} disabled={isEditing || meshElementEditMode === 'off' || (transformKind === 'extrude-face' && method !== 'click')}>
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>

          <div className={`mesh-element-selection-summary ${selectionCurrent ? 'has-selection' : ''}`}>{selectionSummary}</div>

          <div className="mesh-element-mode-row mesh-element-transform-methods">
            {TRANSFORM_MODES.map(({ kind, label, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                className={transformKind === kind ? 'is-active' : ''}
                onClick={() => setMeshElementTransformKind(kind)}
                disabled={isEditing}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>

          {transformKind === 'move' && (
            <div className="mesh-element-displacement-grid">
              {([['X', x, setX], ['Y', y, setY], ['Z', z, setZ]] as const).map(([axis, value, update]) => (
                <label key={axis}>
                  <span>{axis} 位移</span>
                  <div><input value={value} onChange={(event) => update(event.target.value)} inputMode="decimal" disabled={isEditing} /><em>毫米</em></div>
                </label>
              ))}
            </div>
          )}

          {transformKind === 'rotate' && (
            <div className="mesh-element-transform-grid">
              <label>
                <span>源模型旋转轴</span>
                <select value={rotationAxis} onChange={(event) => setRotationAxis(event.target.value as MeshTransformAxis)} disabled={isEditing}>
                  <option value="x">X 轴</option><option value="y">Y 轴</option><option value="z">Z 轴</option>
                </select>
              </label>
              <label>
                <span>旋转角度</span>
                <div><input value={rotationDegrees} onChange={(event) => setRotationDegrees(event.target.value)} inputMode="decimal" disabled={isEditing} /><em>度</em></div>
              </label>
            </div>
          )}

          {transformKind === 'scale' && (
            <div className="mesh-element-transform-grid one-column">
              <label>
                <span>均匀缩放比例</span>
                <div><input value={scaleFactor} onChange={(event) => setScaleFactor(event.target.value)} inputMode="decimal" disabled={isEditing} /><em>倍</em></div>
              </label>
            </div>
          )}
          {transformKind === 'extrude-face' && (
            <>
            <div className="mesh-element-transform-grid">
              <label>
                <span>法向操作</span>
                <select value={faceExtrusionMode} onChange={(event) => setFaceExtrusionMode(event.target.value as MeshFaceExtrusionMode)} disabled={isEditing}>
                  <option value="add">向外加料</option>
                  <option value="cut">向内压入</option>
                </select>
              </label>
              <label>
                <span>作用距离</span>
                <div><input value={faceExtrusionDistance} onChange={(event) => setFaceExtrusionDistance(event.target.value)} inputMode="decimal" disabled={isEditing} /><em>毫米</em></div>
              </label>
            </div>
            {meshPlanarRegionPreview && meshPlanarRegionPreview.revision === importedStlModel.revision && (
              <div className="mesh-planar-region-preview">
                <strong>连续共面区域执行前预览</strong>
                <div className="mesh-planar-region-preview-grid">
                  <span>预计三角面<strong>{meshPlanarRegionPreview.affectedTriangleCount} 个</strong></span>
                  <span>区域面积<strong>{meshPlanarRegionPreview.regionAreaMm2.toFixed(2)} 平方毫米</strong></span>
                  {meshPlanarRegionExtrusionMetrics && (
                    <>
                      <span>外环面积<strong>{meshPlanarRegionExtrusionMetrics.outerAreaMm2.toFixed(2)} 平方毫米</strong></span>
                      <span>孔洞总面积<strong>{meshPlanarRegionExtrusionMetrics.holeAreaMm2.toFixed(2)} 平方毫米</strong></span>
                      <span>净作用面积<strong>{meshPlanarRegionExtrusionMetrics.netAreaMm2.toFixed(2)} 平方毫米</strong></span>
                      <span>工具体估算<strong>{meshPlanarRegionExtrusionMetrics.estimatedVolumeMm3.toFixed(2)} 立方毫米</strong></span>
                    </>
                  )}
                  <span>边界环<strong>{meshPlanarRegionPreview.boundaryLoopCount} 个</strong></span>
                  <span>外环<strong>{meshPlanarRegionPreview.outerBoundaryLoopCount} 个</strong></span>
                  <span>孔洞<strong>{meshPlanarRegionPreview.holeBoundaryLoopCount} 个</strong></span>
                  <span>法线夹角公差<strong>{meshPlanarRegionPreview.normalToleranceDegrees.toFixed(1)}°</strong></span>
                  <span>平面距离公差<strong>{meshPlanarRegionPreview.planeToleranceMm.toFixed(5)} 毫米</strong></span>
                </div>
                {meshPlanarRegionPreview.boundaryLoops.length > 1 && (
                  <div className="mesh-planar-region-loop-navigation" role="group" aria-label="边界环顺序导航">
                    <button
                      type="button"
                      onClick={() => setMeshPlanarRegionFocusedLoopIndex(cycleMeshPlanarRegionLoopIndex(
                        meshPlanarRegionFocusedLoopIndex,
                        meshPlanarRegionPreview.boundaryLoops.length,
                        'previous'
                      ))}
                    >上一个环</button>
                    <span>当前：{focusedPlanarRegionLoopLabel}</span>
                    <button
                      type="button"
                      onClick={() => setMeshPlanarRegionFocusedLoopIndex(cycleMeshPlanarRegionLoopIndex(
                        meshPlanarRegionFocusedLoopIndex,
                        meshPlanarRegionPreview.boundaryLoops.length,
                        'next'
                      ))}
                    >下一个环</button>
                  </div>
                )}
                <div className="mesh-planar-region-loop-list">
                  {meshPlanarRegionPreview.boundaryLoops.map((loop, index) => {
                    const ordinal = meshPlanarRegionPreview.boundaryLoops
                      .slice(0, index + 1)
                      .filter((candidate) => candidate.kind === loop.kind).length;
                    const label = `${loop.kind === 'outer' ? '外环' : '孔洞'} ${ordinal}`;
                    const focused = meshPlanarRegionFocusedLoopIndex === index;
                    return (
                      <button
                        type="button"
                        key={`${loop.kind}-${index}`}
                        className={focused ? 'active' : undefined}
                        aria-pressed={focused}
                        aria-label={`${focused ? '取消聚焦' : '聚焦'}${label}`}
                        onClick={() => setMeshPlanarRegionFocusedLoopIndex(focused ? null : index)}
                      >
                        <strong>{label}<small>{focused ? '已聚焦' : '点击定位'}</small></strong>
                        <em>周长 {loop.perimeterMm.toFixed(2)} 毫米 · 包围 {loop.boundsMm.widthMm.toFixed(2)} × {loop.boundsMm.heightMm.toFixed(2)} 毫米</em>
                      </button>
                    );
                  })}
                </div>
                <small className="mesh-planar-region-boundary-legend outer"><i />青绿色线框表示外环。</small>
                {meshPlanarRegionPreview.holeBoundaryLoopCount > 0 && <small className="mesh-planar-region-boundary-legend hole"><i />珊瑚色线框表示孔洞环。</small>}
                <small>环语义由种子平面二维包含关系判断；桌面 Worker 仍会独立重新扩展区域并完成全部安全校验。</small>
              </div>
            )}
            {meshPlanarRegionPreviewError && <div className="mesh-element-error">{meshPlanarRegionPreviewError}</div>}
            </>
          )}

          {meshElementEditError && <div className="mesh-element-error">{meshElementEditError}</div>}
          {transformKind === 'move' && moveInvalid && <div className="mesh-element-error">位移必须包含非零有限数值，且每轴不能超过 500 毫米</div>}
          {transformKind === 'rotate' && rotationInvalid && <div className="mesh-element-error">旋转角度必须是 -180° 至 180° 之间的非零有限数值</div>}
          {transformKind === 'scale' && scaleInvalid && <div className="mesh-element-error">缩放比例必须在 0.25 至 4 倍之间，且不能等于 1</div>}
          {transformKind === 'extrude-face' && faceExtrusionDistanceInvalid && <div className="mesh-element-error">作用距离必须在 0.20 至 100.00 毫米之间</div>}
          {transformKind === 'extrude-face' && faceExtrusionSelectionInvalid && <div className="mesh-element-error">请点击选择当前修订中的一个种子三角面</div>}

          {meshPlanarRegionExtrusionResultComparison && (
            <section className={`mesh-planar-region-result-comparison ${meshPlanarRegionExtrusionResultComparison.mode}`} aria-label="OpenCascade 执行结果体积对照">
              <strong>OpenCascade 执行结果</strong>
              <div className="mesh-planar-region-result-grid">
                {meshPlanarRegionExtrusionToolVolumeComparison && (
                  <span>执行前平面估算<strong>{meshPlanarRegionExtrusionToolVolumeComparison.planarEstimatedVolumeMm3.toFixed(2)} 立方毫米</strong></span>
                )}
                <span>实际工具体积<strong>{meshPlanarRegionExtrusionResultComparison.toolVolumeMm3.toFixed(2)} 立方毫米</strong></span>
                <span>模型体积变化<strong>{meshPlanarRegionExtrusionResultComparison.modelVolumeChangeMm3.toFixed(2)} 立方毫米</strong></span>
                <span>实际作用比例<strong>{meshPlanarRegionExtrusionResultComparison.effectRatioPercent.toFixed(2)}%</strong></span>
              </div>
              {meshPlanarRegionExtrusionToolVolumeComparison && (
                <div className={`mesh-planar-region-tool-volume-difference ${meshPlanarRegionExtrusionToolVolumeComparison.direction}`}>
                  <span>工具体构造偏差</span>
                  <strong>
                    {meshPlanarRegionExtrusionToolVolumeComparison.direction === 'equal'
                      ? '与平面估算一致'
                      : `${meshPlanarRegionExtrusionToolVolumeComparison.direction === 'higher' ? '高于' : '低于'} ${Math.abs(meshPlanarRegionExtrusionToolVolumeComparison.differenceMm3).toFixed(2)} 立方毫米`}
                    {' · '}
                    {meshPlanarRegionExtrusionToolVolumeComparison.differencePercent > 0 ? '+' : ''}{meshPlanarRegionExtrusionToolVolumeComparison.differencePercent.toFixed(2)}%
                  </strong>
                </div>
              )}
              {meshPlanarRegionExtrusionDirectionConsistency && meshPlanarRegionChainStatus && (
                <div
                  className={`mesh-planar-region-chain-status ${meshPlanarRegionExtrusionDirectionConsistency.status}`}
                  aria-label="三段体积链路状态"
                >
                  <span><small>平面轮廓</small><strong>{meshPlanarRegionChainStatus.planar}</strong></span>
                  <span><small>工具体</small><strong>{meshPlanarRegionChainStatus.tool}</strong></span>
                  <span><small>布尔作用</small><strong>{meshPlanarRegionChainStatus.boolean}</strong></span>
                </div>
              )}
              {meshPlanarRegionExtrusionDirectionConsistency?.status === 'inconsistent' && (
                <div className="mesh-planar-region-direction-warning" role="alert">
                  <strong>几何方向安全警告</strong>
                  <span>
                    结果声明为{meshPlanarRegionExtrusionDirectionConsistency.mode === 'add' ? '向外加料' : '向内压入'}，
                    但模型体积实际{meshPlanarRegionExtrusionDirectionConsistency.actualDirection === 'increase' ? '增加' : '减少'}
                    {Math.abs(meshPlanarRegionExtrusionDirectionConsistency.volumeDeltaMm3).toFixed(2)} 立方毫米；
                    请勿将其视为正常{meshPlanarRegionExtrusionDirectionConsistency.mode === 'add' ? '加料' : '压入'}结果。
                  </span>
                </div>
              )}
              {codexDiagnosticDraftAction === 'replace' && codexDiagnosticFieldDifferences?.length ? (
                <div className="mesh-planar-region-diagnostic-differences" aria-label="诊断字段变化">
                  <strong>最新诊断将更新 {codexDiagnosticFieldDifferences.length} 项</strong>
                  <ul>
                    {codexDiagnosticFieldDifferences.map((difference) => (
                      <li key={difference.key}>
                        <span>{difference.label}</span>
                        <code>{difference.previousValue} → {difference.latestValue}</code>
                      </li>
                    ))}
                  </ul>
                  <small>这里只显示变化字段；点击替换前不会修改草稿或执行指令。</small>
                  <div className={`mesh-planar-region-diagnostic-copy diagnostic-difference-copy ${diagnosticDifferenceCopyStatus}`} aria-live="polite">
                    <button
                      type="button"
                      className="codex-analysis"
                      onClick={() => void copyPlanarRegionDiagnosticDifferences()}
                    >
                      {diagnosticDifferenceCopyStatus === 'copied' ? '已复制差异摘要' : '复制差异摘要'}
                    </button>
                    {diagnosticDifferenceCopyStatus === 'copied' && <span>差异摘要已复制，不会自动发送或执行。</span>}
                    {diagnosticDifferenceCopyStatus === 'failed' && <span role="alert">复制差异摘要失败，请检查剪贴板权限。</span>}
                  </div>
                </div>
              ) : null}
              <div className={`mesh-planar-region-diagnostic-copy ${diagnosticCopyStatus}`} aria-live="polite">
                <button
                  type="button"
                  onClick={() => void copyPlanarRegionDiagnostic()}
                  disabled={!meshPlanarRegionExtrusionDiagnosticSummary}
                >
                  {diagnosticCopyStatus === 'copied' ? '已复制几何诊断' : '复制几何诊断'}
                </button>
                <button
                  type="button"
                  className="codex-analysis"
                  onClick={applyPlanarRegionDiagnosticToCodexDraft}
                  disabled={!meshPlanarRegionExtrusionDiagnosticSummary || codexDiagnosticDraftAction === 'duplicate' || codexDiagnosticDraftAction === 'unsafe'}
                >
                  {codexDiagnosticDraftAction === 'replace'
                    ? '替换为最新诊断'
                    : codexDiagnosticDraftAction === 'duplicate'
                      ? '当前诊断已在草稿'
                      : codexDiagnosticDraftAction === 'unsafe'
                        ? '诊断草稿需手工处理'
                        : '交给 Codex 分析'}
                </button>
                {diagnosticCopyStatus === 'copied' && <span>已复制到系统剪贴板，不会自动发送或保存。</span>}
                {diagnosticCopyStatus === 'failed' && <span role="alert">复制失败，请检查剪贴板权限。</span>}
                {diagnosticDraftCurrent === 'appended' && <span>已填入本地指令草稿，请检查后手动执行。</span>}
                {diagnosticDraftCurrent === 'replaced' && <span>已替换为最新诊断，请检查后手动执行。</span>}
                {diagnosticDraftCurrent === 'duplicate' && <span>当前诊断已在草稿中，无需替换。</span>}
                {diagnosticDraftCurrent === 'unsafe' && <span role="alert">旧诊断块已编辑或存在歧义，未覆盖您的文字。</span>}
                {diagnosticDraftCurrent === 'invalid' && <span role="alert">当前诊断为空，未修改指令草稿。</span>}
              </div>
              <small className="mesh-planar-region-result-note">
                {meshPlanarRegionExtrusionToolVolumeComparison
                  && '平面估算与实际工具体的差异可能来自 Wire 重建和几何容差。'}
                {meshPlanarRegionExtrusionResultComparison.mode === 'add'
                  ? '向外加料时，工具体可能与已有实体重叠。'
                  : '向内压入时，工具体可能超出实体厚度并被裁剪。'}
                模型体积变化因此可能小于工具体积；该比例不是打印材料用量。
              </small>
            </section>
          )}

          <div className="mesh-element-actions">
            <button type="button" className="mesh-element-apply" onClick={() => void submitTransform()} disabled={!selectionCurrent || operationInvalid || isEditing}>
              {isEditing ? '正在校验并写回模型…' : actionText}
            </button>
            <button type="button" onClick={clearMeshElementSelection} disabled={!meshElementSelection || isEditing}>清除选择</button>
          </div>
        </>
      )}

      <footer>
        <span>旋转和缩放以选择集合唯一源坐标的几何中心为枢轴；旋转使用源模型单轴，缩放比例限制为 0.25 至 4 倍。</span>
        <span>单次最多选择 {MAX_MESH_ELEMENT_SELECTIONS} 个同类元素；框选可能包含被遮挡区域中的元素。</span>
        <span>共面区域编辑只接受一个点击种子三角面，沿共享无向边扩展连续共面三角面，不跨越锐边或曲面；方向由 OpenCascade 实体内外分类确认。</span>
        <span>修改后仍会重新检查退化面、封闭性、实体有效性、Solid 数量和体积。</span>
      </footer>
    </aside>
  );
}
