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
├── 三维变换操控器
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

1. 前端只接受当前修订中已经完成 OpenCascade 精确解析的单个稳定面、一条种子稳定边，或同一零件中按顺序选择的 2–64 条稳定边。稳定平面可执行圆形/矩形凸台、圆孔/矩形孔/槽孔、整面向外拉伸或向内偏移；稳定边可执行单边、唯一切线连续边链、平面唯一边界 Wire 整圈，或手工多选无分叉开放/闭合边链圆角与倒角。非平面所属边不允许整圈，但可以参与单边、唯一切线链或手工多选边链。
2. 请求携带清单修订号、零件 ID、稳定面 ID、可选单一种子稳定边 ID，以及手工边链专用的逐边精确目标数组。每个逐边目标都保存所属稳定面、稳定边、真实毫米点击坐标、真实外法线、曲面类型和当前修订 UV；手工操作不得同时携带单一种子边。普通轮廓仍携带真实 U 切向、判别式尺寸字段、深度、旋转角和原始中文指令，且无关尺寸字段必须为空。
3. Tauri 命令 `run_local_cad_feature` 与 Vite 本机路由 `/api/model/local-cad-feature` 执行相同的操作白名单、目标绑定、字符串长度、有限数值和尺寸范围校验，再调用 `modeling/local_cad_feature.py`。Codex 只能返回受限 JSON 计划，不能输出或执行 Python、CadQuery、Shell，也不能改写当前选择的零件、稳定面、稳定边、中心、法线或 UV。
4. Worker 读取当前 `generation-result.json`，拒绝过期修订号，并在当前 STEP 中使用 `partId + stableFaceId` 或 `partId + stableFaceId + stableEdgeId` 重新定位 OpenCascade 拓扑。整圈操作把 `stableEdgeId` 视为种子边：在重新定位的稳定平面中查找包含该边的唯一 Wire，过滤退化边，并要求剩余 2–64 条边。切线链操作从种子边两端传播，顶点容差为 `max(1e-6, min(1e-3, 包围盒对角线 × 1e-7))`，相邻切向夹角不超过 5 度，每个端点只能有一个合格后继；无后继、分叉、少于 2 条或超过 64 条都会拒绝。传播结果的全部边一次性进入同一个 OpenCascade fillet/chamfer。实际布尔方向只来自重新定位面的外法线；视口法线只用于点积一致性检查，点击点还要通过真实面或真实边的距离校验。
5. 非平面圆形、矩形和槽孔在正式写入前先执行 `previewOnly` 精确预检。预检复用正式布尔的 STEP、稳定面、真实 UV、外法线、真实 U 切向、曲率、局部壁厚和干涉算法，并导出最终布尔实际使用的 `local-cad-feature-tool-preview.stl`；该 STL 是作用工具体，不是最终布尔结果。
6. 预检结果绑定当前 `revision + partId + stableFaceId + surfaceUv + surfaceTangentU`，返回工具体有效性、封闭性、Solid 数、体积、包围盒，以及是否再次接触目标曲面、是否碰到非目标稳定面、干涉稳定面 ID、最近干涉距离、接触面数和接触采样数。只有 `status=ok` 才允许保存修改前快照并调用正式 Worker；`blocked` 或预检异常不创建版本、不写模型，并保留当前模型、选择和精确工具体用于查看。
7. 非平面矩形与槽孔在当前修订的真实 UV 点击位置建立切平面，`rotationDeg=0` 沿该位置的真实 U 切向，正角度围绕真实外法线旋转；矩形凸台沿外法线加料，矩形孔与槽孔沿内法线切削。Worker 会根据当前 OpenCascade 几何重新计算 U 切向，并校验请求切向没有过期、反向或退化。矩形使用半对角线、槽孔使用总长度一半作为保守包络半径，执行曲率比、裁剪边界、壁厚、自交和相邻稳定面干涉检查。它们是点击位置切平面的安全近似，不是沿任意曲面贴合或测地线生成的轮廓。
8. 正式结果必须是有效、封闭、单一 Solid；增加材料的操作体积必须增加，切削操作体积必须减少；重新导出的 STL 必须能再次读入且体积误差在容差内。曲面受限特征还会保存曲率、壁厚、通孔和干涉诊断。
9. 成功后重新生成稳定面/稳定边描述、几何签名匹配摘要、专用选择 STL、面映射、用户 STL/STEP 和通用多零件 3MF，并原子更新清单修订号与 `localFeatures[]`。每条记录保存目标几何签名快照、创建修订号和重放状态；前端清除旧选择，因为原 `triangleIndex`、曲面 UV 和稳定边选择只对修改前修订有效。

参数化整模重建先调用 `build_body()` / `build_cover()` 得到不含局部特征的基础实体，再按 `localFeatures[]` 历史顺序重放。每条记录执行前都重新校验操作、零件、稳定面、稳定边、记录中心、外法线、当前曲面 UV、尺寸和旋转角；直接稳定 ID 不可用时，可使用目标面或目标边的几何签名快照进行第一版辅助匹配。整圈和切线链记录都只保存种子稳定边快照：整圈在当前稳定平面重新推导唯一 Wire，切线链在当前实体从种子边两端重新推导唯一连续链，均不能复用旧边数组。曲面诊断不直接复用旧值，而是根据当前 OpenCascade 几何重新计算。任一条失败都会在导出前终止，因此不会覆盖最后有效的 STEP、STL、3MF、选择网格或清单，也不允许静默跳过。

能力边界必须明确：稳定面 ID、稳定边 ID 和几何签名回退都是“几何签名匹配第一版”，不是 OpenCascade 原生永久拓扑命名；大幅拓扑变化、对称面或布尔重建可能重新编号。`triangleIndex`、曲面 UV 和 U 切向只对当前修订有效，局部修改、重新三角化、第三方修复或普通导出都可能改变顺序或方向。上传 STL 使用独立的网格区域和壁厚采样协议，不套用参数化 CAD 的稳定面映射。当前已支持任意稳定面所属单条稳定边的固定半径圆角和等距倒角、两端唯一且切向夹角不超过 5 度的切线连续边链传播第一版，以及种子边所属唯一平面边界 Wire 的整圈传播第一版；非平面所属边必须绑定当前修订的真实 UV，并重新复核真实曲面点、外法线和目标边距离，且不允许整圈。当前尚未提供曲面整面偏移、手工多选边链、分叉切线链、多个 Wire、可变半径、连续性等级控制、沿任意自由曲面贴合的轮廓、框选多面布尔或任意拓扑顶点/边/面编辑；曲面矩形和槽孔均按真实 UV 点击位置切平面的安全近似实现。精确工具体预演只展示正式布尔的作用体，不等于最终布尔结果。

## 8. 版本与撤销

- 手工操作与 AI 操作都形成统一命令记录；
- 高频三维操控器拖拽合并为一次历史操作；
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

## 曲面精确预检风险交互（第 32 阶段）

`LocalCadFeaturePreview` 在 `blocked` 状态保存精确预检结果和 `focusedInterferenceFaceId`。后者只是视口定位状态，不属于建模请求，不会回写稳定面选择或改变目标曲面的真实 UV。Store 只接受预检 `interferingStableFaceIds` 列表中的 ID，非法 ID 保持原状态。

`LoadedCadMesh` 使用当前零件的 `faceTessellation.faces` 将干涉稳定面 ID 映射回三角范围。渲染前同时校验请求修订、预检修订、当前 CAD 修订、请求零件、预检零件和选择网格零件；上下文不一致时不生成风险高亮。全部干涉面使用红色半透明覆盖，当前定位面使用亮红色二次覆盖，并在该面中心显示中文标记。目标面原有黄色高亮独立保留。

风险参数面板不直接调用 Python Worker，也不修改 B-Rep。它把用户调整后的直径、宽度、高度、长度、深度和旋转角生成确定性中文命令，调用现有 `executeCommand()`：

```text
受限参数校验 → 当前稳定面和真实 UV 重新绑定 → OpenCascade 精确工具体预检
→ blocked 时继续保留模型 → 通过后保存快照 → 正式 Worker → 单 Solid 结果校验
```

因此参数重试与首次自动执行共享同一安全门，不存在第二套可绕过预检的执行入口。Codex 仍只能返回受限 JSON，不执行 Python、CadQuery 或 Shell。

曲面矩形和槽孔仍以真实 UV 点击位置的切平面为局部坐标系，`rotationDeg=0` 沿真实 U 切向；这是安全近似，不是自由曲面贴合或测地线轮廓。稳定面仍是“几何签名匹配第一版”，所有命中和定位上下文只对当前修订有效。

## 精确预检历史与受限参数收敛

曲面局部特征的执行前预检采用独立事件档案，而不是模型版本：

```text
LocalCadFeatureRequest
  → OpenCascade 精确工具体预检
  → LocalCadFeaturePreflightRecord（通过或阻断都深拷贝留档）
  → 阻断：保留当前 CAD，不创建 ModelVersion
  → 通过：保存修改前快照并调用正式 Worker
  → Worker 成功：记录 executedRevision，再提交 ModelVersion
```

`LocalCadFeaturePreflightRecord` 保存源修订、零件、稳定面、真实 UV、U 切向、受限参数和完整结构化诊断，最多保留最近 50 条。历史记录是只读证据，不是当前选择上下文；恢复版本、切换模型视图或查看历史都不能把记录中的稳定面或 UV 重新变成可执行目标。

`compareLocalCadFeaturePreflights()` 只比较同目标的两条不可变记录，输出参数差异、工具体与安全诊断差异及干涉稳定面增减。`suggestLocalCadFeatureRiskAdjustments()` 是确定性纯函数，只生成缩小轮廓、降低深度或小范围旋转的候选，并逐条复用 `validateLocalCadFeatureAdjustment()`。它不调用 Codex、Python、Shell 或 CAD Worker，也不声称候选已经修复风险；真正应用时仍通过 `buildAdjustedLocalCadFeatureCommand()` 回到完整 OpenCascade 预检和正式执行链。


### 36. 切线连续边链圆角与倒角第一版（已实现）

- `fillet-edge-chain` 与 `chamfer-edge-chain` 仍以当前修订中的单条种子稳定边为唯一输入，不开放任意边 ID 数组。确定性解析器和 Codex 结构化计划只有在中文明确要求切线传播时才能选择这两个操作；“整圈”和“切线链”同时出现时必须拒绝。
- Worker 从种子边两端遍历当前实体的非退化边，以毫米顶点容差连接，并要求相邻边端点切向夹角不超过 5 度。每个传播端点必须恰好只有一个合格后继；没有后继时停止该方向，两个方向都没有后继则拒绝，多个候选则按分叉链拒绝。最终边链必须为 2–64 条。
- 平面和非平面种子边都可使用切线链。非平面仍复用真实 UV、真实曲面点、真实外法线与点击到种子边距离的安全校验；切线链本身不放宽曲面命中协议。
- 所有传播边在一个 OpenCascade fillet/chamfer 中同时执行，返回 `affectedEdgeCount` 和 `edgeScope=tangent-chain`。有效性、封闭性、单 Solid、体积变化、STL 回读与原子文件替换规则保持不变。
- 参数化记录只保存种子稳定边及其“几何签名匹配第一版”快照，重放时从当前实体重新推导链；不持久化旧边数组，也不承诺永久拓扑命名。
- 当前不支持手工多选边链、分叉链、可变半径、连续性等级控制或指定切线角阈值。

2026-07-21 第 36 阶段完整回归通过：前端 18 个测试文件 136/136，Rust 29/29，稳定 CAD 单边/整圈/切线链边特征 18/18，参数化局部特征安全重放 15/15，曲面局部特征 23/23，平面局部特征 7/7，曲面命中 7/7；TypeScript/Vite 生产构建、`cargo check`、Rust 测试、全部 Modeling 回归、Python 语法编译、Rust 格式检查和 `git diff --check` 均通过。仅保留既有 Vite 大分块警告与 CadQuery/Pyparsing 弃用警告。


## 手工多选边链协议

手工边链是显式用户选择协议，不是切线自动传播协议：

```text
视口按顺序选边（2–64 条）
  → 每条边完成 OpenCascade 精确解析
  → Codex 只返回原顺序 stableFaceId + stableEdgeId 列表
  → 前端、Tauri/Vite 与 Worker 复核目标完全一致
  → OpenCascade 按真实物理边去重并验证无分叉开放链或闭合链
  → 同一次 fillet/chamfer 处理整链
  → 原子写回 STEP/STL/选择资产/3MF 与 localFeatures[]
```

- 逐边目标可以跨所属稳定面，但所有边必须属于同一个零件；同一物理边即使从不同所属面点击也只能出现一次。
- 连通图中每个顶点度数必须符合开放链或闭合链：开放链恰有两个度数为 1 的端点，其余为 2；闭合链所有顶点度数为 2。任何分叉、不连续或退化边都拒绝。
- 参数化记录保存逐边稳定 ID、所属面和几何签名快照。重放时先验证旧稳定边 ID，再用当前稳定面重新生成边描述，并用当前描述与旧快照共同确认同一物理边；全部成功后才刷新逐边快照。
- 任何边重定位失败、几何签名失配、顺序变化或 OpenCascade 构造失败都会拒绝整次重建，不能部分应用，也不能覆盖最后有效模型。
- `edgeScope=manual-chain` 只表示用户显式选定的单条无分叉边链，不代表支持可变半径、G1/G2 连续性设置、分叉边网或永久拓扑命名。

2026-07-21 第 37 阶段完整回归通过：前端 18 个测试文件 141/141，Rust 33/33，稳定 CAD 边特征 22/22，参数化局部特征安全重放 17/17，曲面命中 7/7；TypeScript/Vite 生产构建、Cargo 检查与测试、Python 语法、Rust 格式和差异格式检查均通过。

## 对象显示变换与制造导出

对象状态由 `src/model/objectTransform.ts` 定义，并以稳定场景对象 ID 保存在 Zustand 的 `objectPresentations` 中。每个对象包含毫米位置、XYZ 欧拉角、均匀缩放和基础颜色。高频三维操控器更新与版本提交分离：`beginObjectPresentationEdit` 捕获修改前状态，拖动或输入期间只更新预览，`finishObjectPresentationEdit` 在真实变化时提交一个版本。历史版本使用 `geometry / presentation` 分类：纯显示版本恢复对象状态但不触发 OpenCascade 重建；跨过任何几何版本时仍将 CAD 标记为需要重建，避免局部 CAD 特征在参数未变化时被误判为纯显示修改。

视口采用两层变换：外层承载装配基础位置或拆分视图临时偏移，内层承载用户可持久化变换。CAD 点击使用对象的 `worldToLocal`，框选使用 `localToWorld`，确保显示变换不会破坏稳定面原始毫米坐标协议。第一版缩放严格为均匀缩放。

制造导出链路为：

1. 前端 `src/model/objectExport.ts` 规范化对象状态并构造只含 artifacts 普通文件名的请求；
2. Rust `export_transformed_model` 校验对象数、文件清单、扩展名、数值范围和颜色，并在后台线程调用 Worker；
3. `modeling/export_transformed_model.py` 解析 ASCII/二进制 STL，把源坐标 `(x, y, z)` 转换为显示坐标 `(x, z, -y)`，按 Three.js Euler XYZ 应用缩放、旋转、装配基础位置和用户位移，再转换回源坐标；
4. STL 输出二进制三角网格；3MF 输出标准 OPC 包、毫米单位、多对象、中文名称和 `basematerials` 颜色；
5. Worker 通过临时文件、重读和原子替换完成 artifacts 输出，Rust 再处理下载目录重名并复制文件。

CAD 制造拆件复用源 CAD 零件的稳定对象 ID，上传 STL 拆件使用独立的正负侧对象 ID；导出请求按来源选择同一套视口标识，避免 CAD 拆件已经移动、旋转或缩放后仍错误导出原始姿态。STEP 是参数化源数据交换格式，当前继续导出 OpenCascade 原始坐标，不烘焙仅用于场景布置的对象变换。标准几何 3MF 当前不包含 Bambu Studio 专有打印机、耗材、支撑和切片工程元数据。

## 上传 STL 网格元素位移协议

```text
Three.js 点击命中或当前摄像机屏幕投影框选
  → worldToLocal 消除对象显示变换并恢复 STL 源毫米坐标
  → 顶点 / 无向边 / 面去重，按网格遍历顺序限制为 512 个
  → 每个元素绑定 imported-model revision、triangleIndex 与 triangleMm
  → Vite、Tauri/Rust、Python 三层独立请求校验
  → Rust 通过 stdin 向 Python 传递选择集合
  → Python 逐三角面复核并同步移动全部同坐标 STL 顶点副本
  → 退化面检查
  → OpenCascade 封闭性、有效性、Solid 数量和体积检查
  → 临时文件 + 批量原子替换 + 失败回滚
  → 新 revision 刷新视口、使旧选择失效并保存上传快照
```

- 前端协议位于 `src/model/meshElementEdit.ts`，只接受 `uploaded-model`、`vertex / edge / face`、`click / box`、1–512 个同类元素、有限毫米位移和当前三角面上下文。三角边索引固定为 `0: 0-1`、`1: 1-2`、`2: 2-0`，面的元素索引固定为 0。
- Three.js 中源 STL/OpenCascade 坐标 `(x, y, z)` 显示为 `(x, z, -y)`；选择时通过逆矩阵恢复源坐标。外层 `TransformableObject` 的用户位移、旋转和均匀缩放先由 `event.object.worldToLocal` 消除，不能进入局部网格坐标。
- `collectMeshElementBoxSelection` 使用生成器遍历当前上传模型三角面：顶点按顶点投影、边按三维中点投影、面按三维重心投影，且投影深度必须位于 `[-1, 1]`。顶点按六位小数源毫米坐标、边按排序后的无向源端点、面按当前修订 `triangleIndex` 去重；第 513 个不同候选只设置截断状态，不改变已按网格遍历顺序保留的前 512 个。
- 框选第一版不执行射线遮挡过滤，因此是屏幕投影穿透框选，可能包含被遮挡区域中的元素。与稳定 CAD 面框选“只选择第一命中可见面”的语义不同，界面和产品规格必须保持这一区别。
- `MeshElementSelection` 保存选择方式和元素数组，每个元素都包含 `triangleIndex + elementIndex + triangleMm`，外层统一保存 `kind + selectionRevision`。点击单选同样转为长度为 1 的集合，使后端只维护一套批量协议。
- Rust 对集合长度、同类元素、索引、有限坐标、坐标绝对值上限、选择方式和未知字段进行严格反序列化校验，并把 JSON 选择集合写入 Python 子进程标准输入；Vite 开发路由执行等价校验并调用同一 Worker，避免 Web 验收绕过生产协议。
- Worker `modeling/edit_mesh_element.py` 使用 `triangleMm` 与当前工作 STL 对应三角面逐点复核，再以六位小数坐标键收集整个选择集合涉及的唯一源坐标，并同步更新所有 STL 顶点副本。这样可维持分面 STL 的共享几何顶点一致性，但不等同于通用拓扑编辑器或未受约束自由雕刻。
- 修改结果不得包含 NaN、Infinity 或退化三角面。重新导入后的 Shape 必须有效、封闭，修改前后 Solid 数量一致；如果导入流程报告进行了自动修洞或网格清理，Worker 拒绝提交，避免自动修复掩盖编辑产生的破坏。
- `imported-model-working.stl`、`imported-model-working.step`、`imported-model-result.json` 和 `mesh-element-edit-result.json` 使用既有受管 artifacts 目录、临时输出、批量原子替换和回滚机制。Web 开发路由与 Tauri 命令调用同一 Python Worker。
- 视口按元素类型生成合并 `Points`、`LineSegments` 或面 `BufferGeometry`，而不是为每个元素创建独立 React/Three 对象；黄色点、粗线和半透明面高亮集合都绑定当前模型修订。
- 成功后 Zustand 更新上传模型修订，清除制造拆件、壁厚热力图、框选请求和过期选择，并创建绑定对应修订号的中文版本与前后上传模型快照。`restoreVersion`、撤销和重做通过受管恢复命令恢复真实工作 STL、STEP 与清单，只有 Worker 成功后才移动历史索引。

## 上传模型精确快照恢复协议

```text
创建上传模型版本
  → 固定复制原始 STL、工作 STL、工作 STEP、模型清单
  → version.json 写入 uploaded-stl 来源与不可变修订号
  → 撤销、重做或历史恢复请求
  → Rust 校验受管版本直接子目录、来源、修订号和固定文件完整性
  → Python/OpenCascade 双重检查 STL 与 STEP
  → 有效性、封闭性、Solid 数量、体积和清单声明一致
  → 临时文件 + 批量原子替换 + 失败回滚
  → Zustand 成功后移动历史索引并清除过期分析
```

- `VersionSnapshot` 使用 `modelSource` 区分 `cad` 与 `uploaded-stl`，上传来源必须同时保存 `modelRevision`。参数化 CAD 快照默认行为保持不变。
- 首次 STL 导入由 `modeling/split_and_cap.py` 固定创建 `imported-model.stl`、`imported-model-working.stl`、`imported-model-working.step` 和 `imported-model-result.json`，使后续网格编辑与历史恢复使用统一工作集。
- Rust 只接受 `artifacts/versions` 的直接子目录，验证 `version.json`、上传模型清单和调用方预期修订号完全一致，并拒绝 CAD 来源、缺失工作文件、任意外部路径、路径穿越及符号链接逃逸。
- `modeling/restore_uploaded_model_snapshot.py` 使用 OpenCascade 重新载入工作 STL 和 STEP，分别检查 Shape 有效性、封闭性和 Solid 数量，再比较 STL/STEP 体积及清单声明。所有校验都在工作文件替换前完成。
- 文件提交使用同目录临时文件、批量原子替换和失败回滚；任一步失败都保留最后有效模型。桌面恢复命令持有模型生成锁，避免与导入、编辑或重建并发覆盖。
- Store 的上传模型恢复是异步事务：Worker 成功后才修改 `versionIndex`，并重载上传模型清单、切回上传 STL 视图，清除拆件、壁厚、网格选择、局部修改和版本几何对比。异步序号阻止旧恢复响应覆盖较新的恢复。
- Web 模式明确拒绝本机精确恢复。上传 STL 快照不参与参数化 CAD STEP 精确布尔差异；跨项目快照导入、任意外部快照目录和云端同步不在当前协议范围内。
