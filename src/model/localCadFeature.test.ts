import { describe, expect, it } from 'vitest';
import type { CadFaceSelectionContext } from './cadFaceSelection';
import {
  buildLocalCadFeatureRequest,
  buildLocalCadFeatureRequestFromPlan,
  createLocalCadFeaturePreview,
  describeLocalCadFeaturePreview
} from './localCadFeature';

const selection: CadFaceSelectionContext = {
  protocol: 'FormAI-CAD-局部编辑上下文',
  protocolVersion: 1,
  sourceKind: 'cad-face',
  selectionMode: 'click',
  revision: 'revision-1',
  units: 'mm',
  partBoundsMm: { body: { x: 50, y: 30, z: 15 } },
  faces: [{
    partId: 'body',
    partLabel: '主体',
    stableId: 'face-top',
    geometryType: 'PLANE',
    areaMm2: 300,
    centerMm: [0, 0, 10],
    normal: [0, 0, 1]
  }],
  hit: {
    partId: 'body',
    stableId: 'face-top',
    triangleIndex: 20,
    pointMm: { x: 2, y: 3, z: 10 },
    normal: { x: 0, y: 0, z: 1 },
    meshPointMm: { x: 2, y: 3, z: 10 },
    meshNormal: { x: 0, y: 0, z: 1 },
    surfaceUv: { u: 2, v: 3 },
    uvBounds: { uMin: -25, uMax: 25, vMin: -15, vMax: 15 },
    precision: 'opencascade',
    resolutionStatus: 'resolved',
    pointDistanceMm: 0,
    normalDot: 1,
    resolutionError: null
  },
  camera: {
    positionMm: { x: 50, y: 50, z: 50 },
    projectionMatrix: new Array(16).fill(0),
    viewMatrix: new Array(16).fill(0),
    viewportPixels: { width: 800, height: 600 }
  },
  screenshot: null,
  parameters: {
    boardLength: 1, boardWidth: 1, boardThickness: 1, boardComponentHeight: 1,
    clearanceXY: 1, clearanceZ: 1, wallThickness: 1, baseThickness: 1,
    lidThickness: 1, cornerRadius: 1, edgeChamfer: 1, usbPortWidth: 1,
    usbPortHeight: 1, usbPortBottom: 1, usbPortOffsetY: 0, boardOffsetX: 0, boardOffsetZ: 0
  },
  printer: { model: 'Bambu Lab P1S', buildVolumeMm: [256, 256, 256], nozzleMm: 0.4 },
  warning: '测试上下文'
};

const edgeSelection: CadFaceSelectionContext = {
  ...selection,
  selectionMode: 'edge',
  edge: {
    partId: 'body',
    partLabel: '主体',
    stableFaceId: 'face-top',
    stableEdgeId: 'edge-top-front',
    geometryType: 'LINE',
    lengthMm: 50,
    centerMm: [0, -15, 10],
    samplePointsMm: [[-25, -15, 10], [25, -15, 10]]
  },
  hit: {
    ...selection.hit!,
    stableEdgeId: 'edge-top-front',
    pointMm: { x: 2, y: -15, z: 10 }
  }
};

describe('稳定 CAD 面局部特征请求', () => {
  it('只为曲面圆形特征创建绑定修订和真实法线的中文预览', () => {
    const curvedSelection: CadFaceSelectionContext = {
      ...selection,
      faces: [{ ...selection.faces[0], geometryType: 'CYLINDER', stableId: 'face-cylinder' }],
      hit: { ...selection.hit!, stableId: 'face-cylinder', normal: { x: 1, y: 0, z: 0 } }
    };
    const request = buildLocalCadFeatureRequest(curvedSelection, '在这里开一个直径 4 毫米、深 6 毫米的圆孔');
    const preview = createLocalCadFeaturePreview(request);

    expect(preview).toMatchObject({
      kind: 'subtractive',
      status: 'ready',
      errorMessage: null,
      request: {
        selectionRevision: 'revision-1',
        partId: 'body',
        stableFaceId: 'face-cylinder',
        surfaceGeometryType: 'CYLINDER',
        hitNormal: { x: 1, y: 0, z: 0 },
        radiusMm: 2,
        depthMm: 6
      }
    });
    expect(describeLocalCadFeaturePreview(preview!)).toBe(
      '曲面圆孔预览：直径 4.00 毫米，深 6.00 毫米；沿真实内法线显示。'
    );
    expect(createLocalCadFeaturePreview(buildLocalCadFeatureRequest(
      selection,
      '在这里开一个直径 4 毫米、深 6 毫米的圆孔'
    ))).toBeNull();
  });

  it('从点击平面和中文圆孔指令创建毫米制请求', () => {
    const request = buildLocalCadFeatureRequest(selection, '在这个面中心开一个直径 4 毫米、深 6 毫米的孔');
    expect(request).toMatchObject({
      sourceKind: 'cad-part',
      selectionRevision: 'revision-1',
      partId: 'body',
      stableFaceId: 'face-top',
      operation: 'cut-cylinder',
      radiusMm: 2,
      depthMm: 6,
      center: { xMm: 2, yMm: 3, zMm: 10 },
      hitNormal: { x: 0, y: 0, z: 1 }
    });
  });

  it('拒绝框选多面', () => {
    expect(() => buildLocalCadFeatureRequest({ ...selection, selectionMode: 'box' }, '开直径 4 毫米、深 3 毫米的孔'))
      .toThrow('只支持点击选择单个稳定面或单条边');
  });

  it('拒绝仍在解析或解析失败的选择网格预览', () => {
    const resolving = {
      ...selection,
      hit: {
        ...selection.hit!,
        surfaceUv: null,
        uvBounds: null,
        precision: 'mesh' as const,
        resolutionStatus: 'resolving' as const,
        pointDistanceMm: null,
        normalDot: null
      }
    };
    expect(() => buildLocalCadFeatureRequest(resolving, '开直径 4 毫米、深 3 毫米的孔'))
      .toThrow('尚未完成 OpenCascade 精确解析');
  });

  it('接受曲面圆形凸台和圆孔，并携带真实曲面类型与 UV', () => {
    const curved: CadFaceSelectionContext = {
      ...selection,
      faces: [{ ...selection.faces[0], geometryType: 'CYLINDER' }]
    };
    const boss = buildLocalCadFeatureRequest(curved, '增加直径 4 毫米、高 2 毫米的凸台');
    expect(boss).toMatchObject({
      operation: 'add-cylinder', surfaceGeometryType: 'CYLINDER', surfaceUv: { u: 2, v: 3 },
      radiusMm: 2, depthMm: 2
    });
    const hole = buildLocalCadFeatureRequest(curved, '开直径 3 毫米、深 4 毫米的圆孔');
    expect(hole).toMatchObject({ operation: 'cut-cylinder', radiusMm: 1.5, depthMm: 4 });
  });

  it('拒绝曲面矩形、槽孔、整面偏移和曲面边特征', () => {
    const curved: CadFaceSelectionContext = {
      ...selection,
      faces: [{ ...selection.faces[0], geometryType: 'CYLINDER' }]
    };
    for (const command of [
      '增加宽 10 毫米、高 6 毫米、凸出 2 毫米的矩形凸台',
      '开长 14 毫米、宽 5 毫米、深 4 毫米的槽孔',
      '将整个面向外拉伸 2 毫米'
    ]) {
      expect(() => buildLocalCadFeatureRequest(curved, command)).toThrow('只支持圆形凸台或圆孔');
    }
    const curvedEdge: CadFaceSelectionContext = {
      ...edgeSelection,
      faces: [{ ...edgeSelection.faces[0], geometryType: 'CYLINDER' }]
    };
    expect(() => buildLocalCadFeatureRequest(curvedEdge, '将这条边做 2 毫米圆角'))
      .toThrow('只支持平面所属边');
  });

  it('接受绑定当前稳定面的 Codex 圆形凸台计划', () => {
    const request = buildLocalCadFeatureRequestFromPlan(selection, '这里增加凸台', {
      operation: 'add-cylinder',
      partId: 'body',
      stableFaceId: 'face-top',
      radiusMm: 4,
      depthMm: 2,
      reason: '在用户点击位置增加圆形凸台'
    }, 'Codex 已生成受限局部特征计划');
    expect(request).toMatchObject({
      operation: 'add-cylinder',
      partId: 'body',
      stableFaceId: 'face-top',
      radiusMm: 4,
      depthMm: 2,
      summary: 'Codex 已生成受限局部特征计划'
    });
  });

  it('拒绝 Codex 修改当前选择之外的稳定面', () => {
    expect(() => buildLocalCadFeatureRequestFromPlan(selection, '这里开孔', {
      operation: 'cut-cylinder',
      partId: 'cover',
      stableFaceId: 'face-other',
      radiusMm: 2,
      depthMm: 6,
      reason: '错误目标'
    }, '错误计划')).toThrow('当前选择之外');
  });

  it('从中文矩形凸台和槽孔指令创建严格尺寸请求', () => {
    const boss = buildLocalCadFeatureRequest(selection, '在这里增加宽 10 毫米、高 6 毫米、凸出 2 毫米的矩形凸台，旋转 30 度');
    expect(boss).toMatchObject({
      operation: 'add-rectangle', radiusMm: null, widthMm: 10, heightMm: 6,
      lengthMm: null, depthMm: 2, rotationDeg: 30
    });
    const slot = buildLocalCadFeatureRequest(selection, '在这里开长 14 毫米、宽 5 毫米、深 4 毫米的槽孔，旋转 45 度');
    expect(slot).toMatchObject({
      operation: 'cut-slot', radiusMm: null, widthMm: 5, heightMm: null,
      lengthMm: 14, depthMm: 4, rotationDeg: 45
    });
  });

  it('接受绑定当前稳定面的 Codex 矩形孔计划并拒绝混用尺寸', () => {
    const request = buildLocalCadFeatureRequestFromPlan(selection, '这里开矩形孔', {
      operation: 'cut-rectangle', partId: 'body', stableFaceId: 'face-top', radiusMm: null,
      widthMm: 8, heightMm: 5, lengthMm: null, depthMm: 3, rotationDeg: -15, reason: '矩形孔'
    }, '受限矩形孔计划');
    expect(request).toMatchObject({ operation: 'cut-rectangle', widthMm: 8, heightMm: 5, depthMm: 3, rotationDeg: -15 });
    expect(() => buildLocalCadFeatureRequestFromPlan(selection, '错误槽孔', {
      operation: 'cut-slot', partId: 'body', stableFaceId: 'face-top', radiusMm: 2,
      widthMm: 5, heightMm: null, lengthMm: 14, depthMm: 3, rotationDeg: 0, reason: '错误混用'
    }, '错误计划')).toThrow('不能携带圆形半径');
  });

  it('从中文整面指令创建不携带轮廓尺寸的向外拉伸和向内偏移请求', () => {
    const outward = buildLocalCadFeatureRequest(selection, '整面向外拉伸 2 毫米');
    expect(outward).toMatchObject({
      operation: 'offset-face-outward', radiusMm: null, widthMm: null, heightMm: null,
      lengthMm: null, depthMm: 2, rotationDeg: 0
    });
    const inward = buildLocalCadFeatureRequest(selection, '将这个面向内偏移 1.5 毫米');
    expect(inward).toMatchObject({
      operation: 'offset-face-inward', radiusMm: null, widthMm: null, heightMm: null,
      lengthMm: null, depthMm: 1.5, rotationDeg: 0
    });
  });

  it('接受合法 Codex 整面计划并拒绝轮廓尺寸或旋转角', () => {
    const request = buildLocalCadFeatureRequestFromPlan(selection, '整面向外拉伸', {
      operation: 'offset-face-outward', partId: 'body', stableFaceId: 'face-top', radiusMm: null,
      widthMm: null, heightMm: null, lengthMm: null, depthMm: 2, rotationDeg: 0, reason: '整面外移'
    }, '受限整面拉伸计划');
    expect(request).toMatchObject({ operation: 'offset-face-outward', depthMm: 2, widthMm: null, rotationDeg: 0 });

    expect(() => buildLocalCadFeatureRequestFromPlan(selection, '错误整面计划', {
      operation: 'offset-face-inward', partId: 'body', stableFaceId: 'face-top', radiusMm: null,
      widthMm: 8, heightMm: null, lengthMm: null, depthMm: 2, rotationDeg: 0, reason: '错误尺寸'
    }, '错误计划')).toThrow('不能携带局部轮廓尺寸或旋转角');

    expect(() => buildLocalCadFeatureRequestFromPlan(selection, '错误整面旋转', {
      operation: 'offset-face-outward', partId: 'body', stableFaceId: 'face-top', radiusMm: null,
      widthMm: null, heightMm: null, lengthMm: null, depthMm: 2, rotationDeg: 15, reason: '错误旋转'
    }, '错误计划')).toThrow('不能携带局部轮廓尺寸或旋转角');
  });


  it('从中文圆角和倒角指令创建绑定当前稳定边的请求', () => {
    const fillet = buildLocalCadFeatureRequest(edgeSelection, '将这条边做 2 毫米圆角');
    expect(fillet).toMatchObject({
      operation: 'fillet-edge', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: 'edge-top-front', depthMm: 2, radiusMm: null,
      widthMm: null, heightMm: null, lengthMm: null, rotationDeg: 0
    });
    const chamfer = buildLocalCadFeatureRequest(edgeSelection, '将这条边做 1 毫米倒角');
    expect(chamfer).toMatchObject({
      operation: 'chamfer-edge', stableEdgeId: 'edge-top-front', depthMm: 1
    });
  });

  it('接受绑定当前稳定边的 Codex 计划并拒绝越权边 ID', () => {
    const request = buildLocalCadFeatureRequestFromPlan(edgeSelection, '圆角', {
      operation: 'fillet-edge', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: 'edge-top-front', radiusMm: null, widthMm: null,
      heightMm: null, lengthMm: null, depthMm: 2, rotationDeg: 0, reason: '单边圆角'
    }, '受限单边圆角计划');
    expect(request).toMatchObject({ operation: 'fillet-edge', stableEdgeId: 'edge-top-front', depthMm: 2 });

    expect(() => buildLocalCadFeatureRequestFromPlan(edgeSelection, '错误边', {
      operation: 'chamfer-edge', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: 'edge-other', radiusMm: null, widthMm: null,
      heightMm: null, lengthMm: null, depthMm: 1, rotationDeg: 0, reason: '错误边'
    }, '错误计划')).toThrow('当前选择之外的稳定边');
  });

  it('拒绝选择模式与操作类型不匹配', () => {
    expect(() => buildLocalCadFeatureRequestFromPlan(selection, '错误圆角', {
      operation: 'fillet-edge', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: 'edge-top-front', depthMm: 2, reason: '错误模式'
    }, '错误计划')).toThrow('当前选择之外的稳定边');

    expect(() => buildLocalCadFeatureRequestFromPlan(edgeSelection, '错误开孔', {
      operation: 'cut-cylinder', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: null, radiusMm: 2, depthMm: 3, reason: '错误模式'
    }, '错误计划')).toThrow('当前选择的是稳定边，只允许执行圆角或倒角');
  });

  it('拒绝曲面所属边、平面轮廓字段和越界边尺寸', () => {
    const curvedEdge = {
      ...edgeSelection,
      faces: [{ ...edgeSelection.faces[0], geometryType: 'CYLINDER' }]
    };
    expect(() => buildLocalCadFeatureRequest(curvedEdge, '做 2 毫米圆角'))
      .toThrow('只支持平面所属边');

    expect(() => buildLocalCadFeatureRequestFromPlan(edgeSelection, '错误尺寸', {
      operation: 'fillet-edge', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: 'edge-top-front', widthMm: 2, depthMm: 2, reason: '错误尺寸'
    }, '错误计划')).toThrow('不能携带平面轮廓尺寸');

    expect(() => buildLocalCadFeatureRequestFromPlan(edgeSelection, '尺寸过大', {
      operation: 'chamfer-edge', partId: 'body', stableFaceId: 'face-top',
      stableEdgeId: 'edge-top-front', depthMm: 50.01, reason: '尺寸过大'
    }, '错误计划')).toThrow('0.20 至 50.00 毫米');
  });

});
