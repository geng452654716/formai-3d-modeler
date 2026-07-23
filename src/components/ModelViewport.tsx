import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  ContactShadows,
  Grid,
  Html,
  Line,
  OrbitControls,
  PerspectiveCamera,
  TransformControls
} from '@react-three/drei';
import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Matrix3, Matrix4, Mesh, Path, Plane, Quaternion, Raycaster, Shape, Vector2, Vector3 } from 'three';
import type { Camera, Group, Object3D } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  compareCadStableFaceIds,
  findCadPartByRole,
  resolveGeneratedModelUrl,
  resolveVersionSnapshotModelUrl,
  type CadFaceTriangleRange,
  type CadPartDescriptor
} from '../model/cad';
import {
  CAD_FACE_SELECTION_WARNING,
  cadSelectedFaceFromDescriptor,
  cadTriangleRectangleSamples,
  findCadFaceRangeByTriangleIndex,
  findNearestCadEdge,
  type CadFaceSelectionContext,
  type CadSelectedEdgeTarget,
  type CadSelectionScreenshot
} from '../model/cadFaceSelection';
import { createLidGeometry, createTrayGeometry } from '../model/createEnclosureGeometry';
import { getOuterDimensions } from '../model/defaults';
import { degreesToRadians, describeObjectTransformChange, normalizeObjectPresentation } from '../model/objectTransform';
import { describeCadSurfaceGeometryType, describeLocalCadFeaturePreview } from '../model/localCadFeature';
import {
  capturePrintPlatformReturnSnapshot,
  createNextPrintPlatformReturnViewRequest,
  createNextPrintPlatformViewRequest,
  resolvePrintPlatformReturnSnapshot,
  resolvePrintPlatformTopViewRequest,
  type PrintPlatformReturnSnapshot,
  type PrintPlatformViewRequest
} from '../model/printPlatformCamera';
import {
  createPrintPlatformMultiObjectLockedRotationLayoutPlan,
  createPrintPlatformMultiObjectSpacingDiagnostic,
  type PrintPlatformMultiObjectPreview,
  type PrintPlatformMultiObjectLockedRotationLayoutPlan,
  type PrintPlatformMultiObjectSpacingDiagnostic,
  type PrintPlatformObjectPairDiagnostic,
  type PrintPlatformObjectLockedRotationLayoutPlacement
} from '../model/printPlatformMultiObject';
import {
  createPrintPlatformBoundarySegment,
  createPrintPlatformRectanglePoints,
  resolvePrintPlatformBedGuide,
  resolvePrintPlatformGridGuide,
  type PrintPlatformOverlay
} from '../model/printPlatformOverlay';
import {
  createPrintPlatformManualLayoutSession,
  movePrintPlatformManualLayoutObject,
  setPrintPlatformManualLayoutSnapToGrid,
  type PrintPlatformManualLayoutPlacement,
  type PrintPlatformManualLayoutPoint,
  type PrintPlatformManualLayoutSession
} from '../model/printPlatformManualLayout';
import {
  createPrintPlatformAlignmentPlan,
  type PrintPlatformAlignmentOperation,
  type PrintPlatformAlignmentPlacement,
  type PrintPlatformAlignmentPlan
} from '../model/printPlatformAlignmentLayout';
import {
  createPrintPlatformFixedGapPlan,
  type PrintPlatformFixedGapAnchorMode,
  type PrintPlatformFixedGapOperation,
  type PrintPlatformFixedGapPlacement,
  type PrintPlatformFixedGapPlan
} from '../model/printPlatformFixedGapLayout';
import {
  collectMeshElementBoxSelection,
  createMeshElementSelectionSet,
  createMeshPlanarRegionExtrusionPreviewGuides,
  createMeshPlanarRegionExtrusionPreviewMetrics,
  createMeshPlanarRegionExtrusionPreviewProfile,
  createMeshPlanarRegionDimensionGuides,
  createMeshPlanarRegionTopology,
  expandMeshPlanarRegion,
  MESH_PLANAR_REGION_DIMENSION_LAYOUTS,
  MAX_MESH_ELEMENT_SELECTIONS,
  nearestMeshElementIndex,
  selectMeshPlanarRegionDimensionLayout,
  selectedMeshElementPoints,
  type MeshElementSelection,
  type MeshElementSelectionSet,
  type MeshPlanarRegionTopology,
  type MeshPlanarRegionTriangle
} from '../model/meshElementEdit';
import { LocalCadFeatureRiskPanel } from './LocalCadFeatureRiskPanel';
import { PrintPlatformMultiObjectAnalyzer } from './PrintPlatformMultiObjectAnalyzer';
import type { EnclosureParameters, SceneObjectId } from '../model/types';
import { calculateVersionComparisonOffsets } from '../model/versionGeometryComparison';
import {
  WALL_THICKNESS_COLORS,
  WALL_THICKNESS_LABELS,
  type WallThicknessAnalysisResult,
  type WallThicknessSample
} from '../model/wallThickness';
import { useModelStore } from '../store/useModelStore';


const CAD_FACE_SELECTION_LIMIT = 100;
const CAD_FACE_CANDIDATE_LIMIT = 400;
const CAD_FACE_VISIBILITY_SAMPLES = 4;
const MESH_PLANAR_DIMENSION_SAFE_INSETS = { leftPx: 24, topPx: 58, rightPx: 326, bottomPx: 26 };

/** 把三维标签投影限制在视口安全区内，避免进入工具栏、编辑面板或被画布裁切。 */
function createMeshPlanarDimensionHtmlPosition(labelWidthPx: number, labelHeightPx: number) {
  return (element: Object3D, camera: Camera, size: { width: number; height: number }) => {
    const projected = new Vector3();
    element.getWorldPosition(projected);
    projected.project(camera);
    const halfWidth = labelWidthPx / 2;
    const halfHeight = labelHeightPx / 2;
    const leftPx = MESH_PLANAR_DIMENSION_SAFE_INSETS.leftPx + halfWidth;
    const rightPx = Math.max(leftPx, size.width - MESH_PLANAR_DIMENSION_SAFE_INSETS.rightPx - halfWidth);
    const topPx = MESH_PLANAR_DIMENSION_SAFE_INSETS.topPx + halfHeight;
    const bottomPx = Math.max(topPx, size.height - MESH_PLANAR_DIMENSION_SAFE_INSETS.bottomPx - halfHeight);
    return [
      Math.min(rightPx, Math.max(leftPx, (projected.x + 1) * size.width / 2)),
      Math.min(bottomPx, Math.max(topPx, (1 - projected.y) * size.height / 2))
    ] as [number, number];
  };
}

const calculateMeshPlanarAxisLabelPosition = createMeshPlanarDimensionHtmlPosition(104, 20);
const calculateMeshPlanarSummaryLabelPosition = createMeshPlanarDimensionHtmlPosition(104, 38);
const calculateMeshPlanarExtrusionLabelPosition = createMeshPlanarDimensionHtmlPosition(176, 52);

interface FeaturePreviewGeometryProps {
  profile: 'circle' | 'rectangle' | 'slot';
  radiusMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  lengthMm: number | null;
  depthMm: number;
  rotationRad: number;
  color: string;
}

/** 创建与 OpenCascade 切平面槽孔一致的长圆形挤出预览，不把它描述成任意曲面贴合轮廓。 */
function createSlotPreviewGeometry(widthMm: number, lengthMm: number, depthMm: number) {
  const radius = widthMm / 2;
  const straightHalf = Math.max(0, (lengthMm - widthMm) / 2);
  const shape = new Shape();
  shape.moveTo(-straightHalf, -radius);
  shape.lineTo(straightHalf, -radius);
  shape.absarc(straightHalf, 0, radius, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(-straightHalf, radius);
  shape.absarc(-straightHalf, 0, radius, Math.PI / 2, Math.PI * 1.5, false);
  const geometry = new ExtrudeGeometry(shape, { depth: depthMm, steps: 1, bevelEnabled: false, curveSegments: 24 });
  geometry.translate(0, 0, -depthMm / 2);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function FeaturePreviewGeometry(props: FeaturePreviewGeometryProps) {
  const geometry = useMemo(() => {
    if (props.profile === 'slot') {
      return createSlotPreviewGeometry(props.widthMm!, props.lengthMm!, props.depthMm);
    }
    if (props.profile === 'rectangle') {
      return new BoxGeometry(props.widthMm!, props.depthMm, props.heightMm!);
    }
    return new CylinderGeometry(props.radiusMm!, props.radiusMm!, props.depthMm, 48);
  }, [props.depthMm, props.heightMm, props.lengthMm, props.profile, props.radiusMm, props.widthMm]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const rotation = props.profile === 'circle' ? undefined : [0, props.rotationRad, 0] as const;
  return (
    <>
      <mesh renderOrder={8} rotation={rotation}>
        <primitive object={geometry} attach="geometry" />
        <meshStandardMaterial
          color={props.color}
          emissive={props.color}
          emissiveIntensity={0.35}
          transparent
          opacity={0.28}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
      <mesh renderOrder={9} rotation={rotation} scale={1.002}>
        <primitive object={geometry} attach="geometry" />
        <meshBasicMaterial
          color={props.color}
          transparent
          opacity={0.82}
          wireframe
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

function captureCanvasRegion(
  canvas: HTMLCanvasElement,
  cropCss: { x: number; y: number; width: number; height: number }
): CadSelectionScreenshot | null {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = Math.max(0, Math.min(bounds.width - 1, cropCss.x));
  const y = Math.max(0, Math.min(bounds.height - 1, cropCss.y));
  const width = Math.max(1, Math.min(bounds.width - x, cropCss.width));
  const height = Math.max(1, Math.min(bounds.height - y, cropCss.height));
  const scaleX = canvas.width / bounds.width;
  const scaleY = canvas.height / bounds.height;
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(width * scaleX));
  output.height = Math.max(1, Math.round(height * scaleY));
  const context = output.getContext('2d');
  if (!context) return null;
  context.drawImage(
    canvas,
    Math.round(x * scaleX),
    Math.round(y * scaleY),
    output.width,
    output.height,
    0,
    0,
    output.width,
    output.height
  );
  return {
    dataUrl: output.toDataURL('image/png'),
    width: output.width,
    height: output.height,
    crop: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  };
}

function captureClickScreenshot(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.min(384, bounds.width);
  const height = Math.min(288, bounds.height);
  return captureCanvasRegion(canvas, {
    x: clientX - bounds.left - width / 2,
    y: clientY - bounds.top - height / 2,
    width,
    height
  });
}

function createFaceHighlightGeometry(
  geometry: BufferGeometry,
  ranges: CadFaceTriangleRange[]
) {
  const positions = geometry.getAttribute('position');
  if (!positions || ranges.length === 0) return null;
  const index = geometry.getIndex();
  const values: number[] = [];
  ranges.forEach((range) => {
    for (let triangle = range.triangleStart; triangle < range.triangleStart + range.triangleCount; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceIndex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
        values.push(positions.getX(sourceIndex), positions.getY(sourceIndex), positions.getZ(sourceIndex));
      }
    }
  });
  if (values.length === 0) return null;
  const highlight = new BufferGeometry();
  highlight.setAttribute('position', new Float32BufferAttribute(values, 3));
  highlight.computeVertexNormals();
  return highlight;
}

function cameraSelectionContext(camera: Camera, width: number, height: number) {
  camera.updateMatrixWorld();
  return {
    positionMm: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    projectionMatrix: camera.projectionMatrix.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    viewportPixels: { width: Math.round(width), height: Math.round(height) }
  };
}

function applyWallThicknessColors(
  geometry: BufferGeometry,
  analysis: WallThicknessAnalysisResult
) {
  const positions = geometry.getAttribute('position');
  if (!positions || analysis.samples.length === 0) return false;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const diagonal = bounds ? bounds.min.distanceTo(bounds.max) : 1;
  const cellSize = Math.max(diagonal / Math.max(4, Math.sqrt(analysis.samples.length)), 0.05);
  const buckets = new Map<string, typeof analysis.samples>();
  const cellCoordinate = (value: number) => Math.floor(value / cellSize);
  const bucketKey = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
  analysis.samples.forEach((sample) => {
    const key = bucketKey(
      cellCoordinate(sample.xMm),
      cellCoordinate(sample.yMm),
      cellCoordinate(sample.zMm)
    );
    const bucket = buckets.get(key);
    if (bucket) bucket.push(sample);
    else buckets.set(key, [sample]);
  });

  const colors = new Float32Array(positions.count * 3);
  const fallbackColor = new Color(WALL_THICKNESS_COLORS.safe);
  for (let vertexIndex = 0; vertexIndex < positions.count; vertexIndex += 1) {
    const x = positions.getX(vertexIndex);
    const y = positions.getY(vertexIndex);
    const z = positions.getZ(vertexIndex);
    const cellX = cellCoordinate(x);
    const cellY = cellCoordinate(y);
    const cellZ = cellCoordinate(z);
    let nearest = null as WallThicknessAnalysisResult['samples'][number] | null;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    for (let radius = 0; radius <= 4 && nearest === null; radius += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
            const bucket = buckets.get(bucketKey(cellX + offsetX, cellY + offsetY, cellZ + offsetZ));
            if (!bucket) continue;
            bucket.forEach((sample) => {
              const distanceSquared = (sample.xMm - x) ** 2 + (sample.yMm - y) ** 2 + (sample.zMm - z) ** 2;
              if (distanceSquared < nearestDistanceSquared) {
                nearestDistanceSquared = distanceSquared;
                nearest = sample;
              }
            });
          }
        }
      }
    }
    const color = nearest ? new Color(WALL_THICKNESS_COLORS[nearest.severity]) : fallbackColor;
    colors[vertexIndex * 3] = color.r;
    colors[vertexIndex * 3 + 1] = color.g;
    colors[vertexIndex * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return true;
}

interface TransformableObjectProps {
  id: SceneObjectId;
  label: string;
  fallbackColor: string;
  fallbackPresentationId?: SceneObjectId;
  basePosition?: [number, number, number];
  children: ReactNode;
}

/** 把临时拆分位移放在用户变换外层，确保装配/拆分视图不会覆盖真实对象变换。 */
function TransformableObject({
  id,
  label,
  fallbackColor,
  fallbackPresentationId,
  basePosition = [0, 0, 0],
  children
}: TransformableObjectProps) {
  const objectRef = useRef<Group>(null);
  const selectedObject = useModelStore((state) => state.selectedObject);
  const mode = useModelStore((state) => state.objectTransformMode);
  const storedPresentation = useModelStore((state) => (
    state.objectPresentations[id]
      ?? (fallbackPresentationId ? state.objectPresentations[fallbackPresentationId] : undefined)
  ));
  const beginEdit = useModelStore((state) => state.beginObjectPresentationEdit);
  const updatePresentation = useModelStore((state) => state.updateObjectPresentation);
  const finishEdit = useModelStore((state) => state.finishObjectPresentationEdit);
  const presentation = normalizeObjectPresentation(storedPresentation, fallbackColor);
  const rotation = degreesToRadians(presentation.transform.rotationDeg);
  const controlsVisible = selectedObject === id && mode !== 'select';

  const syncFromObject = () => {
    const object = objectRef.current;
    if (!object) return;
    const current = normalizeObjectPresentation(
      useModelStore.getState().objectPresentations[id]
        ?? (fallbackPresentationId
          ? useModelStore.getState().objectPresentations[fallbackPresentationId]
          : undefined),
      fallbackColor
    );
    const changedScale = [object.scale.x, object.scale.y, object.scale.z]
      .reduce((chosen, candidate) => (
        Math.abs(candidate - current.transform.scale) > Math.abs(chosen - current.transform.scale)
          ? candidate
          : chosen
      ), current.transform.scale);
    const uniformScale = mode === 'scale' ? changedScale : current.transform.scale;
    if (mode === 'scale') object.scale.setScalar(uniformScale);
    updatePresentation(id, {
      transform: {
        positionMm: { x: object.position.x, y: object.position.y, z: object.position.z },
        rotationDeg: {
          x: object.rotation.x * 180 / Math.PI,
          y: object.rotation.y * 180 / Math.PI,
          z: object.rotation.z * 180 / Math.PI
        },
        scale: uniformScale
      }
    }, fallbackColor);
  };

  return (
    <group position={basePosition}>
      <group
        ref={objectRef}
        position={[
          presentation.transform.positionMm.x,
          presentation.transform.positionMm.y,
          presentation.transform.positionMm.z
        ]}
        rotation={rotation}
        scale={presentation.transform.scale}
      >
        {children}
      </group>
      {controlsVisible && objectRef.current && (
        <TransformControls
          object={objectRef.current}
          mode={mode === 'translate' ? 'translate' : mode}
          space="local"
          translationSnap={0.1}
          rotationSnap={Math.PI / 180}
          scaleSnap={0.01}
          size={0.72}
          onMouseDown={() => beginEdit(id, fallbackColor)}
          onObjectChange={syncFromObject}
          onMouseUp={() => finishEdit(id, describeObjectTransformChange(mode, label), fallbackColor)}
        />
      )}
    </group>
  );
}

interface SelectableMeshProps {
  id: SceneObjectId;
  geometry: BufferGeometry;
  color: string;
  position?: [number, number, number];
  heatmap?: boolean;
  onSurfacePick?: (point: Vector3, event: ThreeEvent<MouseEvent>) => void;
  interactive?: boolean;
  opacity?: number;
  renderOrder?: number;
  meshRef?: React.RefObject<Mesh | null>;
  cadSelectionData?: { part: CadPartDescriptor; coordinateTransform: Matrix4 };
  meshElementSelectionData?: { revision: string; inverseCoordinateTransform: Matrix4 };
}

function SelectableMesh({
  id,
  geometry,
  color,
  position = [0, 0, 0],
  heatmap = false,
  onSurfacePick,
  interactive = true,
  opacity = 1,
  renderOrder = 0,
  meshRef,
  cadSelectionData,
  meshElementSelectionData
}: SelectableMeshProps) {
  const selectedObject = useModelStore((state) => state.selectedObject);
  const selectObject = useModelStore((state) => state.selectObject);
  const selected = interactive && selectedObject === id;
  const objectPresentation = useModelStore((state) => state.objectPresentations[id]);
  const displayColor = normalizeObjectPresentation(objectPresentation, color).color;

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      userData={{
        ...(cadSelectionData ? { cadFaceSelection: cadSelectionData } : {}),
        ...(meshElementSelectionData ? { meshElementSelection: meshElementSelectionData } : {})
      }}
      position={position}
      castShadow
      receiveShadow
      renderOrder={renderOrder}
      onClick={interactive ? (event) => {
        event.stopPropagation();
        selectObject(id);
        if (onSurfacePick) {
          const localPoint = event.object.worldToLocal(event.point.clone());
          onSurfacePick(localPoint, event);
        }
      } : undefined}
    >
      <meshStandardMaterial
        key={heatmap ? '壁厚热力图材质' : '普通模型材质'}
        color={heatmap ? new Color('#ffffff') : selected ? new Color('#f59e0b') : new Color(displayColor)}
        emissive={selected && heatmap ? new Color('#6b3f00') : new Color('#000000')}
        emissiveIntensity={selected && heatmap ? 0.45 : 0}
        vertexColors={heatmap}
        roughness={0.5}
        metalness={0.05}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 0.99}
      />
    </mesh>
  );
}

function LoadedCadMesh({
  id,
  sourceUrl,
  color,
  position,
  preserveCoordinates = false,
  wallThicknessAnalysis,
  interactive = true,
  opacity = 1,
  renderOrder = 0,
  cadPart
}: {
  id: SceneObjectId;
  sourceUrl: string;
  color: string;
  position?: [number, number, number];
  preserveCoordinates?: boolean;
  wallThicknessAnalysis?: WallThicknessAnalysisResult | null;
  interactive?: boolean;
  opacity?: number;
  renderOrder?: number;
  cadPart?: CadPartDescriptor;
}) {
  const sourceGeometry = useLoader(STLLoader, sourceUrl);
  const meshRef = useRef<Mesh>(null);
  const { camera, gl, size } = useThree();
  const cadResult = useModelStore((state) => state.cadResult);
  const parameters = useModelStore((state) => state.parameters);
  const cadFaceSelectionMode = useModelStore((state) => state.cadFaceSelectionMode);
  const cadFaceSelection = useModelStore((state) => state.cadFaceSelection);
  const localCadFeaturePreview = useModelStore((state) => state.localCadFeaturePreview);
  const selectCadFaces = useModelStore((state) => state.selectCadFaces);
  const clearCadFaceSelection = useModelStore((state) => state.clearCadFaceSelection);
  const resolveCadSurfaceHitSelection = useModelStore((state) => state.resolveCadSurfaceHitSelection);
  const addAssistantMessage = useModelStore((state) => state.addAssistantMessage);
  const selectWallThicknessSample = useModelStore((state) => state.selectWallThicknessSample);
  const wallThicknessPicking = useModelStore((state) => state.wallThicknessPicking);
  const wallThicknessSelection = useModelStore((state) => state.wallThicknessSelection);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const meshElementSelectionMethod = useModelStore((state) => state.meshElementSelectionMethod);
  const meshElementSelection = useModelStore((state) => state.meshElementSelection);
  const meshElementTransformKind = useModelStore((state) => state.meshElementTransformKind);
  const meshFaceExtrusionMode = useModelStore((state) => state.meshFaceExtrusionMode);
  const meshFaceExtrusionDistanceText = useModelStore((state) => state.meshFaceExtrusionDistanceText);
  const meshPlanarRegionPreview = useModelStore((state) => state.meshPlanarRegionPreview);
  const meshPlanarRegionFocusedLoopIndex = useModelStore((state) => state.meshPlanarRegionFocusedLoopIndex);
  const setMeshPlanarRegionFocusedLoopIndex = useModelStore((state) => state.setMeshPlanarRegionFocusedLoopIndex);
  const setMeshPlanarRegionPreview = useModelStore((state) => state.setMeshPlanarRegionPreview);
  const selectMeshElement = useModelStore((state) => state.selectMeshElement);
  const [meshPlanarRegionDimensionLayoutIndex, setMeshPlanarRegionDimensionLayoutIndex] = useState(0);
  const meshPlanarRegionDimensionLayoutIndexRef = useRef(0);
  const prepared = useMemo(() => {
    const normalized = sourceGeometry.clone();
    const hasHeatmap = wallThicknessAnalysis
      ? applyWallThicknessColors(normalized, wallThicknessAnalysis)
      : false;
    normalized.userData.wallThicknessHeatmap = hasHeatmap;
    const coordinateTransform = new Matrix4().makeRotationX(-Math.PI / 2);
    normalized.applyMatrix4(coordinateTransform);
    if (!preserveCoordinates) {
      normalized.computeBoundingBox();
      const bounds = normalized.boundingBox;
      if (bounds) {
        const translation = new Matrix4().makeTranslation(
          -(bounds.min.x + bounds.max.x) / 2,
          -bounds.min.y,
          -(bounds.min.z + bounds.max.z) / 2
        );
        normalized.applyMatrix4(translation);
        coordinateTransform.premultiply(translation);
      }
    }
    normalized.computeVertexNormals();
    const transformedSamples = wallThicknessAnalysis?.samples.map((sample) => ({
      sample,
      point: new Vector3(sample.xMm, sample.yMm, sample.zMm).applyMatrix4(coordinateTransform)
    })) ?? [];
    return {
      geometry: normalized,
      transformedSamples,
      coordinateTransform,
      inverseCoordinateTransform: coordinateTransform.clone().invert()
    };
  }, [preserveCoordinates, sourceGeometry, wallThicknessAnalysis]);
  const { geometry, transformedSamples, coordinateTransform, inverseCoordinateTransform } = prepared;

  const meshElementPickingEnabled = Boolean(
    id === 'uploaded-model'
    && viewportModelSource === 'uploaded-stl'
    && importedStlModel
    && !manufacturingResult
    && meshElementEditMode !== 'off'
    && meshElementSelectionMethod === 'click'
  );
  const currentMeshElementSelection = useMemo<MeshElementSelectionSet | null>(() => (
    id === 'uploaded-model'
    && importedStlModel
    && meshElementSelection?.revision === importedStlModel.revision
      ? meshElementSelection
      : null
  ), [id, importedStlModel, meshElementSelection]);
  const meshPlanarRegionTopologyCache = useRef<{
    revision: string;
    geometry: BufferGeometry;
    inverseCoordinateTransform: Matrix4;
    topology: MeshPlanarRegionTopology;
  } | null>(null);
  useEffect(() => {
    meshPlanarRegionTopologyCache.current = null;
  }, [geometry, id, importedStlModel?.revision, inverseCoordinateTransform, viewportModelSource]);
  useEffect(() => {
    if (
      id !== 'uploaded-model'
      || viewportModelSource !== 'uploaded-stl'
      || meshElementTransformKind !== 'extrude-face'
      || !importedStlModel
      || currentMeshElementSelection?.kind !== 'face'
      || currentMeshElementSelection.selectionMethod !== 'click'
      || currentMeshElementSelection.elements.length !== 1
    ) return;
    const bounds = importedStlModel.metrics.boundsMm;
    try {
      let cached = meshPlanarRegionTopologyCache.current;
      if (
        !cached
        || cached.revision !== importedStlModel.revision
        || cached.geometry !== geometry
        || cached.inverseCoordinateTransform !== inverseCoordinateTransform
      ) {
        const positions = geometry.getAttribute('position');
        if (!positions) throw new Error('上传模型缺少三角面坐标，无法预览连续共面区域');
        const index = geometry.getIndex();
        const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);
        const triangles = Array.from({ length: triangleCount }, (_, triangleIndex): MeshPlanarRegionTriangle => {
          const vertexIndexes = [0, 1, 2].map((corner) => (
            index ? index.getX(triangleIndex * 3 + corner) : triangleIndex * 3 + corner
          ));
          return {
            triangleIndex,
            triangleMm: vertexIndexes.map((vertexIndex) => {
              const point = new Vector3(
                positions.getX(vertexIndex), positions.getY(vertexIndex), positions.getZ(vertexIndex)
              ).applyMatrix4(inverseCoordinateTransform);
              return { x: point.x, y: point.y, z: point.z };
            }) as MeshElementSelection['triangleMm']
          };
        });
        cached = {
          revision: importedStlModel.revision,
          geometry,
          inverseCoordinateTransform,
          topology: createMeshPlanarRegionTopology(triangles)
        };
        meshPlanarRegionTopologyCache.current = cached;
      }
      setMeshPlanarRegionPreview(expandMeshPlanarRegion(
        importedStlModel.revision,
        currentMeshElementSelection.elements[0].triangleIndex,
        cached.topology,
        Math.hypot(bounds.x, bounds.y, bounds.z)
      ));
    } catch (error) {
      setMeshPlanarRegionPreview(null, error instanceof Error ? error.message : '连续共面区域预览失败');
    }
  }, [currentMeshElementSelection, geometry, id, importedStlModel, inverseCoordinateTransform, meshElementTransformKind, setMeshPlanarRegionPreview, viewportModelSource]);
  const selectedMeshElementGeometries = useMemo(() => {
    if (!currentMeshElementSelection) return { vertices: null, edges: null, faces: null };
    const cachedTopology = meshPlanarRegionTopologyCache.current;
    const previewFaces = currentMeshElementSelection.kind === 'face'
      && meshElementTransformKind === 'extrude-face'
      && meshPlanarRegionPreview?.revision === currentMeshElementSelection.revision
      && cachedTopology?.revision === currentMeshElementSelection.revision
      && cachedTopology.geometry === geometry
      ? meshPlanarRegionPreview.triangleIndexes.flatMap((triangleIndex) => {
        const triangle = cachedTopology.topology.triangleByIndex.get(triangleIndex);
        return triangle ? [triangle.triangleMm] : [];
      })
      : null;
    const transformed = (previewFaces ?? currentMeshElementSelection.elements.map(selectedMeshElementPoints)).map((points) => (
      points.map((point) => (
        new Vector3(point.x, point.y, point.z).applyMatrix4(coordinateTransform)
      ))
    ));
    const positions = transformed.flatMap((points) => points.flatMap((point) => [point.x, point.y, point.z]));
    const selectedGeometry = new BufferGeometry();
    selectedGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    if (currentMeshElementSelection.kind === 'face') selectedGeometry.computeVertexNormals();
    return {
      vertices: currentMeshElementSelection.kind === 'vertex' ? selectedGeometry : null,
      edges: currentMeshElementSelection.kind === 'edge' ? selectedGeometry : null,
      faces: currentMeshElementSelection.kind === 'face' ? selectedGeometry : null
    };
  }, [coordinateTransform, currentMeshElementSelection, geometry, meshElementTransformKind, meshPlanarRegionPreview]);
  useEffect(() => () => {
    selectedMeshElementGeometries.vertices?.dispose();
    selectedMeshElementGeometries.edges?.dispose();
    selectedMeshElementGeometries.faces?.dispose();
  }, [selectedMeshElementGeometries]);

  const meshPlanarRegionLoopRenderData = useMemo(() => {
    if (
      id !== 'uploaded-model'
      || meshElementTransformKind !== 'extrude-face'
      || !importedStlModel
      || meshPlanarRegionPreview?.revision !== importedStlModel.revision
    ) return [];
    return meshPlanarRegionPreview.boundaryLoops.flatMap((loop, loopIndex) => {
      if (loop.pointsMm.length < 3) return [];
      const transformPoint = (point: { x: number; y: number; z: number }) => (
        new Vector3(point.x, point.y, point.z).applyMatrix4(coordinateTransform)
      );
      const transformSegment = (segment: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }]) => (
        segment.map(transformPoint) as [Vector3, Vector3]
      );
      const openPoints = loop.pointsMm.map(transformPoint);
      const dimensionGuideCandidates = MESH_PLANAR_REGION_DIMENSION_LAYOUTS.map((layout) => {
        const dimensionGuidesMm = createMeshPlanarRegionDimensionGuides(loop, layout);
        return {
          width: {
            valueMm: dimensionGuidesMm.width.valueMm,
            dimensionLine: transformSegment(dimensionGuidesMm.width.dimensionLineMm),
            extensionLines: dimensionGuidesMm.width.extensionLinesMm.map(transformSegment),
            capLines: dimensionGuidesMm.width.capLinesMm.map(transformSegment),
            label: transformPoint(dimensionGuidesMm.width.labelMm)
          },
          height: {
            valueMm: dimensionGuidesMm.height.valueMm,
            dimensionLine: transformSegment(dimensionGuidesMm.height.dimensionLineMm),
            extensionLines: dimensionGuidesMm.height.extensionLinesMm.map(transformSegment),
            capLines: dimensionGuidesMm.height.capLinesMm.map(transformSegment),
            label: transformPoint(dimensionGuidesMm.height.labelMm)
          },
          summaryLabel: transformPoint(dimensionGuidesMm.summaryLabelMm)
        };
      });
      const ordinal = meshPlanarRegionPreview.boundaryLoops
        .slice(0, loopIndex + 1)
        .filter((candidate) => candidate.kind === loop.kind).length;
      return [{
        loopIndex,
        loop,
        label: `${loop.kind === 'outer' ? '外环' : '孔洞'} ${ordinal}`,
        color: loop.kind === 'outer' ? '#52e0c4' : '#ff8f70',
        points: [...openPoints, openPoints[0]],
        dimensionGuideCandidates
      }];
    });
  }, [coordinateTransform, id, importedStlModel, meshElementTransformKind, meshPlanarRegionPreview]);

  const meshPlanarRegionBoundaryGeometries = useMemo(() => {
    const createBoundaryGeometry = (kind: 'outer' | 'hole') => {
      const positions = meshPlanarRegionLoopRenderData
        .filter((candidate) => candidate.loop.kind === kind)
        .flatMap((candidate) => candidate.points.slice(0, -1).flatMap((point, index) => {
          const next = candidate.points[index + 1];
          return [point.x, point.y, point.z, next.x, next.y, next.z];
        }));
      if (!positions.length) return null;
      const boundaryGeometry = new BufferGeometry();
      boundaryGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      return boundaryGeometry;
    };
    return {
      outer: createBoundaryGeometry('outer'),
      hole: createBoundaryGeometry('hole')
    };
  }, [meshPlanarRegionLoopRenderData]);
  useEffect(() => () => {
    meshPlanarRegionBoundaryGeometries.outer?.dispose();
    meshPlanarRegionBoundaryGeometries.hole?.dispose();
  }, [meshPlanarRegionBoundaryGeometries]);

  const meshPlanarRegionExtrusionPreview = useMemo(() => {
    if (
      id !== 'uploaded-model'
      || meshElementTransformKind !== 'extrude-face'
      || !importedStlModel
      || meshPlanarRegionPreview?.revision !== importedStlModel.revision
    ) return null;
    const profile = createMeshPlanarRegionExtrusionPreviewProfile(
      meshPlanarRegionPreview,
      meshFaceExtrusionMode,
      Number(meshFaceExtrusionDistanceText)
    );
    if (!profile) return null;
    const guides = createMeshPlanarRegionExtrusionPreviewGuides(profile);
    const metrics = createMeshPlanarRegionExtrusionPreviewMetrics(profile);
    if (!guides || !metrics) return null;
    const shape = new Shape();
    shape.moveTo(profile.outer[0].x, profile.outer[0].y);
    profile.outer.slice(1).forEach((point) => shape.lineTo(point.x, point.y));
    shape.closePath();
    profile.holes.forEach((holePoints) => {
      const hole = new Path();
      hole.moveTo(holePoints[0].x, holePoints[0].y);
      holePoints.slice(1).forEach((point) => hole.lineTo(point.x, point.y));
      hole.closePath();
      shape.holes.push(hole);
    });
    const extrusionGeometry = new ExtrudeGeometry(shape, {
      depth: profile.distanceMm,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1
    });
    const sourceBasis = new Matrix4().makeBasis(
      new Vector3(profile.axisU.x, profile.axisU.y, profile.axisU.z),
      new Vector3(profile.axisV.x, profile.axisV.y, profile.axisV.z),
      new Vector3(profile.directionNormalMm.x, profile.directionNormalMm.y, profile.directionNormalMm.z)
    );
    sourceBasis.setPosition(profile.originMm.x, profile.originMm.y, profile.originMm.z);
    extrusionGeometry.applyMatrix4(coordinateTransform.clone().multiply(sourceBasis));
    const transformPoint = (point: { x: number; y: number; z: number }) => (
      new Vector3(point.x, point.y, point.z).applyMatrix4(coordinateTransform)
    );
    /** 将任意数量环的侧边连接线合并为两份轻量 LineSegments 几何，避免逐边创建组件。 */
    const createSideConnectionGeometry = (kind: 'outer' | 'hole') => {
      const positions = guides.loops
        .filter((loop) => loop.kind === kind)
        .flatMap((loop) => loop.sideSegmentsMm.flatMap(([start, end]) => {
          const transformedStart = transformPoint(start);
          const transformedEnd = transformPoint(end);
          return [
            transformedStart.x,
            transformedStart.y,
            transformedStart.z,
            transformedEnd.x,
            transformedEnd.y,
            transformedEnd.z
          ];
        }));
      if (!positions.length) return null;
      const sideGeometry = new BufferGeometry();
      sideGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      return sideGeometry;
    };
    return {
      geometry: extrusionGeometry,
      mode: meshFaceExtrusionMode,
      distanceMm: profile.distanceMm,
      metrics,
      color: meshFaceExtrusionMode === 'add' ? '#2dd4bf' : '#ff8066',
      directionLine: [transformPoint(profile.directionStartMm), transformPoint(profile.directionEndMm)] as [Vector3, Vector3],
      labelPoint: transformPoint(profile.labelPointMm),
      endpointMarkerSegments: guides.endpointMarkerSegmentsMm.map((segment) => (
        segment.map(transformPoint) as [Vector3, Vector3]
      )),
      sideConnectionGeometries: {
        outer: createSideConnectionGeometry('outer'),
        hole: createSideConnectionGeometry('hole')
      },
      outlineLoops: guides.loops.flatMap((loop, loopIndex) => ([{
        key: `${loop.kind}-${loopIndex}-起始端`,
        kind: loop.kind,
        end: false,
        points: loop.startLoopMm.map(transformPoint)
      }, {
        key: `${loop.kind}-${loopIndex}-末端`,
        kind: loop.kind,
        end: true,
        points: loop.endLoopMm.map(transformPoint)
      }]))
    };
  }, [
    coordinateTransform,
    id,
    importedStlModel,
    meshElementTransformKind,
    meshFaceExtrusionDistanceText,
    meshFaceExtrusionMode,
    meshPlanarRegionPreview
  ]);
  useEffect(() => () => {
    meshPlanarRegionExtrusionPreview?.geometry.dispose();
    meshPlanarRegionExtrusionPreview?.sideConnectionGeometries.outer?.dispose();
    meshPlanarRegionExtrusionPreview?.sideConnectionGeometries.hole?.dispose();
  }, [meshPlanarRegionExtrusionPreview]);

  const focusedMeshPlanarRegionLoopBase = meshPlanarRegionFocusedLoopIndex === null
    ? null
    : meshPlanarRegionLoopRenderData.find((candidate) => (
      candidate.loopIndex === meshPlanarRegionFocusedLoopIndex
    )) ?? null;
  const focusedMeshPlanarRegionLoop = focusedMeshPlanarRegionLoopBase
    ? {
        ...focusedMeshPlanarRegionLoopBase,
        dimensionGuides: focusedMeshPlanarRegionLoopBase.dimensionGuideCandidates[
          meshPlanarRegionDimensionLayoutIndex
        ] ?? focusedMeshPlanarRegionLoopBase.dimensionGuideCandidates[0]
      }
    : null;

  useEffect(() => {
    meshPlanarRegionDimensionLayoutIndexRef.current = 0;
    setMeshPlanarRegionDimensionLayoutIndex(0);
  }, [meshPlanarRegionFocusedLoopIndex, meshPlanarRegionPreview?.revision, meshPlanarRegionPreview?.seedTriangleIndex]);

  useFrame(() => {
    if (!focusedMeshPlanarRegionLoopBase || !meshRef.current?.parent) return;
    const safeRightPx = Math.max(170, size.width - MESH_PLANAR_DIMENSION_SAFE_INSETS.rightPx);
    const safeArea = {
      leftPx: MESH_PLANAR_DIMENSION_SAFE_INSETS.leftPx,
      topPx: MESH_PLANAR_DIMENSION_SAFE_INSETS.topPx,
      rightPx: safeRightPx,
      bottomPx: size.height - MESH_PLANAR_DIMENSION_SAFE_INSETS.bottomPx
    };
    const parentWorldMatrix = meshRef.current.parent.matrixWorld;
    const projectAnchor = (point: Vector3, widthPx: number, heightPx: number) => {
      const projected = point.clone().applyMatrix4(parentWorldMatrix).project(camera);
      return {
        xPx: (projected.x + 1) * size.width / 2,
        yPx: (1 - projected.y) * size.height / 2,
        widthPx,
        heightPx
      };
    };
    const nextLayoutIndex = selectMeshPlanarRegionDimensionLayout(
      focusedMeshPlanarRegionLoopBase.dimensionGuideCandidates.map((candidate, layoutIndex) => ({
        layoutIndex,
        anchors: [
          projectAnchor(candidate.width.label, 104, 20),
          projectAnchor(candidate.height.label, 104, 20),
          projectAnchor(candidate.summaryLabel, 104, 38)
        ]
      })),
      safeArea
    );
    if (nextLayoutIndex === null || nextLayoutIndex === meshPlanarRegionDimensionLayoutIndexRef.current) return;
    meshPlanarRegionDimensionLayoutIndexRef.current = nextLayoutIndex;
    setMeshPlanarRegionDimensionLayoutIndex(nextLayoutIndex);
  });

  const selectedMarker = useMemo(() => {
    if (
      !wallThicknessAnalysis
      || !wallThicknessSelection
      || wallThicknessSelection.sourceKind !== wallThicknessAnalysis.sourceKind
      || wallThicknessSelection.sourcePartId !== wallThicknessAnalysis.sourcePartId
    ) return null;
    return transformedSamples.reduce<{ sample: WallThicknessSample; point: Vector3; distanceSquared: number } | null>(
      (nearest, candidate) => {
        const selected = wallThicknessSelection.sample;
        const distanceSquared = (candidate.sample.xMm - selected.xMm) ** 2
          + (candidate.sample.yMm - selected.yMm) ** 2
          + (candidate.sample.zMm - selected.zMm) ** 2;
        return !nearest || distanceSquared < nearest.distanceSquared
          ? { ...candidate, distanceSquared }
          : nearest;
      },
      null
    );
  }, [transformedSamples, wallThicknessAnalysis, wallThicknessSelection]);

  const selectedRanges = useMemo(() => {
    if (!cadPart?.faceTessellation || !cadFaceSelection || cadFaceSelection.revision !== cadResult?.revision) return [];
    const selectedIds = new Set(
      cadFaceSelection.faces
        .filter((face) => face.partId === cadPart.id)
        .map((face) => face.stableId)
    );
    return cadPart.faceTessellation.faces.filter((face) => selectedIds.has(face.stableId));
  }, [cadFaceSelection, cadPart, cadResult?.revision]);
  const highlightGeometry = useMemo(
    () => createFaceHighlightGeometry(geometry, selectedRanges),
    [geometry, selectedRanges]
  );
  const interferenceRanges = useMemo(() => {
    const preview = localCadFeaturePreview;
    const preflight = preview?.preflight;
    if (
      preview?.status !== 'blocked'
      || !preflight
      || !cadPart?.faceTessellation
      || preview.request.selectionRevision !== cadResult?.revision
      || preflight.revision !== cadResult.revision
      || preview.request.partId !== cadPart.id
      || preflight.partId !== cadPart.id
      || cadPart.faceTessellation.partId !== cadPart.id
    ) return [];
    const interferingIds = new Set(preflight.validation.interferingStableFaceIds);
    return cadPart.faceTessellation.faces.filter((face) => interferingIds.has(face.stableId));
  }, [cadPart, cadResult?.revision, localCadFeaturePreview]);
  const interferenceGeometry = useMemo(
    () => createFaceHighlightGeometry(geometry, interferenceRanges),
    [geometry, interferenceRanges]
  );
  const focusedInterferenceRange = useMemo(() => {
    const focusedId = localCadFeaturePreview?.focusedInterferenceFaceId;
    return focusedId ? interferenceRanges.find((face) => face.stableId === focusedId) ?? null : null;
  }, [interferenceRanges, localCadFeaturePreview?.focusedInterferenceFaceId]);
  const focusedInterferenceGeometry = useMemo(
    () => createFaceHighlightGeometry(geometry, focusedInterferenceRange ? [focusedInterferenceRange] : []),
    [geometry, focusedInterferenceRange]
  );
  const focusedInterferencePoint = useMemo(
    () => focusedInterferenceRange
      ? new Vector3(...focusedInterferenceRange.centerMm).applyMatrix4(coordinateTransform)
      : null,
    [coordinateTransform, focusedInterferenceRange]
  );
  const selectedEdgeGeometry = useMemo(() => {
    const edges = cadFaceSelection?.selectionMode === 'edge-chain'
      ? (cadFaceSelection.edgeSelections ?? []).map((target) => target.edge)
      : cadFaceSelection?.selectionMode === 'edge' && cadFaceSelection.edge
        ? [cadFaceSelection.edge]
        : [];
    const visibleEdges = edges.filter((edge) => edge.partId === cadPart?.id && edge.samplePointsMm.length >= 2);
    if (!visibleEdges.length) return null;
    const positions: number[] = [];
    visibleEdges.forEach((edge) => {
      for (let index = 1; index < edge.samplePointsMm.length; index += 1) {
        const start = new Vector3(...edge.samplePointsMm[index - 1]).applyMatrix4(coordinateTransform);
        const end = new Vector3(...edge.samplePointsMm[index]).applyMatrix4(coordinateTransform);
        positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
      }
    });
    const lineGeometry = new BufferGeometry();
    lineGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return lineGeometry;
  }, [cadFaceSelection, cadPart?.id, coordinateTransform]);
  const featurePreviewTransform = useMemo(() => {
    const preview = localCadFeaturePreview;
    const request = preview?.request;
    const selectedFace = cadFaceSelection?.faces[0];
    if (
      !preview
      || !request
      || !cadPart
      || request.selectionRevision !== cadResult?.revision
      || request.partId !== cadPart.id
      || request.stableFaceId !== selectedFace?.stableId
      || request.partId !== selectedFace?.partId
      || (
        !['add-rectangle', 'cut-rectangle', 'cut-slot'].includes(request.operation)
        && request.radiusMm === null
      )
      || (
        ['add-rectangle', 'cut-rectangle'].includes(request.operation)
        && (request.widthMm === null || request.heightMm === null)
      )
      || (request.operation === 'cut-slot' && (request.widthMm === null || request.lengthMm === null))
    ) return null;
    // OpenCascade 已导出最终布尔使用的真实工具体后，不再叠加客户端参数近似体。
    if (preview.preflight?.previewFile) return null;
    const direction = new Vector3(request.hitNormal.x, request.hitNormal.y, request.hitNormal.z);
    if (direction.lengthSq() < 1e-12) return null;
    direction.normalize();
    if (preview.kind === 'subtractive') direction.multiplyScalar(-1);
    direction.applyNormalMatrix(new Matrix3().getNormalMatrix(coordinateTransform)).normalize();
    const center = new Vector3(request.center.xMm, request.center.yMm, request.center.zMm)
      .applyMatrix4(coordinateTransform)
      // 仅用于避免预览和实体表面闪烁，不改变送给 OpenCascade 的毫米参数。
      .addScaledVector(direction, request.depthMm / 2 + 0.02);
    const tangent = request.surfaceTangentU
      ? new Vector3(request.surfaceTangentU.x, request.surfaceTangentU.y, request.surfaceTangentU.z)
        .applyNormalMatrix(new Matrix3().getNormalMatrix(coordinateTransform))
      : null;
    const quaternion = tangent && tangent.lengthSq() >= 1e-12
      ? (() => {
          tangent.addScaledVector(direction, -tangent.dot(direction)).normalize();
          const localZ = tangent.clone().cross(direction).normalize();
          return new Quaternion().setFromRotationMatrix(
            new Matrix4().makeBasis(tangent, direction, localZ)
          );
        })()
      : new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction);
    return {
      center,
      quaternion,
      profile: request.operation === 'cut-slot'
        ? 'slot' as const
        : request.operation === 'add-rectangle' || request.operation === 'cut-rectangle'
          ? 'rectangle' as const
          : 'circle' as const,
      radiusMm: request.radiusMm,
      widthMm: request.widthMm,
      heightMm: request.heightMm,
      lengthMm: request.lengthMm,
      depthMm: request.depthMm,
      rotationRad: request.rotationDeg * Math.PI / 180 * (preview.kind === 'subtractive' ? -1 : 1),
      color: preview.status === 'blocked'
        ? '#f59e0b'
        : preview.status === 'failed' ? '#fb7185'
        : preview.kind === 'additive' ? '#34d399' : '#f87171'
    };
  }, [cadFaceSelection, cadPart, cadResult?.revision, coordinateTransform, localCadFeaturePreview]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => highlightGeometry?.dispose(), [highlightGeometry]);
  useEffect(() => () => interferenceGeometry?.dispose(), [interferenceGeometry]);
  useEffect(() => () => focusedInterferenceGeometry?.dispose(), [focusedInterferenceGeometry]);
  useEffect(() => () => selectedEdgeGeometry?.dispose(), [selectedEdgeGeometry]);

  return (
    <group position={position}>
      <SelectableMesh
        id={id}
        geometry={geometry}
        color={color}
        heatmap={Boolean(geometry.userData.wallThicknessHeatmap)}
        interactive={interactive}
        opacity={opacity}
        renderOrder={renderOrder}
        meshRef={meshRef}
        cadSelectionData={cadPart?.faceTessellation ? { part: cadPart, coordinateTransform } : undefined}
        meshElementSelectionData={id === 'uploaded-model' && importedStlModel
          ? { revision: importedStlModel.revision, inverseCoordinateTransform }
          : undefined}
        onSurfacePick={(point, event) => {
          if (meshElementPickingEnabled && importedStlModel && meshElementEditMode !== 'off') {
            const triangleIndex = event.faceIndex;
            const positions = geometry.getAttribute('position');
            if (triangleIndex === undefined || triangleIndex === null || !positions) return;
            const indices = geometry.index
              ? [
                  geometry.index.getX(triangleIndex * 3),
                  geometry.index.getX(triangleIndex * 3 + 1),
                  geometry.index.getX(triangleIndex * 3 + 2)
                ]
              : [triangleIndex * 3, triangleIndex * 3 + 1, triangleIndex * 3 + 2];
            if (indices.some((index) => index < 0 || index >= positions.count)) return;
            const triangleMm = indices.map((index) => (
              new Vector3(positions.getX(index), positions.getY(index), positions.getZ(index))
                .applyMatrix4(inverseCoordinateTransform)
            )).map((vertex) => ({ x: vertex.x, y: vertex.y, z: vertex.z })) as MeshElementSelection['triangleMm'];
            const sourcePoint = point.clone().applyMatrix4(inverseCoordinateTransform);
            selectMeshElement({
              revision: importedStlModel.revision,
              sourcePartId: 'uploaded-model',
              kind: meshElementEditMode,
              triangleIndex,
              elementIndex: nearestMeshElementIndex(meshElementEditMode, triangleMm, {
                x: sourcePoint.x,
                y: sourcePoint.y,
                z: sourcePoint.z
              }),
              triangleMm
            });
            return;
          }
          if (cadPart?.faceTessellation && (cadFaceSelectionMode === 'click' || cadFaceSelectionMode === 'edge' || cadFaceSelectionMode === 'edge-chain') && cadResult) {
            const faceRange = findCadFaceRangeByTriangleIndex(cadPart.faceTessellation, event.faceIndex);
            if (!faceRange) return;
            const pointCad = point.clone().applyMatrix4(inverseCoordinateTransform);
            const normalCad = event.face?.normal
              ? event.face.normal.clone().applyNormalMatrix(
                  new Matrix3().getNormalMatrix(inverseCoordinateTransform)
                ).normalize()
              : faceRange.normal
                ? new Vector3(...faceRange.normal).normalize()
                : new Vector3(0, 0, 1);
            const screenshot = captureClickScreenshot(gl.domElement, event.clientX, event.clientY);
            const faceDescriptor = cadPart.faces?.find((face) => face.stableId === faceRange.stableId);
            const nearestEdge = cadFaceSelectionMode === 'edge' || cadFaceSelectionMode === 'edge-chain'
              ? findNearestCadEdge(faceDescriptor?.edges, { x: pointCad.x, y: pointCad.y, z: pointCad.z })
              : null;
            if (cadFaceSelectionMode === 'edge' || cadFaceSelectionMode === 'edge-chain') {
              const bounds = cadPart.metrics.boundsMm;
              const diagonal = Math.hypot(bounds.x, bounds.y, bounds.z);
              const maximumDistance = Math.max(0.35, Math.min(3, diagonal * 0.025));
              if (!nearestEdge || nearestEdge.distanceMm > maximumDistance) {
                addAssistantMessage(`点击位置没有贴近可识别的 CAD 边线；请放大模型并点击边界线附近（允许距离 ${maximumDistance.toFixed(2)} 毫米）。`);
                return;
              }
            }
            const selectedFace = cadSelectedFaceFromDescriptor(cadPart, faceRange);
            const selectedEdge = nearestEdge ? {
              partId: cadPart.id,
              partLabel: cadPart.label,
              stableFaceId: faceRange.stableId,
              stableEdgeId: nearestEdge.edge.stableId,
              geometryType: nearestEdge.edge.geometryType,
              lengthMm: nearestEdge.edge.lengthMm,
              centerMm: nearestEdge.edge.centerMm,
              samplePointsMm: nearestEdge.edge.samplePointsMm
            } : null;
            const selectedHit = {
              partId: cadPart.id,
              stableId: faceRange.stableId,
              stableEdgeId: nearestEdge?.edge.stableId ?? null,
              triangleIndex: event.faceIndex ?? faceRange.triangleStart,
              pointMm: { x: pointCad.x, y: pointCad.y, z: pointCad.z },
              normal: { x: normalCad.x, y: normalCad.y, z: normalCad.z },
              meshPointMm: { x: pointCad.x, y: pointCad.y, z: pointCad.z },
              meshNormal: { x: normalCad.x, y: normalCad.y, z: normalCad.z },
              surfaceUv: null,
              uvBounds: null,
              surfaceTangentU: null,
              precision: 'mesh' as const,
              resolutionStatus: 'resolving' as const,
              pointDistanceMm: null,
              normalDot: null,
              resolutionError: null
            };
            const baseContext = {
              protocol: 'FormAI-CAD-局部编辑上下文' as const,
              protocolVersion: 1 as const,
              sourceKind: 'cad-face' as const,
              revision: cadResult.revision,
              units: 'mm' as const,
              partBoundsMm: { [cadPart.id]: cadPart.metrics.boundsMm },
              camera: cameraSelectionContext(camera, size.width, size.height),
              screenshot,
              parameters: { ...parameters },
              printer: cadResult.printer,
              warning: CAD_FACE_SELECTION_WARNING
            };
            if (cadFaceSelectionMode === 'edge-chain' && selectedEdge) {
              const target: CadSelectedEdgeTarget = { face: selectedFace, edge: selectedEdge, hit: selectedHit };
              const currentTargets = cadFaceSelection?.selectionMode === 'edge-chain'
                && cadFaceSelection.revision === cadResult.revision
                && cadFaceSelection.edgeSelections?.every((candidate) => candidate.edge.partId === cadPart.id)
                ? cadFaceSelection.edgeSelections
                : [];
              const key = `${selectedFace.stableId}::${selectedEdge.stableEdgeId}`;
              const exists = currentTargets.some((candidate) =>
                `${candidate.face.stableId}::${candidate.edge.stableEdgeId}` === key
              );
              const edgeSelections = exists
                ? currentTargets.filter((candidate) =>
                    `${candidate.face.stableId}::${candidate.edge.stableEdgeId}` !== key
                  )
                : [...currentTargets, target];
              if (!exists && edgeSelections.length > 64) {
                addAssistantMessage('手工多选边链最多允许选择 64 条边，请先移除部分边。');
                return;
              }
              if (!edgeSelections.length) {
                clearCadFaceSelection();
                return;
              }
              const first = edgeSelections[0];
              const context: CadFaceSelectionContext = {
                ...baseContext,
                selectionMode: 'edge-chain',
                faces: Array.from(new Map(edgeSelections.map((candidate) => [candidate.face.stableId, candidate.face])).values()),
                edgeSelections,
                edge: first.edge,
                hit: first.hit
              };
              selectCadFaces(context);
              addAssistantMessage(`${exists ? '已移除' : '已加入'}稳定边 ${selectedEdge.stableEdgeId}；当前手工边链共 ${edgeSelections.length} 条边。`);
              if (!exists) void resolveCadSurfaceHitSelection(context, target);
              return;
            }
            const context: CadFaceSelectionContext = {
              ...baseContext,
              selectionMode: cadFaceSelectionMode,
              faces: [selectedFace],
              edge: selectedEdge,
              hit: selectedHit
            };
            selectCadFaces(context);
            void resolveCadSurfaceHitSelection(context);
            return;
          }
          if (wallThicknessAnalysis && wallThicknessPicking) {
            const nearest = transformedSamples.reduce<{ sample: WallThicknessSample; distanceSquared: number } | null>(
              (current, candidate) => {
                const distanceSquared = candidate.point.distanceToSquared(point);
                return !current || distanceSquared < current.distanceSquared
                  ? { sample: candidate.sample, distanceSquared }
                  : current;
              },
              null
            );
            if (nearest) selectWallThicknessSample(nearest.sample);
          }
        }}
      />
      {selectedMeshElementGeometries.vertices && (
        <points geometry={selectedMeshElementGeometries.vertices} renderOrder={12}>
          <pointsMaterial
            color="#ffd447"
            size={7}
            sizeAttenuation={false}
            depthTest={false}
            depthWrite={false}
          />
        </points>
      )}
      {selectedMeshElementGeometries.edges && (
        <lineSegments geometry={selectedMeshElementGeometries.edges} renderOrder={12}>
          <lineBasicMaterial color="#ffd447" depthTest={false} depthWrite={false} />
        </lineSegments>
      )}
      {selectedMeshElementGeometries.faces && (
        <mesh geometry={selectedMeshElementGeometries.faces} renderOrder={12}>
          <meshBasicMaterial
            color="#ffd447"
            transparent
            opacity={0.58}
            side={2}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      )}

      {meshPlanarRegionExtrusionPreview && (
        <>
          <mesh
            geometry={meshPlanarRegionExtrusionPreview.geometry}
            renderOrder={11}
            raycast={() => undefined}
          >
            <meshStandardMaterial
              color={meshPlanarRegionExtrusionPreview.color}
              emissive={meshPlanarRegionExtrusionPreview.color}
              emissiveIntensity={0.2}
              transparent
              opacity={0.18}
              depthWrite={false}
              side={DoubleSide}
            />
          </mesh>
          <Line
            points={meshPlanarRegionExtrusionPreview.directionLine}
            color={meshPlanarRegionExtrusionPreview.color}
            lineWidth={2.2}
            transparent
            opacity={0.95}
            depthTest={false}
            depthWrite={false}
            renderOrder={15}
            raycast={() => undefined}
          />
          {meshPlanarRegionExtrusionPreview.outlineLoops.map((loop) => (
            <Line
              key={`工具体轮廓-${loop.key}`}
              points={loop.points}
              color={loop.kind === 'outer'
                ? meshPlanarRegionExtrusionPreview.color
                : meshPlanarRegionExtrusionPreview.mode === 'add' ? '#b8fff3' : '#ffd2c8'}
              lineWidth={loop.end ? 2.4 : 1.2}
              transparent
              opacity={loop.end ? 0.96 : 0.48}
              depthTest={false}
              depthWrite={false}
              renderOrder={15}
              raycast={() => undefined}
            />
          ))}
          {meshPlanarRegionExtrusionPreview.sideConnectionGeometries.outer && (
            <lineSegments
              geometry={meshPlanarRegionExtrusionPreview.sideConnectionGeometries.outer}
              renderOrder={14}
              raycast={() => undefined}
            >
              <lineBasicMaterial
                color={meshPlanarRegionExtrusionPreview.color}
                transparent
                opacity={0.78}
                depthTest={false}
                depthWrite={false}
              />
            </lineSegments>
          )}
          {meshPlanarRegionExtrusionPreview.sideConnectionGeometries.hole && (
            <lineSegments
              geometry={meshPlanarRegionExtrusionPreview.sideConnectionGeometries.hole}
              renderOrder={14}
              raycast={() => undefined}
            >
              <lineBasicMaterial
                color={meshPlanarRegionExtrusionPreview.mode === 'add' ? '#b8fff3' : '#ffd2c8'}
                transparent
                opacity={0.44}
                depthTest={false}
                depthWrite={false}
              />
            </lineSegments>
          )}
          {meshPlanarRegionExtrusionPreview.endpointMarkerSegments.map((points, index) => (
            <Line
              key={`工具体方向端点-${index}`}
              points={points}
              color={meshPlanarRegionExtrusionPreview.color}
              lineWidth={2.6}
              transparent
              opacity={1}
              depthTest={false}
              depthWrite={false}
              renderOrder={16}
              raycast={() => undefined}
            />
          ))}
          <Html
            position={meshPlanarRegionExtrusionPreview.labelPoint}
            center
            distanceFactor={9}
            calculatePosition={calculateMeshPlanarExtrusionLabelPosition}
          >
            <div
              className={`mesh-planar-region-extrusion-label ${meshPlanarRegionExtrusionPreview.mode}`}
              data-mesh-planar-extrusion-preview={meshPlanarRegionExtrusionPreview.mode}
              data-distance-mm={meshPlanarRegionExtrusionPreview.distanceMm.toFixed(2)}
            >
              <span className="mesh-planar-region-extrusion-title">
                {meshPlanarRegionExtrusionPreview.mode === 'add' ? '向外加料预演' : '向内压入预演'}
                <strong>{meshPlanarRegionExtrusionPreview.distanceMm.toFixed(2)} 毫米</strong>
              </span>
              <span>净作用面积 {meshPlanarRegionExtrusionPreview.metrics.netAreaMm2.toFixed(2)} 平方毫米</span>
              <span>工具体估算 {meshPlanarRegionExtrusionPreview.metrics.estimatedVolumeMm3.toFixed(2)} 立方毫米</span>
            </div>
          </Html>
        </>
      )}

      {meshPlanarRegionBoundaryGeometries.outer && (
        <lineSegments geometry={meshPlanarRegionBoundaryGeometries.outer} renderOrder={13}>
          <lineBasicMaterial
            color="#52e0c4"
            transparent={Boolean(focusedMeshPlanarRegionLoop)}
            opacity={focusedMeshPlanarRegionLoop ? 0.22 : 1}
            depthTest={false}
            depthWrite={false}
          />
        </lineSegments>
      )}

      {meshPlanarRegionBoundaryGeometries.hole && (
        <lineSegments geometry={meshPlanarRegionBoundaryGeometries.hole} renderOrder={14}>
          <lineBasicMaterial
            color="#ff8f70"
            transparent={Boolean(focusedMeshPlanarRegionLoop)}
            opacity={focusedMeshPlanarRegionLoop ? 0.22 : 1}
            depthTest={false}
            depthWrite={false}
          />
        </lineSegments>
      )}

      {meshPlanarRegionLoopRenderData.map((candidate) => (
        <Line
          key={`共面边界环拾取-${candidate.loopIndex}`}
          points={candidate.points}
          color={candidate.color}
          lineWidth={9}
          transparent
          opacity={0.001}
          depthTest={false}
          depthWrite={false}
          renderOrder={16}
          onClick={(event) => {
            event.stopPropagation();
            setMeshPlanarRegionFocusedLoopIndex(
              meshPlanarRegionFocusedLoopIndex === candidate.loopIndex ? null : candidate.loopIndex
            );
          }}
        />
      ))}

      {focusedMeshPlanarRegionLoop && (
        <>
          <Line
            points={focusedMeshPlanarRegionLoop.points}
            color={focusedMeshPlanarRegionLoop.color}
            lineWidth={3.5}
            transparent
            opacity={1}
            depthTest={false}
            depthWrite={false}
            renderOrder={15}
          />
          {[focusedMeshPlanarRegionLoop.dimensionGuides.width, focusedMeshPlanarRegionLoop.dimensionGuides.height].map((axisGuide, axisIndex) => (
            <Line
              key={`共面尺寸主线-${axisIndex}`}
              points={axisGuide.dimensionLine}
              color={focusedMeshPlanarRegionLoop.color}
              lineWidth={1.7}
              transparent
              opacity={0.96}
              depthTest={false}
              depthWrite={false}
              renderOrder={17}
            />
          ))}
          {[focusedMeshPlanarRegionLoop.dimensionGuides.width, focusedMeshPlanarRegionLoop.dimensionGuides.height].flatMap((axisGuide, axisIndex) => (
            axisGuide.extensionLines.map((points, lineIndex) => (
              <Line
                key={`共面尺寸延伸线-${axisIndex}-${lineIndex}`}
                points={points}
                color={focusedMeshPlanarRegionLoop.color}
                lineWidth={1}
                transparent
                opacity={0.52}
                depthTest={false}
                depthWrite={false}
                renderOrder={17}
              />
            ))
          ))}
          {[focusedMeshPlanarRegionLoop.dimensionGuides.width, focusedMeshPlanarRegionLoop.dimensionGuides.height].flatMap((axisGuide, axisIndex) => (
            axisGuide.capLines.map((points, lineIndex) => (
              <Line
                key={`共面尺寸端点线-${axisIndex}-${lineIndex}`}
                points={points}
                color={focusedMeshPlanarRegionLoop.color}
                lineWidth={1.4}
                transparent
                opacity={0.88}
                depthTest={false}
                depthWrite={false}
                renderOrder={17}
              />
            ))
          ))}
          <Html
            position={focusedMeshPlanarRegionLoop.dimensionGuides.width.label}
            center
            distanceFactor={9}
            calculatePosition={calculateMeshPlanarAxisLabelPosition}
          >
            <div
              className={`mesh-planar-region-axis-dimension-label ${focusedMeshPlanarRegionLoop.loop.kind}`}
              data-layout-index={meshPlanarRegionDimensionLayoutIndex}
            >
              宽度 {focusedMeshPlanarRegionLoop.dimensionGuides.width.valueMm.toFixed(2)} 毫米
            </div>
          </Html>
          <Html
            position={focusedMeshPlanarRegionLoop.dimensionGuides.height.label}
            center
            distanceFactor={9}
            calculatePosition={calculateMeshPlanarAxisLabelPosition}
          >
            <div
              className={`mesh-planar-region-axis-dimension-label ${focusedMeshPlanarRegionLoop.loop.kind}`}
              data-layout-index={meshPlanarRegionDimensionLayoutIndex}
            >
              高度 {focusedMeshPlanarRegionLoop.dimensionGuides.height.valueMm.toFixed(2)} 毫米
            </div>
          </Html>
          <Html
            position={focusedMeshPlanarRegionLoop.dimensionGuides.summaryLabel}
            center
            distanceFactor={9}
            calculatePosition={calculateMeshPlanarSummaryLabelPosition}
          >
            <div
              className={`mesh-planar-region-dimension-label ${focusedMeshPlanarRegionLoop.loop.kind}`}
              data-layout-index={meshPlanarRegionDimensionLayoutIndex}
            >
              <strong>{focusedMeshPlanarRegionLoop.label}</strong>
              <span>周长 {focusedMeshPlanarRegionLoop.loop.perimeterMm.toFixed(2)} 毫米</span>
            </div>
          </Html>
        </>
      )}

      {highlightGeometry && (
        <mesh geometry={highlightGeometry} renderOrder={5}>
          <meshStandardMaterial
            color="#ffbf47"
            emissive="#8a4f00"
            emissiveIntensity={0.9}
            transparent
            opacity={0.72}
            depthTest={false}
          />
        </mesh>
      )}
      {interferenceGeometry && (
        <mesh geometry={interferenceGeometry} renderOrder={6}>
          <meshStandardMaterial
            color="#ef4444"
            emissive="#7f1d1d"
            emissiveIntensity={1.1}
            transparent
            opacity={0.58}
            depthTest={false}
          />
        </mesh>
      )}
      {focusedInterferenceGeometry && (
        <mesh geometry={focusedInterferenceGeometry} renderOrder={7}>
          <meshStandardMaterial
            color="#fff1f2"
            emissive="#fb2c36"
            emissiveIntensity={1.8}
            transparent
            opacity={0.82}
            depthTest={false}
          />
        </mesh>
      )}
      {focusedInterferencePoint && focusedInterferenceRange && (
        <group position={focusedInterferencePoint}>
          <mesh renderOrder={8}>
            <sphereGeometry args={[0.8, 18, 12]} />
            <meshStandardMaterial color="#ffffff" emissive="#ef4444" emissiveIntensity={2} depthTest={false} />
          </mesh>
          <Html position={[0, 2.2, 0]} center distanceFactor={9}>
            <div className="cad-interference-marker-label">
              <strong>当前干涉面</strong>
              <span>{focusedInterferenceRange.stableId}</span>
            </div>
          </Html>
        </group>
      )}
      {selectedEdgeGeometry && (
        <lineSegments geometry={selectedEdgeGeometry} renderOrder={7}>
          <lineBasicMaterial color="#ff5a36" linewidth={3} depthTest={false} />
        </lineSegments>
      )}
      {featurePreviewTransform && (
        <group
          position={featurePreviewTransform.center}
          quaternion={featurePreviewTransform.quaternion}
          renderOrder={8}
        >
          <FeaturePreviewGeometry
            profile={featurePreviewTransform.profile}
            radiusMm={featurePreviewTransform.radiusMm}
            widthMm={featurePreviewTransform.widthMm}
            heightMm={featurePreviewTransform.heightMm}
            lengthMm={featurePreviewTransform.lengthMm}
            depthMm={featurePreviewTransform.depthMm}
            rotationRad={featurePreviewTransform.rotationRad}
            color={featurePreviewTransform.color}
          />
        </group>
      )}
      {cadFaceSelection?.selectionMode === 'click'
        && cadFaceSelection.hit?.partId === cadPart?.id
        && cadFaceSelection.hit
        && (
          <group position={new Vector3(
            cadFaceSelection.hit.pointMm.x,
            cadFaceSelection.hit.pointMm.y,
            cadFaceSelection.hit.pointMm.z
          ).applyMatrix4(coordinateTransform)}>
            <mesh renderOrder={6}>
              <sphereGeometry args={[0.75, 18, 12]} />
              <meshStandardMaterial color="#fff7dc" emissive="#f59e0b" emissiveIntensity={1.6} depthTest={false} />
            </mesh>
            <Html position={[0, 2.2, 0]} center distanceFactor={9}>
              <div className="cad-face-marker-label">
                <strong>{cadPart?.label}</strong>
                <span>{cadFaceSelection.hit.stableId}</span>
              </div>
            </Html>
          </group>
        )}
      {selectedMarker && (
        <group position={selectedMarker.point}>
          <mesh renderOrder={4}>
            <sphereGeometry args={[0.9, 20, 14]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive={WALL_THICKNESS_COLORS[selectedMarker.sample.severity]}
              emissiveIntensity={1.8}
              depthTest={false}
            />
          </mesh>
          <Html position={[0, 2.4, 0]} center distanceFactor={9}>
            <div className="wall-thickness-marker-label">
              <strong>{WALL_THICKNESS_LABELS[selectedMarker.sample.severity]}</strong>
              <span>{selectedMarker.sample.thicknessMm.toFixed(2)} 毫米</span>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

function CadMesh({
  id,
  fileName,
  revision,
  color,
  position,
  preserveCoordinates = false,
  wallThicknessAnalysis,
  snapshotDirectory,
  interactive = true,
  opacity = 1,
  renderOrder = 0,
  cadPart
}: {
  id: SceneObjectId;
  fileName: string;
  revision: string;
  color: string;
  position?: [number, number, number];
  preserveCoordinates?: boolean;
  wallThicknessAnalysis?: WallThicknessAnalysisResult | null;
  snapshotDirectory?: string;
  interactive?: boolean;
  opacity?: number;
  renderOrder?: number;
  cadPart?: CadPartDescriptor;
}) {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let resolvedUrl: string | null = null;
    setSourceUrl(null);
    const resolver = snapshotDirectory
      ? resolveVersionSnapshotModelUrl(snapshotDirectory, fileName)
      : resolveGeneratedModelUrl(fileName, revision);
    void resolver
      .then((url) => {
        if (!active || !url) {
          if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
          return;
        }
        resolvedUrl = url;
        setSourceUrl(url);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSourceUrl(null);
        console.error(`无法加载三维模型文件“${fileName}”`, error);
      });
    return () => {
      active = false;
      if (resolvedUrl?.startsWith('blob:')) URL.revokeObjectURL(resolvedUrl);
    };
  }, [fileName, revision, snapshotDirectory]);

  if (!sourceUrl) return null;
  return (
    <LoadedCadMesh
      id={id}
      sourceUrl={sourceUrl}
      color={color}
      position={position}
      preserveCoordinates={preserveCoordinates}
      wallThicknessAnalysis={wallThicknessAnalysis}
      interactive={interactive}
      opacity={opacity}
      renderOrder={renderOrder}
      cadPart={cadPart}
    />
  );
}

function ReferenceComponent({ parameters }: { parameters: EnclosureParameters }) {
  const selectedObject = useModelStore((state) => state.selectedObject);
  const selectObject = useModelStore((state) => state.selectObject);
  const referencePresentation = useModelStore((state) => state.objectPresentations.reference);
  const referenceColor = normalizeObjectPresentation(referencePresentation, '#147d64').color;
  const pinRows = Array.from({ length: 21 }, (_, index) => index);
  const boardY = parameters.baseThickness + parameters.boardThickness / 2;

  return (
    <group
      position={[parameters.boardOffsetX, boardY, parameters.boardOffsetZ]}
      onClick={(event) => {
        event.stopPropagation();
        selectObject('reference');
      }}
    >
      <mesh castShadow>
        <boxGeometry
          args={[parameters.boardLength, parameters.boardThickness, parameters.boardWidth]}
        />
        <meshStandardMaterial color={selectedObject === 'reference' ? '#f59e0b' : referenceColor} />
      </mesh>
      <mesh position={[-parameters.boardLength / 2 - 1.6, 2.2, 0]} castShadow>
        <boxGeometry args={[5.2, 4.4, 9]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[6, 1.2, 0]} castShadow>
        <boxGeometry args={[18, 2.4, 16]} />
        <meshStandardMaterial color="#334155" metalness={0.5} roughness={0.35} />
      </mesh>
      {pinRows.flatMap((index) => {
        const x = -parameters.boardLength / 2 + 4 + index * ((parameters.boardLength - 8) / 20);
        return [-1, 1].map((side) => (
          <mesh
            key={`${index}-${side}`}
            position={[x, 1.2, side * (parameters.boardWidth / 2 - 1.8)]}
          >
            <boxGeometry args={[0.7, 2.4, 0.7]} />
            <meshStandardMaterial color="#d7a62a" metalness={0.75} roughness={0.3} />
          </mesh>
        ));
      })}
    </group>
  );
}

function DimensionLabel({ parameters }: { parameters: EnclosureParameters }) {
  const dimensions = getOuterDimensions(parameters);
  return (
    <Html position={[0, dimensions.height + 13, 0]} center transform distanceFactor={8}>
      <div className="dimension-label">
        {dimensions.length.toFixed(1)} × {dimensions.width.toFixed(1)} ×{' '}
        {(dimensions.height + parameters.lidThickness).toFixed(1)} 毫米
      </div>
    </Html>
  );
}

function splitPartPosition(
  axis: 'x' | 'y' | 'z',
  direction: -1 | 1,
  exploded: boolean,
  base: [number, number, number]
): [number, number, number] {
  if (!exploded) return base;
  const distance = 10 * direction;
  if (axis === 'x') return [base[0] + distance, base[1], base[2]];
  if (axis === 'y') return [base[0], base[1], base[2] - distance];
  return [base[0], base[1] + distance, base[2]];
}

function assembledPartPosition(
  role: string,
  parameters: EnclosureParameters
): [number, number, number] {
  if (role !== 'cover') return [0, 0, 0];
  return [0, getOuterDimensions(parameters).height - 0.2, 0];
}

function CadFaceBoxSelectionController() {
  const { camera, scene, size } = useThree();
  const request = useModelStore((state) => state.cadFaceBoxRequest);
  const cadResult = useModelStore((state) => state.cadResult);
  const parameters = useModelStore((state) => state.parameters);
  const selectCadFaces = useModelStore((state) => state.selectCadFaces);
  const clearCadFaceSelection = useModelStore((state) => state.clearCadFaceSelection);
  const addAssistantMessage = useModelStore((state) => state.addAssistantMessage);

  useEffect(() => {
    if (!request || !cadResult) return;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    type Candidate = {
      part: CadPartDescriptor;
      face: CadFaceTriangleRange;
      samples: Array<{ x: number; y: number }>;
    };
    const candidates = new Map<string, Candidate>();
    const selectionMeshes: Mesh[] = [];
    const projectedVertices = [new Vector3(), new Vector3(), new Vector3()];
    let candidateLimitReached = false;

    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const selectionData = object.userData.cadFaceSelection as
        | { part: CadPartDescriptor; coordinateTransform: Matrix4 }
        | undefined;
      const mapping = selectionData?.part.faceTessellation;
      const positions = object.geometry.getAttribute('position');
      if (!selectionData || !mapping || !positions) return;
      selectionMeshes.push(object);
      const index = object.geometry.getIndex();
      for (let triangleIndex = 0; triangleIndex < mapping.triangleCount; triangleIndex += 1) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertexIndex = index ? index.getX(triangleIndex * 3 + corner) : triangleIndex * 3 + corner;
          projectedVertices[corner].set(
            positions.getX(vertexIndex),
            positions.getY(vertexIndex),
            positions.getZ(vertexIndex)
          );
          object.localToWorld(projectedVertices[corner]);
          projectedVertices[corner].project(camera);
        }
        if (
          projectedVertices.every((point) => point.z < -1)
          || projectedVertices.every((point) => point.z > 1)
        ) continue;
        const samples = cadTriangleRectangleSamples(
          projectedVertices.map((point) => ({
            x: (point.x + 1) / 2,
            y: (1 - point.y) / 2
          })),
          request.rectangle,
          CAD_FACE_VISIBILITY_SAMPLES
        );
        if (samples.length === 0) continue;
        const face = findCadFaceRangeByTriangleIndex(mapping, triangleIndex);
        if (!face) continue;
        const key = `${selectionData.part.id}:${face.stableId}`;
        const existing = candidates.get(key);
        if (existing) {
          samples.forEach((sample) => {
            if (existing.samples.length >= CAD_FACE_VISIBILITY_SAMPLES) return;
            if (existing.samples.some((current) => Math.hypot(current.x - sample.x, current.y - sample.y) < 1e-5)) return;
            existing.samples.push(sample);
          });
        } else if (candidates.size < CAD_FACE_CANDIDATE_LIMIT) {
          candidates.set(key, {
            part: selectionData.part,
            face,
            samples: samples.slice(0, CAD_FACE_VISIBILITY_SAMPLES)
          });
        } else {
          candidateLimitReached = true;
        }
      }
    });

    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const selected = new Map<string, { part: CadPartDescriptor; face: CadFaceTriangleRange }>();
    for (const [key, candidate] of candidates) {
      const visible = candidate.samples.some((sample) => {
        ndc.set(sample.x * 2 - 1, 1 - sample.y * 2);
        raycaster.setFromCamera(ndc, camera);
        const firstHit = raycaster.intersectObjects(selectionMeshes, false)[0];
        if (!firstHit || !(firstHit.object instanceof Mesh)) return false;
        const firstSelectionData = firstHit.object.userData.cadFaceSelection as
          | { part: CadPartDescriptor; coordinateTransform: Matrix4 }
          | undefined;
        const firstFace = findCadFaceRangeByTriangleIndex(
          firstSelectionData?.part.faceTessellation,
          firstHit.faceIndex
        );
        return Boolean(
          firstSelectionData
          && firstFace
          && `${firstSelectionData.part.id}:${firstFace.stableId}` === key
        );
      });
      if (!visible) continue;
      selected.set(key, { part: candidate.part, face: candidate.face });
      if (selected.size >= CAD_FACE_SELECTION_LIMIT) break;
    }

    if (selected.size === 0) {
      clearCadFaceSelection();
      addAssistantMessage('框选区域内没有找到当前视角可见的精确 CAD 稳定面，请扩大框选范围或旋转视角后重试。');
      return;
    }
    const entries = [...selected.values()];
    const partBoundsMm = Object.fromEntries(
      [...new Map(entries.map(({ part }) => [part.id, part])).values()]
        .map((part) => [part.id, part.metrics.boundsMm])
    );
    const limited = selected.size >= CAD_FACE_SELECTION_LIMIT || candidateLimitReached;
    selectCadFaces({
      protocol: 'FormAI-CAD-局部编辑上下文',
      protocolVersion: 1,
      sourceKind: 'cad-face',
      selectionMode: 'box',
      revision: cadResult.revision,
      units: 'mm',
      partBoundsMm,
      faces: entries.map(({ part, face }) => cadSelectedFaceFromDescriptor(part, face)),
      hit: null,
      camera: cameraSelectionContext(camera, size.width, size.height),
      screenshot: request.screenshot,
      parameters: { ...parameters },
      printer: cadResult.printer,
      warning: `${CAD_FACE_SELECTION_WARNING} 框选只保留当前视角射线可见的面。${limited ? ` 本次候选过多，最多保留 ${CAD_FACE_SELECTION_LIMIT} 个稳定面。` : ''}`
    });
  }, [addAssistantMessage, cadResult, camera, clearCadFaceSelection, parameters, request, scene, selectCadFaces, size.height, size.width]);

  return null;
}


/** 将当前视角框内的上传 STL 同类元素按屏幕投影收集为受限选择集合。 */
function MeshElementBoxSelectionController() {
  const { camera, scene } = useThree();
  const request = useModelStore((state) => state.meshElementBoxRequest);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const selectMeshElements = useModelStore((state) => state.selectMeshElements);
  const clearMeshElementSelection = useModelStore((state) => state.clearMeshElementSelection);
  const addAssistantMessage = useModelStore((state) => state.addAssistantMessage);

  useEffect(() => {
    if (!request || !importedStlModel || meshElementEditMode === 'off') return;
    const selectionRevision = importedStlModel.revision;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    const meshes: Array<Mesh & { userData: { meshElementSelection?: { revision: string; inverseCoordinateTransform: Matrix4 } } }> = [];
    scene.traverse((object) => {
      if (object instanceof Mesh && object.userData.meshElementSelection) meshes.push(object as typeof meshes[number]);
    });

    function* triangles() {
      const localVertices = [new Vector3(), new Vector3(), new Vector3()];
      for (const object of meshes) {
        const selectionData = object.userData.meshElementSelection;
        if (!selectionData || selectionData.revision !== selectionRevision) continue;
        const positions = object.geometry.getAttribute('position');
        if (!positions) continue;
        const index = object.geometry.getIndex();
        const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
          const vertexIndexes = [0, 1, 2].map((corner) => (
            index ? index.getX(triangleIndex * 3 + corner) : triangleIndex * 3 + corner
          ));
          if (vertexIndexes.some((vertexIndex) => vertexIndex < 0 || vertexIndex >= positions.count)) continue;
          vertexIndexes.forEach((vertexIndex, corner) => {
            localVertices[corner].set(
              positions.getX(vertexIndex),
              positions.getY(vertexIndex),
              positions.getZ(vertexIndex)
            );
          });
          yield {
            triangleIndex,
            triangleMm: localVertices.map((vertex) => {
              const source = vertex.clone().applyMatrix4(selectionData.inverseCoordinateTransform);
              return { x: source.x, y: source.y, z: source.z };
            }) as MeshElementSelection['triangleMm'],
            triangleWorld: localVertices.map((vertex) => {
              const world = vertex.clone().applyMatrix4(object.matrixWorld);
              return { x: world.x, y: world.y, z: world.z };
            }) as MeshElementSelection['triangleMm']
          };
        }
      }
    }

    const projected = new Vector3();
    const { selectionSet, limitReached } = collectMeshElementBoxSelection(
      selectionRevision,
      meshElementEditMode,
      request.rectangle,
      triangles(),
      (point) => {
        projected.set(point.x, point.y, point.z).project(camera);
        return {
          x: (projected.x + 1) / 2,
          y: (1 - projected.y) / 2,
          depth: projected.z
        };
      }
    );
    if (!selectionSet) {
      clearMeshElementSelection();
      addAssistantMessage(`框选区域内没有找到${meshElementEditMode === 'vertex' ? '顶点' : meshElementEditMode === 'edge' ? '边' : '三角面'}，请扩大范围或旋转视角后重试。`);
      return;
    }
    selectMeshElements(selectionSet);
    addAssistantMessage(
      `已按当前视角的屏幕投影框选 ${selectionSet.elements.length} 个${meshElementEditMode === 'vertex' ? '顶点' : meshElementEditMode === 'edge' ? '边' : '三角面'}。${limitReached ? ` 候选超过安全上限，本次按网格遍历顺序只保留前 ${MAX_MESH_ELEMENT_SELECTIONS} 个。` : ''}`
    );
  }, [addAssistantMessage, camera, clearMeshElementSelection, importedStlModel, meshElementEditMode, request, scene, selectMeshElements]);

  return null;
}

const PRINT_PLATFORM_OVERLAY_HEIGHTS_MM = {
  platform: 0.05,
  effective: 0.09,
  object: 0.13,
  multiObject: 0.15,
  combined: 0.18,
  highlight: 0.21,
  layout: 0.25
} as const;

/** 在 X/Z 水平面按真实毫米坐标绘制只读打印平台、安全区域和对象占地。 */
interface PrintPlatformOverlayLayerProps {
  spacingDiagnostic: PrintPlatformMultiObjectSpacingDiagnostic | null;
  layoutPlan: PrintPlatformMultiObjectLockedRotationLayoutPlan | null;
  alignmentPlan: PrintPlatformAlignmentPlan | null;
  fixedGapPlan: PrintPlatformFixedGapPlan | null;
}

function PrintPlatformOverlayLayer({ spacingDiagnostic, layoutPlan, alignmentPlan, fixedGapPlan }: PrintPlatformOverlayLayerProps) {
  const overlay = useModelStore((state) => state.printPlatformOverlay);
  const multiObjectPreview = useModelStore((state) => state.printPlatformMultiObjectPreview);
  const bedGuide = resolvePrintPlatformBedGuide(overlay);
  const gridGuide = resolvePrintPlatformGridGuide(overlay);
  if (!overlay || !bedGuide) return null;

  const objectColor = overlay.status === 'inside'
    ? '#35d2cb'
    : overlay.status === 'too-large'
      ? '#ff5f70'
      : '#ff9e45';
  const highlightedSides = (Object.entries(overlay.overflow) as Array<[
    keyof PrintPlatformOverlay['overflow'],
    boolean
  ]>).filter(([, active]) => active);

  return (
    <group>
      <mesh
        position={[bedGuide.centerMm.x, bedGuide.centerMm.y, bedGuide.centerMm.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => undefined}
        renderOrder={18}
      >
        <planeGeometry args={[bedGuide.widthMm, bedGuide.depthMm]} />
        <meshBasicMaterial
          color="#506d82"
          side={DoubleSide}
          transparent
          opacity={0.1}
          depthWrite={false}
        />
      </mesh>
      {gridGuide?.minorLines.map((line) => (
        <Line
          key={`次网格-${line.axis}-${line.coordinateMm}`}
          points={line.points}
          color="#7890a2"
          lineWidth={0.55}
          transparent
          opacity={0.16}
          depthTest={false}
          depthWrite={false}
          raycast={() => undefined}
          renderOrder={18}
        />
      ))}
      {gridGuide?.majorLines.map((line) => (
        <Line
          key={`主网格-${line.axis}-${line.coordinateMm}`}
          points={line.points}
          color="#8aaec4"
          lineWidth={0.95}
          transparent
          opacity={0.34}
          depthTest={false}
          depthWrite={false}
          raycast={() => undefined}
          renderOrder={18}
        />
      ))}
      {gridGuide?.ticks.map((tick) => (
        <Html
          key={`坐标刻度-${tick.axis}-${tick.coordinateMm}`}
          position={[tick.positionMm.x, tick.positionMm.y, tick.positionMm.z]}
          center
          zIndexRange={[3, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div
            className={`print-platform-grid-tick ${tick.axis === 'x' ? 'x-axis' : 'z-axis'}`}
            data-print-platform-grid-tick={tick.text}
            data-axis={tick.axis}
            data-coordinate-mm={tick.coordinateMm}
            aria-hidden="true"
          >
            {tick.text}
          </div>
        </Html>
      ))}
      {bedGuide.centerCrossSegments.map((points, index) => (
        <Line
          key={index === 0 ? '中心横线' : '中心纵线'}
          points={points}
          color="#f0b44c"
          lineWidth={1.8}
          depthTest={false}
          raycast={() => undefined}
          renderOrder={19}
        />
      ))}
      <Html
        position={[
          bedGuide.frontLabelPositionMm.x,
          bedGuide.frontLabelPositionMm.y,
          bedGuide.frontLabelPositionMm.z
        ]}
        center
        zIndexRange={[4, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div className="print-platform-front-label" aria-hidden="true">
          {bedGuide.frontLabel}
        </div>
      </Html>
      <Line
        points={createPrintPlatformRectanglePoints(overlay.platformBoundsMm, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.platform)}
        color="#7e96aa"
        lineWidth={1.25}
        dashed
        dashSize={3}
        gapSize={2}
        depthTest={false}
        renderOrder={20}
      />
      <Line
        points={createPrintPlatformRectanglePoints(overlay.effectiveBoundsMm, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.effective)}
        color="#68c58b"
        lineWidth={1.8}
        dashed
        dashSize={7}
        gapSize={2.5}
        depthTest={false}
        renderOrder={21}
      />
      <Line
        points={createPrintPlatformRectanglePoints(overlay.objectBoundsMm, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.object)}
        color={objectColor}
        lineWidth={2.5}
        depthTest={false}
        raycast={() => undefined}
        renderOrder={22}
      />
      {multiObjectPreview?.objects.map((object, index) => (
        <Line
          key={`多对象占地-${object.sourceIdentity}`}
          points={createPrintPlatformRectanglePoints(
            object.boundsMm,
            PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.multiObject + index * 0.002
          )}
          color={['#58a6ff', '#c77dff', '#4dd4ac', '#ffd166', '#f78c6c'][index % 5]}
          lineWidth={1.35}
          dashed
          dashSize={4}
          gapSize={2}
          transparent
          opacity={0.78}
          depthTest={false}
          depthWrite={false}
          raycast={() => undefined}
          renderOrder={23}
        />
      ))}
      {multiObjectPreview?.combinedBoundsMm && (
        <Line
          points={createPrintPlatformRectanglePoints(
            multiObjectPreview.combinedBoundsMm,
            PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.combined
          )}
          color="#e8d067"
          lineWidth={2.7}
          dashed
          dashSize={8}
          gapSize={2.5}
          depthTest={false}
          depthWrite={false}
          raycast={() => undefined}
          renderOrder={24}
        />
      )}
      {spacingDiagnostic?.pairs.filter((pair) => pair.status !== 'safe').map((pair) => (
        pair.overlapBoundsMm ? (
          <Line
            key={`对象重叠-${pair.sourceIdentity}`}
            points={createPrintPlatformRectanglePoints(
              pair.overlapBoundsMm,
              PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.highlight + 0.01
            )}
            color="#ff5f70"
            lineWidth={4}
            dashed
            dashSize={3}
            gapSize={1.5}
            depthTest={false}
            depthWrite={false}
            raycast={() => undefined}
            renderOrder={26}
          />
        ) : (
          <Line
            key={`对象间距不足-${pair.sourceIdentity}`}
            points={[
              [pair.connectionStartMm.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.highlight + 0.01, pair.connectionStartMm.z],
              [pair.connectionEndMm.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.highlight + 0.01, pair.connectionEndMm.z]
            ]}
            color="#ff9e45"
            lineWidth={3.2}
            dashed
            dashSize={1.5}
            gapSize={1}
            depthTest={false}
            depthWrite={false}
            raycast={() => undefined}
            renderOrder={26}
          />
        )
      ))}
      {layoutPlan?.status === 'ready' && layoutPlan.placements.map((placement, index) => {
        const currentCenter = {
          x: (placement.currentBoundsMm.minimumX + placement.currentBoundsMm.maximumX) / 2,
          z: (placement.currentBoundsMm.minimumZ + placement.currentBoundsMm.maximumZ) / 2
        };
        const targetCenter = {
          x: (placement.targetBoundsMm.minimumX + placement.targetBoundsMm.maximumX) / 2,
          z: (placement.targetBoundsMm.minimumZ + placement.targetBoundsMm.maximumZ) / 2
        };
        const orientationLengthMm = Math.max(3, Math.min(
          placement.targetBoundsMm.maximumX - placement.targetBoundsMm.minimumX,
          placement.targetBoundsMm.maximumZ - placement.targetBoundsMm.minimumZ
        ) * 0.38);
        const orientationRadians = placement.targetRotationYDeg * Math.PI / 180;
        const orientationEnd = {
          x: targetCenter.x + Math.cos(orientationRadians) * orientationLengthMm,
          z: targetCenter.z - Math.sin(orientationRadians) * orientationLengthMm
        };
        return (
          <group key={`自动排布目标-${placement.sourceIdentity}`}>
            <Line
              points={createPrintPlatformRectanglePoints(
                placement.targetBoundsMm,
                PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + index * 0.002
              )}
              color={placement.locked ? '#9aa4ad' : '#69e3ff'}
              lineWidth={placement.locked ? 2.2 : 2.8}
              dashed
              dashSize={5}
              gapSize={1.8}
              transparent
              opacity={0.92}
              depthTest={false}
              depthWrite={false}
              raycast={() => undefined}
              renderOrder={27}
            />
            <Line
              points={[
                [targetCenter.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.018, targetCenter.z],
                [orientationEnd.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.018, orientationEnd.z]
              ]}
              color={placement.locked ? '#9aa4ad' : placement.rotated ? '#ffb65c' : '#b9f3ff'}
              lineWidth={placement.locked ? 2 : placement.rotated ? 3 : 2.2}
              transparent
              opacity={0.94}
              depthTest={false}
              depthWrite={false}
              raycast={() => undefined}
              renderOrder={28}
            />
            {placement.moved && (
              <Line
                points={[
                  [currentCenter.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.01, currentCenter.z],
                  [targetCenter.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.01, targetCenter.z]
                ]}
                color="#69e3ff"
                lineWidth={1.8}
                dashed
                dashSize={2}
                gapSize={1.2}
                transparent
                opacity={0.76}
                depthTest={false}
                depthWrite={false}
                raycast={() => undefined}
                renderOrder={27}
              />
            )}
          </group>
        );
      })}
      {alignmentPlan?.placements.filter((placement) => placement.selected).map((placement, index) => {
        const color = placement.status === 'valid'
          ? placement.reference ? '#ffd166' : '#69e3ff'
          : '#ff5f70';
        return (
          <group key={`对齐分布目标-${placement.sourceIdentity}`}>
            <Line
              points={createPrintPlatformRectanglePoints(
                placement.targetBoundsMm,
                PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.04 + index * 0.002
              )}
              color={color}
              lineWidth={placement.reference ? 3.3 : placement.status === 'valid' ? 2.8 : 4}
              dashed
              dashSize={placement.reference ? 7 : 5}
              gapSize={1.6}
              transparent
              opacity={0.94}
              depthTest={false}
              depthWrite={false}
              raycast={() => undefined}
              renderOrder={29}
            />
            {placement.moved && (
              <Line
                points={[
                  [placement.currentCenterMm.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.05, placement.currentCenterMm.z],
                  [placement.targetCenterMm.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.05, placement.targetCenterMm.z]
                ]}
                color={color}
                lineWidth={2}
                dashed
                dashSize={2}
                gapSize={1.2}
                transparent
                opacity={0.82}
                depthTest={false}
                depthWrite={false}
                raycast={() => undefined}
                renderOrder={30}
              />
            )}
          </group>
        );
      })}
      {fixedGapPlan?.placements.filter((placement) => placement.selected).map((placement, index) => {
        const color = placement.status === 'valid'
          ? placement.fixedAnchor ? '#ffd166' : '#69e3ff'
          : '#ff5f70';
        return (
          <group key={`固定净间距目标-${placement.sourceIdentity}`}>
            <Line
              points={createPrintPlatformRectanglePoints(
                placement.targetBoundsMm,
                PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.07 + index * 0.002
              )}
              color={color}
              lineWidth={placement.fixedAnchor ? 3.3 : placement.status === 'valid' ? 2.8 : 4}
              dashed
              dashSize={placement.fixedAnchor ? 7 : 5}
              gapSize={1.6}
              transparent
              opacity={0.94}
              depthTest={false}
              depthWrite={false}
              raycast={() => undefined}
              renderOrder={31}
            />
            {placement.moved && (
              <Line
                points={[
                  [placement.currentCenterMm.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.08, placement.currentCenterMm.z],
                  [placement.targetCenterMm.x, PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.08, placement.targetCenterMm.z]
                ]}
                color={color}
                lineWidth={2}
                dashed
                dashSize={2}
                gapSize={1.2}
                transparent
                opacity={0.82}
                depthTest={false}
                depthWrite={false}
                raycast={() => undefined}
                renderOrder={32}
              />
            )}
          </group>
        );
      })}
      {highlightedSides.map(([side]) => (
        <Line
          key={side}
          points={createPrintPlatformBoundarySegment(
            overlay.effectiveBoundsMm,
            side,
            PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.highlight
          )}
          color={overlay.status === 'too-large' ? '#ff475d' : '#ff7b3e'}
          lineWidth={4}
          depthTest={false}
          raycast={() => undefined}
          renderOrder={25}
        />
      ))}
    </group>
  );
}

interface PrintPlatformManualLayoutDragLayerProps {
  session: PrintPlatformManualLayoutSession | null;
  onMoveObject: (objectId: string, centerMm: PrintPlatformManualLayoutPoint) => void;
}

/** 在平台平面上接收拖动，只回传临时中心坐标；模型对象本身直到确认前都不会移动。 */
function PrintPlatformManualLayoutDragLayer({
  session,
  onMoveObject
}: PrintPlatformManualLayoutDragLayerProps) {
  const draggingObjectId = useRef<string | null>(null);
  const dragOffsetMm = useRef<PrintPlatformManualLayoutPoint>({ x: 0, z: 0 });
  const dragPlane = useMemo(() => new Plane(new Vector3(0, 1, 0), -0.38), []);

  if (!session) return null;

  const planePoint = (event: ThreeEvent<PointerEvent>) => {
    const point = event.ray.intersectPlane(dragPlane, new Vector3());
    return point ? { x: point.x, z: point.z } : null;
  };

  const releasePointer = (event: ThreeEvent<PointerEvent>) => {
    draggingObjectId.current = null;
    const target = event.target as EventTarget & { releasePointerCapture?: (pointerId: number) => void };
    target.releasePointerCapture?.(event.pointerId);
  };

  return (
    <group>
      {session.placements.map((placement, index) => {
        const widthMm = placement.targetBoundsMm.maximumX - placement.targetBoundsMm.minimumX;
        const depthMm = placement.targetBoundsMm.maximumZ - placement.targetBoundsMm.minimumZ;
        const center = placement.targetCenterMm;
        const valid = placement.status === 'valid';
        const color = placement.locked ? '#9aa4ad' : valid ? '#69e3ff' : '#ff5f70';
        return (
          <group key={`手工排布拖动-${placement.objectId}`}>
            <Line
              points={createPrintPlatformRectanglePoints(
                placement.targetBoundsMm,
                PRINT_PLATFORM_OVERLAY_HEIGHTS_MM.layout + 0.08 + index * 0.002
              )}
              color={color}
              lineWidth={placement.locked ? 2 : valid ? 3.2 : 4}
              dashed
              dashSize={placement.locked ? 3 : 5}
              gapSize={1.5}
              depthTest={false}
              depthWrite={false}
              raycast={() => undefined}
              renderOrder={31}
            />
            <mesh
              position={[center.x, 0.38, center.z]}
              rotation={[-Math.PI / 2, 0, 0]}
              renderOrder={30}
              onPointerDown={placement.locked ? undefined : (event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                const point = planePoint(event);
                if (!point) return;
                draggingObjectId.current = placement.objectId;
                dragOffsetMm.current = {
                  x: placement.targetCenterMm.x - point.x,
                  z: placement.targetCenterMm.z - point.z
                };
                const target = event.target as EventTarget & { setPointerCapture?: (pointerId: number) => void };
                target.setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={placement.locked ? undefined : (event) => {
                if (draggingObjectId.current !== placement.objectId) return;
                event.stopPropagation();
                const point = planePoint(event);
                if (!point) return;
                onMoveObject(placement.objectId, {
                  x: point.x + dragOffsetMm.current.x,
                  z: point.z + dragOffsetMm.current.z
                });
              }}
              onPointerUp={placement.locked ? undefined : (event) => {
                event.stopPropagation();
                releasePointer(event);
              }}
              onPointerCancel={placement.locked ? undefined : releasePointer}
            >
              <planeGeometry args={[Math.max(widthMm, 2), Math.max(depthMm, 2)]} />
              <meshBasicMaterial
                color={color}
                side={DoubleSide}
                transparent
                opacity={placement.locked ? 0.035 : valid ? 0.12 : 0.2}
                depthTest={false}
                depthWrite={false}
              />
            </mesh>
            <Html
              position={[center.x, 0.52, center.z]}
              center
              zIndexRange={[8, 0]}
              style={{ pointerEvents: 'none' }}
            >
              <span
                className={`print-platform-manual-object-label is-${placement.status}${placement.locked ? ' is-locked' : ''}`}
                data-print-platform-manual-object={placement.objectId}
                data-print-platform-manual-status={placement.status}
                data-print-platform-manual-x={placement.targetCenterMm.x}
                data-print-platform-manual-z={placement.targetCenterMm.z}
              >
                {placement.objectLabel}{placement.locked ? ' · 已锁定' : ''}
              </span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function printPlatformOverlayStatusText(overlay: PrintPlatformOverlay) {
  if (overlay.status === 'inside') return `“${overlay.objectLabel}”位于安全有效区域`;
  if (overlay.status === 'too-large') {
    return `“${overlay.objectLabel}”尺寸大于安全有效区域，无法仅靠平移修正`;
  }
  return `“${overlay.objectLabel}”超出安全有效区域`;
}

function printPlatformOverflowDescriptions(overlay: PrintPlatformOverlay) {
  const labels: Array<[keyof PrintPlatformOverlay['overflow'], string]> = [
    ['left', '左侧'],
    ['right', '右侧'],
    ['front', '前侧'],
    ['back', '后侧']
  ];
  return labels
    .filter(([side]) => overlay.overflow[side])
    .map(([side, label]) => `${label}越界 ${overlay.overflowMm[side].toFixed(2)} 毫米`);
}

function printPlatformMultiObjectStatusText(preview: PrintPlatformMultiObjectPreview) {
  if (!preview.combinedBoundsMm) return '当前装配没有可计算占地的可打印对象';
  if (preview.combinedStatus === 'inside') return '整体联合占地位于安全有效区域';
  if (preview.combinedStatus === 'too-large') return '整体联合占地尺寸大于安全有效区域';
  if (preview.combinedFitsPlatform) return '整体位于物理平台，但超出安全有效区域';
  return '整体联合占地超出物理打印平台';
}

function printPlatformObjectFootprintStatusText(
  object: PrintPlatformMultiObjectPreview['objects'][number]
) {
  const size = `${object.widthMm.toFixed(2)} × ${object.depthMm.toFixed(2)} 毫米`;
  if (object.fitsEffectiveArea) return `${object.objectLabel}：${size}，位于安全区域`;
  if (object.status === 'too-large') return `${object.objectLabel}：${size}，尺寸过大`;
  if (object.fitsPlatform) return `${object.objectLabel}：${size}，超出安全区域`;
  return `${object.objectLabel}：${size}，超出物理平台`;
}

function printPlatformSpacingStatusText(diagnostic: PrintPlatformMultiObjectSpacingDiagnostic) {
  if (diagnostic.status === 'empty') return '可打印对象少于 2 个，无需执行对象间距诊断';
  if (diagnostic.status === 'overlap') {
    return `发现 ${diagnostic.overlapCount} 组对象水平占地重叠`;
  }
  if (diagnostic.status === 'too-close') {
    return `发现 ${diagnostic.tooCloseCount} 组对象间距不足`;
  }
  return `全部 ${diagnostic.pairCount} 组对象对均满足安全间距`;
}

function printPlatformSpacingPairText(pair: PrintPlatformObjectPairDiagnostic) {
  const labels = `${pair.firstObjectLabel} ↔ ${pair.secondObjectLabel}`;
  if (pair.status === 'overlap') {
    return `${labels}：重叠 ${pair.overlapXMm.toFixed(2)} × ${pair.overlapZMm.toFixed(2)} 毫米（${pair.overlapAreaMm2.toFixed(2)} 平方毫米），至少还需分离 ${pair.requiredAdditionalMm.toFixed(2)} 毫米`;
  }
  if (pair.status === 'too-close') {
    return `${labels}：当前最近间距 ${pair.distanceMm.toFixed(2)} 毫米，还需增加 ${pair.requiredAdditionalMm.toFixed(2)} 毫米`;
  }
  return `${labels}：最近间距 ${pair.distanceMm.toFixed(2)} 毫米，满足要求`;
}

function printPlatformLayoutStatusText(plan: PrintPlatformMultiObjectLockedRotationLayoutPlan) {
  if (plan.status === 'empty') return '当前没有可排布的打印对象';
  if (plan.status === 'unplaceable') return '当前安全有效区域无法生成完整排布方案';
  if (plan.changedObjectCount === 0) return `全部 ${plan.objectCount} 个对象已位于最优位置和角度`;
  return `已生成 ${plan.objectCount} 个对象、${plan.rowCount} 行的候选排布，其中 ${plan.movedObjectCount} 个对象需要移动、${plan.rotatedObjectCount} 个对象需要绕 Y 轴旋转 90 度`;
}

function printPlatformLayoutPlacementText(placement: PrintPlatformObjectLockedRotationLayoutPlacement) {
  if (placement.locked) return `${placement.objectLabel}：已锁定，保持当前位置和 Y 轴 ${placement.currentRotationYDeg.toFixed(2)}°`;
  if (!placement.changed) return `${placement.objectLabel}：保持当前位置和 Y 轴 ${placement.currentRotationYDeg.toFixed(2)}°`;
  const x = Math.abs(placement.deltaMm.x) <= 1e-4
    ? 'X 轴不移动'
    : `沿 X 轴${placement.deltaMm.x > 0 ? '正' : '负'}方向 ${Math.abs(placement.deltaMm.x).toFixed(2)} 毫米`;
  const z = Math.abs(placement.deltaMm.z) <= 1e-4
    ? 'Z 轴不移动'
    : `沿 Z 轴${placement.deltaMm.z > 0 ? '正' : '负'}方向 ${Math.abs(placement.deltaMm.z).toFixed(2)} 毫米`;
  const rotation = placement.rotated
    ? `绕 Y 轴从 ${placement.currentRotationYDeg.toFixed(2)}° 调整为 ${placement.targetRotationYDeg.toFixed(2)}°（+90°）`
    : `保持 Y 轴 ${placement.currentRotationYDeg.toFixed(2)}°`;
  const target = `目标占地 X ${placement.targetBoundsMm.minimumX.toFixed(2)} 至 ${placement.targetBoundsMm.maximumX.toFixed(2)} 毫米、Z ${placement.targetBoundsMm.minimumZ.toFixed(2)} 至 ${placement.targetBoundsMm.maximumZ.toFixed(2)} 毫米`;
  return `${placement.objectLabel}：${x}，${z}，水平位移 ${placement.distanceMm.toFixed(2)} 毫米；${rotation}；${target}`;
}

function printPlatformAlignmentOperationText(operation: PrintPlatformAlignmentOperation) {
  return {
    'align-x-min': 'X 轴左边界对齐',
    'align-x-center': 'X 轴中心对齐',
    'align-x-max': 'X 轴右边界对齐',
    'align-z-min': 'Z 轴后边界对齐',
    'align-z-center': 'Z 轴中心对齐',
    'align-z-max': 'Z 轴前边界对齐',
    'distribute-x-centers': 'X 轴中心等距分布',
    'distribute-z-centers': 'Z 轴中心等距分布'
  }[operation];
}

function printPlatformAlignmentStatusText(plan: PrintPlatformAlignmentPlan) {
  if (plan.status === 'invalid') return `当前${printPlatformAlignmentOperationText(plan.operation)}预览存在 ${plan.invalidObjectCount} 个非法目标`;
  if (plan.changedObjectCount === 0) return plan.failureReason ?? '当前操作不会改变任何已选对象的位置';
  return `已为 ${plan.selectedObjectCount} 个对象生成${printPlatformAlignmentOperationText(plan.operation)}预览，其中 ${plan.changedObjectCount} 个对象需要移动`;
}

function printPlatformAlignmentPlacementText(placement: PrintPlatformAlignmentPlacement) {
  const role = placement.reference
    ? '基准对象'
    : placement.distributionEndpoint
      ? '分布端点，中心保持不动'
      : placement.moved ? '需要移动' : '位置保持不动';
  const target = `目标中心 X ${placement.targetCenterMm.x.toFixed(2)}、Z ${placement.targetCenterMm.z.toFixed(2)} 毫米`;
  const delta = `位移 X ${placement.deltaMm.x.toFixed(2)}、Z ${placement.deltaMm.z.toFixed(2)} 毫米`;
  return `${placement.objectLabel}：${role}；${target}；${delta}${placement.failureReason ? `；${placement.failureReason}` : '；位置合法'}`;
}

function printPlatformFixedGapOperationText(operation: PrintPlatformFixedGapOperation) {
  return operation === 'distribute-x-fixed-gap' ? 'X 轴固定净间距分布' : 'Z 轴固定净间距分布';
}

function printPlatformFixedGapAnchorModeText(anchorMode: PrintPlatformFixedGapAnchorMode) {
  if (anchorMode === 'keep-first') return '保持首对象不动';
  if (anchorMode === 'keep-last') return '保持末对象不动';
  return '指定对象不动';
}

function printPlatformFixedGapAnchorObjectText(plan: PrintPlatformFixedGapPlan) {
  return plan.placements.find((placement) => placement.objectId === plan.anchorObjectId)?.objectLabel ?? '未解析';
}

function printPlatformFixedGapVersionAnchorText(plan: PrintPlatformFixedGapPlan) {
  return plan.anchorMode === 'keep-selected'
    ? `指定“${printPlatformFixedGapAnchorObjectText(plan)}”不动`
    : printPlatformFixedGapAnchorModeText(plan.anchorMode);
}

function printPlatformFixedGapStatusText(plan: PrintPlatformFixedGapPlan) {
  if (plan.status === 'invalid') return `当前${printPlatformFixedGapOperationText(plan.operation)}预览存在 ${plan.invalidObjectCount} 个非法目标`;
  if (plan.changedObjectCount === 0) return plan.failureReason ?? '当前固定净间距分布不会改变任何已选对象的位置';
  return `已按 ${plan.targetGapMm.toFixed(2)} 毫米目标净间距生成预览，其中 ${plan.changedObjectCount} 个对象需要移动`;
}

function printPlatformFixedGapPlacementText(placement: PrintPlatformFixedGapPlacement) {
  const sequence = placement.sequenceIndex === null ? '未参与分布' : `空间序号 ${placement.sequenceIndex + 1}`;
  const role = placement.fixedAnchor ? '固定锚点，中心保持不动' : placement.moved ? '需要移动' : '位置保持不动';
  const previousGap = placement.previousGapMm === null ? '无前一对象净间距' : `与前一对象净间距 ${placement.previousGapMm.toFixed(2)} 毫米`;
  const target = `目标中心 X ${placement.targetCenterMm.x.toFixed(2)}、Z ${placement.targetCenterMm.z.toFixed(2)} 毫米`;
  const delta = `位移 X ${placement.deltaMm.x.toFixed(2)}、Z ${placement.deltaMm.z.toFixed(2)} 毫米`;
  return `${placement.objectLabel}：${sequence}；${role}；${previousGap}；${target}；${delta}${placement.failureReason ? `；${placement.failureReason}` : '；位置合法'}`;
}

function printPlatformManualLayoutStatusText(session: PrintPlatformManualLayoutSession) {
  if (session.invalidObjectCount > 0) {
    return `当前有 ${session.invalidObjectCount} 个对象越界或与其他对象冲突，修正前不能确认`;
  }
  if (session.changedObjectCount === 0) return '拖动青色对象边界以设置临时位置，当前尚无位置变化';
  return `已有 ${session.changedObjectCount} 个对象形成合法临时位置，可以一次确认全部变化`;
}

function printPlatformManualLayoutPlacementText(placement: PrintPlatformManualLayoutPlacement) {
  if (placement.locked) return `${placement.objectLabel}：已锁定，不可拖动`;
  const raw = `吸附前 X ${placement.rawCenterMm.x.toFixed(2)}、Z ${placement.rawCenterMm.z.toFixed(2)} 毫米`;
  const target = `目标 X ${placement.targetCenterMm.x.toFixed(2)}、Z ${placement.targetCenterMm.z.toFixed(2)} 毫米`;
  const delta = `位移 X ${placement.deltaMm.x.toFixed(2)}、Z ${placement.deltaMm.z.toFixed(2)} 毫米`;
  return `${placement.objectLabel}：${raw}；${target}；${delta}${placement.failureReason ? `；${placement.failureReason}` : '；位置合法'}`;
}

interface PrintPlatformCameraControllerProps {
  request: PrintPlatformViewRequest | null;
  onReturnSnapshotSourceChange: (sourceIdentity: string | null) => void;
}

interface ViewportOrbitControls {
  target: Vector3;
  update: () => void;
}

function viewportOrbitControls(value: unknown): ViewportOrbitControls | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ViewportOrbitControls>;
  if (!(candidate.target instanceof Vector3) || typeof candidate.update !== 'function') return null;
  return candidate as ViewportOrbitControls;
}

/** 平滑执行打印平台俯视或返回请求，不把相机状态写入模型、版本或撤销栈。 */
function PrintPlatformCameraController({
  request,
  onReturnSnapshotSourceChange
}: PrintPlatformCameraControllerProps) {
  const currentOverlay = useModelStore((state) => state.printPlatformOverlay);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const controls = useThree((state) => state.controls);
  const handledRequestKey = useRef<string | null>(null);
  const returnSnapshot = useRef<PrintPlatformReturnSnapshot | null>(null);
  const animation = useRef<{
    sourceIdentity: string;
    elapsedSeconds: number;
    durationSeconds: number;
    startPosition: Vector3;
    endPosition: Vector3;
    startTarget: Vector3;
    endTarget: Vector3;
    clearReturnSnapshotOnComplete: boolean;
  } | null>(null);

  const clearReturnSnapshot = () => {
    if (!returnSnapshot.current) return;
    returnSnapshot.current = null;
    onReturnSnapshotSourceChange(null);
  };

  useEffect(() => {
    if (
      returnSnapshot.current
      && (!currentOverlay || returnSnapshot.current.sourceIdentity !== currentOverlay.sourceIdentity)
    ) {
      returnSnapshot.current = null;
      onReturnSnapshotSourceChange(null);
    }
  }, [currentOverlay?.sourceIdentity, onReturnSnapshotSourceChange]);

  useFrame((_, deltaSeconds) => {
    const orbitControls = viewportOrbitControls(controls);
    const requestKey = request ? `${request.kind}\u0000${request.sourceIdentity}\u0000${request.id}` : null;
    if (request && requestKey !== handledRequestKey.current && orbitControls) {
      handledRequestKey.current = requestKey;
      if (request.kind === 'top-view') {
        const verticalFovDeg = 'fov' in camera && typeof camera.fov === 'number' ? camera.fov : 34;
        try {
          const view = resolvePrintPlatformTopViewRequest(
            request,
            currentOverlay,
            { widthPx: size.width, heightPx: size.height },
            verticalFovDeg
          );
          if (!view) {
            animation.current = null;
          } else {
            const previousSnapshot = returnSnapshot.current;
            const nextSnapshot = capturePrintPlatformReturnSnapshot(
              previousSnapshot,
              view.sourceIdentity,
              {
                cameraPositionMm: {
                  x: camera.position.x,
                  y: camera.position.y,
                  z: camera.position.z
                },
                targetMm: {
                  x: orbitControls.target.x,
                  y: orbitControls.target.y,
                  z: orbitControls.target.z
                }
              }
            );
            returnSnapshot.current = nextSnapshot;
            if (nextSnapshot !== previousSnapshot) {
              onReturnSnapshotSourceChange(nextSnapshot.sourceIdentity);
            }
            animation.current = {
              sourceIdentity: view.sourceIdentity,
              elapsedSeconds: 0,
              durationSeconds: 0.46,
              startPosition: camera.position.clone(),
              endPosition: new Vector3(
                view.cameraPositionMm.x,
                view.cameraPositionMm.y,
                view.cameraPositionMm.z
              ),
              startTarget: orbitControls.target.clone(),
              endTarget: new Vector3(view.targetMm.x, view.targetMm.y, view.targetMm.z),
              clearReturnSnapshotOnComplete: false
            };
            if ('far' in camera && typeof camera.far === 'number' && camera.far < view.distanceMm * 4) {
              camera.far = Math.max(5000, view.distanceMm * 4);
              if ('updateProjectionMatrix' in camera && typeof camera.updateProjectionMatrix === 'function') {
                camera.updateProjectionMatrix();
              }
            }
          }
        } catch {
          animation.current = null;
        }
      } else {
        const snapshot = resolvePrintPlatformReturnSnapshot(returnSnapshot.current, currentOverlay);
        animation.current = snapshot && snapshot.sourceIdentity === request.sourceIdentity
          ? {
              sourceIdentity: snapshot.sourceIdentity,
              elapsedSeconds: 0,
              durationSeconds: 0.46,
              startPosition: camera.position.clone(),
              endPosition: new Vector3(
                snapshot.cameraPositionMm.x,
                snapshot.cameraPositionMm.y,
                snapshot.cameraPositionMm.z
              ),
              startTarget: orbitControls.target.clone(),
              endTarget: new Vector3(snapshot.targetMm.x, snapshot.targetMm.y, snapshot.targetMm.z),
              clearReturnSnapshotOnComplete: true
            }
          : null;
      }
    }

    const active = animation.current;
    if (!active || !orbitControls) return;
    if (!currentOverlay || currentOverlay.sourceIdentity !== active.sourceIdentity) {
      animation.current = null;
      clearReturnSnapshot();
      return;
    }
    active.elapsedSeconds += Math.min(deltaSeconds, 0.1);
    const progress = Math.min(1, active.elapsedSeconds / active.durationSeconds);
    const easedProgress = 1 - (1 - progress) ** 3;
    camera.position.lerpVectors(active.startPosition, active.endPosition, easedProgress);
    orbitControls.target.lerpVectors(active.startTarget, active.endTarget, easedProgress);
    orbitControls.update();
    if (progress >= 1) {
      animation.current = null;
      if (active.clearReturnSnapshotOnComplete) clearReturnSnapshot();
    }
  });

  return null;
}

interface ModelSceneProps {
  printPlatformViewRequest: PrintPlatformViewRequest | null;
  printPlatformSpacingDiagnostic: PrintPlatformMultiObjectSpacingDiagnostic | null;
  printPlatformLayoutPlan: PrintPlatformMultiObjectLockedRotationLayoutPlan | null;
  printPlatformAlignmentPlan: PrintPlatformAlignmentPlan | null;
  printPlatformFixedGapPlan: PrintPlatformFixedGapPlan | null;
  printPlatformManualLayoutSession: PrintPlatformManualLayoutSession | null;
  onMovePrintPlatformManualObject: (objectId: string, centerMm: PrintPlatformManualLayoutPoint) => void;
  onPrintPlatformReturnSnapshotSourceChange: (sourceIdentity: string | null) => void;
}

function ModelScene({
  printPlatformViewRequest,
  printPlatformSpacingDiagnostic,
  printPlatformLayoutPlan,
  printPlatformAlignmentPlan,
  printPlatformFixedGapPlan,
  printPlatformManualLayoutSession,
  onMovePrintPlatformManualObject,
  onPrintPlatformReturnSnapshotSourceChange
}: ModelSceneProps) {
  const parameters = useModelStore((state) => state.parameters);
  const exploded = useModelStore((state) => state.exploded);
  const showBoard = useModelStore((state) => state.showBoard);
  const selectObject = useModelStore((state) => state.selectObject);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const cadResult = useModelStore((state) => state.cadResult);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const wallThicknessResult = useModelStore((state) => state.wallThicknessResult);
  const wallThicknessVisible = useModelStore((state) => state.wallThicknessVisible);
  const versions = useModelStore((state) => state.versions);
  const versionGeometryComparisonMode = useModelStore((state) => state.versionGeometryComparisonMode);
  const versionGeometryComparisonBaseId = useModelStore((state) => state.versionGeometryComparisonBaseId);
  const versionGeometryComparisonSnapshot = useModelStore((state) => state.versionGeometryComparisonSnapshot);
  const versionGeometryDifferenceResult = useModelStore((state) => state.versionGeometryDifferenceResult);
  const versionGeometryComparisonStatus = useModelStore((state) => state.versionGeometryComparisonStatus);
  const cadFaceSelectionMode = useModelStore((state) => state.cadFaceSelectionMode);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const meshElementSelectionMethod = useModelStore((state) => state.meshElementSelectionMethod);
  const cadFaceSelection = useModelStore((state) => state.cadFaceSelection);
  const localCadFeaturePreview = useModelStore((state) => state.localCadFeaturePreview);
  const bodyGeometry = useMemo(() => createTrayGeometry(parameters), [parameters]);
  const coverGeometry = useMemo(() => createLidGeometry(parameters), [parameters]);
  const dimensions = getOuterDimensions(parameters);
  const coverBottomY = exploded ? dimensions.height + 18 : dimensions.height - 0.2;
  const coverCenterY = coverBottomY + parameters.lidThickness / 2;
  const showUploadedStl = viewportModelSource === 'uploaded-stl' && importedStlModel !== null;
  const showCad = viewportModelSource === 'cad' && cadResult !== null;
  const uploadedBounds = importedStlModel?.metrics.boundsMm;
  const uploadedGroupPosition: [number, number, number] = uploadedBounds
    ? [
        -(uploadedBounds.minX + uploadedBounds.maxX) / 2,
        -uploadedBounds.minZ,
        (uploadedBounds.minY + uploadedBounds.maxY) / 2
      ]
    : [0, 0, 0];
  const comparisonBaseVersion = versions.find(
    (version) => version.id === versionGeometryComparisonBaseId
  ) ?? null;
  const comparisonSnapshotDirectory = comparisonBaseVersion?.snapshotDirectory ?? null;
  const visualComparisonActive = Boolean(versionGeometryComparisonStatus === 'ready'
    && (versionGeometryComparisonMode === 'overlay' || versionGeometryComparisonMode === 'side-by-side')
    && versionGeometryComparisonSnapshot !== null
    && comparisonSnapshotDirectory
    && cadResult !== null);
  const differenceActive = Boolean(versionGeometryComparisonStatus === 'ready'
    && versionGeometryComparisonMode === 'difference'
    && versionGeometryComparisonSnapshot !== null
    && versionGeometryDifferenceResult !== null
    && cadResult !== null);
  const comparisonOffsets = useMemo(
    () => calculateVersionComparisonOffsets(
      versionGeometryComparisonSnapshot,
      cadResult,
      versionGeometryComparisonMode
    ),
    [cadResult, versionGeometryComparisonMode, versionGeometryComparisonSnapshot]
  );

  useEffect(
    () => () => {
      bodyGeometry.dispose();
      coverGeometry.dispose();
    },
    [bodyGeometry, coverGeometry]
  );

  const partPosition = (role: string): [number, number, number] =>
    role === 'cover' ? [0, coverBottomY, 0] : [0, 0, 0];
  const exactFeaturePreview = useMemo(() => {
    const preview = localCadFeaturePreview;
    const preflight = preview?.preflight;
    const selectedFace = cadFaceSelection?.faces[0];
    const targetPart = preview && cadResult
      ? cadResult.parts.find((part) => part.id === preview.request.partId)
      : null;
    if (
      !preview
      || !preflight?.previewFile
      || !cadResult
      || !targetPart
      || preview.request.selectionRevision !== cadResult.revision
      || preflight.revision !== cadResult.revision
      || preflight.partId !== preview.request.partId
      || preflight.stableFaceId !== preview.request.stableFaceId
      || selectedFace?.partId !== preview.request.partId
      || selectedFace.stableId !== preview.request.stableFaceId
    ) return null;
    return {
      fileName: preflight.previewFile,
      revision: `${preflight.revision}-工具体预演`,
      position: partPosition(targetPart.role),
      color: preview.status === 'blocked'
        ? '#f59e0b'
        : preview.kind === 'additive' ? '#34d399' : '#f87171'
    };
  }, [cadFaceSelection, cadResult, localCadFeaturePreview, coverBottomY]);

  return (
    <>
      <color attach="background" args={['#17191d']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[60, 90, 40]} intensity={2.5} castShadow />
      <PerspectiveCamera makeDefault position={[92, 70, 92]} fov={34} far={5000} />
      <OrbitControls
        makeDefault
        enabled={!printPlatformManualLayoutSession && cadFaceSelectionMode !== 'box' && !(showUploadedStl && meshElementEditMode !== 'off' && meshElementSelectionMethod === 'box')}
        target={[0, 11, 0]}
        minDistance={55}
        maxDistance={1_000_000}
      />
      <PrintPlatformCameraController
        request={printPlatformViewRequest}
        onReturnSnapshotSourceChange={onPrintPlatformReturnSnapshotSourceChange}
      />
      <CadFaceBoxSelectionController />
      <MeshElementBoxSelectionController />
      <group onPointerMissed={() => selectObject(showUploadedStl ? 'uploaded-model' : cadResult?.parts[0]?.id ?? 'body')}>
        {differenceActive && versionGeometryComparisonSnapshot && versionGeometryDifferenceResult && cadResult ? (
          <Suspense fallback={null}>
            {cadResult.parts.map((part) => (
              <CadMesh
                key={`差异背景-${part.id}`}
                id={`差异背景-${part.id}`}
                fileName={part.stlFile}
                revision={cadResult.revision}
                color="#aeb4bc"
                position={assembledPartPosition(part.role, parameters)}
                preserveCoordinates
                interactive={false}
                opacity={0.18}
                renderOrder={0}
              />
            ))}
            {versionGeometryDifferenceResult.parts.map((part) => (
              <group key={`精确差异-${part.id}`}>
                {part.addedStlFile && (
                  <CadMesh
                    id={`精确差异-新增-${part.id}`}
                    fileName={part.addedStlFile}
                    revision={versionGeometryDifferenceResult.revision}
                    color="#32d583"
                    position={assembledPartPosition(part.role, parameters)}
                    preserveCoordinates
                    interactive={false}
                    opacity={0.96}
                    renderOrder={3}
                  />
                )}
                {part.removedStlFile && (
                  <CadMesh
                    id={`精确差异-删除-${part.id}`}
                    fileName={part.removedStlFile}
                    revision={versionGeometryDifferenceResult.revision}
                    color="#f05252"
                    position={assembledPartPosition(
                      part.role,
                      comparisonBaseVersion?.parameters ?? parameters
                    )}
                    preserveCoordinates
                    interactive={false}
                    opacity={0.82}
                    renderOrder={4}
                  />
                )}
              </group>
            ))}
          </Suspense>
        ) : visualComparisonActive && versionGeometryComparisonSnapshot && cadResult ? (
          <Suspense fallback={null}>
            <group position={comparisonOffsets.base}>
              {versionGeometryComparisonSnapshot.parts.map((part) => (
                <CadMesh
                  key={`版本基准-${part.id}`}
                  id={`版本基准-${part.id}`}
                  fileName={part.stlFile}
                  revision={versionGeometryComparisonSnapshot.revision}
                  color="#48a9dc"
                  position={assembledPartPosition(
                    part.role,
                    comparisonBaseVersion?.parameters ?? parameters
                  )}
                  snapshotDirectory={comparisonSnapshotDirectory ?? undefined}
                  interactive={false}
                  opacity={versionGeometryComparisonMode === 'overlay' ? 0.28 : 0.86}
                  renderOrder={1}
                />
              ))}
            </group>
            <group position={comparisonOffsets.current}>
              {cadResult.parts.map((part) => (
                <CadMesh
                  key={`当前版本-${part.id}`}
                  id={`当前版本-${part.id}`}
                  fileName={part.stlFile}
                  revision={cadResult.revision}
                  color="#e6a23a"
                  position={assembledPartPosition(part.role, parameters)}
                  interactive={false}
                  opacity={versionGeometryComparisonMode === 'overlay' ? 0.62 : 0.9}
                  renderOrder={2}
                />
              ))}
            </group>
          </Suspense>
        ) : showUploadedStl ? (
          <Suspense fallback={null}>
            <group position={uploadedGroupPosition}>
              {manufacturingResult?.sourceKind === 'uploaded-stl' ? (
                <>
                  <TransformableObject
                    id="uploaded-model-negative"
                    label="负方向拆件"
                    fallbackColor="#c9d9e8"
                    basePosition={splitPartPosition(manufacturingResult.validation.axis, -1, exploded, [0, 0, 0])}
                  >
                    <CadMesh
                      id="uploaded-model-negative"
                      fileName="manufacturing-negative.stl"
                      revision={manufacturingResult.revision}
                      color="#c9d9e8"
                      preserveCoordinates
                    />
                  </TransformableObject>
                  <TransformableObject
                    id="uploaded-model-positive"
                    label="正方向拆件"
                    fallbackColor="#e7d4b6"
                    basePosition={splitPartPosition(manufacturingResult.validation.axis, 1, exploded, [0, 0, 0])}
                  >
                    <CadMesh
                      id="uploaded-model-positive"
                      fileName="manufacturing-positive.stl"
                      revision={manufacturingResult.revision}
                      color="#e7d4b6"
                      preserveCoordinates
                    />
                  </TransformableObject>
                </>
              ) : (
                <TransformableObject id="uploaded-model" label={importedStlModel.name} fallbackColor="#d7dde4">
                  <CadMesh
                    id="uploaded-model"
                    fileName={importedStlModel.sourceFile}
                    revision={importedStlModel.revision}
                    color="#d7dde4"
                    preserveCoordinates
                    wallThicknessAnalysis={
                      wallThicknessVisible && wallThicknessResult?.sourceKind === 'uploaded-stl'
                        ? wallThicknessResult
                        : null
                    }
                  />
                </TransformableObject>
              )}
            </group>
          </Suspense>
        ) : showCad ? (
          <Suspense fallback={null}>
            {cadResult.parts.map((part) => {
              const basePosition = partPosition(part.role);
              if (manufacturingResult?.sourcePartId === part.id) {
                return (
                  <group key={`${part.id}-${manufacturingResult.revision}`}>
                    <TransformableObject
                      id={`${part.id}-negative`}
                      label={`${part.label}负方向拆件`}
                      fallbackColor="#c9d9e8"
                      fallbackPresentationId={part.id}
                      basePosition={basePosition}
                    >
                      <CadMesh
                        id={`${part.id}-negative`}
                        fileName="manufacturing-negative.stl"
                        revision={manufacturingResult.revision}
                        color="#c9d9e8"
                        position={splitPartPosition(manufacturingResult.validation.axis, -1, exploded, [0, 0, 0])}
                        preserveCoordinates
                      />
                    </TransformableObject>
                    <TransformableObject
                      id={`${part.id}-positive`}
                      label={`${part.label}正方向拆件`}
                      fallbackColor="#e7d4b6"
                      fallbackPresentationId={part.id}
                      basePosition={basePosition}
                    >
                      <CadMesh
                        id={`${part.id}-positive`}
                        fileName="manufacturing-positive.stl"
                        revision={manufacturingResult.revision}
                        color="#e7d4b6"
                        position={splitPartPosition(manufacturingResult.validation.axis, 1, exploded, [0, 0, 0])}
                        preserveCoordinates
                      />
                    </TransformableObject>
                  </group>
                );
              }
              const partColor = part.role === 'cover' ? '#eeeae1' : '#d9d4c8';
              return (
                <TransformableObject
                  key={part.id}
                  id={part.id}
                  label={part.label}
                  fallbackColor={partColor}
                  basePosition={basePosition}
                >
                  <CadMesh
                    id={part.id}
                    fileName={part.faceTessellation?.selectionMeshFile ?? part.stlFile}
                    revision={cadResult.revision}
                    cadPart={part}
                    color={partColor}
                    wallThicknessAnalysis={
                      wallThicknessVisible && wallThicknessResult?.sourcePartId === part.id
                        ? wallThicknessResult
                        : null
                    }
                  />
                </TransformableObject>
              );
            })}
          </Suspense>
        ) : (
          <>
            <TransformableObject id="body" label="模型主体" fallbackColor="#d9d4c8">
              <SelectableMesh id="body" geometry={bodyGeometry} color="#d9d4c8" />
            </TransformableObject>
            <TransformableObject id="cover" label="模型上盖" fallbackColor="#eeeae1" basePosition={[0, coverCenterY, 0]}>
              <SelectableMesh id="cover" geometry={coverGeometry} color="#eeeae1" />
            </TransformableObject>
          </>
        )}
        {exactFeaturePreview && !(visualComparisonActive || differenceActive) && showCad && (
          <Suspense fallback={null}>
            <CadMesh
              id="精确曲面工具体预演"
              fileName={exactFeaturePreview.fileName}
              revision={exactFeaturePreview.revision}
              color={exactFeaturePreview.color}
              position={exactFeaturePreview.position}
              preserveCoordinates
              interactive={false}
              opacity={0.34}
              renderOrder={8}
            />
          </Suspense>
        )}
        {!(visualComparisonActive || differenceActive) && !showUploadedStl && showBoard && (
          <TransformableObject id="reference" label="参考元件" fallbackColor="#147d64">
            <ReferenceComponent parameters={parameters} />
          </TransformableObject>
        )}
        {!(visualComparisonActive || differenceActive) && !showUploadedStl && <DimensionLabel parameters={parameters} />}
      </group>
      <Grid
        args={[240, 240]}
        cellSize={5}
        cellThickness={0.6}
        cellColor="#3a3d43"
        sectionSize={25}
        sectionThickness={1}
        sectionColor="#555b66"
        fadeDistance={220}
        fadeStrength={1}
        infiniteGrid
      />
      <PrintPlatformOverlayLayer
        spacingDiagnostic={printPlatformSpacingDiagnostic}
        layoutPlan={printPlatformLayoutPlan}
        alignmentPlan={printPlatformAlignmentPlan}
        fixedGapPlan={printPlatformFixedGapPlan}
      />
      <PrintPlatformManualLayoutDragLayer
        session={printPlatformManualLayoutSession}
        onMoveObject={onMovePrintPlatformManualObject}
      />
      <ContactShadows position={[0, 0.02, 0]} opacity={0.5} scale={150} blur={2.6} far={80} />
    </>
  );
}

export function ModelViewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragSerial = useRef(0);
  const [boxDragStart, setBoxDragStart] = useState<{ x: number; y: number } | null>(null);
  const [boxDragCurrent, setBoxDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [printPlatformViewRequest, setPrintPlatformViewRequest] = useState<PrintPlatformViewRequest | null>(null);
  const [printPlatformReturnSourceIdentity, setPrintPlatformReturnSourceIdentity] = useState<string | null>(null);
  const [printPlatformSpacingClearanceInput, setPrintPlatformSpacingClearanceInput] = useState('2');
  const [printPlatformLayoutPreviewSourceIdentity, setPrintPlatformLayoutPreviewSourceIdentity] = useState<string | null>(null);
  const [printPlatformLockedObjectIds, setPrintPlatformLockedObjectIds] = useState<string[]>([]);
  const [printPlatformAlignmentSelectedObjectIds, setPrintPlatformAlignmentSelectedObjectIds] = useState<string[]>([]);
  const [printPlatformAlignmentReferenceObjectId, setPrintPlatformAlignmentReferenceObjectId] = useState<string | null>(null);
  const [printPlatformAlignmentPreviewRequest, setPrintPlatformAlignmentPreviewRequest] = useState<{
    operation: PrintPlatformAlignmentOperation;
    sourceIdentity: string;
  } | null>(null);
  const [printPlatformFixedGapInput, setPrintPlatformFixedGapInput] = useState('2');
  const [printPlatformFixedGapAnchorMode, setPrintPlatformFixedGapAnchorMode] = useState<PrintPlatformFixedGapAnchorMode>('keep-first');
  const [printPlatformFixedGapAnchorObjectId, setPrintPlatformFixedGapAnchorObjectId] = useState<string | null>(null);
  const [printPlatformFixedGapPreviewRequest, setPrintPlatformFixedGapPreviewRequest] = useState<{
    operation: PrintPlatformFixedGapOperation;
    sourceIdentity: string;
  } | null>(null);
  const [printPlatformManualLayoutSession, setPrintPlatformManualLayoutSession] = useState<PrintPlatformManualLayoutSession | null>(null);
  const cadStatus = useModelStore((state) => state.cadStatus);
  const cadResult = useModelStore((state) => state.cadResult);
  const cadError = useModelStore((state) => state.cadError);
  const viewportModelSource = useModelStore((state) => state.viewportModelSource);
  const importedStlModel = useModelStore((state) => state.importedStlModel);
  const manufacturingResult = useModelStore((state) => state.manufacturingResult);
  const wallThicknessStatus = useModelStore((state) => state.wallThicknessStatus);
  const wallThicknessResult = useModelStore((state) => state.wallThicknessResult);
  const wallThicknessError = useModelStore((state) => state.wallThicknessError);
  const wallThicknessVisible = useModelStore((state) => state.wallThicknessVisible);
  const wallThicknessPicking = useModelStore((state) => state.wallThicknessPicking);
  const wallThicknessSelection = useModelStore((state) => state.wallThicknessSelection);
  const cadFaceSelectionMode = useModelStore((state) => state.cadFaceSelectionMode);
  const meshElementEditMode = useModelStore((state) => state.meshElementEditMode);
  const meshElementSelectionMethod = useModelStore((state) => state.meshElementSelectionMethod);
  const cadFaceSelection = useModelStore((state) => state.cadFaceSelection);
  const localCadFeaturePreview = useModelStore((state) => state.localCadFeaturePreview);
  const clearLocalCadFeaturePreview = useModelStore((state) => state.clearLocalCadFeaturePreview);
  const requestCadFaceBoxSelection = useModelStore((state) => state.requestCadFaceBoxSelection);
  const requestMeshElementBoxSelection = useModelStore((state) => state.requestMeshElementBoxSelection);
  const selectThinnestWallThicknessSample = useModelStore((state) => state.selectThinnestWallThicknessSample);
  const clearWallThicknessSelection = useModelStore((state) => state.clearWallThicknessSelection);
  const versions = useModelStore((state) => state.versions);
  const versionGeometryComparisonMode = useModelStore((state) => state.versionGeometryComparisonMode);
  const versionGeometryComparisonBaseId = useModelStore((state) => state.versionGeometryComparisonBaseId);
  const versionGeometryComparisonStatus = useModelStore((state) => state.versionGeometryComparisonStatus);
  const versionGeometryDifferenceResult = useModelStore((state) => state.versionGeometryDifferenceResult);
  const versionGeometryComparisonSnapshot = useModelStore((state) => state.versionGeometryComparisonSnapshot);
  const printPlatformOverlay = useModelStore((state) => state.printPlatformOverlay);
  const printPlatformMultiObjectPreview = useModelStore((state) => state.printPlatformMultiObjectPreview);
  const objectPresentations = useModelStore((state) => state.objectPresentations);
  const applyObjectPresentationBatch = useModelStore((state) => state.applyObjectPresentationBatch);
  const printPlatformSpacingState = useMemo(() => {
    if (!printPlatformMultiObjectPreview) return { diagnostic: null, error: null };
    const parsedClearance = printPlatformSpacingClearanceInput.trim() === ''
      ? Number.NaN
      : Number(printPlatformSpacingClearanceInput);
    try {
      return {
        diagnostic: createPrintPlatformMultiObjectSpacingDiagnostic(
          printPlatformMultiObjectPreview,
          parsedClearance
        ),
        error: null
      };
    } catch {
      return {
        diagnostic: createPrintPlatformMultiObjectSpacingDiagnostic(printPlatformMultiObjectPreview, 2),
        error: '安全间距必须是大于或等于 0 的有限毫米值，当前按默认 2.00 毫米诊断。'
      };
    }
  }, [printPlatformMultiObjectPreview, printPlatformSpacingClearanceInput]);
  const printPlatformLayoutPlan = useMemo(() => {
    if (!printPlatformMultiObjectPreview || !printPlatformOverlay || !printPlatformSpacingState.diagnostic) return null;
    try {
      return createPrintPlatformMultiObjectLockedRotationLayoutPlan(
        printPlatformMultiObjectPreview,
        printPlatformOverlay.effectiveBoundsMm,
        printPlatformSpacingState.diagnostic.clearanceMm,
        printPlatformLockedObjectIds
      );
    } catch {
      return null;
    }
  }, [printPlatformMultiObjectPreview, printPlatformOverlay, printPlatformSpacingState.diagnostic, printPlatformLockedObjectIds]);
  const activePrintPlatformLayoutPlan = printPlatformLayoutPlan?.sourceIdentity === printPlatformLayoutPreviewSourceIdentity
    ? printPlatformLayoutPlan
    : null;
  const printPlatformAlignmentSelectedObjects = useMemo(() => (
    printPlatformMultiObjectPreview?.objects
      .filter((object) => printPlatformAlignmentSelectedObjectIds.includes(object.objectId))
      .sort((first, second) => first.sourceIdentity.localeCompare(second.sourceIdentity, 'zh-CN') || first.objectId.localeCompare(second.objectId, 'zh-CN'))
    ?? []
  ), [printPlatformMultiObjectPreview, printPlatformAlignmentSelectedObjectIds]);
  const resolvedPrintPlatformAlignmentReferenceObjectId = printPlatformAlignmentSelectedObjectIds.includes(printPlatformAlignmentReferenceObjectId ?? '')
    ? printPlatformAlignmentReferenceObjectId
    : printPlatformAlignmentSelectedObjects[0]?.objectId ?? null;
  const resolvedPrintPlatformFixedGapAnchorObjectId = printPlatformAlignmentSelectedObjectIds.includes(printPlatformFixedGapAnchorObjectId ?? '')
    ? printPlatformFixedGapAnchorObjectId
    : printPlatformAlignmentSelectedObjects[0]?.objectId ?? null;
  const printPlatformAlignmentPlan = useMemo(() => {
    if (
      !printPlatformAlignmentPreviewRequest
      || !printPlatformMultiObjectPreview
      || !printPlatformOverlay
      || !printPlatformSpacingState.diagnostic
    ) return null;
    try {
      return createPrintPlatformAlignmentPlan(
        printPlatformMultiObjectPreview,
        printPlatformOverlay.effectiveBoundsMm,
        printPlatformSpacingState.diagnostic.clearanceMm,
        printPlatformLockedObjectIds,
        printPlatformAlignmentSelectedObjectIds,
        printPlatformAlignmentPreviewRequest.operation,
        resolvedPrintPlatformAlignmentReferenceObjectId
      );
    } catch {
      return null;
    }
  }, [
    printPlatformAlignmentPreviewRequest,
    printPlatformMultiObjectPreview,
    printPlatformOverlay,
    printPlatformSpacingState.diagnostic,
    printPlatformLockedObjectIds,
    printPlatformAlignmentSelectedObjectIds,
    resolvedPrintPlatformAlignmentReferenceObjectId
  ]);
  const activePrintPlatformAlignmentPlan = printPlatformAlignmentPlan?.sourceIdentity === printPlatformAlignmentPreviewRequest?.sourceIdentity
    ? printPlatformAlignmentPlan
    : null;
  const printPlatformFixedGapInputState = useMemo(() => {
    const parsed = printPlatformFixedGapInput.trim() === '' ? Number.NaN : Number(printPlatformFixedGapInput);
    const clearance = printPlatformSpacingState.diagnostic?.clearanceMm ?? 0;
    if (!Number.isFinite(parsed) || parsed < 0) return { value: null, error: '目标净间距必须是大于或等于 0 的有限毫米值。' };
    if (parsed + 1e-4 < clearance) return { value: null, error: `目标净间距不得小于当前 ${clearance.toFixed(2)} 毫米安全间距。` };
    return { value: parsed, error: null };
  }, [printPlatformFixedGapInput, printPlatformSpacingState.diagnostic?.clearanceMm]);
  const printPlatformFixedGapPlan = useMemo(() => {
    if (
      !printPlatformFixedGapPreviewRequest
      || !printPlatformMultiObjectPreview
      || !printPlatformOverlay
      || !printPlatformSpacingState.diagnostic
      || printPlatformFixedGapInputState.value === null
    ) return null;
    try {
      return createPrintPlatformFixedGapPlan(
        printPlatformMultiObjectPreview,
        printPlatformOverlay.effectiveBoundsMm,
        printPlatformSpacingState.diagnostic.clearanceMm,
        printPlatformFixedGapInputState.value,
        printPlatformLockedObjectIds,
        printPlatformAlignmentSelectedObjectIds,
        printPlatformFixedGapPreviewRequest.operation,
        printPlatformFixedGapAnchorMode,
        resolvedPrintPlatformFixedGapAnchorObjectId
      );
    } catch {
      return null;
    }
  }, [
    printPlatformFixedGapPreviewRequest,
    printPlatformMultiObjectPreview,
    printPlatformOverlay,
    printPlatformSpacingState.diagnostic,
    printPlatformFixedGapInputState.value,
    printPlatformFixedGapAnchorMode,
    resolvedPrintPlatformFixedGapAnchorObjectId,
    printPlatformLockedObjectIds,
    printPlatformAlignmentSelectedObjectIds
  ]);
  const activePrintPlatformFixedGapPlan = printPlatformFixedGapPlan?.sourceIdentity === printPlatformFixedGapPreviewRequest?.sourceIdentity
    ? printPlatformFixedGapPlan
    : null;
  const setVersionGeometryComparisonMode = useModelStore((state) => state.setVersionGeometryComparisonMode);
  const closeVersionGeometryComparison = useModelStore((state) => state.closeVersionGeometryComparison);
  const primaryPart = findCadPartByRole(cadResult, 'primary') ?? cadResult?.parts[0] ?? null;
  const comparisonBaseVersion = versions.find(
    (version) => version.id === versionGeometryComparisonBaseId
  ) ?? null;
  const stableFaceComparison = useMemo(
    () => compareCadStableFaceIds(versionGeometryComparisonSnapshot, cadResult),
    [cadResult, versionGeometryComparisonSnapshot]
  );
  const meshBoxSelecting = Boolean(
    viewportModelSource === 'uploaded-stl'
    && importedStlModel
    && !manufacturingResult
    && meshElementEditMode !== 'off'
    && meshElementSelectionMethod === 'box'
  );
  const boxSelecting = cadFaceSelectionMode === 'box' || meshBoxSelecting;

  useEffect(() => {
    setPrintPlatformViewRequest(null);
    setPrintPlatformReturnSourceIdentity(null);
    setPrintPlatformLayoutPreviewSourceIdentity(null);
    setPrintPlatformAlignmentPreviewRequest(null);
    setPrintPlatformFixedGapPreviewRequest(null);
    setPrintPlatformManualLayoutSession(null);
  }, [printPlatformOverlay?.sourceIdentity]);

  useEffect(() => {
    setPrintPlatformLockedObjectIds([]);
    setPrintPlatformAlignmentSelectedObjectIds([]);
    setPrintPlatformAlignmentReferenceObjectId(null);
    setPrintPlatformAlignmentPreviewRequest(null);
    setPrintPlatformFixedGapPreviewRequest(null);
    setPrintPlatformManualLayoutSession(null);
  }, [printPlatformMultiObjectPreview?.sourceIdentity]);

  useEffect(() => {
    setPrintPlatformAlignmentPreviewRequest(null);
    setPrintPlatformFixedGapPreviewRequest(null);
    setPrintPlatformManualLayoutSession(null);
  }, [printPlatformSpacingState.diagnostic?.sourceIdentity, printPlatformLockedObjectIds.join('\u0000')]);

  useEffect(() => {
    const clearance = printPlatformSpacingState.diagnostic?.clearanceMm;
    if (clearance === undefined) return;
    setPrintPlatformFixedGapInput(clearance.toString());
    setPrintPlatformFixedGapPreviewRequest(null);
  }, [printPlatformMultiObjectPreview?.sourceIdentity, printPlatformSpacingState.diagnostic?.clearanceMm]);

  useEffect(() => {
    setPrintPlatformAlignmentPreviewRequest(null);
    setPrintPlatformFixedGapPreviewRequest(null);
    setPrintPlatformAlignmentReferenceObjectId((current) => (
      current && printPlatformAlignmentSelectedObjectIds.includes(current) ? current : null
    ));
  }, [printPlatformAlignmentSelectedObjectIds.join('\u0000')]);

  const togglePrintPlatformObjectLock = (objectId: string) => {
    setPrintPlatformLockedObjectIds((previous) => (
      previous.includes(objectId)
        ? previous.filter((candidate) => candidate !== objectId)
        : [...previous, objectId].sort()
    ));
    setPrintPlatformAlignmentSelectedObjectIds((previous) => previous.filter((candidate) => candidate !== objectId));
    setPrintPlatformFixedGapAnchorObjectId((previous) => previous === objectId ? null : previous);
    setPrintPlatformFixedGapPreviewRequest(null);
  };

  const togglePrintPlatformAlignmentObject = (objectId: string) => {
    if (printPlatformLockedObjectIds.includes(objectId)) return;
    setPrintPlatformAlignmentSelectedObjectIds((previous) => (
      previous.includes(objectId)
        ? previous.filter((candidate) => candidate !== objectId)
        : [...previous, objectId].sort()
    ));
    setPrintPlatformFixedGapAnchorObjectId((previous) => (
      printPlatformAlignmentSelectedObjectIds.includes(objectId) && previous === objectId ? null : previous
    ));
    setPrintPlatformFixedGapPreviewRequest(null);
  };

  const createPrintPlatformAlignmentPreview = (operation: PrintPlatformAlignmentOperation) => {
    if (!printPlatformMultiObjectPreview || !printPlatformOverlay || !printPlatformSpacingState.diagnostic) return;
    const plan = createPrintPlatformAlignmentPlan(
      printPlatformMultiObjectPreview,
      printPlatformOverlay.effectiveBoundsMm,
      printPlatformSpacingState.diagnostic.clearanceMm,
      printPlatformLockedObjectIds,
      printPlatformAlignmentSelectedObjectIds,
      operation,
      resolvedPrintPlatformAlignmentReferenceObjectId
    );
    setPrintPlatformLayoutPreviewSourceIdentity(null);
    setPrintPlatformManualLayoutSession(null);
    setPrintPlatformFixedGapPreviewRequest(null);
    setPrintPlatformAlignmentPreviewRequest({ operation, sourceIdentity: plan.sourceIdentity });
    setPrintPlatformViewRequest((previous) => createNextPrintPlatformViewRequest(previous, printPlatformOverlay));
  };

  const createPrintPlatformFixedGapPreview = (operation: PrintPlatformFixedGapOperation) => {
    if (
      !printPlatformMultiObjectPreview
      || !printPlatformOverlay
      || !printPlatformSpacingState.diagnostic
      || printPlatformFixedGapInputState.value === null
    ) return;
    const plan = createPrintPlatformFixedGapPlan(
      printPlatformMultiObjectPreview,
      printPlatformOverlay.effectiveBoundsMm,
      printPlatformSpacingState.diagnostic.clearanceMm,
      printPlatformFixedGapInputState.value,
      printPlatformLockedObjectIds,
      printPlatformAlignmentSelectedObjectIds,
      operation,
      printPlatformFixedGapAnchorMode,
      resolvedPrintPlatformFixedGapAnchorObjectId
    );
    setPrintPlatformLayoutPreviewSourceIdentity(null);
    setPrintPlatformManualLayoutSession(null);
    setPrintPlatformAlignmentPreviewRequest(null);
    setPrintPlatformFixedGapPreviewRequest({ operation, sourceIdentity: plan.sourceIdentity });
    setPrintPlatformViewRequest((previous) => createNextPrintPlatformViewRequest(previous, printPlatformOverlay));
  };

  const startPrintPlatformManualLayout = () => {
    if (!printPlatformMultiObjectPreview || !printPlatformOverlay || !printPlatformSpacingState.diagnostic) return;
    setPrintPlatformLayoutPreviewSourceIdentity(null);
    setPrintPlatformAlignmentPreviewRequest(null);
    setPrintPlatformFixedGapPreviewRequest(null);
    setPrintPlatformManualLayoutSession(createPrintPlatformManualLayoutSession(
      printPlatformMultiObjectPreview,
      printPlatformOverlay.effectiveBoundsMm,
      printPlatformSpacingState.diagnostic.clearanceMm,
      printPlatformLockedObjectIds,
      true
    ));
    setPrintPlatformViewRequest((previous) => createNextPrintPlatformViewRequest(previous, printPlatformOverlay));
  };

  const movePrintPlatformManualObject = (objectId: string, centerMm: PrintPlatformManualLayoutPoint) => {
    setPrintPlatformManualLayoutSession((current) => (
      current ? movePrintPlatformManualLayoutObject(current, objectId, centerMm) : current
    ));
  };

  const applyPrintPlatformLayout = () => {
    if (
      !activePrintPlatformLayoutPlan
      || activePrintPlatformLayoutPlan.status !== 'ready'
      || activePrintPlatformLayoutPlan.changedObjectCount === 0
    ) return;
    const updates = activePrintPlatformLayoutPlan.placements.filter((placement) => !placement.locked && placement.changed).map((placement) => {
      const splitSourceId = manufacturingResult?.sourceKind === 'cad-part'
        && (placement.objectId === `${manufacturingResult.sourcePartId}-negative`
          || placement.objectId === `${manufacturingResult.sourcePartId}-positive`)
        ? manufacturingResult.sourcePartId
        : null;
      const cadPart = cadResult?.parts.find((part) => part.id === (splitSourceId ?? placement.objectId));
      const fallbackColor = placement.objectId.endsWith('-negative')
        ? '#c9d9e8'
        : placement.objectId.endsWith('-positive')
          ? '#e7d4b6'
          : placement.objectId === 'uploaded-model'
            ? '#d7dde4'
            : cadPart?.role === 'cover' || placement.objectId === 'cover'
              ? '#eeeae1'
              : '#d9d4c8';
      const current = normalizeObjectPresentation(
        objectPresentations[placement.objectId]
          ?? (splitSourceId ? objectPresentations[splitSourceId] : undefined),
        fallbackColor
      );
      return {
        objectId: placement.objectId,
        presentation: {
          ...current,
          transform: {
            ...current.transform,
            positionMm: {
              ...current.transform.positionMm,
              x: current.transform.positionMm.x + placement.deltaMm.x,
              z: current.transform.positionMm.z + placement.deltaMm.z
            },
            rotationDeg: {
              ...current.transform.rotationDeg,
              y: placement.targetRotationYDeg
            }
          }
        }
      };
    });
    const applied = applyObjectPresentationBatch(
      updates,
      activePrintPlatformLayoutPlan.lockedObjectCount > 0
        ? `锁定 ${activePrintPlatformLayoutPlan.lockedObjectCount} 个对象后重新寻优排布 ${activePrintPlatformLayoutPlan.adjustableObjectCount} 个对象`
        : `旋转寻优排布 ${activePrintPlatformLayoutPlan.objectCount} 个打印对象`
    );
    if (applied) setPrintPlatformLayoutPreviewSourceIdentity(null);
  };

  const applyPrintPlatformAlignmentPlan = () => {
    if (!activePrintPlatformAlignmentPlan?.canApply) return;
    const updates = activePrintPlatformAlignmentPlan.placements
      .filter((placement) => placement.selected && placement.moved && placement.status === 'valid')
      .map((placement) => {
        const splitSourceId = manufacturingResult?.sourceKind === 'cad-part'
          && (placement.objectId === `${manufacturingResult.sourcePartId}-negative`
            || placement.objectId === `${manufacturingResult.sourcePartId}-positive`)
          ? manufacturingResult.sourcePartId
          : null;
        const cadPart = cadResult?.parts.find((part) => part.id === (splitSourceId ?? placement.objectId));
        const fallbackColor = placement.objectId.endsWith('-negative')
          ? '#c9d9e8'
          : placement.objectId.endsWith('-positive')
            ? '#e7d4b6'
            : placement.objectId === 'uploaded-model'
              ? '#d7dde4'
              : cadPart?.role === 'cover' || placement.objectId === 'cover'
                ? '#eeeae1'
                : '#d9d4c8';
        const current = normalizeObjectPresentation(
          objectPresentations[placement.objectId]
            ?? (splitSourceId ? objectPresentations[splitSourceId] : undefined),
          fallbackColor
        );
        return {
          objectId: placement.objectId,
          presentation: {
            ...current,
            transform: {
              ...current.transform,
              positionMm: {
                ...current.transform.positionMm,
                x: current.transform.positionMm.x + placement.deltaMm.x,
                z: current.transform.positionMm.z + placement.deltaMm.z
              }
            }
          }
        };
      });
    const applied = applyObjectPresentationBatch(
      updates,
      `${printPlatformAlignmentOperationText(activePrintPlatformAlignmentPlan.operation)} ${activePrintPlatformAlignmentPlan.selectedObjectCount} 个打印对象`
    );
    if (applied) setPrintPlatformAlignmentPreviewRequest(null);
  };

  const applyPrintPlatformFixedGapPlan = () => {
    if (!activePrintPlatformFixedGapPlan?.canApply) return;
    const updates = activePrintPlatformFixedGapPlan.placements
      .filter((placement) => placement.selected && placement.moved && placement.status === 'valid')
      .map((placement) => {
        const splitSourceId = manufacturingResult?.sourceKind === 'cad-part'
          && (placement.objectId === `${manufacturingResult.sourcePartId}-negative`
            || placement.objectId === `${manufacturingResult.sourcePartId}-positive`)
          ? manufacturingResult.sourcePartId
          : null;
        const cadPart = cadResult?.parts.find((part) => part.id === (splitSourceId ?? placement.objectId));
        const fallbackColor = placement.objectId.endsWith('-negative')
          ? '#c9d9e8'
          : placement.objectId.endsWith('-positive')
            ? '#e7d4b6'
            : placement.objectId === 'uploaded-model'
              ? '#d7dde4'
              : cadPart?.role === 'cover' || placement.objectId === 'cover'
                ? '#eeeae1'
                : '#d9d4c8';
        const current = normalizeObjectPresentation(
          objectPresentations[placement.objectId] ?? (splitSourceId ? objectPresentations[splitSourceId] : undefined),
          fallbackColor
        );
        return {
          objectId: placement.objectId,
          presentation: {
            ...current,
            transform: {
              ...current.transform,
              positionMm: {
                ...current.transform.positionMm,
                x: current.transform.positionMm.x + placement.deltaMm.x,
                z: current.transform.positionMm.z + placement.deltaMm.z
              }
            }
          }
        };
      });
    const applied = applyObjectPresentationBatch(
      updates,
      `${printPlatformFixedGapOperationText(activePrintPlatformFixedGapPlan.operation)}（${printPlatformFixedGapVersionAnchorText(activePrintPlatformFixedGapPlan)}）${activePrintPlatformFixedGapPlan.selectedObjectCount} 个打印对象`
    );
    if (applied) setPrintPlatformFixedGapPreviewRequest(null);
  };

  const applyPrintPlatformManualLayout = () => {
    if (!printPlatformManualLayoutSession?.canApply) return;
    const updates = printPlatformManualLayoutSession.placements
      .filter((placement) => !placement.locked && placement.moved && placement.status === 'valid')
      .map((placement) => {
        const splitSourceId = manufacturingResult?.sourceKind === 'cad-part'
          && (placement.objectId === `${manufacturingResult.sourcePartId}-negative`
            || placement.objectId === `${manufacturingResult.sourcePartId}-positive`)
          ? manufacturingResult.sourcePartId
          : null;
        const cadPart = cadResult?.parts.find((part) => part.id === (splitSourceId ?? placement.objectId));
        const fallbackColor = placement.objectId.endsWith('-negative')
          ? '#c9d9e8'
          : placement.objectId.endsWith('-positive')
            ? '#e7d4b6'
            : placement.objectId === 'uploaded-model'
              ? '#d7dde4'
              : cadPart?.role === 'cover' || placement.objectId === 'cover'
                ? '#eeeae1'
                : '#d9d4c8';
        const current = normalizeObjectPresentation(
          objectPresentations[placement.objectId]
            ?? (splitSourceId ? objectPresentations[splitSourceId] : undefined),
          fallbackColor
        );
        return {
          objectId: placement.objectId,
          presentation: {
            ...current,
            transform: {
              ...current.transform,
              positionMm: {
                ...current.transform.positionMm,
                x: current.transform.positionMm.x + placement.deltaMm.x,
                z: current.transform.positionMm.z + placement.deltaMm.z
              }
            }
          }
        };
      });
    const applied = applyObjectPresentationBatch(
      updates,
      `手工排布 ${updates.length} 个打印对象（1 毫米吸附）`
    );
    if (applied) setPrintPlatformManualLayoutSession(null);
  };

  const statusText = {
    loading: '读取精确模型',
    ready: 'OpenCascade 实体有效',
    stale: '参数已变更，等待重建',
    generating: 'OpenCascade 正在重建',
    error: cadError ?? '精确模型生成失败'
  }[cadStatus];
  const boxRectangle = boxDragStart && boxDragCurrent
    ? {
        left: Math.min(boxDragStart.x, boxDragCurrent.x),
        top: Math.min(boxDragStart.y, boxDragCurrent.y),
        width: Math.abs(boxDragCurrent.x - boxDragStart.x),
        height: Math.abs(boxDragCurrent.y - boxDragStart.y)
      }
    : null;

  const pointerPosition = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const finishBoxSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!boxDragStart) return;
    const current = pointerPosition(event);
    setBoxDragCurrent(current);
    setBoxDragStart(null);
    setBoxDragCurrent(null);
    const canvas = containerRef.current?.querySelector('canvas');
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(0, Math.min(boxDragStart.x, current.x));
    const top = Math.max(0, Math.min(boxDragStart.y, current.y));
    const right = Math.min(bounds.width, Math.max(boxDragStart.x, current.x));
    const bottom = Math.min(bounds.height, Math.max(boxDragStart.y, current.y));
    if (right - left < 6 || bottom - top < 6) return;
    const rectangle = {
      left: left / bounds.width,
      top: top / bounds.height,
      right: right / bounds.width,
      bottom: bottom / bounds.height
    };
    if (meshBoxSelecting) {
      requestMeshElementBoxSelection({ id: ++dragSerial.current, rectangle });
      return;
    }
    const padding = 18;
    requestCadFaceBoxSelection({
      id: ++dragSerial.current,
      rectangle,
      screenshot: captureCanvasRegion(canvas, {
        x: left - padding,
        y: top - padding,
        width: right - left + padding * 2,
        height: bottom - top + padding * 2
      })
    });
  };

  return (
    <div className={`viewport-canvas ${boxSelecting ? 'is-cad-box-selecting' : ''}`} ref={containerRef}>
      <PrintPlatformMultiObjectAnalyzer />
      <Canvas shadows dpr={[1, 2]} gl={{ antialias: true, preserveDrawingBuffer: true }}>
        <ModelScene
          printPlatformViewRequest={printPlatformViewRequest}
          printPlatformSpacingDiagnostic={printPlatformSpacingState.diagnostic}
          printPlatformLayoutPlan={activePrintPlatformLayoutPlan}
          printPlatformAlignmentPlan={activePrintPlatformAlignmentPlan}
          printPlatformFixedGapPlan={activePrintPlatformFixedGapPlan}
          printPlatformManualLayoutSession={printPlatformManualLayoutSession}
          onMovePrintPlatformManualObject={movePrintPlatformManualObject}
          onPrintPlatformReturnSnapshotSourceChange={setPrintPlatformReturnSourceIdentity}
        />
      </Canvas>
      {printPlatformOverlay && (
        <div className={`print-platform-overlay-stack${printPlatformMultiObjectPreview || printPlatformManualLayoutSession || activePrintPlatformAlignmentPlan || activePrintPlatformFixedGapPlan ? ' has-scrollable-layout' : ''}`}>
          <aside
            className={`print-platform-overlay-legend is-${printPlatformOverlay.status}`}
            aria-label="打印平台三维视口图例"
          >
            <strong>打印平台预览</strong>
            <span className="print-platform-overlay-source">{printPlatformOverlayStatusText(printPlatformOverlay)}</span>
            <div className="print-platform-overlay-legend-row"><i className="is-platform" />物理平台边界</div>
            <div className="print-platform-overlay-legend-row"><i className="is-effective" />安全有效区域 · 边距 {printPlatformOverlay.safetyMarginMm.toFixed(2)} 毫米</div>
            <div className="print-platform-overlay-legend-row"><i className="is-object" />当前对象占地</div>
            {printPlatformMultiObjectPreview && (
              <section className="print-platform-multi-object-summary" aria-label="多对象联合占地摘要">
                <strong>多对象联合占地</strong>
                <span data-print-platform-multi-status>{printPlatformMultiObjectStatusText(printPlatformMultiObjectPreview)}</span>
                <span>
                  可打印对象：{printPlatformMultiObjectPreview.objectCount} 个
                  {printPlatformMultiObjectPreview.combinedBoundsMm
                    ? ` · 整体 ${printPlatformMultiObjectPreview.combinedWidthMm.toFixed(2)} × ${printPlatformMultiObjectPreview.combinedDepthMm.toFixed(2)} 毫米`
                    : ''}
                </span>
                {printPlatformMultiObjectPreview.objects.map((object) => (
                  <small key={object.sourceIdentity} data-print-platform-object-footprint={object.objectId}>
                    {printPlatformObjectFootprintStatusText(object)}
                  </small>
                ))}
                {(Object.values(printPlatformMultiObjectPreview.excludedCounts).some((count) => count > 0)) && (
                  <small>
                    已排除：参考对象 {printPlatformMultiObjectPreview.excludedCounts.reference} 个、隐藏对象 {printPlatformMultiObjectPreview.excludedCounts.hidden} 个、无有效几何对象 {printPlatformMultiObjectPreview.excludedCounts.invalidGeometry} 个
                  </small>
                )}
                <div className="print-platform-overlay-legend-row"><i className="is-combined" />整体联合占地边界</div>
                {printPlatformSpacingState.diagnostic && (
                  <section
                    className={`print-platform-spacing-diagnostic is-${printPlatformSpacingState.diagnostic.status}`}
                    aria-label="多对象间距与重叠诊断"
                    data-print-platform-spacing-status={printPlatformSpacingState.diagnostic.status}
                  >
                    <strong>对象间距与重叠诊断</strong>
                    <label>
                      <span>安全间距</span>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        inputMode="decimal"
                        aria-label="对象安全间距 毫米"
                        value={printPlatformSpacingClearanceInput}
                        onChange={(event) => setPrintPlatformSpacingClearanceInput(event.target.value)}
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                      <span>毫米</span>
                    </label>
                    {printPlatformSpacingState.error && (
                      <small className="print-platform-spacing-error">{printPlatformSpacingState.error}</small>
                    )}
                    <span>{printPlatformSpacingStatusText(printPlatformSpacingState.diagnostic)}</span>
                    {printPlatformSpacingState.diagnostic.pairs
                      .filter((pair) => pair.status !== 'safe')
                      .map((pair) => (
                        <small
                          key={pair.sourceIdentity}
                          className={`is-${pair.status}`}
                          data-print-platform-spacing-pair={`${pair.firstObjectId}:${pair.secondObjectId}`}
                        >
                          {printPlatformSpacingPairText(pair)}
                        </small>
                      ))}
                    <small>
                      共 {printPlatformSpacingState.diagnostic.pairCount} 组：重叠 {printPlatformSpacingState.diagnostic.overlapCount} 组、间距不足 {printPlatformSpacingState.diagnostic.tooCloseCount} 组、安全 {printPlatformSpacingState.diagnostic.safeCount} 组
                    </small>
                    <div className="print-platform-overlay-legend-row"><i className="is-spacing-overlap" />水平重叠区域</div>
                    <div className="print-platform-overlay-legend-row"><i className="is-spacing-close" />间距不足连线</div>
                    <section className="print-platform-layout-locks" aria-label="排布对象锁定">
                      <strong>排布锁定（{printPlatformLockedObjectIds.length} 个）</strong>
                      {printPlatformMultiObjectPreview.objects.map((object) => {
                        const locked = printPlatformLockedObjectIds.includes(object.objectId);
                        return (
                          <button
                            key={object.sourceIdentity}
                            type="button"
                            className={locked ? 'is-locked' : ''}
                            aria-pressed={locked}
                            data-print-platform-layout-lock={object.objectId}
                            onClick={() => togglePrintPlatformObjectLock(object.objectId)}
                          >
                            {object.objectLabel}：{locked ? '已锁定' : '可调整'}
                          </button>
                        );
                      })}
                    </section>
                    {!printPlatformManualLayoutSession && !activePrintPlatformLayoutPlan && (
                      <section
                        className="print-platform-alignment-selection"
                        aria-label="打印对象对齐与等距分布"
                        data-print-platform-alignment-selection
                      >
                        <strong>对齐与等距分布（已选 {printPlatformAlignmentSelectedObjects.length} 个）</strong>
                        <div className="print-platform-alignment-object-list">
                          {printPlatformMultiObjectPreview.objects.map((object) => {
                            const locked = printPlatformLockedObjectIds.includes(object.objectId);
                            const selected = printPlatformAlignmentSelectedObjectIds.includes(object.objectId);
                            return (
                              <button
                                key={object.sourceIdentity}
                                type="button"
                                className={selected ? 'is-selected' : ''}
                                aria-pressed={selected}
                                disabled={locked || Boolean(activePrintPlatformAlignmentPlan) || Boolean(activePrintPlatformFixedGapPlan)}
                                data-print-platform-alignment-object={object.objectId}
                                data-print-platform-alignment-selected={selected ? 'true' : 'false'}
                                onClick={() => togglePrintPlatformAlignmentObject(object.objectId)}
                              >
                                {object.objectLabel}：{locked ? '已锁定' : selected ? '已选择' : '未选择'}
                              </button>
                            );
                          })}
                        </div>
                        <label className="print-platform-alignment-reference">
                          <span>对齐基准对象</span>
                          <select
                            aria-label="对齐基准对象"
                            data-print-platform-alignment-reference
                            value={resolvedPrintPlatformAlignmentReferenceObjectId ?? ''}
                            disabled={printPlatformAlignmentSelectedObjects.length === 0 || Boolean(activePrintPlatformAlignmentPlan) || Boolean(activePrintPlatformFixedGapPlan)}
                            onChange={(event) => {
                              setPrintPlatformAlignmentReferenceObjectId(event.target.value || null);
                              setPrintPlatformAlignmentPreviewRequest(null);
                            }}
                          >
                            {printPlatformAlignmentSelectedObjects.length === 0 && <option value="">请先选择对象</option>}
                            {printPlatformAlignmentSelectedObjects.map((object) => (
                              <option key={object.sourceIdentity} value={object.objectId}>{object.objectLabel}</option>
                            ))}
                          </select>
                        </label>
                        <div className="print-platform-alignment-operations" aria-label="对齐操作">
                          {([
                            ['align-x-min', 'X 左边界'],
                            ['align-x-center', 'X 中心'],
                            ['align-x-max', 'X 右边界'],
                            ['align-z-min', 'Z 后边界'],
                            ['align-z-center', 'Z 中心'],
                            ['align-z-max', 'Z 前边界']
                          ] as const).map(([operation, label]) => (
                            <button
                              key={operation}
                              type="button"
                              disabled={printPlatformAlignmentSelectedObjects.length < 2 || Boolean(activePrintPlatformAlignmentPlan) || Boolean(activePrintPlatformFixedGapPlan)}
                              data-print-platform-alignment-operation={operation}
                              onClick={() => createPrintPlatformAlignmentPreview(operation)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="print-platform-alignment-operations is-distribution" aria-label="等距分布操作">
                          {([
                            ['distribute-x-centers', 'X 等距分布'],
                            ['distribute-z-centers', 'Z 等距分布']
                          ] as const).map(([operation, label]) => (
                            <button
                              key={operation}
                              type="button"
                              disabled={printPlatformAlignmentSelectedObjects.length < 3 || Boolean(activePrintPlatformAlignmentPlan) || Boolean(activePrintPlatformFixedGapPlan)}
                              data-print-platform-alignment-operation={operation}
                              onClick={() => createPrintPlatformAlignmentPreview(operation)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <small>对齐至少选择 2 个对象；等距分布至少选择 3 个对象。锁定对象保持原位并继续参与间距校验。</small>
                        {activePrintPlatformAlignmentPlan && (
                          <section
                            className={`print-platform-alignment-preview is-${activePrintPlatformAlignmentPlan.status}`}
                            aria-label="多对象对齐与等距分布预览"
                            data-print-platform-alignment-preview
                            data-print-platform-alignment-status={activePrintPlatformAlignmentPlan.status}
                          >
                            <strong>{printPlatformAlignmentOperationText(activePrintPlatformAlignmentPlan.operation)}预览</strong>
                            <span>{printPlatformAlignmentStatusText(activePrintPlatformAlignmentPlan)}</span>
                            <small>
                              已选 {activePrintPlatformAlignmentPlan.selectedObjectCount} 个 · 实际移动 {activePrintPlatformAlignmentPlan.changedObjectCount} 个 · 锁定约束 {activePrintPlatformAlignmentPlan.lockedObjectCount} 个 · 总位移 {activePrintPlatformAlignmentPlan.totalDistanceMm.toFixed(2)} 毫米 · 安全间距 {activePrintPlatformAlignmentPlan.clearanceMm.toFixed(2)} 毫米
                            </small>
                            {activePrintPlatformAlignmentPlan.failureReason && (
                              <small className="print-platform-alignment-error">{activePrintPlatformAlignmentPlan.failureReason}</small>
                            )}
                            {activePrintPlatformAlignmentPlan.placements
                              .filter((placement) => placement.selected)
                              .map((placement) => (
                                <small
                                  key={placement.sourceIdentity}
                                  className={`is-${placement.status}`}
                                  data-print-platform-alignment-placement={placement.objectId}
                                  data-print-platform-alignment-placement-status={placement.status}
                                  data-print-platform-alignment-reference-object={placement.reference ? 'true' : 'false'}
                                >
                                  {printPlatformAlignmentPlacementText(placement)}
                                </small>
                              ))}
                            <div className="print-platform-alignment-actions">
                              <button
                                type="button"
                                data-print-platform-alignment-apply
                                disabled={!activePrintPlatformAlignmentPlan.canApply}
                                onClick={applyPrintPlatformAlignmentPlan}
                              >
                                确认全部目标位置
                              </button>
                              <button
                                type="button"
                                className="is-secondary"
                                data-print-platform-alignment-cancel
                                onClick={() => setPrintPlatformAlignmentPreviewRequest(null)}
                              >
                                取消预览
                              </button>
                            </div>
                            <div className="print-platform-overlay-legend-row"><i className="is-alignment-reference" />基准对象</div>
                            <div className="print-platform-overlay-legend-row"><i className="is-alignment-valid" />合法目标</div>
                            <div className="print-platform-overlay-legend-row"><i className="is-alignment-invalid" />越界或间距冲突</div>
                          </section>
                        )}
                        <div className="print-platform-fixed-gap-controls">
                          <label className="print-platform-fixed-gap-input">
                            <span>目标净间距</span>
                            <input
                              type="number"
                              min={printPlatformSpacingState.diagnostic.clearanceMm}
                              step="0.5"
                              inputMode="decimal"
                              aria-label="目标净间距 毫米"
                              data-print-platform-fixed-gap-input
                              value={printPlatformFixedGapInput}
                              disabled={Boolean(activePrintPlatformAlignmentPlan) || Boolean(activePrintPlatformFixedGapPlan)}
                              onChange={(event) => {
                                setPrintPlatformFixedGapInput(event.target.value);
                                setPrintPlatformFixedGapPreviewRequest(null);
                              }}
                              onWheel={(event) => event.currentTarget.blur()}
                            />
                            <span>毫米</span>
                          </label>
                          <label className="print-platform-fixed-gap-anchor">
                            <span>固定锚点</span>
                            <select
                              aria-label="固定净间距锚点模式"
                              data-print-platform-fixed-gap-anchor-mode
                              value={printPlatformFixedGapAnchorMode}
                              disabled={Boolean(activePrintPlatformAlignmentPlan) || Boolean(activePrintPlatformFixedGapPlan)}
                              onChange={(event) => {
                                setPrintPlatformFixedGapAnchorMode(event.target.value as PrintPlatformFixedGapAnchorMode);
                                setPrintPlatformFixedGapPreviewRequest(null);
                              }}
                            >
                              <option value="keep-first">保持首对象不动</option>
                              <option value="keep-last">保持末对象不动</option>
                              <option value="keep-selected">指定对象不动</option>
                            </select>
                          </label>
                          {printPlatformFixedGapAnchorMode === 'keep-selected' && (
                            <label className="print-platform-fixed-gap-anchor">
                              <span>指定锚点对象</span>
                              <select
                                aria-label="固定净间距指定锚点对象"
                                data-print-platform-fixed-gap-anchor-object
                                value={resolvedPrintPlatformFixedGapAnchorObjectId ?? ''}
                                disabled={
                                  printPlatformAlignmentSelectedObjects.length === 0
                                  || Boolean(activePrintPlatformAlignmentPlan)
                                  || Boolean(activePrintPlatformFixedGapPlan)
                                }
                                onChange={(event) => {
                                  setPrintPlatformFixedGapAnchorObjectId(event.target.value || null);
                                  setPrintPlatformFixedGapPreviewRequest(null);
                                }}
                              >
                                {printPlatformAlignmentSelectedObjects.map((object) => (
                                  <option key={object.sourceIdentity} value={object.objectId}>{object.objectLabel}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {printPlatformFixedGapInputState.error && (
                            <small className="print-platform-alignment-error">{printPlatformFixedGapInputState.error}</small>
                          )}
                          <div className="print-platform-alignment-operations is-distribution" aria-label="固定净间距分布操作">
                            {([
                              ['distribute-x-fixed-gap', 'X 固定净间距'],
                              ['distribute-z-fixed-gap', 'Z 固定净间距']
                            ] as const).map(([operation, label]) => (
                              <button
                                key={operation}
                                type="button"
                                disabled={
                                  printPlatformAlignmentSelectedObjects.length < 2
                                  || printPlatformFixedGapInputState.value === null
                                  || Boolean(activePrintPlatformAlignmentPlan)
                                  || Boolean(activePrintPlatformFixedGapPlan)
                                }
                                data-print-platform-fixed-gap-operation={operation}
                                onClick={() => createPrintPlatformFixedGapPreview(operation)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <small>{printPlatformFixedGapAnchorMode === 'keep-first' ? '保持空间顺序第一个对象不动，并向正方向按边界递推。' : printPlatformFixedGapAnchorMode === 'keep-last' ? '保持空间顺序最后一个对象不动，并向负方向按边界反向递推。' : '保持指定对象当前中心不动，前方对象向负方向、后方对象向正方向按边界递推。'}目标净间距不得小于当前安全间距。</small>
                        </div>
                        {activePrintPlatformFixedGapPlan && (
                          <section
                            className={`print-platform-alignment-preview is-${activePrintPlatformFixedGapPlan.status}`}
                            aria-label="多对象固定净间距分布预览"
                            data-print-platform-fixed-gap-preview
                            data-print-platform-fixed-gap-status={activePrintPlatformFixedGapPlan.status}
                          >
                            <strong>{printPlatformFixedGapOperationText(activePrintPlatformFixedGapPlan.operation)}预览 · {printPlatformFixedGapAnchorModeText(activePrintPlatformFixedGapPlan.anchorMode)}</strong>
                            <span>{printPlatformFixedGapStatusText(activePrintPlatformFixedGapPlan)}</span>
                            <small>
                              锚点模式 {printPlatformFixedGapAnchorModeText(activePrintPlatformFixedGapPlan.anchorMode)} · 锚点对象 {printPlatformFixedGapAnchorObjectText(activePrintPlatformFixedGapPlan)} · 已选 {activePrintPlatformFixedGapPlan.selectedObjectCount} 个 · 实际移动 {activePrintPlatformFixedGapPlan.changedObjectCount} 个 · 锁定约束 {activePrintPlatformFixedGapPlan.lockedObjectCount} 个 · 目标净间距 {activePrintPlatformFixedGapPlan.targetGapMm.toFixed(2)} 毫米 · 安全间距 {activePrintPlatformFixedGapPlan.clearanceMm.toFixed(2)} 毫米 · 总位移 {activePrintPlatformFixedGapPlan.totalDistanceMm.toFixed(2)} 毫米
                            </small>
                            {activePrintPlatformFixedGapPlan.failureReason && (
                              <small className="print-platform-alignment-error">{activePrintPlatformFixedGapPlan.failureReason}</small>
                            )}
                            {activePrintPlatformFixedGapPlan.placements
                              .filter((placement) => placement.selected)
                              .sort((first, second) => (first.sequenceIndex ?? 0) - (second.sequenceIndex ?? 0))
                              .map((placement) => (
                                <small
                                  key={placement.sourceIdentity}
                                  className={`is-${placement.status}`}
                                  data-print-platform-fixed-gap-placement={placement.objectId}
                                  data-print-platform-fixed-gap-placement-status={placement.status}
                                >
                                  {printPlatformFixedGapPlacementText(placement)}
                                </small>
                              ))}
                            <div className="print-platform-alignment-actions">
                              <button
                                type="button"
                                data-print-platform-fixed-gap-apply
                                disabled={!activePrintPlatformFixedGapPlan.canApply}
                                onClick={applyPrintPlatformFixedGapPlan}
                              >
                                确认全部目标位置
                              </button>
                              <button
                                type="button"
                                className="is-secondary"
                                data-print-platform-fixed-gap-cancel
                                onClick={() => setPrintPlatformFixedGapPreviewRequest(null)}
                              >
                                取消预览
                              </button>
                            </div>
                            <div className="print-platform-overlay-legend-row"><i className="is-alignment-reference" />“{printPlatformFixedGapAnchorObjectText(activePrintPlatformFixedGapPlan)}”固定锚点</div>
                            <div className="print-platform-overlay-legend-row"><i className="is-alignment-valid" />合法目标</div>
                            <div className="print-platform-overlay-legend-row"><i className="is-alignment-invalid" />越界或间距冲突</div>
                          </section>
                        )}
                      </section>
                    )}
                    {!printPlatformManualLayoutSession && !activePrintPlatformAlignmentPlan && !activePrintPlatformFixedGapPlan && !activePrintPlatformLayoutPlan && (
                      <button
                        type="button"
                        className="print-platform-manual-start-button"
                        data-print-platform-manual-start
                        disabled={printPlatformMultiObjectPreview.objectCount === printPlatformLockedObjectIds.length}
                        onClick={startPrintPlatformManualLayout}
                      >
                        开始俯视手工排布
                      </button>
                    )}
                    {printPlatformManualLayoutSession && (
                      <section
                        className={`print-platform-manual-layout ${printPlatformManualLayoutSession.invalidObjectCount > 0 ? 'is-invalid' : 'is-valid'}`}
                        aria-label="打印平台手工拖动排布"
                        data-print-platform-manual-session
                        data-print-platform-manual-valid={printPlatformManualLayoutSession.invalidObjectCount === 0 ? 'true' : 'false'}
                      >
                        <strong>俯视手工排布</strong>
                        <label className="print-platform-manual-snap">
                          <input
                            type="checkbox"
                            checked={printPlatformManualLayoutSession.snapToGrid}
                            data-print-platform-manual-snap
                            onChange={(event) => setPrintPlatformManualLayoutSession((current) => (
                              current ? setPrintPlatformManualLayoutSnapToGrid(current, event.target.checked) : current
                            ))}
                          />
                          <span>启用固定 1 毫米网格吸附</span>
                        </label>
                        <span>{printPlatformManualLayoutStatusText(printPlatformManualLayoutSession)}</span>
                        <small>
                          可拖动 {printPlatformManualLayoutSession.adjustableObjectCount} 个 · 锁定 {printPlatformManualLayoutSession.lockedObjectCount} 个 · 已变化 {printPlatformManualLayoutSession.changedObjectCount} 个 · 安全间距 {printPlatformManualLayoutSession.clearanceMm.toFixed(2)} 毫米
                        </small>
                        {printPlatformManualLayoutSession.placements.map((placement) => (
                          <small
                            key={placement.objectId}
                            className={`is-${placement.status}`}
                            data-print-platform-manual-placement={placement.objectId}
                            data-print-platform-manual-placement-status={placement.status}
                            data-print-platform-manual-locked={placement.locked ? 'true' : 'false'}
                          >
                            {printPlatformManualLayoutPlacementText(placement)}
                          </small>
                        ))}
                        <div className="print-platform-manual-actions">
                          <button
                            type="button"
                            data-print-platform-manual-apply
                            disabled={!printPlatformManualLayoutSession.canApply}
                            onClick={applyPrintPlatformManualLayout}
                          >
                            确认全部临时位置
                          </button>
                          <button
                            type="button"
                            className="is-secondary"
                            data-print-platform-manual-cancel
                            onClick={() => setPrintPlatformManualLayoutSession(null)}
                          >
                            取消手工排布
                          </button>
                        </div>
                        <div className="print-platform-overlay-legend-row"><i className="is-manual-valid" />合法临时位置</div>
                        <div className="print-platform-overlay-legend-row"><i className="is-manual-invalid" />越界或间距冲突</div>
                      </section>
                    )}
                    {printPlatformLayoutPlan && !activePrintPlatformLayoutPlan && !printPlatformManualLayoutSession && !activePrintPlatformAlignmentPlan && !activePrintPlatformFixedGapPlan && (
                      <button
                        type="button"
                        className="print-platform-layout-preview-button"
                        data-print-platform-layout-create
                        onClick={() => {
                          setPrintPlatformAlignmentPreviewRequest(null);
                          setPrintPlatformFixedGapPreviewRequest(null);
                          setPrintPlatformLayoutPreviewSourceIdentity(printPlatformLayoutPlan.sourceIdentity);
                        }}
                      >
                        生成锁定与 90 度旋转寻优预览
                      </button>
                    )}
                    {activePrintPlatformLayoutPlan && !printPlatformManualLayoutSession && !activePrintPlatformAlignmentPlan && !activePrintPlatformFixedGapPlan && (
                      <section
                        className={`print-platform-layout-preview is-${activePrintPlatformLayoutPlan.status}`}
                        aria-label="多对象锁定与 90 度旋转寻优排布预览"
                        data-print-platform-layout-status={activePrintPlatformLayoutPlan.status}
                      >
                        <strong>多对象锁定与 90 度旋转寻优排布预览</strong>
                        <div className="print-platform-layout-actions">
                          <button
                            type="button"
                            data-print-platform-layout-apply
                            disabled={activePrintPlatformLayoutPlan.status !== 'ready' || activePrintPlatformLayoutPlan.changedObjectCount === 0}
                            onClick={applyPrintPlatformLayout}
                          >
                            应用全部位置与旋转
                          </button>
                          <button
                            type="button"
                            className="is-secondary"
                            data-print-platform-layout-cancel
                            onClick={() => setPrintPlatformLayoutPreviewSourceIdentity(null)}
                          >
                            取消预览
                          </button>
                        </div>
                        <span>{printPlatformLayoutStatusText(activePrintPlatformLayoutPlan)}</span>
                        {activePrintPlatformLayoutPlan.failureReason && (
                          <small className="print-platform-layout-error">{activePrintPlatformLayoutPlan.failureReason}</small>
                        )}
                        {activePrintPlatformLayoutPlan.status === 'ready' && (
                          <>
                            <small>
                              锁定 {activePrintPlatformLayoutPlan.lockedObjectCount} 个 · 可调整 {activePrintPlatformLayoutPlan.adjustableObjectCount} 个 · 目标整体占地 {activePrintPlatformLayoutPlan.combinedTargetWidthMm.toFixed(2)} × {activePrintPlatformLayoutPlan.combinedTargetDepthMm.toFixed(2)} 毫米（{activePrintPlatformLayoutPlan.combinedTargetAreaMm2.toFixed(2)} 平方毫米） · 安全间距 {activePrintPlatformLayoutPlan.clearanceMm.toFixed(2)} 毫米 · 总水平位移 {activePrintPlatformLayoutPlan.totalDistanceMm.toFixed(2)} 毫米
                            </small>
                            {activePrintPlatformLayoutPlan.placements.map((placement) => (
                              <small
                                key={placement.sourceIdentity}
                                data-print-platform-layout-placement={placement.objectId}
                                data-print-platform-layout-rotation={placement.targetRotationYDeg}
                                data-print-platform-layout-locked={placement.locked ? 'true' : 'false'}
                              >
                                {printPlatformLayoutPlacementText(placement)}
                              </small>
                            ))}
                            <div className="print-platform-overlay-legend-row"><i className="is-layout-target" />可调整对象候选目标</div>
                            <div className="print-platform-overlay-legend-row"><i className="is-layout-locked" />锁定对象保持位置</div>
                          </>
                        )}
                      </section>
                    )}
                  </section>
                )}
              </section>
            )}
            {printPlatformOverflowDescriptions(printPlatformOverlay).map((description) => (
              <span key={description} className="print-platform-overlay-overflow">{description}</span>
            ))}
            <small>{printPlatformManualLayoutSession
              ? '拖动只修改当前临时预览；取消不会移动模型，确认后才会一次创建一个版本。'
              : activePrintPlatformAlignmentPlan
                ? '对齐与分布只显示只读幽灵目标；取消不会移动模型，确认后才会一次创建一个版本。'
                : activePrintPlatformFixedGapPlan
                  ? '固定净间距分布只显示只读幽灵目标；取消不会移动模型，确认后才会一次创建一个版本。'
                  : '只读叠加，不移动对象、不创建版本，也不参与选择。'}</small>
          </aside>
          <div className="print-platform-view-actions">
            <button
              type="button"
              className="print-platform-top-view-button"
              title="从正上方查看并适配完整打印平台与当前对象"
              aria-label="俯视并适配打印平台"
              onClick={() => setPrintPlatformViewRequest((previous) => (
                createNextPrintPlatformViewRequest(previous, printPlatformOverlay)
              ))}
            >
              俯视并适配平台
            </button>
            {printPlatformReturnSourceIdentity === printPlatformOverlay.sourceIdentity && (
              <button
                type="button"
                className="print-platform-return-view-button"
                title="平滑返回本次俯视前的相机位置和视角目标"
                aria-label="返回俯视前的原视角"
                onClick={() => setPrintPlatformViewRequest((previous) => (
                  createNextPrintPlatformReturnViewRequest(previous, printPlatformOverlay.sourceIdentity)
                ))}
              >
                返回原视角
              </button>
            )}
          </div>
        </div>
      )}
      {boxSelecting && (
        <div
          className="cad-face-box-capture"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointerPosition(event);
            setBoxDragStart(point);
            setBoxDragCurrent(point);
          }}
          onPointerMove={(event) => {
            if (boxDragStart) setBoxDragCurrent(pointerPosition(event));
          }}
          onPointerUp={finishBoxSelection}
          onPointerCancel={() => {
            setBoxDragStart(null);
            setBoxDragCurrent(null);
          }}
          aria-label={meshBoxSelecting ? '框选上传模型网格元素' : '框选稳定 CAD 面'}
        >
          {boxRectangle && (
            <div className="cad-face-box-rectangle" style={boxRectangle} />
          )}
          {!boxRectangle && <span>{meshBoxSelecting
            ? `按住鼠标拖动，框选要移动的${meshElementEditMode === 'vertex' ? '顶点' : meshElementEditMode === 'edge' ? '边' : '三角面'}`
            : '按住鼠标拖动，框选需要交给 AI 修改的 CAD 面'}</span>}
        </div>
      )}
      {cadFaceSelection && (
        <div className={`cad-face-selection-overlay ${localCadFeaturePreview ? 'has-feature-preview' : ''}`}>
          <strong>{cadFaceSelection.selectionMode === 'click'
            ? '已点击选择稳定 CAD 面'
            : cadFaceSelection.selectionMode === 'edge'
              ? `已点击选择${describeCadSurfaceGeometryType(cadFaceSelection.faces[0]?.geometryType ?? '')}所属种子稳定 CAD 边`
              : cadFaceSelection.selectionMode === 'edge-chain'
                ? '已手工选择稳定 CAD 边链'
                : '已框选稳定 CAD 面'}</strong>
          <span>
            {cadFaceSelection.selectionMode === 'edge'
              ? cadFaceSelection.faces[0]?.geometryType === 'PLANE'
                ? '1 条种子边；支持单边、唯一切线连续边链或所属平面边界整圈圆角/倒角，不支持手工多选边链或可变半径'
                : '1 条种子边；支持曲面所属单边或唯一切线连续边链圆角/倒角，不支持整圈、手工多选边链或可变半径'
              : cadFaceSelection.selectionMode === 'edge-chain'
                ? `${cadFaceSelection.edgeSelections?.length ?? 0} 条边；只支持同一零件中无分叉的开放链或闭合链，执行前每条边都必须完成 OpenCascade 精确解析`
              : `${cadFaceSelection.faces.length} 个面`} · {new Set(cadFaceSelection.faces.map((face) => face.partId)).size} 个零件 · 下一条指令将附带原始毫米坐标、法线和局部截图
          </span>
          {localCadFeaturePreview && (
            <div className={`local-cad-feature-preview-status is-${localCadFeaturePreview.status}`}>
              <strong>{localCadFeaturePreview.status === 'checking' ? '正在生成 OpenCascade 精确工具体预演' : localCadFeaturePreview.status === 'ready' ? '准备自动执行' : localCadFeaturePreview.status === 'executing' ? '正在自动执行' : localCadFeaturePreview.status === 'blocked' ? '检测到曲面干涉，已阻止执行' : '执行失败，预览已保留'}</strong>
              <span>{describeLocalCadFeaturePreview(localCadFeaturePreview)}</span>
              <small>精确预演绑定当前 CAD 修订、零件、稳定面、曲面 UV 和真实 U 切向；模型重建或重新选择后自动失效。</small>
              {localCadFeaturePreview.errorMessage && <small>{localCadFeaturePreview.errorMessage}</small>}
              {localCadFeaturePreview.status === 'blocked' && (
                <LocalCadFeatureRiskPanel preview={localCadFeaturePreview} />
              )}
              {localCadFeaturePreview.status === 'failed' && (
                <button type="button" onClick={clearLocalCadFeaturePreview}>清除预览</button>
              )}
            </div>
          )}
          <small>{cadFaceSelection.warning}</small>
        </div>
      )}
      {versionGeometryComparisonStatus === 'ready' && versionGeometryComparisonMode !== 'off' && (
        <div className="version-geometry-overlay">
          <div className="version-geometry-heading">
            <div>
              <strong>精确版本实体对比</strong>
              <span>{comparisonBaseVersion?.label ?? '历史版本'} ↔ 当前版本</span>
            </div>
            <button type="button" onClick={closeVersionGeometryComparison}>退出对比</button>
          </div>
          <div className="version-geometry-mode-buttons" role="group" aria-label="版本实体对比方式">
            <button
              type="button"
              className={versionGeometryComparisonMode === 'overlay' ? 'is-active' : ''}
              onClick={() => setVersionGeometryComparisonMode('overlay')}
            >
              半透明重叠
            </button>
            <button
              type="button"
              className={versionGeometryComparisonMode === 'side-by-side' ? 'is-active' : ''}
              onClick={() => setVersionGeometryComparisonMode('side-by-side')}
            >
              并排对比
            </button>
            {versionGeometryDifferenceResult && (
              <button
                type="button"
                className={versionGeometryComparisonMode === 'difference' ? 'is-active' : ''}
                onClick={() => setVersionGeometryComparisonMode('difference')}
              >
                精确差异
              </button>
            )}
          </div>
          {versionGeometryComparisonMode === 'difference' && versionGeometryDifferenceResult ? (
            <>
              <div className="version-geometry-legend is-difference">
                <span><i className="is-added" />绿色：当前版本新增</span>
                <span><i className="is-removed" />红色：相对当前版本已删除</span>
              </div>
              <small>
                {versionGeometryDifferenceResult.method} · 新增 {versionGeometryDifferenceResult.summary.addedVolumeMm3.toFixed(2)} 立方毫米 · 删除 {versionGeometryDifferenceResult.summary.removedVolumeMm3.toFixed(2)} 立方毫米
              </small>
              {versionGeometryDifferenceResult.summary.changedPartCount === 0 && (
                <small>没有检测到超过布尔容差的实体体积差异。</small>
              )}
            </>
          ) : (
            <>
              <div className="version-geometry-legend">
                <span><i className="is-base" />基准版本</span>
                <span><i className="is-current" />当前版本</span>
              </div>
              <small>视觉叠加基于两个已保存 STL；“精确差异”使用 OpenCascade 布尔差集。</small>
            </>
          )}
          {stableFaceComparison.available ? (
            <small>
              几何签名匹配第一版：共享稳定面 {stableFaceComparison.sharedStableIdCount} 个 · 新增编号 {stableFaceComparison.addedStableIdCount} 个 · 消失编号 {stableFaceComparison.disappearedStableIdCount} 个。大幅拓扑变化或对称面可能重新编号。
            </small>
          ) : (
            <small>所选旧快照尚未包含面几何签名；重新保存新版本后可进行稳定面编号对比。</small>
          )}
        </div>
      )}
      <div className={`cad-validation cad-${cadStatus}`}>
        <span className="status-dot" />
        <div>
          <strong>
            {manufacturingResult
              ? '精确拆件 · 连接结构已写入实体'
              : viewportModelSource === 'uploaded-stl'
                ? importedStlModel?.metrics.repair.repaired
                  ? '上传 STL · 网格修复与封闭性检查通过'
                  : '上传 STL · 封闭性检查通过'
                : `${viewportModelSource === 'cad' ? '精确 CAD' : '快速预览'} · ${statusText}`}
          </strong>
          {manufacturingResult ? (
            <small>
              连接器 {manufacturingResult.features.jointCount} 个 · {{
                'none': '紧固结构',
                'snap-fit': '可拆卡扣',
                'screw-boss': '螺丝柱',
                'threaded-hole': '打印内螺纹',
                'external-thread': '打印外螺纹',
                'iso-threaded-hole': 'ISO 60° 内螺纹',
                'iso-external-thread': 'ISO 60° 外螺纹'
              }[manufacturingResult.features.fastenerType]} {manufacturingResult.features.fastenerCount} 个 · 最小设计壁厚 {manufacturingResult.features.minimumDesignedWallMm.toFixed(2)} 毫米 · 装配干涉 {manufacturingResult.features.interferenceVolumeMm3.toFixed(6)} 立方毫米 · 补面 {manufacturingResult.validation.negativeCapFaces + manufacturingResult.validation.positiveCapFaces} 个 · 拆件体积误差 {manufacturingResult.validation.volumeErrorMm3.toFixed(6)} 立方毫米
            </small>
          ) : viewportModelSource === 'uploaded-stl' && importedStlModel ? (
            <small>
              {importedStlModel.originalFileName} · {importedStlModel.metrics.triangleCount.toLocaleString()} 个三角面 · {importedStlModel.metrics.volumeMm3.toFixed(2)} 立方毫米
            </small>
          ) : cadResult && (
            <small>
              {primaryPart?.label ?? '主零件'} {Math.round(primaryPart?.metrics.volumeMm3 ?? 0).toLocaleString()} 立方毫米 · P1S 尺寸校验通过
            </small>
          )}
        </div>
      </div>

      {wallThicknessStatus !== 'idle' && (
        <div className={`wall-thickness-overlay wall-thickness-${wallThicknessStatus}`}>
          <strong>全局壁厚分析</strong>
          {wallThicknessStatus === 'analyzing' ? (
            <span>正在执行表面法向射线采样，请稍候…</span>
          ) : wallThicknessStatus === 'error' ? (
            <span>{wallThicknessError ?? '壁厚分析失败'}</span>
          ) : wallThicknessResult ? (
            <>
              <span>
                最薄 {wallThicknessResult.minimumThicknessMm.toFixed(2)} 毫米 · 5% 分位 {wallThicknessResult.percentile05Mm.toFixed(2)} 毫米 · 覆盖率 {(wallThicknessResult.coverageRatio * 100).toFixed(1)}%
              </span>
              <span>危险 {wallThicknessResult.criticalCount} · 偏薄 {wallThicknessResult.thinCount} · 建议 {wallThicknessResult.recommendedCount} · 充足 {wallThicknessResult.safeCount}</span>
              {wallThicknessVisible && (
                <div className="wall-thickness-legend">
                  <span><i style={{ background: WALL_THICKNESS_COLORS.critical }} />危险：&lt; {wallThicknessResult.thresholds.criticalBelowMm.toFixed(2)} 毫米</span>
                  <span><i style={{ background: WALL_THICKNESS_COLORS.thin }} />偏薄：{wallThicknessResult.thresholds.criticalBelowMm.toFixed(2)}–{wallThicknessResult.thresholds.thinBelowMm.toFixed(2)} 毫米</span>
                  <span><i style={{ background: WALL_THICKNESS_COLORS.recommended }} />建议：{wallThicknessResult.thresholds.thinBelowMm.toFixed(2)}–{wallThicknessResult.thresholds.recommendedBelowMm.toFixed(2)} 毫米</span>
                  <span><i style={{ background: WALL_THICKNESS_COLORS.safe }} />充足：≥ {wallThicknessResult.thresholds.recommendedBelowMm.toFixed(2)} 毫米</span>
                </div>
              )}
              {wallThicknessVisible && (
                <div className="wall-thickness-actions">
                  <button onClick={selectThinnestWallThicknessSample}>定位最薄处</button>
                  {wallThicknessSelection && (
                    <button onClick={clearWallThicknessSelection}>清除局部定位</button>
                  )}
                </div>
              )}
              {wallThicknessVisible && (
                <span className="wall-thickness-pick-hint">
                  {wallThicknessPicking
                    ? '局部选择已开启：点击模型表面即可把该区域交给 AI。'
                    : '点击工具栏的局部选择按钮后，可在模型表面定位区域。'}
                </span>
              )}
              <small>表面法向射线采样估算 · P1S · 0.4 毫米喷嘴 · PLA/PETG</small>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
