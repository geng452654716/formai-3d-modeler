import { useMemo, useState } from 'react';
import { Move3d, MousePointer2, X } from 'lucide-react';
import { MESH_ELEMENT_LABELS, type MeshElementEditMode, type MeshPointMm } from '../model/meshElementEdit';
import { useModelStore } from '../store/useModelStore';

const EDIT_MODES: Array<{ mode: Exclude<MeshElementEditMode, 'off'>; label: string }> = [
  { mode: 'vertex', label: '选择顶点' },
  { mode: 'edge', label: '选择边' },
  { mode: 'face', label: '选择面' }
];

function parseDisplacement(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 提供任意上传 STL 的单个顶点、边或三角面精确毫米位移入口。 */
export function MeshElementEditPanel() {
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const meshElementSelection = useModelStore((state) => state.meshElementSelection);
  const meshElementEditStatus = useModelStore((state) => state.meshElementEditStatus);
  const meshElementEditError = useModelStore((state) => state.meshElementEditError);
  const setMeshElementEditMode = useModelStore((state) => state.setMeshElementEditMode);
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
    ? meshElementSelection.kind === 'face'
      ? `已选择第 ${meshElementSelection.triangleIndex + 1} 个三角面`
      : `已选择第 ${meshElementSelection.triangleIndex + 1} 个三角面的第 ${meshElementSelection.elementIndex + 1} 个${MESH_ELEMENT_LABELS[meshElementSelection.kind]}`
    : meshElementEditMode === 'off'
      ? '请选择一种编辑元素'
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

          <div className={`mesh-element-selection-summary ${selectionCurrent ? 'has-selection' : ''}`}>
            {selectionSummary}
          </div>

          <div className="mesh-element-displacement-grid">
            {([
              ['X', x, setX],
              ['Y', y, setY],
              ['Z', z, setZ]
            ] as const).map(([axis, value, setter]) => (
              <label key={axis}>
                <span>{axis} 位移</span>
                <div><input type="number" min={-500} max={500} step={0.1} value={value} onChange={(event) => setter(event.target.value)} disabled={isEditing} /><small>毫米</small></div>
              </label>
            ))}
          </div>

          <div className="mesh-element-actions">
            <button
              type="button"
              className="mesh-element-apply"
              onClick={() => void submitMove()}
              disabled={!selectionCurrent || !displacement || isZero || exceedsLimit || isEditing}
            >
              {isEditing ? '正在校验并应用…' : '应用位移'}
            </button>
            <button type="button" onClick={clearMeshElementSelection} disabled={!meshElementSelection || isEditing}>取消选择</button>
          </div>

          {!displacement && <p className="mesh-element-validation">请输入有效的数字位移。</p>}
          {isZero && <p className="mesh-element-validation">至少一个方向的位移不能为零。</p>}
          {exceedsLimit && <p className="mesh-element-validation">每个方向的位移范围是 -500 至 500 毫米。</p>}
          {meshElementEditError && <p className="mesh-element-error">{meshElementEditError}</p>}
        </>
      )}

      <footer>
        <span>位移使用源模型 XYZ 毫米坐标。</span>
        <span>修改后会重新执行封闭性和实体有效性检查。</span>
        <span>失败不会覆盖最后有效模型。</span>
      </footer>
    </aside>
  );
}
