import type { CadGenerationResult } from './cad';
import type { CurvedFeatureDiagnostics, VersionCurvedFeature } from './types';

const diagnosticOperations = new Set([
  'add-cylinder', 'cut-cylinder', 'add-rectangle', 'cut-rectangle', 'cut-slot'
]);

/** 深拷贝曲面受限局部特征，避免版本历史被后续 CAD 重建结果原地修改。 */
export function captureVersionCurvedFeatures(
  cadResult: Pick<CadGenerationResult, 'localFeatures'> | null
): VersionCurvedFeature[] {
  return (cadResult?.localFeatures ?? []).flatMap((feature) => {
    if (
      !diagnosticOperations.has(feature.operation)
      || feature.surfaceGeometryType === 'PLANE'
      || !feature.curvedDiagnostics
      || (
        !['add-rectangle', 'cut-rectangle', 'cut-slot'].includes(feature.operation)
        && feature.radiusMm === null
      )
      || (
        ['add-rectangle', 'cut-rectangle'].includes(feature.operation)
        && (feature.widthMm == null || feature.heightMm == null)
      )
      || (feature.operation === 'cut-slot' && (feature.widthMm == null || feature.lengthMm == null))
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
      widthMm: feature.widthMm ?? null,
      heightMm: feature.heightMm ?? null,
      lengthMm: feature.lengthMm ?? null,
      rotationDeg: feature.rotationDeg ?? 0,
      surfaceTangentU: feature.surfaceTangentU ? { ...feature.surfaceTangentU } : null,
      depthMm: feature.depthMm,
      command: feature.command,
      diagnostics
    }];
  });
}
