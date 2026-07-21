import { describe, expect, it } from 'vitest';
import {
  displayToSourcePoint,
  manufacturingSplitPresentationId,
  rotateDisplayPointXyz,
  sourceToDisplayPoint,
  transformSourcePointForExport,
  validateTransformedExportRequest
} from './objectExport';

const identity = {
  positionMm: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 },
  scale: 1
};

describe('视口变换导出坐标', () => {
  it('源坐标和显示坐标可以无损往返', () => {
    const source = { x: 3, y: -5, z: 7 };
    expect(displayToSourcePoint(sourceToDisplayPoint(source))).toEqual(source);
  });

  it('与 Three.js XYZ 旋转顺序一致', () => {
    const rotated = rotateDisplayPointXyz({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 90 });
    expect(rotated.x).toBeCloseTo(0, 10);
    expect(rotated.y).toBeCloseTo(1, 10);
    expect(rotated.z).toBeCloseTo(0, 10);
  });

  it('按显示坐标应用缩放、旋转、用户位移和装配基础位置', () => {
    const result = transformSourcePointForExport(
      { x: 1, y: 0, z: 0 },
      { positionMm: { x: 3, y: 4, z: 5 }, rotationDeg: { x: 0, y: 0, z: 90 }, scale: 2 },
      { x: 0, y: 10, z: 0 }
    );
    expect(result.x).toBeCloseTo(3, 10);
    expect(result.y).toBeCloseTo(-5, 10);
    expect(result.z).toBeCloseTo(16, 10);
  });

  it('单位变换保持源网格不变', () => {
    expect(transformSourcePointForExport({ x: 1, y: 2, z: 3 }, identity)).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('变换导出请求校验', () => {
  it('拒绝多对象 STL 和任意路径', () => {
    const object = { id: 'a', name: '零件', sourceFile: 'part.stl', color: '#112233', transform: identity };
    expect(validateTransformedExportRequest({ outputFileName: 'model.stl', format: 'stl', objects: [object, object] })).toBe('STL 一次只能导出一个对象');
    expect(validateTransformedExportRequest({ outputFileName: '../model.stl', format: 'stl', objects: [object] })).toBe('导出文件名不合法');
  });

  it('拆件导出复用与视口一致的对象标识', () => {
    expect(manufacturingSplitPresentationId('cad-part', 'body', 'negative')).toBe('body');
    expect(manufacturingSplitPresentationId('cad-part', 'custom-shell', 'positive')).toBe('custom-shell');
    expect(manufacturingSplitPresentationId('uploaded-stl', 'uploaded-model', 'negative')).toBe('uploaded-model-negative');
    expect(manufacturingSplitPresentationId('uploaded-stl', 'uploaded-model', 'positive')).toBe('uploaded-model-positive');
  });
});
