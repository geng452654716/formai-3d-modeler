import { Move3D, Rotate3D, RotateCcw, Scale3D } from 'lucide-react';
import { normalizeObjectPresentation, type ObjectTransformMode, type ObjectVector3 } from '../model/objectTransform';
import { useModelStore } from '../store/useModelStore';

const modes: Array<{ mode: ObjectTransformMode; label: string; icon: typeof Move3D }> = [
  { mode: 'translate', label: '移动', icon: Move3D },
  { mode: 'rotate', label: '旋转', icon: Rotate3D },
  { mode: 'scale', label: '缩放', icon: Scale3D }
];

function selectedObjectInfo() {
  const state = useModelStore.getState();
  const id = state.selectedObject;
  if (id === 'reference') return { id, label: '参考元件', color: '#147d64' };
  if (id === 'uploaded-model-negative') return { id, label: '负方向拆件', color: '#c9d9e8' };
  if (id === 'uploaded-model-positive') return { id, label: '正方向拆件', color: '#e7d4b6' };
  if (state.importedStlModel?.id === id || id === 'uploaded-model') {
    return { id, label: state.importedStlModel?.name ?? '上传模型', color: '#d7dde4' };
  }
  const part = state.cadResult?.parts.find((item) => item.id === id);
  if (part) return { id, label: part.label, color: part.role === 'cover' ? '#eeeae1' : '#d9d4c8' };
  if (id === 'cover') return { id, label: '上盖', color: '#eeeae1' };
  return { id, label: '模型主体', color: '#d9d4c8' };
}

/** 为任意选中零件提供和三维操控器共用的精确毫米、角度、缩放与颜色入口。 */
export function ObjectTransformSection() {
  const selectedObject = useModelStore((state) => state.selectedObject);
  const objectTransformMode = useModelStore((state) => state.objectTransformMode);
  const storedPresentation = useModelStore((state) => state.objectPresentations[selectedObject]);
  const setObjectTransformMode = useModelStore((state) => state.setObjectTransformMode);
  const beginEdit = useModelStore((state) => state.beginObjectPresentationEdit);
  const updatePresentation = useModelStore((state) => state.updateObjectPresentation);
  const finishEdit = useModelStore((state) => state.finishObjectPresentationEdit);
  const resetPresentation = useModelStore((state) => state.resetObjectPresentation);
  const info = selectedObjectInfo();
  const presentation = normalizeObjectPresentation(storedPresentation, info.color);

  const updateVector = (field: 'positionMm' | 'rotationDeg', axis: keyof ObjectVector3, value: number) => {
    const current = normalizeObjectPresentation(
      useModelStore.getState().objectPresentations[info.id],
      info.color
    );
    updatePresentation(info.id, {
      transform: {
        ...current.transform,
        [field]: { ...current.transform[field], [axis]: value }
      }
    }, info.color);
  };

  const finish = (label: string) => finishEdit(info.id, label, info.color);

  return (
    <section className="parameter-section object-transform-section">
      <h3>
        <Move3D size={14} /> 对象变换与颜色
      </h3>
      <p className="object-transform-note">
        当前对象：{info.label}。位移使用毫米，旋转使用度；缩放为均匀缩放，避免打印尺寸被单轴拉伸。
      </p>
      <div className="object-transform-mode-row" role="group" aria-label="对象变换工具">
        {modes.map(({ mode, label, icon: Icon }) => (
          <button
            type="button"
            key={mode}
            className={objectTransformMode === mode ? 'is-active' : ''}
            onClick={() => setObjectTransformMode(objectTransformMode === mode ? 'select' : mode)}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>
      <div className="object-vector-grid">
        <span>位置</span>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={`位置-${axis}`}>
            <b>{axis.toUpperCase()}</b>
            <input
              type="number"
              step="0.1"
              value={presentation.transform.positionMm[axis]}
              onFocus={() => beginEdit(info.id, info.color)}
              onChange={(event) => updateVector('positionMm', axis, Number(event.target.value))}
              onBlur={() => finish(`精确移动${info.label}`)}
            />
            <small>毫米</small>
          </label>
        ))}
        <span>旋转</span>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={`旋转-${axis}`}>
            <b>{axis.toUpperCase()}</b>
            <input
              type="number"
              step="1"
              value={presentation.transform.rotationDeg[axis]}
              onFocus={() => beginEdit(info.id, info.color)}
              onChange={(event) => updateVector('rotationDeg', axis, Number(event.target.value))}
              onBlur={() => finish(`精确旋转${info.label}`)}
            />
            <small>度</small>
          </label>
        ))}
      </div>
      <div className="object-transform-bottom-row">
        <label>
          <span>均匀缩放</span>
          <input
            type="number"
            min="0.05"
            max="20"
            step="0.01"
            value={presentation.transform.scale}
            onFocus={() => beginEdit(info.id, info.color)}
            onChange={(event) => {
              const current = normalizeObjectPresentation(useModelStore.getState().objectPresentations[info.id], info.color);
              updatePresentation(info.id, {
                transform: { ...current.transform, scale: Number(event.target.value) }
              }, info.color);
            }}
            onBlur={() => finish(`精确缩放${info.label}`)}
          />
          <small>倍</small>
        </label>
        <label className="object-color-field">
          <span>零件颜色</span>
          <input
            type="color"
            value={presentation.color}
            onFocus={() => beginEdit(info.id, info.color)}
            onChange={(event) => updatePresentation(info.id, { color: event.target.value }, info.color)}
            onBlur={() => finish(`调整${info.label}颜色`)}
          />
          <code>{presentation.color.toUpperCase()}</code>
        </label>
      </div>
      <button
        type="button"
        className="object-transform-reset"
        onClick={() => resetPresentation(info.id, `重置${info.label}变换与颜色`, info.color)}
      >
        <RotateCcw size={13} /> 重置当前对象
      </button>
    </section>
  );
}
