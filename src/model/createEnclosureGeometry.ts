import { BoxGeometry, BufferGeometry, ExtrudeGeometry, Path, Shape, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { getOuterDimensions } from './defaults';
import type { EnclosureParameters } from './types';

function createBrush(geometry: BufferGeometry, position: Vector3) {
  const brush = new Brush(geometry);
  brush.position.copy(position);
  brush.updateMatrixWorld(true);
  return brush;
}

function subtract(base: Brush, cutter: Brush, evaluator: Evaluator) {
  const result = evaluator.evaluate(base, cutter, SUBTRACTION);
  result.geometry.computeVertexNormals();
  return result;
}

function drawRoundedRectangle(
  path: Shape | Path,
  length: number,
  width: number,
  radius: number,
  centerX = 0,
  centerY = 0,
  clockwise = false
) {
  const left = centerX - length / 2;
  const right = centerX + length / 2;
  const bottom = centerY - width / 2;
  const top = centerY + width / 2;
  const safeRadius = Math.max(0, Math.min(radius, length / 2, width / 2));

  if (clockwise) {
    path.moveTo(left + safeRadius, bottom);
    path.quadraticCurveTo(left, bottom, left, bottom + safeRadius);
    path.lineTo(left, top - safeRadius);
    path.quadraticCurveTo(left, top, left + safeRadius, top);
    path.lineTo(right - safeRadius, top);
    path.quadraticCurveTo(right, top, right, top - safeRadius);
    path.lineTo(right, bottom + safeRadius);
    path.quadraticCurveTo(right, bottom, right - safeRadius, bottom);
    path.lineTo(left + safeRadius, bottom);
    path.closePath();
  } else {
    path.moveTo(left + safeRadius, bottom);
    path.lineTo(right - safeRadius, bottom);
    path.quadraticCurveTo(right, bottom, right, bottom + safeRadius);
    path.lineTo(right, top - safeRadius);
    path.quadraticCurveTo(right, top, right - safeRadius, top);
    path.lineTo(left + safeRadius, top);
    path.quadraticCurveTo(left, top, left, top - safeRadius);
    path.lineTo(left, bottom + safeRadius);
    path.quadraticCurveTo(left, bottom, left + safeRadius, bottom);
    path.closePath();
  }
}

/** Builds the preview tray with a rounded body, internal cavity and USB cutout. */
export function createTrayGeometry(parameters: EnclosureParameters): BufferGeometry {
  const dimensions = getOuterDimensions(parameters);
  const innerLength = parameters.boardLength + 2 * parameters.clearanceXY;
  const innerWidth = parameters.boardWidth + 2 * parameters.clearanceXY;
  const innerHeight = dimensions.height - parameters.baseThickness + 0.8;
  const outerRadius = Math.min(
    parameters.cornerRadius,
    dimensions.width / 2 - 0.1,
    dimensions.length / 2 - 0.1,
    dimensions.height / 2 - 0.1
  );
  const innerRadius = Math.max(0.4, outerRadius - parameters.wallThickness);
  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];

  const outer = createBrush(
    new RoundedBoxGeometry(
      dimensions.length,
      dimensions.height,
      dimensions.width,
      5,
      outerRadius
    ),
    new Vector3(0, dimensions.height / 2, 0)
  );

  const cavity = createBrush(
    new RoundedBoxGeometry(innerLength, innerHeight, innerWidth, 4, innerRadius),
    new Vector3(0, parameters.baseThickness + innerHeight / 2, 0)
  );

  let result = subtract(outer, cavity, evaluator);

  const usbCut = createBrush(
    new BoxGeometry(
      parameters.wallThickness * 4,
      parameters.usbPortHeight,
      parameters.usbPortWidth
    ),
    new Vector3(
      -dimensions.length / 2,
      parameters.baseThickness + parameters.usbPortBottom + parameters.usbPortHeight / 2,
      parameters.usbPortOffsetY
    )
  );
  result = subtract(result, usbCut, evaluator);

  return result.geometry.clone();
}

/** Builds a lid from a 2D rounded profile so its corner radius never distorts its thickness. */
export function createLidGeometry(parameters: EnclosureParameters): BufferGeometry {
  const dimensions = getOuterDimensions(parameters);
  const chamfer = Math.min(
    parameters.edgeChamfer,
    Math.max(0, parameters.lidThickness / 2 - 0.05),
    Math.max(0, parameters.cornerRadius / 2)
  );
  const profileLength = dimensions.length - 2 * chamfer;
  const profileWidth = dimensions.width - 2 * chamfer;
  const profileRadius = Math.max(0, parameters.cornerRadius - chamfer);
  const shape = new Shape();
  drawRoundedRectangle(shape, profileLength, profileWidth, profileRadius);

  const slotLength = Math.min(parameters.boardLength * 0.45, 28);
  [-6, -3, 0, 3, 6].forEach((offset) => {
    const slot = new Path();
    drawRoundedRectangle(slot, slotLength, 1.6, 0.6, 5, offset, true);
    shape.holes.push(slot);
  });

  const geometry = new ExtrudeGeometry(shape, {
    depth: Math.max(0.05, parameters.lidThickness - 2 * chamfer),
    steps: 1,
    curveSegments: 8,
    bevelEnabled: chamfer > 0,
    bevelSize: chamfer,
    bevelThickness: chamfer,
    bevelSegments: 2
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (bounds) {
    geometry.translate(
      -(bounds.min.x + bounds.max.x) / 2,
      -(bounds.min.y + bounds.max.y) / 2,
      -(bounds.min.z + bounds.max.z) / 2
    );
  }
  geometry.computeVertexNormals();
  return geometry;
}
