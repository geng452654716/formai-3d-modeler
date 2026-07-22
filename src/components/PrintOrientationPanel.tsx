import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, Printer, RotateCcw } from 'lucide-react';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { resolveGeneratedModelUrl } from '../model/cad';
import {
  evaluateAxisAlignedPrintOrientations,
  type PrintOrientationAnalysis
} from '../model/printOrientation';

export interface PrintOrientationSource {
  identity: string;
  fileName: string;
  revision: string;
  label: string;
  buildVolumeMm: [number, number, number];
}

interface PrintOrientationPanelProps {
  source: PrintOrientationSource | null;
  unavailableReason?: string;
}

type AnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: PrintOrientationAnalysis };

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : '打印方向分析失败，请稍后重试';
}

/** 从当前精确 STL 临时读取三角网格并展示六向打印估算，不写回模型或项目状态。 */
export function PrintOrientationPanel({ source, unavailableReason }: PrintOrientationPanelProps) {
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: 'idle' });
  const requestSerial = useRef(0);

  useEffect(() => {
    requestSerial.current += 1;
    setAnalysisState({ status: 'idle' });
    return () => {
      requestSerial.current += 1;
    };
  }, [source?.identity]);

  async function analyze() {
    if (!source) return;
    const serial = ++requestSerial.current;
    setAnalysisState({ status: 'loading' });
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
          overhangAngleDeg: 45
        });
        if (serial !== requestSerial.current) return;
        setAnalysisState({ status: 'ready', result });
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

  const result = analysisState.status === 'ready' ? analysisState.result : null;
  const recommended = result?.candidates.find((candidate) => candidate.id === result.recommendedId) ?? null;

  return (
    <section className="parameter-section print-orientation-section">
      <h3>
        <Printer size={14} /> 六向打印方向评估
      </h3>
      <p className="print-orientation-note">
        对精确封闭网格比较 X、Y、Z 正负六个朝上方向；按 P1S 成型空间、打印高度、底面接触和 45° 悬垂面积给出只读建议。
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
      {result && (
        <div className="print-orientation-result">
          <div className={`print-orientation-recommendation ${recommended ? 'available' : 'unavailable'}`}>
            {recommended ? <CheckCircle2 size={15} /> : <Printer size={15} />}
            <div>
              <strong>{recommended ? `推荐：${recommended.label}` : '当前六向候选均不可打印'}</strong>
              <span>{result.recommendedReason}</span>
            </div>
          </div>
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
            已分析“{source?.label}”的 {result.triangleCount.toLocaleString()} 个有效三角面。该结果是轴向几何估算，不等同于切片器生成的真实支撑、耗材或打印时间。
          </small>
        </div>
      )}
    </section>
  );
}
