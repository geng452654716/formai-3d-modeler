import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETERS } from '../model/defaults';
import { createPrintOrientationPresentation } from '../model/printOrientation';
import { normalizeObjectPresentation } from '../model/objectTransform';
import type { ModelVersion } from '../model/types';
import { useModelStore } from './useModelStore';

const originalState = useModelStore.getState();

function version(label: string, objectPresentations: ModelVersion['objectPresentations'] = {}): ModelVersion {
  return {
    id: crypto.randomUUID(),
    label,
    createdAt: new Date().toISOString(),
    parameters: { ...DEFAULT_PARAMETERS },
    interfaceOpenings: null,
    objectPresentations
  };
}

describe('对象变换、颜色与版本历史', () => {
  beforeEach(() => {
    const initial = version('初始模型');
    useModelStore.setState({
      parameters: { ...DEFAULT_PARAMETERS },
      versions: [initial],
      versionIndex: 0,
      cadStatus: 'ready',
      objectTransformMode: 'select',
      objectPresentations: {},
      selectedObject: 'body'
    });
  });

  afterEach(() => {
    useModelStore.setState(originalState, true);
  });

  it('一次连续三维操控器编辑只生成一个版本，并可撤销和重做', () => {
    const store = useModelStore.getState();
    store.beginObjectPresentationEdit('body', '#d9d4c8');
    store.updateObjectPresentation('body', { transform: { positionMm: { x: 3, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 }, scale: 1 } });
    store.updateObjectPresentation('body', { transform: { positionMm: { x: 8, y: 2, z: -1 }, rotationDeg: { x: 0, y: 0, z: 0 }, scale: 1 } });
    store.finishObjectPresentationEdit('body', '移动模型主体', '#d9d4c8');

    expect(useModelStore.getState().versions).toHaveLength(2);
    expect(useModelStore.getState().versions[1].changeKind).toBe('presentation');
    expect(useModelStore.getState().objectPresentations.body.transform.positionMm).toEqual({ x: 8, y: 2, z: -1 });

    useModelStore.getState().undo();
    expect(useModelStore.getState().objectPresentations.body).toBeUndefined();
    expect(useModelStore.getState().cadStatus).toBe('ready');

    useModelStore.getState().redo();
    expect(useModelStore.getState().objectPresentations.body.transform.positionMm).toEqual({ x: 8, y: 2, z: -1 });
    expect(useModelStore.getState().cadStatus).toBe('ready');
  });

  it('同参数的几何版本仍会在撤销时要求重建 CAD', () => {
    useModelStore.getState().commitVersion('几何局部修改');
    useModelStore.setState({ cadStatus: 'ready' });

    useModelStore.getState().undo();

    expect(useModelStore.getState().cadStatus).toBe('stale');
  });

  it('规范化非法数值、缩放和颜色，并在重置时生成中文版本', () => {
    const store = useModelStore.getState();
    store.beginObjectPresentationEdit('body', '#d9d4c8');
    store.updateObjectPresentation('body', {
      transform: {
        positionMm: { x: Number.POSITIVE_INFINITY, y: 2000, z: -2000 },
        rotationDeg: { x: 50000, y: -50000, z: Number.NaN },
        scale: 99
      },
      color: 'red'
    }, '#d9d4c8');
    store.finishObjectPresentationEdit('body', '调整模型主体', '#d9d4c8');

    const normalized = useModelStore.getState().objectPresentations.body;
    expect(normalized.transform.positionMm).toEqual({ x: 0, y: 1000, z: -1000 });
    expect(normalized.transform.rotationDeg).toEqual({ x: 36000, y: -36000, z: 0 });
    expect(normalized.transform.scale).toBe(20);
    expect(normalized.color).toBe('#d9d4c8');

    useModelStore.getState().resetObjectPresentation('body', '重置模型主体变换与颜色', '#d9d4c8');
    const state = useModelStore.getState();
    expect(state.versions.at(-1)?.label).toBe('重置模型主体变换与颜色');
    expect(state.objectPresentations.body.transform.scale).toBe(1);
  });

  it('没有实际变化时不会产生空历史版本', () => {
    const store = useModelStore.getState();
    store.beginObjectPresentationEdit('body', '#d9d4c8');
    store.updateObjectPresentation('body', { color: '#d9d4c8' }, '#d9d4c8');
    store.finishObjectPresentationEdit('body', '调整模型主体颜色', '#d9d4c8');
    expect(useModelStore.getState().versions).toHaveLength(1);
  });


  it('应用推荐打印方向生成一个中文展示版本并可撤销和重做', () => {
    const initialPresentation = {
      transform: {
        positionMm: { x: 8, y: -2, z: 3 },
        rotationDeg: { x: 30, y: 15, z: -10 },
        scale: 1.25
      },
      color: '#123456'
    };
    const initialVersion = version('旋转后的模型', { body: initialPresentation });
    useModelStore.setState({
      objectPresentations: { body: initialPresentation },
      versions: [initialVersion],
      versionIndex: 0
    });
    const store = useModelStore.getState();
    const current = normalizeObjectPresentation(store.objectPresentations.body, '#d9d4c8');
    const next = createPrintOrientationPresentation(current, 'positive-z', '#d9d4c8');

    store.beginObjectPresentationEdit('body', '#d9d4c8');
    store.updateObjectPresentation('body', next, '#d9d4c8');
    store.finishObjectPresentationEdit('body', '应用“模型主体”的打印方向：Z 正方向朝上', '#d9d4c8');

    let state = useModelStore.getState();
    expect(state.versions).toHaveLength(2);
    expect(state.versions.at(-1)).toMatchObject({
      label: '应用“模型主体”的打印方向：Z 正方向朝上',
      changeKind: 'presentation'
    });
    expect(state.objectPresentations.body).toEqual({
      transform: {
        positionMm: { x: 8, y: -2, z: 3 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 1.25
      },
      color: '#123456'
    });

    state.undo();
    state = useModelStore.getState();
    expect(state.objectPresentations.body).toEqual(initialPresentation);
    expect(state.cadStatus).toBe('ready');

    state.redo();
    state = useModelStore.getState();
    expect(state.objectPresentations.body.transform.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.objectPresentations.body.transform.positionMm).toEqual(initialPresentation.transform.positionMm);
    expect(state.objectPresentations.body.transform.scale).toBe(1.25);
    expect(state.objectPresentations.body.color).toBe('#123456');
    expect(state.cadStatus).toBe('ready');
  });

  it('目标绝对旋转没有变化时不会为推荐方向创建重复版本', () => {
    const store = useModelStore.getState();
    const current = normalizeObjectPresentation(store.objectPresentations.body, '#d9d4c8');
    const next = createPrintOrientationPresentation(current, 'positive-z', '#d9d4c8');
    store.beginObjectPresentationEdit('body', '#d9d4c8');
    store.updateObjectPresentation('body', next, '#d9d4c8');
    store.finishObjectPresentationEdit('body', '应用“模型主体”的打印方向：Z 正方向朝上', '#d9d4c8');

    expect(useModelStore.getState().versions).toHaveLength(1);
  });

  it('新建画布会清空变换状态并退出三维操控器工具', () => {
    useModelStore.setState({
      objectTransformMode: 'rotate',
      objectPresentations: {
        body: {
          transform: { positionMm: { x: 1, y: 2, z: 3 }, rotationDeg: { x: 4, y: 5, z: 6 }, scale: 2 },
          color: '#112233'
        }
      }
    });
    useModelStore.getState().resetProject();
    const state = useModelStore.getState();
    expect(state.objectTransformMode).toBe('select');
    expect(state.objectPresentations).toEqual({});
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].label).toBe('新模型画布');
  });
});
