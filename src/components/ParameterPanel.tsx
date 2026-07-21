import { CheckCircle2, ChevronDown, Info, RotateCcw, Scissors } from 'lucide-react';
import { DEFAULT_PARAMETERS, PARAMETER_LIMITS, getOuterDimensions } from '../model/defaults';
import { describeMeshRepair } from '../model/importedModel';
import {
  INTERFACE_OPENING_FACE_LABELS,
  INTERFACE_OPENING_SHAPE_LABELS
} from '../model/interfaceOpenings';
import type { EnclosureParameters } from '../model/types';
import { useModelStore } from '../store/useModelStore';

interface ParameterControlProps {
  parameterKey: keyof EnclosureParameters;
  label: string;
  step?: number;
}

function ParameterControl({ parameterKey, label, step = 0.1 }: ParameterControlProps) {
  const value = useModelStore((state) => state.parameters[parameterKey]);
  const setParameter = useModelStore((state) => state.setParameter);
  const commitVersion = useModelStore((state) => state.commitVersion);
  const [minimum, maximum] = PARAMETER_LIMITS[parameterKey];

  return (
    <label className="parameter-control">
      <span className="parameter-label">{label}</span>
      <div className="parameter-input-row">
        <input
          type="range"
          min={minimum}
          max={maximum}
          step={step}
          value={value}
          onChange={(event) => setParameter(parameterKey, Number(event.target.value))}
          onPointerUp={() => commitVersion(`调整${label}`)}
        />
        <div className="number-field">
          <input
            type="number"
            min={minimum}
            max={maximum}
            step={step}
            value={value}
            onChange={(event) => setParameter(parameterKey, Number(event.target.value))}
            onBlur={() => commitVersion(`调整${label}`)}
          />
          <span>毫米</span>
        </div>
      </div>
    </label>
  );
}

/** 根据通用上传模型的当前选择状态生成不依赖业务类型的零件名称。 */
function getUploadedSelectionLabel(selectedObject: string, modelName: string) {
  if (selectedObject === 'uploaded-model-negative') return '带连接结构的负方向拆件';
  if (selectedObject === 'uploaded-model-positive') return '带连接结构的正方向拆件';
  return modelName;
}

/** 展示任意 STL 的几何检查和拆件结果，避免沿用示例外壳的固定参数。 */
function UploadedModelPanel() {
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const localStlEditResult = useModelStore((state) => state.localStlEditResult);
  const selectedObject = useModelStore((state) => state.selectedObject);

  if (!importedStlModel) return null;

  const { metrics } = importedStlModel;
  const { boundsMm } = metrics;
  const splitValidation = manufacturingResult?.sourceKind === 'uploaded-stl'
    ? manufacturingResult.validation
    : null;
  const axisLabel = splitValidation
    ? { x: 'X 轴（左右）', y: 'Y 轴（前后）', z: 'Z 轴（上下）' }[splitValidation.axis]
    : null;

  return (
    <aside className="parameter-panel panel">
      <div className="panel-header">
        <span>上传模型信息</span>
        <CheckCircle2 size={14} className="panel-status-icon" aria-label="模型检查通过" />
      </div>
      <div className="selection-summary">
        <div>
          <span>选中对象</span>
          <strong>{getUploadedSelectionLabel(selectedObject, importedStlModel.name)}</strong>
        </div>
        <div className="dimension-pill">
          {boundsMm.x.toFixed(1)} × {boundsMm.y.toFixed(1)} × {boundsMm.z.toFixed(1)}
        </div>
      </div>

      <section className="parameter-section">
        <h3>
          <ChevronDown size={14} /> 几何检查
        </h3>
        <dl className="model-metadata-list">
          <div><dt>原始文件</dt><dd title={importedStlModel.originalFileName}>{importedStlModel.originalFileName}</dd></div>
          <div><dt>模型类型</dt><dd>通用 STL 网格</dd></div>
          <div><dt>三角面</dt><dd>{metrics.triangleCount.toLocaleString()} 个</dd></div>
          <div><dt>封闭实体</dt><dd>{metrics.solidCount} 个</dd></div>
          <div><dt>总体积</dt><dd>{metrics.volumeMm3.toFixed(2)} 立方毫米</dd></div>
          <div><dt>网格状态</dt><dd className="metadata-success">有效、封闭、可拆件</dd></div>
        </dl>
      </section>

      <section className="parameter-section">
        <h3>
          <CheckCircle2 size={14} /> 上传网格修复
        </h3>
        <dl className="model-metadata-list">
          <div><dt>处理结果</dt><dd className="metadata-success">{describeMeshRepair(metrics.repair)}</dd></div>
          <div><dt>输入三角面</dt><dd>{metrics.repair.inputTriangleCount.toLocaleString()} 个</dd></div>
          <div><dt>输出三角面</dt><dd>{metrics.repair.outputTriangleCount.toLocaleString()} 个</dd></div>
          <div><dt>修复前开放边</dt><dd>{metrics.repair.boundaryEdgeCountBefore.toLocaleString()} 条</dd></div>
          <div><dt>修复后开放边</dt><dd className="metadata-success">{metrics.repair.boundaryEdgeCountAfter} 条</dd></div>
          <div><dt>连通网格</dt><dd>{metrics.repair.connectedComponentCount} 个</dd></div>
        </dl>
        <ul className="capability-list">
          <li>当前自动修复独立、简单、近似共面的开放孔洞</li>
          <li>非流形、分叉、嵌套或明显非共面破面会中文拒绝，不伪造实体</li>
        </ul>
      </section>

      {localStlEditResult && (
        <section className="parameter-section accent-section">
          <h3>
            <CheckCircle2 size={14} /> 局部实体修改结果
          </h3>
          <dl className="model-metadata-list">
            <div><dt>操作</dt><dd>{localStlEditResult.operation === 'add-cylinder' ? '局部圆形凸台加厚' : '局部圆孔切除'}</dd></div>
            <div><dt>修改前体积</dt><dd>{localStlEditResult.validation.volumeBeforeMm3.toFixed(2)} 立方毫米</dd></div>
            <div><dt>修改后体积</dt><dd>{localStlEditResult.validation.volumeAfterMm3.toFixed(2)} 立方毫米</dd></div>
            <div><dt>体积变化</dt><dd>{localStlEditResult.validation.volumeDeltaMm3 >= 0 ? '+' : ''}{localStlEditResult.validation.volumeDeltaMm3.toFixed(2)} 立方毫米</dd></div>
            <div><dt>实体校验</dt><dd className="metadata-success">有效、封闭、单一 Solid</dd></div>
            <div><dt>当前工作文件</dt><dd>{localStlEditResult.sourceFile}</dd></div>
          </dl>
          <ul className="capability-list">
            <li>第一版仅沿选中表面法向执行圆柱加料或切除</li>
            <li>复杂自由曲面重建、任意网格雕刻和复杂自交修复尚未实现</li>
          </ul>
        </section>
      )}

      <section className="parameter-section accent-section">
        <h3>
          <Scissors size={14} /> {splitValidation ? '精确拆件与连接结果' : '通用拆件能力'}
        </h3>
        {splitValidation ? (
          <dl className="model-metadata-list">
            <div><dt>切割方向</dt><dd>{axisLabel}</dd></div>
            <div><dt>平面坐标</dt><dd>{splitValidation.offsetMm.toFixed(2)} 毫米</dd></div>
            <div><dt>切割补面</dt><dd>{splitValidation.negativeCapFaces + splitValidation.positiveCapFaces} 个</dd></div>
            <div><dt>负方向体积</dt><dd>{splitValidation.negativeVolumeMm3.toFixed(2)} 立方毫米</dd></div>
            <div><dt>正方向体积</dt><dd>{splitValidation.positiveVolumeMm3.toFixed(2)} 立方毫米</dd></div>
            <div><dt>体积误差</dt><dd className="metadata-success">{splitValidation.volumeErrorMm3.toFixed(6)} 立方毫米</dd></div>
          </dl>
        ) : (
          <ul className="capability-list">
            <li>支持任意模型类型和文件名</li>
            <li>支持 X、Y、Z 轴任意毫米坐标拆件</li>
            <li>自动补齐切割面并验证体积守恒</li>
          </ul>
        )}
      </section>

      <div className="print-hint">
        <Info size={15} />
        <span>当前 STL 按毫米制处理。导出前请结合 P1S 的 256 × 256 × 256 毫米成型空间检查最终尺寸和打印方向。</span>
      </div>
    </aside>
  );
}

export function ParameterPanel() {
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const parameters = useModelStore((state) => state.parameters);
  const interfaceOpenings = useModelStore((state) => state.interfaceOpenings);
  const cadResult = useModelStore((state) => state.cadResult);
  const setParameter = useModelStore((state) => state.setParameter);
  const commitVersion = useModelStore((state) => state.commitVersion);
  const dimensions = getOuterDimensions(parameters);

  const resetParameters = () => {
    (Object.entries(DEFAULT_PARAMETERS) as Array<[keyof EnclosureParameters, number]>).forEach(
      ([key, value]) => setParameter(key, value)
    );
    commitVersion('恢复默认参数');
  };

  if (viewportModelSource === 'uploaded-stl' && importedStlModel) {
    return <UploadedModelPanel />;
  }

  return (
    <aside className="parameter-panel panel">
      <div className="panel-header">
        <span>模型参数</span>
        <button className="icon-button" onClick={resetParameters} title="恢复默认参数">
          <RotateCcw size={14} />
        </button>
      </div>
      <div className="selection-summary">
        <div>
          <span>选中对象</span>
          <strong>下壳体</strong>
        </div>
        <div className="dimension-pill">
          {dimensions.length.toFixed(1)} × {dimensions.width.toFixed(1)} ×{' '}
          {dimensions.height.toFixed(1)}
        </div>
      </div>

      <section className="parameter-section">
        <h3>
          <ChevronDown size={14} /> 参考元件尺寸
        </h3>
        <ParameterControl parameterKey="boardLength" label="长度" step={0.5} />
        <ParameterControl parameterKey="boardWidth" label="宽度" step={0.5} />
        <ParameterControl parameterKey="boardComponentHeight" label="元件高度" step={0.5} />
      </section>

      <section className="parameter-section accent-section">
        <h3>
          <ChevronDown size={14} /> 外壳特征
        </h3>
        <ParameterControl parameterKey="wallThickness" label="壁厚" />
        <ParameterControl parameterKey="baseThickness" label="底板厚度" />
        <ParameterControl parameterKey="cornerRadius" label="圆角半径" />
        <ParameterControl parameterKey="edgeChamfer" label="倒角宽度" />
        <ParameterControl parameterKey="clearanceXY" label="装配间隙" />
      </section>

      {interfaceOpenings === null ? (
        <section className="parameter-section">
          <h3>
            <ChevronDown size={14} /> 模板 USB-C 开孔
          </h3>
          <ParameterControl parameterKey="usbPortWidth" label="开孔宽度" />
          <ParameterControl parameterKey="usbPortHeight" label="开孔高度" />
          <ParameterControl parameterKey="usbPortBottom" label="底部偏移" />
          <ParameterControl parameterKey="usbPortOffsetY" label="水平偏移" />
        </section>
      ) : (
        <section className="parameter-section precise-opening-section">
          <h3>
            <CheckCircle2 size={14} /> 照片精确开孔
          </h3>
          <p className="precise-opening-note">
            已由照片识别与人工复核结果覆盖模板 USB 参数。照片定位锚点会随接口面尺寸变化重新计算；接口宽高和物理偏移保持毫米值，不会按比例缩放。
          </p>
          {interfaceOpenings.length > 0 ? (
            <ul className="precise-opening-list">
              {interfaceOpenings.map((opening) => (
                <li key={opening.id}>
                  <div>
                    <strong>{opening.label}</strong>
                    <span>
                      {INTERFACE_OPENING_FACE_LABELS[opening.face]} · {INTERFACE_OPENING_SHAPE_LABELS[opening.shape]} · {opening.positionReference === 'face-center-bottom'
                        ? '底边锚定，随尺寸重算'
                        : '固定坐标，建议重新复核'}
                    </span>
                  </div>
                  <b>{opening.widthMm.toFixed(2)} × {opening.heightMm.toFixed(2)} 毫米</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="precise-opening-empty">识别结果明确指定不生成接口开孔。</p>
          )}
          {cadResult?.interfaceOpeningMode === 'custom' && (
            <dl className="opening-validation-summary">
              <div><dt>已校验开孔</dt><dd>{cadResult.openingValidation.count} 个</dd></div>
              <div><dt>主体 / 上盖</dt><dd>{cadResult.openingValidation.bodyCount} / {cadResult.openingValidation.coverCount}</dd></div>
              <div><dt>最小边缘余量</dt><dd>{cadResult.openingValidation.minimumEdgeMarginMm?.toFixed(2) ?? '—'} 毫米</dd></div>
              <div><dt>最小孔间距</dt><dd>{cadResult.openingValidation.minimumSpacingMm?.toFixed(2) ?? '—'} 毫米</dd></div>
            </dl>
          )}
        </section>
      )}

      <div className="print-hint">
        <Info size={15} />
        <span>P1S · 0.4 毫米喷嘴 · PLA/PETG。当前壁厚满足双线宽打印建议。</span>
      </div>
    </aside>
  );
}
