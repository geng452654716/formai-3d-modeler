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
import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Matrix3, Matrix4, Mesh, Path, Quaternion, Raycaster, Shape, Vector2, Vector3 } from 'three';
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
  collectMeshElementBoxSelection,
  createMeshElementSelectionSet,
  createMeshPlanarRegionExtrusionPreviewGuides,
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
const calculateMeshPlanarExtrusionLabelPosition = createMeshPlanarDimensionHtmlPosition(118, 24);

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
  basePosition?: [number, number, number];
  children: ReactNode;
}

/** 把临时拆分位移放在用户变换外层，确保装配/拆分视图不会覆盖真实对象变换。 */
function TransformableObject({
  id,
  label,
  fallbackColor,
  basePosition = [0, 0, 0],
  children
}: TransformableObjectProps) {
  const objectRef = useRef<Group>(null);
  const selectedObject = useModelStore((state) => state.selectedObject);
  const mode = useModelStore((state) => state.objectTransformMode);
  const storedPresentation = useModelStore((state) => state.objectPresentations[id]);
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
      useModelStore.getState().objectPresentations[id],
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
    if (!guides) return null;
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
              {meshPlanarRegionExtrusionPreview.mode === 'add' ? '向外加料预演' : '向内压入预演'}
              <strong>{meshPlanarRegionExtrusionPreview.distanceMm.toFixed(2)} 毫米</strong>
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

function ModelScene() {
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
      <PerspectiveCamera makeDefault position={[92, 70, 92]} fov={34} />
      <OrbitControls
        makeDefault
        enabled={cadFaceSelectionMode !== 'box' && !(showUploadedStl && meshElementEditMode !== 'off' && meshElementSelectionMethod === 'box')}
        target={[0, 11, 0]}
        minDistance={55}
        maxDistance={260}
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
                  <TransformableObject
                    key={`${part.id}-${manufacturingResult.revision}`}
                    id={part.id}
                    label={part.label}
                    fallbackColor="#d9d4c8"
                    basePosition={basePosition}
                  >
                    <CadMesh
                      id={part.id}
                      fileName="manufacturing-negative.stl"
                      revision={manufacturingResult.revision}
                      color="#c9d9e8"
                      position={splitPartPosition(manufacturingResult.validation.axis, -1, exploded, [0, 0, 0])}
                      preserveCoordinates
                    />
                    <CadMesh
                      id={part.id}
                      fileName="manufacturing-positive.stl"
                      revision={manufacturingResult.revision}
                      color="#e7d4b6"
                      position={splitPartPosition(manufacturingResult.validation.axis, 1, exploded, [0, 0, 0])}
                      preserveCoordinates
                    />
                  </TransformableObject>
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
      <ContactShadows position={[0, 0.02, 0]} opacity={0.5} scale={150} blur={2.6} far={80} />
    </>
  );
}

export function ModelViewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragSerial = useRef(0);
  const [boxDragStart, setBoxDragStart] = useState<{ x: number; y: number } | null>(null);
  const [boxDragCurrent, setBoxDragCurrent] = useState<{ x: number; y: number } | null>(null);
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
      <Canvas shadows dpr={[1, 2]} gl={{ antialias: true, preserveDrawingBuffer: true }}>
        <ModelScene />
      </Canvas>
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
