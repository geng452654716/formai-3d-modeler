import { useEffect, useState } from 'react';
import {
  Check,
  EyeOff,
  Pencil,
  RotateCcw,
  Scissors,
  Save,
  X
} from 'lucide-react';
import type { DetectedInterface, DetectedInterfaceType } from '../model/imageRecognition';
import {
  inferInterfaceOpeningShape,
  INTERFACE_OPENING_SHAPE_LABELS
} from '../model/interfaceOpenings';
import type { InterfaceOpeningShape } from '../model/types';
import {
  getMatchedInterfaceValue,
  ignoreMatchedInterface,
  REFERENCE_VIEW_LABELS,
  restoreIgnoredInterface,
  reviewMatchedInterface,
  splitMatchedInterface,
  type MatchedInterface,
  type MultiViewCalibrationResult
} from '../model/multiViewCalibration';

interface InterfaceReviewPanelProps {
  result: MultiViewCalibrationResult;
  onChange: (result: MultiViewCalibrationResult) => void;
}

const interfaceTypes: DetectedInterfaceType[] = ['USB-C', '按钮', 'LED', '排针', '电源接口', '未知'];
const openingShapes: InterfaceOpeningShape[] = ['circle', 'rectangle', 'rounded-rectangle', 'slot'];

type EditableInterface = Pick<DetectedInterface,
  | 'id'
  | 'type'
  | 'side'
  | 'positionXPercent'
  | 'positionYPercent'
  | 'widthMm'
  | 'heightMm'
  | 'horizontalOffsetMm'
  | 'bottomOffsetMm'
  | 'requiresOpening'
  | 'openingShape'
>;

function toEditableInterface(item: MatchedInterface): EditableInterface {
  const value = getMatchedInterfaceValue(item);
  return {
    id: value.id,
    type: value.type,
    side: value.side,
    positionXPercent: value.positionXPercent,
    positionYPercent: value.positionYPercent,
    widthMm: value.widthMm,
    heightMm: value.heightMm,
    horizontalOffsetMm: value.horizontalOffsetMm,
    bottomOffsetMm: value.bottomOffsetMm,
    requiresOpening: value.requiresOpening,
    openingShape: value.openingShape
  };
}

function InterfaceReviewCard({
  item,
  allIds,
  result,
  onChange
}: {
  item: MatchedInterface;
  allIds: string[];
  result: MultiViewCalibrationResult;
  onChange: (result: MultiViewCalibrationResult) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditableInterface>(() => toEditableInterface(item));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(toEditableInterface(item));
    setError(null);
  }, [item]);

  const setNumber = (key: keyof EditableInterface, value: string) => {
    setDraft((current) => ({ ...current, [key]: Number(value) }));
  };

  const handleSave = () => {
    const id = draft.id.trim();
    if (!id) {
      setError('接口标识不能为空。');
      return;
    }
    if (allIds.some((candidate) => candidate !== item.id && candidate === id)) {
      setError('接口标识已存在，请使用唯一名称。');
      return;
    }
    const numericValues = [
      draft.positionXPercent,
      draft.positionYPercent,
      draft.widthMm,
      draft.heightMm,
      draft.horizontalOffsetMm,
      draft.bottomOffsetMm
    ];
    if (numericValues.some((value) => !Number.isFinite(value))) {
      setError('接口尺寸和位置必须是有效数字。');
      return;
    }
    if (draft.widthMm <= 0 || draft.heightMm <= 0) {
      setError('接口宽度和高度必须大于 0 毫米。');
      return;
    }
    if (
      draft.positionXPercent < 0
      || draft.positionXPercent > 100
      || draft.positionYPercent < 0
      || draft.positionYPercent > 100
    ) {
      setError('照片位置百分比必须在 0 到 100 之间。');
      return;
    }
    onChange(reviewMatchedInterface(result, item.id, { ...draft, id }));
    setEditing(false);
    setError(null);
  };

  const statusLabel = item.matchStatus === 'ignored'
    ? '已忽略'
    : item.matchStatus === 'needs-confirmation'
      ? '待确认'
      : item.matchMethod === 'same-id' ? '自动匹配' : '人工确认';
  const statusClass = item.matchStatus === 'ignored'
    ? 'is-ignored'
    : item.matchStatus === 'matched' ? 'is-confirmed' : 'needs-confirmation';
  const value = getMatchedInterfaceValue(item);
  const resolvedOpeningShape = inferInterfaceOpeningShape(value);

  return (
    <div className={`interface-review-card ${item.matchStatus === 'ignored' ? 'is-ignored' : ''}`}>
      <div className="interface-review-summary">
        <span className={statusClass}>{statusLabel}</span>
        <strong>{value.type}</strong>
        <small>{item.observations.map((observation) => `${REFERENCE_VIEW_LABELS[observation.viewType]}：${observation.fileName}`).join('；')}</small>
        <b>{Math.round(item.confidence * 100)}%</b>
      </div>
      <div className="interface-review-metrics">
        <span>标识：{value.id}</span>
        <span>{value.widthMm.toFixed(2)} × {value.heightMm.toFixed(2)} 毫米</span>
        <span>横向 {value.horizontalOffsetMm.toFixed(2)} 毫米</span>
        <span>底部 {value.bottomOffsetMm.toFixed(2)} 毫米</span>
        <span>{value.requiresOpening ? '需要开孔' : '仅避让'}</span>
        {value.requiresOpening && <span>轮廓：{INTERFACE_OPENING_SHAPE_LABELS[resolvedOpeningShape]}</span>}
      </div>

      {item.matchStatus === 'ignored' ? (
        <div className="interface-review-actions">
          <button className="secondary-modal-button compact" onClick={() => onChange(restoreIgnoredInterface(result, item.id))}>
            <RotateCcw size={13} />恢复接口
          </button>
        </div>
      ) : (
        <div className="interface-review-actions">
          {item.matchStatus === 'needs-confirmation' && (
            <button className="secondary-modal-button compact confirm" onClick={() => onChange(reviewMatchedInterface(result, item.id))}>
              <Check size={13} />{item.observations.length > 1 ? '确认为同一接口' : '确认保留接口'}
            </button>
          )}
          {item.matchStatus === 'needs-confirmation' && item.observations.length > 1 && (
            <button className="secondary-modal-button compact" onClick={() => onChange(splitMatchedInterface(result, item.id))}>
              <Scissors size={13} />拆为独立接口
            </button>
          )}
          <button className="secondary-modal-button compact" onClick={() => setEditing((current) => !current)}>
            {editing ? <X size={13} /> : <Pencil size={13} />}{editing ? '取消编辑' : '编辑参数'}
          </button>
          <button className="danger-modal-button compact" onClick={() => onChange(ignoreMatchedInterface(result, item.id))}>
            <EyeOff size={13} />忽略误识别
          </button>
        </div>
      )}

      {editing && item.matchStatus !== 'ignored' && (
        <div className="interface-review-editor">
          <label><span>接口标识</span><input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} /></label>
          <label><span>接口类型</span><select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as DetectedInterfaceType }))}>{interfaceTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label><span>所在面</span><input value={draft.side} onChange={(event) => setDraft((current) => ({ ...current, side: event.target.value }))} /></label>
          <label><span>宽度（毫米）</span><input type="number" min="0.01" step="0.1" value={draft.widthMm} onChange={(event) => setNumber('widthMm', event.target.value)} /></label>
          <label><span>高度（毫米）</span><input type="number" min="0.01" step="0.1" value={draft.heightMm} onChange={(event) => setNumber('heightMm', event.target.value)} /></label>
          <label><span>横向偏移（毫米）</span><input type="number" step="0.1" value={draft.horizontalOffsetMm} onChange={(event) => setNumber('horizontalOffsetMm', event.target.value)} /></label>
          <label><span>底部偏移（毫米）</span><input type="number" step="0.1" value={draft.bottomOffsetMm} onChange={(event) => setNumber('bottomOffsetMm', event.target.value)} /></label>
          <label>
            <span>开孔轮廓</span>
            <select
              value={draft.openingShape ?? ''}
              disabled={!draft.requiresOpening}
              onChange={(event) => setDraft((current) => ({
                ...current,
                openingShape: event.target.value
                  ? event.target.value as InterfaceOpeningShape
                  : undefined
              }))}
            >
              <option value="">自动判断</option>
              {openingShapes.map((shape) => (
                <option key={shape} value={shape}>{INTERFACE_OPENING_SHAPE_LABELS[shape]}</option>
              ))}
            </select>
          </label>
          <label><span>照片横向位置（%）</span><input type="number" min="0" max="100" step="0.1" value={draft.positionXPercent} onChange={(event) => setNumber('positionXPercent', event.target.value)} /></label>
          <label><span>照片纵向位置（%）</span><input type="number" min="0" max="100" step="0.1" value={draft.positionYPercent} onChange={(event) => setNumber('positionYPercent', event.target.value)} /></label>
          <label className="interface-opening-toggle"><input type="checkbox" checked={draft.requiresOpening} onChange={(event) => setDraft((current) => ({ ...current, requiresOpening: event.target.checked }))} /><span>外壳需要为此接口开孔</span></label>
          {error && <div className="interface-review-error">{error}</div>}
          <button className="primary-modal-button compact-save" onClick={handleSave}><Save size={13} />保存修改并确认</button>
        </div>
      )}
    </div>
  );
}

export function InterfaceReviewPanel({ result, onChange }: InterfaceReviewPanelProps) {
  const allIds = result.matchedInterfaces.map((item) => item.id);
  return (
    <div className="interface-review-panel">
      <div className="interface-review-title">
        <div>
          <strong>接口人工复核</strong>
          <span>待确认项必须逐一确认、拆分或忽略；编辑后的尺寸和偏移将用于后续精确开孔。</span>
        </div>
      </div>
      <div className="interface-review-list">
        {result.matchedInterfaces.length > 0
          ? result.matchedInterfaces.map((item) => (
              <InterfaceReviewCard
                key={item.id}
                item={item}
                allIds={allIds}
                result={result}
                onChange={onChange}
              />
            ))
          : <p className="interface-review-empty">没有识别到接口，可直接应用联合尺寸结果。</p>}
      </div>
    </div>
  );
}
