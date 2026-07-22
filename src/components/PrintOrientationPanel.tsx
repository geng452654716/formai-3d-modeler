import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, MoveDown, Printer, Rotate3D, RotateCcw, X } from 'lucide-react';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { resolveGeneratedModelUrl } from '../model/cad';
import { normalizeObjectPresentation, type ObjectVector3 } from '../model/objectTransform';
import {
  createPrintBedPlacementPresentation,
  createPrintOrientationPresentation,
  evaluateAxisAlignedPrintOrientations,
  evaluatePrintBedPlacement,
  isPrintOrientationRotationApplied,
  type PrintBedNormalizationSpace,
  type PrintBedPlacementPreview,
  type PrintOrientationAnalysis
} from '../model/printOrientation';
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

type AnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      sourceIdentity: string;
      result: PrintOrientationAnalysis;
      bedPlacement: PrintBedPlacementPreview;
    };

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : '打印方向分析失败，请稍后重试';
}

/** 从当前精确 STL 读取三角网格，展示六向打印估算并可确认应用到当前对象。 */
export function PrintOrientationPanel({ source, unavailableReason }: PrintOrientationPanelProps) {
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: 'idle' });
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [bedConfirmationOpen, setBedConfirmationOpen] = useState(false);
  const [applicationNotice, setApplicationNotice] = useState<string | null>(null);
  const requestSerial = useRef(0);
  const pendingPresentationNotice = useRef<string | null>(null);

  useEffect(() => {
    requestSerial.current += 1;
    setAnalysisState({ status: 'idle' });
    setConfirmationOpen(false);
    setBedConfirmationOpen(false);
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
        if (serial !== requestSerial.current || sourceIdentity !== source.identity) return;
        setAnalysisState({ status: 'ready', sourceIdentity, result, bedPlacement });
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
  const alreadyApplied = Boolean(source && recommended && isPrintOrientationRotationApplied(
    source.currentRotationDeg,
    recommended.id
  ));

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
    const sourceTransformStillCurrent = current.transform.scale === source.uniformScale
      && (['x', 'y', 'z'] as const).every((axis) => (
        current.transform.positionMm[axis] === source.currentPositionMm[axis]
        && current.transform.rotationDeg[axis] === source.currentRotationDeg[axis]
      ));
    if (!sourceTransformStillCurrent) {
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
      setApplicationNotice(successNotice);
    } catch (error) {
      pendingPresentationNotice.current = null;
      setBedConfirmationOpen(false);
      setApplicationNotice(`自动落床失败：${errorMessage(error)}`);
    }
  }

  const bedMoveDescription = bedPlacement
    ? bedPlacement.requiredVerticalDeltaMm > 0
      ? `向上移动 ${Math.abs(bedPlacement.requiredVerticalDeltaMm).toFixed(2)} 毫米`
      : `向下移动 ${Math.abs(bedPlacement.requiredVerticalDeltaMm).toFixed(2)} 毫米`
    : '';

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
