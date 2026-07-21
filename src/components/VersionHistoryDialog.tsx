import { ArrowRight, CheckCircle2, HardDrive, History, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { compareModelVersions } from '../model/versionComparison';
import { captureVersionCurvedFeatures } from '../model/versionCurvedFeatures';
import { createLocalCadFeatureAdjustment } from '../model/localCadFeature';
import {
  compareLocalCadFeaturePreflights,
  findPreviousComparableLocalCadFeaturePreflight,
  type LocalCadFeaturePreflightRecord
} from '../model/localCadFeaturePreflightHistory';
import type { ModelVersion } from '../model/types';
import { useModelStore } from '../store/useModelStore';

interface VersionHistoryDialogProps {
  onClose: () => void;
}

const changeTypeLabels = {
  added: '新增开孔',
  removed: '删除开孔',
  modified: '修改开孔'
} as const;

const curvedFeatureChangeTypeLabels = {
  added: '新增特征',
  removed: '删除特征',
  modified: '诊断已变化'
} as const;

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function formatMillimeters(value: number) {
  const normalized = Math.abs(value) < 1e-6 ? 0 : value;
  return `${Number(normalized.toFixed(4))} 毫米`;
}

function chooseInitialBaseVersion(versions: ModelVersion[], currentIndex: number) {
  if (currentIndex > 0) return versions[currentIndex - 1]?.id ?? versions[currentIndex]?.id ?? '';
  return versions[currentIndex + 1]?.id ?? versions[currentIndex]?.id ?? '';
}

function describePreflightOperation(record: LocalCadFeaturePreflightRecord) {
  return ({
    'add-cylinder': '圆形凸台',
    'cut-cylinder': '圆孔',
    'add-rectangle': '矩形凸台',
    'cut-rectangle': '矩形孔',
    'cut-slot': '槽孔',
    'offset-face-outward': '整面向外拉伸',
    'offset-face-inward': '整面向内偏移',
    'fillet-edge': '圆角',
    'chamfer-edge': '倒角'
  } as const)[record.request.operation];
}

function describePreflightParameters(record: LocalCadFeaturePreflightRecord) {
  const adjustment = createLocalCadFeatureAdjustment(record.request);
  return [
    adjustment.diameterMm !== null ? `直径 ${adjustment.diameterMm} 毫米` : null,
    adjustment.widthMm !== null ? `宽 ${adjustment.widthMm} 毫米` : null,
    adjustment.heightMm !== null ? `高 ${adjustment.heightMm} 毫米` : null,
    adjustment.lengthMm !== null ? `长 ${adjustment.lengthMm} 毫米` : null,
    `深度或高度 ${adjustment.depthMm} 毫米`,
    adjustment.rotationDeg !== 0 ? `旋转 ${adjustment.rotationDeg} 度` : null
  ].filter(Boolean).join(' · ');
}

export function VersionHistoryDialog({ onClose }: VersionHistoryDialogProps) {
  const versions = useModelStore((state) => state.versions);
  const versionIndex = useModelStore((state) => state.versionIndex);
  const parameters = useModelStore((state) => state.parameters);
  const interfaceOpenings = useModelStore((state) => state.interfaceOpenings);
  const restoreVersion = useModelStore((state) => state.restoreVersion);
  const cadStatus = useModelStore((state) => state.cadStatus);
  const cadResult = useModelStore((state) => state.cadResult);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const versionGeometryComparisonStatus = useModelStore(
    (state) => state.versionGeometryComparisonStatus
  );
  const versionGeometryComparisonError = useModelStore(
    (state) => state.versionGeometryComparisonError
  );
  const openVersionGeometryComparison = useModelStore(
    (state) => state.openVersionGeometryComparison
  );
  const preflightHistory = useModelStore((state) => state.localCadFeaturePreflightHistory);
  const clearPreflightHistory = useModelStore((state) => state.clearLocalCadFeaturePreflightHistory);
  const [selectedVersionId, setSelectedVersionId] = useState(() => (
    chooseInitialBaseVersion(versions, versionIndex)
  ));

  const currentVersion = versions[versionIndex];
  const baseVersion = versions.find((version) => version.id === selectedVersionId)
    ?? versions[versionIndex > 0 ? versionIndex - 1 : versionIndex + 1]
    ?? currentVersion;
  const liveCurrentVersion = useMemo<ModelVersion>(() => ({
    ...currentVersion,
    parameters: { ...parameters },
    interfaceOpenings: interfaceOpenings?.map((opening) => ({ ...opening })) ?? interfaceOpenings,
    curvedFeatures: captureVersionCurvedFeatures(cadResult)
  }), [cadResult, currentVersion, interfaceOpenings, parameters]);
  const comparison = useMemo(
    () => compareModelVersions(baseVersion, liveCurrentVersion),
    [baseVersion, liveCurrentVersion]
  );

  const handleRestore = () => {
    if (baseVersion.id === currentVersion.id) return;
    const confirmed = window.confirm(
      `恢复到“${baseVersion.label}”吗？恢复后会自动重建 CAD；如果继续修改，将从该版本创建新的历史分支。`
    );
    if (!confirmed) return;
    restoreVersion(baseVersion.id);
    onClose();
  };

  const canCompareGeometry = baseVersion.id !== currentVersion.id
    && Boolean(baseVersion.snapshotDirectory)
    && viewportModelSource === 'cad'
    && cadStatus === 'ready'
    && cadResult !== null;
  const geometryUnavailableReason = baseVersion.id === currentVersion.id
    ? '请选择另一个历史版本作为基准。'
    : !baseVersion.snapshotDirectory
      ? '该版本没有本机精确快照，无法加载旧实体。'
      : viewportModelSource !== 'cad'
        ? '请先切换回精确 CAD 视图。'
        : cadStatus !== 'ready' || !cadResult
          ? '当前精确 CAD 尚未完成重建，请等待实体校验通过。'
          : null;
  const handleGeometryComparison = async (mode: 'overlay' | 'side-by-side' | 'difference') => {
    const opened = await openVersionGeometryComparison(baseVersion.id, mode);
    if (opened) onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card version-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-history-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <History size={18} />
            <div>
              <strong id="version-history-title">版本历史与对比</strong>
              <span>恢复参数化版本，查看参数与通用开孔元数据变化</span>
            </div>
          </div>
          <button onClick={onClose} title="关闭"><X size={17} /></button>
        </header>

        <div className="version-history-layout">
          <aside className="version-list-panel">
            <div className="version-section-heading">
              <div>
                <strong>历史版本</strong>
                <span>共 {versions.length} 个记录</span>
              </div>
              <small>选择一个版本作为对比基准</small>
            </div>
            <div className="version-list" role="list">
              {[...versions].reverse().map((version) => {
                const originalIndex = versions.findIndex((candidate) => candidate.id === version.id);
                const isCurrent = originalIndex === versionIndex;
                const isSelected = version.id === baseVersion.id;
                return (
                  <button
                    type="button"
                    className={`version-list-item ${isSelected ? 'is-selected' : ''}`}
                    key={version.id}
                    onClick={() => setSelectedVersionId(version.id)}
                    aria-pressed={isSelected}
                  >
                    <span className="version-number">版本 {originalIndex + 1}</span>
                    <span className="version-list-content">
                      <strong>{version.label}</strong>
                      <small>{formatDate(version.createdAt)}</small>
                      <small className={version.snapshotDirectory ? 'has-snapshot' : ''}>
                        {version.snapshotDirectory
                          ? <><HardDrive size={11} /> 已保存本机精确快照</>
                          : '仅保存参数与开孔记录'}
                      </small>
                    </span>
                    {isCurrent && <b><CheckCircle2 size={12} /> 当前</b>}
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="version-comparison-panel">
            <div className="version-comparison-summary">
              <div>
                <span>对比基准</span>
                <strong>{baseVersion.label}</strong>
              </div>
              <ArrowRight size={16} />
              <div>
                <span>当前版本</span>
                <strong>{currentVersion.label}</strong>
              </div>
              <button
                type="button"
                className="secondary-modal-button compact"
                disabled={baseVersion.id === currentVersion.id}
                onClick={handleRestore}
              >
                <RotateCcw size={14} /> 恢复此版本
              </button>
            </div>

            <p className="version-comparison-note">
              当前参数和通用开孔元数据对比用于解释设计意图；标有“本机精确快照”的版本还可加载已保存 STL，
              或使用 OpenCascade 对历史与当前 STEP 实体执行精确布尔差集。
            </p>

            <details className="preflight-history-section">
              <summary>
                <div>
                  <strong>精确预检记录</strong>
                  <span>共 {preflightHistory.length} 条，通过和阻断尝试都独立留档</span>
                </div>
                {preflightHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (window.confirm('清空全部精确预检记录吗？模型版本和当前 CAD 不会受影响。')) {
                        clearPreflightHistory();
                      }
                    }}
                  >
                    清空记录
                  </button>
                )}
              </summary>
              <div className="preflight-history-list">
                {[...preflightHistory].reverse().map((record) => {
                  const previousRecord = findPreviousComparableLocalCadFeaturePreflight(
                    preflightHistory,
                    record
                  );
                  const recordComparison = previousRecord
                    ? compareLocalCadFeaturePreflights(previousRecord, record)
                    : null;
                  const comparisonFields = recordComparison
                    ? [...recordComparison.parameterDifferences, ...recordComparison.diagnosticDifferences]
                    : [];
                  return (
                    <article className={`is-${record.outcome}`} key={record.id}>
                      <div className="preflight-history-title">
                        <div>
                          <strong>{describePreflightOperation(record)}</strong>
                          <span>{formatDate(record.createdAt)} · 零件 {record.request.partId} · 稳定面 {record.request.stableFaceId}</span>
                        </div>
                        <b>{record.outcome === 'passed' ? '预检通过' : '已阻断'}</b>
                      </div>
                      <p>{describePreflightParameters(record)}</p>
                      <dl>
                        <div><dt>工具体积</dt><dd>{record.result.validation.toolVolumeMm3.toFixed(2)} 立方毫米</dd></div>
                        <div><dt>干涉稳定面</dt><dd>{record.result.validation.interferingStableFaceIds.join('、') || '无'}</dd></div>
                        <div><dt>最近干涉距离</dt><dd>{record.result.validation.minimumInterferenceDistanceMm?.toFixed(3) ?? '未知'} 毫米</dd></div>
                        <div><dt>正式执行</dt><dd>{record.executedRevision ? `已关联修订 ${record.executedRevision}` : '未写入模型'}</dd></div>
                      </dl>
                      {recordComparison && (
                        <details className="preflight-record-comparison">
                          <summary>
                            {recordComparison.becamePassed ? '修改后已从阻断变为通过' : `与同目标上一次预检比较（${comparisonFields.length} 项变化）`}
                          </summary>
                          <div>
                            {comparisonFields.map((difference) => (
                              <span key={difference.field}>
                                <small>{difference.label}</small>
                                <b>{difference.before} → {difference.after}</b>
                              </span>
                            ))}
                            {(recordComparison.removedInterferingStableFaceIds.length > 0 || recordComparison.addedInterferingStableFaceIds.length > 0) && (
                              <span>
                                <small>干涉稳定面变化</small>
                                <b>移除 {recordComparison.removedInterferingStableFaceIds.join('、') || '无'}；新增 {recordComparison.addedInterferingStableFaceIds.join('、') || '无'}</b>
                              </span>
                            )}
                            {comparisonFields.length === 0 && <small>参数和结构化诊断没有变化。</small>}
                          </div>
                        </details>
                      )}
                    </article>
                  );
                })}
                {preflightHistory.length === 0 && <p className="version-section-empty">还没有精确工具体预检记录。</p>}
              </div>
            </details>

            <section className="version-geometry-entry">
              <div>
                <strong>精确实体视觉对比</strong>
                <span>蓝色为基准版本，橙色为当前版本；保持毫米制坐标。</span>
              </div>
              <div className="version-geometry-entry-actions">
                <button
                  type="button"
                  disabled={!canCompareGeometry || versionGeometryComparisonStatus === 'loading'}
                  onClick={() => void handleGeometryComparison('overlay')}
                >
                  {versionGeometryComparisonStatus === 'loading' ? '正在加载旧实体…' : '半透明重叠'}
                </button>
                <button
                  type="button"
                  disabled={!canCompareGeometry || versionGeometryComparisonStatus === 'loading'}
                  onClick={() => void handleGeometryComparison('side-by-side')}
                >
                  并排对比
                </button>
                <button
                  type="button"
                  className="is-primary"
                  disabled={!canCompareGeometry || versionGeometryComparisonStatus === 'loading'}
                  onClick={() => void handleGeometryComparison('difference')}
                >
                  {versionGeometryComparisonStatus === 'loading' ? '正在计算精确差异…' : '计算精确差异'}
                </button>
              </div>
              {geometryUnavailableReason && <small>{geometryUnavailableReason}</small>}
              {versionGeometryComparisonStatus === 'error' && versionGeometryComparisonError && (
                <small className="is-error">精确实体处理失败：{versionGeometryComparisonError}</small>
              )}
              <small>精确差异按通用零件 ID 匹配 STEP 实体；绿色表示新增区域，红色表示删除区域。</small>
              {cadResult?.faceMatching ? (
                <small>
                  当前模型已记录 {cadResult.faceMatching.currentFaceCount} 个面几何签名；本次重建继承 {cadResult.faceMatching.inheritedFaceCount} 个稳定 ID，新增 {cadResult.faceMatching.newFaceCount} 个。该编号是近似匹配第一版，不保证任意拓扑修改下永久稳定。
                </small>
              ) : (
                <small>当前模型尚未生成面几何签名，完成一次精确 CAD 重建后即可记录。</small>
              )}
            </section>

            {!comparison.hasDifferences ? (
              <div className="version-no-difference">
                <CheckCircle2 size={18} />
                <div>
                  <strong>没有检测到差异</strong>
                  <span>所选基准与当前模型的参数、通用开孔和曲面局部特征记录一致。</span>
                </div>
              </div>
            ) : (
              <div className="version-difference-content">
                <section className="version-difference-section">
                  <div className="version-section-heading">
                    <div>
                      <strong>参数变化</strong>
                      <span>{comparison.parameterDifferences.length} 项</span>
                    </div>
                  </div>
                  {comparison.parameterDifferences.length > 0 ? (
                    <div className="parameter-difference-table">
                      <div className="parameter-difference-header">
                        <span>参数</span><span>基准值</span><span>当前值</span><span>变化量</span>
                      </div>
                      {comparison.parameterDifferences.map((difference) => (
                        <div className="parameter-difference-row" key={difference.key}>
                          <strong>{difference.label}</strong>
                          <span>{formatMillimeters(difference.before)}</span>
                          <span>{formatMillimeters(difference.after)}</span>
                          <b className={difference.delta > 0 ? 'is-increase' : 'is-decrease'}>
                            {difference.delta > 0 ? '+' : ''}{formatMillimeters(difference.delta)}
                          </b>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="version-section-empty">参数没有变化。</p>
                  )}
                </section>

                <section className="version-difference-section">
                  <div className="version-section-heading">
                    <div>
                      <strong>通用开孔变化</strong>
                      <span>{comparison.openingDifferences.length} 个开孔记录</span>
                    </div>
                  </div>
                  {comparison.openingModeDifference && (
                    <div className="opening-mode-difference">
                      <strong>开孔模式</strong>
                      <span>{comparison.openingModeDifference.before}</span>
                      <ArrowRight size={13} />
                      <span>{comparison.openingModeDifference.after}</span>
                    </div>
                  )}
                  {comparison.openingDifferences.length > 0 ? (
                    <div className="opening-difference-list">
                      {comparison.openingDifferences.map((difference) => (
                        <article
                          className={`opening-difference-card is-${difference.changeType}`}
                          key={`${difference.changeType}-${difference.id}`}
                        >
                          <div className="opening-difference-title">
                            <div>
                              <strong>{difference.label}</strong>
                              <span>编号：{difference.id}</span>
                            </div>
                            <b>{changeTypeLabels[difference.changeType]}</b>
                          </div>
                          {difference.changeType === 'modified' && (
                            <p>变化字段：{difference.changedFields.join('、')}</p>
                          )}
                          {difference.fields.length > 0 && (
                            <>
                              <dl>
                                {difference.fields.map((field) => (
                                  <div key={field.field}>
                                    <dt>{field.label}</dt>
                                    <dd>{field.before} <ArrowRight size={11} /> {field.after}</dd>
                                  </div>
                                ))}
                              </dl>
                            </>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : !comparison.openingModeDifference ? (
                    <p className="version-section-empty">通用开孔记录没有变化。</p>
                  ) : null}
                </section>

                <section className="version-difference-section">
                  <div className="version-section-heading">
                    <div>
                      <strong>曲面局部特征变化</strong>
                      <span>{comparison.curvedFeatureDifferences.length} 个特征记录</span>
                    </div>
                  </div>
                  {comparison.curvedFeatureDifferences.length > 0 ? (
                    <div className="curved-feature-difference-list">
                      {comparison.curvedFeatureDifferences.map((difference) => (
                        <article
                          className={`curved-feature-difference-card is-${difference.changeType}`}
                          key={`${difference.changeType}-${difference.id}`}
                        >
                          <div className="curved-feature-difference-title">
                            <div>
                              <strong>{difference.label}</strong>
                              <span>零件：{difference.partId} · 稳定面：{difference.stableFaceId}</span>
                            </div>
                            <b>{curvedFeatureChangeTypeLabels[difference.changeType]}</b>
                          </div>
                          {difference.changeType === 'modified' && (
                            <p>变化字段：{difference.changedFields.join('、')}</p>
                          )}
                          <dl>
                            {difference.fields.map((field) => (
                              <div key={field.field}>
                                <dt>{field.label}</dt>
                                <dd>{field.before} <ArrowRight size={11} /> {field.after}</dd>
                              </div>
                            ))}
                          </dl>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="version-section-empty">曲面局部特征记录没有变化。</p>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
