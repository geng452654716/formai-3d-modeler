import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETERS } from './defaults';
import {
  createImageCalibration,
  interfacePhysicalSizeToImageBounds,
  mapDetectedUsbToParameters,
  moveDetectedInterfaceOnImage,
  resizeDetectedInterfaceOnImage,
  type CalibrationPoint,
  type DetectedInterface
} from './imageRecognition';

const points: CalibrationPoint[] = [
  { xPercent: 10, yPercent: 20, xPixel: 100, yPixel: 200 },
  { xPercent: 60, yPercent: 20, xPixel: 600, yPixel: 200 }
];

it('根据双点像素距离计算毫米比例', () => {
  const calibration = createImageCalibration(1000, 800, points, 50);
  expect(calibration?.pixelDistance).toBe(500);
  expect(calibration?.mmPerPixel).toBeCloseTo(0.1);
});

it('拒绝没有双点或像素距离过短的标定', () => {
  expect(createImageCalibration(1000, 800, points.slice(0, 1), 50)).toBeNull();
  expect(createImageCalibration(1000, 800, [points[0], points[0]], 50)).toBeNull();
});

describe('USB 接口参数映射', () => {
  const detectedUsb: DetectedInterface = {
    id: 'usb-1',
    type: 'USB-C',
    side: '接口面',
    positionXPercent: 60,
    positionYPercent: 70,
    widthMm: 12,
    heightMm: 5,
    horizontalOffsetMm: 3.2,
    bottomOffsetMm: 1.8,
    confidence: 0.96,
    requiresOpening: true
  };

  it('将接口尺寸和偏移写入 CAD 参数', () => {
    expect(mapDetectedUsbToParameters([detectedUsb], 'front', DEFAULT_PARAMETERS)).toEqual({
      usbPortWidth: 12,
      usbPortHeight: 5,
      usbPortOffsetY: 3.2,
      usbPortBottom: 1.8
    });
  });

  it('非接口面不自动修改开孔', () => {
    expect(mapDetectedUsbToParameters([detectedUsb], 'side', DEFAULT_PARAMETERS)).toEqual({});
  });
});


describe('照片接口区域二维编辑', () => {
  const calibration = createImageCalibration(1000, 800, points, 50)!;
  const detectedInterface: DetectedInterface = {
    id: 'port-1',
    type: '电源接口',
    side: '正面',
    positionXPercent: 60,
    positionYPercent: 70,
    widthMm: 12,
    heightMm: 5,
    horizontalOffsetMm: 0,
    bottomOffsetMm: 0,
    confidence: 0.9,
    requiresOpening: true
  };

  it('将毫米尺寸换算成照片百分比框', () => {
    expect(interfacePhysicalSizeToImageBounds(detectedInterface, calibration)).toEqual({
      centerXPercent: 60,
      centerYPercent: 70,
      widthPercent: 12,
      heightPercent: 6.25
    });
  });

  it('拖动接口时将中心限制在照片范围内', () => {
    const moved = moveDetectedInterfaceOnImage(detectedInterface, calibration, 80, 80);
    expect(moved.positionXPercent).toBe(94);
    expect(moved.positionYPercent).toBeCloseTo(96.875);
  });

  it('调整接口框尺寸后换算回毫米', () => {
    const resized = resizeDetectedInterfaceOnImage(detectedInterface, calibration, 20, 10);
    expect(resized.widthMm).toBeCloseTo(20);
    expect(resized.heightMm).toBeCloseTo(8);
  });

  it('按图片中心更新横向偏移', () => {
    const moved = moveDetectedInterfaceOnImage(detectedInterface, calibration, -20, 0);
    expect(moved.positionXPercent).toBe(40);
    expect(moved.horizontalOffsetMm).toBeCloseTo(-10);
  });

  it('按接口框底边更新底部偏移且不小于零', () => {
    const moved = moveDetectedInterfaceOnImage(detectedInterface, calibration, 0, 40);
    expect(moved.bottomOffsetMm).toBe(0);
  });

  it('无效标定比例时安全返回原接口', () => {
    const invalidCalibration = { ...calibration, mmPerPixel: 0 };
    expect(interfacePhysicalSizeToImageBounds(detectedInterface, invalidCalibration)).toBeNull();
    expect(moveDetectedInterfaceOnImage(detectedInterface, invalidCalibration, 10, 10)).toBe(detectedInterface);
    expect(resizeDetectedInterfaceOnImage(detectedInterface, invalidCalibration, 20, 20)).toBe(detectedInterface);
  });
});
