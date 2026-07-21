import type { CadGenerationResult } from './cad';
import type { CurvedFeatureDiagnostics, VersionCurvedFeature } from './types';

const circularOperations = new Set(['add-cylinder', 'cut-cylinder']);

/** 深拷贝曲面圆形局部特征，避免版本历史被后续 CAD 重建结果原地修改。 */
export function captureVersionCurvedFeatures(
  cadResult: Pick<CadGenerationResult, 'localFeatures'> | null
): VersionCurvedFeature[] {
  return (cadResult?.localFeatures ?? []).flatMap((feature) => {
    if (
      !circularOperations.has(feature.operation)
      || feature.surfaceGeometryType === 'PLANE'
      || feature.radiusMm === null
      || !feature.curvedDiagnostics
    ) return [];
    const operation = feature.operation as VersionCurvedFeature['operation'];
    const diagnostics: CurvedFeatureDiagnostics = {
      ...feature.curvedDiagnostics,
      interferingStableFaceIds: [...feature.curvedDiagnostics.interferingStableFaceIds]
    };
    return [{
      id: `${feature.createdRevision ?? feature.revision}:${feature.partId}:${operation}`,
      operation,
      partId: feature.partId,
      stableFaceId: feature.stableFaceId,
      surfaceGeometryType: feature.surfaceGeometryType ?? 'UNKNOWN',
      radiusMm: feature.radiusMm,
      depthMm: feature.depthMm,
      command: feature.command,
      diagnostics
    }];
  });
}
