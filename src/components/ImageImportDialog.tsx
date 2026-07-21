import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent, type PointerEvent } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ImagePlus,
  Layers3,
  LoaderCircle,
  MousePointer2,
  RotateCcw,
  Ruler,
  Trash2,
  X
} from 'lucide-react';
import {
  createImageCalibration,
  interfacePhysicalSizeToImageBounds,
  mapDetectedUsbToParameters,
  moveDetectedInterfaceOnImage,
  resizeDetectedInterfaceOnImage,
  type CalibrationPoint,
  type DetectedInterface,
  type ImageCalibration,
  type InterfaceImageBounds,
  type ReferenceImageAnalysis
} from '../model/imageRecognition';
import { buildInterfaceOpenings } from '../model/interfaceOpenings';
import {
  buildMultiViewCalibrationResult,
  canApplyMultiViewCalibration,
  countPendingInterfaces,
  flattenMatchedInterfaces,
  mergeEstimatedParameterChanges,
  REFERENCE_VIEW_LABELS,
  type MultiViewCalibrationResult,
  type ReferenceViewRecord,
  type ReferenceViewType
} from '../model/multiViewCalibration';
import type { EnclosureParameters } from '../model/types';
import { InterfaceReviewPanel } from './InterfaceReviewPanel';
import { analyzeReferenceImage } from '../platform/backend';
import { useModelStore } from '../store/useModelStore';

interface ImageImportDialogProps {
  files: File[];
  onClose: () => void;
}

interface ReferenceViewDraft {
  id: string;
  file: File;
  viewType: ReferenceViewType;
  referenceDimension: number;
  imageDimensions: { width: number; height: number };
  calibrationPoints: CalibrationPoint[];
  analysis: ReferenceImageAnalysis | null;
  originalInterfaces: DetectedInterface[] | null;
  status: 'idle' | 'analyzing' | 'done' | 'error';
  error: string | null;
  importedAt: string;
}

const viewOptions = Object.entries(REFERENCE_VIEW_LABELS) as Array<[ReferenceViewType, string]>;
const defaultViewOrder: ReferenceViewType[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'perspective'];


type ImageInteractionMode = 'calibration' | 'interfaces';

interface InterfacePointerInteraction {
  pointerId: number;
  interfaceId: string;
  kind: 'move' | 'resize';
  startClientX: number;
  startClientY: number;
  startInterface: DetectedInterface;
  startBounds: InterfaceImageBounds;
  latestInterface: DetectedInterface;
}

function interfaceWasEdited(current: DetectedInterface, original: DetectedInterface | undefined) {
  if (!original) return true;
  return current.positionXPercent !== original.positionXPercent
    || current.positionYPercent !== original.positionYPercent
    || current.widthMm !== original.widthMm
    || current.heightMm !== original.heightMm
    || current.horizontalOffsetMm !== original.horizontalOffsetMm
    || current.bottomOffsetMm !== original.bottomOffsetMm;
}

function createDraft(file: File, index: number): ReferenceViewDraft {
  return {
    id: crypto.randomUUID(),
    file,
    viewType: defaultViewOrder[index % defaultViewOrder.length],
    referenceDimension: 58,
    imageDimensions: { width: 0, height: 0 },
    calibrationPoints: [],
    analysis: null,
    originalInterfaces: null,
    status: 'idle',
    error: null,
    importedAt: new Date().toISOString()
  };
}

function toRecord(draft: ReferenceViewDraft, calibration: ImageCalibration): ReferenceViewRecord | null {
  if (!draft.analysis) return null;
  return {
    id: draft.id,
    fileName: draft.file.name,
    viewType: draft.viewType,
    calibration,
    importedAt: draft.importedAt,
    analysis: draft.analysis
  };
}

export function ImageImportDialog({ files, onClose }: ImageImportDialogProps) {
  const [drafts, setDrafts] = useState<ReferenceViewDraft[]>(() => files.map(createDraft));
  const [activeId, setActiveId] = useState(() => drafts[0]?.id ?? '');
  const [createNewCanvas, setCreateNewCanvas] = useState(true);
  const [jointResult, setJointResult] = useState<MultiViewCalibrationResult | null>(null);
  const [jointError, setJointError] = useState<string | null>(null);
  const addImageInput = useRef<HTMLInputElement>(null);
  const imageSurfaceRef = useRef<HTMLDivElement>(null);
  const interfaceInteraction = useRef<InterfacePointerInteraction | null>(null);
  const activeDraft = drafts.find((draft) => draft.id === activeId) ?? drafts[0] ?? null;
  const [previewUrl, setPreviewUrl] = useState('');
  const [interactionMode, setInteractionMode] = useState<ImageInteractionMode>('calibration');
  const [selectedInterfaceId, setSelectedInterfaceId] = useState<string | null>(null);

  const parameters = useModelStore((state) => state.parameters);
  const resetProject = useModelStore((state) => state.resetProject);
  const setParameter = useModelStore((state) => state.setParameter);
  const commitVersion = useModelStore((state) => state.commitVersion);
  const generateCad = useModelStore((state) => state.generateCad);
  const addAssistantMessage = useModelStore((state) => state.addAssistantMessage);
  const setReferenceImage = useModelStore((state) => state.setReferenceImage);
  const setReferenceImages = useModelStore((state) => state.setReferenceImages);
  const upsertReferenceImage = useModelStore((state) => state.upsertReferenceImage);
  const removeReferenceImage = useModelStore((state) => state.removeReferenceImage);
  const setMultiViewCalibration = useModelStore((state) => state.setMultiViewCalibration);
  const setDetectedInterfaces = useModelStore((state) => state.setDetectedInterfaces);
  const setInterfaceOpenings = useModelStore((state) => state.setInterfaceOpenings);

  const calibration = useMemo(() => activeDraft ? createImageCalibration(
    activeDraft.imageDimensions.width,
    activeDraft.imageDimensions.height,
    activeDraft.calibrationPoints,
    activeDraft.referenceDimension
  ) : null, [activeDraft]);

  const records = useMemo(() => drafts.flatMap((draft) => {
    const draftCalibration = createImageCalibration(
      draft.imageDimensions.width,
      draft.imageDimensions.height,
      draft.calibrationPoints,
      draft.referenceDimension
    );
    const record = draftCalibration ? toRecord(draft, draftCalibration) : null;
    return record ? [record] : [];
  }), [drafts]);

  useEffect(() => {
    if (!activeDraft) {
      setPreviewUrl('');
      return;
    }
    const nextPreviewUrl = URL.createObjectURL(activeDraft.file);
    setPreviewUrl(nextPreviewUrl);
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [activeDraft?.file]);

  const updateActive = (changes: Partial<ReferenceViewDraft>, invalidateJoint = true) => {
    if (!activeDraft) return;
    setDrafts((current) => current.map((draft) => draft.id === activeDraft.id
      ? { ...draft, ...changes }
      : draft));
    if (invalidateJoint) {
      setJointResult(null);
      setJointError(null);
    }
  };

  const invalidateAnalysis = (changes: Partial<ReferenceViewDraft>) => updateActive({
    ...changes,
    analysis: null,
    originalInterfaces: null,
    status: 'idle',
    error: null
  });

  const handleCalibrationPoint = (event: MouseEvent<HTMLDivElement>) => {
    if (interactionMode !== 'calibration') return;
    if (!activeDraft || activeDraft.status === 'analyzing' || activeDraft.imageDimensions.width <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const xPercent = Math.min(100, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * 100));
    const yPercent = Math.min(100, Math.max(0, ((event.clientY - bounds.top) / bounds.height) * 100));
    const nextPoint: CalibrationPoint = {
      xPercent,
      yPercent,
      xPixel: activeDraft.imageDimensions.width * xPercent / 100,
      yPixel: activeDraft.imageDimensions.height * yPercent / 100
    };
    invalidateAnalysis({
      calibrationPoints: activeDraft.calibrationPoints.length >= 2
        ? [nextPoint]
        : activeDraft.calibrationPoints.concat(nextPoint)
    });
  };

  const handleAddImages = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    if (selected.length === 0) return;
    const nextDrafts = selected.map((file, index) => createDraft(file, drafts.length + index));
    setDrafts((current) => current.concat(nextDrafts));
    setActiveId(nextDrafts[0].id);
    setInteractionMode('calibration');
    setSelectedInterfaceId(null);
    setJointResult(null);
    setJointError(null);
    event.currentTarget.value = '';
  };

  const handleRemoveActive = () => {
    if (!activeDraft) return;
    const remaining = drafts.filter((draft) => draft.id !== activeDraft.id);
    setDrafts(remaining);
    setActiveId(remaining[0]?.id ?? '');
    setInteractionMode(remaining[0]?.analysis ? 'interfaces' : 'calibration');
    setSelectedInterfaceId(null);
    removeReferenceImage(activeDraft.id);
    setJointResult(null);
    setJointError(null);
    if (remaining.length === 0) onClose();
  };

  const handleAnalyze = async () => {
    if (!activeDraft || !calibration) {
      if (activeDraft) updateActive({ error: '请先在图片上依次点击真实尺寸的两个端点' }, false);
      return;
    }
    updateActive({ status: 'analyzing', error: null }, false);
    try {
      const analysis = await analyzeReferenceImage(
        activeDraft.file,
        activeDraft.viewType,
        calibration,
        parameters
      );
      const completedDraft = {
        ...activeDraft,
        analysis,
        originalInterfaces: analysis.interfaces.map((item) => ({ ...item })),
        status: 'done' as const,
        error: null
      };
      setDrafts((current) => current.map((draft) => draft.id === activeDraft.id ? completedDraft : draft));
      const record = toRecord(completedDraft, calibration);
      if (record) upsertReferenceImage(record);
      setJointResult(null);
      setJointError(null);
      setInteractionMode('interfaces');
      setSelectedInterfaceId(analysis.interfaces[0]?.id ?? null);
    } catch (nextError) {
      updateActive({
        error: nextError instanceof Error ? nextError.message : '图片识别失败',
        status: 'error'
      }, false);
    }
  };


  const previewInterfaceUpdate = (updatedInterface: DetectedInterface) => {
    if (!activeDraft?.analysis) return;
    setDrafts((current) => current.map((draft) => draft.id === activeDraft.id && draft.analysis
      ? {
          ...draft,
          analysis: {
            ...draft.analysis,
            interfaces: draft.analysis.interfaces.map((item) => item.id === updatedInterface.id
              ? updatedInterface
              : item)
          }
        }
      : draft));
  };

  const commitInterfaceUpdate = (updatedInterface: DetectedInterface, message = '接口区域已修改，请重新执行联合标定。') => {
    if (!activeDraft?.analysis || !calibration) return;
    const nextDraft: ReferenceViewDraft = {
      ...activeDraft,
      analysis: {
        ...activeDraft.analysis,
        interfaces: activeDraft.analysis.interfaces.map((item) => item.id === updatedInterface.id
          ? updatedInterface
          : item)
      }
    };
    setDrafts((current) => current.map((draft) => draft.id === activeDraft.id ? nextDraft : draft));
    const record = toRecord(nextDraft, calibration);
    if (record) upsertReferenceImage(record);
    setJointResult(null);
    setMultiViewCalibration(null);
    setJointError(message);
  };

  const handleInterfacePointerDown = (
    event: PointerEvent<HTMLElement>,
    detectedInterface: DetectedInterface,
    kind: InterfacePointerInteraction['kind']
  ) => {
    if (interactionMode !== 'interfaces' || !calibration) return;
    const startBounds = interfacePhysicalSizeToImageBounds(detectedInterface, calibration);
    if (!startBounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedInterfaceId(detectedInterface.id);
    interfaceInteraction.current = {
      pointerId: event.pointerId,
      interfaceId: detectedInterface.id,
      kind,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startInterface: detectedInterface,
      startBounds,
      latestInterface: detectedInterface
    };
  };

  const handleInterfacePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const interaction = interfaceInteraction.current;
    const surface = imageSurfaceRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || !surface || !calibration) return;
    event.preventDefault();
    const surfaceBounds = surface.getBoundingClientRect();
    if (surfaceBounds.width <= 0 || surfaceBounds.height <= 0) return;
    const deltaXPercent = (event.clientX - interaction.startClientX) / surfaceBounds.width * 100;
    const deltaYPercent = (event.clientY - interaction.startClientY) / surfaceBounds.height * 100;
    const updatedInterface = interaction.kind === 'move'
      ? moveDetectedInterfaceOnImage(
          interaction.startInterface,
          calibration,
          deltaXPercent,
          deltaYPercent
        )
      : resizeDetectedInterfaceOnImage(
          interaction.startInterface,
          calibration,
          interaction.startBounds.widthPercent + deltaXPercent * 2,
          interaction.startBounds.heightPercent + deltaYPercent * 2
        );
    interaction.latestInterface = updatedInterface;
    previewInterfaceUpdate(updatedInterface);
  };

  const finishInterfacePointerInteraction = (event: PointerEvent<HTMLDivElement>) => {
    const interaction = interfaceInteraction.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    interfaceInteraction.current = null;
    commitInterfaceUpdate(interaction.latestInterface);
  };

  const restoreSelectedInterface = () => {
    if (!activeDraft?.analysis || !selectedInterfaceId) return;
    const original = activeDraft.originalInterfaces?.find((item) => item.id === selectedInterfaceId);
    if (!original) return;
    commitInterfaceUpdate({ ...original }, '已恢复本次 Codex 识别值，请重新执行联合标定。');
  };

  const handleJointCalibration = () => {
    const result = buildMultiViewCalibrationResult(records);
    setJointResult(result);
    setJointError(result.status === 'insufficient' ? result.warnings[0] : null);
    if (result.status !== 'insufficient') {
      setReferenceImages(records);
      setMultiViewCalibration(result);
    }
  };

  const handleJointResultChange = (result: MultiViewCalibrationResult) => {
    setJointResult(result);
    setMultiViewCalibration(result);
    setJointError(countPendingInterfaces(result) > 0
      ? '请先处理全部待确认接口，再应用联合结果。'
      : null);
  };

  const applyRecords = async (targetRecords: ReferenceViewRecord[], result: MultiViewCalibrationResult) => {
    if (targetRecords.length === 0) return;
    if (targetRecords.length > 1 && !canApplyMultiViewCalibration(result)) {
      setJointError('仍有接口对应关系待确认，请选择确认、拆分或忽略后再生成模型。');
      return;
    }
    if (createNewCanvas) resetProject();

    const parameterChanges = mergeEstimatedParameterChanges(targetRecords);
    (Object.entries(parameterChanges) as Array<[keyof EnclosureParameters, number]>).forEach(
      ([parameter, value]) => setParameter(parameter, value)
    );

    const recognizedParameters = useModelStore.getState().parameters;
    const frontInterfaces = flattenMatchedInterfaces(result, 'front');
    const interfaceChanges = mapDetectedUsbToParameters(
      frontInterfaces,
      'front',
      recognizedParameters
    );
    (Object.entries(interfaceChanges) as Array<[keyof EnclosureParameters, number]>).forEach(
      ([parameter, value]) => setParameter(parameter, value)
    );

    setReferenceImages(targetRecords);
    setMultiViewCalibration(result);
    const primaryRecord = targetRecords.find((record) => record.viewType === 'front') ?? targetRecords[0];
    setReferenceImage({
      fileName: primaryRecord.fileName,
      viewType: primaryRecord.viewType,
      calibration: primaryRecord.calibration,
      importedAt: primaryRecord.importedAt
    });
    setDetectedInterfaces(flattenMatchedInterfaces(result));
    const openingBuild = buildInterfaceOpenings(result, useModelStore.getState().parameters);
    setInterfaceOpenings(openingBuild.openings);
    commitVersion(targetRecords.length > 1
      ? `根据 ${targetRecords.length} 个照片视角联合创建模型`
      : `根据图片 ${primaryRecord.fileName} 创建模型`);

    const openingMessage = openingBuild.openings.length > 0
      ? `已生成 ${openingBuild.openings.length} 个通用精确开孔，包含圆孔、矩形孔、圆角矩形孔或槽孔轮廓。`
      : '没有已确认且需要穿过外壳的接口，当前照片结果只作为识别与避让信息保存。';
    const uncertainCount = countPendingInterfaces(result);
    const ignoredCount = result.matchedInterfaces.filter((item) => item.matchStatus === 'ignored').length;
    addAssistantMessage(
      `已应用 ${targetRecords.length} 个照片视角和 ${Object.keys(parameterChanges).length} 个融合尺寸参数。${openingMessage}${openingBuild.warnings.length > 0 ? ` ${openingBuild.warnings.join(' ')}` : ''}${uncertainCount > 0 ? ` 另有 ${uncertainCount} 组接口对应关系尚未确认。` : ''}${ignoredCount > 0 ? ` 已按人工复核忽略 ${ignoredCount} 组误识别接口。` : ''}`
    );
    await generateCad(useModelStore.getState().parameters);
    onClose();
  };

  if (!activeDraft) return null;

  const readyCount = records.length;
  const confirmedInterfaces = jointResult?.matchedInterfaces.filter((item) => item.matchStatus === 'matched').length ?? 0;
  const pendingInterfaces = countPendingInterfaces(jointResult);
  const ignoredInterfaces = jointResult?.matchedInterfaces.filter((item) => item.matchStatus === 'ignored').length ?? 0;
  const selectedInterface = activeDraft.analysis?.interfaces.find((item) => item.id === selectedInterfaceId);
  const selectedOriginalInterface = activeDraft.originalInterfaces?.find((item) => item.id === selectedInterfaceId);
  const selectedInterfaceWasEdited = selectedInterface
    ? interfaceWasEdited(selectedInterface, selectedOriginalInterface)
    : false;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-card image-import-dialog multi-view-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div><Camera size={18} /><div><strong>多视角照片联合标定</strong><span>逐张双点标定 · Codex 接口识别 · 尺度融合与跨视角对应</span></div></div>
          <button onClick={onClose} title="关闭"><X size={17} /></button>
        </header>

        <div className="multi-view-toolbar">
          <div className="multi-view-tabs">
            {drafts.map((draft, index) => (
              <button
                className={draft.id === activeDraft.id ? 'active' : ''}
                key={draft.id}
                onClick={() => {
                  setActiveId(draft.id);
                  setInteractionMode(draft.analysis ? 'interfaces' : 'calibration');
                  setSelectedInterfaceId(draft.analysis?.interfaces[0]?.id ?? null);
                }}
                title={draft.file.name}
              >
                <span>{REFERENCE_VIEW_LABELS[draft.viewType]}</span>
                <small>{draft.analysis ? `已识别 ${draft.analysis.interfaces.length} 个接口` : draft.calibrationPoints.length === 2 ? '待识别' : `待标定 ${draft.calibrationPoints.length}/2`}</small>
                <b>{index + 1}</b>
              </button>
            ))}
          </div>
          <input ref={addImageInput} className="hidden-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp" capture="environment" onChange={handleAddImages} />
          <button className="secondary-modal-button compact" onClick={() => addImageInput.current?.click()}><ImagePlus size={14} />添加照片</button>
          <button className="danger-modal-button compact" onClick={handleRemoveActive}><Trash2 size={14} />移除当前</button>
        </div>

        <div className="image-import-grid">
          <div className="image-preview">
            <div className="image-edit-toolbar">
              <div role="group" aria-label="照片操作模式">
                <button className={interactionMode === 'calibration' ? 'active' : ''} onClick={() => setInteractionMode('calibration')}><Ruler size={13} />尺寸标定</button>
                <button className={interactionMode === 'interfaces' ? 'active' : ''} disabled={!activeDraft.analysis} onClick={() => setInteractionMode('interfaces')}><MousePointer2 size={13} />编辑接口</button>
              </div>
              <span>{interactionMode === 'calibration' ? '点击照片选择两个标定端点' : '拖动接口框修改位置，拖动右下角调整尺寸'}</span>
            </div>
            <div className="image-stage">
              <div
                ref={imageSurfaceRef}
                className={`image-surface is-${interactionMode}`}
                onClick={handleCalibrationPoint}
                onPointerMove={handleInterfacePointerMove}
                onPointerUp={finishInterfacePointerInteraction}
                onPointerCancel={finishInterfacePointerInteraction}
                title={interactionMode === 'calibration' ? '依次点击已知真实尺寸的两个端点' : '选择并拖动接口区域'}
              >
                {previewUrl && <img
                  src={previewUrl}
                  alt="待识别参考图"
                  draggable={false}
                  onLoad={(event) => updateActive({ imageDimensions: {
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight
                  } }, false)}
                />}
                {activeDraft.imageDimensions.width > 0 && (
                  <svg className="calibration-overlay" viewBox={`0 0 ${activeDraft.imageDimensions.width} ${activeDraft.imageDimensions.height}`} aria-label="尺寸标定线">
                    {activeDraft.calibrationPoints.length === 2 && <line x1={activeDraft.calibrationPoints[0].xPixel} y1={activeDraft.calibrationPoints[0].yPixel} x2={activeDraft.calibrationPoints[1].xPixel} y2={activeDraft.calibrationPoints[1].yPixel} />}
                    {activeDraft.calibrationPoints.map((point, index) => (
                      <g key={`${point.xPixel}-${point.yPixel}`}><circle cx={point.xPixel} cy={point.yPixel} r={Math.max(5, activeDraft.imageDimensions.width / 180)} /><text x={point.xPixel + 9} y={point.yPixel - 9}>{index === 0 ? 'A' : 'B'}</text></g>
                    ))}
                  </svg>
                )}
                {activeDraft.analysis?.interfaces.map((item, index) => {
                  const bounds = calibration ? interfacePhysicalSizeToImageBounds(item, calibration) : null;
                  if (!bounds) return null;
                  const original = activeDraft.originalInterfaces?.find((candidate) => candidate.id === item.id);
                  const wasEdited = interfaceWasEdited(item, original);
                  return (
                    <div
                      className={`interface-marker ${item.requiresOpening ? 'requires-opening' : ''} ${item.id === selectedInterfaceId ? 'is-selected' : ''} ${wasEdited ? 'is-edited' : ''}`}
                      key={item.id || `${item.type}-${index}`}
                      style={{
                        left: `${bounds.centerXPercent}%`,
                        top: `${bounds.centerYPercent}%`,
                        width: `${bounds.widthPercent}%`,
                        height: `${bounds.heightPercent}%`
                      }}
                      role="button"
                      tabIndex={interactionMode === 'interfaces' ? 0 : -1}
                      aria-label={`接口 ${item.type}，${item.widthMm.toFixed(1)} 乘 ${item.heightMm.toFixed(1)} 毫米`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedInterfaceId(item.id);
                      }}
                      onPointerDown={(event) => handleInterfacePointerDown(event, item, 'move')}
                    >
                      <div className="interface-marker-label">
                        <span>{item.type}{wasEdited ? ' · 已修改' : ''}</span>
                        <small>{item.widthMm.toFixed(1)} × {item.heightMm.toFixed(1)} 毫米 · {item.requiresOpening ? '需要开孔' : '仅避让'}</small>
                      </div>
                      {interactionMode === 'interfaces' && item.id === selectedInterfaceId && (
                        <button
                          className="interface-resize-handle"
                          title="拖动调整接口宽度和高度"
                          aria-label="调整接口区域尺寸"
                          onPointerDown={(event) => handleInterfacePointerDown(event, item, 'resize')}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {selectedInterface && interactionMode === 'interfaces' && (
              <div className="selected-interface-summary">
                <div><strong>{selectedInterface.type} · {selectedInterface.side}</strong><span>中心 {selectedInterface.positionXPercent.toFixed(1)}%, {selectedInterface.positionYPercent.toFixed(1)}% · 横向偏移 {selectedInterface.horizontalOffsetMm.toFixed(1)} 毫米 · 底部偏移 {selectedInterface.bottomOffsetMm.toFixed(1)} 毫米</span></div>
                <button className="secondary-modal-button compact" disabled={!selectedInterfaceWasEdited || !selectedOriginalInterface} onClick={restoreSelectedInterface}><RotateCcw size={13} />恢复本次识别值</button>
              </div>
            )}
            <span>{activeDraft.file.name} · {activeDraft.imageDimensions.width || '—'} × {activeDraft.imageDimensions.height || '—'} 像素 · 当前编辑基于已标定二维照片平面，不是相机位姿求解</span>
          </div>

          <div className="image-import-form">
            <label>当前图片视角<select value={activeDraft.viewType} onChange={(event) => { setInteractionMode('calibration'); setSelectedInterfaceId(null); invalidateAnalysis({ viewType: event.target.value as ReferenceViewType }); }}>{viewOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>标定线真实长度<div className="modal-number"><input type="number" min="0.1" step="0.1" value={activeDraft.referenceDimension} onChange={(event) => { setInteractionMode('calibration'); setSelectedInterfaceId(null); invalidateAnalysis({ referenceDimension: Number(event.target.value) }); }} /><span>毫米</span></div></label>
            <div className={`calibration-status ${calibration ? 'is-ready' : ''}`}>
              <Ruler size={15} />
              <div><strong>{calibration ? '当前视角双点标定已就绪' : `请在图片上选择标定点 ${activeDraft.calibrationPoints.length + 1}/2`}</strong><span>{calibration ? `${calibration.pixelDistance.toFixed(1)} 像素 = ${calibration.realDistanceMm.toFixed(2)} 毫米 · ${calibration.mmPerPixel.toFixed(5)} 毫米/像素` : '选择同一平面上一段已知真实长度的两个端点'}</span></div>
            </div>
            <button className="secondary-modal-button" onClick={() => { setInteractionMode('calibration'); setSelectedInterfaceId(null); invalidateAnalysis({ calibrationPoints: [] }); }} disabled={activeDraft.calibrationPoints.length === 0}><RotateCcw size={14} />重新选择标定点</button>
            <small>每个视角独立标定。标定线应与接口所在平面共面，并尽量避免透视倾斜；制造前仍需用卡尺复核。</small>
            <button className="primary-modal-button" onClick={() => void handleAnalyze()} disabled={activeDraft.status === 'analyzing' || !calibration}>
              {activeDraft.status === 'analyzing' ? <LoaderCircle className="is-spinning" size={16} /> : <Camera size={16} />}
              {activeDraft.status === 'analyzing' ? '正在识别当前视角' : activeDraft.analysis ? '重新识别当前视角' : '识别当前视角'}
            </button>
          </div>
        </div>

        {activeDraft.error && <div className="modal-error"><AlertTriangle size={15} />{activeDraft.error}</div>}
        {activeDraft.analysis && (
          <div className="analysis-result compact-analysis">
            <div className="analysis-title"><CheckCircle2 size={16} /><strong>当前视角：{activeDraft.analysis.objectType}</strong><span>置信度 {Math.round(activeDraft.analysis.confidence * 100)}%</span></div>
            <p>{activeDraft.analysis.summary}</p>
            <div className="analysis-columns">
              <div><strong>尺寸参数</strong>{activeDraft.analysis.estimatedParameters.length ? activeDraft.analysis.estimatedParameters.map((change) => <span key={change.parameter}>{change.reason}：{change.value.toFixed(1)} 毫米</span>) : <span>没有足够证据自动修改尺寸</span>}</div>
              <div><strong>接口位置</strong>{activeDraft.analysis.interfaces.length ? activeDraft.analysis.interfaces.map((item, index) => <span key={item.id || `${item.type}-${index}`}>{item.type} · {item.side} · {item.widthMm.toFixed(1)} × {item.heightMm.toFixed(1)} 毫米 · {item.requiresOpening ? '需要开孔' : '仅避让'}</span>) : <span>未识别到明确接口</span>}</div>
            </div>
            {activeDraft.analysis.warnings.map((warning) => <div className="analysis-warning" key={warning}><AlertTriangle size={13} />{warning}</div>)}
          </div>
        )}

        <div className="joint-calibration-panel">
          <div className="joint-calibration-heading">
            <div><Layers3 size={17} /><div><strong>联合标定与接口对应</strong><span>已完成 {readyCount}/{drafts.length} 个视角；至少需要 2 个已标定并识别的视角</span></div></div>
            <button className="secondary-modal-button" disabled={readyCount < 2} onClick={handleJointCalibration}><Layers3 size={14} />执行联合标定</button>
          </div>
          {jointError && <div className="modal-error"><AlertTriangle size={15} />{jointError}</div>}
          {jointResult && jointResult.status !== 'insufficient' && (
            <div className="joint-result-grid">
              <div><span>联合尺度</span><strong>{jointResult.fusedMmPerPixel?.toFixed(5)} 毫米/像素</strong></div>
              <div><span>最大尺度偏差</span><strong>{((jointResult.maximumScaleDeviationRatio ?? 0) * 100).toFixed(1)}%</strong></div>
              <div><span>已确认接口</span><strong>{confirmedInterfaces} 组</strong></div>
              <div><span>待人工确认</span><strong>{pendingInterfaces} 组</strong></div>
              <div><span>已忽略误识别</span><strong>{ignoredInterfaces} 组</strong></div>
            </div>
          )}
          {jointResult && jointResult.status !== 'insufficient' && (
            <InterfaceReviewPanel result={jointResult} onChange={handleJointResultChange} />
          )}
          {jointResult?.warnings.map((warning) => <div className="analysis-warning" key={warning}><AlertTriangle size={13} />{warning}</div>)}
          <p className="capability-boundary">当前版本复用 Codex 逐张识别，并在本机执行尺度中位数融合和接口候选匹配；不声称已经完成摄影测量、相机内外参优化或任意物体三维网格重建。</p>
          <label className="modal-checkbox"><input type="checkbox" checked={createNewCanvas} onChange={(event) => setCreateNewCanvas(event.target.checked)} />应用结果时创建新模型画布</label>
          <div className="joint-actions">
            {activeDraft.analysis && calibration && <button className="secondary-modal-button" onClick={() => {
              const record = toRecord(activeDraft, calibration);
              if (record) void applyRecords([record], buildMultiViewCalibrationResult([record]));
            }}>仅应用当前视角</button>}
            <button className="primary-modal-button" disabled={!canApplyMultiViewCalibration(jointResult)} title={pendingInterfaces > 0 ? '请先确认、拆分或忽略全部待确认接口' : undefined} onClick={() => jointResult && void applyRecords(records, jointResult)}>应用联合结果并生成精确模型</button>
          </div>
        </div>
      </section>
    </div>
  );
}
