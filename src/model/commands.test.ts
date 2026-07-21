import { describe, expect, it } from 'vitest';
import { analyzeModelCommand } from './commands';

describe('analyzeModelCommand', () => {
  it('extracts multiple dimension changes', () => {
    const result = analyzeModelCommand('圆角改成 6 mm，壁厚设为 2.4 mm');
    expect(result.parameters).toEqual({ cornerRadius: 6, wallThickness: 2.4 });
  });

  it('extracts USB opening dimensions', () => {
    const result = analyzeModelCommand('USB 开孔宽度改成 12，高度设置为 7');
    expect(result.parameters).toEqual({ usbPortWidth: 12, usbPortHeight: 7 });
  });

  it('returns help when no deterministic command is recognized', () => {
    const result = analyzeModelCommand('让外壳更有未来感');
    expect(result.parameters).toEqual({});
    expect(result.summary).toContain('没有识别');
  });
});
