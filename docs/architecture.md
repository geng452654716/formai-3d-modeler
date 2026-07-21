# 技术架构

## 1. 总体原则

产品以精确可制造实体为核心，采用 CAD 与网格混合架构：

- CAD 内核负责精确尺寸、布尔运算、壳体、圆角、开孔和装配特征；
- Blender/网格 Worker 负责自由网格编辑、复杂外形和后续有机模型；
- Three.js 负责实时预览和交互，不作为最终精确几何的唯一来源；
- Codex 负责编排和生成结构化建模操作，建模内核负责确定性执行。

## 2. 推荐技术栈

### 桌面应用

- Tauri 2；
- React + TypeScript；
- React Three Fiber / Three.js；
- Zustand 或等价轻量状态管理；
- macOS 首发，架构保留 Windows 支持。

### 精确建模 Worker

- Python sidecar；
- CadQuery + OpenCascade；
- STEP/BREP 作为精确实体中间产物；
- STL/GLB 作为视口可加载的三角化预览产物；
- STL 与 3MF 作为打印输出。

### 网格建模 Worker

- Blender 后台进程；
- Blender Python API；
- 用于网格编辑、复杂表面、颜色和后续贴图能力。

### Codex 集成

- 首选 Codex App Server，与自定义桌面 UI 深度集成；
- 通过 JSON-RPC 启动线程、发送回合、附加图片、接收流式事件和处理认证状态；
- 复用本机 Codex 配置和认证；
- 自动执行仍运行在项目级 workspace-write 沙箱中，不使用无沙箱危险模式；
- App Server 协议处于实验阶段，因此连接层必须隔离在单独 adapter 中，避免协议变化影响建模核心。

开发初期可以使用 `codex exec --json` 作为更简单的备用适配器，等核心工作流稳定后切换或并行支持 App Server。

### 自有几何后端

产品不接入 Fusion 360。`GeometryBackend` 作为内部抽象，用于隔离 UI、AI 操作协议和具体几何执行器：

- OpenCascade/CadQuery：默认且首版唯一的精确实体后端；
- Blender：后续网格和自由表面后端；
- Three.js CSG：仅用于低延迟交互预览，不作为最终可制造实体的权威来源。

圆角、倒角、布尔运算、内部掏空、接口开孔、包络和装配间隙均由本地 OpenCascade Worker 确定性执行。

## 3. 系统模块

```text
Desktop UI
├── Project Manager
├── Reference Image Board
├── Chat / Codex Activity
├── Scene Tree
├── 3D Viewport
├── Object / Face Selection
├── Transform Gizmo
├── Feature & Dimension Panel
├── Version Timeline
└── Export / Print Validation

Tauri Host
├── Codex Adapter
│   ├── App Server Client
│   └── Exec JSON Fallback
├── Project File Service
├── Process Supervisor
├── Version Store
├── Screenshot / Selection Context Builder
└── Worker RPC Client

Modeling Workers
├── CAD Worker (CadQuery / OpenCascade)
├── Mesh Worker (Blender)
├── Tessellation / Preview Worker
├── Validation Worker
└── STL / 3MF Exporter
```

版本快照读取采用最小权限 IPC：前端只能提交 Store 已保存的快照目录和清单声明文件名；Rust 对 `artifacts/versions` 根目录、规范化后的直接子目录、普通文件名、清单声明和最终规范化文件路径逐层校验。创建快照时只复制当前 `generation-result.json` 及其 `outputs`、`parts[].stlFile`、`parts[].stepFile` 和 `assemblyFile` 明确声明的当前 CAD 文件，不再携带壁厚、拆件、局部编辑或版本差异临时结果；复制期间复用生成锁，失败时删除不完整目录。三维视口只直接解析 STL。精确版本差异由 Rust 内部构造历史快照目录、当前 artifacts 目录和固定 Worker 路径，把清单声明的 STEP 交给 OpenCascade 执行双向布尔差集；前端不能传入任意 STEP 或输出路径，且只能读取结果清单声明的 `version-difference-*.stl`。

## 4. 项目数据结构

```text
project-name/
├── project.json
├── scene.json
├── parameters.json
├── references/
│   ├── front.png
│   ├── side.png
│   └── annotations.json
├── components/
│   ├── pcb.step
│   └── pcb.metadata.json
├── features/
│   └── feature-graph.json
├── scripts/
│   ├── cad.py
│   └── mesh.py
├── artifacts/
│   ├── model.step
│   ├── preview.glb
│   ├── output.stl
│   └── output.3mf
└── versions/
    └── <version-id>/
```

## 5. AI 操作协议

Codex 优先输出结构化操作，而不是直接重写整个模型文件：

```json
{
  "intent": "为 PCB 创建带接口开孔的上下壳",
  "operations": [
    {
      "type": "create_component_envelope",
      "target": "pcb-main",
      "parameters": {
        "clearance_xy_mm": 0.3,
        "clearance_z_mm": 0.5
      }
    },
    {
      "type": "create_shell",
      "target": "pcb-main-envelope",
      "parameters": {
        "wall_thickness_mm": 2.0,
        "split": "horizontal"
      }
    },
    {
      "type": "cut_port",
      "target": "bottom-shell",
      "parameters": {
        "component_port": "usb-c",
        "clearance_mm": 0.4
      }
    }
  ]
}
```

标准操作由建模 Worker 确定性执行。只有标准操作不足以表达复杂造型时，Codex 才生成受版本控制的 CadQuery 或 Blender Python 脚本。

### 多视角参考图与通用精确开孔数据流

1. 桌面后端按视角逐张调用本机 Codex 视觉输入，返回结构化尺寸、接口、置信度、是否需要开孔、可选二维开孔轮廓和中文警告；
2. `multiViewCalibration.ts` 使用各图双点标定比例的中位数融合尺度，并报告最大相对偏差；
3. 接口按稳定 ID 或类型与尺寸相似度形成跨视角分组，候选相似匹配必须标记为待人工确认；
4. 人工复核层可以确认候选、拆成独立接口、忽略误识别，或覆盖接口 ID、类型、所在面、尺寸、位置、是否开孔和开孔轮廓；人工覆盖值保存在 `MatchedInterface.reviewedInterface`，不修改原始观测，便于追溯；
5. 只要仍有 `needs-confirmation` 分组，联合应用入口就保持禁用；忽略项不进入项目接口列表或开孔协议；
6. Zustand 保存参考视角记录和联合结果，并同步写入本机 `localStorage`；当前不保存图片二进制，也不替代未来的项目文件服务；
7. 所有经过复核、`requiresOpening=true` 且能够确定正交接口面的接口进入 `InterfaceOpeningSpec[]`；支持正面、背面、左侧、右侧、顶部和底部，不再绑定 USB-C 或固定模型类别；
8. 单张透视图只能提供二维观测，不能单独确定精确接口面。开孔宽高与位置来自相应正交视图的二维标定平面，不包含相机位姿推导；
9. 单视角照片接口框编辑使用 `imageRecognition.ts` 的确定性二维坐标换算：毫米宽高转换为图片百分比框，拖动后按图片中心回算横向偏移，按接口框底边回算底部偏移；接口框被限制在照片边界内，最小可操作尺寸为 8 像素；
10. 照片直接编辑只覆盖当前 `ReferenceViewRecord.analysis.interfaces`，同时保留当前识别批次的原始接口副本用于恢复；任何编辑都会清空旧联合结果，并要求用户重新执行联合标定，防止过期匹配被继续应用；
11. 前端把复核结果转换为通用开孔记录，同时保存解析后的中心坐标，以及 `face-center-bottom` 定位来源、相对接口面水平中心的毫米偏移和相对底边的毫米偏移；Vite 开发后端和 Tauri/Rust 后端执行相同的字段校验与 camelCase 到 snake_case 转换，再交给 Python Worker；
12. `modeling/generate_model.py` 使用 OpenCascade Boolean 生成圆孔、矩形孔、圆角矩形孔和槽孔；顶部开孔切上盖，其余五面开孔切主体；
13. Worker 在切削前检查保守边缘余量和同面孔间距，在切削时检查开孔体与目标实体实际相交，并在每次 Boolean 后检查有效、封闭且为单一 Solid；结果清单返回开孔模式、开孔列表及主体/上盖计数；
14. 参数中缺少 `interface_openings` 表示继续使用模板 USB 开孔；显式传入空数组表示禁用所有接口开孔；非空数组表示由照片/人工复核开孔覆盖模板 USB；
15. Zustand 在手工参数或 Codex 参数变化时按照片定位锚点重新解析中心坐标；Python Worker 也会基于当前外壳尺寸再次解析，避免 Web 与桌面链路不一致。侧面使用当前外壳高度，顶部和底部使用当前外壳宽度；接口宽高和物理偏移保持毫米值，不按比例缩放；
16. 老项目没有定位来源字段时继续使用原固定中心坐标；界面标记为“固定坐标，建议重新复核”。

该数据流不包含相机内外参求解、特征点三角化、SfM、稠密网格重建、受力分析、疲劳分析或有限元分析。

## 6. Codex 回合流程

1. UI 收集文字、参考图片、当前视角截图、对象 ID、面 ID 和尺寸参数；
2. Tauri 创建执行前快照；
3. Codex Adapter 向线程发送上下文；
4. Codex 读取项目中的 `scene.json`、参数和建模规则；
5. Codex 生成结构化操作或脚本；
6. Worker 在临时版本目录执行；
7. 验证 Worker 检查尺寸、封闭性、壁厚、碰撞和打印区域；
8. 验证通过后提交新版本，并更新 STL/GLB 预览；
9. 验证失败时保留旧版本并把错误返回给同一个 Codex 线程修复；
10. UI 展示结果摘要与前后差异。

## 7. 选择与局部修改

视口中的对象、实体、面和可编辑网格元素需要可验证的选择标识。当前参数化 CAD 已实现第一版稳定面选择链路：

1. CadQuery/OpenCascade Worker 为零件的每个 OpenCascade 面生成“几何签名匹配第一版”的稳定面 ID。签名组合曲面类型、归一化中心、归一化包围盒、面积比例、法向和边拓扑摘要，并只在同一稳定零件 ID 内执行一对一匹配。
2. `modeling/face_tessellation_mapping.py` 逐面独立三角化，再按稳定面顺序连接为专用选择 STL；映射 JSON 为每个稳定面记录连续的 `[triangleStart, triangleStart + triangleCount)` 区间。选择 STL 只服务交互命中，与面向用户的 STL 导出分离。
3. Three.js 点击事件使用 `event.faceIndex` 作为本次选择网格的 `triangleIndex`，通过连续区间回查稳定面 ID。
4. 框选先判断投影后的屏幕空间三角形与框选矩形是否相交，再从摄像机向候选采样点发射射线；只有第一命中仍属于候选稳定面时才保留，因此默认只选择当前视角可见面。
5. 命中坐标先通过 `worldToLocal` 去除装配或拆分视图的零件位移，再应用选择网格坐标逆变换，恢复为零件原始毫米坐标；法线通过对应的逆变换法线矩阵恢复并归一化。
6. WebGL 画布启用可读取缓冲，点击或框选结束后裁剪局部 PNG。Data URL 不进入文本命令，桌面后端会把 PNG 字节作为 Codex 图片附件传输。

发送给 Codex 的结构化局部上下文至少包含：

- 当前零件 ID、名称和原始毫米包围盒；
- 一个或多个稳定面 ID、曲面类型、面积和面中心；
- 点击命中的原始毫米坐标、逆变换后的外法线和本次 `triangleIndex`；
- 当前摄像机矩阵、选择方式和框选区域；
- 局部 PNG 截图、尺寸上下文和用户指令。

稳定 CAD 局部特征的数据流如下：

1. 前端只接受当前修订中已经完成 OpenCascade 精确解析的单个稳定面或单条稳定边。稳定平面可执行圆形/矩形凸台、圆孔/矩形孔/槽孔、整面向外拉伸或向内偏移；稳定平面所属单边可执行圆角或等距倒角；非平面稳定面只允许受限圆形凸台、圆孔、矩形凸台、矩形孔和槽孔。
2. 请求携带清单修订号、零件 ID、稳定面 ID、可选稳定边 ID、真实毫米点击坐标、真实外法线、曲面类型、当前修订 UV、当前 UV 位置的真实单位 U 切向、判别式尺寸字段、深度、旋转角和原始中文指令。圆形只携带半径，矩形只携带宽高，槽孔只携带宽度和总长度，无关尺寸字段必须为空。
3. Tauri 命令 `run_local_cad_feature` 与 Vite 本机路由 `/api/model/local-cad-feature` 执行相同的操作白名单、目标绑定、字符串长度、有限数值和尺寸范围校验，再调用 `modeling/local_cad_feature.py`。Codex 只能返回受限 JSON 计划，不能输出或执行 Python、CadQuery、Shell，也不能改写当前选择的零件、稳定面、稳定边、中心、法线或 UV。
4. Worker 读取当前 `generation-result.json`，拒绝过期修订号，并在当前 STEP 中使用 `partId + stableFaceId` 或 `partId + stableFaceId + stableEdgeId` 重新定位 OpenCascade 拓扑。实际布尔方向只来自重新定位面的外法线；视口法线只用于点积一致性检查，点击点还要通过真实面或真实边的距离校验。
5. 非平面矩形与槽孔在当前修订的真实 UV 点击位置建立切平面，`rotationDeg=0` 沿该位置的真实 U 切向，正角度围绕真实外法线旋转；矩形凸台沿外法线加料，矩形孔与槽孔沿内法线切削。Worker 会根据当前 OpenCascade 几何重新计算 U 切向，并校验请求切向没有过期、反向或退化。矩形使用半对角线、槽孔使用总长度一半作为保守包络半径，执行曲率比、裁剪边界、壁厚、自交和相邻稳定面干涉检查。它们是点击位置切平面的安全近似，不是沿任意曲面贴合或测地线生成的轮廓。
6. 结果必须是有效、封闭、单一 Solid；增加材料的操作体积必须增加，切削操作体积必须减少；重新导出的 STL 必须能再次读入且体积误差在容差内。曲面受限特征还会保存曲率、壁厚、通孔和干涉诊断。
7. 成功后重新生成稳定面/稳定边描述、几何签名匹配摘要、专用选择 STL、面映射、用户 STL/STEP 和通用多零件 3MF，并原子更新清单修订号与 `localFeatures[]`。每条记录保存目标几何签名快照、创建修订号和重放状态；前端清除旧选择，因为原 `triangleIndex`、曲面 UV 和稳定边选择只对修改前修订有效。

参数化整模重建先调用 `build_body()` / `build_cover()` 得到不含局部特征的基础实体，再按 `localFeatures[]` 历史顺序重放。每条记录执行前都重新校验操作、零件、稳定面、稳定边、记录中心、外法线、当前曲面 UV、尺寸和旋转角；直接稳定 ID 不可用时，可使用目标面或目标边的几何签名快照进行第一版辅助匹配。曲面诊断不直接复用旧值，而是根据当前 OpenCascade 几何重新计算。任一条失败都会在导出前终止，因此不会覆盖最后有效的 STEP、STL、3MF、选择网格或清单，也不允许静默跳过。

能力边界必须明确：稳定面 ID、稳定边 ID 和几何签名回退都是“几何签名匹配第一版”，不是 OpenCascade 原生永久拓扑命名；大幅拓扑变化、对称面或布尔重建可能重新编号。`triangleIndex`、曲面 UV 和 U 切向只对当前修订有效，局部修改、重新三角化、第三方修复或普通导出都可能改变顺序或方向。上传 STL 使用独立的网格区域和壁厚采样协议，不套用参数化 CAD 的稳定面映射。当前尚未提供曲面整面偏移、曲面所属边圆角/倒角、沿任意自由曲面贴合的轮廓、框选多面布尔或任意拓扑顶点/边/面编辑；曲面矩形凸台和矩形孔已经按真实 UV 点击位置切平面的安全近似实现。

## 8. 版本与撤销

- 手工操作与 AI 操作都形成统一命令记录；
- 高频 Gizmo 拖拽合并为一次历史操作；
- 每次 AI 回合创建版本节点；
- 版本保存参数、特征图、脚本哈希、精确实体和预览；
- 支持撤销/重做、恢复、分支、并排对比和半透明重叠对比。

当前已经落地版本列表、任意版本恢复、分支截断、参数与通用开孔元数据对比，以及历史/当前 STL 的蓝橙重叠和按真实毫米宽度并排显示。桌面端还可按稳定零件 ID 读取历史与当前 STEP，执行 `current - base` 和 `base - current` 两个 OpenCascade 精确布尔差集；视口以绿色显示新增区域、红色显示删除区域，并报告体积。该实体级差异不依赖面 ID。参数化 CAD 清单会保存面/边几何签名与近似稳定 ID，版本实体对比可统计共享、新增和消失编号；版本历史还能对比非平面圆形凸台、圆孔、矩形凸台、矩形孔和受限槽孔的尺寸、旋转角、真实 U 切向、曲率、壁厚、通孔及干涉诊断。仍未实现的是任意拓扑修改下的永久稳定命名、完整自由曲面特征和多面操作。

## 9. 打印验证

导出前至少检查：

- 模型是否封闭和流形；
- 是否存在自交；
- 是否有零厚度或退化几何；
- 最小壁厚；
- 元件与外壳的间隙；
- 螺丝柱、孔位和接口是否碰撞；
- 包围盒是否超过所选拓竹打印机成型尺寸；
- 模型是否存在未连接悬浮部件；
- STL/3MF 输出尺寸是否与项目毫米尺寸一致。

悬垂角、支撑和摆盘属于切片相关检查，可在几何验证稳定后增加。

## 10. 实施阶段

### Phase 1：端到端骨架

- Tauri 桌面壳；
- Three.js 视口；
- 项目创建与保存；
- Codex App Server/Exec adapter；
- CAD Worker 创建基础盒体；
- GLB 预览；
- STL 导出。

### Phase 2：电子外壳

- 元件尺寸与 STEP/STL 导入；
- 包络、掏空、壁厚、开孔、螺丝柱；
- 参数面板；
- 打印验证；
- 3MF 几何导出。

### Phase 3：AI 局部修改与历史

- 对象/面/框选上下文；
- 局部截图；
- 自动版本；
- 撤销/重做；
- 版本差异对比。

### Phase 4：网格编辑

- Blender Worker；
- 顶点、边、面模式；
- 参数化实体转网格分支；
- 复杂参考图建模能力。

## 非平面矩形局部特征安全语义

- 方向基准只来自当前 STEP 中目标稳定面真实 UV 位置的 OpenCascade 单位 U 切向。客户端命中结果负责传递该上下文，Python Worker 在执行前重新计算并校验；Codex 结构化计划只能提供矩形宽高、深度与旋转角，不能提供或覆盖 U 切向。
- OpenCascade 切平面的局部 X 轴以真实 U 切向为零度方向，并绕真实外法线应用 `rotationDeg`。Three.js 对加料和切削使用等价坐标变换，切削预览因局部法线反向而对局部旋转角做符号补偿，保证正角度语义一致。
- 安全包络半径为矩形半对角线 `sqrt(width² + height²) / 2`。同一包络进入曲率、裁剪边界、壁厚、自交和相邻面干涉检查，避免只验证四角造成边缘或旋转后的范围漏检。
- 结果协议、版本快照与参数化重放都保存矩形宽、高、深度、旋转角、当前修订 U 切向和曲面诊断。重放时重新定位稳定面并重新计算方向和诊断，不信任历史诊断；旧记录缺少 U 切向可补写，但历史反向切向会被拒绝。
- 该能力不改变拓扑命名边界：稳定面仍是“几何签名匹配第一版”，`triangleIndex`、UV 和 U 切向只对当前修订有效；曲面矩形不是曲面贴合、投影包裹或测地线轮廓。
