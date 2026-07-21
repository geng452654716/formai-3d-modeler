import type { EnclosureParameters } from './types';

/** Default dimensions for the current electronic-component enclosure template. */
export const DEFAULT_PARAMETERS: EnclosureParameters = {
  boardLength: 58,
  boardWidth: 28,
  boardThickness: 1.6,
  boardComponentHeight: 8.5,
  clearanceXY: 0.3,
  clearanceZ: 0.5,
  wallThickness: 2,
  baseThickness: 2,
  lidThickness: 2,
  cornerRadius: 4,
  edgeChamfer: 0.6,
  usbPortWidth: 11,
  usbPortHeight: 6,
  usbPortBottom: 2.7,
  usbPortOffsetY: 0,
  boardOffsetX: 0,
  boardOffsetZ: 0
};

export const PARAMETER_LIMITS: Record<keyof EnclosureParameters, [number, number]> = {
  boardLength: [30, 150],
  boardWidth: [15, 100],
  boardThickness: [0.8, 5],
  boardComponentHeight: [2, 40],
  clearanceXY: [0.1, 3],
  clearanceZ: [0.1, 5],
  wallThickness: [0.8, 8],
  baseThickness: [0.8, 8],
  lidThickness: [0.8, 8],
  cornerRadius: [0, 15],
  edgeChamfer: [0, 4],
  usbPortWidth: [4, 30],
  usbPortHeight: [2, 20],
  usbPortBottom: [0, 15],
  usbPortOffsetY: [-40, 40],
  boardOffsetX: [-15, 15],
  boardOffsetZ: [-15, 15]
};

export function getOuterDimensions(parameters: EnclosureParameters) {
  const horizontalPadding = 2 * (parameters.clearanceXY + parameters.wallThickness);

  return {
    length: parameters.boardLength + horizontalPadding,
    width: parameters.boardWidth + horizontalPadding,
    height:
      parameters.baseThickness +
      parameters.boardThickness +
      parameters.boardComponentHeight +
      parameters.clearanceZ
  };
}
