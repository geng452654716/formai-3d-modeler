import { useEffect, useRef, useState } from 'react';
import {
  BoxSelect,
  Boxes,
  ChevronDown,
  Download,
  Eye,
  Image,
  History,
  MousePointer2,
  Move3D,
  Plus,
  Redo2,
  RefreshCw,
  Ruler,
  Rotate3D,
  Save,
  Scale3D,
  Undo2,
  Wrench,
  X
} from 'lucide-react';
import { CommandPanel } from './components/CommandPanel';
import { ImageImportDialog } from './components/ImageImportDialog';
import { ManufacturingToolsDialog } from './components/ManufacturingToolsDialog';
import { ModelViewport } from './components/ModelViewport';
import { MeshElementEditPanel } from './components/MeshElementEditPanel';
import { ParameterPanel } from './components/ParameterPanel';
import { SceneTree } from './components/SceneTree';
import { VersionHistoryDialog } from './components/VersionHistoryDialog';
import { generatedDownloadUrl } from './model/cad';
import { getOuterDimensions } from './model/defaults';
import { appendMeshPlanarRegionCodexAnalysisDraft } from './model/meshElementEdit';
import {
  createTransformedExportObject,
  manufacturingSplitPresentationId,
  type TransformedExportRequest
} from './model/objectExport';
import { exportGeneratedFile, exportTransformedModel, isDesktopRuntime } from './platform/backend';
import { useModelStore } from './store/useModelStore';

const splitExportFiles = [
  ['带连接结构的负方向拆件 STL', 'manufacturing-negative.stl'],
  ['带连接结构的正方向拆件 STL', 'manufacturing-positive.stl'],
  ['带连接结构的负方向拆件 STEP', 'manufacturing-negative.step'],
  ['带连接结构的正方向拆件 STEP', 'manufacturing-positive.step']
] as const;

function App() {
  const [exportOpen, setExportOpen] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [manufacturingOpen, setManufacturingOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [commandDraft, setCommandDraft] = useState('');
  const imageInput = useRef<HTMLInputElement>(null);
  const initialParameters = useRef(true);
  const undo = useModelStore((state) => state.undo);
  const redo = useModelStore((state) => state.redo);
  const versionIndex = useModelStore((state) => state.versionIndex);
  const versions = useModelStore((state) => state.versions);
  const versionRestoreStatus = useModelStore((state) => state.versionRestoreStatus);
  const exploded = useModelStore((state) => state.exploded);
  const setExploded = useModelStore((state) => state.setExploded);
  const parameters = useModelStore((state) => state.parameters);
  const cadStatus = useModelStore((state) => state.cadStatus);
  const hydrateCadResult = useModelStore((state) => state.hydrateCadResult);
  const initializeBackend = useModelStore((state) => state.initializeBackend);
  const saveCurrentVersion = useModelStore((state) => state.saveCurrentVersion);
  const generateCad = useModelStore((state) => state.generateCad);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const setViewportModelSource = useModelStore((state) => state.setViewportModelSource);
  const resetProject = useModelStore((state) => state.resetProject);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const cadResult = useModelStore((state) => state.cadResult);
  const selectedObject = useModelStore((state) => state.selectedObject);
  const objectTransformMode = useModelStore((state) => state.objectTransformMode);
  const objectPresentations = useModelStore((state) => state.objectPresentations);
  const setObjectTransformMode = useModelStore((state) => state.setObjectTransformMode);
  const analyzeWallThickness = useModelStore((state) => state.analyzeWallThickness);
  const wallThicknessStatus = useModelStore((state) => state.wallThicknessStatus);
  const wallThicknessResult = useModelStore((state) => state.wallThicknessResult);
  const wallThicknessVisible = useModelStore((state) => state.wallThicknessVisible);
  const setWallThicknessVisible = useModelStore((state) => state.setWallThicknessVisible);
  const wallThicknessPicking = useModelStore((state) => state.wallThicknessPicking);
  const setWallThicknessPicking = useModelStore((state) => state.setWallThicknessPicking);
  const cadFaceSelectionMode = useModelStore((state) => state.cadFaceSelectionMode);
  const cadFaceSelection = useModelStore((state) => state.cadFaceSelection);
  const setCadFaceSelectionMode = useModelStore((state) => state.setCadFaceSelectionMode);
  const clearCadFaceSelection = useModelStore((state) => state.clearCadFaceSelection);
  const versionGeometryComparisonMode = useModelStore((state) => state.versionGeometryComparisonMode);

  /** 保留当前页面已有指令，并去重追加用户主动选择的几何诊断分析请求。 */
  const appendCodexDiagnostic = (summary: string) => {
    setCommandDraft((current) => appendMeshPlanarRegionCodexAnalysisDraft(current, summary).draft);
  };
  const modelExportFiles: Array<readonly [string, string]> = cadResult
    ? [
        ...cadResult.parts.flatMap((part) => [
          [`${part.label} STL`, part.stlFile] as const,
          [`${part.label} STEP`, part.stepFile] as const
        ]),
        ['完整装配 3MF', cadResult.assemblyFile] as const
      ]
    : [];
  const sourceExportFiles: Array<readonly [string, string]> = viewportModelSource === 'uploaded-stl' && importedStlModel
    ? importedStlModel.metrics.repair.repaired
      ? [
          ['原始上传 STL', importedStlModel.originalSourceFile] as const,
          ['修复后工作 STL', importedStlModel.sourceFile] as const
        ]
      : [['上传 STL', importedStlModel.sourceFile] as const]
    : modelExportFiles;
  const availableExportFiles = manufacturingResult
    && manufacturingResult.sourceKind === (viewportModelSource === 'uploaded-stl' ? 'uploaded-stl' : 'cad-part')
    ? [...sourceExportFiles, ...splitExportFiles]
    : sourceExportFiles;
  const selectedCadPart = cadResult?.parts.find((part) => part.id === selectedObject)
    ?? cadResult?.parts.find((part) => part.role === 'primary')
    ?? cadResult?.parts[0]
    ?? null;
  const displayedWallThicknessMatches = wallThicknessResult
    ? viewportModelSource === 'uploaded-stl'
      ? wallThicknessResult.sourceKind === 'uploaded-stl'
      : viewportModelSource === 'cad' && wallThicknessResult.sourcePartId === selectedCadPart?.id
    : false;
  const canAnalyzeWallThickness = viewportModelSource === 'uploaded-stl'
    ? importedStlModel !== null
    : cadResult !== null && cadStatus === 'ready';
  const canSelectCadFaces = Boolean(
    viewportModelSource === 'cad'
    && cadStatus === 'ready'
    && cadResult?.parts.some((part) => part.faceTessellation?.status === 'ok')
    && !manufacturingResult
    && versionGeometryComparisonMode === 'off'
  );

  useEffect(() => {
    void initializeBackend();
    void hydrateCadResult();
  }, [hydrateCadResult, initializeBackend]);

  useEffect(() => {
    if (initialParameters.current) {
      initialParameters.current = false;
      return;
    }
    if (cadStatus !== 'stale') return;
    const timer = window.setTimeout(() => void generateCad(parameters), 700);
    return () => window.clearTimeout(timer);
  }, [cadStatus, generateCad, parameters]);

  const transformedExportRequest = (fileName: string): TransformedExportRequest | null => {
    const lowerName = fileName.toLowerCase();
    if (!lowerName.endsWith('.stl') && !lowerName.endsWith('.3mf')) return null;
    const outputFileName = `${fileName.replace(/\.(stl|3mf)$/i, '')}-视口变换.${lowerName.endsWith('.3mf') ? '3mf' : 'stl'}`;
    if (lowerName.endsWith('.3mf') && cadResult?.assemblyFile === fileName) {
      const coverY = getOuterDimensions(parameters).height - 0.2;
      return {
        outputFileName,
        format: '3mf',
        objects: cadResult.parts.map((part) => createTransformedExportObject(
          part.id,
          part.label,
          part.stlFile,
          objectPresentations[part.id],
          part.role === 'cover' ? '#eeeae1' : '#d9d4c8',
          part.role === 'cover' ? { x: 0, y: coverY, z: 0 } : undefined
        ))
      };
    }
    if (fileName === 'manufacturing-negative.stl' || fileName === 'manufacturing-positive.stl') {
      const positive = fileName.includes('positive');
      const direction = positive ? 'positive' : 'negative';
      const id = manufacturingSplitPresentationId(
        manufacturingResult?.sourceKind ?? 'uploaded-stl',
        manufacturingResult?.sourcePartId ?? 'uploaded-model',
        direction
      );
      return {
        outputFileName,
        format: 'stl',
        objects: [createTransformedExportObject(
          id,
          positive ? '正方向拆件' : '负方向拆件',
          fileName,
          objectPresentations[id],
          positive ? '#e7d4b6' : '#c9d9e8'
        )]
      };
    }
    const cadPart = cadResult?.parts.find((part) => part.stlFile === fileName);
    if (cadPart) {
      return {
        outputFileName,
        format: 'stl',
        objects: [createTransformedExportObject(
          cadPart.id,
          cadPart.label,
          fileName,
          objectPresentations[cadPart.id],
          cadPart.role === 'cover' ? '#eeeae1' : '#d9d4c8'
        )]
      };
    }
    if (importedStlModel && [importedStlModel.sourceFile, importedStlModel.originalSourceFile].includes(fileName)) {
      return {
        outputFileName,
        format: 'stl',
        objects: [createTransformedExportObject(
          importedStlModel.id,
          importedStlModel.name,
          fileName,
          objectPresentations[importedStlModel.id],
          '#d7dde4'
        )]
      };
    }
    return null;
  };

  const handleExport = async (fileName: string) => {
    if (!isDesktopRuntime()) {
      const anchor = document.createElement('a');
      anchor.href = generatedDownloadUrl(fileName);
      anchor.download = fileName;
      anchor.click();
      setExportNotice(fileName.endsWith('.step') ? 'STEP 已按参数化原始坐标导出' : 'Web 预览仅导出原始生成文件');
      setExportOpen(false);
      return;
    }
    try {
      const transformedRequest = transformedExportRequest(fileName);
      const destination = transformedRequest
        ? await exportTransformedModel(transformedRequest)
        : await exportGeneratedFile(fileName);
      const note = fileName.toLowerCase().endsWith('.step')
        ? `STEP 保留参数化原始坐标，已导出到 ${destination}`
        : `已应用视口变换并导出到 ${destination}`;
      setExportNotice(note);
      window.setTimeout(() => setExportNotice(null), 6000);
    } catch (error) {
      setExportNotice(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExportOpen(false);
    }
  };

  const handleWallThickness = async () => {
    if (wallThicknessStatus === 'analyzing') return;
    if (displayedWallThicknessMatches) {
      setWallThicknessVisible(!wallThicknessVisible);
      return;
    }
    if (viewportModelSource === 'uploaded-stl' && importedStlModel) {
      await analyzeWallThickness({
        sourceKind: 'uploaded-stl',
        sourcePartId: importedStlModel.id,
        minimumWallMm: 1.2,
        sampleLimit: 1200
      });
      return;
    }
    if (!selectedCadPart) {
      setExportNotice('没有可分析的精确 CAD 零件，请先重建模型');
      window.setTimeout(() => setExportNotice(null), 4500);
      return;
    }
    await analyzeWallThickness({
      sourceKind: 'cad-part',
      sourcePartId: selectedCadPart.id,
      minimumWallMm: 1.2,
      sampleLimit: 1200
    });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <strong>FormAI</strong>
            <span>AI 三维建模</span>
          </div>
        </div>
        <div className="project-name">
          <span>{viewportModelSource === 'uploaded-stl' ? importedStlModel?.name ?? '上传模型' : cadResult?.model.name ?? '未命名模型'}</span>
          <ChevronDown size={14} />
        </div>
        <div className="topbar-actions">
          <input
            ref={imageInput}
            className="hidden-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            capture="environment"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) setImageFiles(files);
              event.currentTarget.value = '';
            }}
          />
          <button
            className="topbar-text-button"
            onClick={() => {
              if (window.confirm('创建新模型画布会清除当前未导出的版本历史，是否继续？')) {
                resetProject();
                void generateCad();
              }
            }}
          >
            <Plus size={15} /> 新建模型
          </button>
          <button className="topbar-text-button" onClick={() => imageInput.current?.click()}>
            <Image size={15} /> 导入图片
          </button>
          <button className="topbar-text-button" onClick={() => setManufacturingOpen(true)}>
            <Wrench size={15} /> 拆件与连接
          </button>
          <span className="saved-state"><span /> 已保存</span>
          {exportNotice && <span className="export-notice">{exportNotice}</span>}
          <button
            className="toolbar-button"
            title="保存当前版本快照"
            onClick={() => void saveCurrentVersion()}
          >
            <Save size={16} />
          </button>
          <button className="toolbar-button" onClick={() => void undo()} disabled={versionIndex === 0 || versionRestoreStatus === 'restoring'} title="撤销">
            <Undo2 size={16} />
          </button>
          <button
            className="toolbar-button"
            onClick={() => void redo()}
            disabled={versionIndex >= versions.length - 1 || versionRestoreStatus === 'restoring'}
            title="重做"
          >
            <Redo2 size={16} />
          </button>
          <button
            className="toolbar-button"
            onClick={() => void generateCad()}
            disabled={cadStatus === 'generating'}
            title="使用 OpenCascade 重建精确实体"
          >
            <RefreshCw size={16} className={cadStatus === 'generating' ? 'is-spinning' : ''} />
          </button>
          <div className="export-control">
            <button className="export-button" onClick={() => setExportOpen((open) => !open)}>
              <Download size={15} /> 导出 <ChevronDown size={13} />
            </button>
            {exportOpen && (
              <div className="export-menu">
                {availableExportFiles.map(([label, fileName]) => (
                  <button key={fileName} onClick={() => void handleExport(fileName)}>
                    <span>{label}</span>
                    <small>{fileName.endsWith('.step') ? '参数化原始坐标' : fileName.endsWith('.3mf') ? '含对象颜色与视口变换' : '应用视口变换'}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="workspace">
        <SceneTree />
        <section className="viewport-area">
          <div className="viewport-toolbar">
            <button
              className={cadFaceSelectionMode === 'off' && objectTransformMode === 'select' ? 'active' : ''}
              title="普通对象选择"
              onClick={() => {
                setCadFaceSelectionMode('off');
                setObjectTransformMode('select');
              }}
            ><MousePointer2 size={16} /></button>
            <button
              className={objectTransformMode === 'translate' ? 'active' : ''}
              title="使用三维操控器移动当前对象，单位为毫米"
              onClick={() => {
                setCadFaceSelectionMode('off');
                setObjectTransformMode(objectTransformMode === 'translate' ? 'select' : 'translate');
              }}
            ><Move3D size={16} /></button>
            <button
              className={objectTransformMode === 'rotate' ? 'active' : ''}
              title="使用三维操控器旋转当前对象，步进为 1 度"
              onClick={() => {
                setCadFaceSelectionMode('off');
                setObjectTransformMode(objectTransformMode === 'rotate' ? 'select' : 'rotate');
              }}
            ><Rotate3D size={16} /></button>
            <button
              className={objectTransformMode === 'scale' ? 'active' : ''}
              title="使用三维操控器均匀缩放当前对象"
              onClick={() => {
                setCadFaceSelectionMode('off');
                setObjectTransformMode(objectTransformMode === 'scale' ? 'select' : 'scale');
              }}
            ><Scale3D size={16} /></button>
            <span />
            <button
              className={`cad-face-tool-button ${cadFaceSelectionMode === 'click' ? 'active' : ''}`}
              title="点击选择一个稳定 CAD 面，并附带局部截图交给 Codex"
              disabled={!canSelectCadFaces}
              onClick={() => {
                setObjectTransformMode('select');
                setCadFaceSelectionMode(cadFaceSelectionMode === 'click' ? 'off' : 'click');
              }}
            >
              <MousePointer2 size={15} /> 点击选面
            </button>
            <button
              className={`cad-face-tool-button ${cadFaceSelectionMode === 'edge' ? 'active' : ''}`}
              title="点击选择一条种子稳定 CAD 边，用于单边、切线连续边链或平面边界整圈圆角与倒角"
              disabled={!canSelectCadFaces}
              onClick={() => {
                setObjectTransformMode('select');
                setCadFaceSelectionMode(cadFaceSelectionMode === 'edge' ? 'off' : 'edge');
              }}
            >
              <Wrench size={15} /> 点击选边
            </button>
            <button
              className={`cad-face-tool-button ${cadFaceSelectionMode === 'edge-chain' ? 'active' : ''}`}
              title="逐条点击加入或移除稳定 CAD 边，形成一条开放或闭合的手工边链"
              disabled={!canSelectCadFaces}
              onClick={() => {
                setObjectTransformMode('select');
                setCadFaceSelectionMode(cadFaceSelectionMode === 'edge-chain' ? 'off' : 'edge-chain');
              }}
            >
              <Wrench size={15} /> 多选边链
            </button>
            <button
              className={`cad-face-tool-button ${cadFaceSelectionMode === 'box' ? 'active' : ''}`}
              title="拖动框选多个稳定 CAD 面，并附带框选截图交给 Codex"
              disabled={!canSelectCadFaces}
              onClick={() => {
                setObjectTransformMode('select');
                setCadFaceSelectionMode(cadFaceSelectionMode === 'box' ? 'off' : 'box');
              }}
            >
              <BoxSelect size={15} /> 框选区域
            </button>
            {cadFaceSelection && (
              <button className="cad-face-tool-button" title="清除稳定 CAD 面局部选择" onClick={clearCadFaceSelection}>
                <X size={15} /> 清除局部选择
              </button>
            )}
            <button
              className={wallThicknessPicking ? 'active' : ''}
              title={wallThicknessPicking ? '关闭壁厚局部选择' : '在热力图上点击选择局部区域'}
              disabled={!displayedWallThicknessMatches || !wallThicknessVisible}
              onClick={() => setWallThicknessPicking(!wallThicknessPicking)}
            >
              <BoxSelect size={16} />
            </button>
            <div className="view-mode-switch" aria-label="装配显示模式">
              <button
                className={!exploded ? 'active' : ''}
                onClick={() => setExploded(false)}
                title="查看合起来后的最终模型"
              >
                <Boxes size={15} /> 装配视图
              </button>
              <button
                className={exploded ? 'active' : ''}
                onClick={() => setExploded(true)}
                title="分开查看每一个零件"
              >
                <Eye size={15} /> 拆分视图
              </button>
            </div>
            <button
              className={`wall-thickness-button ${displayedWallThicknessMatches && wallThicknessVisible ? 'active' : ''}`}
              onClick={() => void handleWallThickness()}
              disabled={!canAnalyzeWallThickness || wallThicknessStatus === 'analyzing'}
              title={
                wallThicknessStatus === 'analyzing'
                  ? '正在执行全局壁厚采样'
                  : displayedWallThicknessMatches
                    ? wallThicknessVisible ? '关闭壁厚热力图' : '显示壁厚热力图'
                    : '分析当前选中零件的全局壁厚'
              }
            >
              <Ruler size={15} />
              {wallThicknessStatus === 'analyzing'
                ? '分析中'
                : displayedWallThicknessMatches
                  ? wallThicknessVisible ? '关闭热力图' : '显示热力图'
                  : '壁厚分析'}
            </button>
            <button
              className={viewportModelSource !== 'preview' ? 'active' : ''}
              onClick={() => setViewportModelSource(
                viewportModelSource === 'uploaded-stl'
                  ? 'cad'
                  : viewportModelSource === 'cad' ? 'preview' : 'cad'
              )}
              title={
                viewportModelSource === 'uploaded-stl'
                  ? '切换回当前项目 CAD'
                  : viewportModelSource === 'cad' ? '切换到快速参数预览' : '切换到 OpenCascade 精确实体'
              }
            >
              <Boxes size={16} />
            </button>
          </div>
          <div className="viewport-status">
            <span>透视</span>
            <span>毫米</span>
            <span>{viewportModelSource === 'uploaded-stl' ? '上传 STL 实体' : viewportModelSource === 'cad' ? 'OpenCascade 实体' : '快速预览'}</span>
          </div>
          <ModelViewport />
          <MeshElementEditPanel onAppendCodexDiagnostic={appendCodexDiagnostic} />
          <CommandPanel command={commandDraft} onCommandChange={setCommandDraft} />
          <button
            type="button"
            className="history-indicator"
            onClick={() => setVersionHistoryOpen(true)}
            title="查看版本历史与参数差异"
          >
            <History size={13} /> 版本 {versionIndex + 1}/{versions.length}
          </button>
        </section>
        <ParameterPanel />
      </div>
      {imageFiles.length > 0 && <ImageImportDialog files={imageFiles} onClose={() => setImageFiles([])} />}
      {manufacturingOpen && <ManufacturingToolsDialog onClose={() => setManufacturingOpen(false)} />}
      {versionHistoryOpen && <VersionHistoryDialog onClose={() => setVersionHistoryOpen(false)} />}
    </main>
  );
}

export default App;
