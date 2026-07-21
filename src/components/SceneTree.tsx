import {
  Box,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Cpu,
  Cuboid,
  Eye,
  EyeOff,
  FileUp,
  Layers3,
  Minus,
  PanelTop,
  Scissors
} from 'lucide-react';
import { useModelStore } from '../store/useModelStore';

const parametricFeatures = [
  ['实体包络', Box],
  ['内部掏空', Minus],
  ['外轮廓圆角', CircleDot],
  ['顶边倒角', Layers3],
  ['接口开孔', Minus]
] as const;

export function SceneTree() {
  const selectedObject = useModelStore((state) => state.selectedObject);
  const selectObject = useModelStore((state) => state.selectObject);
  const showBoard = useModelStore((state) => state.showBoard);
  const setShowBoard = useModelStore((state) => state.setShowBoard);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const cadResult = useModelStore((state) => state.cadResult);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const showUploaded = viewportModelSource === 'uploaded-stl' && importedStlModel !== null;
  const parts = cadResult?.parts ?? [
    { id: 'body', label: '主体', role: 'primary' },
    { id: 'cover', label: '上盖', role: 'cover' }
  ];

  return (
    <aside className="scene-panel panel">
      <div className="panel-header">
        <span>场景结构</span>
        <button className="icon-button" aria-label="展开场景">
          <ChevronDown size={15} />
        </button>
      </div>
      <div className="scene-section-label">对象</div>
      <div className="scene-list">
        {showUploaded ? (
          manufacturingResult?.sourceKind === 'uploaded-stl' ? (
            <>
              <button
                className={`scene-row ${selectedObject === 'uploaded-model-negative' ? 'is-selected' : ''}`}
                onClick={() => selectObject('uploaded-model-negative')}
              >
                <Cuboid size={16} />
                <span>带连接结构的负方向拆件</span>
              </button>
              <button
                className={`scene-row ${selectedObject === 'uploaded-model-positive' ? 'is-selected' : ''}`}
                onClick={() => selectObject('uploaded-model-positive')}
              >
                <Cuboid size={16} />
                <span>带连接结构的正方向拆件</span>
              </button>
            </>
          ) : (
            <button
              className={`scene-row ${selectedObject === importedStlModel.id ? 'is-selected' : ''}`}
              onClick={() => selectObject(importedStlModel.id)}
              title={importedStlModel.originalFileName}
            >
              <FileUp size={16} />
              <span>上传模型：{importedStlModel.name}</span>
            </button>
          )
        ) : (
          <>
            {parts.map((part) => {
              const Icon = part.role === 'cover' ? PanelTop : Cuboid;
              return (
                <button
                  key={part.id}
                  className={`scene-row ${selectedObject === part.id ? 'is-selected' : ''}`}
                  onClick={() => selectObject(part.id)}
                >
                  <Icon size={16} />
                  <span>{part.label}</span>
                </button>
              );
            })}
            <button
              className={`scene-row ${selectedObject === 'reference' ? 'is-selected' : ''}`}
              onClick={() => selectObject('reference')}
            >
              <Cpu size={16} />
              <span>参考元件</span>
              <span
                className="scene-visibility"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowBoard(!showBoard);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setShowBoard(!showBoard);
                }}
              >
                {showBoard ? <Eye size={14} /> : <EyeOff size={14} />}
              </span>
            </button>
          </>
        )}
      </div>
      <div className="scene-section-label feature-heading">特征历史</div>
      <div className="feature-list">
        {showUploaded ? (
          <>
            <div className="feature-row">
              <span className="feature-index">1</span><FileUp size={14} /><span>导入 STL</span>
            </div>
            <div className="feature-row">
              <span className="feature-index">2</span><CheckCircle2 size={14} /><span>封闭性与体积检查</span>
            </div>
            {manufacturingResult?.sourceKind === 'uploaded-stl' && (
              <div className="feature-row">
                <span className="feature-index">3</span><Scissors size={14} /><span>拆件与自动补面</span>
              </div>
            )}
          </>
        ) : parametricFeatures.map(([label, Icon], index) => (
          <div className="feature-row" key={label}>
            <span className="feature-index">{index + 1}</span>
            <Icon size={14} />
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="kernel-card">
        <div className="kernel-status">
          <span className="status-dot" />
          自有 CAD 内核
        </div>
        <strong>OpenCascade / CadQuery</strong>
        <small>{showUploaded ? '毫米 · STL 分面实体 · 本地执行' : '毫米 · 参数化实体 · 本地执行'}</small>
      </div>
    </aside>
  );
}
