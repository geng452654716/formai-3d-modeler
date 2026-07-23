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

能力边界必须明确：稳定面 ID、稳定边 ID 和几何签名回退都是“几何签名匹配第一版”，不是 OpenCascade 原生永久拓扑命名；大幅拓扑变化、对称面或布尔重建可能重新编号。`triangleIndex`、曲面 UV 和 U 切向只对当前修订有效，局部修改、重新三角化、第三方修复或普通导出都可能改变顺序或方向。上传 STL 使用独立的网格区域和壁厚采样协议，不套用参数化 CAD 的稳定面映射。当前已支持任意稳定面所属单条稳定边的固定半径圆角和等距倒角、两端唯一且切向夹角不超过 5 度的切线连续边链传播第一版，以及种子边所属唯一平面边界 Wire 的整圈传播第一版；非平面所属边必须绑定当前修订的真实 UV，并重新复核真实曲面点、外法线和目标边距离，且不允许整圈。当前尚未提供曲面整面偏移、分叉切线链、多个 Wire、可变半径、连续性等级控制、沿任意自由曲面贴合的轮廓、框选多面布尔或任意拓扑顶点/边/面编辑；曲面矩形和槽孔均按真实 UV 点击位置切平面的安全近似实现。精确工具体预演只展示正式布尔的作用体，不等于最终布尔结果。

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
- 切线自动传播本身不支持分叉链、可变半径、连续性等级控制或指定切线角阈值；需要显式指定边集合时，使用下一节的手工多选边链协议。

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

## 上传 STL 网格选择集合旋转与均匀缩放协议

第 42 阶段把原有“上传 STL 网格元素位移协议”扩展为受限变换联合类型：

```text
当前修订的同类网格选择集合
  → 按六位小数源毫米坐标键生成唯一坐标集合
  → 计算唯一坐标的算术平均值作为几何中心枢轴
  → 位移 / X-Y-Z 单轴旋转 / 围绕同一枢轴均匀缩放
  → 同步更新全部同源坐标的 STL 顶点副本
  → 退化面 + OpenCascade 封闭性/有效性/Solid 数量/体积复核
  → 临时文件 + 批量原子替换 + 失败回滚
  → 刷新上传模型修订、清除旧选择并保存桌面精确快照
```

- `src/model/meshElementEdit.ts` 使用 `move | rotate | scale` 可辨识联合类型。旋转必须提供 `axis=x|y|z` 和有限角度，角度范围为 `[-180, 180]` 且不能为 0；缩放必须提供 `0.25～4` 的有限比例且不能等于 1。
- Vite 开发后端、Tauri/Rust 和 Python Worker 分别执行同样的独立白名单校验。Rust 使用 `MeshElementTransformParameters` 统一规范化三类参数，缺少旋转轴不会默认成 Z 轴，未知操作不会进入 Worker。
- Python 使用源模型右手坐标执行标准单轴旋转矩阵。枢轴只由选择集合涉及的唯一源坐标决定，不按三角面中的重复顶点副本加权，因此共享顶点数量不会改变旋转和缩放中心。
- 单顶点位移仍可生效；单顶点绕自身旋转或缩放没有实际几何变化，Worker 必须中文拒绝。所有数值在写回前检查有限性，结果坐标必须真实变化且不能产生退化三角面。
- 版本与恢复继续使用第 40 阶段的上传模型受管快照。浏览器开发模式的 `createVersionSnapshot` 按既定边界返回空，不允许把内存状态伪装为真实文件恢复；桌面端才通过 Tauri 创建和恢复本机精确快照。
- 当前不支持非均匀缩放、任意轴旋转、单独枢轴编辑、拓扑增删、挤出、焊接、分裂或自由雕刻。

2026-07-21 第 42 阶段验证结果：前端 173/173、Rust 45/45、Python 网格元素变换 9/9、上传快照恢复 3/3、拆件与补面 27/27；生产构建、Cargo 检查、Python 语法、Rust 格式和差异检查通过。浏览器实际完成 8 顶点 Z 轴 10° 旋转与 0.9 倍均匀缩放，并确认修订失效、中文结果和当前页面控制台无新增错误。

## 参数化 CAD 零件转受管网格分支协议

第 43 阶段在参数化 B-Rep 与受管 STL 网格之间建立显式、不可混淆的分支边界：

```text
当前 CAD 修订 + 用户主动选择的任意零件 ID
  → 前端确认参数化能力边界
  → Tauri/Vite 读取当前 generation-result.json
  → 复核修订、零件、普通 STL 文件名、文件大小和存在性
  → 复用 STL 实体检查生成原始 STL、工作 STL、工作 STEP 和模型清单
  → branchSource 写入源 CAD 修订、零件 ID、中文名称和源 STL 文件
  → Zustand 切换到 uploaded-stl 视图并清除旧分析/选择
  → 创建 CAD 派生网格中文版本和桌面精确快照
  → 复用网格元素点击/框选、位移、单轴旋转和均匀缩放
```

- `create_cad_mesh_branch` 持有与 CAD 生成、上传导入和网格编辑相同的工作进程锁。`resolve_cad_mesh_branch_source()` 只从当前清单的 `parts[]` 查找用户选中的 ID，并通过普通文件名校验阻止路径穿越；实现不依赖任何固定零件角色。
- `inspect_stl_as_imported_model()` 是普通 STL 上传与 CAD 网格分支共用的实体导入入口。普通上传传入空来源；CAD 派生分支在实体检查成功后把 `branchSource.kind=cad-part` 写入模型清单。
- `ImportedStlModel.branchSource` 和 `ModelVersion.meshBranchSource` 用于区分运行时模型来源与不可变版本来源。来源元数据不是把网格升级为 B-Rep 的证明，只用于历史追踪、中文说明和恢复校验。
- `modeling/edit_mesh_element.py` 与 `modeling/local_stl_edit.py` 在重建 `updatedModel` 时复制已有 `branchSource`；`restore_uploaded_model_snapshot.py` 恢复完整清单，因此位移、旋转、缩放、局部圆柱布尔和快照恢复都不会把 CAD 派生网格误降级为普通上传模型。
- Store 只在当前 `cadStatus=ready`、CAD 修订和目标零件仍存在时发起创建。成功后清除拆件、壁厚、局部 CAD 选择、网格选择和旧结果；桌面精确快照创建失败不会回滚已经通过实体检查的网格分支，但会保留清晰中文边界并禁止伪造恢复成功。
- Web 开发 API 使用相同的修订和文件名校验，但没有 Tauri 受管版本目录，因此可以验证真实工作网格创建与编辑，不能作为桌面精确快照恢复的替代证据。
- 第一版一次只转换一个 CAD 零件；不执行多个零件合并、不生成参数化特征树、不把编辑后 STEP 称为原生精确 B-Rep，也不实现拓扑增删、焊接、分裂、面挤出或自由雕刻。

2026-07-22 第 43 阶段验证结果：前端 177/177、Rust 47/47、Python 网格元素编辑 10/10、局部 STL 编辑 5/5、上传快照恢复 4/4、拆件与补面 27/27；生产构建、Cargo 检查与测试、Python 语法、Rust 格式和差异检查通过。浏览器完成真实 CAD 零件转网格分支并确认全中文状态、真实毫米尺寸、来源语义和无控制台错误。

## 受管网格单三角面法向布尔协议

第 44 阶段把网格元素协议扩展为受限 `extrude-face` 操作：

```text
当前上传模型修订 + 点击选择的单个 triangleIndex/triangleMm
  → TypeScript 可辨识联合类型和 Store 前置拒绝
  → Vite/Tauri 独立校验面类型、点击方式、单元素、模式和距离
  → Python 复核当前 STL 中的三角面源坐标
  → OpenCascade 实体内外分类确认真实外法线
  → 构造带极小重叠量的封闭三角柱工具体
  → add 执行并集 / cut 执行切除
  → 有效性、封闭性、单 Solid 和体积方向检查
  → 临时 STEP/STL 导出并重新导入验证网格拓扑
  → 原子替换工作文件、更新修订并保留 branchSource
  → Store 清除过期选择、分析与拆件，创建中文版本和桌面精确快照
```

- `src/model/meshElementEdit.ts` 新增 `operation=extrude-face`、`faceExtrusionMode=add|cut` 和 `distanceMm`；它与位移、旋转、缩放保持可辨识联合类型，避免把缺少法向参数的请求默认成其他操作。
- `src/components/MeshElementEditPanel.tsx` 固定第一版为面元素和点击单选。Store 在调用后端前拒绝框选、多面、非面和过期修订；成功后使用真实外法线、工具体积和体积差生成中文摘要。
- `src-tauri/src/backend.rs` 与 `vite.config.ts` 分别执行等价白名单校验。Rust 将选择集合通过标准输入交给 Worker；Vite 开发后端调用相同 Python 实现，因此浏览器验收不会绕过生产建模算法。
- `modeling/edit_mesh_element.py` 不信任 STL 法线，而是从 `triangleMm` 计算候选法线并用 `BRepClass3d_SolidClassifier` 对两侧采样点分类。三角柱在实体内外增加受限微小重叠量，确保布尔工具与目标 Solid 真实相交。
- 布尔结果先检查 OpenCascade Shape，再导出临时 STEP/STL，并调用通用 STL 实体导入链重新检查非流形边、封闭性、Solid 数量、体积和包围盒。STL 再导入失败会被包装成“法向编辑导出结果未通过网格检查”，临时文件在 `finally` 中清理，既有工作文件不变。
- `imported-model-working.stl`、`imported-model-working.step`、`imported-model-result.json` 和 `mesh-element-edit-result.json` 使用既有批量原子替换和回滚机制。`branchSource` 被复制到新清单，使普通上传 STL 和 CAD 派生网格共享算法但保留来源语义。
- Vite 中不需要读取 Worker JSON 的任务使用 `stdio=['ignore','ignore','pipe']`，只消费标准错误；需要解析 JSON 的曲面点击 Worker 仍显式读取标准输出。该区分防止大型清单填满未消费管道导致全局 `generating` 锁长期占用。
- 第一版故意不做面区域扩展或拓扑焊接。选中三角面落在锐边或开孔边界时，布尔结果可能在 STL 三角化后形成四面共边；系统安全拒绝，不关闭非流形检查。

## 连续共面区域法向布尔协议

第 45 阶段保留兼容字段 `operation=extrude-face` 与 `faceExtrusionMode=add|cut`，但把工具体来源从单个三角面扩展为一个种子三角面所在的连续共面区域：

```text
当前上传模型修订 + 点击选择的一个种子 triangleIndex/triangleMm
  → 当前 STL 三角面源坐标复核
  → 共享无向边索引与非流形边拒绝
  → 以种子面为基准执行连续共面 BFS
  → 0.5° 法线夹角 + 动态平面距离公差
  → 20,000 面 / 200,000 平方毫米资源上限
  → 提取全部边界闭环并投影到种子平面
  → 构造一个带孔平面 Face 和一个封闭棱柱工具体
  → OpenCascade 并集或切除
  → 有效性、封闭性、单 Solid、体积方向和 STL 再导入检查
  → 原子替换工作文件、更新修订、保留 branchSource 与精确快照
```

- `_edge_key` 以六位小数源毫米坐标排序形成无向边键；每条边最多允许两个相邻三角面。三个及以上三角面共享同一边时属于非流形输入，扩展在布尔前终止。
- `_expand_coplanar_region` 从种子面开始按共享边 BFS。候选面法线与种子面法线夹角不超过 0.5°，且三个顶点到种子平面的绝对距离均不超过动态公差 `max(0.00001, min(0.02, 模型对角线 × 0.000001))` 毫米。这样不会跨锐边，也不会把曲面三角带误当成一个平面。
- 每次加入候选面前累计三角面数量和真实三维面积；最多 20,000 面和 200,000 平方毫米。种子面在 BFS 前单独执行同一上限检查，避免单个巨大三角面绕过面积门。
- `_boundary_loops` 统计区域中只出现一次的无向边并沿有向边形成闭环；闭环投影到由真实外法线建立的二维基底。最大绝对投影面积环作为外环，其余环作为孔洞，传给 `cq.Face.makeFromWires` 形成单一带孔 Face。
- `_planar_region_prism` 只从这个 Face 生成一个棱柱，并沿实体内外分类确认的真实法线加入极小重叠量。一次布尔避免多个共面三角柱在内部边上产生重叠或四面共边；孔洞 Wire 会在工具体中保持为空。
- 结果清单新增 `affectedTriangleCount`、`regionAreaMm2`、`boundaryLoopCount`、`normalToleranceDegrees` 和 `planeToleranceMm`。Store 用这些字段生成全中文结果，同时保留 `toolVolumeMm3`、修改前后体积、当前修订失效处理、拆件/壁厚分析清理和版本快照。
- 工作 STL、STEP、上传模型清单和编辑结果依旧先写临时文件并批量替换；任何边界、布尔、实体或 STL 再导入失败都会回滚，不能覆盖最后有效模型。普通上传 STL 与 CAD 派生网格继续共用协议并保留 `branchSource`。

2026-07-22 第 45 阶段验证结果：前端 179/179、Rust 49/49、Python 网格元素编辑 15/15、局部 STL 编辑 5/5、上传快照恢复 4/4、拆件与补面 27/27；生产构建、Cargo 检查与测试、Python 语法、Rust 格式和差异检查通过。带孔用例自动扩展 130 个三角面、识别 2 个边界环、区域面积约 307.44 平方毫米并保持贯穿孔。浏览器加料与压入都从 720.00 平方毫米的 2 三角面顶面区域生成单一工具体，体积分别变化 +1440.00 和 -1440.00 立方毫米。

## 连续共面区域前端预览协议

第 46 阶段在 `meshElementEdit.ts` 增加纯函数区域扩展器。视口从当前 Three.js 几何按 `faceIndex` 顺序恢复全部源毫米三角面，使用六位小数坐标键建立共享无向边邻接，再以种子面执行 BFS、面积累计和边界环遍历。Store 保存绑定上传模型修订的预览及中文错误；完整区域仅用于黄色高亮和面板测量。任何状态切换都会清除预览，后端 `edit_mesh_element.py` 仍独立读取工作 STL、重新扩展并执行 OpenCascade 布尔与原子回滚，因此前端结果不是安全边界。


## 连续共面区域边界线框与拓扑缓存协议

第 47 阶段新增 `MeshPlanarRegionTopology`，保存当前视口几何恢复出的 `triangleByIndex`、共享无向边 `edgeOwners` 与 `pointByKey`。该对象包含 `Map`，只属于 `LoadedCadMesh` 当前修订的 `useRef` 缓存，不进入 Zustand Store，也不参与持久化、版本快照或 Worker 请求。Store 只保存可序列化的 `MeshPlanarRegionPreview`。

`MeshPlanarRegionPreview.boundaryLoopsMm` 保存源毫米坐标下的闭合边界环点序列；渲染层创建独立 `BufferGeometry` 时才应用 `coordinateTransform`，从而兼容装配、拆分和 CAD 派生网格视图。线框使用不写深度的青绿色 `LineSegments` 叠加，生命周期与当前预览绑定，并在依赖变化或组件清理时显式 `dispose()`。

缓存键由模型修订、Three.js `BufferGeometry` 实例、逆坐标变换和视图来源共同约束。修订、导入、恢复、几何或视图变化时立即失效；切换操作模式只清除预览，不强制重建仍然有效的当前修订拓扑。`expandMeshPlanarRegion()` 同时接受三角面迭代器和已构建 topology，确保纯函数测试与视口缓存使用同一套区域扩展、面积上限和边界拒绝逻辑。

前端 topology 与边界线框仅用于交互反馈。桌面 Worker 不读取或信任缓存，仍从当前工作 STL 独立建立邻接、复核非流形和边界闭合性，并由 OpenCascade 判断平面 Face、外环/孔洞 Wire、布尔结果有效性、封闭性和单 Solid 约束。

## 连续共面区域环语义与测量协议

第 48 阶段在前端预览协议中新增可序列化的 `MeshPlanarRegionBoundaryLoop`：

```text
kind: outer | hole
pointsMm: 源毫米闭合环点序列
perimeterMm: 三维真实闭合周长
boundsMm: 种子平面二维包围宽度与高度
nestingDepth: 二维包含深度
```

测量器从种子三角面法线建立稳定二维基底，把全部边界环投影到同一平面，并通过二维射线法判断一个环顶点是否位于其他环内部。包含深度为 0 的环分类为外环，深度为 1 的环分类为孔洞；该协议不依赖 STL 绕序、边界数组顺序或有符号面积方向。深度大于 1 表示第一版不支持的嵌套岛，预览在进入 Worker 前以中文拒绝。

`MeshPlanarRegionPreview` 新增 `outerBoundaryLoopCount`、`holeBoundaryLoopCount` 和 `boundaryLoops`，继续保留 `boundaryLoopCount` 与 `boundaryLoopsMm` 兼容字段。周长使用源毫米三维点逐段求和；包围尺寸使用共同二维基底计算，避免种子三角面的任意边方向改变测量结果。

渲染层从同一个 `boundaryLoops` 分别生成外环和孔洞 `BufferGeometry`。外环使用青绿色 `#52e0c4`，孔洞使用珊瑚色 `#ff8f70`，两者都关闭深度读写并使用独立 `renderOrder`；预览或组件生命周期变化时分别释放 GPU 几何。Store 只保存可序列化预览，不保存 Three.js 对象。

上述语义和尺寸仍不是安全边界，也不进入网格编辑请求。桌面 Worker 从当前工作 STL 独立重建邻接、边界环和 OpenCascade Wire，继续执行非流形、资源上限、有效性、封闭性、单 Solid 与原子回滚检查。

## 连续共面区域环聚焦与视口标注协议

第 49 阶段在 Zustand Store 新增 `meshPlanarRegionFocusedLoopIndex` 和受限 setter。Setter 只接受当前 `meshPlanarRegionPreview.boundaryLoops` 中存在的整数索引；设置新预览时始终重置聚焦，所有会使预览失效的模型、选择、视图和操作状态转换也同步写入 `null`，防止旧索引引用新修订的环。

`LoadedCadMesh` 仅在以下条件全部成立时创建聚焦表示：当前操作为共面区域、上传模型存在、预览修订等于当前模型修订、聚焦索引有效且环至少包含三个点。环点在渲染层应用当前 `coordinateTransform`，闭合后交给 Drei `Line` 以加粗线宽显示；原外环和孔洞 `LineSegments` 暂时降低透明度。标注锚点使用转换后环点中心，并通过 `Html` 显示全中文周长、宽度和高度。

聚焦状态、Drei 线条和 HTML 标注都不持久化、不进入版本快照，也不发送给 `edit_mesh_element.py`。Worker 的区域扩展、Wire 判断、OpenCascade 布尔、安全校验和原子回滚协议保持不变。

### 50. 共面边界环拾取与顺序导航架构（已实现）

- `cycleMeshPlanarRegionLoopIndex` 是无 UI 依赖的纯函数，统一处理空列表、未聚焦、过期索引、正向/反向导航和首尾循环；组件不各自复制索引回绕规则。
- `LoadedCadMesh` 仅在上传模型、共面区域操作、当前导入修订和有效预览同时成立时构造 `meshPlanarRegionLoopRenderData`。每项包含稳定 `loopIndex`、语义、中文名称、颜色、闭合视口点列和标注中心。
- 可见外环/孔洞仍分别合并为两个 `BufferGeometry + lineSegments`，并通过 `useEffect` 清理；直接拾取另用 Drei `Line` 的透明宽线层，避免为聚合几何编写自定义逐线段命中算法。
- 拾取层使用极低透明度而不是 `visible=false`，以保留射线检测；环命中调用 `stopPropagation()` 后写入 Store，因此模型面不会同时收到该次点击。非环区域没有拾取对象拦截，继续进入既有 `SelectableMesh` 选面流程。
- 面板列表、顺序导航、视口强化线和 HTML 标注都读取 `meshPlanarRegionFocusedLoopIndex`；该索引仍由 Store 校验当前预览范围并在预览或修订变化时清除，不进入 Worker 请求和持久化层。

2026-07-22 架构验证：新增纯函数测试后前端共 190/190 通过，生产构建通过；浏览器验证两种环的直接射线拾取、事件拦截和非线框选面路径均正常，控制台无错误。

**下一阶段架构方向：**从聚焦环的种子平面二维基底和 `boundsMm` 派生宽高尺寸线几何，统一生成端点、延伸线与标签锚点；根据投影方向和轮廓外偏移选择标签位置，并继续只在渲染层消费预览数据。

### 51. 连续共面区域尺寸辅助线与标注避让第一版（已实现）

- `MeshPlanarRegionBoundaryLoop.measurementFrame` 保存区域种子平面的源毫米原点、稳定 U/V 单位轴和二维最小/最大范围。该结构由 `measureMeshPlanarBoundaryLoops` 与语义分类一次生成，使尺寸显示不依赖环顶点顺序、种子边方向或 Three.js 相机。
- `createMeshPlanarRegionDimensionGuides` 是无 Three.js 依赖的纯函数：校验正有限宽高，计算 1.5 至 6 毫米自适应偏移，并输出宽高主线、延伸线、端点短线、轴标签及摘要标签的源毫米坐标。长方形和 2 × 2 毫米孔洞测试覆盖长度、轮廓外方向、最小偏移和有限坐标。
- `LoadedCadMesh` 在统一的 `meshPlanarRegionLoopRenderData` 中把辅助线源毫米点应用当前 `coordinateTransform`，只为当前上传模型修订、共面区域模式和有效预览创建渲染数据。可见尺寸线使用 `depthTest=false`、`depthWrite=false` 和独立渲染顺序；透明宽边界拾取层继续位于交互层。
- Drei `Html` 分别承载宽度、高度和摘要标签。宽度位于 `minV` 外侧，高度位于 `maxU` 外侧，摘要位于 `maxV` 外侧；摘要不再重复宽高。外环与孔洞沿用青绿/珊瑚语义色，CSS 禁止标签接收指针事件。
- 测量基底与辅助线都属于前端瞬时预览：不写入 Zustand 持久状态，不传给 Tauri/Python Worker，不改变区域扩展、OpenCascade Wire 分类、布尔方向、项目版本或快照格式。

2026-07-22 验证：前端 25 个测试文件 190/190，TypeScript/Vite 构建和 `git diff --check` 通过；浏览器验证外环与孔洞的尺寸线/中文标签切换、线框取消聚焦、非线框重新选面和无 Console 错误。

**下一阶段架构边界：**在前端相机与 DOM 安全区层增加纯显示的投影侧边选择，不修改源毫米测量结果。候选位置应由同一测量基底生成，再按屏幕投影选择不会接近顶部工具栏、右侧编辑面板和视口边缘的方向；不引入 Worker 契约、版本迁移或尺寸驱动约束求解。


### 52. 连续共面区域尺寸标注视口自适应翻转架构（已实现）

- `MESH_PLANAR_REGION_DIMENSION_LAYOUTS` 固定定义四组源平面候选；`createMeshPlanarRegionDimensionGuides(loop, layout)` 只改变宽度、高度和摘要所在外侧以及对应延伸线起点，不改变 `measurementFrame`、真实毫米值或边界环语义。
- `selectMeshPlanarRegionDimensionLayout` 是无 Three.js 依赖的纯函数。它对每个候选的三个标签锚点计算安全区溢出平方惩罚和矩形重叠面积惩罚，并在分数相同时保留输入顺序；空候选返回 `null`。
- `LoadedCadMesh` 一次创建四组已应用 `coordinateTransform` 的渲染候选。`useFrame` 使用当前父级 `matrixWorld` 和相机投影锚点，画布安全内边距为左 24、上 58、右 326、下 26 像素；只有布局索引真正变化时才写入组件本地状态，避免每帧触发 React 重渲染。
- `createMeshPlanarDimensionHtmlPosition` 作为 Drei `Html.calculatePosition` 的最终屏幕安全门，按标签估算尺寸夹紧坐标；它与候选评分共同处理三维翻转无法完全避开固定 DOM 面板的情况。
- 布局索引、投影锚点和屏幕夹紧均为渲染层瞬时状态，不进入 Zustand 持久状态、Tauri/Python Worker、项目版本、精确快照或 OpenCascade Wire/布尔语义。

2026-07-22 架构验证：纯函数新增布局翻转、延伸线方向、安全区溢出、标签重叠和空候选测试，前端共 192/192 通过；生产构建和差异检查通过。浏览器验证多相机角度下候选索引自动切换、屏幕坐标保持在安全区、带孔区域数据不变且 Console 无错误。

**下一阶段架构方向：**从当前修订的共面区域拓扑、外环/孔洞二维投影、法向操作和毫米距离生成只读半透明棱柱预演几何；前端预演必须独立于 Worker 的真实工具体构造，参数无效或上下文失效时立即清除，并继续由后端承担实体方向、封闭性、有效性、单 Solid 和体积校验。

### 53. 连续共面区域法向工具体视口预演架构（已实现）

- `MeshPlanarRegionPreview.outwardNormalMm` 保存前端瞬时方向。`meshOutwardNormal` 汇总当前拓扑全部三角面的六倍有符号体积；负体积翻转种子法线，开口或近零体积保持种子法线回退。该字段只服务渲染，不能替代 Worker 的 OpenCascade 实体分类。
- `createMeshPlanarRegionExtrusionPreviewProfile` 是无 Three.js 依赖的纯函数：校验 0.20 至 100.00 毫米范围，按语义寻找唯一外环和全部孔洞，将所有点投影到外环共同测量基底，并输出方向法线、起止点及标签点。交换环数组顺序不会改变轮廓语义。
- `meshFaceExtrusionMode` 与 `meshFaceExtrusionDistanceText` 位于 Zustand 瞬时 UI 状态，供面板和 `LoadedCadMesh` 同步消费；它们不进入模型版本、精确快照或后端契约，新建画布时恢复“向外加料 / 2 毫米”。
- `LoadedCadMesh` 用 `Shape + Path + ExtrudeGeometry` 构造带孔棱柱，再以源毫米 U/V/法向基底和既有 `coordinateTransform` 映射到显示坐标。几何随依赖变化主动 `dispose()`；材质半透明且关闭深度写入，工具体和方向线禁用 raycast，标签关闭指针事件。
- 预演存在条件同时绑定上传模型、共面区域操作、当前导入修订、有效区域和有效距离。任何依赖变化均通过 `useMemo` 重建或返回 `null`，不新增 Worker 消息、持久化迁移和版本恢复负担。

2026-07-22 架构验证：带孔轮廓、环顺序无关、加料/压入反向、无效距离和闭合网格绕序修正测试通过；前端共 193/193，生产构建与差异检查通过。浏览器验证实时状态同步、预演清除、孔洞聚焦共存和零 Console 错误。

### 54. 连续共面区域工具体轮廓与标签安全区架构（已实现）

- `createMeshPlanarRegionExtrusionPreviewGuides(profile)` 是无 Three.js 依赖的纯函数。它验证正有限距离、外环与孔洞的点数和非零面积、全部二维点与三维基底的有限性，以及 U/V 轴和方向法线的非零长度；无效输入返回 `null`。
- 外环和孔洞分别生成首尾闭合的 `startLoopMm` 与 `endLoopMm`。末端点统一由起始平面点沿 `directionNormalMm * distanceMm` 派生，保证显示几何和 profile 的真实毫米作用距离一致。
- 方向末端十字由 `axisU`、`axisV` 构造，半径按外环较短包围边的 8% 计算并夹紧至 0.35 至 2.00 毫米。该标记只是只读方向语义，不是变换控件或参数拖动手柄。
- `LoadedCadMesh` 将所有源毫米线组通过既有坐标变换映射到视口；末端外环与孔洞使用更高线宽/亮度区分。新增 `Line` 统一禁用 `raycast`、深度测试和深度写入，HTML 标签复用 `createMeshPlanarDimensionHtmlPosition(118, 24)` 完成最终屏幕安全区夹紧。
- 指南线、端点和标签全部属于渲染层瞬时数据，不进入 Zustand 持久模型状态、Tauri/Python Worker、OpenCascade 布尔、项目版本、精确快照或恢复协议。

2026-07-22 架构验证：带孔环的起止闭合点数、对应点法向距离、有限坐标和非零端点标记测试通过；少点环、非有限孔洞和零长度轴均被拒绝。前端共 193/193，生产构建和差异检查通过；浏览器验证向外 2.00 毫米、向内 6.00 毫米、多角度标签安全区和零 Console 错误。仅保留既有 Vite 大分块警告。

### 55. 连续共面区域工具体侧边连接与遮挡层级架构（已实现）

- `MeshPlanarRegionExtrusionPreviewLoopGuide.sideSegmentsMm` 保存每个唯一二维环顶点对应的源毫米起止端线段；创建时复用已验证的闭合起止环，但不包含重复的闭合末点。
- 每条连接线的起点等于同索引 `startLoopMm`，终点等于同索引 `endLoopMm`，长度等于 `distanceMm`。外环、单孔及多孔 profile 使用同一通用映射，不依赖 Demo 文件名或固定孔洞数量。
- `LoadedCadMesh` 将全部连接线应用既有 `coordinateTransform` 后，按 `outer` 与 `hole` 分别合并为两份 `BufferGeometry`；渲染使用不可拾取的 `lineSegments`，统一关闭深度测试和深度写入，外环透明度 0.78、孔洞透明度 0.44。
- 连接线几何和棱柱几何共享 profile 生命周期，在 React effect 清理时主动 `dispose()`；不新增 Zustand 持久字段、Worker 消息、OpenCascade 近似 CSG、项目版本或快照数据。

2026-07-22 架构验证：测试覆盖外环 4 条、孔洞 4 条及第二个三角孔 3 条连接线，验证对应端点、作用距离与全部有限坐标；针对性测试 20/20、前端 193/193，生产构建和差异检查通过。浏览器验证加料 2.00 毫米、压入 6.00 毫米、多角度层级与零 Console 错误。仅保留既有 Vite 大分块警告。

### 56. 连续共面区域工具体度量架构（已实现）

- `createMeshPlanarRegionExtrusionPreviewMetrics(profile)` 是无 Three.js 依赖的纯函数。私有环面积函数使用鞋带公式并取有符号面积绝对值，因此外环和孔洞绕序反转不改变数值。
- 度量结果包含 `outerAreaMm2`、`holeAreaMm2`、`netAreaMm2` 和 `estimatedVolumeMm3`；孔洞按任意数量累加，净面积必须大于零，体积固定为净面积乘正有限 `distanceMm`。
- 任一环少于三个点、含非有限坐标、面积退化，或孔洞总面积不小于外环时返回 `null`。指南线生成复用同一环面积校验，避免渲染层和度量层接受范围不一致。
- `MeshElementEditPanel` 从当前导入修订、区域、方向和距离即时重建 profile 与 metrics；`LoadedCadMesh` 在创建 Three.js 工具体前同时要求 guides 与 metrics 有效，并把同一个 metrics 对象交给视口中文标签。
- 扩展后的标签使用 `createMeshPlanarDimensionHtmlPosition(176, 52)` 预留安全区，并保持 `pointer-events: none`。所有度量均为 React 派生数据，不进入 Zustand 持久状态、Tauri/Python Worker、项目版本、精确快照或恢复协议。

2026-07-22 架构验证：自动测试覆盖 100 平方毫米外环、4 平方毫米单孔、额外 0.5 平方毫米三角孔、双向绕序和退化输入；针对性测试 20/20、前端 193/193，生产构建和差异检查通过。浏览器验证面板/视口同步、2.00 与 6.00 毫米实时重算、0.10 毫米清除、安全区和零 Console 错误。仅保留既有 Vite 大分块警告。

### 57. 连续共面区域执行结果体积对照架构（已实现）

- `createMeshPlanarRegionExtrusionResultComparison(result, currentRevision)` 是纯派生边界：只接受当前修订的 `extrude-face` 成功结果、合法 `faceExtrusionMode`、正有限 `toolVolumeMm3` 和有限 `validation.volumeDeltaMm3`。
- 模型体积变化统一使用 `Math.abs(volumeDeltaMm3)`；实际作用比例为体积变化绝对值除以工具体积。最多 0.1 个百分点的浮点越界会夹紧为 100%，更明显的超过工具体积结果返回 `null`。
- `MeshElementEditPanel` 只订阅已有 `meshElementEditResult` 和 `importedStlModel.revision`，通过 `useMemo` 即时生成对照卡；没有新增 Store 字段、Tauri 命令、Python 输出、项目版本数据或快照恢复协议。
- 卡片按加料和压入使用不同边框与说明，但数值格式统一为两位小数；说明限定为几何重叠或裁剪，不把比例扩展成材料、耗材或切片语义。

2026-07-22 架构验证：纯函数覆盖加料 90%、压入 75%、轻微浮点夹紧、明显异常比例、过期修订、其他操作、缺失模式、零值、负值和非有限数；针对性测试 24/24、前端 197/197，生产构建和差异检查通过。浏览器真实 Worker 返回 103.58 立方毫米工具体与 100.00 立方毫米模型变化，派生 96.54%，Console 无错误。

### 58. 连续共面区域平面估算与工具体构造偏差架构（已实现）

- `createMeshPlanarRegionExtrusionToolVolumeComparison(result, currentRevision)` 先复用既有执行结果边界，再校验正有限 `regionAreaMm2` 与 `distanceMm`；平面理论体积固定为面积乘距离，不重新读取预演 Store 或 Three.js 几何。
- 实际工具体积减去平面理论体积得到有符号 `differenceMm3`，再除以理论体积得到 `differencePercent`。方向枚举限定为 `equal | higher | lower`；理论体积百万分之一或 `0.000001` 立方毫米以内归一为零偏差，避免界面出现 `-0.00%`。
- 绝对偏差百分比超过 50% 时返回 `null`。该阈值只用于拒绝明显不可信的解释数据，不会让 `createMeshPlanarRegionExtrusionResultComparison` 的合法工具体积、模型变化和作用比例消失。
- `MeshElementEditPanel` 仅从同一 `meshElementEditResult` 与当前导入修订派生两份比较对象；四个主指标改为两列网格，偏差方向使用独立语义色，说明文案不承诺偏差根因。
- 没有新增 Zustand 持久字段、Tauri 命令、Python Worker 输出、项目版本数据或快照迁移，旧结果和缺字段结果继续安全降级。

2026-07-22 架构验证：测试覆盖零偏差、百万分之一内浮点一致、正负偏差、±50% 边界、超过边界、过期修订，以及缺失、非正和非有限面积/距离；针对性测试 27/27、前端 200/200，生产构建和差异检查通过。真实 Worker 返回平面估算 1310.40、工具体积 1357.38、模型变化 1310.40 立方毫米，派生 +46.98 立方毫米、+3.58% 和 96.54%，Console 无错误。

### 59. 连续共面区域方向一致性与三段状态架构（已实现）

- `createMeshPlanarRegionExtrusionDirectionConsistency(result, currentRevision)` 先复用执行结果对照边界，因此继承当前修订、合法模式、正工具体积、有限体积变化和作用比例上限校验。
- 近零公差为 `max(0.000001, toolVolumeMm3 × 0.000001)` 立方毫米；公差内归一为 `unchanged` 与零变化，之外按符号派生 `increase | decrease`，再与加料期望增加、压入期望减少比较为 `consistent | inconsistent`。
- 返回值保留模式、期望方向、实际方向、有符号体积变化和近零公差，界面不重新实现数值判定。方向矛盾仍可保留合法的绝对体积对照，便于显示具体安全警告。
- `MeshElementEditPanel` 从已有三份纯派生对象组织“平面轮廓 / 工具体 / 布尔作用”三列状态；异常警告使用 `role=alert`，但不触发自动回滚、Worker 重试或版本写入。
- 新样式只增加一致、近零、矛盾三种状态色和红色警告容器，无明显阴影；未修改 Store、Tauri、Python、项目版本或快照协议。

2026-07-22 架构验证：自动测试覆盖加料增量、压入减量、加料减量、压入增量、正负近零变化、过期修订、缺失模式、非有限值和明显异常比例；针对性测试 31/31、前端 204/204，生产构建和差异检查通过。真实 Worker 的 +1310.40 立方毫米加料结果被判定为“加料增量一致”，三段状态布局和 Console 均正常。

### 60. 连续共面区域中文诊断摘要与按需复制架构（已实现）

- `createMeshPlanarRegionExtrusionDiagnosticSummary(result, currentRevision)` 先复用执行结果、工具体偏差和方向一致性三份纯派生边界，再组合原结果的区域面积与距离，统一生成两位小数的十行中文文本。
- 摘要不读取文件路径、账号或环境信息；面积、距离和工具体偏差可独立降级为“暂不可用”，但过期修订、无效执行结果和方向边界失败会整体返回 `null`。
- `copyMeshPlanarRegionExtrusionDiagnosticSummary(summary, writeText)` 通过注入写入函数隔离副作用，空文本和写入异常统一返回 `failed`。`MeshElementEditPanel` 只在点击事件中调用浏览器剪贴板；API 超时或拒绝时，可在同一用户手势中退回临时 textarea 兼容复制。
- 复制反馈保存在组件本地并绑定摘要文本；修订或结果变化后旧反馈不会误用于新摘要。没有新增 Zustand 字段、Tauri 命令、Python Worker 输出、项目版本或快照迁移。
- 新样式仅增加紧凑按钮与成功/失败文字，不使用明显阴影；摘要不会自动发送 Codex、上传网络或保存历史。

2026-07-22 架构验证：针对性测试 36/36、前端 209/209、生产构建和差异检查通过。真实 Worker 的 655.20 平方毫米加料结果生成完整十行摘要；受支持浏览器上下文可读取复制文本，干净新页面的复制反馈和布局正常且 Console 无错误。

**下一阶段架构方向：**建立无自动提交的本地“Codex 指令草稿注入”边界。由纯函数生成诊断分析请求，使用页面内事件或受控回调把文本追加到现有指令输入状态，保留用户原文并按诊断标识去重；不得触发执行函数、网络请求、Worker 或版本写入。

### 61. 连续共面区域诊断请求本地草稿注入架构（已实现）

- `createMeshPlanarRegionCodexAnalysisRequest(summary)` 负责把非空诊断包装为稳定中文请求；`appendMeshPlanarRegionCodexAnalysisDraft(currentDraft, summary)` 负责保留既有文字、追加双换行分隔块并按完整请求去重，返回 `appended / duplicate / invalid` 状态。
- `App` 持有仅在当前页面存活的 `commandDraft` React 状态，并通过受控回调连接 `MeshElementEditPanel` 与 `CommandPanel`。没有引入全局事件、Zustand 字段、Tauri 命令、Python Worker 输出、项目版本或快照迁移。
- `MeshElementEditPanel` 只在用户点击“交给 Codex 分析”时传递当前 `createMeshPlanarRegionExtrusionDiagnosticSummary` 结果；摘要为 `null` 时按钮禁用，反馈与当前摘要绑定，结果变化后旧反馈不继续生效。
- `CommandPanel` 改为受控多行草稿；只有表单提交或 Command/Ctrl + Enter 才调用已有 `executeCommand`，草稿注入回调本身不接触 Codex/API、网络或 Worker。

2026-07-22 架构验证：纯函数新增请求生成、保留原文、重复去重和失效摘要测试，针对性测试 40/40、前端 213/213、生产构建和差异检查通过。真实 Worker 的 655.20 平方毫米加料结果成功追加到已有用户草稿，连续点击保持单个请求块，消息数量未变化；验收页 Console 无错误。

### 62. 诊断草稿块页面级身份与安全移除架构（已实现）

- `App` 新增页面级 `commandDiagnosticBlocks`，只登记本页通过稳定生成函数实际注入的完整请求；它与 `commandDraft` 一样不进入 Zustand、Worker、Tauri、项目版本或快照。草稿清空时同步清除登记。
- `inspectMeshPlanarRegionCodexAnalysisDraft(draft, generatedBlocks)` 只用登记过的完整文本做精确计数，并结合三项固定结构标记返回 `none / complete / edited / ambiguous`。唯一完整匹配才携带可删除目标；重复完整块、完整块加残片、手工编辑或未登记粘贴均进入保护状态。
- `removeMeshPlanarRegionCodexAnalysisDraftBlock` 复用检查结果，只删除唯一完整目标；前后片段分别在删除边界归一化空白，再以一个空行连接。`unsafe / not-found` 返回原草稿，不发生局部猜测。
- `CommandPanel` 状态卡只在本地派生检查结果，移除按钮不接触 `executeCommand`。成功后显示“剩余建模指令尚未执行”；编辑和歧义状态使用禁用按钮及中文说明。
- `.mesh-element-edit-panel ~ .command-panel` 使网格编辑状态下的指令面板左移，修复更高层编辑面板覆盖诊断按钮的真实指针事件问题。

2026-07-22 架构验证：纯函数新增完整移除、前后文字保留、空草稿、手工编辑、残缺、重复块和未登记文本测试；针对性测试 45/45、前端 218/218、生产构建和差异检查通过。真实 Worker 诊断在浏览器中完成唯一识别、物理点击移除、用户文字保留和编辑后安全拒绝，干净验收页 Console 无错误。

### 63. 诊断草稿块字符范围与 textarea 定位架构（已实现）

- `createMeshPlanarRegionCodexDraftBlockLocation` 复用第 62 阶段唯一完整检查结果，返回 `start / end / lineCount / operationMode / directionStatus`；字段摘要从匹配块原文逐行派生，缺失时安全降级为“未识别”。
- 函数不为 `edited / ambiguous / none` 返回范围，因此 UI 不存在按标题、前缀或近似文本计算选择区的第二套逻辑。
- `CommandPanel` 使用本地 `textarea` ref。用户点击定位时先聚焦，再设置精确选择区，并按块前换行数和真实 CSS 行高计算 `scrollTop`；不触发 `onCommandChange`、`executeCommand`、Worker、网络或版本写入。
- 状态卡动作区改为纵向“定位诊断块 / 移除诊断块”，网格编辑面板避让规则继续确保两个按钮可接收真实指针事件。

2026-07-22 架构验证：新增前后文字范围、块位于开头、多行前缀、安全摘要降级，以及编辑、残缺和重复拒绝测试；针对性测试 49/49、前端 222/222、生产构建和差异检查通过。浏览器精确选中完整 13 行诊断块并产生非零滚动，修改后不再返回可定位范围，Console 无错误。

### 64. 连续共面区域旧诊断块安全替换架构（已实现）

- `replaceMeshPlanarRegionCodexAnalysisDraftBlock(draft, generatedBlocks, latestSummary)` 复用稳定请求生成与完整块检查，只接受唯一完整本页旧块和非空最新摘要，返回 `replaced / duplicate / unsafe / invalid`。
- 成功替换通过旧块精确字符范围拼接 `draft.slice(...)`，不对块外内容执行 `trim` 或空行归一化，因此用户前后文字、尾随空格和原有换行位置保持不变。
- `App` 复用当前修订的诊断摘要派生 `append / replace / duplicate / unsafe` 动作；点击后重新检查实时草稿，替换成功时在同一 React 事件中批量更新 `commandDraft` 与 `commandDiagnosticBlocks`，并移除旧块登记。
- `MeshElementEditPanel` 只消费动作状态和同步返回结果来切换全中文按钮与反馈。用户编辑块后检查立即转为 `unsafe`，旧追加/替换成功反馈失效，防止界面误示可管理状态。
- 没有新增 Zustand 字段、Tauri 命令、Python Worker 输出、网络调用、项目版本或快照迁移；替换不触发表单提交和 `executeCommand`。

2026-07-22 架构验证：新增测试覆盖块外内容原样保留、相同块、编辑块、重复块和空最新摘要；针对性测试 53/53、前端 226/226，生产构建和差异检查通过。真实浏览器完成 2.00→3.00 毫米诊断原位替换，标题保持 1 处且消息数不变；手工修改后产生 1.00 毫米新结果仍被安全拒绝，Console 无错误。

### 65. 连续共面区域诊断字段纯比较架构（已实现）

- `createMeshPlanarRegionCodexDiagnosticFieldDifferences(draft, generatedBlocks, latestSummary)` 先复用稳定请求生成和唯一完整块检查，再按固定九字段定义比较旧块与最新请求；返回项仅包含稳定键、中文标签、旧值和新值。
- 相同请求返回空数组；任一字段在旧块或最新请求中缺失时跳过。`edited / ambiguous / none`、未登记文本及空最新摘要返回 `null`，不按标题、近似行或数值格式猜测差异。
- `App` 只在现有 `codexDiagnosticDraftAction === 'replace'` 时把派生数组传给 `MeshElementEditPanel`；组件只读渲染“旧值 → 新值”，替换后或安全状态变化时由受控状态自然消失。
- 差异数组不进入 Zustand、Tauri、Worker、项目版本或快照，不保存完整诊断副本，也不触发剪贴板、网络、替换或 `executeCommand`。

2026-07-22 架构验证：新增字段固定顺序、相同值过滤、字段缺失、相同请求、编辑、重复、未登记和空摘要测试；针对性测试 56/56、前端 229/229，生产构建和差异检查通过。真实浏览器显示 2.00→3.00 毫米诊断的 6 个实际变化字段，替换后立即消失，消息数保持 3；编辑字段后比较层返回不安全且卡片隐藏，Console 无错误。

### 66. 连续共面区域诊断字段差异复制架构（已实现）

- `createMeshPlanarRegionCodexDiagnosticDifferenceSummary(differences)` 只消费第 65 阶段的有限差异数组，按既有顺序生成固定中文标题、数量和逐项变化；空数组或任一项标签、旧值、新值为空时返回 `null`，不读取完整诊断正文。
- `copyMeshPlanarRegionCodexDiagnosticDifferenceSummary(differences, writeText)` 把剪贴板写入作为异步依赖注入，成功返回 `copied`，无效输入或写入异常统一返回 `failed`，不把宿主权限错误抛到 React 事件链。
- `MeshElementEditPanel` 仅在 `codexDiagnosticDraftAction === 'replace'` 且存在差异时即时生成摘要；复制反馈用摘要文本做身份绑定，因此替换、重新计算或安全状态变化后旧反馈自然失效。
- 新状态只存在于面板本地 React 状态，不进入 Zustand、Tauri、Worker、项目版本或快照；复制处理不调用草稿更新回调、`executeCommand`、网络或几何执行。

2026-07-22 架构验证：新增固定格式、字段顺序、完整正文排除、空差异、无效字段、剪贴板成功与异常测试；针对性测试 59/59、前端 232/232，生产构建和差异检查通过。真实浏览器捕获到 6 项有限差异文本，草稿与消息数不变，替换后组件派生摘要和反馈一并清除；干净验收页 Console 无错误。

### 67. 连续共面区域诊断差异复制预览架构（已实现）

- `createMeshPlanarRegionCodexDiagnosticDifferencePreview(summary, expanded)` 是无副作用纯函数：空摘要返回 `null`，收起时只返回中文入口标签，展开时把原始 `summary` 作为 `content` 原样返回，不做 `trim`、重新格式化或第二次字段拼接。
- `MeshPlanarRegionDiagnosticDifferenceTools` 同时持有 `previewExpanded` 与 `copyStatus` 两项局部状态，并由父组件使用 `key={diagnosticDifferenceSummary}` 按摘要身份挂载；摘要变化会创建全新局部状态，差异卡隐藏会卸载组件。
- 复制仍由既有 `copyMeshPlanarRegionCodexDiagnosticDifferenceSummary(differences, writeText)` 生成相同摘要；预览展示使用父组件已经派生的 `diagnosticDifferenceSummary`，浏览器验收严格比较两者文本以防漂移。
- 只读 `<pre>` 使用 `white-space: pre-wrap`、`user-select: text` 和 `tabIndex=0`，不注册编辑、复制或执行快捷键；新增样式只有细边框、滚动和语义颜色，无明显阴影。
- 未新增 Zustand 字段、Tauri 命令、Python Worker 输出、项目版本、快照或持久化协议，也不改变诊断替换安全边界。

2026-07-22 架构验证：针对性测试 62/62、前端 235/235、生产构建和差异检查通过。真实浏览器确认预览默认收起，展开正文与剪贴板捕获文本严格相同；收起、替换、摘要身份变化和卡片卸载均能清理局部状态，干净页面 Console 无错误。

### 68. 连续共面区域诊断差异预览全文选择架构（已实现）

- `selectMeshPlanarRegionCodexDiagnosticDifferencePreviewText(previewElement, selectText)` 只校验当前节点和非空正文，再调用可注入选择边界；成功返回 `selected`，空引用、空正文、Selection/Range 不支持或任何异常统一返回 `failed`。
- `MeshPlanarRegionDiagnosticDifferenceTools` 使用 `useRef<HTMLPreElement>` 指向当前只读预览；浏览器实现通过 `document.createRange().selectNodeContents(element)` 与 `window.getSelection()` 重置范围，不读取或写入剪贴板。
- `selectionStatus` 只存在于 keyed 子组件本地。展开/收起动作主动清回 `idle`；摘要变化、差异失效或替换时，现有 keyed 挂载边界继续负责卸载旧状态。
- 成功和失败反馈均为中文，失败使用 `role=alert` 但不抛出到组件树；按钮、反馈和正文只在预览展开时渲染。
- 未新增 Store、Tauri、Worker、模型版本、快照、草稿或系统块协议，也不修改既有复制和执行链。

2026-07-22 架构验证：针对性测试 65/65、前端 238/238、生产构建和差异检查通过。真实浏览器验证 Selection 文本与预览正文严格相同、剪贴板调用为 0，并覆盖 Selection 不可用、收起重置、重新展开和替换卸载；干净页面 Console 无错误。

### 69. 连续共面区域诊断差异预览统计架构（已实现）

- `createMeshPlanarRegionCodexDiagnosticDifferencePreviewMetrics(summary)` 是无副作用纯函数：空摘要返回 `null`，行数按 CRLF/LF/CR 分隔统计，字符数使用 `Array.from(summary).length` 按 Unicode 码点计算。
- `MeshPlanarRegionDiagnosticDifferenceTools` 只从当前 `preview.content` 即时派生统计；预览收起时 `content` 为 `null`，因此统计不渲染，也不存在第二份正文状态。
- 统计标签是只读 `<small aria-label="差异摘要内容统计">`，仅增加语义颜色和等宽数字样式；既有 `<pre>` 引用和 Selection/Range 选择链路保持不变。
- 摘要变化仍由 `key={diagnosticDifferenceSummary}` 触发子组件重挂载，替换或安全状态失效则卸载整张差异工具卡；未新增 Store、Tauri、Worker、模型版本、快照或持久化字段。

2026-07-22 架构验证：针对性测试 67/67、前端 240/240、生产构建和差异检查通过。真实浏览器中 6 项差异正文独立计算为 8 行、230 个 Unicode 字符，统计标签严格一致；Selection 不受影响，收起、重新展开与替换卸载均符合 keyed 状态边界，干净页面 Console 无错误。

### 70. 任意封闭模型六向打印方向评估架构（已实现）

- `evaluateAxisAlignedPrintOrientations` 是独立无副作用纯函数，输入为毫米制 `positions` 与可选 `indices`；既支持索引网格，也支持 `STLLoader` 展开的非索引三角面，不依赖 Three.js 场景对象、Store 或固定模型语义。
- 计算阶段过滤退化面、拒绝非有限坐标和无三维体积网格，通过封闭体有向体积统一整体绕序，再对固定顺序 +Z、-Z、+Y、-Y、+X、-X 构造候选；整体反转三角面绕序不会改变结果。
- 候选尺寸由原始包围盒轴映射得到；底面接触使用最低平面容差和朝下法线共同判定，支撑面积排除底面接触后按 `normal · up < -cos(45°)` 累加。评分权重固定为悬垂比例 70、打印高度 20、底面接触 10，超出成型空间的候选保持 `score=null`，不能参与推荐。
- `PrintOrientationPanel` 使用 `resolveGeneratedModelUrl` 临时读取当前精确 STL，解析后立即释放几何和 Blob URL；分析状态只在组件本地保存，并通过请求序号阻止旧异步结果覆盖新来源。
- `ParameterPanel` 为上传 STL 使用 `revision + sourceFile` 身份，为 CAD 使用 `cad revision + part id + stlFile` 身份；当前场景选中 CAD 零件优先，主零件仅作为回退。身份变化触发局部结果清除，快速预览不提供伪精确输入。
- 未新增 Zustand 字段、Tauri 命令、Python Worker、对象变换、项目版本或快照协议；UI 只增加全中文只读结果和无明显阴影样式。

2026-07-22 架构验证：针对性测试 6/6、前端 26 个测试文件 246/246、生产构建和差异检查通过。自动测试覆盖索引与非索引等价、整体反向绕序、非对称悬垂、六向超出 P1S、退化与非有限输入。真实浏览器验证 CAD 主体、上盖、快速预览和任意上传 STL 四条状态路径，上传 STL 输出六个候选且 Console 无错误或警告。

### 71. 六向打印方向建议一键应用架构（已实现）

- `PRINT_ORIENTATION_ROTATIONS_DEG` 把六个候选映射为绝对 Three.js XYZ 欧拉角；`getPrintOrientationRotationDeg` 返回副本，`isPrintOrientationRotationApplied` 使用模 360° 和有限容差判断等价角度，避免累计旋转与重复版本。
- `createPrintOrientationPresentation` 先通过 `normalizeObjectPresentation` 取得完整对象展示状态，再只替换 `rotationDeg`；位置、均匀缩放、颜色和其他对象状态不会被重新构造或丢失。
- `PrintOrientationSource` 增加真实 `objectId`、回退颜色、均匀缩放和当前旋转。CAD 使用零件 ID，任意上传 STL 固定使用视口对象 `uploaded-model`；来源身份包含缩放值，缩放变化会卸载旧分析与确认状态。
- `PrintOrientationPanel` 的确认操作复用 `beginObjectPresentationEdit`、`updateObjectPresentation` 和 `finishObjectPresentationEdit`，生成“应用‘对象名称’的打印方向：方向名称”中文展示版本；成功后递增请求序号、清除旧结果并显示重新分析提示。
- 六向纯计算接收 `uniformScale`，读取顶点时应用缩放，因此尺寸、面积和体积自然按一次、平方和立方缩放；非法缩放在进入几何计算前以中文错误拒绝。
- 确认卡与成功提示只存在于组件本地，不增加新的持久化协议、Tauri 命令或 Python Worker；版本、撤销和重做继续由既有对象展示快照负责。

2026-07-22 架构验证：针对性测试 18/18、前端 26 个测试文件 253/253、生产构建和差异检查通过。真实浏览器覆盖 CAD 取消、确认、撤销、重做、角度等价保护、1.5 倍缩放和任意上传 STL 对象写入，Console 为 0 个错误、0 个警告。

### 72. 推荐打印方向应用后的自动落床架构（已实现）

- `evaluatePrintBedPlacement` 纯计算旋转、缩放和归一化后的最低点、当前垂直位置、目标 Y 位置与所需位移；`createPrintBedPlacementPresentation` 只替换对象展示状态中的 `positionMm.y`。
- 坐标链明确为原始 STL X → 视口 X、原始 STL Z → 视口 Y、原始 STL Y → 视口 -Z，打印平台固定为视口 Y=0。CAD 普通零件使用 `normalizationSpace: 'object-local'`，任意上传 STL 使用 `normalizationSpace: 'world'`，对应 `uploadedGroupPosition` 位于对象变换外层的真实场景结构。
- `PrintBedPlacementOptions` 同时携带绝对旋转、业务位置、均匀缩放、归一化空间和可选基础显示位置；最低点计算与 UI 解耦，可覆盖 CAD 主体、装配上盖及任意上传 STL，不依赖固定模型名称。
- `PrintOrientationPanel` 仅在当前精确分析与对象展示来源仍一致时派生预览。来源身份包含对象、修订、位置、旋转、缩放、基础位置和归一化空间；请求序号与写入前 Store 复核共同阻止过期结果或并发变化写入。
- 确认动作继续复用 `beginObjectPresentationEdit`、`updateObjectPresentation` 与 `finishObjectPresentationEdit`，生成“将‘对象名称’落到打印平台”版本。取消、重复落床、越界和失败路径都不会提交版本。
- 写入会改变来源身份，因此组件通过 `pendingPresentationNotice` 暂存成功提示，并在来源刷新清理旧分析时恢复该提示；该状态只存在于组件本地，不增加 Zustand、Tauri、Worker 或项目文件协议。

2026-07-22 架构验证：针对性测试 24/24、前端 26 个测试文件 259/259、生产构建和差异检查通过。真实浏览器分别验证 CAD 对象内归一化和上传 STL 对象外归一化路径，覆盖 Y=10、Y=7.5、取消、确认、版本、撤销、重做、重复保护及成功提示保留，Console 为 0 个错误、0 个警告。

### 73. 自动落床后的平台边界适配与只读居中预览架构（已实现）

- `evaluateTransformedDisplayBounds` 统一执行原始 STL X → 视口 X、原始 STL Z → 视口 Y、原始 STL Y → 视口 -Z 的坐标映射，并按绝对旋转、均匀缩放、业务位置、基础显示位置和 `normalizationSpace` 计算最终显示包围范围；第 72 阶段落床计算与本阶段平台计算复用同一条几何链。
- `evaluatePrintPlatformBoundary` 是无副作用纯函数，默认平台为 256 × 256 毫米且以视口 X=0/Z=0 为中心；输出 X/Z 包围范围、平台范围、四边余量、四向越界量、最小安全余量、适配状态、居中位移和目标水平位置。
- CAD 零件使用 `object-local` 归一化，任意上传 STL 使用 `world` 归一化；变换顺序与 `ModelViewport` 的真实场景层级一致，避免上传 STL 的世界归一化偏移被对象旋转或缩放重复应用。
- `PrintOrientationPanel` 只在推荐方向已应用、对象已落床且当前分析来源身份未变化时展示平台卡。位置、旋转、缩放、修订、对象、基础位置或归一化空间变化都会通过来源身份和局部状态清理使旧结果失效。
- 平台卡只读渲染中文余量、越界与居中建议，不调用 `beginObjectPresentationEdit`、`updateObjectPresentation` 或 `finishObjectPresentationEdit`，因此不会产生对象展示版本或持久化写入。

2026-07-22 架构验证：针对性测试 29/29，前端 26 个测试文件 264/264，生产构建和差异检查通过。自动测试覆盖 CAD 对象内归一化、上传 STL 对象外世界归一化、旋转、缩放、已有位置、平台内、四向越界和无效输入；真实浏览器验证 CAD 与任意上传 STL 两条场景链的精确余量、越界和居中目标。

### 74. 平台居中建议确认应用架构（已实现）

- `createPrintPlatformCenterPresentation` 是无副作用展示状态转换函数：先通过 `normalizeObjectPresentation` 补齐完整状态，再只替换平台预览给出的 `positionMm.x` 和 `positionMm.z`；目标非有限时抛出中文错误，其他变换和颜色保持不变。
- `PrintOrientationPanel` 新增独立的居中确认状态；来源身份变化和重新分析都会关闭确认。`sourceTransformStillCurrent` 统一核对 Store 当前缩放、XYZ 位置和 XYZ 旋转，落床与居中写入共享同一实时变换门禁。
- 居中写入还核对推荐方向已应用、对象已落床、平台来源身份、未重复居中、目标有限、当前位置加建议位移等于目标，以及规范化后目标未被对象安全范围截断；写入后再次读取 Store 验证 X/Z，失败则回滚展示状态且不完成版本。
- 成功路径调用 `beginObjectPresentationEdit`、`updateObjectPresentation` 和 `finishObjectPresentationEdit`，生成“将‘对象名称’移动到打印平台中心”展示版本；成功后递增请求序号、清除旧分析并通过待处理提示跨来源刷新保留中文结果。

2026-07-22 架构验证：针对性测试 32/32、前端 26 个测试文件 267/267、生产构建和差异检查通过。自动测试覆盖纯函数状态保留、非法目标、中文版本及撤销重做；真实浏览器覆盖任意上传 STL 与 CAD 的确认、取消、重复保护、来源失效、版本恢复和 Store 写入后状态，Console 为 0 个错误、0 个警告。

### 75. 平台安全边距设置与单对象可打印区域预览架构（已实现）

- `PrintPlatformSafetyAreaPreview` 独立描述 `safetyMarginMm`、有效平台边界、四边安全余量与越界量、适配状态、是否可仅靠平移适配、最小安全余量和 X/Z 修正量，不改变既有物理平台预览协议。
- `evaluatePrintPlatformSafetyArea` 是无副作用纯函数，平台宽深和中心直接复用 `PrintPlatformBoundaryPreview.platformBoundsMm`；输入必须有限且非负，且收缩后两轴都必须保留正尺寸，否则抛出全中文错误。
- 最小修正按每轴独立求解：对象位于有效区域内时为 0，单侧越界时返回恰好回到边界的位移；对象尺寸大于有效轴时标记 `canFitEffectiveArea=false`，只保留中心对齐近似供解释，UI 明确禁止把它解释为完全适配。
- `PrintOrientationPanel` 以本地 `safetyMarginInput` 保存用户当前设置，并从已验证的物理平台预览纯派生安全区域；输入变化不参与分析来源身份，不调用对象展示编辑链，也不修改 `platformBoundary.centerTargetPositionMm`。
- 安全区域卡与物理平台卡同时存在。无效边距只显示中文错误；有效结果按固定方向显示余量或越界，并在可修正时显示只读 X/Z 建议。

2026-07-22 架构验证：针对性测试 39/39、前端 26 个测试文件 274/274、生产构建和差异检查通过。自动测试覆盖默认值、零边距、接近上限、非法输入、单轴/双轴越界、对象大于有效区域和物理预览不可变；真实浏览器覆盖 CAD 与任意上传 STL，确认边距变化不清除分析、不创建版本且不改变物理居中目标，独立页面 Console 为 0 个错误、0 个警告。

### 76. 安全区域修正建议确认应用架构（已实现）

- `createPrintPlatformSafetyCorrectionPresentation` 是无副作用状态转换：先规范化对象展示状态，再只把 `correctionDeltaMm.x/z` 累加到 `positionMm.x/z`；对象过大、已适配、建议为零或修正量非有限时抛出全中文错误。
- `translatePrintPlatformBoundaryPreview` 按候选 X/Z 位移重算对象边界、物理四边余量、越界量、最小余量、居中差值和适配状态；组件在写入前把结果再次交给 `evaluatePrintPlatformSafetyArea`，确保候选位置同时位于物理平台和安全有效区域内。
- `SafetyCorrectionConfirmation` 冻结安全边距、两轴修正量和目标 X/Z。输入变化立即清除快照；确认时再次核对来源身份、推荐方向、落床状态、Store 实时变换、边距、修正量和目标一致性，避免陈旧确认写入。
- 成功路径复用 `beginObjectPresentationEdit`、`updateObjectPresentation` 和 `finishObjectPresentationEdit`，生成“将‘对象名称’移动到平台安全区域”展示版本；写入后读取 Store 校验目标，旧分析失效并保留中文成功提示。

2026-07-22 架构验证：针对性测试 44/44、前端 26 个测试文件 279/279、生产构建和差异检查通过。自动测试覆盖单轴、双轴、状态保留、修正后复验、非居中目标、对象过大、已适配、零值、非有限值、中文版本及撤销重做；真实浏览器覆盖 CAD、任意上传 STL、取消、边距快照失效、确认和重新分析，独立页面 Console 为 0 个错误、0 个警告。

### 77. 平台安全区域边界三维视口可视化架构（已实现）

- `src/model/printPlatformOverlay.ts` 定义独立 `PrintPlatformOverlay` 协议和 `createPrintPlatformOverlay` 纯转换，复制来源身份、对象身份、平台/有效区/对象水平边界、四边越界量及 `inside / overflow / too-large` 状态；所有身份、边界、高度和越界输入均进行有限值与顺序校验。
- `createPrintPlatformRectanglePoints` 和 `createPrintPlatformBoundarySegment` 只生成真实 X/Z 毫米坐标的闭合折线或指定边段。左/右映射 `minimumX/maximumX`，前/后映射 `maximumZ/minimumZ`，渲染层无需重复推导业务方向。
- Zustand Store 只保存 `printPlatformOverlay` 临时状态与来源核对清理动作，不把它加入 `ModelVersion`。模型来源切换、新建画布、开始导入 STL 和清除上传 STL 会同步清理；带旧身份的组件 cleanup 不会删除新来源叠加。
- `PrintOrientationPanel` 仅在分析来源仍有效、推荐方向已应用、对象已经落床、物理平台与合法安全区域都存在时写入叠加；来源或对象变换变化使旧分析和旧叠加失效，安全边距变化则在当前来源上同步重建。
- `PrintPlatformOverlayLayer` 使用 Drei `Line` 分层绘制平台、安全区域、对象占地和越界边段，通过轻微 Y 偏移、`depthTest=false` 与固定 `renderOrder` 避免 Z-fighting。DOM 图例 `pointer-events:none`，三维线框无指针处理，不进入选择与操控链路。

2026-07-22 架构验证：针对性测试 53/53、前端 28 个测试文件 288/288、生产构建和差异检查通过。自动测试覆盖 CAD 与通用上传模型身份、区域内外、单轴/双轴越界、对象过大、边距变化、无效输入、矩形坐标、四边映射、Store 非版本状态、旧来源保护和模型切换清理；真实浏览器覆盖安全边距刷新、视口旋转/缩放/平移、图例事件穿透、任意 STL 与安全修正后状态，Console 为 0 个错误、0 个警告。

### 78. 打印平台叠加一键俯视与适配视野架构（已实现）

- `src/model/printPlatformCamera.ts` 定义 `PrintPlatformTopView` 与 `PrintPlatformViewRequest`。`mergePrintPlatformViewBounds` 合并物理平台和对象 X/Z 边界，`createPrintPlatformTopView` 依据垂直视场角、视口宽高比和安全倍率计算并集中心、轨道目标和相机距离；所有来源、边界、视口与计算结果均执行有限值和退化校验。
- `createNextPrintPlatformViewRequest` 只复制当前来源身份与本次平台/对象边界并生成递增编号；`resolvePrintPlatformTopViewRequest` 在消费前再次核对当前叠加来源，旧来源或已清理叠加返回 `null`，不把临时请求写入 Store。
- `PrintPlatformCameraController` 在 `useFrame` 中使用约 0.46 秒 ease-out 动画同步插值 `camera.position` 与 `OrbitControls.target`。相机采用轻微 Z 偏移避免正俯视视线与 Three.js 默认 Y-up 完全共线，并按适配距离动态扩展远裁剪面。
- 请求消费键由 `sourceIdentity + 请求编号` 组成，避免新来源编号重新从 1 开始时被旧请求误判；连续点击仍可生成并消费下一编号。非法请求、退化边界和来源不匹配不改变当前相机。
- `PerspectiveCamera` 和 `OrbitControls` 放宽只读视口距离上限，使完整 256 × 256 毫米平台及更大通用对象可见；动画后控制器继续启用，不阻断旋转、缩放、平移或选择。
- 视口 DOM 使用 `.print-platform-overlay-stack` 纵向排列图例和按钮；图例保持 `pointer-events:none`，按钮单独 `pointer-events:auto`。相机请求、动画和按钮状态不进入 `ModelVersion`、撤销重做、项目持久化、打印分析来源或几何导出。

2026-07-23 架构验证：针对性测试 18/18、前端 29 个测试文件 297/297、生产构建和差异检查通过。自动测试覆盖平台内、单轴/双轴越界、对象大于平台、宽窄视口、连续请求、来源变化、请求边界复制、最小距离和非法输入；真实浏览器验证新旧来源编号同为 1 时，新来源首次请求仍改变 Canvas，版本保持且 Console 为 0 个错误、0 个警告。

### 79. 打印平台俯视前视角返回架构（已实现）

- `printPlatformCamera.ts` 新增 `PrintPlatformCameraPose`、`PrintPlatformReturnSnapshot`、`PrintPlatformTopViewRequest` 与 `PrintPlatformReturnViewRequest`；联合请求以 `kind` 区分俯视和返回，并共享单调递增编号。
- `capturePrintPlatformReturnSnapshot` 校验来源、相机位置、控制器目标和两点距离，复制三轴数值；已有同来源快照时直接返回原对象，确保重复俯视不会覆盖第一次捕获。`resolvePrintPlatformReturnSnapshot` 只允许当前叠加来源消费快照。
- `PrintPlatformCameraController` 在第一次有效俯视请求开始前，从真实 `camera.position` 和 `OrbitControls.target` 捕获快照；返回请求只引用同来源内部快照，复用相同 ease-out 插值恢复两者，并在动画完成后清除。
- 已处理请求键由 `kind + sourceIdentity + id` 构成，避免俯视与返回或不同来源的相同编号冲突。来源变化时父组件请求、返回可用状态和控制器内部快照共同清理；动画期间来源失效也立即终止并删除快照。
- 父组件只保存当前临时请求和“哪个来源可返回”的轻量 UI 状态；真实相机快照只存在控制器 `ref`，不进入 Zustand、`ModelVersion`、撤销重做、项目持久化、打印分析协议或导出数据。
- `.print-platform-view-actions` 统一承载俯视和返回按钮；容器保持事件穿透，两个中文按钮单独接收鼠标和键盘焦点。

2026-07-23 架构验证：针对性测试 23/23、前端 29 个测试文件 302/302、生产构建和差异检查通过。自动测试覆盖首次复制、输入对象后续变更不污染快照、重复捕获保留、来源切换、返回请求类型与编号、空来源、非有限坐标和相机目标重合；浏览器验证返回后的 Canvas PNG 与原图哈希一致，来源清理正确且 Console 为 0 个错误、0 个警告。

### 80. 打印平台半透明床面与中心、前向标识架构（已实现）

- `src/model/printPlatformOverlay.ts` 新增 `PrintPlatformBedGuide`、`createPrintPlatformBedGuide` 与 `resolvePrintPlatformBedGuide`。协议只从 `sourceIdentity` 和 `platformBoundsMm` 派生中心、宽深、中心十字段、前侧标签坐标，不复制对象展示状态或增加 Store 字段。
- 边界验证复用有限毫米检查并额外要求正宽度、正深度；严格创建函数使用中文错误拒绝空来源、非有限或退化边界，安全解析函数在渲染入口返回 `null`，防止非法状态产生 NaN 平面或中断整个三维场景。
- `PrintPlatformOverlayLayer` 使用关闭深度写入的低透明度双面平面绘制床面；中心十字与床面都设置空 `raycast`，`Html` 方向标签设置 `pointer-events: none`，因此不会进入 React Three Fiber 选择、框选或操控器命中链路。
- 前侧坐标固定基于 `maximumZ` 并向床面内部留出小量视觉边距；标签沿右前区域放置以避开视口左下 Codex 面板，但几何语义仍完全来自平台边界。床面显示只消费既有 `printPlatformOverlay`，来源失效继续由 Store 原生命周期统一清除。
- 新协议不修改模型、相机请求、项目序列化、版本快照和 STL/STEP/3MF 导出数据；完整测试覆盖 P1S 与非对称平台的尺寸/中心、中心十字、最大 Z 前向语义、来源切换和非法边界。

2026-07-23 第 80 阶段验证：针对性测试 12/12，完整前端测试 305/305，TypeScript/Vite 构建和差异检查通过。浏览器确认床面、中心十字和方向标签渲染正常，标签事件穿透、视角旋转与版本隔离有效，来源变化同步清理，Console 为 0 个错误、0 个警告。

### 81. 打印平台毫米网格与坐标刻度架构（已实现）

- `src/model/printPlatformOverlay.ts` 新增 `PrintPlatformGridGuide`、`PrintPlatformGridLine`、`PrintPlatformGridTick`、`createPrintPlatformGridGuide` 与 `resolvePrintPlatformGridGuide`。协议只读取 `sourceIdentity` 和 `platformBoundsMm`，固定输出 10/50 毫米间距、主次线段与刻度锚点。
- 坐标生成先用边界除以 10 的整数索引求首末值，避免逐毫米扫描和浮点累积；每轴最多允许 1024 个坐标，非有限、退化或异常超大范围由严格函数抛出中文错误，安全解析入口返回 `null`。
- X 坐标线使用固定 X 并沿 `minimumZ → maximumZ` 裁剪，Z 坐标线使用固定 Z 并沿 `minimumX → maximumX` 裁剪；每 5 个次网格索引自然落在 50 毫米主网格。正数刻度带“+”，零点统一为数值 0，避免 `-0` 文案。
- `PrintPlatformOverlayLayer` 在床面之后批量绘制低透明度主次 `Line`，统一关闭 `depthWrite`、`depthTest` 和 `raycast`；刻度 `Html` 设置 `pointer-events: none` 并带只读数据属性，中心十字、安全边界、对象占地和越界高亮继续使用更高显示层级。
- 网格由现有打印平台叠加即时派生，不增加 Zustand 字段，也不进入版本、撤销重做、项目序列化、相机请求或 STL/STEP/3MF 导出；来源变化沿用既有叠加生命周期自动清除。

2026-07-23 第 81 阶段验证：针对性测试 16/16，完整前端测试 309/309，TypeScript/Vite 构建和差异检查通过。自动测试覆盖 P1S、非对称跨零、不跨零、主次分类、严格裁剪、中文刻度、来源切换、非法退化和异常超大范围；浏览器验证 10 个主刻度、事件穿透、真实旋转、版本隔离与来源清理，Console 为 0 个错误、0 个警告。

### 82. 打印平台多对象联合占地预览架构（已实现）

- `src/model/printPlatformMultiObject.ts` 定义独立纯协议：候选、单对象占地、联合预览、排除计数和确定性来源身份。协议接受任意 CAD、上传 STL 或参考来源，严格校验有限且非退化边界，并输出 `inside`、`overflow`、`too-large` 状态。
- `PrintPlatformMultiObjectAnalyzer` 只在既有单对象 `printPlatformOverlay` 有效时运行，使用 `resolveGeneratedModelUrl`、`STLLoader` 与 `evaluatePrintPlatformBoundary` 异步读取全部精确 STL；单个对象失败只计入无有效几何，不阻断其他对象。
- `PrintBedNormalizationSpace` 增加 `preserved`：制造拆件保留生成文件中的装配坐标，再叠加显式基础位置和对象展示变换；普通 CAD 继续使用 `object-local`，未拆分上传 STL 使用原整体显示基础位置。
- Zustand 只保存独立临时 `printPlatformMultiObjectPreview`；设置或清除单对象平台叠加、切换模型来源、导入/清除 STL 或重置项目时同步清理。Effect 使用取消标记和来源身份阻止过期异步结果回写，不进入 `ModelVersion`、持久化或导出协议。
- `PrintPlatformOverlayLayer` 绘制每对象虚线与黄色联合粗虚线，统一关闭深度测试、深度写入和射线命中；DOM 摘要使用只读数据属性和 `pointer-events: none`，便于浏览器验收且不阻断视角与对象交互。

2026-07-23 第 82 阶段验证：针对性测试 55/55，完整前端测试 318/318，TypeScript/Vite 构建和差异检查通过。浏览器确认多对象精确 STL 分析、联合轮廓、参考对象排除、事件穿透、版本隔离和来源变化清理均符合预期，Console 为 0 个错误、0 个警告。

### 83. 打印平台多对象间距与重叠诊断架构（已实现）

- `src/model/printPlatformMultiObject.ts` 增加 `PrintPlatformObjectPairDiagnostic`、`PrintPlatformMultiObjectSpacingDiagnostic` 和 `createPrintPlatformMultiObjectSpacingDiagnostic`。纯函数按来源身份排序对象，生成稳定对象对，候选输入顺序不影响输出。
- 每轴关系同时输出间隔、重叠量和最近点；仅当 X/Z 两轴都有正重叠才判定水平重叠，否则使用 `Math.hypot(gapX, gapZ)` 计算最近二维间距。重叠最小分离量采用较小轴重叠深度加安全间距。
- 安全间距严格要求非负有限毫米值。`ModelViewport` 保留本地字符串输入，合法值实时派生诊断；非法值不写 Store，而是以 2.00 毫米重新计算并显示中文回退提示。
- `ModelScene` 只接收当前派生诊断：重叠对象对复用矩形点协议绘制红色粗虚线，间距不足对象对绘制最近点橙色连线；全部 Three.js 提示关闭深度写入和射线命中。摘要风险文本事件穿透，只有安全间距输入启用指针事件。
- 诊断不增加 Zustand、版本、持久化或导出字段；第 82 阶段联合预览失效后 React 派生值自然归零，不存在独立过期异步请求。

2026-07-23 第 83 阶段验证：针对性测试 18/18，完整前端测试 328/328，TypeScript/Vite 构建和差异检查通过。自动测试覆盖重叠、X/Z 单轴分离、对角距离、临界安全值、多个对象、顺序无关、来源身份、空集合和非法输入；浏览器验证实时输入、中文回退、红色重叠框、事件穿透、版本隔离和来源清理，Console 为 0 个错误、0 个警告。

**下一阶段架构方向：**在现有联合占地和间距诊断之上增加确定性二维排布规划器，输出每对象目标 X/Z、整体候选边界和失败原因；先以独立预览协议显示幽灵轮廓，确认时通过新的批量展示变换动作一次提交一个版本。

### 84. 打印平台多对象自动排布预览架构（已实现）

- `createPrintPlatformMultiObjectLayoutPlan(...)` 是无副作用纯排布协议，只消费第 82 阶段的 `PrintPlatformMultiObjectPreview`、安全有效区域和安全间距。它先校验有限边界与非负间距，再按稳定来源身份排序，保证输入顺序不会改变输出。
- 第一版采用从有效区域最小 X/Z 角开始的行式装箱：对象按当前轴对齐占地放入当前行，放不下时使用该行最大深度加安全间距换行。协议不旋转对象，并输出目标边界、X/Z 位移、水平距离、行号、整体边界、行数、移动数量和适配状态。
- 失败具有事务语义：单个对象尺寸超过有效区域或所有对象无法完整放入时返回 `unplaceable` 和全中文原因，但 `placements` 为空，不泄漏或应用部分方案；空集合返回 `empty`。
- React 本地状态仅保存当前预览对应的排布来源身份。对象占地、有效区域或安全间距改变后新方案身份不同，旧预览自然失效；取消只清除本地身份，不修改 Store。幽灵线设置 `depthTest={false}`、`depthWrite={false}` 且关闭射线命中。
- `applyObjectPresentationBatch(...)` 负责原子批量写入对象展示状态：先拒绝空身份、重复身份和空版本名，再一次持久化完整展示映射并创建一个 `presentation` 版本；无实际变化返回 `false`，应用时同步清除旧打印平台派生状态。现有版本快照因此可整体撤销和重做。
- 制造拆件统一使用 `<sourcePartId>-negative` 与 `<sourcePartId>-positive` 独立对象身份。CAD 拆件视口与导出在独立状态缺失时回退父零件展示状态，独立状态存在时优先使用；上传 STL 拆件继续只使用自身独立状态，避免错误继承。
- 第一版刻意不做 90 度或任意角度旋转搜索、异形网格嵌套、切片器级碰撞、Brim/裙边、支撑占地、材料分组或多打印板管理。

2026-07-23 第 84 阶段验证：针对性测试 5 个文件 49/49，完整前端测试 32 个文件 343/343，TypeScript/Vite 构建和差异检查通过。自动测试覆盖单对象、多尺寸、换行、临界适配、对象过大、总空间不足、顺序无关、非对称区域、无位移、非法输入、批量版本、拆件独立身份与导出回退。浏览器验证预览、幽灵提示、事件穿透、取消、原子应用、整体撤销重做和操作按钮可见性，Console 为 0 个错误、0 个警告。

### 85. 打印平台多对象 90 度旋转寻优排布架构（已实现）

- `PrintPlatformMultiObjectAnalyzer` 对每个 STL 只加载一次，在同一份顶点坐标上分别以当前 `rotationDeg` 和 `rotationDeg.y + 90` 调用平台边界计算，向通用对象候选提供当前边界、当前 Y 轴角度和精确 `rotated90BoundsMm`；纯协议缺少后者时才围绕当前中心交换宽深以兼容旧调用。
- `createPrintPlatformMultiObjectRotationLayoutPlan(...)` 为稳定身份排序后的每个对象生成“保持”和“增加 90 度”两个候选，并复用确定性行式排布。搜索状态按几何状态去重，最多检查 8192 个状态；只接受完整放入有效区域的方案，再依次比较行数、整体面积、总水平位移、旋转数量和稳定朝向签名。
- 目标 Y 轴角度通过等价角归一化生成，避免当前角度接近 Store 上限时简单加 90 度被截断。协议输出每对象当前/目标边界、位置位移、当前/目标 Y 轴角度、是否增加 90 度和是否发生变化，以及整体行数、移动数、旋转数、变化数、尺寸、面积和总位移。
- `ModelViewport` 只保存当前旋转方案身份并使用 `data-print-platform-layout-*` 属性暴露可验收状态。三维场景以青色目标边界、中心位移线和 Y 轴方向线显示候选，旋转对象使用橙色加粗方向线；所有线段设置 `depthTest={false}`、`depthWrite={false}`、`raycast={() => undefined}`，摘要文本继续事件穿透。
- 确认时复用 `applyObjectPresentationBatch(...)`，一次写入所有对象的目标 X/Z 与 Y 轴角度并生成一个 `presentation` 版本；批量动作保留 Y、X/Z 旋转轴、缩放和颜色，空变化返回 `false`。取消或来源、间距、有效区域变化仅使本地预览失效，不污染 Store、持久化或 STL/STEP/3MF。
- 第一版明确不搜索任意角度，不做异形网格嵌套、切片器级碰撞、Brim/裙边、支撑、材料分组或多打印板管理。

2026-07-23 第 85 阶段验证：针对性测试 6 个文件 59/59，完整前端测试 33 个文件 353/353，TypeScript/Vite 构建和差异检查通过。自动测试覆盖旋转后才能放入、减少行数、减小面积、稳定选择、非零当前角度、无意义旋转抑制、空间不足和批量版本。真实浏览器验证精确候选、中文摘要、幽灵边界、位移与方向线、取消、原子应用以及整体撤销重做，Console 为 0 个错误、0 个警告。

**下一阶段架构方向：**在旋转寻优协议上增加显式锁定集合；规划器先验证并占用锁定对象的目标边界，再在剩余空间搜索未锁定对象，预览协议区分锁定与可调整状态，锁定本身保持为会话级排布约束而不写入几何文件。
