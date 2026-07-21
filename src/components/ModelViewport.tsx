import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useLoader, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  ContactShadows,
  Grid,
  Html,
  OrbitControls,
  PerspectiveCamera
} from '@react-three/drei';
import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Matrix3, Matrix4, Mesh, Quaternion, Raycaster, Shape, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
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
  type CadSelectionScreenshot
} from '../model/cadFaceSelection';
import { createLidGeometry, createTrayGeometry } from '../model/createEnclosureGeometry';
import { getOuterDimensions } from '../model/defaults';
import { describeCadSurfaceGeometryType, describeLocalCadFeaturePreview } from '../model/localCadFeature';
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
  cadSelectionData
}: SelectableMeshProps) {
  const selectedObject = useModelStore((state) => state.selectedObject);
  const selectObject = useModelStore((state) => state.selectObject);
  const selected = interactive && selectedObject === id;

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      userData={cadSelectionData ? { cadFaceSelection: cadSelectionData } : undefined}
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
        color={heatmap ? new Color('#ffffff') : selected ? new Color('#f59e0b') : new Color(color)}
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
  const resolveCadSurfaceHitSelection = useModelStore((state) => state.resolveCadSurfaceHitSelection);
  const addAssistantMessage = useModelStore((state) => state.addAssistantMessage);
  const selectWallThicknessSample = useModelStore((state) => state.selectWallThicknessSample);
  const wallThicknessPicking = useModelStore((state) => state.wallThicknessPicking);
  const wallThicknessSelection = useModelStore((state) => state.wallThicknessSelection);
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
  const selectedEdgeGeometry = useMemo(() => {
    const edge = cadFaceSelection?.selectionMode === 'edge'
      && cadFaceSelection.edge?.partId === cadPart?.id
      ? cadFaceSelection.edge : null;
    if (!edge || edge.samplePointsMm.length < 2) return null;
    const positions: number[] = [];
    for (let index = 1; index < edge.samplePointsMm.length; index += 1) {
      const start = new Vector3(...edge.samplePointsMm[index - 1]).applyMatrix4(coordinateTransform);
      const end = new Vector3(...edge.samplePointsMm[index]).applyMatrix4(coordinateTransform);
      positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
    }
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
      || request.partId !== selectedFace.partId
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
        onSurfacePick={(point, event) => {
          if (cadPart?.faceTessellation && (cadFaceSelectionMode === 'click' || cadFaceSelectionMode === 'edge') && cadResult) {
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
            if (cadFaceSelectionMode === 'edge' && faceRange.geometryType !== 'PLANE') {
              addAssistantMessage(`当前点击边所属面是${describeCadSurfaceGeometryType(faceRange.geometryType)}；第一版圆角和倒角只支持平面所属边，请选择平面边界。`);
              return;
            }
            const nearestEdge = cadFaceSelectionMode === 'edge'
              ? findNearestCadEdge(faceDescriptor?.edges, { x: pointCad.x, y: pointCad.y, z: pointCad.z })
              : null;
            if (cadFaceSelectionMode === 'edge') {
              const bounds = cadPart.metrics.boundsMm;
              const diagonal = Math.hypot(bounds.x, bounds.y, bounds.z);
              const maximumDistance = Math.max(0.35, Math.min(3, diagonal * 0.025));
              if (!nearestEdge || nearestEdge.distanceMm > maximumDistance) {
                addAssistantMessage(`点击位置没有贴近可识别的 CAD 边线；请放大模型并点击边界线附近（允许距离 ${maximumDistance.toFixed(2)} 毫米）。`);
                return;
              }
            }
            const context: CadFaceSelectionContext = {
              protocol: 'FormAI-CAD-局部编辑上下文',
              protocolVersion: 1,
              sourceKind: 'cad-face',
              selectionMode: cadFaceSelectionMode,
              revision: cadResult.revision,
              units: 'mm',
              partBoundsMm: { [cadPart.id]: cadPart.metrics.boundsMm },
              faces: [cadSelectedFaceFromDescriptor(cadPart, faceRange)],
              edge: nearestEdge ? {
                partId: cadPart.id,
                partLabel: cadPart.label,
                stableFaceId: faceRange.stableId,
                stableEdgeId: nearestEdge.edge.stableId,
                geometryType: nearestEdge.edge.geometryType,
                lengthMm: nearestEdge.edge.lengthMm,
                centerMm: nearestEdge.edge.centerMm,
                samplePointsMm: nearestEdge.edge.samplePointsMm
              } : null,
              hit: {
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
                precision: 'mesh',
                resolutionStatus: 'resolving',
                pointDistanceMm: null,
                normalDot: null,
                resolutionError: null
              },
              camera: cameraSelectionContext(camera, size.width, size.height),
              screenshot,
              parameters: { ...parameters },
              printer: cadResult.printer,
              warning: CAD_FACE_SELECTION_WARNING
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
        <meshStandardMaterial color={selectedObject === 'reference' ? '#f59e0b' : '#147d64'} />
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

  return (
    <>
      <color attach="background" args={['#17191d']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[60, 90, 40]} intensity={2.5} castShadow />
      <PerspectiveCamera makeDefault position={[92, 70, 92]} fov={34} />
      <OrbitControls makeDefault enabled={cadFaceSelectionMode !== 'box'} target={[0, 11, 0]} minDistance={55} maxDistance={260} />
      <CadFaceBoxSelectionController />
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
                  <CadMesh
                    id="uploaded-model-negative"
                    fileName="manufacturing-negative.stl"
                    revision={manufacturingResult.revision}
                    color="#c9d9e8"
                    position={splitPartPosition(manufacturingResult.validation.axis, -1, exploded, [0, 0, 0])}
                    preserveCoordinates
                  />
                  <CadMesh
                    id="uploaded-model-positive"
                    fileName="manufacturing-positive.stl"
                    revision={manufacturingResult.revision}
                    color="#e7d4b6"
                    position={splitPartPosition(manufacturingResult.validation.axis, 1, exploded, [0, 0, 0])}
                    preserveCoordinates
                  />
                </>
              ) : (
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
                    <CadMesh
                      id={part.id}
                      fileName="manufacturing-negative.stl"
                      revision={manufacturingResult.revision}
                      color="#c9d9e8"
                      position={splitPartPosition(manufacturingResult.validation.axis, -1, exploded, basePosition)}
                      preserveCoordinates
                    />
                    <CadMesh
                      id={part.id}
                      fileName="manufacturing-positive.stl"
                      revision={manufacturingResult.revision}
                      color="#e7d4b6"
                      position={splitPartPosition(manufacturingResult.validation.axis, 1, exploded, basePosition)}
                      preserveCoordinates
                    />
                  </group>
                );
              }
              return (
                <CadMesh
                  key={part.id}
                  id={part.id}
                  fileName={part.faceTessellation?.selectionMeshFile ?? part.stlFile}
                  revision={cadResult.revision}
                  cadPart={part}
                  color={part.role === 'cover' ? '#eeeae1' : '#d9d4c8'}
                  position={basePosition}
                  wallThicknessAnalysis={
                    wallThicknessVisible && wallThicknessResult?.sourcePartId === part.id
                      ? wallThicknessResult
                      : null
                  }
                />
              );
            })}
          </Suspense>
        ) : (
          <>
            <SelectableMesh id="body" geometry={bodyGeometry} color="#d9d4c8" />
            <SelectableMesh
              id="cover"
              geometry={coverGeometry}
              color="#eeeae1"
              position={[0, coverCenterY, 0]}
            />
          </>
        )}
        {!(visualComparisonActive || differenceActive) && !showUploadedStl && showBoard && <ReferenceComponent parameters={parameters} />}
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
  const cadFaceSelection = useModelStore((state) => state.cadFaceSelection);
  const localCadFeaturePreview = useModelStore((state) => state.localCadFeaturePreview);
  const clearLocalCadFeaturePreview = useModelStore((state) => state.clearLocalCadFeaturePreview);
  const requestCadFaceBoxSelection = useModelStore((state) => state.requestCadFaceBoxSelection);
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
    const padding = 18;
    requestCadFaceBoxSelection({
      id: ++dragSerial.current,
      rectangle: {
        left: left / bounds.width,
        top: top / bounds.height,
        right: right / bounds.width,
        bottom: bottom / bounds.height
      },
      screenshot: captureCanvasRegion(canvas, {
        x: left - padding,
        y: top - padding,
        width: right - left + padding * 2,
        height: bottom - top + padding * 2
      })
    });
  };

  return (
    <div className={`viewport-canvas ${cadFaceSelectionMode === 'box' ? 'is-cad-box-selecting' : ''}`} ref={containerRef}>
      <Canvas shadows dpr={[1, 2]} gl={{ antialias: true, preserveDrawingBuffer: true }}>
        <ModelScene />
      </Canvas>
      {cadFaceSelectionMode === 'box' && (
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
          aria-label="框选稳定 CAD 面"
        >
          {boxRectangle && (
            <div className="cad-face-box-rectangle" style={boxRectangle} />
          )}
          {!boxRectangle && <span>按住鼠标拖动，框选需要交给 AI 修改的 CAD 面</span>}
        </div>
      )}
      {cadFaceSelection && (
        <div className={`cad-face-selection-overlay ${localCadFeaturePreview ? 'has-feature-preview' : ''}`}>
          <strong>{cadFaceSelection.selectionMode === 'click' ? '已点击选择稳定 CAD 面' : cadFaceSelection.selectionMode === 'edge' ? '已点击选择稳定 CAD 边' : '已框选稳定 CAD 面'}</strong>
          <span>
            {cadFaceSelection.selectionMode === 'edge' ? '1 条边' : `${cadFaceSelection.faces.length} 个面`} · {new Set(cadFaceSelection.faces.map((face) => face.partId)).size} 个零件 · 下一条指令将附带原始毫米坐标、法线和局部截图
          </span>
          {localCadFeaturePreview && (
            <div className={`local-cad-feature-preview-status is-${localCadFeaturePreview.status}`}>
              <strong>{localCadFeaturePreview.status === 'ready' ? '准备自动执行' : localCadFeaturePreview.status === 'executing' ? '正在自动执行' : localCadFeaturePreview.status === 'blocked' ? '检测到曲面干涉，已阻止执行' : '执行失败，预览已保留'}</strong>
              <span>{describeLocalCadFeaturePreview(localCadFeaturePreview)}</span>
              <small>预览绑定当前 CAD 修订、零件、稳定面和曲面 UV；模型重建或重新选择后自动失效。</small>
              {localCadFeaturePreview.errorMessage && <small>{localCadFeaturePreview.errorMessage}</small>}
              {(localCadFeaturePreview.status === 'blocked' || localCadFeaturePreview.status === 'failed') && (
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
