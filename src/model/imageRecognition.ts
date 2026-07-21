import { getOuterDimensions, PARAMETER_LIMITS } from './defaults';
import type { EnclosureParameters, InterfaceOpeningShape } from './types';

export interface CalibrationPoint {
  xPercent: number;
  yPercent: number;
  xPixel: number;
  yPixel: number;
}

export interface ImageCalibration {
  imageWidthPx: number;
  imageHeightPx: number;
  pointA: CalibrationPoint;
  pointB: CalibrationPoint;
  pixelDistance: number;
  realDistanceMm: number;
  mmPerPixel: number;
}

export type DetectedInterfaceType =
  | 'USB-C'
  | '按钮'
  | 'LED'
  | '排针'
  | '电源接口'
  | '未知';

export interface DetectedInterface {
  id: string;
  type: DetectedInterfaceType;
  side: string;
  positionXPercent: number;
  positionYPercent: number;
  widthMm: number;
  heightMm: number;
  horizontalOffsetMm: number;
  bottomOffsetMm: number;
  confidence: number;
  requiresOpening: boolean;
  /** 开孔轮廓；旧识别结果缺省时根据接口类型自动推断。 */
  openingShape?: InterfaceOpeningShape;
}


export interface InterfaceImageBounds {
  centerXPercent: number;
  centerYPercent: number;
  widthPercent: number;
  heightPercent: number;
}

const MINIMUM_INTERFACE_BOX_PIXELS = 8;

function isUsableCalibration(calibration: ImageCalibration) {
  return calibration.imageWidthPx > 0
    && calibration.imageHeightPx > 0
    && Number.isFinite(calibration.mmPerPixel)
    && calibration.mmPerPixel > 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function syncInterfaceFromImageBounds(
  detectedInterface: DetectedInterface,
  calibration: ImageCalibration,
  bounds: InterfaceImageBounds
): DetectedInterface {
  const widthMm = bounds.widthPercent / 100 * calibration.imageWidthPx * calibration.mmPerPixel;
  const heightMm = bounds.heightPercent / 100 * calibration.imageHeightPx * calibration.mmPerPixel;
  const horizontalOffsetMm = (bounds.centerXPercent - 50) / 100
    * calibration.imageWidthPx
    * calibration.mmPerPixel;
  const bottomOffsetMm = Math.max(
    0,
    (100 - bounds.centerYPercent - bounds.heightPercent / 2) / 100
      * calibration.imageHeightPx
      * calibration.mmPerPixel
  );

  return {
    ...detectedInterface,
    positionXPercent: bounds.centerXPercent,
    positionYPercent: bounds.centerYPercent,
    widthMm,
    heightMm,
    horizontalOffsetMm,
    bottomOffsetMm
  };
}

/**
 * Converts a detected physical interface size into a box on the calibrated 2D image plane.
 * This is not camera-pose solving or photogrammetry.
 */
export function interfacePhysicalSizeToImageBounds(
  detectedInterface: DetectedInterface,
  calibration: ImageCalibration
): InterfaceImageBounds | null {
  if (!isUsableCalibration(calibration)) return null;

  const minimumWidthPercent = MINIMUM_INTERFACE_BOX_PIXELS / calibration.imageWidthPx * 100;
  const minimumHeightPercent = MINIMUM_INTERFACE_BOX_PIXELS / calibration.imageHeightPx * 100;
  const requestedWidthPercent = detectedInterface.widthMm / calibration.mmPerPixel
    / calibration.imageWidthPx
    * 100;
  const requestedHeightPercent = detectedInterface.heightMm / calibration.mmPerPixel
    / calibration.imageHeightPx
    * 100;
  const widthPercent = clamp(
    Number.isFinite(requestedWidthPercent) ? requestedWidthPercent : minimumWidthPercent,
    minimumWidthPercent,
    100
  );
  const heightPercent = clamp(
    Number.isFinite(requestedHeightPercent) ? requestedHeightPercent : minimumHeightPercent,
    minimumHeightPercent,
    100
  );
  const halfWidth = widthPercent / 2;
  const halfHeight = heightPercent / 2;

  return {
    centerXPercent: clamp(detectedInterface.positionXPercent, halfWidth, 100 - halfWidth),
    centerYPercent: clamp(detectedInterface.positionYPercent, halfHeight, 100 - halfHeight),
    widthPercent,
    heightPercent
  };
}

/** Moves an interface box on the calibrated 2D image plane and refreshes its CAD offsets. */
export function moveDetectedInterfaceOnImage(
  detectedInterface: DetectedInterface,
  calibration: ImageCalibration,
  deltaXPercent: number,
  deltaYPercent: number
): DetectedInterface {
  const bounds = interfacePhysicalSizeToImageBounds(detectedInterface, calibration);
  if (!bounds || !Number.isFinite(deltaXPercent) || !Number.isFinite(deltaYPercent)) {
    return detectedInterface;
  }

  const halfWidth = bounds.widthPercent / 2;
  const halfHeight = bounds.heightPercent / 2;
  return syncInterfaceFromImageBounds(detectedInterface, calibration, {
    ...bounds,
    centerXPercent: clamp(bounds.centerXPercent + deltaXPercent, halfWidth, 100 - halfWidth),
    centerYPercent: clamp(bounds.centerYPercent + deltaYPercent, halfHeight, 100 - halfHeight)
  });
}

/** Resizes an interface box around its centre and converts the result back to millimetres. */
export function resizeDetectedInterfaceOnImage(
  detectedInterface: DetectedInterface,
  calibration: ImageCalibration,
  requestedWidthPercent: number,
  requestedHeightPercent: number
): DetectedInterface {
  const bounds = interfacePhysicalSizeToImageBounds(detectedInterface, calibration);
  if (!bounds || !Number.isFinite(requestedWidthPercent) || !Number.isFinite(requestedHeightPercent)) {
    return detectedInterface;
  }

  const minimumWidthPercent = MINIMUM_INTERFACE_BOX_PIXELS / calibration.imageWidthPx * 100;
  const minimumHeightPercent = MINIMUM_INTERFACE_BOX_PIXELS / calibration.imageHeightPx * 100;
  const maximumWidthPercent = Math.max(
    minimumWidthPercent,
    2 * Math.min(bounds.centerXPercent, 100 - bounds.centerXPercent)
  );
  const maximumHeightPercent = Math.max(
    minimumHeightPercent,
    2 * Math.min(bounds.centerYPercent, 100 - bounds.centerYPercent)
  );

  return syncInterfaceFromImageBounds(detectedInterface, calibration, {
    ...bounds,
    widthPercent: clamp(requestedWidthPercent, minimumWidthPercent, maximumWidthPercent),
    heightPercent: clamp(requestedHeightPercent, minimumHeightPercent, maximumHeightPercent)
  });
}

export interface ReferenceImageAnalysis {
  summary: string;
  objectType: string;
  confidence: number;
  estimatedParameters: Array<{
    parameter: keyof EnclosureParameters;
    value: number;
    reason: string;
  }>;
  interfaces: DetectedInterface[];
  warnings: string[];
}

export interface ReferenceImageMetadata {
  fileName: string;
  viewType: string;
  calibration: ImageCalibration;
  importedAt: string;
}

/** Creates a physical image scale from two points selected on the original pixels. */
export function createImageCalibration(
  imageWidthPx: number,
  imageHeightPx: number,
  points: CalibrationPoint[],
  realDistanceMm: number
): ImageCalibration | null {
  if (
    points.length !== 2 ||
    imageWidthPx <= 0 ||
    imageHeightPx <= 0 ||
    !Number.isFinite(realDistanceMm) ||
    realDistanceMm <= 0
  ) {
    return null;
  }

  const [pointA, pointB] = points;
  const pixelDistance = Math.hypot(
    pointB.xPixel - pointA.xPixel,
    pointB.yPixel - pointA.yPixel
  );
  if (pixelDistance < 1) return null;

  return {
    imageWidthPx,
    imageHeightPx,
    pointA,
    pointB,
    pixelDistance,
    realDistanceMm,
    mmPerPixel: realDistanceMm / pixelDistance
  };
}

function clampParameter(key: keyof EnclosureParameters, value: number) {
  const [minimum, maximum] = PARAMETER_LIMITS[key];
  return Math.min(maximum, Math.max(minimum, value));
}

/** Maps the strongest calibrated USB detection on an interface photo into CAD parameters. */
export function mapDetectedUsbToParameters(
  interfaces: DetectedInterface[],
  viewType: string,
  parameters: EnclosureParameters
): Partial<EnclosureParameters> {
  if (viewType !== 'front') return {};
  const usb = interfaces
    .filter((item) => item.type === 'USB-C' && item.requiresOpening)
    .sort((left, right) => right.confidence - left.confidence)[0];
  if (!usb) return {};

  const dimensions = getOuterDimensions(parameters);
  const width = clampParameter(
    'usbPortWidth',
    usb.widthMm > 0 ? usb.widthMm : parameters.usbPortWidth
  );
  const height = clampParameter(
    'usbPortHeight',
    usb.heightMm > 0 ? usb.heightMm : parameters.usbPortHeight
  );
  const maximumHorizontalOffset = Math.max(
    0,
    dimensions.width / 2 - parameters.wallThickness - width / 2
  );
  const horizontalOffset = Math.min(
    maximumHorizontalOffset,
    Math.max(-maximumHorizontalOffset, usb.horizontalOffsetMm)
  );
  const maximumBottomOffset = Math.max(0, dimensions.height - height);
  const bottomOffset = Math.min(
    maximumBottomOffset,
    Math.max(0, usb.bottomOffsetMm)
  );

  return {
    usbPortWidth: width,
    usbPortHeight: height,
    usbPortOffsetY: clampParameter('usbPortOffsetY', horizontalOffset),
    usbPortBottom: clampParameter('usbPortBottom', bottomOffset)
  };
}
