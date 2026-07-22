import { afterEach, describe, expect, it } from 'vitest';
import type { PrintPlatformOverlay } from '../model/printPlatformOverlay';
import { useModelStore } from './useModelStore';

function overlay(sourceIdentity = 'cad:revision-1:part-body'): PrintPlatformOverlay {
  return {
    sourceIdentity,
    objectId: 'body',
    objectLabel: '通用模型主体',
    safetyMarginMm: 5,
    platformBoundsMm: { minimumX: -128, maximumX: 128, minimumZ: -128, maximumZ: 128 },
    effectiveBoundsMm: { minimumX: -123, maximumX: 123, minimumZ: -123, maximumZ: 123 },
    objectBoundsMm: { minimumX: -20, maximumX: 20, minimumZ: -15, maximumZ: 15 },
    overflowMm: { left: 0, right: 0, front: 0, back: 0 },
    overflow: { left: false, right: false, front: false, back: false },
    fitsEffectiveArea: true,
    canFitEffectiveArea: true,
    status: 'inside'
  };
}

afterEach(() => {
  useModelStore.setState({ printPlatformOverlay: null });
});

describe('打印平台视口叠加临时状态', () => {
  it('设置和清除叠加不创建版本或修改版本游标', () => {
    const before = useModelStore.getState();
    const versionIds = before.versions.map((version) => version.id);
    const versionIndex = before.versionIndex;
    const presentations = before.objectPresentations;

    before.setPrintPlatformOverlay(overlay());
    expect(useModelStore.getState().printPlatformOverlay?.objectLabel).toBe('通用模型主体');
    useModelStore.getState().clearPrintPlatformOverlay();

    const after = useModelStore.getState();
    expect(after.printPlatformOverlay).toBeNull();
    expect(after.versions.map((version) => version.id)).toEqual(versionIds);
    expect(after.versionIndex).toBe(versionIndex);
    expect(after.objectPresentations).toBe(presentations);
  });

  it('旧来源清理不会误删已经由新分析写入的叠加', () => {
    useModelStore.getState().setPrintPlatformOverlay(overlay('cad:旧来源'));
    useModelStore.getState().setPrintPlatformOverlay(overlay('uploaded-stl:新来源'));

    useModelStore.getState().clearPrintPlatformOverlay('cad:旧来源');
    expect(useModelStore.getState().printPlatformOverlay?.sourceIdentity).toBe('uploaded-stl:新来源');

    useModelStore.getState().clearPrintPlatformOverlay('uploaded-stl:新来源');
    expect(useModelStore.getState().printPlatformOverlay).toBeNull();
  });

  it('切换模型来源会立即清除旧叠加但不创建版本', () => {
    const store = useModelStore.getState();
    store.setPrintPlatformOverlay(overlay());
    const versionCount = useModelStore.getState().versions.length;

    store.setViewportModelSource('preview');

    expect(useModelStore.getState().printPlatformOverlay).toBeNull();
    expect(useModelStore.getState().versions).toHaveLength(versionCount);
  });

  it('新建画布会清除叠加并建立新的初始版本', () => {
    useModelStore.getState().setPrintPlatformOverlay(overlay());

    useModelStore.getState().resetProject();

    const state = useModelStore.getState();
    expect(state.printPlatformOverlay).toBeNull();
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]?.label).toBe('新模型画布');
  });
});
