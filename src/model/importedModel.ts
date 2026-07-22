/** 上传 STL 的毫米制包围盒，用于拆件平面范围和视口统一定位。 */
export interface ModelBoundsMm {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  x: number;
  y: number;
  z: number;
}

/** 上传网格在进入 OpenCascade 前的通用拓扑诊断与简单孔洞修复指标。 */
export interface MeshRepairMetrics {
  attempted: boolean;
  repaired: boolean;
  inputTriangleCount: number;
  outputTriangleCount: number;
  removedDegenerateTriangleCount: number;
  removedDuplicateTriangleCount: number;
  boundaryEdgeCountBefore: number;
  boundaryEdgeCountAfter: number;
  nonManifoldEdgeCount: number;
  connectedComponentCount: number;
  repairedHoleCount: number;
  addedTriangleCount: number;
}

/** 生成不混淆“上传修洞”和“拆件切割补面”的中文摘要。 */
export function describeMeshRepair(repair: MeshRepairMetrics) {
  if (!repair.repaired) return '未发现开放边、退化面或重复面，无需修复';

  const actions: string[] = [];
  if (repair.repairedHoleCount > 0) {
    actions.push(`修复 ${repair.repairedHoleCount} 个上传网格孔洞，新增 ${repair.addedTriangleCount} 个补面三角形`);
  }
  if (repair.removedDegenerateTriangleCount > 0) {
    actions.push(`移除 ${repair.removedDegenerateTriangleCount} 个退化三角形`);
  }
  if (repair.removedDuplicateTriangleCount > 0) {
    actions.push(`移除 ${repair.removedDuplicateTriangleCount} 个重复三角形`);
  }
  return `已自动${actions.join('，')}`;
}

/** 后端完成修复与封闭性检查后返回的通用 STL 模型清单。 */
export interface ImportedStlModel {
  status: 'ok';
  revision: string;
  id: 'uploaded-model';
  name: string;
  originalFileName: string;
  /** 视口和后续拆件使用的工作模型；发生修复时指向修复后的 STL。 */
  sourceFile: string;
  /** 用户上传内容在内部输出目录中的原始安全文件名。 */
  originalSourceFile: string;
  sourceKind: 'uploaded-stl';
  /** 由精确 CAD 零件主动派生时，记录可追溯的原分支信息。 */
  branchSource?: {
    kind: 'cad-part';
    cadRevision: string;
    partId: string;
    partLabel: string;
    sourceStlFile: string;
  };
  units: 'mm';
  kernel: string;
  outputs: string[];
  files: Record<string, { bytes: number }>;
  metrics: {
    valid: boolean;
    watertight: boolean;
    triangleCount: number;
    solidCount: number;
    volumeMm3: number;
    boundsMm: ModelBoundsMm;
    repair: MeshRepairMetrics;
  };
}
