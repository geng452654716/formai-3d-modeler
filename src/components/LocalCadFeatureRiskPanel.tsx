import { useEffect, useMemo, useState } from 'react';
import {
  buildAdjustedLocalCadFeatureCommand,
  createLocalCadFeatureAdjustment,
  type LocalCadFeatureAdjustment,
  type LocalCadFeaturePreview
} from '../model/localCadFeature';
import { useModelStore } from '../store/useModelStore';

type EditableField = keyof LocalCadFeatureAdjustment;
type EditableValues = Record<EditableField, string>;

function adjustmentToEditable(adjustment: LocalCadFeatureAdjustment): EditableValues {
  return {
    diameterMm: adjustment.diameterMm?.toString() ?? '',
    widthMm: adjustment.widthMm?.toString() ?? '',
    heightMm: adjustment.heightMm?.toString() ?? '',
    lengthMm: adjustment.lengthMm?.toString() ?? '',
    depthMm: adjustment.depthMm.toString(),
    rotationDeg: adjustment.rotationDeg.toString()
  };
}

function editableToAdjustment(values: EditableValues): LocalCadFeatureAdjustment {
  const optionalNumber = (value: string) => value.trim() ? Number(value) : null;
  return {
    diameterMm: optionalNumber(values.diameterMm),
    widthMm: optionalNumber(values.widthMm),
    heightMm: optionalNumber(values.heightMm),
    lengthMm: optionalNumber(values.lengthMm),
    depthMm: Number(values.depthMm),
    rotationDeg: Number(values.rotationDeg)
  };
}

function ParameterInput({
  label,
  field,
  value,
  unit,
  onChange
}: {
  label: string;
  field: EditableField;
  value: string;
  unit: string;
  onChange: (field: EditableField, value: string) => void;
}) {
  return (
    <label className="local-cad-risk-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          step={field === 'rotationDeg' ? '1' : '0.1'}
          value={value}
          onChange={(event) => onChange(field, event.target.value)}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}

/** 在精确预检阻断后提供测量、干涉面定位和受限参数重试入口。 */
export function LocalCadFeatureRiskPanel({ preview }: { preview: LocalCadFeaturePreview }) {
  const executeCommand = useModelStore((state) => state.executeCommand);
  const aiStatus = useModelStore((state) => state.aiStatus);
  const clearPreview = useModelStore((state) => state.clearLocalCadFeaturePreview);
  const focusInterferenceFace = useModelStore((state) => state.focusLocalCadFeatureInterferenceFace);
  const originalAdjustment = useMemo(
    () => createLocalCadFeatureAdjustment(preview.request),
    [preview.request]
  );
  const [values, setValues] = useState(() => adjustmentToEditable(originalAdjustment));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(adjustmentToEditable(originalAdjustment));
    setError(null);
  }, [originalAdjustment]);

  const validation = preview.preflight?.validation;
  if (preview.status !== 'blocked' || !validation) return null;

  const circular = preview.request.operation === 'add-cylinder' || preview.request.operation === 'cut-cylinder';
  const rectangular = preview.request.operation === 'add-rectangle' || preview.request.operation === 'cut-rectangle';
  const slot = preview.request.operation === 'cut-slot';
  const updateValue = (field: EditableField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setError(null);
  };
  const retry = async () => {
    try {
      const command = buildAdjustedLocalCadFeatureCommand(
        preview.request,
        editableToAdjustment(values)
      );
      setError(null);
      await executeCommand(command);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '风险参数无效，请检查后重试');
    }
  };

  return (
    <div className="local-cad-risk-panel">
      <div className="local-cad-risk-section">
        <strong>精确工具体测量</strong>
        <div className="local-cad-risk-metrics">
          <span>体积<b>{validation.toolVolumeMm3.toFixed(2)} 立方毫米</b></span>
          <span>包围盒<b>{validation.toolBoundsMm.x.toFixed(2)} × {validation.toolBoundsMm.y.toFixed(2)} × {validation.toolBoundsMm.z.toFixed(2)} 毫米</b></span>
          <span>最近干涉距离<b>{validation.minimumInterferenceDistanceMm?.toFixed(3) ?? '未知'} 毫米</b></span>
          <span>接触检查<b>{validation.contactFaceCount} 个面 / {validation.contactSampleCount} 个采样</b></span>
        </div>
      </div>

      <div className="local-cad-risk-section">
        <strong>定位干涉稳定面</strong>
        <div className="local-cad-risk-faces">
          {validation.interferingStableFaceIds.length > 0
            ? validation.interferingStableFaceIds.map((stableFaceId) => (
                <button
                  type="button"
                  key={stableFaceId}
                  className={preview.focusedInterferenceFaceId === stableFaceId ? 'is-active' : ''}
                  onClick={() => focusInterferenceFace(stableFaceId)}
                >
                  {stableFaceId}
                </button>
              ))
            : <small>未返回可定位的稳定面 ID，请依据工具体和诊断信息调整参数。</small>}
        </div>
        <small>红色为全部干涉面，亮红色为当前定位面；定位不会改变原目标曲面或真实 UV。</small>
      </div>

      <div className="local-cad-risk-section">
        <strong>调整风险参数</strong>
        <div className="local-cad-risk-fields">
          {circular && <ParameterInput label="直径" field="diameterMm" value={values.diameterMm} unit="毫米" onChange={updateValue} />}
          {(rectangular || slot) && <ParameterInput label="宽度" field="widthMm" value={values.widthMm} unit="毫米" onChange={updateValue} />}
          {rectangular && <ParameterInput label="高度" field="heightMm" value={values.heightMm} unit="毫米" onChange={updateValue} />}
          {slot && <ParameterInput label="长度" field="lengthMm" value={values.lengthMm} unit="毫米" onChange={updateValue} />}
          <ParameterInput label={preview.kind === 'additive' ? '凸出高度' : '切入深度'} field="depthMm" value={values.depthMm} unit="毫米" onChange={updateValue} />
          {!circular && <ParameterInput label="旋转角" field="rotationDeg" value={values.rotationDeg} unit="度" onChange={updateValue} />}
        </div>
        {error && <small className="local-cad-risk-error">{error}</small>}
        <div className="local-cad-risk-actions">
          <button type="button" onClick={() => {
            setValues(adjustmentToEditable(originalAdjustment));
            setError(null);
          }} disabled={aiStatus === 'running'}>
            恢复原参数
          </button>
          <button type="button" className="is-primary" onClick={() => void retry()} disabled={aiStatus === 'running'}>
            重新预检并自动执行
          </button>
          <button type="button" className="is-danger" onClick={clearPreview} disabled={aiStatus === 'running'}>
            清除预览
          </button>
        </div>
        <small>调整后仍会重新经过受限中文解析、OpenCascade 单一实体校验与精确干涉预检；只有通过后才会写入模型。</small>
      </div>
    </div>
  );
}
