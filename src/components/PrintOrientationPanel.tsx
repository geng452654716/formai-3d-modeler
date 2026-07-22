import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, Move, MoveDown, Printer, Rotate3D, RotateCcw, X } from 'lucide-react';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { resolveGeneratedModelUrl } from '../model/cad';
import { normalizeObjectPresentation, type ObjectVector3 } from '../model/objectTransform';
import {
  createPrintBedPlacementPresentation,
  createPrintOrientationPresentation,
  createPrintPlatformCenterPresentation,
  createPrintPlatformSafetyCorrectionPresentation,
  evaluateAxisAlignedPrintOrientations,
  evaluatePrintBedPlacement,
  evaluatePrintPlatformBoundary,
  evaluatePrintPlatformSafetyArea,
  isPrintOrientationRotationApplied,
  translatePrintPlatformBoundaryPreview,
  type PrintBedNormalizationSpace,
  type PrintBedPlacementPreview,
  type PrintOrientationAnalysis,
  type PrintPlatformBoundaryPreview
} from '../model/printOrientation';
import { createPrintPlatformOverlay } from '../model/printPlatformOverlay';
import { useModelStore } from '../store/useModelStore';

export interface PrintOrientationSource {
  identity: string;
  fileName: string;
  revision: string;
  label: string;
  buildVolumeMm: [number, number, number];
  objectId: string;
  fallbackColor: string;
  uniformScale: number;
  currentRotationDeg: ObjectVector3;
  currentPositionMm: ObjectVector3;
  bedNormalizationSpace: PrintBedNormalizationSpace;
  basePositionDisplayMm: ObjectVector3;
}

interface PrintOrientationPanelProps {
  source: PrintOrientationSource | null;
  unavailableReason?: string;
}

interface SafetyCorrectionConfirmation {
  safetyMarginMm: number;
  correctionDeltaMm: { x: number; z: number };
  targetPositionMm: { x: number; z: number };
}

type AnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      sourceIdentity: string;
      result: PrintOrientationAnalysis;
      bedPlacement: PrintBedPlacementPreview;
      platformBoundary: PrintPlatformBoundaryPreview;
    };

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : '打印方向分析失败，请稍后重试';
}

/** 从当前精确 STL 读取三角网格，展示六向打印估算并可确认应用到当前对象。 */
export function PrintOrientationPanel({ source, unavailableReason }: PrintOrientationPanelProps) {
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: 'idle' });
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [bedConfirmationOpen, setBedConfirmationOpen] = useState(false);
  const [centerConfirmationOpen, setCenterConfirmationOpen] = useState(false);
  const [safetyCorrectionConfirmation, setSafetyCorrectionConfirmation] = useState<SafetyCorrectionConfirmation | null>(null);
  const [safetyMarginInput, setSafetyMarginInput] = useState('5');
  const [applicationNotice, setApplicationNotice] = useState<string | null>(null);
  const requestSerial = useRef(0);
  const pendingPresentationNotice = useRef<string | null>(null);

  useEffect(() => {
    requestSerial.current += 1;
    setAnalysisState({ status: 'idle' });
    setConfirmationOpen(false);
    setBedConfirmationOpen(false);
    setCenterConfirmationOpen(false);
    setSafetyCorrectionConfirmation(null);
    setApplicationNotice(pendingPresentationNotice.current);
    pendingPresentationNotice.current = null;
    return () => {
      requestSerial.current += 1;
    };
  }, [source?.identity]);

  async function analyze() {
    if (!source) return;
    const serial = ++requestSerial.current;
    const sourceIdentity = source.identity;
    setAnalysisState({ status: 'loading' });
    setConfirmationOpen(false);
    setBedConfirmationOpen(false);
    setCenterConfirmationOpen(false);
    setSafetyCorrectionConfirmation(null);
    setApplicationNotice(null);
    let sourceUrl: string | null = null;
    try {
      sourceUrl = await resolveGeneratedModelUrl(source.fileName, source.revision);
      if (!sourceUrl) throw new Error('无法读取当前模型的精确 STL 文件');
      const response = await fetch(sourceUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`读取精确 STL 失败（${response.status}）`);
      const geometry = new STLLoader().parse(await response.arrayBuffer());
      try {
        const positions = geometry.getAttribute('position');
        if (!positions) throw new Error('当前 STL 缺少三角面坐标');
        const result = evaluateAxisAlignedPrintOrientations({
          positions: positions.array,
          indices: geometry.getIndex()?.array ?? null
        }, {
          buildVolumeMm: source.buildVolumeMm,
          overhangAngleDeg: 45,
          uniformScale: source.uniformScale
        });
        const bedPlacement = evaluatePrintBedPlacement({
          positions: positions.array,
          indices: geometry.getIndex()?.array ?? null
        }, {
          rotationDeg: source.currentRotationDeg,
          positionMm: source.currentPositionMm,
          uniformScale: source.uniformScale,
          normalizationSpace: source.bedNormalizationSpace,
          basePositionDisplayMm: source.basePositionDisplayMm
        });
        const platformBoundary = evaluatePrintPlatformBoundary({
          positions: positions.array,
          indices: geometry.getIndex()?.array ?? null
        }, {
          rotationDeg: source.currentRotationDeg,
          positionMm: source.currentPositionMm,
          uniformScale: source.uniformScale,
          normalizationSpace: source.bedNormalizationSpace,
          basePositionDisplayMm: source.basePositionDisplayMm,
          platformSizeMm: [source.buildVolumeMm[0], source.buildVolumeMm[1]]
        });
        if (serial !== requestSerial.current || sourceIdentity !== source.identity) return;
        setAnalysisState({ status: 'ready', sourceIdentity, result, bedPlacement, platformBoundary });
      } finally {
        geometry.dispose();
      }
    } catch (error) {
      if (serial !== requestSerial.current) return;
      setAnalysisState({ status: 'error', message: errorMessage(error) });
    } finally {
      if (sourceUrl?.startsWith('blob:')) URL.revokeObjectURL(sourceUrl);
    }
  }

  const result = analysisState.status === 'ready' && analysisState.sourceIdentity === source?.identity
    ? analysisState.result
    : null;
  const recommended = result?.candidates.find((candidate) => candidate.id === result.recommendedId) ?? null;
  const bedPlacement = analysisState.status === 'ready' && analysisState.sourceIdentity === source?.identity
    ? analysisState.bedPlacement
    : null;
  const platformBoundary = analysisState.status === 'ready' && analysisState.sourceIdentity === source?.identity
    ? analysisState.platformBoundary
    : null;
  const alreadyApplied = Boolean(source && recommended && isPrintOrientationRotationApplied(
    source.currentRotationDeg,
    recommended.id
  ));

  const safetyMarginValue = safetyMarginInput.trim() ? Number(safetyMarginInput) : Number.NaN;
  const safetyEvaluation = useMemo(() => {
    if (!platformBoundary) return { safetyArea: null, safetyMarginError: null };
    try {
      return {
        safetyArea: evaluatePrintPlatformSafetyArea(platformBoundary, safetyMarginValue),
        safetyMarginError: null
      };
    } catch (error) {
      return { safetyArea: null, safetyMarginError: errorMessage(error) };
    }
  }, [platformBoundary, safetyMarginValue]);
  const { safetyArea, safetyMarginError } = safetyEvaluation;

  useEffect(() => {
    const store = useModelStore.getState();
    if (!source || !bedPlacement?.alreadyOnBed || !platformBoundary || !safetyArea) {
      store.clearPrintPlatformOverlay(source?.identity);
      return;
    }

    try {
      store.setPrintPlatformOverlay(createPrintPlatformOverlay({
        identity: source.identity,
        objectId: source.objectId,
        objectLabel: source.label
      }, platformBoundary, safetyArea));
    } catch {
      store.clearPrintPlatformOverlay(source.identity);
      return;
    }

    return () => {
      useModelStore.getState().clearPrintPlatformOverlay(source.identity);
    };
  }, [bedPlacement?.alreadyOnBed, platformBoundary, safetyArea, source]);

  /** 写入前核对 Store 中的实时对象变换仍与本次分析来源严格一致。 */
  function sourceTransformStillCurrent(current: ReturnType<typeof normalizeObjectPresentation>) {
    if (!source) return false;
    return current.transform.scale === source.uniformScale
      && (['x', 'y', 'z'] as const).every((axis) => (
        current.transform.positionMm[axis] === source.currentPositionMm[axis]
        && current.transform.rotationDeg[axis] === source.currentRotationDeg[axis]
      ));
  }

  /** 二次确认后复用对象展示状态版本链，只写当前对象的绝对旋转。 */
  function applyRecommendedOrientation() {
    if (!source || !recommended || analysisState.status !== 'ready' || analysisState.sourceIdentity !== source.identity) {
      setConfirmationOpen(false);
      setApplicationNotice('当前分析已经失效，请重新分析后再应用。');
      return;
    }

    const store = useModelStore.getState();
    const current = normalizeObjectPresentation(store.objectPresentations[source.objectId], source.fallbackColor);
    if (isPrintOrientationRotationApplied(current.transform.rotationDeg, recommended.id)) {
      setConfirmationOpen(false);
      setApplicationNotice('当前对象已经是推荐打印方向，无需重复应用。');
      return;
    }

    const successNotice = '已应用推荐方向，请重新分析确认当前打印风险。';
    pendingPresentationNotice.current = successNotice;
    try {
      const next = createPrintOrientationPresentation(current, recommended.id, source.fallbackColor);
      store.beginObjectPresentationEdit(source.objectId, source.fallbackColor);
      store.updateObjectPresentation(source.objectId, next, source.fallbackColor);
      store.finishObjectPresentationEdit(
        source.objectId,
        `应用“${source.label}”的打印方向：${recommended.label}`,
        source.fallbackColor
      );
      const applied = normalizeObjectPresentation(
        useModelStore.getState().objectPresentations[source.objectId],
        source.fallbackColor
      );
      if (!isPrintOrientationRotationApplied(applied.transform.rotationDeg, recommended.id)) {
        throw new Error('对象旋转写入后校验失败');
      }
      requestSerial.current += 1;
      setAnalysisState({ status: 'idle' });
      setConfirmationOpen(false);
      setCenterConfirmationOpen(false);
      setApplicationNotice(successNotice);
    } catch (error) {
      pendingPresentationNotice.current = null;
      setConfirmationOpen(false);
      setApplicationNotice(`应用推荐方向失败：${errorMessage(error)}`);
    }
  }

  /** 用户确认后只写视口 Y 位置，使当前旋转缩放后的最低点落到平台 0 毫米。 */
  function applyPrintBedPlacement() {
    if (
      !source
      || !recommended
      || !bedPlacement
      || !alreadyApplied
      || analysisState.status !== 'ready'
      || analysisState.sourceIdentity !== source.identity
    ) {
      setBedConfirmationOpen(false);
      setApplicationNotice('当前落床预览已经失效，请重新分析后再应用。');
      return;
    }

    const store = useModelStore.getState();
    const current = normalizeObjectPresentation(store.objectPresentations[source.objectId], source.fallbackColor);
    if (!sourceTransformStillCurrent(current)) {
      setBedConfirmationOpen(false);
      setApplicationNotice('当前对象变换已经变化，请重新分析后再落床。');
      return;
    }
    if (bedPlacement.alreadyOnBed) {
      setBedConfirmationOpen(false);
      setApplicationNotice('当前对象已经落在打印平台，无需重复移动。');
      return;
    }

    const successNotice = '已将当前对象落到打印平台，可使用撤销或重做恢复。';
    pendingPresentationNotice.current = successNotice;
    try {
      const next = createPrintBedPlacementPresentation(current, bedPlacement, source.fallbackColor);
      if (Math.abs(next.transform.positionMm.y - bedPlacement.targetVerticalPositionMm) > 1e-6) {
        throw new Error('目标垂直位置超出对象变换允许范围');
      }
      store.beginObjectPresentationEdit(source.objectId, source.fallbackColor);
      store.updateObjectPresentation(source.objectId, next, source.fallbackColor);
      const written = normalizeObjectPresentation(
        useModelStore.getState().objectPresentations[source.objectId],
        source.fallbackColor
      );
      if (Math.abs(written.transform.positionMm.y - bedPlacement.targetVerticalPositionMm) > 1e-6) {
        store.updateObjectPresentation(source.objectId, current, source.fallbackColor);
        store.finishObjectPresentationEdit(source.objectId, '取消无效自动落床', source.fallbackColor);
        throw new Error('对象垂直位置写入后校验失败');
      }
      store.finishObjectPresentationEdit(
        source.objectId,
        `将“${source.label}”落到打印平台`,
        source.fallbackColor
      );
      requestSerial.current += 1;
      setAnalysisState({ status: 'idle' });
      setBedConfirmationOpen(false);
      setCenterConfirmationOpen(false);
      setApplicationNotice(successNotice);
    } catch (error) {
      pendingPresentationNotice.current = null;
      setBedConfirmationOpen(false);
      setApplicationNotice(`自动落床失败：${errorMessage(error)}`);
    }
  }

  /** 用户确认后只写视口 X/Z 位置，使当前对象水平包围范围中心对齐平台中心。 */
  function applyPrintPlatformCenter() {
    if (
      !source
      || !recommended
      || !bedPlacement?.alreadyOnBed
      || !platformBoundary
      || !alreadyApplied
      || analysisState.status !== 'ready'
      || analysisState.sourceIdentity !== source.identity
    ) {
      setCenterConfirmationOpen(false);
      setApplicationNotice('当前居中预览已经失效，请重新分析后再应用。');
      return;
    }

    const store = useModelStore.getState();
    const current = normalizeObjectPresentation(store.objectPresentations[source.objectId], source.fallbackColor);
    if (!sourceTransformStillCurrent(current)) {
      setCenterConfirmationOpen(false);
      setApplicationNotice('当前对象变换已经变化，请重新分析后再居中。');
      return;
    }
    if (platformBoundary.alreadyCentered) {
      setCenterConfirmationOpen(false);
      setApplicationNotice('当前对象已经水平居中，无需重复移动。');
      return;
    }
    const target = platformBoundary.targetHorizontalPositionMm;
    const targetMatchesPreview = Number.isFinite(target.x)
      && Number.isFinite(target.z)
      && Math.abs(current.transform.positionMm.x + platformBoundary.centerDeltaMm.x - target.x) <= 1e-6
      && Math.abs(current.transform.positionMm.z + platformBoundary.centerDeltaMm.z - target.z) <= 1e-6;
    if (!targetMatchesPreview) {
      setCenterConfirmationOpen(false);
      setApplicationNotice('当前居中目标无效，请重新分析后再应用。');
      return;
    }

    const successNotice = '已将当前对象移动到打印平台中心，可使用撤销或重做恢复。';
    pendingPresentationNotice.current = successNotice;
    try {
      const next = createPrintPlatformCenterPresentation(current, platformBoundary, source.fallbackColor);
      if (
        Math.abs(next.transform.positionMm.x - target.x) > 1e-6
        || Math.abs(next.transform.positionMm.z - target.z) > 1e-6
      ) {
        throw new Error('目标水平位置超出对象变换允许范围');
      }
      store.beginObjectPresentationEdit(source.objectId, source.fallbackColor);
      store.updateObjectPresentation(source.objectId, next, source.fallbackColor);
      const written = normalizeObjectPresentation(
        useModelStore.getState().objectPresentations[source.objectId],
        source.fallbackColor
      );
      if (
        Math.abs(written.transform.positionMm.x - target.x) > 1e-6
        || Math.abs(written.transform.positionMm.z - target.z) > 1e-6
      ) {
        store.updateObjectPresentation(source.objectId, current, source.fallbackColor);
        store.finishObjectPresentationEdit(source.objectId, '取消无效平台居中', source.fallbackColor);
        throw new Error('对象水平位置写入后校验失败');
      }
      store.finishObjectPresentationEdit(
        source.objectId,
        `将“${source.label}”移动到打印平台中心`,
        source.fallbackColor
      );
      requestSerial.current += 1;
      setAnalysisState({ status: 'idle' });
      setCenterConfirmationOpen(false);
      setApplicationNotice(successNotice);
    } catch (error) {
      pendingPresentationNotice.current = null;
      setCenterConfirmationOpen(false);
      setApplicationNotice(`平台居中失败：${errorMessage(error)}`);
    }
  }

  /** 冻结当前安全边距、最小修正量和目标位置，避免确认期间输入变化导致误写。 */
  function openSafetyCorrectionConfirmation() {
    if (
      !source
      || !recommended
      || !alreadyApplied
      || !bedPlacement?.alreadyOnBed
      || !platformBoundary
      || !safetyArea
      || safetyArea.fitsEffectiveArea
      || !safetyArea.canFitEffectiveArea
      || (
        Math.abs(safetyArea.correctionDeltaMm.x) <= 1e-4
        && Math.abs(safetyArea.correctionDeltaMm.z) <= 1e-4
      )
    ) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice('当前没有可应用的安全区域修正建议。');
      return;
    }
    setSafetyCorrectionConfirmation({
      safetyMarginMm: safetyArea.safetyMarginMm,
      correctionDeltaMm: { ...safetyArea.correctionDeltaMm },
      targetPositionMm: {
        x: source.currentPositionMm.x + safetyArea.correctionDeltaMm.x,
        z: source.currentPositionMm.z + safetyArea.correctionDeltaMm.z
      }
    });
    setCenterConfirmationOpen(false);
    setApplicationNotice(null);
  }

  /** 确认后重新验证实时来源与安全区域，只提交进入有效区域所需的最小 X/Z 平移。 */
  function applyPrintPlatformSafetyCorrection() {
    const confirmation = safetyCorrectionConfirmation;
    if (
      !source
      || !recommended
      || !alreadyApplied
      || !bedPlacement?.alreadyOnBed
      || !platformBoundary
      || !safetyArea
      || !confirmation
      || analysisState.status !== 'ready'
      || analysisState.sourceIdentity !== source.identity
    ) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice('当前安全区域修正预览已经失效，请重新分析后再应用。');
      return;
    }

    const store = useModelStore.getState();
    const current = normalizeObjectPresentation(store.objectPresentations[source.objectId], source.fallbackColor);
    if (!sourceTransformStillCurrent(current)) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice('当前对象变换已经变化，请重新分析后再修正安全区域。');
      return;
    }

    const deltaStillCurrent = Math.abs(safetyArea.correctionDeltaMm.x - confirmation.correctionDeltaMm.x) <= 1e-6
      && Math.abs(safetyArea.correctionDeltaMm.z - confirmation.correctionDeltaMm.z) <= 1e-6;
    const targetStillCurrent = Math.abs(current.transform.positionMm.x + confirmation.correctionDeltaMm.x - confirmation.targetPositionMm.x) <= 1e-6
      && Math.abs(current.transform.positionMm.z + confirmation.correctionDeltaMm.z - confirmation.targetPositionMm.z) <= 1e-6;
    if (
      Math.abs(safetyArea.safetyMarginMm - confirmation.safetyMarginMm) > 1e-6
      || !deltaStillCurrent
      || !targetStillCurrent
    ) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice('安全边距或修正目标已经变化，请重新确认后再应用。');
      return;
    }
    if (!safetyArea.canFitEffectiveArea || safetyArea.fitsEffectiveArea) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice(safetyArea.fitsEffectiveArea
        ? '当前对象已经位于安全有效区域，无需重复移动。'
        : '当前对象尺寸大于安全有效区域，无法仅靠平移修正。');
      return;
    }
    if (
      Math.abs(confirmation.correctionDeltaMm.x) <= 1e-4
      && Math.abs(confirmation.correctionDeltaMm.z) <= 1e-4
    ) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice('当前安全区域没有可应用的修正量。');
      return;
    }

    const correctedBoundary = translatePrintPlatformBoundaryPreview(
      platformBoundary,
      confirmation.correctionDeltaMm
    );
    const correctedSafetyArea = evaluatePrintPlatformSafetyArea(correctedBoundary, confirmation.safetyMarginMm);
    if (!correctedBoundary.fitsPlatform || !correctedSafetyArea.fitsEffectiveArea) {
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice('修正后的对象仍未完整进入安全有效区域，请重新分析。');
      return;
    }

    const successNotice = '已将当前对象移动到平台安全区域，可使用撤销或重做恢复；请重新分析确认安全余量。';
    pendingPresentationNotice.current = successNotice;
    try {
      const next = createPrintPlatformSafetyCorrectionPresentation(current, safetyArea, source.fallbackColor);
      if (
        Math.abs(next.transform.positionMm.x - confirmation.targetPositionMm.x) > 1e-6
        || Math.abs(next.transform.positionMm.z - confirmation.targetPositionMm.z) > 1e-6
      ) {
        throw new Error('安全区域目标位置超出对象变换允许范围');
      }
      store.beginObjectPresentationEdit(source.objectId, source.fallbackColor);
      store.updateObjectPresentation(source.objectId, next, source.fallbackColor);
      const written = normalizeObjectPresentation(
        useModelStore.getState().objectPresentations[source.objectId],
        source.fallbackColor
      );
      if (
        Math.abs(written.transform.positionMm.x - confirmation.targetPositionMm.x) > 1e-6
        || Math.abs(written.transform.positionMm.z - confirmation.targetPositionMm.z) > 1e-6
      ) {
        store.updateObjectPresentation(source.objectId, current, source.fallbackColor);
        store.finishObjectPresentationEdit(source.objectId, '取消无效安全区域修正', source.fallbackColor);
        throw new Error('对象安全区域位置写入后校验失败');
      }
      store.finishObjectPresentationEdit(
        source.objectId,
        `将“${source.label}”移动到平台安全区域`,
        source.fallbackColor
      );
      requestSerial.current += 1;
      setAnalysisState({ status: 'idle' });
      setSafetyCorrectionConfirmation(null);
      setCenterConfirmationOpen(false);
      setApplicationNotice(successNotice);
    } catch (error) {
      pendingPresentationNotice.current = null;
      setSafetyCorrectionConfirmation(null);
      setApplicationNotice(`安全区域修正失败：${errorMessage(error)}`);
    }
  }

  const bedMoveDescription = bedPlacement
    ? bedPlacement.requiredVerticalDeltaMm > 0
      ? `向上移动 ${Math.abs(bedPlacement.requiredVerticalDeltaMm).toFixed(2)} 毫米`
      : `向下移动 ${Math.abs(bedPlacement.requiredVerticalDeltaMm).toFixed(2)} 毫米`
    : '';
  const centerMoveXDescription = platformBoundary
    ? Math.abs(platformBoundary.centerDeltaMm.x) <= 1e-4
      ? 'X 方向无需移动'
      : `${platformBoundary.centerDeltaMm.x > 0 ? '向右（X 正）' : '向左（X 负）'}移动 ${Math.abs(platformBoundary.centerDeltaMm.x).toFixed(2)} 毫米`
    : '';
  const centerMoveZDescription = platformBoundary
    ? Math.abs(platformBoundary.centerDeltaMm.z) <= 1e-4
      ? 'Z 方向无需移动'
      : `${platformBoundary.centerDeltaMm.z > 0 ? '向前（Z 正）' : '向后（Z 负）'}移动 ${Math.abs(platformBoundary.centerDeltaMm.z).toFixed(2)} 毫米`
    : '';

  function marginDescription(label: string, marginMm: number) {
    return marginMm >= -1e-4
      ? `${label}余量 ${Math.max(0, marginMm).toFixed(2)} 毫米`
      : `${label}越界 ${Math.abs(marginMm).toFixed(2)} 毫米`;
  }

  function correctionDescription(axis: 'X' | 'Z', deltaMm: number) {
    if (Math.abs(deltaMm) <= 1e-4) return `${axis} 方向无需修正`;
    if (axis === 'X') return `${deltaMm > 0 ? '向右（X 正）' : '向左（X 负）'}修正 ${Math.abs(deltaMm).toFixed(2)} 毫米`;
    return `${deltaMm > 0 ? '向前（Z 正）' : '向后（Z 负）'}修正 ${Math.abs(deltaMm).toFixed(2)} 毫米`;
  }

  return (
    <section className="parameter-section print-orientation-section">
      <h3>
        <Printer size={14} /> 六向打印方向评估
      </h3>
      <p className="print-orientation-note">
        对精确封闭网格比较 X、Y、Z 正负六个朝上方向；按 P1S 成型空间、打印高度、底面接触和 45° 悬垂面积给出建议。
      </p>
      <button
        type="button"
        className="print-orientation-analyze-button"
        disabled={!source || analysisState.status === 'loading'}
        onClick={() => void analyze()}
      >
        {analysisState.status === 'loading' ? (
          <><LoaderCircle size={14} className="spin" /> 正在分析六个方向…</>
        ) : result ? (
          <><RotateCcw size={14} /> 重新分析打印方向</>
        ) : (
          <><Printer size={14} /> 分析打印方向</>
        )}
      </button>
      {!source && (
        <p className="print-orientation-unavailable">{unavailableReason ?? '当前没有可分析的精确封闭模型。'}</p>
      )}
      {analysisState.status === 'error' && (
        <p className="print-orientation-error" role="alert">{analysisState.message}</p>
      )}
      {applicationNotice && (
        <p className="print-orientation-application-notice" role="status">{applicationNotice}</p>
      )}
      {result && (
        <div className="print-orientation-result">
          <div className={`print-orientation-recommendation ${recommended ? 'available' : 'unavailable'}`}>
            {recommended ? <CheckCircle2 size={15} /> : <Printer size={15} />}
            <div>
              <strong>{recommended ? `推荐：${recommended.label}` : '当前六向候选均不可打印'}</strong>
              <span>{result.recommendedReason}</span>
            </div>
          </div>
          {recommended && source && (
            <div className="print-orientation-application">
              {alreadyApplied ? (
                <p className="print-orientation-applied-state"><CheckCircle2 size={14} /> 当前对象已是推荐打印方向</p>
              ) : !confirmationOpen ? (
                <button
                  type="button"
                  className="print-orientation-apply-button"
                  onClick={() => {
                    setConfirmationOpen(true);
                    setApplicationNotice(null);
                  }}
                >
                  <Rotate3D size={14} /> 应用推荐方向
                </button>
              ) : (
                <div className="print-orientation-confirmation" role="group" aria-label="确认应用推荐打印方向">
                  <strong>确认旋转“{source.label}”</strong>
                  <span>目标方向：{recommended.label}</span>
                  <span>
                    应用后尺寸：{recommended.widthMm.toFixed(1)} × {recommended.depthMm.toFixed(1)} × {recommended.heightMm.toFixed(1)} 毫米
                  </span>
                  <small>只改变当前对象旋转；位置、缩放、颜色、其他零件和几何文件保持不变。</small>
                  <div>
                    <button type="button" className="confirm" onClick={applyRecommendedOrientation}>
                      <CheckCircle2 size={13} /> 确认应用
                    </button>
                    <button type="button" className="cancel" onClick={() => setConfirmationOpen(false)}>
                      <X size={13} /> 取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {recommended && source && alreadyApplied && bedPlacement && (
            <div className="print-bed-placement">
              <div className="print-bed-placement-preview">
                <strong><MoveDown size={14} /> 自动落床预览</strong>
                <span>当前最低点：{bedPlacement.minimumHeightMm.toFixed(2)} 毫米</span>
                <span>目标平台高度：0.00 毫米</span>
                <span>目标 Y 位置：{bedPlacement.targetVerticalPositionMm.toFixed(2)} 毫米</span>
                <small>只沿视口垂直 Y 轴移动当前对象；水平位置、旋转、缩放、颜色和其他零件保持不变。</small>
              </div>
              {bedPlacement.alreadyOnBed ? (
                <p className="print-orientation-applied-state"><CheckCircle2 size={14} /> 当前对象已落在打印平台</p>
              ) : !bedConfirmationOpen ? (
                <button
                  type="button"
                  className="print-bed-apply-button"
                  onClick={() => {
                    setBedConfirmationOpen(true);
                    setApplicationNotice(null);
                  }}
                >
                  <MoveDown size={14} /> 将对象落到平台
                </button>
              ) : (
                <div className="print-orientation-confirmation" role="group" aria-label="确认自动落床">
                  <strong>确认移动“{source.label}”</strong>
                  <span>垂直位移：{bedMoveDescription}</span>
                  <span>最低点：{bedPlacement.minimumHeightMm.toFixed(2)} → 0.00 毫米</span>
                  <small>本操作只修改当前对象 Y 位置，并生成可撤销、可重做的中文版本。</small>
                  <div>
                    <button type="button" className="confirm" onClick={applyPrintBedPlacement}>
                      <CheckCircle2 size={13} /> 确认落床
                    </button>
                    <button type="button" className="cancel" onClick={() => setBedConfirmationOpen(false)}>
                      <X size={13} /> 取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {recommended && source && alreadyApplied && bedPlacement?.alreadyOnBed && platformBoundary && (
            <div className={`print-platform-boundary ${platformBoundary.fitsPlatform ? 'fits' : 'overflow'}`}>
              <div className="print-platform-boundary-heading">
                <strong><Move size={14} /> 平台边界与居中预览</strong>
                <b>{platformBoundary.fitsPlatform ? '完整适配' : '存在越界'}</b>
              </div>
              <span>
                当前占地：{platformBoundary.boundsMm.width.toFixed(2)} × {platformBoundary.boundsMm.depth.toFixed(2)} 毫米
              </span>
              <span>
                物理平台：{(platformBoundary.platformBoundsMm.maximumX - platformBoundary.platformBoundsMm.minimumX).toFixed(2)} × {(platformBoundary.platformBoundsMm.maximumZ - platformBoundary.platformBoundsMm.minimumZ).toFixed(2)} 毫米
              </span>
              <div className="print-platform-safety-controls">
                <label>
                  <span>平台安全边距</span>
                  <input
                    type="number"
                    min="0"
                    max="127.99"
                    step="0.5"
                    value={safetyMarginInput}
                    aria-label="平台安全边距 毫米"
                    onChange={(event) => {
                      setSafetyMarginInput(event.target.value);
                      setSafetyCorrectionConfirmation(null);
                    }}
                  />
                  <small>毫米</small>
                </label>
                <small>默认 5 毫米；只缩减只读有效区域，不移动对象或创建版本。</small>
              </div>
              {safetyMarginError ? (
                <p className="print-platform-safety-error">{safetyMarginError}</p>
              ) : safetyArea && (
                <div className={`print-platform-safety-preview ${safetyArea.fitsEffectiveArea ? 'fits' : 'overflow'}`}>
                  <div>
                    <strong>安全可打印区域</strong>
                    <b>{safetyArea.fitsEffectiveArea ? '位于安全区域' : '超出安全区域'}</b>
                  </div>
                  <span>有效区域：{safetyArea.effectivePlatformBoundsMm.width.toFixed(2)} × {safetyArea.effectivePlatformBoundsMm.depth.toFixed(2)} 毫米</span>
                  <div className="print-platform-margin-grid" aria-label="安全可打印区域四边余量">
                    {([
                      ['左（X 负）', safetyArea.marginsMm.left],
                      ['右（X 正）', safetyArea.marginsMm.right],
                      ['前（Z 正）', safetyArea.marginsMm.front],
                      ['后（Z 负）', safetyArea.marginsMm.back]
                    ] as const).map(([label, marginMm]) => (
                      <span key={label} className={marginMm < -1e-4 ? 'overflow' : ''}>
                        {marginDescription(label, marginMm)}
                      </span>
                    ))}
                  </div>
                  {safetyArea.fitsEffectiveArea ? (
                    <span>最小安全区域余量：{Math.max(0, safetyArea.minimumMarginMm).toFixed(2)} 毫米</span>
                  ) : safetyArea.canFitEffectiveArea ? (
                    <div className="print-platform-safety-correction">
                      <strong>只读修正建议</strong>
                      <span>{correctionDescription('X', safetyArea.correctionDeltaMm.x)}</span>
                      <span>{correctionDescription('Z', safetyArea.correctionDeltaMm.z)}</span>
                      {!safetyCorrectionConfirmation ? (
                        <button
                          type="button"
                          className="print-platform-safety-correction-button"
                          onClick={openSafetyCorrectionConfirmation}
                        >
                          <Move size={14} /> 应用安全区域修正
                        </button>
                      ) : (
                        <div className="print-orientation-confirmation" role="group" aria-label="确认应用平台安全区域修正">
                          <strong>确认修正“{source.label}”</strong>
                          <span>安全边距：{safetyCorrectionConfirmation.safetyMarginMm.toFixed(2)} 毫米</span>
                          <span>当前位置：X {source.currentPositionMm.x.toFixed(2)}，Z {source.currentPositionMm.z.toFixed(2)} 毫米</span>
                          <span>
                            最小修正：{correctionDescription('X', safetyCorrectionConfirmation.correctionDeltaMm.x)}；
                            {correctionDescription('Z', safetyCorrectionConfirmation.correctionDeltaMm.z)}
                          </span>
                          <span>
                            修正后位置：X {safetyCorrectionConfirmation.targetPositionMm.x.toFixed(2)}，Z {safetyCorrectionConfirmation.targetPositionMm.z.toFixed(2)} 毫米
                          </span>
                          <small>本操作只修改当前对象 X/Z 位置，不强制居中，并生成可撤销、可重做的中文版本。</small>
                          <div>
                            <button type="button" className="confirm" onClick={applyPrintPlatformSafetyCorrection}>
                              <CheckCircle2 size={13} /> 确认修正
                            </button>
                            <button type="button" className="cancel" onClick={() => setSafetyCorrectionConfirmation(null)}>
                              <X size={13} /> 取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="print-platform-safety-error">当前对象尺寸大于安全有效区域，单纯移动无法完全进入。</p>
                  )}
                </div>
              )}
              <div className="print-platform-margin-grid" aria-label="打印平台四边余量">
                {([
                  ['左（X 负）', platformBoundary.marginsMm.left],
                  ['右（X 正）', platformBoundary.marginsMm.right],
                  ['前（Z 正）', platformBoundary.marginsMm.front],
                  ['后（Z 负）', platformBoundary.marginsMm.back]
                ] as const).map(([label, marginMm]) => (
                  <span key={label} className={marginMm < -1e-4 ? 'overflow' : ''}>
                    {marginDescription(label, marginMm)}
                  </span>
                ))}
              </div>
              {platformBoundary.fitsPlatform && (
                <span>最小安全余量：{Math.max(0, platformBoundary.minimumMarginMm).toFixed(2)} 毫米</span>
              )}
              <div className="print-platform-center-preview">
                <strong>{platformBoundary.alreadyCentered ? '当前对象已水平居中' : '只读居中建议'}</strong>
                <span>{centerMoveXDescription}</span>
                <span>{centerMoveZDescription}</span>
                <span>
                  目标位置：X {platformBoundary.targetHorizontalPositionMm.x.toFixed(2)}，Z {platformBoundary.targetHorizontalPositionMm.z.toFixed(2)} 毫米
                </span>
              </div>
              {platformBoundary.alreadyCentered ? (
                <p className="print-orientation-applied-state"><CheckCircle2 size={14} /> 当前对象已位于打印平台中心</p>
              ) : !centerConfirmationOpen ? (
                <button
                  type="button"
                  className="print-platform-center-button"
                  onClick={() => {
                    setCenterConfirmationOpen(true);
                    setApplicationNotice(null);
                  }}
                >
                  <Move size={14} /> 应用居中位置
                </button>
              ) : (
                <div className="print-orientation-confirmation" role="group" aria-label="确认应用打印平台居中">
                  <strong>确认居中“{source.label}”</strong>
                  <span>当前位置：X {source.currentPositionMm.x.toFixed(2)}，Z {source.currentPositionMm.z.toFixed(2)} 毫米</span>
                  <span>水平位移：{centerMoveXDescription}；{centerMoveZDescription}</span>
                  <span>目标位置：X {platformBoundary.targetHorizontalPositionMm.x.toFixed(2)}，Z {platformBoundary.targetHorizontalPositionMm.z.toFixed(2)} 毫米</span>
                  <small>本操作只修改当前对象 X/Z 位置，并生成可撤销、可重做的中文版本。</small>
                  <div>
                    <button type="button" className="confirm" onClick={applyPrintPlatformCenter}>
                      <CheckCircle2 size={13} /> 确认居中
                    </button>
                    <button type="button" className="cancel" onClick={() => setCenterConfirmationOpen(false)}>
                      <X size={13} /> 取消
                    </button>
                  </div>
                </div>
              )}
              <small>预览本身不会移动对象、排列其他零件或修改几何文件；只有确认后才写入当前对象的水平位置。</small>
            </div>
          )}
          <ul className="print-orientation-candidate-list" aria-label="六向打印方向候选">
            {result.candidates.map((candidate) => (
              <li
                key={candidate.id}
                className={`${candidate.id === result.recommendedId ? 'recommended' : ''} ${candidate.fitsBuildVolume ? '' : 'unavailable'}`.trim()}
              >
                <div>
                  <strong>{candidate.label}</strong>
                  <b>{candidate.id === result.recommendedId ? '推荐' : candidate.fitsBuildVolume ? `风险${candidate.riskLevel}` : '超出空间'}</b>
                </div>
                <span>
                  尺寸 {candidate.widthMm.toFixed(1)} × {candidate.depthMm.toFixed(1)} × {candidate.heightMm.toFixed(1)} 毫米
                </span>
                <span>
                  悬垂 {candidate.supportAreaMm2.toFixed(1)} 平方毫米（{(candidate.supportRatio * 100).toFixed(1)}%） · 接触 {candidate.contactAreaMm2.toFixed(1)} 平方毫米
                </span>
              </li>
            ))}
          </ul>
          <small>
            已分析“{source?.label}”的 {result.triangleCount.toLocaleString()} 个有效三角面；当前均匀缩放 {result.uniformScale.toFixed(3)} 倍。该结果是轴向几何估算，不等同于切片器生成的真实支撑、耗材或打印时间。
          </small>
        </div>
      )}
    </section>
  );
}
