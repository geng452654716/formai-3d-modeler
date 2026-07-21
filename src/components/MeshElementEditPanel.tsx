import { useMemo, useState } from 'react';
import { BoxSelect, Move3d, MousePointer2, X } from 'lucide-react';
import {
  MAX_MESH_ELEMENT_SELECTIONS,
  MESH_ELEMENT_LABELS,
  type MeshElementEditMode,
  type MeshElementSelectionMethod,
  type MeshPointMm
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

function parseDisplacement(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 提供任意上传 STL 的点击或框选批量网格元素精确毫米位移入口。 */
export function MeshElementEditPanel() {
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const meshElementSelectionMethod = useModelStore((state) => state.meshElementSelectionMethod);
  const meshElementSelection = useModelStore((state) => state.meshElementSelection);
  const meshElementEditStatus = useModelStore((state) => state.meshElementEditStatus);
  const meshElementEditError = useModelStore((state) => state.meshElementEditError);
  const setMeshElementEditMode = useModelStore((state) => state.setMeshElementEditMode);
  const setMeshElementSelectionMethod = useModelStore((state) => state.setMeshElementSelectionMethod);
  const clearMeshElementSelection = useModelStore((state) => state.clearMeshElementSelection);
  const applyMeshElementMove = useModelStore((state) => state.applyMeshElementMove);
  const clearManufacturingSplit = useModelStore((state) => state.clearManufacturingSplit);
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [z, setZ] = useState('0');

  const displacement = useMemo<MeshPointMm | null>(() => {
    const values = [parseDisplacement(x), parseDisplacement(y), parseDisplacement(z)];
    if (values.some((value) => value === null)) return null;
    return { x: values[0]!, y: values[1]!, z: values[2]! };
  }, [x, y, z]);
  const isZero = displacement !== null
    && displacement.x === 0
    && displacement.y === 0
    && displacement.z === 0;
  const exceedsLimit = displacement !== null
    && [displacement.x, displacement.y, displacement.z].some((value) => Math.abs(value) > 500);
  const isEditing = meshElementEditStatus === 'editing';
  const selectionCurrent = Boolean(
    meshElementSelection
    && importedStlModel
    && meshElementSelection.revision === importedStlModel.revision
  );

  if (viewportModelSource !== 'uploaded-stl' || !importedStlModel) return null;

  const selectionSummary = selectionCurrent && meshElementSelection
    ? `已${meshElementSelection.selectionMethod === 'box' ? '框选' : '点击选择'} ${meshElementSelection.elements.length} 个${MESH_ELEMENT_LABELS[meshElementSelection.kind]}`
    : meshElementEditMode === 'off'
      ? '请选择一种编辑元素'
      : meshElementSelectionMethod === 'box'
        ? `请按住鼠标拖动框选要移动的${MESH_ELEMENT_LABELS[meshElementEditMode]}`
        : `请在模型上点击要移动的${MESH_ELEMENT_LABELS[meshElementEditMode]}`;

  async function submitMove() {
    if (!displacement || isZero || exceedsLimit || !selectionCurrent || isEditing) return;
    const result = await applyMeshElementMove(displacement);
    if (result) {
      setX('0');
      setY('0');
      setZ('0');
    }
  }

  return (
    <aside className="mesh-element-edit-panel" aria-label="网格元素编辑">
      <header>
        <div>
          <strong><Move3d size={14} /> 网格元素编辑</strong>
          <span>任意上传 STL · 源模型毫米坐标</span>
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
              <button
                key={mode}
                type="button"
                className={meshElementEditMode === mode ? 'is-active' : ''}
                onClick={() => setMeshElementEditMode(mode)}
                disabled={isEditing}
              >
                <MousePointer2 size={11} /> {label}
              </button>
            ))}
          </div>

          <div className="mesh-element-mode-row mesh-element-selection-methods">
            {SELECTION_METHODS.map(({ method, label, icon: Icon }) => (
              <button
                key={method}
                type="button"
                className={meshElementSelectionMethod === method ? 'is-active' : ''}
                onClick={() => setMeshElementSelectionMethod(method)}
                disabled={isEditing || meshElementEditMode === 'off'}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>

          <div className={`mesh-element-selection-summary ${selectionCurrent ? 'has-selection' : ''}`}>
            {selectionSummary}
          </div>

          <div className="mesh-element-displacement-grid">
            {([['X', x, setX], ['Y', y, setY], ['Z', z, setZ]] as const).map(([axis, value, update]) => (
              <label key={axis}>
                <span>{axis} 位移</span>
                <div><input value={value} onChange={(event) => update(event.target.value)} inputMode="decimal" disabled={isEditing} /><em>毫米</em></div>
              </label>
            ))}
          </div>

          {meshElementEditError && <div className="mesh-element-error">{meshElementEditError}</div>}
          {!displacement && <div className="mesh-element-error">位移必须是有效数字</div>}
          {exceedsLimit && <div className="mesh-element-error">每个坐标轴的单次位移不能超过 500 毫米</div>}

          <div className="mesh-element-actions">
            <button
              type="button"
              className="mesh-element-apply"
              onClick={() => void submitMove()}
              disabled={!selectionCurrent || !displacement || isZero || exceedsLimit || isEditing}
            >
              {isEditing ? '正在校验并批量移动…' : '批量应用位移'}
            </button>
            <button type="button" onClick={clearMeshElementSelection} disabled={!meshElementSelection || isEditing}>清除选择</button>
          </div>
        </>
      )}

      <footer>
        <span>单次最多选择 {MAX_MESH_ELEMENT_SELECTIONS} 个同类元素；超出时按网格遍历顺序保留前 {MAX_MESH_ELEMENT_SELECTIONS} 个，顶点和边按源坐标去重。</span>
        <span>框选使用当前视角的屏幕投影，可能包含被遮挡区域中的元素。</span>
        <span>修改后仍会重新检查退化面、封闭性、实体有效性、Solid 数量和体积。</span>
      </footer>
    </aside>
  );
}
