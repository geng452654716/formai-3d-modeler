import { describe, expect, it } from 'vitest';
import {
  cloneObjectPresentations,
  degreesToRadians,
  describeObjectTransformChange,
  normalizeObjectPresentation,
  sameObjectPresentation
} from './objectTransform';

describe('通用对象变换与颜色', () => {
  it('提供毫米、角度和均匀缩放默认值，并规范颜色', () => {
    expect(normalizeObjectPresentation(undefined, '#D9D4C8')).toEqual({
      transform: {
        positionMm: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 1
      },
      color: '#d9d4c8'
    });
  });

  it('拒绝非有限数值、非法颜色和危险缩放', () => {
    expect(normalizeObjectPresentation({
      transform: {
        positionMm: { x: Number.NaN, y: 2000, z: -2000 },
        rotationDeg: { x: Number.POSITIVE_INFINITY, y: 40000, z: -40000 },
        scale: 0
      },
      color: 'red'
    }, '#abcdef')).toEqual({
      transform: {
        positionMm: { x: 0, y: 1000, z: -1000 },
        rotationDeg: { x: 0, y: 36000, z: -36000 },
        scale: 0.05
      },
      color: '#abcdef'
    });
  });

  it('克隆历史状态且可判断是否发生真实变化', () => {
    const source = { body: normalizeObjectPresentation({ color: '#123456' }) };
    const clone = cloneObjectPresentations(source);
    expect(clone).toEqual(source);
    expect(clone.body).not.toBe(source.body);
    expect(sameObjectPresentation(clone.body, source.body)).toBe(true);
    clone.body.transform.positionMm.x = 4;
    expect(sameObjectPresentation(clone.body, source.body)).toBe(false);
  });

  it('将中文工具与 Three.js 弧度连接起来', () => {
    expect(degreesToRadians({ x: 180, y: 90, z: -45 })).toEqual([Math.PI, Math.PI / 2, -Math.PI / 4]);
    expect(describeObjectTransformChange('translate', '模型主体')).toBe('移动模型主体');
    expect(describeObjectTransformChange('rotate', '模型主体')).toBe('旋转模型主体');
    expect(describeObjectTransformChange('scale', '模型主体')).toBe('缩放模型主体');
  });
});
