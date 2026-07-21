export interface VersionGeometryDifferencePartMetrics {
  baseVolumeMm3: number;
  currentVolumeMm3: number;
  addedVolumeMm3: number;
  removedVolumeMm3: number;
  addedSolidCount: number;
  removedSolidCount: number;
  volumeToleranceMm3: number;
  changed: boolean;
}

export interface VersionGeometryDifferencePart {
  id: string;
  label: string;
  role: string;
  changeType: 'unchanged' | 'modified' | 'added-part' | 'removed-part';
  addedStlFile: string | null;
  removedStlFile: string | null;
  metrics: VersionGeometryDifferencePartMetrics;
}

export interface VersionGeometryDifferenceResult {
  status: 'ok';
  revision: string;
  units: 'mm';
  kernel: string;
  method: 'OpenCascade 精确布尔差集' | string;
  baseRevision: string;
  currentRevision: string;
  outputs: string[];
  summary: {
    partCount: number;
    changedPartCount: number;
    addedVolumeMm3: number;
    removedVolumeMm3: number;
  };
  parts: VersionGeometryDifferencePart[];
}
