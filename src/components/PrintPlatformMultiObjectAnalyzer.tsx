import { useEffect, useMemo } from 'react';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { resolveGeneratedModelUrl } from '../model/cad';
import { getOuterDimensions } from '../model/defaults';
import { normalizeObjectPresentation, type ObjectVector3 } from '../model/objectTransform';
import {
  createPrintPlatformMultiObjectPreview,
  createPrintPlatformMultiObjectSourceIdentity,
  type PrintPlatformObjectFootprintCandidate,
  type PrintPlatformObjectSourceKind
} from '../model/printPlatformMultiObject';
import {
  evaluatePrintPlatformBoundary,
  type PrintBedNormalizationSpace
} from '../model/printOrientation';
import { useModelStore } from '../store/useModelStore';

interface GeometryFootprintSource {
  sourceIdentity: string;
  objectId: string;
  objectLabel: string;
  sourceKind: Exclude<PrintPlatformObjectSourceKind, 'reference'>;
  fileName: string;
  revision: string;
  visible: boolean;
  rotationDeg: ObjectVector3;
  positionMm: ObjectVector3;
  uniformScale: number;
  normalizationSpace: PrintBedNormalizationSpace;
  basePositionDisplayMm: ObjectVector3;
}

function vectorIdentity(value: ObjectVector3) {
  return `${value.x},${value.y},${value.z}`;
}

function geometrySourceIdentity(source: Omit<GeometryFootprintSource, 'sourceIdentity'>) {
  return [
    source.sourceKind,
    source.revision,
    source.fileName,
    source.objectId,
    `位置-${vectorIdentity(source.positionMm)}`,
    `旋转-${vectorIdentity(source.rotationDeg)}`,
    `缩放-${source.uniformScale}`,
    `基础位置-${vectorIdentity(source.basePositionDisplayMm)}`,
    `归一化-${source.normalizationSpace}`,
    source.visible ? '可见' : '隐藏'
  ].join(':');
}

function withIdentity(source: Omit<GeometryFootprintSource, 'sourceIdentity'>): GeometryFootprintSource {
  return { ...source, sourceIdentity: geometrySourceIdentity(source) };
}

/**
 * 当单对象平台分析仍有效时，后台读取当前装配中的全部可打印精确 STL，
 * 只派生联合占地并写入独立只读预览，不触碰对象变换或版本链。
 */
export function PrintPlatformMultiObjectAnalyzer() {
  const overlay = useModelStore((state) => state.printPlatformOverlay);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const cadResult = useModelStore((state) => state.cadResult);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const objectPresentations = useModelStore((state) => state.objectPresentations);
  const parameters = useModelStore((state) => state.parameters);
  const showBoard = useModelStore((state) => state.showBoard);

  const sources = useMemo(() => {
    const result: GeometryFootprintSource[] = [];
    if (viewportModelSource === 'cad' && cadResult) {
      const assembledCoverY = getOuterDimensions(parameters).height - 0.2;
      cadResult.parts.forEach((part) => {
        const fallbackColor = part.role === 'cover' ? '#eeeae1' : '#d9d4c8';
        const transform = normalizeObjectPresentation(
          objectPresentations[part.id],
          fallbackColor
        ).transform;
        const basePositionDisplayMm = {
          x: 0,
          y: part.role === 'cover' ? assembledCoverY : 0,
          z: 0
        };
        if (
          manufacturingResult?.sourceKind === 'cad-part'
          && manufacturingResult.sourcePartId === part.id
        ) {
          ([-1, 1] as const).forEach((direction) => {
            const suffix = direction < 0 ? 'negative' : 'positive';
            const objectId = `${part.id}-${suffix}`;
            const directionLabel = direction < 0 ? '负方向拆件' : '正方向拆件';
            const splitTransform = normalizeObjectPresentation(
              objectPresentations[objectId] ?? objectPresentations[part.id],
              direction < 0 ? '#c9d9e8' : '#e7d4b6'
            ).transform;
            result.push(withIdentity({
              objectId,
              objectLabel: `${part.label}（${directionLabel}）`,
              sourceKind: 'cad',
              fileName: `manufacturing-${suffix}.stl`,
              revision: manufacturingResult.revision,
              visible: true,
              rotationDeg: splitTransform.rotationDeg,
              positionMm: splitTransform.positionMm,
              uniformScale: splitTransform.scale,
              normalizationSpace: 'preserved',
              basePositionDisplayMm
            }));
          });
          return;
        }
        result.push(withIdentity({
          objectId: part.id,
          objectLabel: part.label,
          sourceKind: 'cad',
          fileName: part.stlFile,
          revision: cadResult.revision,
          visible: true,
          rotationDeg: transform.rotationDeg,
          positionMm: transform.positionMm,
          uniformScale: transform.scale,
          normalizationSpace: 'object-local',
          basePositionDisplayMm
        }));
      });
    }

    if (viewportModelSource === 'uploaded-stl' && importedStlModel) {
      const bounds = importedStlModel.metrics.boundsMm;
      const uploadedBasePosition = {
        x: -(bounds.minX + bounds.maxX) / 2,
        y: -bounds.minZ,
        z: (bounds.minY + bounds.maxY) / 2
      };
      if (manufacturingResult?.sourceKind === 'uploaded-stl') {
        ([-1, 1] as const).forEach((direction) => {
          const suffix = direction < 0 ? 'negative' : 'positive';
          const objectId = `uploaded-model-${suffix}`;
          const directionLabel = direction < 0 ? '负方向拆件' : '正方向拆件';
          const fallbackColor = direction < 0 ? '#c9d9e8' : '#e7d4b6';
          const transform = normalizeObjectPresentation(
            objectPresentations[objectId],
            fallbackColor
          ).transform;
          result.push(withIdentity({
            objectId,
            objectLabel: `${importedStlModel.name}（${directionLabel}）`,
            sourceKind: 'uploaded-stl',
            fileName: `manufacturing-${suffix}.stl`,
            revision: manufacturingResult.revision,
            visible: true,
            rotationDeg: transform.rotationDeg,
            positionMm: transform.positionMm,
            uniformScale: transform.scale,
            normalizationSpace: 'preserved',
            basePositionDisplayMm: uploadedBasePosition
          }));
        });
      } else {
        const transform = normalizeObjectPresentation(
          objectPresentations['uploaded-model'],
          '#d7dde4'
        ).transform;
        result.push(withIdentity({
          objectId: 'uploaded-model',
          objectLabel: importedStlModel.name,
          sourceKind: 'uploaded-stl',
          fileName: importedStlModel.sourceFile,
          revision: importedStlModel.revision,
          visible: true,
          rotationDeg: transform.rotationDeg,
          positionMm: transform.positionMm,
          uniformScale: transform.scale,
          normalizationSpace: 'preserved',
          basePositionDisplayMm: uploadedBasePosition
        }));
      }
    }
    return result;
  }, [cadResult, importedStlModel, manufacturingResult, objectPresentations, parameters, viewportModelSource]);

  const referenceCandidate = useMemo<PrintPlatformObjectFootprintCandidate | null>(() => (
    viewportModelSource === 'cad'
      ? {
          sourceIdentity: `reference:定位参考件:${showBoard ? '可见' : '隐藏'}`,
          objectId: 'reference',
          objectLabel: '定位参考件',
          sourceKind: 'reference',
          printable: false,
          visible: showBoard,
          boundsMm: null
        }
      : null
  ), [showBoard, viewportModelSource]);

  const identityCandidates = useMemo<PrintPlatformObjectFootprintCandidate[]>(() => [
    ...sources.map((source) => ({
      sourceIdentity: source.sourceIdentity,
      objectId: source.objectId,
      objectLabel: source.objectLabel,
      sourceKind: source.sourceKind,
      printable: true,
      visible: source.visible,
      boundsMm: null
    })),
    ...(referenceCandidate ? [referenceCandidate] : [])
  ], [referenceCandidate, sources]);

  const multiObjectSourceIdentity = useMemo(() => {
    if (!overlay) return null;
    try {
      return createPrintPlatformMultiObjectSourceIdentity(
        overlay.sourceIdentity,
        identityCandidates
      );
    } catch {
      return null;
    }
  }, [identityCandidates, overlay]);

  useEffect(() => {
    const store = useModelStore.getState();
    store.clearPrintPlatformMultiObjectPreview();
    if (!overlay || !multiObjectSourceIdentity) return;
    const currentOverlay = overlay;
    const currentSourceIdentity = multiObjectSourceIdentity;
    let cancelled = false;

    async function analyzeSources() {
      const platformSizeMm: [number, number] = [
        currentOverlay.platformBoundsMm.maximumX - currentOverlay.platformBoundsMm.minimumX,
        currentOverlay.platformBoundsMm.maximumZ - currentOverlay.platformBoundsMm.minimumZ
      ];
      const analyzed = await Promise.all(sources.map(async (source): Promise<PrintPlatformObjectFootprintCandidate> => {
        let sourceUrl: string | null = null;
        try {
          sourceUrl = await resolveGeneratedModelUrl(source.fileName, source.revision);
          if (!sourceUrl) throw new Error('无法读取精确 STL');
          const response = await fetch(sourceUrl, { cache: 'no-store' });
          if (!response.ok) throw new Error(`读取精确 STL 失败（${response.status}）`);
          const geometry = new STLLoader().parse(await response.arrayBuffer());
          try {
            const positions = geometry.getAttribute('position');
            if (!positions) throw new Error('精确 STL 缺少三角面坐标');
            const boundary = evaluatePrintPlatformBoundary({
              positions: positions.array,
              indices: geometry.getIndex()?.array ?? null
            }, {
              rotationDeg: source.rotationDeg,
              positionMm: source.positionMm,
              uniformScale: source.uniformScale,
              normalizationSpace: source.normalizationSpace,
              basePositionDisplayMm: source.basePositionDisplayMm,
              platformSizeMm
            });
            return {
              sourceIdentity: source.sourceIdentity,
              objectId: source.objectId,
              objectLabel: source.objectLabel,
              sourceKind: source.sourceKind,
              printable: true,
              visible: source.visible,
              boundsMm: boundary.boundsMm
            };
          } finally {
            geometry.dispose();
          }
        } catch {
          return {
            sourceIdentity: source.sourceIdentity,
            objectId: source.objectId,
            objectLabel: source.objectLabel,
            sourceKind: source.sourceKind,
            printable: true,
            visible: source.visible,
            boundsMm: null
          };
        } finally {
          if (sourceUrl?.startsWith('blob:')) URL.revokeObjectURL(sourceUrl);
        }
      }));
      if (cancelled) return;
      try {
        const preview = createPrintPlatformMultiObjectPreview(
          currentSourceIdentity,
          [...analyzed, ...(referenceCandidate ? [referenceCandidate] : [])],
          currentOverlay.platformBoundsMm,
          currentOverlay.effectiveBoundsMm
        );
        if (!cancelled) useModelStore.getState().setPrintPlatformMultiObjectPreview(preview);
      } catch {
        if (!cancelled) useModelStore.getState().clearPrintPlatformMultiObjectPreview();
      }
    }

    void analyzeSources();
    return () => {
      cancelled = true;
      useModelStore.getState().clearPrintPlatformMultiObjectPreview(currentSourceIdentity);
    };
  }, [multiObjectSourceIdentity, overlay, referenceCandidate, sources]);

  return null;
}
