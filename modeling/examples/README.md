# 示例模型参数

此目录只保存可选 Demo，不参与通用建模协议或默认文件命名。

- `esp32-s3-n16r8.json`：电子元件保护壳模板的首个演示参数，用于展示照片标定、接口识别、内部包络和外壳生成流程。

通用 Worker 为 `modeling/generate_model.py`，默认参数为 `modeling/default-model.json`；生成结果通过 `model`、动态 `parts[]` 和 `assemblyFile` 描述，不依赖 ESP32。
