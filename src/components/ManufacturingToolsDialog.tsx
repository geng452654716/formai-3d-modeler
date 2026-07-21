import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleDotDashed,
  FileUp,
  LoaderCircle,
  Puzzle,
  Scissors,
  Trash2,
  Wrench,
  X
} from 'lucide-react';
import {
  createManufacturingPlan,
  type ExactFastenerType,
  type FastenerType,
  type JointType,
  type ManufacturingSourceKind,
  type ScrewSize,
  type SplitAxis,
  type SplitStrategy
} from '../model/manufacturing';
import { describeMeshRepair } from '../model/importedModel';
import { useModelStore } from '../store/useModelStore';

interface ManufacturingToolsDialogProps {
  onClose: () => void;
}

interface SplitSourceOption {
  key: string;
  kind: ManufacturingSourceKind;
  id: string;
  label: string;
}

const axisName: Record<SplitAxis, string> = {
  x: 'X 轴（左右拆分）',
  y: 'Y 轴（前后拆分）',
  z: 'Z 轴（上下拆分）'
};

const jointName: Record<JointType, string> = {
  'round-pin': '圆柱定位销',
  'd-pin': 'D 形防转销',
  dovetail: '燕尾榫',
  'ball-socket': '球头连接',
  magnet: '磁铁安装孔'
};

/** 将内核紧固结构标识转换为全中文结果名称。 */
function fastenerName(type: ExactFastenerType, screwSize: ScrewSize): string {
  return {
    none: '紧固结构',
    'screw-boss': `${screwSize} 螺丝柱`,
    'snap-fit': 'PLA/PETG 可拆卡扣',
    'threaded-hole': `${screwSize} 打印内螺纹`,
    'external-thread': `${screwSize} 打印外螺纹`,
    'iso-threaded-hole': `${screwSize} ISO 60° 内螺纹`,
    'iso-external-thread': `${screwSize} ISO 60° 外螺纹`
  }[type];
}

export function ManufacturingToolsDialog({ onClose }: ManufacturingToolsDialogProps) {
  const parameters = useModelStore((state) => state.parameters);
  const cadStatus = useModelStore((state) => state.cadStatus);
  const cadResult = useModelStore((state) => state.cadResult);
  const generateCad = useModelStore((state) => state.generateCad);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const importedStlStatus = useModelStore((state) => state.importedStlStatus);
  const importedStlError = useModelStore((state) => state.importedStlError);
  const importStlModel = useModelStore((state) => state.importStlModel);
  const clearImportedStlModel = useModelStore((state) => state.clearImportedStlModel);
  const setExploded = useModelStore((state) => state.setExploded);
  const addAssistantMessage = useModelStore((state) => state.addAssistantMessage);
  const runManufacturingSplit = useModelStore((state) => state.runManufacturingSplit);
  const manufacturingStatus = useModelStore((state) => state.manufacturingStatus);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const manufacturingError = useModelStore((state) => state.manufacturingError);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [splitStrategy, setSplitStrategy] = useState<SplitStrategy>('support-minimization');
  const [sourceKey, setSourceKey] = useState('');
  const [splitAxis, setSplitAxis] = useState<SplitAxis>(() => manufacturingResult?.validation.axis ?? 'x');
  const [offsetMm, setOffsetMm] = useState(() => manufacturingResult?.validation.offsetMm ?? 0);
  const [jointType, setJointType] = useState<JointType>('d-pin');
  const [fastenerType, setFastenerType] = useState<FastenerType>('screw-boss');
  const [screwSize, setScrewSize] = useState<ScrewSize>('M3');
  const [clearanceMm, setClearanceMm] = useState(0.25);

  const sourceOptions = useMemo<SplitSourceOption[]>(() => {
    const options: SplitSourceOption[] = (cadResult?.parts ?? []).map((part) => ({
      key: `cad-part:${part.id}`,
      kind: 'cad-part' as const,
      id: part.id,
      label: `当前项目：${part.label}`
    }));
    if (importedStlModel) {
      options.push({
        key: 'uploaded-stl:uploaded-model',
        kind: 'uploaded-stl',
        id: importedStlModel.id,
        label: `上传模型：${importedStlModel.originalFileName}`
      });
    }
    return options;
  }, [cadResult, importedStlModel]);

  const preferredSourceKey = viewportModelSource === 'uploaded-stl' && importedStlModel
    ? 'uploaded-stl:uploaded-model'
    : sourceOptions[0]?.key ?? '';
  const activeSource = sourceOptions.find((source) => source.key === sourceKey)
    ?? sourceOptions.find((source) => source.key === preferredSourceKey)
    ?? sourceOptions[0];
  const displayedManufacturingResult = manufacturingResult
    && activeSource
    && manufacturingResult.sourceKind === activeSource.kind
    && manufacturingResult.sourcePartId === activeSource.id
    && manufacturingResult.validation.axis === splitAxis
    && Math.abs(manufacturingResult.validation.offsetMm - offsetMm) < 1e-6
    && manufacturingResult.features.jointType === jointType
    && manufacturingResult.features.fastenerType === fastenerType
    && manufacturingResult.features.screwSize === screwSize
    && Math.abs(manufacturingResult.features.clearanceMm - clearanceMm) < 1e-6
    ? manufacturingResult
    : null;
  const plan = useMemo(() => createManufacturingPlan(parameters, {
    splitStrategy,
    jointType,
    fastenerType,
    screwSize,
    clearanceMm
  }, {
    sourceKind: activeSource?.kind,
    splitAxis,
    boundsMm: activeSource?.kind === 'uploaded-stl'
      ? importedStlModel?.metrics.boundsMm
      : undefined
  }), [activeSource?.kind, clearanceMm, fastenerType, importedStlModel?.metrics.boundsMm, jointType, parameters, screwSize, splitAxis, splitStrategy]);

  useEffect(() => {
    if (activeSource?.kind !== 'uploaded-stl' || !importedStlModel) return;
    const bounds = importedStlModel.metrics.boundsMm;
    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      z: (bounds.minZ + bounds.maxZ) / 2
    }[splitAxis];
    setOffsetMm(Number(center.toFixed(3)));
  }, [activeSource?.kind, importedStlModel?.revision, splitAxis]);

  const handleStlUpload = async (file: File | undefined) => {
    if (!file) return;
    const imported = await importStlModel(file);
    if (!imported) return;
    setSourceKey('uploaded-stl:uploaded-model');
    const bounds = imported.metrics.boundsMm;
    setOffsetMm(Number(((bounds.minX + bounds.maxX) / 2).toFixed(3)));
  };

  const handleGenerate = async () => {
    if (!activeSource) return;
    let resolvedSource = activeSource;
    let currentCadResult = cadResult;
    if (activeSource.kind === 'cad-part' && cadStatus !== 'ready') {
      currentCadResult = await generateCad();
      if (!currentCadResult) return;
      const part = currentCadResult.parts.find((candidate) => candidate.id === activeSource.id)
        ?? currentCadResult.parts[0];
      if (!part) return;
      resolvedSource = {
        key: `cad-part:${part.id}`,
        kind: 'cad-part',
        id: part.id,
        label: `当前项目：${part.label}`
      };
      setSourceKey(resolvedSource.key);
    }

    const result = await runManufacturingSplit({
      sourceKind: resolvedSource.kind,
      sourcePartId: resolvedSource.id,
      axis: splitAxis,
      offsetMm,
      jointType,
      fastenerType,
      screwSize,
      clearanceMm
    });
    if (!result) return;
    setExploded(true);
    const validation = result.validation;
    const features = result.features;
    const fastenerSummary = `${features.fastenerCount} 个 ${fastenerName(features.fastenerType, features.screwSize)}`;
    addAssistantMessage(
      `已完成精确拆件和连接结构实体化：${resolvedSource.label}沿${axisName[splitAxis]}、坐标 ${offsetMm.toFixed(2)} 毫米拆为两个封闭实体；已布尔写入 ${features.jointCount} 个${jointName[features.jointType]}和 ${fastenerSummary}；最小设计壁厚 ${features.minimumDesignedWallMm.toFixed(2)} 毫米，装配干涉 ${features.interferenceVolumeMm3.toFixed(6)} 立方毫米；拆件体积守恒误差 ${validation.volumeErrorMm3.toFixed(6)} 立方毫米。`
    );
  };

  const running = manufacturingStatus === 'generating';
  const importing = importedStlStatus === 'importing';
  const importedBounds = importedStlModel?.metrics.boundsMm;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card manufacturing-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <Wrench size={18} />
            <div>
              <strong>拆件与连接结构</strong>
              <span>任意 STL / CAD 零件 · 简单修洞与切割补面 · P1S 制造约束</span>
            </div>
          </div>
          <button onClick={onClose} title="关闭"><X size={17} /></button>
        </header>

        <section className="stl-import-panel">
          <div>
            <strong><FileUp size={16} /> 上传自定义 STL</strong>
            <span>模型类型、文件名和零件结构不受限制；支持毫米制封闭网格和简单平面孔洞自动修复。</span>
          </div>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept=".stl,model/stl"
            onChange={(event) => {
              void handleStlUpload(event.target.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
          <div className="stl-import-actions">
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing || running}>
              {importing ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />}
              {importing ? '正在检查 STL' : '选择 STL 文件'}
            </button>
            {importedStlModel && (
              <button type="button" className="secondary-danger-button" onClick={clearImportedStlModel} disabled={running}>
                <Trash2 size={14} /> 移除上传模型
              </button>
            )}
          </div>
          {importedStlModel && importedBounds && (
            <div className="stl-import-summary">
              <CheckCircle2 size={16} />
              <div>
                <strong>{importedStlModel.originalFileName}</strong>
                <span>
                  {importedStlModel.metrics.triangleCount.toLocaleString()} 个三角面 · {importedStlModel.metrics.solidCount} 个封闭实体 ·
                  {' '}{importedBounds.x.toFixed(2)} × {importedBounds.y.toFixed(2)} × {importedBounds.z.toFixed(2)} 毫米 ·
                  {' '}{importedStlModel.metrics.volumeMm3.toFixed(2)} 立方毫米
                </span>
                <span>{describeMeshRepair(importedStlModel.metrics.repair)}</span>
              </div>
            </div>
          )}
          {importedStlError && <div className="manufacturing-error">STL 导入失败：{importedStlError}</div>}
        </section>

        <div className="manufacturing-grid">
          <section>
            <h3><Scissors size={15} /> 自动拆件与补面</h3>
            <label>
              拆件策略
              <select value={splitStrategy} onChange={(event) => setSplitStrategy(event.target.value as SplitStrategy)}>
                <option value="support-minimization">最少支撑</option>
                <option value="print-volume">适配打印空间</option>
                <option value="manual-plane">手动分型平面</option>
              </select>
            </label>
            <label>
              拆件来源
              <select
                value={activeSource?.key ?? ''}
                onChange={(event) => setSourceKey(event.target.value)}
                disabled={sourceOptions.length === 0}
              >
                {sourceOptions.length === 0 && <option value="">暂无可拆模型</option>}
                {sourceOptions.map((source) => (
                  <option key={source.key} value={source.key}>{source.label}</option>
                ))}
              </select>
            </label>
            <label>
              切割方向
              <select value={splitAxis} onChange={(event) => setSplitAxis(event.target.value as SplitAxis)}>
                <option value="x">X 轴（左右）</option>
                <option value="y">Y 轴（前后）</option>
                <option value="z">Z 轴（上下）</option>
              </select>
            </label>
            <label>
              平面坐标
              <div className="modal-number">
                <input
                  type="number"
                  step="0.5"
                  value={offsetMm}
                  onChange={(event) => setOffsetMm(Number(event.target.value))}
                />
                <span>毫米</span>
              </div>
            </label>
            <p>{plan.splitDescription} 当前会真实生成两个 STEP/STL 封闭实体。</p>
          </section>
          <section>
            <h3><Puzzle size={15} /> 自动连接结构</h3>
            <label>
              连接器
              <select value={jointType} onChange={(event) => setJointType(event.target.value as JointType)}>
                <option value="round-pin">圆柱定位销</option>
                <option value="d-pin">D 形防转销</option>
                <option value="dovetail">燕尾榫</option>
                <option value="ball-socket">球头连接</option>
                <option value="magnet">磁铁孔</option>
              </select>
            </label>
            <label>
              公母间隙
              <div className="modal-number">
                <input type="number" min="0.1" max="1" step="0.05" value={clearanceMm} onChange={(event) => setClearanceMm(Number(event.target.value))} />
                <span>毫米</span>
              </div>
            </label>
          </section>
          <section>
            <h3><CircleDotDashed size={15} /> 卡扣、螺纹与螺丝</h3>
            <label>
              结构类型
              <select value={fastenerType} onChange={(event) => setFastenerType(event.target.value as FastenerType)}>
                <option value="screw-boss">螺丝柱、通孔、沉孔（精确实体）</option>
                <option value="snap-fit">PLA/PETG 可拆卡扣（精确实体）</option>
                <option value="threaded-hole">打印友好近似内螺纹（精确实体）</option>
                <option value="external-thread">打印友好近似外螺纹（精确实体）</option>
                <option value="iso-threaded-hole">ISO 公制 60° 内螺纹（精确实体）</option>
                <option value="iso-external-thread">ISO 公制 60° 外螺纹（精确实体）</option>
              </select>
            </label>
            {fastenerType !== 'snap-fit' && (
              <label>
                公制规格
                <select value={screwSize} onChange={(event) => setScrewSize(event.target.value as ScrewSize)}>
                  <option>M2</option>
                  <option>M2.5</option>
                  <option>M3</option>
                </select>
              </label>
            )}
            <p>{plan.fastenerDescription}</p>
          </section>
        </div>
        <div className="plan-preview">
          <div>
            <strong>制造方案预览</strong>
            <span>2 个拆件 · {plan.connectors.length} 个候选连接位 · 间隙 {clearanceMm.toFixed(2)} 毫米</span>
          </div>
          <div className="connector-table">
            {plan.connectors.map((connector) => (
              <span key={connector.label}>
                {connector.label}
                <small>{plan.connectorAxes[0]} {connector.xMm.toFixed(1)} / {plan.connectorAxes[1]} {connector.yMm.toFixed(1)} / Ø {connector.diameterMm.toFixed(1)} 毫米</small>
              </span>
            ))}
          </div>
          {plan.warnings.map((warning) => <p className="analysis-warning" key={warning}>{warning}</p>)}
        </div>
        {displayedManufacturingResult && (
          <>
            <div className="manufacturing-validation">
              <CheckCircle2 size={16} />
              <div>
                <strong>精确拆件与连接结构校验通过</strong>
                <span>
                  {displayedManufacturingResult.features.jointCount} 个{jointName[displayedManufacturingResult.features.jointType]} ·
                  {' '}{displayedManufacturingResult.features.fastenerCount} 个
                  {' '}{fastenerName(
                    displayedManufacturingResult.features.fastenerType,
                    displayedManufacturingResult.features.screwSize
                  )} ·
                  {' '}最小设计壁厚 {displayedManufacturingResult.features.minimumDesignedWallMm.toFixed(2)} 毫米 ·
                  {' '}装配干涉 {displayedManufacturingResult.features.interferenceVolumeMm3.toFixed(6)} 立方毫米
                </span>
                <span>
                  两侧切割补面 {displayedManufacturingResult.validation.negativeCapFaces + displayedManufacturingResult.validation.positiveCapFaces} 个 ·
                  拆件体积误差 {displayedManufacturingResult.validation.volumeErrorMm3.toFixed(6)} 立方毫米 · 两个实体均已封闭
                </span>
              </div>
            </div>
            <div className="connector-table">
              {displayedManufacturingResult.features.placements.map((placement) => (
                <span key={`${placement.role}-${placement.label}`}>
                  {placement.label}
                  <small>
                    {displayedManufacturingResult.features.placementAxes[0]} {placement.uMm.toFixed(2)} /
                    {' '}{displayedManufacturingResult.features.placementAxes[1]} {placement.vMm.toFixed(2)} /
                    {' '}{placement.pitchMm != null && placement.diameterMm != null && placement.lengthMm != null
                      ? `Ø ${placement.diameterMm.toFixed(2)} 毫米 / 螺距 ${placement.pitchMm.toFixed(2)} 毫米 / 有效长度 ${placement.lengthMm.toFixed(2)} 毫米${placement.profileAngleDeg != null ? ` / 牙型角 ${placement.profileAngleDeg.toFixed(0)}°` : ""}${placement.threadStandard ? ` / ${placement.threadStandard}` : ""}`
                      : placement.diameterMm != null
                        ? `Ø ${placement.diameterMm.toFixed(2)} 毫米`
                        : `${placement.widthMm?.toFixed(2)} × ${placement.heightMm?.toFixed(2)} × ${placement.lengthMm?.toFixed(2)} 毫米`}
                  </small>
                </span>
              ))}
            </div>
          </>
        )}
        {manufacturingError && <div className="manufacturing-error">拆件失败：{manufacturingError}</div>}
        <div className="manufacturing-note">
          圆柱销、D 形销、燕尾榫、球头和磁铁孔现已由 OpenCascade 布尔写入拆件实体；PLA/PETG 可拆悬臂卡扣、M2/M2.5/M3 螺丝柱、打印友好圆脊近似螺纹和 ISO 公制粗牙 60° 内外螺纹均已实体化，并检查封闭性、最小设计壁厚、装配间隙与干涉。复杂非流形、自相交、分叉、嵌套或明显非共面破面仍会明确拒绝。
        </div>
        <button className="primary-modal-button" onClick={() => void handleGenerate()} disabled={running || importing || !activeSource}>
          {running ? <LoaderCircle className="spin" size={16} /> : displayedManufacturingResult ? <CheckCircle2 size={16} /> : <Wrench size={16} />}
          {running ? '正在生成拆件与连接实体' : displayedManufacturingResult ? '重新生成精确拆件与连接' : '生成精确拆件与连接'}
        </button>
      </section>
    </div>
  );
}
