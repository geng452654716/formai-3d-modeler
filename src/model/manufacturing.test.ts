import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETERS } from './defaults';
import { createManufacturingPlan } from './manufacturing';

describe('制造方案', () => {
  it('为当前外壳生成四个对称连接位', () => {
    const plan = createManufacturingPlan(DEFAULT_PARAMETERS, {
      splitStrategy: 'support-minimization',
      jointType: 'd-pin',
      clearanceMm: 0.25,
      fastenerType: 'screw-boss',
      screwSize: 'M3'
    });
    expect(plan.parts).toEqual(['下壳体', '顶盖']);
    expect(plan.connectorAxes).toEqual(['X', 'Y']);
    expect(plan.connectors).toHaveLength(4);
    expect(plan.connectors[0].xMm).toBe(-plan.connectors[1].xMm);
    expect(plan.connectors[0].diameterMm).toBe(5);
  });

  it('为上传 STL 使用真实包围盒和切割平面坐标，不绑定固定零件语义', () => {
    const plan = createManufacturingPlan(DEFAULT_PARAMETERS, {
      splitStrategy: 'support-minimization',
      jointType: 'round-pin',
      clearanceMm: 0.25,
      fastenerType: 'snap-fit',
      screwSize: 'M3'
    }, {
      sourceKind: 'uploaded-stl',
      splitAxis: 'x',
      boundsMm: {
        minX: -17,
        maxX: 17,
        minY: -11,
        maxY: 11,
        minZ: 0,
        maxZ: 16
      }
    });

    expect(plan.parts).toEqual(['负方向拆件', '正方向拆件']);
    expect(plan.connectorAxes).toEqual(['Y', 'Z']);
    expect(plan.splitDescription).toContain('上传模型');
    expect(plan.splitDescription).not.toContain('下壳');
    expect(plan.connectors[0].label).toBe('候选连接位 1');
    expect(plan.connectors[0].xMm).toBeCloseTo(-6.16);
    expect(plan.connectors[0].yMm).toBeCloseTo(3.52);
  });

  it('明确区分打印友好近似螺纹与 ISO 真实牙型', () => {
    for (const fastenerType of ['threaded-hole', 'external-thread'] as const) {
      const plan = createManufacturingPlan(DEFAULT_PARAMETERS, {
        splitStrategy: 'manual-plane',
        jointType: 'd-pin',
        clearanceMm: 0.25,
        fastenerType,
        screwSize: 'M3'
      });

      expect(plan.fastenerDescription).toContain('近似');
      expect(plan.fastenerDescription).not.toContain('真实牙型');
    }
  });
  it('为 ISO 公制螺纹明确声明 60° 真实牙型', () => {
    for (const fastenerType of ['iso-threaded-hole', 'iso-external-thread'] as const) {
      const plan = createManufacturingPlan(DEFAULT_PARAMETERS, {
        splitStrategy: 'manual-plane',
        jointType: 'd-pin',
        clearanceMm: 0.25,
        fastenerType,
        screwSize: 'M3'
      });

      expect(plan.fastenerDescription).toContain('ISO 公制粗牙 60°');
      expect(plan.fastenerDescription).not.toContain('近似');
    }
  });


});
