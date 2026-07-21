import { describe, expect, it } from 'vitest';
import type { CadFaceSelectionContext } from './cadFaceSelection';
import {
  buildCadFaceSelectionCommandContext,
  cadTriangleRectangleSamples,
  cadSelectedFaceFromDescriptor,
  findCadFaceRangeByTriangleIndex,
  screenshotDataUrlToBytes
} from './cadFaceSelection';
import type { CadFaceTessellationMapping } from './cad';

const mapping: CadFaceTessellationMapping = {
  status: 'ok',
  version: 1,
  partId: 'generic-part',
  units: 'mm',
  coordinateSystem: '测试坐标系',
  method: '测试映射',
  sourceStlFile: 'part.stl',
  selectionMeshFile: 'part-selection.stl',
  mappingFile: 'part-map.json',
  triangleCount: 7,
  faceCount: 3,
  linearToleranceMm: 0.05,
  angularToleranceRad: 0.1,
  faces: [
    { stableId: 'face-a', geometryType: 'PLANE', triangleStart: 0, triangleCount: 2, areaMm2: 20, centerMm: [0, 0, 0] },
    { stableId: 'face-b', geometryType: 'CYLINDER', triangleStart: 2, triangleCount: 4, areaMm2: 30, centerMm: [1, 0, 0] },
    { stableId: 'face-c', geometryType: 'PLANE', triangleStart: 6, triangleCount: 1, areaMm2: 10, centerMm: [2, 0, 0] }
  ],
  warning: '测试提示'
};

describe('CAD 稳定面局部选择', () => {
  it('按三角面索引回查连续稳定面区间', () => {
    expect(findCadFaceRangeByTriangleIndex(mapping, 0)?.stableId).toBe('face-a');
    expect(findCadFaceRangeByTriangleIndex(mapping, 2)?.stableId).toBe('face-b');
    expect(findCadFaceRangeByTriangleIndex(mapping, 5)?.stableId).toBe('face-b');
    expect(findCadFaceRangeByTriangleIndex(mapping, 6)?.stableId).toBe('face-c');
    expect(findCadFaceRangeByTriangleIndex(mapping, 7)).toBeNull();
    expect(findCadFaceRangeByTriangleIndex(mapping, -1)).toBeNull();
  });

  it('生成包含稳定面、原始毫米坐标、法线、尺寸与截图状态的中文协议', () => {
    const selection = {
      protocol: 'FormAI-CAD-局部编辑上下文',
      protocolVersion: 1,
      sourceKind: 'cad-face',
      selectionMode: 'click',
      revision: 'r1',
      units: 'mm',
      partBoundsMm: { body: { x: 10, y: 20, z: 30 } },
      faces: [{
        partId: 'body',
        partLabel: '主体',
        stableId: 'face-a',
        geometryType: 'PLANE',
        areaMm2: 20,
        centerMm: [0, 0, 0]
      }],
      hit: {
        partId: 'body',
        stableId: 'face-a',
        triangleIndex: 1,
        pointMm: { x: 1, y: 2, z: 3 },
        normal: { x: 0, y: 0, z: 1 },
        meshPointMm: { x: 1.01, y: 2, z: 3 },
        meshNormal: { x: 0, y: 0, z: 1 },
        surfaceUv: { u: 1, v: 2 },
        uvBounds: { uMin: 0, uMax: 10, vMin: 0, vMax: 20 },
        precision: 'opencascade',
        resolutionStatus: 'resolved',
        pointDistanceMm: 0.01,
        normalDot: 1,
        resolutionError: null
      },
      camera: {
        positionMm: { x: 10, y: 20, z: 30 },
        projectionMatrix: [],
        viewMatrix: [],
        viewportPixels: { width: 800, height: 600 }
      },
      screenshot: { dataUrl: 'data:image/png;base64,AA==', width: 10, height: 10, crop: { x: 0, y: 0, width: 10, height: 10 } },
      parameters: {} as CadFaceSelectionContext['parameters'],
      printer: { model: 'Bambu Lab P1S', buildVolumeMm: [256, 256, 256], nozzleMm: 0.4 },
      warning: '稳定面提示'
    } satisfies CadFaceSelectionContext;

    const text = buildCadFaceSelectionCommandContext(selection);
    expect(text).toContain('主体/face-a');
    expect(text).toContain('OpenCascade 精确命中坐标=(1.000, 2.000, 3.000) 毫米');
    expect(text).toContain('真实外法向=(0.000000, 0.000000, 1.000000)');
    expect(text).toContain('曲面 UV=(1.000000000, 2.000000000)');
    expect(text).toContain('body=(10.000, 20.000, 30.000) 毫米');
    expect(text).toContain('已随指令附加局部截图');
  });

  it('将通用零件描述转换为稳定面选择，且不绑定示例型号', () => {
    const part = {
      id: 'custom-figurine-shell',
      label: '自定义手办外壳',
      role: 'primary',
      stlFile: 'custom.stl',
      stepFile: 'custom.step',
      metrics: {
        valid: true,
        volumeMm3: 100,
        boundsMm: { x: 40, y: 50, z: 60 },
        fitsP1S: true
      }
    };
    expect(cadSelectedFaceFromDescriptor(part, mapping.faces[1])).toEqual({
      partId: 'custom-figurine-shell',
      partLabel: '自定义手办外壳',
      stableId: 'face-b',
      geometryType: 'CYLINDER',
      areaMm2: 30,
      centerMm: [1, 0, 0]
    });
  });

  it('框选命中三角形中心、顶点、包含关系和边界相交', () => {
    const rectangle = { left: 0.4, top: 0.4, right: 0.6, bottom: 0.6 };
    expect(cadTriangleRectangleSamples([
      { x: 0.45, y: 0.45 },
      { x: 0.55, y: 0.45 },
      { x: 0.5, y: 0.55 }
    ], rectangle)).not.toHaveLength(0);
    expect(cadTriangleRectangleSamples([
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.5, y: 0.8 }
    ], rectangle)).not.toHaveLength(0);
    expect(cadTriangleRectangleSamples([
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 },
      { x: 0.2, y: 0.3 }
    ], rectangle)).not.toHaveLength(0);
    expect(cadTriangleRectangleSamples([
      { x: 0.05, y: 0.05 },
      { x: 0.15, y: 0.05 },
      { x: 0.1, y: 0.15 }
    ], rectangle)).toEqual([]);
  });

  it('只接受 PNG Data URL，并转换为 IPC 字节数组', () => {
    expect(screenshotDataUrlToBytes({
      dataUrl: 'data:image/png;base64,iVBORw==',
      width: 1,
      height: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 }
    })).toEqual([137, 80, 78, 71]);
    expect(screenshotDataUrlToBytes({
      dataUrl: 'data:image/jpeg;base64,AA==',
      width: 1,
      height: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 }
    })).toBeNull();
  });

});
