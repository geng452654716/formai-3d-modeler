import { describe, expect, it } from 'vitest';
import { parseLocalStlEditCommand } from './localStlEdit';

describe('上传 STL 局部修改中文解析', () => {
  it('解析圆形凸台和局部加厚', () => {
    expect(parseLocalStlEditCommand('这里增加一个直径 8 毫米、高 2 毫米的凸台')).toMatchObject({
      operation: 'add-cylinder', radiusMm: 4, depthMm: 2
    });
    expect(parseLocalStlEditCommand('这里局部加厚 1.5 毫米，范围直径 10 毫米')).toMatchObject({
      operation: 'add-cylinder', radiusMm: 5, depthMm: 1.5
    });
  });

  it('解析圆孔和圆柱切除', () => {
    expect(parseLocalStlEditCommand('这里开一个直径 4 毫米、深 6 毫米的孔')).toMatchObject({
      operation: 'cut-cylinder', radiusMm: 2, depthMm: 6
    });
    expect(parseLocalStlEditCommand('这里切除半径 2.5 毫米、深度 3 毫米')).toMatchObject({
      operation: 'cut-cylinder', radiusMm: 2.5, depthMm: 3
    });
  });

  it('拒绝模糊、缺参数和超限命令', () => {
    expect(() => parseLocalStlEditCommand('把这里改一下')).toThrow('请明确说明');
    expect(() => parseLocalStlEditCommand('这里开一个直径 4 毫米的孔')).toThrow('切入深度');
    expect(() => parseLocalStlEditCommand('这里增加直径 500 毫米、高 2 毫米的凸台')).toThrow('半径');
  });
});
