import { FormEvent, KeyboardEvent } from 'react';
import { Bot, CornerDownLeft, MapPin, Sparkles, X } from 'lucide-react';
import { describeCadEdgeGeometryType, describeCadSurfaceGeometryType } from '../model/localCadFeature';
import { WALL_THICKNESS_LABELS } from '../model/wallThickness';
import { useModelStore } from '../store/useModelStore';

const cadSuggestions = ['圆角改成 6 毫米', '壁厚设为 2.4 毫米', 'USB 开孔宽度改成 12 毫米'];
const cadFaceSuggestions = [
  '在这里增加直径 8 毫米、高 2 毫米的圆形凸台',
  '在这里开一个直径 4 毫米、深 6 毫米的圆孔',
  '在这里增加宽 10 毫米、高 6 毫米、凸出 2 毫米的矩形凸台',
  '在这里开长 14 毫米、宽 5 毫米、深 4 毫米的槽孔',
  '将整个面向外拉伸 2 毫米',
  '将整个面向内偏移 1 毫米'
];
const cadCurvedFaceSuggestions = [
  '在这里增加直径 4 毫米、高 2 毫米的圆形凸台',
  '在这里开一个直径 3 毫米、深 4 毫米的圆孔',
  '在这里增加宽 5 毫米、高 3 毫米、凸出 2 毫米的矩形凸台，旋转 10 度',
  '在这里开一个宽 4 毫米、高 3 毫米、深 4 毫米的矩形孔，旋转 15 度',
  '在这里开一个宽 3 毫米、长 6 毫米、深 4 毫米、旋转 20 度的槽孔'
];
const cadEdgeSuggestions = ['将这条边做 2 毫米圆角', '将这条边做 1 毫米倒角'];
const cadManualEdgeChainSuggestions = ['将这些边做 2 毫米圆角', '将这些边做 1 毫米倒角'];
const uploadedStlSuggestions = ['这里增加一个直径 8 毫米、高 2 毫米的凸台', '这里开一个直径 4 毫米、深 6 毫米的孔'];

interface CommandPanelProps {
  command: string;
  onCommandChange: (command: string) => void;
}

/** 展示当前页面的临时建模指令草稿；只有用户提交表单时才执行指令。 */
export function CommandPanel({ command, onCommandChange }: CommandPanelProps) {
  const messages = useModelStore((state) => state.messages);
  const executeCommand = useModelStore((state) => state.executeCommand);
  const aiStatus = useModelStore((state) => state.aiStatus);
  const aiActivity = useModelStore((state) => state.aiActivity);
  const backendStatus = useModelStore((state) => state.backendStatus);
  const wallThicknessSelection = useModelStore((state) => state.wallThicknessSelection);
  const cadFaceSelection = useModelStore((state) => state.cadFaceSelection);
  const clearCadFaceSelection = useModelStore((state) => state.clearCadFaceSelection);
  const clearWallThicknessSelection = useModelStore((state) => state.clearWallThicknessSelection);
  const uploadedRegionSelected = wallThicknessSelection?.sourceKind === 'uploaded-stl';
  const suggestions = cadFaceSelection
    ? cadFaceSelection.selectionMode === 'edge-chain'
      ? cadManualEdgeChainSuggestions
      : cadFaceSelection.selectionMode === 'edge'
      ? cadEdgeSuggestions
      : cadFaceSelection.faces[0]?.geometryType !== 'PLANE'
        ? cadCurvedFaceSuggestions
        : cadFaceSuggestions
    : uploadedRegionSelected ? uploadedStlSuggestions : cadSuggestions;
  const cadHit = cadFaceSelection?.hit;
  const manualEdgeTargets = cadFaceSelection?.selectionMode === 'edge-chain'
    ? cadFaceSelection.edgeSelections ?? []
    : [];
  const manualEdgeResolvingCount = manualEdgeTargets.filter((target) => target.hit.resolutionStatus === 'resolving').length;
  const manualEdgeFailedCount = manualEdgeTargets.filter((target) => target.hit.resolutionStatus === 'failed').length;
  const manualEdgeFaceCount = new Set(manualEdgeTargets.map((target) => target.face.stableId)).size;
  const cadHitResolutionText = cadHit?.resolutionStatus === 'resolving'
    ? '正在用 OpenCascade 解析真实曲面 UV 和外法线……'
    : cadHit?.resolutionStatus === 'resolved' && cadHit.surfaceUv
      ? `OpenCascade 精确命中 · UV（${cadHit.surfaceUv.u.toFixed(6)}，${cadHit.surfaceUv.v.toFixed(6)}）· 投影距离 ${cadHit.pointDistanceMm?.toFixed(4) ?? '未知'} 毫米。`
      : cadHit?.resolutionStatus === 'failed'
        ? `精确解析失败：${cadHit.resolutionError ?? '未知错误'}。当前仅保留选择网格预览，不会生成伪造 UV。`
        : '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed) return;
    void executeCommand(trimmed);
    onCommandChange('');
  };

  const submitWithShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const badge = aiStatus === 'running'
    ? (aiActivity ?? '正在执行建模任务')
    : backendStatus?.codexAuthenticated
      ? `Codex 已连接${backendStatus.codexVersion ? ` · ${backendStatus.codexVersion}` : ''}`
      : backendStatus?.mode === 'tauri' && !backendStatus.cadWorkerAvailable
        ? 'CAD 运行环境未就绪'
        : '本地规则模式';

  return (
    <section className="command-panel panel">
      <div className="command-title">
        <div>
          <Bot size={17} />
          <span>Codex 建模指令</span>
        </div>
        <span className={`local-badge ai-${aiStatus}`}>{badge}</span>
      </div>
      <div className="message-list">
        {messages.slice(-3).map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.role === 'assistant' && <Sparkles size={13} />}
            <span>{message.content}</span>
          </div>
        ))}
      </div>
      {cadFaceSelection && (
        <div className="command-region-context cad-face-context">
          <MapPin size={13} />
          <div>
            <strong>
              {cadFaceSelection.selectionMode === 'click'
                ? `已选择 ${cadFaceSelection.faces[0]?.partLabel ?? '零件'}的 1 个稳定 CAD 面`
                : cadFaceSelection.selectionMode === 'edge'
                  ? `已选择 ${cadFaceSelection.edge?.partLabel ?? '零件'}的 1 条种子稳定 CAD 边`
                  : cadFaceSelection.selectionMode === 'edge-chain'
                    ? `已选择 ${manualEdgeTargets[0]?.edge.partLabel ?? '零件'}的 ${manualEdgeTargets.length} 条手工边，分布在 ${manualEdgeFaceCount} 个稳定面`
                    : `已框选 ${cadFaceSelection.faces.length} 个稳定 CAD 面，涉及 ${new Set(cadFaceSelection.faces.map((face) => face.partId)).size} 个零件`}
            </strong>
            <span>
              {cadFaceSelection.selectionMode === 'edge-chain'
                ? `逐条点击可加入或移除；${manualEdgeResolvingCount ? `正在精确解析 ${manualEdgeResolvingCount} 条，` : ''}${manualEdgeFailedCount ? `${manualEdgeFailedCount} 条解析失败，` : ''}${manualEdgeTargets.length < 2 ? '至少选择 2 条后才能执行。' : manualEdgeResolvingCount || manualEdgeFailedCount ? '全部完成 OpenCascade 精确解析后才能执行。' : '已具备执行条件，OpenCascade 将检查连续性并拒绝不连续、分叉或重复物理边。'}`
                : cadFaceSelection.hit
                ? cadFaceSelection.edge
                  ? `${cadFaceSelection.edge.stableEdgeId} · ${describeCadSurfaceGeometryType(cadFaceSelection.faces[0]?.geometryType ?? '')}所属${describeCadEdgeGeometryType(cadFaceSelection.edge.geometryType)} · 长度 ${cadFaceSelection.edge.lengthMm.toFixed(2)} 毫米 · 点击坐标 ${cadFaceSelection.hit.pointMm.x.toFixed(2)}，${cadFaceSelection.hit.pointMm.y.toFixed(2)}，${cadFaceSelection.hit.pointMm.z.toFixed(2)} 毫米。`
                  : `${cadFaceSelection.hit.stableId} · ${describeCadSurfaceGeometryType(cadFaceSelection.faces[0]?.geometryType ?? '')} · 点击坐标 ${cadFaceSelection.hit.pointMm.x.toFixed(2)}，${cadFaceSelection.hit.pointMm.y.toFixed(2)}，${cadFaceSelection.hit.pointMm.z.toFixed(2)} 毫米。`
                : `稳定面：${cadFaceSelection.faces.slice(0, 3).map((face) => face.stableId).join('、')}${cadFaceSelection.faces.length > 3 ? '…' : ''}。`}
              {cadFaceSelection.selectionMode !== 'edge-chain' && cadHitResolutionText && ` ${cadHitResolutionText}`}
              {cadFaceSelection.selectionMode === 'edge-chain'
                ? ' 可输入“将这些边做 2 毫米圆角”或“将这些边做 1 毫米倒角”；当前仅支持固定尺寸的开放链或闭合链，不支持分叉链、可变半径和连续性等级控制。'
                : cadFaceSelection.selectionMode === 'edge'
                ? cadFaceSelection.faces[0]?.geometryType === 'PLANE'
                  ? ' 精确解析完成后可输入“将这条边做 2 毫米圆角”“沿切线链做 2 毫米圆角”或“将这圈边做 2 毫米圆角”；Worker 会重新定位种子稳定边并复核点击距离与外法线。切线链第一版只传播到两端唯一且夹角不超过 5 度的连续边，整圈第一版只传播到种子边所属的唯一平面边界；修改后需要重新选择。'
                  : ` 精确解析完成后可对这条曲面所属边执行固定半径单边或切线连续边链圆角/倒角；Worker 会再次用 OpenCascade 重新定位稳定面和种子边，并复核真实 UV 点、点击距离与真实外法线。曲面所属边不支持整圈，切线链只传播到两端唯一且夹角不超过 5 度的连续边；修改后需要重新选择。`
                : cadFaceSelection.selectionMode === 'click' && cadFaceSelection.faces.length === 1 && cadFaceSelection.faces[0]?.geometryType === 'PLANE'
                ? ' 精确解析完成后可在此平面执行圆形或矩形凸台、圆孔、矩形孔、槽孔，以及整面向外拉伸或向内偏移；修改后需要重新选择，因为原三角面索引会失效。'
                : cadFaceSelection.selectionMode === 'click'
                  ? ' 精确解析完成后可沿真实法线生成受限圆形、矩形或槽孔特征；矩形和槽孔是在真实 UV 点击位置建立的切平面安全近似，不是任意曲面贴合或测地线轮廓。整面偏移仍未实现；如需圆角或倒角，请切换“点击选边”并点击目标边界。修改后需要重新选择。'
                  : ' 框选多面作为 AI 局部范围上下文，不执行局部布尔；下一条指令仍会附带局部截图、零件尺寸与摄像机上下文。'}
            </span>
          </div>
          <button onClick={clearCadFaceSelection} title={cadFaceSelection.selectionMode === 'edge' || cadFaceSelection.selectionMode === 'edge-chain' ? '清除稳定 CAD 边选择' : '清除稳定 CAD 面选择'}><X size={12} /></button>
        </div>
      )}
      {wallThicknessSelection && (
        <div className="command-region-context">
          <MapPin size={13} />
          <div>
            <strong>
              已选择{WALL_THICKNESS_LABELS[wallThicknessSelection.sample.severity]}区域 · {wallThicknessSelection.sample.thicknessMm.toFixed(2)} 毫米
            </strong>
            <span>
              坐标 {wallThicknessSelection.sample.xMm.toFixed(2)}，{wallThicknessSelection.sample.yMm.toFixed(2)}，{wallThicknessSelection.sample.zMm.toFixed(2)} 毫米；{uploadedRegionSelected ? '可执行圆形凸台加厚或圆孔切除。' : '下一条指令会携带此局部上下文。'}
            </span>
          </div>
          <button onClick={clearWallThicknessSelection} title="清除局部选择"><X size={12} /></button>
        </div>
      )}
      <div className="suggestions">
        {suggestions.map((suggestion) => (
          <button key={suggestion} onClick={() => onCommandChange(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="command-form">
        <textarea
          value={command}
          onChange={(event) => onCommandChange(event.target.value)}
          onKeyDown={submitWithShortcut}
          placeholder={cadFaceSelection
            ? cadFaceSelection.selectionMode === 'edge-chain'
              ? '例如：将这些边做 2 毫米圆角'
              : cadFaceSelection.selectionMode === 'edge'
              ? '例如：将这条边做 2 毫米圆角'
              : cadFaceSelection.faces[0]?.geometryType !== 'PLANE'
                ? '例如：在这里开一个直径 3 毫米、深 4 毫米的圆孔'
                : '例如：在这里开长 14 毫米、宽 5 毫米、深 4 毫米的槽孔'
            : uploadedRegionSelected ? '例如：这里增加直径 8 毫米、高 2 毫米的凸台' : '例如：圆角改成 5 毫米，壁厚设置为 2.2 毫米'}
          disabled={aiStatus === 'running'}
          aria-label="建模指令草稿"
        />
        <button type="submit" aria-label="执行建模指令" disabled={aiStatus === 'running'}>
          <CornerDownLeft size={16} />
        </button>
      </form>
    </section>
  );
}
