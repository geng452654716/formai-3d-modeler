import { useMemo, useState } from 'react';
import { BoxSelect, Move3d, MousePointer2, Rotate3d, Scaling, X } from 'lucide-react';
import {
  MAX_MESH_ELEMENT_SELECTIONS,
  MESH_ELEMENT_LABELS,
  type MeshElementEditMode,
  type MeshElementSelectionMethod,
  type MeshElementTransformKind,
  type MeshElementTransformOperation,
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
  { kind: 'scale', label: '缩放', icon: Scaling }
];

function parseFinite(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 提供任意上传 STL 选择集合的受限位移、单轴旋转和均匀缩放入口。 */
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
  const applyMeshElementTransform = useModelStore((state) => state.applyMeshElementTransform);
  const clearManufacturingSplit = useModelStore((state) => state.clearManufacturingSplit);
  const [transformKind, setTransformKind] = useState<MeshElementTransformKind>('move');
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [z, setZ] = useState('0');
  const [rotationAxis, setRotationAxis] = useState<MeshTransformAxis>('z');
  const [rotationDegrees, setRotationDegrees] = useState('15');
  const [scaleFactor, setScaleFactor] = useState('1.1');

  const displacement = useMemo<MeshPointMm | null>(() => {
    const values = [parseFinite(x), parseFinite(y), parseFinite(z)];
    if (values.some((value) => value === null)) return null;
    return { x: values[0]!, y: values[1]!, z: values[2]! };
  }, [x, y, z]);
  const parsedRotation = parseFinite(rotationDegrees);
  const parsedScale = parseFinite(scaleFactor);
  const moveInvalid = !displacement
    || [displacement.x, displacement.y, displacement.z].every((value) => value === 0)
    || [displacement.x, displacement.y, displacement.z].some((value) => Math.abs(value) > 500);
  const rotationInvalid = parsedRotation === null || parsedRotation === 0 || Math.abs(parsedRotation) > 180;
  const scaleInvalid = parsedScale === null || parsedScale === 1 || parsedScale < 0.25 || parsedScale > 4;
  const operationInvalid = transformKind === 'move' ? moveInvalid : transformKind === 'rotate' ? rotationInvalid : scaleInvalid;
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
        ? `请按住鼠标拖动框选要变换的${MESH_ELEMENT_LABELS[meshElementEditMode]}`
        : `请在模型上点击要变换的${MESH_ELEMENT_LABELS[meshElementEditMode]}`;

  async function submitTransform() {
    if (operationInvalid || !selectionCurrent || isEditing) return;
    const operation: MeshElementTransformOperation = transformKind === 'move'
      ? { kind: 'move', displacementMm: displacement! }
      : transformKind === 'rotate'
        ? { kind: 'rotate', axis: rotationAxis, angleDegrees: parsedRotation! }
        : { kind: 'scale', scaleFactor: parsedScale! };
    const result = await applyMeshElementTransform(operation);
    if (result?.operation === 'move') {
      setX('0');
      setY('0');
      setZ('0');
    }
  }

  const actionText = transformKind === 'move' ? '批量应用位移' : transformKind === 'rotate' ? '统一应用旋转' : '统一应用缩放';

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
              <button key={mode} type="button" className={meshElementEditMode === mode ? 'is-active' : ''} onClick={() => setMeshElementEditMode(mode)} disabled={isEditing}>
                <MousePointer2 size={11} /> {label}
              </button>
            ))}
          </div>

          <div className="mesh-element-mode-row mesh-element-selection-methods">
            {SELECTION_METHODS.map(({ method, label, icon: Icon }) => (
              <button key={method} type="button" className={meshElementSelectionMethod === method ? 'is-active' : ''} onClick={() => setMeshElementSelectionMethod(method)} disabled={isEditing || meshElementEditMode === 'off'}>
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>

          <div className={`mesh-element-selection-summary ${selectionCurrent ? 'has-selection' : ''}`}>{selectionSummary}</div>

          <div className="mesh-element-mode-row mesh-element-transform-methods">
            {TRANSFORM_MODES.map(({ kind, label, icon: Icon }) => (
              <button key={kind} type="button" className={transformKind === kind ? 'is-active' : ''} onClick={() => setTransformKind(kind)} disabled={isEditing}>
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

          {meshElementEditError && <div className="mesh-element-error">{meshElementEditError}</div>}
          {transformKind === 'move' && moveInvalid && <div className="mesh-element-error">位移必须包含非零有限数值，且每轴不能超过 500 毫米</div>}
          {transformKind === 'rotate' && rotationInvalid && <div className="mesh-element-error">旋转角度必须是 -180° 至 180° 之间的非零有限数值</div>}
          {transformKind === 'scale' && scaleInvalid && <div className="mesh-element-error">缩放比例必须在 0.25 至 4 倍之间，且不能等于 1</div>}

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
        <span>修改后仍会重新检查退化面、封闭性、实体有效性、Solid 数量和体积。</span>
      </footer>
    </aside>
  );
}
