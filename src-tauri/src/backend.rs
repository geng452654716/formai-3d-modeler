use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Response;

const GENERATED_FILES: &[&str] = &[
    "model-body.stl",
    "model-cover.stl",
    "model-body.step",
    "model-cover.step",
    "model-assembly.3mf",
    "generation-result.json",
    "imported-model.stl",
    "imported-model-result.json",
    "imported-model-working.stl",
    "imported-model-working.step",
    "local-stl-edit-result.json",
    "mesh-element-edit-result.json",
    "uploaded-model-restore-result.json",
    "local-cad-feature-result.json",
    "local-cad-feature-preflight-result.json",
    "manufacturing-negative.stl",
    "manufacturing-positive.stl",
    "manufacturing-negative.step",
    "manufacturing-positive.step",
    "manufacturing-result.json",
    "wall-thickness-result.json",
    "version-difference-result.json",
];

const PARAMETER_NAMES: &[(&str, &str)] = &[
    ("boardLength", "board_length"),
    ("boardWidth", "board_width"),
    ("boardThickness", "board_thickness"),
    ("boardComponentHeight", "board_component_height"),
    ("clearanceXY", "clearance_xy"),
    ("clearanceZ", "clearance_z"),
    ("wallThickness", "wall_thickness"),
    ("baseThickness", "base_thickness"),
    ("lidThickness", "lid_thickness"),
    ("cornerRadius", "corner_radius"),
    ("edgeChamfer", "edge_chamfer"),
    ("usbPortWidth", "usb_port_width"),
    ("usbPortHeight", "usb_port_height"),
    ("usbPortBottom", "usb_port_bottom"),
    ("usbPortOffsetY", "usb_port_offset_y"),
];
const MAXIMUM_INTERFACE_OPENINGS: usize = 100;
const INTERFACE_OPENING_FACES: &[&str] = &["front", "back", "left", "right", "top", "bottom"];
const INTERFACE_OPENING_SHAPES: &[&str] = &["circle", "rectangle", "rounded-rectangle", "slot"];
const INTERFACE_OPENING_POSITION_REFERENCES: &[&str] = &["face-center-bottom"];

#[derive(Clone)]
pub struct BackendState {
    paths: BackendPaths,
    generation_lock: Arc<Mutex<()>>,
    codex_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct BackendPaths {
    project_root: PathBuf,
    artifacts_dir: PathBuf,
    worker_path: PathBuf,
    split_worker_path: PathBuf,
    wall_thickness_worker_path: PathBuf,
    version_difference_worker_path: PathBuf,
    local_stl_edit_worker_path: PathBuf,
    mesh_element_edit_worker_path: PathBuf,
    uploaded_model_restore_worker_path: PathBuf,
    local_cad_feature_worker_path: PathBuf,
    cad_surface_hit_worker_path: PathBuf,
    transformed_export_worker_path: PathBuf,
    python_path: PathBuf,
    codex_path: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    mode: &'static str,
    project_root: String,
    cad_worker_available: bool,
    codex_installed: bool,
    codex_authenticated: bool,
    codex_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSnapshot {
    id: String,
    label: String,
    directory: String,
    files: Vec<String>,
    model_source: String,
    model_revision: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportVector3 {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportObjectTransform {
    position_mm: ExportVector3,
    rotation_deg: ExportVector3,
    scale: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformedExportObject {
    id: String,
    name: String,
    source_file: String,
    color: String,
    transform: ExportObjectTransform,
    base_position_display_mm: Option<ExportVector3>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformedExportRequest {
    output_file_name: String,
    format: String,
    objects: Vec<TransformedExportObject>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexParameterChange {
    parameter: String,
    value: f64,
    reason: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalCadFeaturePlan {
    operation: String,
    part_id: String,
    stable_face_id: String,
    stable_edge_id: Option<String>,
    selected_edges: Vec<CodexSelectedEdgeTarget>,
    radius_mm: Option<f64>,
    width_mm: Option<f64>,
    height_mm: Option<f64>,
    length_mm: Option<f64>,
    depth_mm: f64,
    rotation_deg: f64,
    reason: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSelectedEdgeTarget {
    stable_face_id: String,
    stable_edge_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelCommandResult {
    summary: String,
    changes: Vec<CodexParameterChange>,
    local_feature: Option<CodexLocalCadFeaturePlan>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationPoint {
    x_percent: f64,
    y_percent: f64,
    x_pixel: f64,
    y_pixel: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCalibration {
    image_width_px: f64,
    image_height_px: f64,
    point_a: CalibrationPoint,
    point_b: CalibrationPoint,
    pixel_distance: f64,
    real_distance_mm: f64,
    mm_per_pixel: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedInterface {
    id: String,
    r#type: String,
    side: String,
    position_x_percent: f64,
    position_y_percent: f64,
    width_mm: f64,
    height_mm: f64,
    horizontal_offset_mm: f64,
    bottom_offset_mm: f64,
    confidence: f64,
    requires_opening: bool,
    opening_shape: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysisResult {
    summary: String,
    object_type: String,
    confidence: f64,
    estimated_parameters: Vec<CodexParameterChange>,
    interfaces: Vec<DetectedInterface>,
    warnings: Vec<String>,
}

impl BackendState {
    pub fn new(resource_dir: Option<PathBuf>, app_data_dir: Option<PathBuf>) -> Self {
        Self {
            paths: BackendPaths::resolve(resource_dir, app_data_dir),
            generation_lock: Arc::new(Mutex::new(())),
            codex_lock: Arc::new(Mutex::new(())),
        }
    }
}

impl BackendPaths {
    fn resolve(resource_dir: Option<PathBuf>, app_data_dir: Option<PathBuf>) -> Self {
        let project_root = find_project_root(resource_dir.as_deref());
        let artifacts_dir = env::var("FORM_AI_ARTIFACTS_DIR")
            .map(PathBuf::from)
            .ok()
            .or_else(|| {
                (!cfg!(debug_assertions))
                    .then(|| app_data_dir.map(|path| path.join("artifacts")))
                    .flatten()
            })
            .unwrap_or_else(|| project_root.join("artifacts"));
        let worker_path = project_root.join("modeling/generate_model.py");
        let split_worker_path = project_root.join("modeling/split_and_cap.py");
        let wall_thickness_worker_path = project_root.join("modeling/wall_thickness_analysis.py");
        let version_difference_worker_path =
            project_root.join("modeling/version_geometry_difference.py");
        let local_stl_edit_worker_path = project_root.join("modeling/local_stl_edit.py");
        let mesh_element_edit_worker_path = project_root.join("modeling/edit_mesh_element.py");
        let uploaded_model_restore_worker_path =
            project_root.join("modeling/restore_uploaded_model_snapshot.py");
        let local_cad_feature_worker_path = project_root.join("modeling/local_cad_feature.py");
        let cad_surface_hit_worker_path = project_root.join("modeling/resolve_cad_surface_hit.py");
        let transformed_export_worker_path =
            project_root.join("modeling/export_transformed_model.py");
        let local_python = project_root.join("modeling/.venv/bin/python");
        let python_path = env::var("FORM_AI_PYTHON_PATH")
            .map(PathBuf::from)
            .ok()
            .filter(|path| path.is_file())
            .or_else(|| local_python.is_file().then_some(local_python))
            .unwrap_or_else(|| PathBuf::from("python3"));

        Self {
            project_root,
            artifacts_dir,
            worker_path,
            split_worker_path,
            wall_thickness_worker_path,
            version_difference_worker_path,
            local_stl_edit_worker_path,
            mesh_element_edit_worker_path,
            uploaded_model_restore_worker_path,
            local_cad_feature_worker_path,
            cad_surface_hit_worker_path,
            transformed_export_worker_path,
            python_path,
            codex_path: find_executable("FORM_AI_CODEX_PATH", "codex"),
        }
    }
}

fn find_project_root(resource_dir: Option<&Path>) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(configured) = env::var("FORM_AI_PROJECT_ROOT") {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(root.to_path_buf());
    }
    if let Ok(current) = env::current_dir() {
        candidates.push(current);
    }
    if let Some(resources) = resource_dir {
        candidates.push(resources.to_path_buf());
        candidates.push(resources.join("_up_"));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.join("modeling/generate_model.py").is_file())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
}

fn find_executable(environment_name: &str, executable: &str) -> Option<PathBuf> {
    if let Ok(configured) = env::var(environment_name) {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{executable}")),
        PathBuf::from(format!("/usr/local/bin/{executable}")),
        PathBuf::from(format!("/usr/bin/{executable}")),
    ];
    if executable == "codex" {
        // The Codex binary shipped with the user's installed desktop app is the
        // preferred macOS integration because it reuses the existing login state.
        candidates.extend([
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        ]);
    }
    if let Ok(home) = env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin").join(executable));
        if executable == "codex" {
            candidates.extend([
                PathBuf::from(&home).join("Applications/ChatGPT.app/Contents/Resources/codex"),
                PathBuf::from(&home).join("Applications/Codex.app/Contents/Resources/codex"),
            ]);
        }
    }
    if Command::new(executable).arg("--version").output().is_ok() {
        return Some(PathBuf::from(executable));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn now_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn sanitize_label(label: &str) -> String {
    let value: String = label
        .chars()
        .filter_map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                Some(character)
            } else if character.is_whitespace() || matches!(character, ':' | '：') {
                Some('-')
            } else {
                None
            }
        })
        .take(48)
        .collect();
    if value.is_empty() {
        "snapshot".into()
    } else {
        value
    }
}

fn normalize_parameters(parameters: &Value) -> Result<Value, String> {
    let source = parameters
        .as_object()
        .ok_or_else(|| "缺少模型参数".to_string())?;
    let mut normalized = Map::new();
    for (client_name, worker_name) in PARAMETER_NAMES {
        let value = source
            .get(*client_name)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
            .ok_or_else(|| format!("无效模型参数：{client_name}"))?;
        normalized.insert((*worker_name).to_string(), json!(value));
    }

    if let Some(interface_openings) = source.get("interfaceOpenings") {
        let openings = interface_openings
            .as_array()
            .ok_or_else(|| "照片精确开孔必须是数组".to_string())?;
        if openings.len() > MAXIMUM_INTERFACE_OPENINGS {
            return Err(format!(
                "照片精确开孔不能超过 {MAXIMUM_INTERFACE_OPENINGS} 个"
            ));
        }
        let mut normalized_openings = Vec::with_capacity(openings.len());
        for (index, opening) in openings.iter().enumerate() {
            let opening = opening
                .as_object()
                .ok_or_else(|| format!("第 {} 个照片精确开孔格式无效", index + 1))?;
            let read_string = |name: &str, maximum_length: usize| -> Result<String, String> {
                let value = opening
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.chars().count() <= maximum_length)
                    .ok_or_else(|| format!("第 {} 个开孔的 {name} 无效", index + 1))?;
                Ok(value.to_string())
            };
            let read_number = |name: &str, minimum: f64, maximum: f64| -> Result<f64, String> {
                let value = opening
                    .get(name)
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value >= minimum && *value <= maximum)
                    .ok_or_else(|| format!("第 {} 个开孔的 {name} 无效", index + 1))?;
                Ok(value)
            };
            let face = read_string("face", 16)?;
            let shape = read_string("shape", 32)?;
            if !INTERFACE_OPENING_FACES.contains(&face.as_str()) {
                return Err(format!("第 {} 个开孔的接口面无效", index + 1));
            }
            if !INTERFACE_OPENING_SHAPES.contains(&shape.as_str()) {
                return Err(format!("第 {} 个开孔的轮廓无效", index + 1));
            }
            let mut normalized_opening = Map::new();
            normalized_opening.insert("id".to_string(), json!(read_string("id", 80)?));
            normalized_opening.insert("label".to_string(), json!(read_string("label", 120)?));
            normalized_opening.insert(
                "source_type".to_string(),
                json!(read_string("sourceType", 80)?),
            );
            normalized_opening.insert("face".to_string(), json!(face));
            normalized_opening.insert("shape".to_string(), json!(shape));
            normalized_opening.insert(
                "width_mm".to_string(),
                json!(read_number("widthMm", 0.01, 1000.0)?),
            );
            normalized_opening.insert(
                "height_mm".to_string(),
                json!(read_number("heightMm", 0.01, 1000.0)?),
            );
            normalized_opening.insert(
                "center_u_mm".to_string(),
                json!(read_number("centerUMm", -1000.0, 1000.0)?),
            );
            normalized_opening.insert(
                "center_v_mm".to_string(),
                json!(read_number("centerVMm", -1000.0, 1000.0)?),
            );
            normalized_opening.insert(
                "corner_radius_mm".to_string(),
                json!(read_number("cornerRadiusMm", 0.0, 500.0)?),
            );
            normalized_opening.insert(
                "minimum_edge_margin_mm".to_string(),
                json!(read_number("minimumEdgeMarginMm", 0.0, 100.0)?),
            );
            normalized_opening.insert(
                "minimum_spacing_mm".to_string(),
                json!(read_number("minimumSpacingMm", 0.0, 100.0)?),
            );
            normalized_opening.insert(
                "source_confidence".to_string(),
                json!(read_number("sourceConfidence", 0.0, 1.0)?),
            );

            let position_fields = ["positionReference", "horizontalOffsetMm", "bottomOffsetMm"];
            if position_fields
                .iter()
                .any(|name| opening.contains_key(*name))
            {
                if position_fields
                    .iter()
                    .any(|name| !opening.contains_key(*name))
                {
                    return Err(format!("第 {} 个开孔的照片定位锚点不完整", index + 1));
                }
                let position_reference = read_string("positionReference", 40)?;
                if !INTERFACE_OPENING_POSITION_REFERENCES.contains(&position_reference.as_str()) {
                    return Err(format!("第 {} 个开孔的照片定位方式无效", index + 1));
                }
                normalized_opening
                    .insert("position_reference".to_string(), json!(position_reference));
                normalized_opening.insert(
                    "horizontal_offset_mm".to_string(),
                    json!(read_number("horizontalOffsetMm", -1000.0, 1000.0)?),
                );
                normalized_opening.insert(
                    "bottom_offset_mm".to_string(),
                    json!(read_number("bottomOffsetMm", -1000.0, 1000.0)?),
                );
            }
            normalized_openings.push(Value::Object(normalized_opening));
        }
        normalized.insert(
            "interface_openings".to_string(),
            Value::Array(normalized_openings),
        );
    }
    Ok(Value::Object(normalized))
}

fn generated_file_names(artifacts_dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = GENERATED_FILES
        .iter()
        .map(|value| (*value).to_string())
        .collect();
    for result_name in [
        "generation-result.json",
        "imported-model-result.json",
        "manufacturing-result.json",
        "wall-thickness-result.json",
        "local-stl-edit-result.json",
        "mesh-element-edit-result.json",
        "uploaded-model-restore-result.json",
        "local-cad-feature-result.json",
        "local-cad-feature-preflight-result.json",
        "version-difference-result.json",
    ] {
        let result_path = artifacts_dir.join(result_name);
        let Ok(contents) = fs::read_to_string(result_path) else {
            continue;
        };
        let Ok(result) = serde_json::from_str::<Value>(&contents) else {
            continue;
        };
        if let Some(outputs) = result.get("outputs").and_then(Value::as_array) {
            for file_name in outputs.iter().filter_map(Value::as_str) {
                let is_plain_file_name = Path::new(file_name)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value == file_name);
                if is_plain_file_name && !files.iter().any(|value| value == file_name) {
                    files.push(file_name.to_string());
                }
            }
        }
    }
    files
}

fn is_plain_file_name(file_name: &str) -> bool {
    Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value == file_name)
}

fn version_snapshot_generated_file_names(artifacts_dir: &Path) -> Result<Vec<String>, String> {
    let manifest_path = artifacts_dir.join("generation-result.json");
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("无法读取当前精确模型清单：{error}"))?;
    let manifest: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("当前精确模型清单格式错误：{error}"))?;
    let mut files = vec!["generation-result.json".to_string()];

    let mut add_declared_file = |file_name: &str, source: &str| -> Result<(), String> {
        if !is_plain_file_name(file_name) {
            return Err(format!(
                "当前精确模型清单中的{source}文件名无效：{file_name}"
            ));
        }
        if !files.iter().any(|value| value == file_name) {
            files.push(file_name.to_string());
        }
        Ok(())
    };

    let outputs = manifest
        .get("outputs")
        .and_then(Value::as_array)
        .ok_or_else(|| "当前精确模型清单缺少 outputs 文件列表".to_string())?;
    for file_name in outputs {
        let file_name = file_name
            .as_str()
            .ok_or_else(|| "当前精确模型清单 outputs 中存在非字符串文件名".to_string())?;
        add_declared_file(file_name, "输出")?;
    }

    let parts = manifest
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "当前精确模型清单缺少 parts 零件列表".to_string())?;
    for (index, part) in parts.iter().enumerate() {
        let part = part
            .as_object()
            .ok_or_else(|| format!("当前精确模型清单第 {} 个零件格式错误", index + 1))?;
        for (field, label) in [("stlFile", "STL"), ("stepFile", "STEP")] {
            if let Some(file_name) = part.get(field) {
                let file_name = file_name.as_str().ok_or_else(|| {
                    format!(
                        "当前精确模型清单第 {} 个零件的 {label} 文件名无效",
                        index + 1
                    )
                })?;
                add_declared_file(file_name, label)?;
            }
        }
    }

    if let Some(assembly_file) = manifest.get("assemblyFile") {
        let assembly_file = assembly_file
            .as_str()
            .ok_or_else(|| "当前精确模型清单的装配文件名无效".to_string())?;
        add_declared_file(assembly_file, "装配")?;
    }

    for file_name in &files {
        let source = artifacts_dir.join(file_name);
        if !source.is_file() {
            return Err(format!("当前精确模型清单声明的文件不存在：{file_name}"));
        }
    }
    Ok(files)
}

const UPLOADED_MODEL_SNAPSHOT_FILES: &[&str] = &[
    "imported-model.stl",
    "imported-model-working.stl",
    "imported-model-working.step",
];

fn read_uploaded_model_manifest_at(directory: &Path) -> Result<Value, String> {
    let manifest_path = fs::canonicalize(directory.join("imported-model-result.json"))
        .map_err(|error| format!("上传模型快照缺少模型清单：{error}"))?;
    if manifest_path.parent() != Some(directory) {
        return Err("上传模型快照清单不允许指向快照目录之外".into());
    }
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("上传模型快照清单无法读取：{error}"))?,
    )
    .map_err(|error| format!("上传模型快照清单格式错误：{error}"))?;
    if manifest.get("status").and_then(Value::as_str) != Some("ok")
        || manifest.get("sourceKind").and_then(Value::as_str) != Some("uploaded-stl")
        || manifest.get("id").and_then(Value::as_str) != Some("uploaded-model")
    {
        return Err("上传模型快照清单不是有效的上传 STL 结果".into());
    }
    Ok(manifest)
}

fn uploaded_model_snapshot_file_names(
    artifacts_dir: &Path,
    expected_revision: &str,
) -> Result<Vec<String>, String> {
    let manifest = read_uploaded_model_manifest_at(artifacts_dir)?;
    let revision = manifest
        .get("revision")
        .and_then(Value::as_str)
        .ok_or_else(|| "当前上传模型清单缺少修订号".to_string())?;
    if revision != expected_revision {
        return Err("当前上传模型修订号与待保存版本不一致，请重试".into());
    }
    if manifest.get("sourceFile").and_then(Value::as_str) != Some("imported-model-working.stl")
        || manifest.get("originalSourceFile").and_then(Value::as_str) != Some("imported-model.stl")
    {
        return Err("当前上传模型尚未形成标准工作 STL，请重新导入后再保存版本".into());
    }
    let outputs = manifest
        .get("outputs")
        .and_then(Value::as_array)
        .ok_or_else(|| "当前上传模型清单缺少输出文件列表".to_string())?;
    let output_names = outputs
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "当前上传模型输出列表包含无效文件名".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if output_names.len() != UPLOADED_MODEL_SNAPSHOT_FILES.len()
        || UPLOADED_MODEL_SNAPSHOT_FILES
            .iter()
            .any(|required| !output_names.contains(required))
    {
        return Err("当前上传模型快照必须完整包含原始 STL、工作 STL 和工作 STEP".into());
    }
    let mut files = vec!["imported-model-result.json".to_string()];
    for file_name in UPLOADED_MODEL_SNAPSHOT_FILES {
        let source = artifacts_dir.join(file_name);
        if !source.is_file() {
            return Err(format!("当前上传模型缺少快照文件：{file_name}"));
        }
        files.push((*file_name).to_string());
    }
    Ok(files)
}

fn read_version_snapshot_metadata_at(directory: &Path) -> Result<Value, String> {
    let metadata_path = fs::canonicalize(directory.join("version.json"))
        .map_err(|error| format!("版本快照缺少版本元数据：{error}"))?;
    if metadata_path.parent() != Some(directory) {
        return Err("版本快照元数据不允许指向快照目录之外".into());
    }
    serde_json::from_str(
        &fs::read_to_string(metadata_path)
            .map_err(|error| format!("版本快照元数据无法读取：{error}"))?,
    )
    .map_err(|error| format!("版本快照元数据格式错误：{error}"))
}

fn validate_uploaded_model_snapshot(
    directory: &Path,
    expected_revision: &str,
) -> Result<Value, String> {
    let metadata = read_version_snapshot_metadata_at(directory)?;
    if metadata.get("modelSource").and_then(Value::as_str) != Some("uploaded-stl") {
        return Err("所选版本不是上传 STL 精确快照".into());
    }
    if metadata.get("modelRevision").and_then(Value::as_str) != Some(expected_revision) {
        return Err("版本元数据与待恢复上传模型修订号不一致".into());
    }
    let manifest = read_uploaded_model_manifest_at(directory)?;
    if manifest.get("revision").and_then(Value::as_str) != Some(expected_revision) {
        return Err("版本记录与上传模型快照修订号不一致".into());
    }
    let outputs = manifest
        .get("outputs")
        .and_then(Value::as_array)
        .ok_or_else(|| "上传模型快照清单缺少输出文件列表".to_string())?;
    for required in UPLOADED_MODEL_SNAPSHOT_FILES {
        if !outputs.iter().any(|value| value.as_str() == Some(required)) {
            return Err(format!("上传模型快照清单缺少文件声明：{required}"));
        }
        let path = fs::canonicalize(directory.join(required))
            .map_err(|_| format!("上传模型快照缺少文件：{required}"))?;
        if path.parent() != Some(directory) || !path.is_file() {
            return Err(format!(
                "上传模型快照文件不允许指向快照目录之外：{required}"
            ));
        }
    }
    Ok(manifest)
}

fn validate_generated_file(file_name: &str, artifacts_dir: &Path) -> Result<(), String> {
    if is_plain_file_name(file_name)
        && generated_file_names(artifacts_dir)
            .iter()
            .any(|value| value == file_name)
    {
        Ok(())
    } else {
        Err(format!("不允许访问生成文件：{file_name}"))
    }
}

fn version_snapshot_directory(
    snapshot_directory: &str,
    artifacts_dir: &Path,
) -> Result<PathBuf, String> {
    let versions_root = artifacts_dir.join("versions");
    let canonical_root = fs::canonicalize(&versions_root)
        .map_err(|error| format!("无法读取版本快照目录：{error}"))?;
    let requested = Path::new(snapshot_directory);
    if !requested.is_absolute() {
        return Err("版本快照路径必须是本机绝对路径".into());
    }
    let canonical_directory =
        fs::canonicalize(requested).map_err(|error| format!("无法读取所选版本快照：{error}"))?;
    let is_direct_snapshot = canonical_directory
        .parent()
        .is_some_and(|parent| parent == canonical_root);
    if !is_direct_snapshot || !canonical_directory.is_dir() {
        return Err("不允许访问版本快照目录之外的路径".into());
    }
    Ok(canonical_directory)
}

fn read_version_snapshot_manifest_at(directory: &Path) -> Result<Value, String> {
    let manifest_path = fs::canonicalize(directory.join("generation-result.json"))
        .map_err(|error| format!("版本快照缺少精确模型清单：{error}"))?;
    if manifest_path.parent() != Some(directory) {
        return Err("版本快照模型清单不允许指向快照目录之外".into());
    }
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("版本快照缺少精确模型清单：{error}"))?;
    let manifest: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("版本快照模型清单格式错误：{error}"))?;
    if manifest.get("status").and_then(Value::as_str) != Some("ok") {
        return Err("版本快照模型清单不是有效的生成结果".into());
    }
    Ok(manifest)
}

fn snapshot_declares_file(manifest: &Value, file_name: &str) -> bool {
    let declared_output = manifest
        .get("outputs")
        .and_then(Value::as_array)
        .is_some_and(|outputs| {
            outputs
                .iter()
                .any(|value| value.as_str() == Some(file_name))
        });
    let declared_part = manifest
        .get("parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts.iter().any(|part| {
                ["stlFile", "stepFile"]
                    .iter()
                    .any(|field| part.get(field).and_then(Value::as_str) == Some(file_name))
            })
        });
    let declared_assembly = manifest.get("assemblyFile").and_then(Value::as_str) == Some(file_name);
    declared_output || declared_part || declared_assembly
}

fn validate_version_snapshot_stl_files(directory: &Path, manifest: &Value) -> Result<(), String> {
    let parts = manifest
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "版本快照模型清单缺少零件列表".to_string())?;
    if parts.is_empty() {
        return Err("版本快照模型清单没有可显示的零件".into());
    }
    for part in parts {
        let file_name = part
            .get("stlFile")
            .and_then(Value::as_str)
            .ok_or_else(|| "版本快照零件缺少 STL 文件声明".to_string())?;
        let is_plain_file_name = Path::new(file_name)
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == file_name);
        if !is_plain_file_name || !snapshot_declares_file(manifest, file_name) {
            return Err(format!("版本快照 STL 文件声明无效：{file_name}"));
        }
        if !directory.join(file_name).is_file() {
            return Err(format!("版本快照缺少零件 STL 文件：{file_name}"));
        }
    }
    Ok(())
}

fn validate_version_snapshot_step_files(directory: &Path, manifest: &Value) -> Result<(), String> {
    let parts = manifest
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "版本快照模型清单缺少零件列表".to_string())?;
    if parts.is_empty() {
        return Err("版本快照模型清单没有可比较的零件".into());
    }
    for part in parts {
        let file_name = part
            .get("stepFile")
            .and_then(Value::as_str)
            .ok_or_else(|| "版本快照零件缺少 STEP 文件声明".to_string())?;
        let is_plain_step_file = Path::new(file_name)
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == file_name)
            && matches!(
                Path::new(file_name)
                    .extension()
                    .and_then(|value| value.to_str()),
                Some("step" | "STEP" | "stp" | "STP")
            );
        if !is_plain_step_file || !snapshot_declares_file(manifest, file_name) {
            return Err(format!("版本快照 STEP 文件声明无效：{file_name}"));
        }
        let file_path = fs::canonicalize(directory.join(file_name))
            .map_err(|_| format!("版本快照缺少零件 STEP 文件：{file_name}"))?;
        if file_path.parent() != Some(directory) || !file_path.is_file() {
            return Err(format!(
                "版本快照 STEP 文件不允许指向快照目录之外：{file_name}"
            ));
        }
    }
    Ok(())
}

fn validate_version_difference_outputs(artifacts_dir: &Path, result: &Value) -> Result<(), String> {
    if result.get("status").and_then(Value::as_str) != Some("ok") {
        return Err("精确版本差异结果状态无效".into());
    }
    let outputs = result
        .get("outputs")
        .and_then(Value::as_array)
        .ok_or_else(|| "精确版本差异结果缺少输出清单".to_string())?;
    let canonical_artifacts = fs::canonicalize(artifacts_dir)
        .map_err(|error| format!("无法读取当前模型目录：{error}"))?;
    for output in outputs {
        let file_name = output
            .as_str()
            .ok_or_else(|| "精确版本差异输出文件名无效".to_string())?;
        let is_allowed_name = Path::new(file_name)
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == file_name)
            && file_name.starts_with("version-difference-")
            && file_name.ends_with(".stl");
        if !is_allowed_name {
            return Err(format!("精确版本差异输出文件名无效：{file_name}"));
        }
        let file_path = fs::canonicalize(artifacts_dir.join(file_name))
            .map_err(|_| format!("精确版本差异输出文件不存在：{file_name}"))?;
        if file_path.parent() != Some(canonical_artifacts.as_path()) || !file_path.is_file() {
            return Err(format!(
                "精确版本差异输出不允许指向模型目录之外：{file_name}"
            ));
        }
    }
    Ok(())
}

fn version_snapshot_file_path(
    snapshot_directory: &str,
    file_name: &str,
    artifacts_dir: &Path,
) -> Result<PathBuf, String> {
    let is_plain_file_name = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value == file_name);
    if !is_plain_file_name {
        return Err(format!("不允许访问版本快照文件：{file_name}"));
    }
    let directory = version_snapshot_directory(snapshot_directory, artifacts_dir)?;
    let manifest = read_version_snapshot_manifest_at(&directory)?;
    if !snapshot_declares_file(&manifest, file_name) {
        return Err(format!("版本快照清单未声明文件：{file_name}"));
    }
    let file_path = fs::canonicalize(directory.join(file_name))
        .map_err(|_| format!("版本快照文件不存在：{file_name}"))?;
    if file_path.parent() != Some(directory.as_path()) || !file_path.is_file() {
        return Err(format!("版本快照文件不允许指向快照目录之外：{file_name}"));
    }
    Ok(file_path)
}

/// Resolves a source part through the generation manifest instead of template-specific names.
fn generation_part_step_file(artifacts_dir: &Path, source_part_id: &str) -> Result<String, String> {
    if source_part_id.trim().is_empty() {
        return Err("请选择需要拆分的零件".into());
    }
    let manifest_path = artifacts_dir.join("generation-result.json");
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("无法读取模型清单：{error}"))?,
    )
    .map_err(|error| format!("模型清单格式错误：{error}"))?;
    let step_file = manifest
        .get("parts")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find(|part| part.get("id").and_then(Value::as_str) == Some(source_part_id))
        })
        .and_then(|part| part.get("stepFile"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("模型清单中没有找到零件：{source_part_id}"))?;
    let plain_name = Path::new(step_file)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == step_file)
        .ok_or_else(|| "模型清单中的 STEP 文件名无效".to_string())?;
    Ok(plain_name.to_string())
}

/// Resolves the current upload working STL through its manifest so edits remain cumulative.
fn imported_model_source_file(artifacts_dir: &Path) -> Result<String, String> {
    let manifest_path = artifacts_dir.join("imported-model-result.json");
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("无法读取上传模型清单：{error}"))?,
    )
    .map_err(|error| format!("上传模型清单格式错误：{error}"))?;
    let source_file = manifest
        .get("sourceFile")
        .and_then(Value::as_str)
        .ok_or_else(|| "上传模型清单缺少当前工作文件".to_string())?;
    let plain_name = Path::new(source_file)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == source_file)
        .ok_or_else(|| "上传模型工作文件名无效".to_string())?;
    if !artifacts_dir.join(plain_name).is_file() {
        return Err(format!(
            "没有找到上传模型工作文件 {plain_name}，请重新选择 STL 文件"
        ));
    }
    Ok(plain_name.to_string())
}

fn run_process_with_input(
    executable: &Path,
    arguments: &[String],
    current_dir: &Path,
    input: Option<&str>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(current_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {}：{error}", executable.display()))?;
    if let (Some(content), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin
            .write_all(content.as_bytes())
            .map_err(|error| format!("无法写入进程输入：{error}"))?;
    }
    child
        .wait_with_output()
        .map_err(|error| format!("进程执行失败：{error}"))
}

fn codex_version(paths: &BackendPaths) -> Option<String> {
    let executable = paths.codex_path.as_ref()?;
    let output = Command::new(executable).arg("--version").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn codex_authenticated(paths: &BackendPaths) -> bool {
    let Some(executable) = paths.codex_path.as_ref() else {
        return false;
    };
    Command::new(executable)
        .args(["login", "status"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn cad_runtime_available(paths: &BackendPaths) -> bool {
    paths.worker_path.is_file()
        && Command::new(&paths.python_path)
            .args(["-c", "import cadquery"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
}

#[tauri::command]
pub fn backend_status(state: tauri::State<'_, BackendState>) -> BackendStatus {
    BackendStatus {
        mode: "tauri",
        project_root: state.paths.project_root.display().to_string(),
        cad_worker_available: cad_runtime_available(&state.paths),
        codex_installed: state.paths.codex_path.is_some(),
        codex_authenticated: codex_authenticated(&state.paths),
        codex_version: codex_version(&state.paths),
    }
}

#[tauri::command]
pub async fn generate_cad(
    parameters: Value,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        fs::create_dir_all(&state.paths.artifacts_dir)
            .map_err(|error| format!("无法创建模型输出目录：{error}"))?;
        if !state.paths.worker_path.is_file() {
            return Err(format!(
                "未找到 CAD Worker：{}",
                state.paths.worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
        "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
        state.paths.python_path.display()
      ));
        }
        let runtime_parameters = state.paths.artifacts_dir.join(".runtime-parameters.json");
        fs::write(
            &runtime_parameters,
            serde_json::to_vec_pretty(&normalize_parameters(&parameters)?)
                .map_err(|error| format!("无法序列化模型参数：{error}"))?,
        )
        .map_err(|error| format!("无法写入模型参数：{error}"))?;

        let arguments = vec![
            state.paths.worker_path.display().to_string(),
            "--parameters".into(),
            runtime_parameters.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            None,
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("CAD Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state.paths.artifacts_dir.join("generation-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取 CAD 结果：{error}"))?;
        serde_json::from_str(&contents).map_err(|error| format!("CAD 结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("CAD 后台任务失败：{error}"))?
}

fn inspect_stl_as_imported_model(
    paths: &BackendPaths,
    original_file_name: String,
    file_bytes: Vec<u8>,
    branch_source: Option<Value>,
) -> Result<Value, String> {
    if !paths.split_worker_path.is_file() {
        return Err(format!(
            "未找到 STL 检查 Worker：{}",
            paths.split_worker_path.display()
        ));
    }
    if !cad_runtime_available(paths) {
        return Err(format!(
            "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
            paths.python_path.display()
        ));
    }
    fs::create_dir_all(&paths.artifacts_dir)
        .map_err(|error| format!("无法创建模型输出目录：{error}"))?;
    let source_path = paths.artifacts_dir.join("imported-model.stl");
    fs::write(&source_path, file_bytes).map_err(|error| format!("无法保存受管 STL：{error}"))?;
    let arguments = vec![
        paths.split_worker_path.display().to_string(),
        "--input".into(),
        source_path.display().to_string(),
        "--output".into(),
        paths.artifacts_dir.display().to_string(),
        "--stem".into(),
        "imported-model".into(),
        "--source-kind".into(),
        "uploaded-stl".into(),
        "--inspect-only".into(),
        "--original-file-name".into(),
        original_file_name,
    ];
    let output = run_process_with_input(&paths.python_path, &arguments, &paths.project_root, None)?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("STL 检查 Worker 退出，状态码：{}", output.status)
        } else {
            message
        });
    }
    let result_path = paths.artifacts_dir.join("imported-model-result.json");
    let contents = fs::read_to_string(&result_path)
        .map_err(|error| format!("无法读取 STL 导入结果：{error}"))?;
    let mut result: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("STL 导入结果格式错误：{error}"))?;
    if let Some(branch_source) = branch_source {
        let object = result
            .as_object_mut()
            .ok_or_else(|| "STL 导入结果必须是对象".to_string())?;
        object.insert("branchSource".into(), branch_source);
        fs::write(
            &result_path,
            serde_json::to_vec_pretty(&result)
                .map_err(|error| format!("无法序列化网格分支清单：{error}"))?,
        )
        .map_err(|error| format!("无法写入网格分支清单：{error}"))?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn import_stl_model(
    file_name: String,
    file_bytes: Vec<u8>,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let original_file_name = Path::new(&file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.to_ascii_lowercase().ends_with(".stl"))
        .ok_or_else(|| "请选择 STL 文件".to_string())?
        .to_string();
    if file_bytes.is_empty() {
        return Err("上传的 STL 文件为空".into());
    }
    if file_bytes.len() > 50 * 1024 * 1024 {
        return Err("STL 文件不能超过 50 MB".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        inspect_stl_as_imported_model(&state.paths, original_file_name, file_bytes, None)
    })
    .await
    .map_err(|error| format!("STL 导入后台任务失败：{error}"))?
}

/** 从当前 CAD 清单解析任意零件的安全 STL 来源，拒绝旧修订和路径穿越。 */
fn resolve_cad_mesh_branch_source(
    manifest: &Value,
    cad_revision: &str,
    source_part_id: &str,
) -> Result<(String, String), String> {
    if manifest.get("revision").and_then(Value::as_str) != Some(cad_revision) {
        return Err("精确 CAD 已在选择后发生变化，请重新选择零件".into());
    }
    let part = manifest
        .get("parts")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find(|part| part.get("id").and_then(Value::as_str) == Some(source_part_id))
        })
        .ok_or_else(|| format!("模型清单中没有找到零件：{source_part_id}"))?;
    let part_label = part
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(source_part_id)
        .to_string();
    let stl_file = part
        .get("stlFile")
        .and_then(Value::as_str)
        .filter(|value| is_plain_file_name(value))
        .ok_or_else(|| "模型清单中的 CAD 零件 STL 文件名无效".to_string())?
        .to_string();
    Ok((part_label, stl_file))
}

#[tauri::command]
pub async fn create_cad_mesh_branch(
    cad_revision: String,
    source_part_id: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    if cad_revision.trim().is_empty() || cad_revision.chars().count() > 200 {
        return Err("CAD 修订号无效，请先重新生成精确模型".into());
    }
    if source_part_id.trim().is_empty() || source_part_id.chars().count() > 200 {
        return Err("请选择要转换为网格分支的 CAD 零件".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        let manifest_path = state.paths.artifacts_dir.join("generation-result.json");
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(&manifest_path)
                .map_err(|error| format!("无法读取当前精确模型清单：{error}"))?,
        )
        .map_err(|error| format!("当前精确模型清单格式错误：{error}"))?;
        let (part_label, stl_file) =
            resolve_cad_mesh_branch_source(&manifest, &cad_revision, &source_part_id)?;
        let source_path = state.paths.artifacts_dir.join(&stl_file);
        let file_bytes =
            fs::read(&source_path).map_err(|error| format!("无法读取 CAD 零件 STL：{error}"))?;
        if file_bytes.is_empty() {
            return Err("CAD 零件 STL 文件为空".into());
        }
        if file_bytes.len() > 50 * 1024 * 1024 {
            return Err("CAD 零件 STL 不能超过 50 MB".into());
        }
        inspect_stl_as_imported_model(
            &state.paths,
            format!("{part_label}-网格分支.stl"),
            file_bytes,
            Some(json!({
                "kind": "cad-part",
                "cadRevision": cad_revision,
                "partId": source_part_id,
                "partLabel": part_label,
                "sourceStlFile": stl_file
            })),
        )
    })
    .await
    .map_err(|error| format!("CAD 网格分支后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn run_manufacturing_split(
    source_kind: String,
    source_part_id: String,
    axis: String,
    offset_mm: f64,
    joint_type: String,
    fastener_type: String,
    screw_size: String,
    clearance_mm: f64,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        let source_file = match source_kind.as_str() {
            "cad-part" => generation_part_step_file(
                &state.paths.artifacts_dir,
                &source_part_id,
            )?,
            "uploaded-stl" => {
                if source_part_id != "uploaded-model" {
                    return Err("上传 STL 的来源标识无效".to_string());
                }
                imported_model_source_file(&state.paths.artifacts_dir)?
            }
            _ => return Err("拆件来源类型无效".to_string()),
        };
        if !matches!(axis.as_str(), "x" | "y" | "z") {
            return Err("拆件轴只能是 X、Y 或 Z".to_string());
        }
        if !offset_mm.is_finite() {
            return Err("拆件平面偏移必须是有限毫米数值".to_string());
        }
        if !matches!(
            joint_type.as_str(),
            "round-pin" | "d-pin" | "dovetail" | "ball-socket" | "magnet"
        ) {
            return Err("连接结构类型无效".to_string());
        }
        if !matches!(
            fastener_type.as_str(),
            "screw-boss"
                | "snap-fit"
                | "threaded-hole"
                | "external-thread"
                | "iso-threaded-hole"
                | "iso-external-thread"
        ) {
            return Err(
                "精确紧固结构只能选择螺丝柱、可拆卡扣、打印友好近似螺纹或 ISO 60° 螺纹"
                    .to_string(),
            );
        }
        if !matches!(screw_size.as_str(), "M2" | "M2.5" | "M3") {
            return Err("螺丝规格只能是 M2、M2.5 或 M3".to_string());
        }
        if !clearance_mm.is_finite() || !(0.1..=1.0).contains(&clearance_mm) {
            return Err("公母间隙必须在 0.10 至 1.00 毫米之间".to_string());
        }
        if !state.paths.split_worker_path.is_file() {
            return Err(format!(
                "未找到拆件 Worker：{}",
                state.paths.split_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        let source_path = state.paths.artifacts_dir.join(&source_file);
        if !source_path.is_file() {
            return Err(if source_kind == "uploaded-stl" {
                "没有找到上传模型，请先选择 STL 文件".to_string()
            } else {
                format!("没有找到精确模型 {source_file}，请先重建 CAD")
            });
        }
        fs::create_dir_all(&state.paths.artifacts_dir)
            .map_err(|error| format!("无法创建模型输出目录：{error}"))?;

        let arguments = vec![
            state.paths.split_worker_path.display().to_string(),
            "--input".into(),
            source_path.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
            "--axis".into(),
            axis,
            "--offset".into(),
            offset_mm.to_string(),
            "--stem".into(),
            "manufacturing".into(),
            "--source-kind".into(),
            source_kind,
            "--source-part-id".into(),
            source_part_id,
            "--joint-type".into(),
            joint_type,
            "--fastener-type".into(),
            fastener_type,
            "--screw-size".into(),
            screw_size,
            "--clearance".into(),
            clearance_mm.to_string(),
            "--apply-features".into(),
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            None,
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("拆件 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state.paths.artifacts_dir.join("manufacturing-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取拆件结果：{error}"))?;
        serde_json::from_str(&contents).map_err(|error| format!("拆件结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("拆件后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn run_local_stl_edit(
    source_part_id: String,
    operation: String,
    center_xmm: f64,
    center_ymm: f64,
    center_zmm: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    radius_mm: f64,
    depth_mm: f64,
    command: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        if source_part_id != "uploaded-model" {
            return Err("上传 STL 的来源标识无效".to_string());
        }
        if !matches!(operation.as_str(), "add-cylinder" | "cut-cylinder") {
            return Err("局部 STL 修改操作无效".to_string());
        }
        if ![center_xmm, center_ymm, center_zmm, normal_x, normal_y, normal_z, radius_mm, depth_mm]
            .iter()
            .all(|value| value.is_finite())
        {
            return Err("局部 STL 修改坐标、法向和尺寸必须是有限数值".to_string());
        }
        if command.chars().count() > 2_000 {
            return Err("局部修改指令过长，请控制在 2000 字以内".to_string());
        }
        if !state.paths.local_stl_edit_worker_path.is_file() {
            return Err(format!(
                "未找到局部 STL 修改 Worker：{}",
                state.paths.local_stl_edit_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        let source_file = imported_model_source_file(&state.paths.artifacts_dir)?;
        let source_path = state.paths.artifacts_dir.join(source_file);
        let arguments = vec![
            state.paths.local_stl_edit_worker_path.display().to_string(),
            "--input".into(),
            source_path.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
            "--operation".into(),
            operation,
            "--center-x".into(),
            center_xmm.to_string(),
            "--center-y".into(),
            center_ymm.to_string(),
            "--center-z".into(),
            center_zmm.to_string(),
            "--normal-x".into(),
            normal_x.to_string(),
            "--normal-y".into(),
            normal_y.to_string(),
            "--normal-z".into(),
            normal_z.to_string(),
            "--radius".into(),
            radius_mm.to_string(),
            "--depth".into(),
            depth_mm.to_string(),
            "--command".into(),
            command,
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            None,
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("局部 STL 修改 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state.paths.artifacts_dir.join("local-stl-edit-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取局部 STL 修改结果：{error}"))?;
        serde_json::from_str(&contents)
            .map_err(|error| format!("局部 STL 修改结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("局部 STL 修改后台任务失败：{error}"))?
}

fn validate_mesh_element_selections(
    element_kind: &str,
    selection_method: &str,
    selections: &[Value],
) -> Result<String, String> {
    if !matches!(element_kind, "vertex" | "edge" | "face") {
        return Err("网格元素类型只能是顶点、边或面".into());
    }
    if !matches!(selection_method, "click" | "box") {
        return Err("网格元素选择方式只能是点击或框选".into());
    }
    if selections.is_empty() || selections.len() > 512 {
        return Err("单次必须选择 1 至 512 个同类网格元素".into());
    }
    for selection in selections {
        let object = selection
            .as_object()
            .ok_or_else(|| "网格元素选择格式无效".to_string())?;
        if object.len() != 3
            || !["triangleIndex", "elementIndex", "triangleMm"]
                .iter()
                .all(|field| object.contains_key(*field))
        {
            return Err("网格元素选择包含缺失或不允许的字段".into());
        }
        let triangle_index = object
            .get("triangleIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "三角面索引无效，请重新选择".to_string())?;
        if triangle_index > 5_000_000 {
            return Err("三角面索引超过安全上限".into());
        }
        let element_index = object
            .get("elementIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "网格元素索引无效，请重新选择".to_string())?;
        if element_index > 2 || (element_kind == "face" && element_index != 0) {
            return Err("网格元素索引与编辑类型不匹配".into());
        }
        let triangle = object
            .get("triangleMm")
            .and_then(Value::as_array)
            .filter(|triangle| triangle.len() == 3)
            .ok_or_else(|| "网格元素源三角面坐标无效".to_string())?;
        for point in triangle {
            let coordinates = point
                .as_object()
                .filter(|point| {
                    point.len() == 3 && ["x", "y", "z"].iter().all(|axis| point.contains_key(*axis))
                })
                .ok_or_else(|| "网格元素源坐标格式无效".to_string())?;
            for axis in ["x", "y", "z"] {
                let coordinate = coordinates
                    .get(axis)
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "网格元素源坐标必须是有限毫米数值".to_string())?;
                if !coordinate.is_finite() || coordinate.abs() > 1_000_000.0 {
                    return Err("网格元素源坐标超出安全范围".into());
                }
            }
        }
    }
    serde_json::to_string(selections).map_err(|error| format!("无法序列化网格元素选择：{error}"))
}

/// 校验单三角面法向编辑的选择约束、方向模式和毫米距离。
fn validate_mesh_face_extrusion(
    element_kind: &str,
    selection_method: &str,
    selection_count: usize,
    face_extrusion_mode: Option<String>,
    distance_mm: Option<f64>,
) -> Result<(String, f64), String> {
    if element_kind != "face" || selection_method != "click" || selection_count != 1 {
        return Err("三角面法向编辑第一版必须且只能点击选择一个三角面".into());
    }
    let mode = face_extrusion_mode.unwrap_or_default();
    if !matches!(mode.as_str(), "add" | "cut") {
        return Err("三角面法向编辑只能选择向外加料或向内压入".into());
    }
    let distance = distance_mm.unwrap_or(0.0);
    if !distance.is_finite() || !(0.2..=100.0).contains(&distance) {
        return Err("三角面法向距离必须在 0.20 至 100.00 毫米之间".into());
    }
    Ok((mode, distance))
}

#[derive(Debug, PartialEq)]
struct MeshElementTransformParameters {
    displacement: [f64; 3],
    rotation_axis: String,
    rotation_degrees: f64,
    scale_factor: f64,
}

/// 统一校验网格元素变换参数，并生成传递给 Python Worker 的完整参数集合。
fn validate_mesh_element_transform(
    operation: &str,
    delta_xmm: Option<f64>,
    delta_ymm: Option<f64>,
    delta_zmm: Option<f64>,
    rotation_axis: Option<String>,
    rotation_degrees: Option<f64>,
    scale_factor: Option<f64>,
) -> Result<MeshElementTransformParameters, String> {
    let displacement = [
        delta_xmm.unwrap_or(0.0),
        delta_ymm.unwrap_or(0.0),
        delta_zmm.unwrap_or(0.0),
    ];
    let rotation_axis = rotation_axis.unwrap_or_default();
    let rotation_degrees = rotation_degrees.unwrap_or(0.0);
    let scale_factor = scale_factor.unwrap_or(1.0);
    match operation {
        "move" => {
            if !displacement
                .iter()
                .all(|value| value.is_finite() && value.abs() <= 500.0)
            {
                return Err("网格元素每轴位移必须是 -500 至 500 毫米的有限数值".to_string());
            }
            if displacement.iter().all(|value| value.abs() < 1e-9) {
                return Err("请至少输入一个非零位移".to_string());
            }
        }
        "rotate" => {
            if !matches!(rotation_axis.as_str(), "x" | "y" | "z") {
                return Err("旋转轴只能是源模型 X、Y 或 Z 轴".to_string());
            }
            if !rotation_degrees.is_finite()
                || rotation_degrees.abs() > 180.0
                || rotation_degrees.abs() < 1e-9
            {
                return Err("旋转角度必须是 -180° 至 180° 之间的非零有限数值".to_string());
            }
        }
        "scale" => {
            if !scale_factor.is_finite()
                || !(0.25..=4.0).contains(&scale_factor)
                || (scale_factor - 1.0).abs() < 1e-9
            {
                return Err("缩放比例必须在 0.25 至 4 倍之间，且不能等于 1".to_string());
            }
        }
        _ => return Err("网格元素操作只能是位移、旋转或缩放".to_string()),
    }
    Ok(MeshElementTransformParameters {
        displacement,
        rotation_axis: if rotation_axis.is_empty() {
            "z".to_string()
        } else {
            rotation_axis
        },
        rotation_degrees,
        scale_factor,
    })
}

#[tauri::command]
pub async fn run_mesh_element_edit(
    source_part_id: String,
    selection_revision: String,
    element_kind: String,
    selection_method: String,
    selections: Vec<Value>,
    operation: String,
    delta_xmm: Option<f64>,
    delta_ymm: Option<f64>,
    delta_zmm: Option<f64>,
    rotation_axis: Option<String>,
    rotation_degrees: Option<f64>,
    scale_factor: Option<f64>,
    face_extrusion_mode: Option<String>,
    distance_mm: Option<f64>,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        if source_part_id != "uploaded-model" {
            return Err("网格元素编辑只允许当前上传模型".to_string());
        }
        if selection_revision.trim().is_empty() || selection_revision.chars().count() > 200 {
            return Err("网格元素选择修订号无效，请重新选择".to_string());
        }
        let selections_json =
            validate_mesh_element_selections(&element_kind, &selection_method, &selections)?;
        let (transform, face_extrusion) = if operation == "extrude-face" {
            let extrusion = validate_mesh_face_extrusion(
                &element_kind,
                &selection_method,
                selections.len(),
                face_extrusion_mode,
                distance_mm,
            )?;
            (
                MeshElementTransformParameters {
                    displacement: [0.0, 0.0, 0.0],
                    rotation_axis: "z".into(),
                    rotation_degrees: 0.0,
                    scale_factor: 1.0,
                },
                extrusion,
            )
        } else {
            (
                validate_mesh_element_transform(
                    &operation,
                    delta_xmm,
                    delta_ymm,
                    delta_zmm,
                    rotation_axis,
                    rotation_degrees,
                    scale_factor,
                )?,
                ("add".into(), 0.0),
            )
        };
        if !state.paths.mesh_element_edit_worker_path.is_file() {
            return Err(format!(
                "未找到网格元素编辑 Worker：{}",
                state.paths.mesh_element_edit_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        let source_file = imported_model_source_file(&state.paths.artifacts_dir)?;
        let source_path = state.paths.artifacts_dir.join(source_file);
        let arguments = vec![
            state.paths.mesh_element_edit_worker_path.display().to_string(),
            "--input".into(),
            source_path.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
            "--selection-revision".into(),
            selection_revision,
            "--kind".into(),
            element_kind,
            "--selection-method".into(),
            selection_method,
            "--operation".into(),
            operation,
            "--selections-stdin".into(),
            "--delta-x".into(),
            transform.displacement[0].to_string(),
            "--delta-y".into(),
            transform.displacement[1].to_string(),
            "--delta-z".into(),
            transform.displacement[2].to_string(),
            "--rotation-axis".into(),
            transform.rotation_axis,
            "--rotation-degrees".into(),
            transform.rotation_degrees.to_string(),
            "--scale-factor".into(),
            transform.scale_factor.to_string(),
            "--face-extrusion-mode".into(),
            face_extrusion.0,
            "--distance".into(),
            face_extrusion.1.to_string(),
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            Some(&selections_json),
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("网格元素编辑 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state.paths.artifacts_dir.join("mesh-element-edit-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取网格元素编辑结果：{error}"))?;
        serde_json::from_str(&contents)
            .map_err(|error| format!("网格元素编辑结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("网格元素编辑后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn restore_uploaded_model_snapshot(
    snapshot_directory: String,
    expected_revision: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "上传模型恢复锁已损坏".to_string())?;
        let expected_revision = expected_revision.trim();
        if expected_revision.is_empty() || expected_revision.chars().count() > 200 {
            return Err("待恢复上传模型修订号无效".to_string());
        }
        let directory = version_snapshot_directory(
            &snapshot_directory,
            &state.paths.artifacts_dir,
        )?;
        validate_uploaded_model_snapshot(&directory, expected_revision)?;
        if !state.paths.uploaded_model_restore_worker_path.is_file() {
            return Err(format!(
                "未找到上传模型快照恢复 Worker：{}",
                state.paths.uploaded_model_restore_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        fs::create_dir_all(&state.paths.artifacts_dir)
            .map_err(|error| format!("无法创建模型输出目录：{error}"))?;
        let arguments = vec![
            state
                .paths
                .uploaded_model_restore_worker_path
                .display()
                .to_string(),
            "--snapshot".into(),
            directory.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
            "--expected-revision".into(),
            expected_revision.to_string(),
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            None,
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("上传模型快照恢复 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state
            .paths
            .artifacts_dir
            .join("uploaded-model-restore-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取上传模型恢复结果：{error}"))?;
        let result: Value = serde_json::from_str(&contents)
            .map_err(|error| format!("上传模型恢复结果格式错误：{error}"))?;
        if result.get("status").and_then(Value::as_str) != Some("ok") {
            return Err("上传模型恢复结果未通过校验".to_string());
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("上传模型快照恢复后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn run_local_cad_feature(
    selection_revision: String,
    part_id: String,
    stable_face_id: String,
    stable_edge_id: Option<String>,
    edge_targets: Vec<Value>,
    operation: String,
    center_xmm: f64,
    center_ymm: f64,
    center_zmm: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    surface_geometry_type: String,
    surface_u: f64,
    surface_v: f64,
    surface_tangent_ux: Option<f64>,
    surface_tangent_uy: Option<f64>,
    surface_tangent_uz: Option<f64>,
    radius_mm: Option<f64>,
    width_mm: Option<f64>,
    height_mm: Option<f64>,
    length_mm: Option<f64>,
    depth_mm: f64,
    rotation_deg: f64,
    command: String,
    preview_only: bool,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state.generation_lock.lock().map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        if !matches!(operation.as_str(), "add-cylinder" | "cut-cylinder" | "add-rectangle" | "cut-rectangle" | "cut-slot" | "offset-face-outward" | "offset-face-inward" | "fillet-edge" | "chamfer-edge" | "fillet-edge-loop" | "chamfer-edge-loop" | "fillet-edge-chain" | "chamfer-edge-chain" | "fillet-edge-manual-chain" | "chamfer-edge-manual-chain") {
            return Err("稳定 CAD 局部特征操作无效".to_string());
        }
        if selection_revision.is_empty() || selection_revision.chars().count() > 200
            || part_id.is_empty() || part_id.chars().count() > 200
            || stable_face_id.is_empty() || stable_face_id.chars().count() > 200 {
            return Err("稳定 CAD 面选择标识无效，请重新选择目标面".to_string());
        }
        if surface_geometry_type.trim().is_empty() || surface_geometry_type.chars().count() > 100 {
            return Err("稳定 CAD 面曲面类型无效，请重新选择目标面".to_string());
        }
        if ![center_xmm, center_ymm, center_zmm, normal_x, normal_y, normal_z, surface_u, surface_v, depth_mm, rotation_deg]
            .iter().all(|value| value.is_finite())
            || [radius_mm, width_mm, height_mm, length_mm].iter().flatten().any(|value| !value.is_finite()) {
            return Err("稳定 CAD 面局部特征坐标、法向和尺寸必须是有限数值".to_string());
        }
        let surface_tangent_u = match (surface_tangent_ux, surface_tangent_uy, surface_tangent_uz) {
            (Some(x), Some(y), Some(z)) if [x, y, z].iter().all(|value| value.is_finite()) => Some((x, y, z)),
            (None, None, None) => None,
            _ => return Err("曲面 U 切向必须同时提供三个有限分量，或全部留空".to_string()),
        };
        if !(0.2..=200.0).contains(&depth_mm) || !(-180.0..=180.0).contains(&rotation_deg) {
            return Err("稳定 CAD 面局部特征深度或旋转角超出安全范围".to_string());
        }
        let cylinder = matches!(operation.as_str(), "add-cylinder" | "cut-cylinder");
        let slot = operation == "cut-slot";
        let rectangle = matches!(operation.as_str(), "add-rectangle" | "cut-rectangle");
        let whole_face = matches!(operation.as_str(), "offset-face-outward" | "offset-face-inward");
        let manual_edge_chain = matches!(operation.as_str(), "fillet-edge-manual-chain" | "chamfer-edge-manual-chain");
        let edge_feature = manual_edge_chain || matches!(operation.as_str(), "fillet-edge" | "chamfer-edge" | "fillet-edge-loop" | "chamfer-edge-loop" | "fillet-edge-chain" | "chamfer-edge-chain");
        let edge_loop_feature = matches!(operation.as_str(), "fillet-edge-loop" | "chamfer-edge-loop");
        let curved_face = surface_geometry_type != "PLANE";
        if preview_only && !curved_face {
            return Err("OpenCascade 精确工具体预演第一版只用于非平面曲面局部特征".into());
        }
        if curved_face && !cylinder && !rectangle && !slot && !edge_feature {
            return Err("当前选中的是非平面曲面；当前曲面局部特征只支持圆形凸台、圆孔、矩形凸台、矩形孔、受限槽孔，或对所选稳定边执行单边或切线连续边链圆角与倒角".into());
        }
        if curved_face && edge_loop_feature {
            return Err("整圈边圆角或倒角第一版只支持平面边界，请重新选择平面所属边".into());
        }
        if curved_face && (rectangle || slot) {
            let (x, y, z) = surface_tangent_u.ok_or_else(|| {
                "曲面方向轮廓缺少有效的 OpenCascade 真实 U 切向，请重新点击目标面".to_string()
            })?;
            if (x * x + y * y + z * z).sqrt() < 0.5 {
                return Err("曲面方向轮廓的 OpenCascade 真实 U 切向已退化，请重新点击目标面".to_string());
            }
        }
        if manual_edge_chain {
            if stable_edge_id.is_some() || !(2..=64).contains(&edge_targets.len()) {
                return Err("手工多选边链必须携带 2 至 64 条逐边目标，且不能携带单一种子边 ID".into());
            }
            let mut keys = std::collections::HashSet::new();
            for (index, target) in edge_targets.iter().enumerate() {
                let object = target.as_object().ok_or_else(|| format!("手工边链第 {} 条目标格式无效", index + 1))?;
                let face_id = object.get("stableFaceId").and_then(Value::as_str).map(str::trim)
                    .filter(|value| !value.is_empty() && value.chars().count() <= 200)
                    .ok_or_else(|| format!("手工边链第 {} 条目标缺少稳定面 ID", index + 1))?;
                let edge_id = object.get("stableEdgeId").and_then(Value::as_str).map(str::trim)
                    .filter(|value| !value.is_empty() && value.chars().count() <= 200)
                    .ok_or_else(|| format!("手工边链第 {} 条目标缺少稳定边 ID", index + 1))?;
                let center = object.get("center").and_then(Value::as_object)
                    .ok_or_else(|| format!("手工边链第 {} 条目标缺少点击坐标", index + 1))?;
                let normal = object.get("hitNormal").and_then(Value::as_object)
                    .ok_or_else(|| format!("手工边链第 {} 条目标缺少点击法线", index + 1))?;
                let uv = object.get("surfaceUv").and_then(Value::as_object)
                    .ok_or_else(|| format!("手工边链第 {} 条目标缺少真实 UV", index + 1))?;
                let values = [
                    center.get("xMm").and_then(Value::as_f64), center.get("yMm").and_then(Value::as_f64), center.get("zMm").and_then(Value::as_f64),
                    normal.get("x").and_then(Value::as_f64), normal.get("y").and_then(Value::as_f64), normal.get("z").and_then(Value::as_f64),
                    uv.get("u").and_then(Value::as_f64), uv.get("v").and_then(Value::as_f64),
                ];
                if values.iter().any(|value| value.is_none_or(|number| !number.is_finite())) {
                    return Err(format!("手工边链第 {} 条目标包含无效坐标、法线或 UV", index + 1));
                }
                let geometry_type = object.get("surfaceGeometryType").and_then(Value::as_str).map(str::trim)
                    .filter(|value| !value.is_empty() && value.chars().count() <= 100)
                    .ok_or_else(|| format!("手工边链第 {} 条目标缺少曲面类型", index + 1))?;
                if !keys.insert((face_id.to_string(), edge_id.to_string())) {
                    return Err("手工多选边链包含重复稳定边".into());
                }
                let _ = geometry_type;
            }
        } else if !edge_targets.is_empty() {
            return Err("非手工边链操作不能携带逐边目标列表".into());
        }
        if edge_feature && !manual_edge_chain {
            if stable_edge_id.as_deref().is_none_or(|value| value.is_empty() || value.chars().count() > 200)
                || depth_mm > 50.0 || radius_mm.is_some() || width_mm.is_some() || height_mm.is_some()
                || length_mm.is_some() || rotation_deg.abs() > 1e-9 {
                return Err("圆角或倒角选择标识或尺寸字段不符合安全协议".to_string());
            }
        } else if stable_edge_id.is_some() {
            return Err("平面局部特征不能携带稳定边 ID".to_string());
        } else if whole_face {
            if radius_mm.is_some() || width_mm.is_some() || height_mm.is_some() || length_mm.is_some()
                || rotation_deg.abs() > 1e-9 {
                return Err("整面拉伸或偏移尺寸字段不符合安全协议".to_string());
            }
        } else if cylinder {
            if radius_mm.is_none_or(|value| !(0.5..=100.0).contains(&value))
                || width_mm.is_some() || height_mm.is_some() || length_mm.is_some() || rotation_deg.abs() > 1e-9 {
                return Err("圆柱局部特征尺寸字段不符合安全协议".to_string());
            }
        } else {
            let width = width_mm.ok_or_else(|| "矩形或槽孔局部特征缺少宽度".to_string())?;
            if radius_mm.is_some() || !(0.5..=200.0).contains(&width) {
                return Err("矩形或槽孔局部特征尺寸字段不符合安全协议".to_string());
            }
            if operation == "cut-slot" {
                if height_mm.is_some() || length_mm.is_none_or(|value| !(1.0..=200.0).contains(&value) || value < width) {
                    return Err("槽孔尺寸字段不符合安全协议".to_string());
                }
            } else if length_mm.is_some() || height_mm.is_none_or(|value| !(0.5..=200.0).contains(&value)) {
                return Err("矩形尺寸字段不符合安全协议".to_string());
            }
        }
        if command.chars().count() > 2_000 {
            return Err("局部特征指令过长，请控制在 2000 字以内".to_string());
        }
        if !state.paths.local_cad_feature_worker_path.is_file() {
            return Err(format!("未找到稳定 CAD 面局部特征 Worker：{}", state.paths.local_cad_feature_worker_path.display()));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!("CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。", state.paths.python_path.display()));
        }
        let mut arguments = vec![
            state.paths.local_cad_feature_worker_path.display().to_string(), "--output".into(),
            state.paths.artifacts_dir.display().to_string(), "--operation".into(), operation,
            "--selection-revision".into(), selection_revision, "--part-id".into(), part_id,
            "--stable-face-id".into(), stable_face_id, "--center-x".into(), center_xmm.to_string(),
            "--center-y".into(), center_ymm.to_string(), "--center-z".into(), center_zmm.to_string(),
            "--normal-x".into(), normal_x.to_string(), "--normal-y".into(), normal_y.to_string(),
            "--normal-z".into(), normal_z.to_string(), "--surface-geometry-type".into(), surface_geometry_type,
            "--surface-u".into(), surface_u.to_string(), "--surface-v".into(), surface_v.to_string(),
            "--depth".into(), depth_mm.to_string(),
            "--rotation".into(), rotation_deg.to_string(), "--command".into(), command,
        ];
        if let Some(stable_edge_id) = stable_edge_id {
            arguments.extend(["--stable-edge-id".into(), stable_edge_id]);
        }
        if manual_edge_chain {
            arguments.extend([
                "--edge-targets-json".into(),
                serde_json::to_string(&edge_targets).map_err(|error| format!("无法序列化手工边链目标：{error}"))?,
            ]);
        }
        if let Some((x, y, z)) = surface_tangent_u {
            arguments.extend([
                "--surface-tangent-u-x".into(), x.to_string(),
                "--surface-tangent-u-y".into(), y.to_string(),
                "--surface-tangent-u-z".into(), z.to_string(),
            ]);
        }
        for (flag, value) in [("--radius", radius_mm), ("--width", width_mm), ("--height", height_mm), ("--length", length_mm)] {
            if let Some(value) = value { arguments.push(flag.into()); arguments.push(value.to_string()); }
        }
        if preview_only {
            arguments.push("--preview-only".into());
        }
        let output = run_process_with_input(&state.paths.python_path, &arguments, &state.paths.project_root, None)?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() { format!("稳定 CAD 面局部特征 Worker 退出，状态码：{}", output.status) } else { message });
        }
        let result_name = if preview_only {
            "local-cad-feature-preflight-result.json"
        } else {
            "local-cad-feature-result.json"
        };
        let result_path = state.paths.artifacts_dir.join(result_name);
        let contents = fs::read_to_string(&result_path).map_err(|error| format!("无法读取稳定 CAD 面局部特征结果：{error}"))?;
        serde_json::from_str(&contents).map_err(|error| format!("稳定 CAD 面局部特征结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("稳定 CAD 面局部特征后台任务失败：{error}"))?
}

fn validate_cad_surface_hit_request(
    selection_revision: &str,
    part_id: &str,
    stable_face_id: &str,
    triangle_index: i64,
    point_and_normal: &[f64; 6],
) -> Result<(), String> {
    if [selection_revision, part_id, stable_face_id]
        .iter()
        .any(|value| value.trim().is_empty() || value.chars().count() > 200)
    {
        return Err("曲面点击选择标识无效，请重新点击目标面".to_string());
    }
    if triangle_index < 0 {
        return Err("曲面点击三角面索引无效，请重新点击目标面".to_string());
    }
    if !point_and_normal.iter().all(|value| value.is_finite()) {
        return Err("曲面点击坐标和选择网格法线必须是有限数值".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn resolve_cad_surface_hit(
    selection_revision: String,
    part_id: String,
    stable_face_id: String,
    triangle_index: i64,
    point_x: f64,
    point_y: f64,
    point_z: f64,
    normal_x: f64,
    normal_y: f64,
    normal_z: f64,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state.generation_lock.lock().map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        validate_cad_surface_hit_request(
            &selection_revision,
            &part_id,
            &stable_face_id,
            triangle_index,
            &[point_x, point_y, point_z, normal_x, normal_y, normal_z],
        )?;
        if !state.paths.cad_surface_hit_worker_path.is_file() {
            return Err(format!(
                "未找到 OpenCascade 曲面点击解析 Worker：{}",
                state.paths.cad_surface_hit_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        let arguments = vec![
            state.paths.cad_surface_hit_worker_path.display().to_string(),
            "--output".into(), state.paths.artifacts_dir.display().to_string(),
            "--selection-revision".into(), selection_revision.trim().to_string(),
            "--part-id".into(), part_id.trim().to_string(),
            "--stable-face-id".into(), stable_face_id.trim().to_string(),
            "--triangle-index".into(), triangle_index.to_string(),
            "--point-x".into(), point_x.to_string(),
            "--point-y".into(), point_y.to_string(),
            "--point-z".into(), point_z.to_string(),
            "--normal-x".into(), normal_x.to_string(),
            "--normal-y".into(), normal_y.to_string(),
            "--normal-z".into(), normal_z.to_string(),
        ];
        let output = run_process_with_input(&state.paths.python_path, &arguments, &state.paths.project_root, None)?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("OpenCascade 曲面点击解析 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let stdout = String::from_utf8(output.stdout)
            .map_err(|_| "OpenCascade 曲面点击解析 Worker 返回了非 UTF-8 内容".to_string())?;
        serde_json::from_str(stdout.trim())
            .map_err(|error| format!("OpenCascade 曲面点击解析结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("OpenCascade 曲面点击解析后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn analyze_wall_thickness(
    source_kind: String,
    source_part_id: String,
    minimum_wall_mm: f64,
    sample_limit: u32,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        if !matches!(source_kind.as_str(), "cad-part" | "uploaded-stl") {
            return Err("壁厚分析来源类型无效".to_string());
        }
        if !minimum_wall_mm.is_finite() || !(0.4..=10.0).contains(&minimum_wall_mm) {
            return Err("最小目标壁厚必须在 0.40 至 10.00 毫米之间".to_string());
        }
        if !(12..=5000).contains(&sample_limit) {
            return Err("壁厚采样上限必须在 12 至 5000 之间".to_string());
        }
        let source_file = match source_kind.as_str() {
            "cad-part" => generation_part_step_file(
                &state.paths.artifacts_dir,
                &source_part_id,
            )?,
            "uploaded-stl" => {
                if source_part_id != "uploaded-model" {
                    return Err("上传 STL 的来源标识无效".to_string());
                }
                imported_model_source_file(&state.paths.artifacts_dir)?
            }
            _ => unreachable!(),
        };
        if !state.paths.wall_thickness_worker_path.is_file() {
            return Err(format!(
                "未找到壁厚分析 Worker：{}",
                state.paths.wall_thickness_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        let source_path = state.paths.artifacts_dir.join(&source_file);
        if !source_path.is_file() {
            return Err(if source_kind == "uploaded-stl" {
                "没有找到上传模型，请先选择 STL 文件".to_string()
            } else {
                format!("没有找到精确模型 {source_file}，请先重建 CAD")
            });
        }
        fs::create_dir_all(&state.paths.artifacts_dir)
            .map_err(|error| format!("无法创建模型输出目录：{error}"))?;
        let arguments = vec![
            state.paths.wall_thickness_worker_path.display().to_string(),
            "--input".into(),
            source_path.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
            "--source-kind".into(),
            source_kind,
            "--source-part-id".into(),
            source_part_id,
            "--minimum-wall".into(),
            minimum_wall_mm.to_string(),
            "--sample-limit".into(),
            sample_limit.to_string(),
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            None,
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("壁厚分析 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state.paths.artifacts_dir.join("wall-thickness-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取壁厚分析结果：{error}"))?;
        serde_json::from_str(&contents)
            .map_err(|error| format!("壁厚分析结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("壁厚分析后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn run_version_geometry_difference(
    snapshot_directory: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "CAD 工作进程锁已损坏".to_string())?;
        let snapshot_directory = version_snapshot_directory(
            &snapshot_directory,
            &state.paths.artifacts_dir,
        )?;
        let snapshot_manifest = read_version_snapshot_manifest_at(&snapshot_directory)?;
        validate_version_snapshot_step_files(&snapshot_directory, &snapshot_manifest)?;

        let current_manifest_path = state.paths.artifacts_dir.join("generation-result.json");
        let current_manifest: Value = serde_json::from_str(
            &fs::read_to_string(&current_manifest_path)
                .map_err(|error| format!("无法读取当前精确模型清单：{error}"))?,
        )
        .map_err(|error| format!("当前精确模型清单格式错误：{error}"))?;
        if current_manifest.get("status").and_then(Value::as_str) != Some("ok") {
            return Err("当前精确模型清单不是有效的生成结果".into());
        }
        let current_parts = current_manifest
            .get("parts")
            .and_then(Value::as_array)
            .ok_or_else(|| "当前精确模型清单缺少零件列表".to_string())?;
        if current_parts.is_empty() {
            return Err("当前精确模型清单没有可比较的零件".into());
        }
        for part in current_parts {
            let file_name = part
                .get("stepFile")
                .and_then(Value::as_str)
                .ok_or_else(|| "当前精确模型零件缺少 STEP 文件声明".to_string())?;
            if !snapshot_declares_file(&current_manifest, file_name) {
                return Err(format!("当前精确模型清单未声明 STEP 文件：{file_name}"));
            }
            validate_generated_file(file_name, &state.paths.artifacts_dir)?;
            let file_path = fs::canonicalize(state.paths.artifacts_dir.join(file_name))
                .map_err(|_| format!("当前精确模型缺少零件 STEP 文件：{file_name}"))?;
            let artifacts_directory = fs::canonicalize(&state.paths.artifacts_dir)
                .map_err(|error| format!("无法读取当前模型目录：{error}"))?;
            if file_path.parent() != Some(artifacts_directory.as_path()) || !file_path.is_file() {
                return Err(format!("当前 STEP 文件不允许指向模型目录之外：{file_name}"));
            }
        }

        if !state.paths.version_difference_worker_path.is_file() {
            return Err(format!(
                "未找到精确版本差异 Worker：{}",
                state.paths.version_difference_worker_path.display()
            ));
        }
        if !cad_runtime_available(&state.paths) {
            return Err(format!(
                "CAD Python 环境不可用：{}。请设置 FORM_AI_PYTHON_PATH 指向已安装 CadQuery 的 Python。",
                state.paths.python_path.display()
            ));
        }
        let arguments = vec![
            state.paths.version_difference_worker_path.display().to_string(),
            "--base-directory".into(),
            snapshot_directory.display().to_string(),
            "--current-directory".into(),
            state.paths.artifacts_dir.display().to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
        ];
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            None,
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("精确版本差异 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result_path = state.paths.artifacts_dir.join("version-difference-result.json");
        let contents = fs::read_to_string(&result_path)
            .map_err(|error| format!("无法读取精确版本差异结果：{error}"))?;
        let result: Value = serde_json::from_str(&contents)
            .map_err(|error| format!("精确版本差异结果格式错误：{error}"))?;
        validate_version_difference_outputs(&state.paths.artifacts_dir, &result)?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("精确版本差异后台任务失败：{error}"))?
}

#[tauri::command]
pub fn read_generated_file(
    file_name: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Response, String> {
    validate_generated_file(&file_name, &state.paths.artifacts_dir)?;
    let bytes = fs::read(state.paths.artifacts_dir.join(&file_name))
        .map_err(|error| format!("无法读取 {file_name}：{error}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn load_version_snapshot(
    snapshot_directory: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Value, String> {
    let directory = version_snapshot_directory(&snapshot_directory, &state.paths.artifacts_dir)?;
    let manifest = read_version_snapshot_manifest_at(&directory)?;
    validate_version_snapshot_stl_files(&directory, &manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub fn read_version_snapshot_file(
    snapshot_directory: String,
    file_name: String,
    state: tauri::State<'_, BackendState>,
) -> Result<Response, String> {
    let file_path =
        version_snapshot_file_path(&snapshot_directory, &file_name, &state.paths.artifacts_dir)?;
    let bytes = fs::read(&file_path)
        .map_err(|error| format!("无法读取版本快照文件 {file_name}：{error}"))?;
    Ok(Response::new(bytes))
}

fn validate_export_vector(value: &ExportVector3, limit: f64, label: &str) -> Result<(), String> {
    if [value.x, value.y, value.z]
        .into_iter()
        .all(|component| component.is_finite() && component.abs() <= limit)
    {
        Ok(())
    } else {
        Err(format!("{label}包含无效或超出范围的数值"))
    }
}

fn validate_transformed_export_request(
    request: &TransformedExportRequest,
    artifacts_dir: &Path,
) -> Result<(), String> {
    let output_path = Path::new(&request.output_file_name);
    let plain_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value == request.output_file_name);
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !plain_name
        || request.output_file_name.chars().count() > 120
        || !request
            .output_file_name
            .chars()
            .all(|value| value.is_alphanumeric() || matches!(value, '-' | '_' | '.'))
        || !matches!(request.format.as_str(), "stl" | "3mf")
        || extension != request.format
    {
        return Err("变换导出的文件名或格式不合法".into());
    }
    if !(1..=64).contains(&request.objects.len()) {
        return Err("变换导出对象数量必须在 1 到 64 之间".into());
    }
    if request.format == "stl" && request.objects.len() != 1 {
        return Err("STL 一次只能导出一个对象".into());
    }
    for object in &request.objects {
        if object.id.is_empty()
            || object.id.chars().count() > 160
            || object.name.is_empty()
            || object.name.chars().count() > 120
        {
            return Err("变换导出对象缺少有效名称或标识".into());
        }
        validate_generated_file(&object.source_file, artifacts_dir)?;
        if !object.source_file.to_ascii_lowercase().ends_with(".stl") {
            return Err(format!("对象“{}”的源文件不是 STL", object.name));
        }
        let color = object.color.as_bytes();
        if color.len() != 7 || color[0] != b'#' || !color[1..].iter().all(u8::is_ascii_hexdigit) {
            return Err(format!("对象“{}”的颜色不合法", object.name));
        }
        validate_export_vector(&object.transform.position_mm, 1_000.0, "对象位置")?;
        validate_export_vector(&object.transform.rotation_deg, 36_000.0, "对象旋转")?;
        if !object.transform.scale.is_finite() || !(0.05..=20.0).contains(&object.transform.scale) {
            return Err(format!("对象“{}”的缩放不合法", object.name));
        }
        if let Some(base) = &object.base_position_display_mm {
            validate_export_vector(base, 1_000.0, "对象装配基础位置")?;
        }
    }
    Ok(())
}

fn copy_artifact_to_downloads(file_name: &str, artifacts_dir: &Path) -> Result<String, String> {
    let home = env::var("HOME").map_err(|_| "无法找到用户目录".to_string())?;
    let downloads = PathBuf::from(home).join("Downloads");
    fs::create_dir_all(&downloads).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let source = artifacts_dir.join(file_name);
    let mut destination = downloads.join(file_name);
    if destination.exists() {
        let path = Path::new(file_name);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("formai-model");
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let suffix = if extension.is_empty() {
            format!("-{id}", id = now_id())
        } else {
            format!("-{id}.{extension}", id = now_id())
        };
        destination = downloads.join(format!("{stem}{suffix}"));
    }
    fs::copy(&source, &destination).map_err(|error| format!("导出失败：{error}"))?;
    Ok(destination.display().to_string())
}

#[tauri::command]
pub async fn export_transformed_model(
    request: TransformedExportRequest,
    state: tauri::State<'_, BackendState>,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .generation_lock
            .lock()
            .map_err(|_| "变换导出锁不可用".to_string())?;
        validate_transformed_export_request(&request, &state.paths.artifacts_dir)?;
        if !state.paths.transformed_export_worker_path.is_file() {
            return Err(format!(
                "未找到变换导出 Worker：{}",
                state.paths.transformed_export_worker_path.display()
            ));
        }
        let arguments = vec![
            state
                .paths
                .transformed_export_worker_path
                .display()
                .to_string(),
            "--output".into(),
            state.paths.artifacts_dir.display().to_string(),
        ];
        let input = serde_json::to_string(&request)
            .map_err(|error| format!("无法序列化变换导出请求：{error}"))?;
        let output = run_process_with_input(
            &state.paths.python_path,
            &arguments,
            &state.paths.project_root,
            Some(&input),
        )?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("变换导出 Worker 退出，状态码：{}", output.status)
            } else {
                message
            });
        }
        let result: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("变换导出 Worker 返回格式错误：{error}"))?;
        if result.get("status").and_then(Value::as_str) != Some("ok")
            || result.get("fileName").and_then(Value::as_str) != Some(&request.output_file_name)
        {
            return Err("变换导出 Worker 未返回有效结果".into());
        }
        let output_path = state.paths.artifacts_dir.join(&request.output_file_name);
        if !output_path.is_file() || output_path.metadata().map(|item| item.len()).unwrap_or(0) == 0
        {
            return Err("变换导出文件不存在或为空".into());
        }
        copy_artifact_to_downloads(&request.output_file_name, &state.paths.artifacts_dir)
    })
    .await
    .map_err(|error| format!("变换导出任务异常结束：{error}"))?
}

#[tauri::command]
pub fn export_generated_file(
    file_name: String,
    state: tauri::State<'_, BackendState>,
) -> Result<String, String> {
    validate_generated_file(&file_name, &state.paths.artifacts_dir)?;
    copy_artifact_to_downloads(&file_name, &state.paths.artifacts_dir)
}

#[tauri::command]
pub fn create_version_snapshot(
    label: String,
    parameters: Value,
    model_source: String,
    model_revision: Option<String>,
    state: tauri::State<'_, BackendState>,
) -> Result<VersionSnapshot, String> {
    let _guard = state
        .generation_lock
        .lock()
        .map_err(|_| "版本快照锁不可用".to_string())?;
    let generated_files = match model_source.as_str() {
        "cad" => version_snapshot_generated_file_names(&state.paths.artifacts_dir)?,
        "uploaded-stl" => {
            let revision = model_revision
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "上传模型版本快照缺少修订号".to_string())?;
            uploaded_model_snapshot_file_names(&state.paths.artifacts_dir, revision)?
        }
        _ => return Err("版本快照模型来源只能是精确 CAD 或上传 STL".into()),
    };
    let id = now_id();
    let directory = state.paths.artifacts_dir.join("versions").join(format!(
        "{}-{}",
        id,
        sanitize_label(&label)
    ));
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建版本快照：{error}"))?;

    let snapshot_result = (|| -> Result<Vec<String>, String> {
        fs::write(
            directory.join("version.json"),
            serde_json::to_vec_pretty(&json!({
              "id": id,
              "label": label,
              "createdAtUnixMs": now_id(),
              "parameters": parameters,
              "modelSource": model_source,
              "modelRevision": model_revision,
            }))
            .map_err(|error| format!("无法序列化版本快照：{error}"))?,
        )
        .map_err(|error| format!("无法写入版本快照：{error}"))?;

        let mut files = vec!["version.json".to_string()];
        for file_name in generated_files {
            let source = state.paths.artifacts_dir.join(&file_name);
            fs::copy(&source, directory.join(&file_name))
                .map_err(|error| format!("无法复制快照文件 {file_name}：{error}"))?;
            files.push(file_name);
        }
        Ok(files)
    })();

    let files = match snapshot_result {
        Ok(files) => files,
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
    };
    Ok(VersionSnapshot {
        id,
        label,
        directory: directory.display().to_string(),
        files,
        model_source,
        model_revision,
    })
}

fn codex_output_schema() -> Value {
    let parameters: Vec<&str> = PARAMETER_NAMES
        .iter()
        .map(|(client_name, _)| *client_name)
        .collect();
    json!({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "summary": { "type": "string" },
        "changes": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "parameter": { "type": "string", "enum": parameters },
              "value": { "type": "number" },
              "reason": { "type": "string" }
            },
            "required": ["parameter", "value", "reason"]
          }
        },
        "localFeature": {
          "anyOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "operation": { "type": "string", "enum": ["add-cylinder", "cut-cylinder", "add-rectangle", "cut-rectangle", "cut-slot", "offset-face-outward", "offset-face-inward", "fillet-edge", "chamfer-edge", "fillet-edge-loop", "chamfer-edge-loop", "fillet-edge-chain", "chamfer-edge-chain", "fillet-edge-manual-chain", "chamfer-edge-manual-chain"] },
                "partId": { "type": "string" },
                "stableFaceId": { "type": "string" },
                "stableEdgeId": { "type": ["string", "null"] },
                "selectedEdges": {
                  "type": "array",
                  "maxItems": 64,
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "stableFaceId": { "type": "string" },
                      "stableEdgeId": { "type": "string" }
                    },
                    "required": ["stableFaceId", "stableEdgeId"]
                  }
                },
                "radiusMm": { "type": ["number", "null"] },
                "widthMm": { "type": ["number", "null"] },
                "heightMm": { "type": ["number", "null"] },
                "lengthMm": { "type": ["number", "null"] },
                "depthMm": { "type": "number", "minimum": 0.2, "maximum": 200.0 },
                "rotationDeg": { "type": "number", "minimum": -180.0, "maximum": 180.0 },
                "reason": { "type": "string" }
              },
              "required": ["operation", "partId", "stableFaceId", "stableEdgeId", "selectedEdges", "radiusMm", "widthMm", "heightMm", "lengthMm", "depthMm", "rotationDeg", "reason"]
            }
          ]
        }
      },
      "required": ["summary", "changes", "localFeature"]
    })
}

fn codex_prompt(command: &str, parameters: &Value, selection_context: Option<&Value>) -> String {
    let local_context = selection_context
        .map(|value| {
            format!(
                "\n已验证的 CAD 局部选择上下文：{}\n\
该上下文来自本次生成的稳定面选择网格，稳定面与稳定边都只是几何签名匹配第一版，不是永久拓扑命名。\
当 selectionMode=click 且 faces[0].geometryType=PLANE 时，允许生成圆形/矩形凸台、圆孔/矩形孔/槽孔，或执行整面向外拉伸/向内偏移；stableEdgeId 必须为 null。\
当 selectionMode=click 且 faces[0] 是非 PLANE 曲面时，只允许使用 add-cylinder、cut-cylinder、add-rectangle、cut-rectangle 或 cut-slot；矩形和槽孔是在真实 UV 点击位置的切平面安全近似，不是沿任意曲面贴合轮廓；不得生成整面偏移。\
曲面操作必须使用上下文中 resolutionStatus=resolved、precision=opencascade 的真实点击点、外法线和 surfaceUv，不得改写 UV、切换目标或伪造曲面参数。\
曲面矩形和槽孔的 rotationDeg=0 表示沿上下文中的真实 U 切向，正角度围绕真实外法线旋转；真实 U 切向由 OpenCascade 命中结果提供，Codex 不得改写，也不得在 localFeature 中增加切向字段。\
当 selectionMode=edge 时：fillet-edge/chamfer-edge 对当前种子稳定边执行单边圆角或倒角；fillet-edge-chain/chamfer-edge-chain 只在用户明确要求“切线链、相切边、切线连续、连续边链、沿切线或顺着切线”时使用，从当前种子边两端自动传播到唯一且夹角不超过 5 度的切线连续边，允许平面或非平面所属种子边；fillet-edge-loop/chamfer-edge-loop 只在用户明确要求“这圈、整圈、一圈、整周、周边、轮廓边或边界圈”且所属面为 PLANE 时使用，以当前 stableEdgeId 作为种子边，对其所属唯一平面边界 Wire 执行整圈圆角或倒角；若同时要求整圈和切线链必须拒绝并要求用户明确范围。非平面所属边仍必须使用当前 OpenCascade 精确点击点、真实 UV 和外法线；partId、stableFaceId、stableEdgeId 必须逐字复制当前选择，不得改成任意手工多边链或可变半径。\
当 selectionMode=edge-chain 时，只允许使用 fillet-edge-manual-chain 或 chamfer-edge-manual-chain；partId 和 stableFaceId 必须逐字复制首条目标，stableEdgeId 必须为 null，selectedEdges 必须按 edgeSelections 原始顺序逐项复制 stableFaceId 与 stableEdgeId，不得增删、排序、去重、替换或推断其他边。用户同时要求自动整圈或自动切线传播时必须返回 localFeature=null 并要求明确范围。\
除手工边链操作外 selectedEdges 必须为空数组；手工边链操作必须包含 2 至 64 项。\
四个轮廓尺寸必须全部为 null，rotationDeg 必须为 0，depthMm 表示圆角半径或倒角距离，范围为 0.20 至 50.00 毫米。\
所有 localFeature 都必须让 changes 为空，不得自行切换到其他零件、面或边。点击平面操作中：圆形凸台/圆孔使用 add-cylinder/cut-cylinder；矩形凸台/孔使用 add-rectangle/cut-rectangle；\
槽孔使用 cut-slot；整面向外拉伸/向内偏移使用 offset-face-outward/offset-face-inward。radiusMm 只用于圆柱，widthMm+heightMm 只用于矩形，widthMm+lengthMm 只用于槽孔；\
整面操作的四个轮廓尺寸必须全部为 null，rotationDeg 必须为 0。depthMm 是凸台高度、切入深度或整面移动距离。其他选择必须返回 localFeature=null，并在 summary 中说明暂不支持。\
必须尊重前端验证的原始毫米坐标、外法向、零件包围盒和截图；不得把 STL 三角面索引当作跨重建永久标识。",
                serde_json::to_string(value).unwrap_or_else(|_| "{}".into())
            )
        })
        .unwrap_or_else(|| {
            "\n当前没有 CAD 稳定面或稳定边选择上下文，localFeature 必须返回 null。".into()
        });
    format!(
        "你是 FormAI 的受限结构化 CAD 指令规划器。只分析用户建模要求，不修改文件、不运行命令。\n\
当前模型面向 Bambu Lab P1S、0.4 毫米喷嘴、PLA/PETG；尺寸单位全部是毫米。\n\
参数化整模修改只能使用 JSON Schema 中列出的参数字段，并让 localFeature 为 null。\n\
稳定面局部轮廓、整面拉伸/偏移或稳定边圆角/倒角只能通过 localFeature 表达，且 changes 必须为空；不得输出任意 Python、CadQuery 或 shell。\n\
如果要求无法通过现有参数、稳定面局部/整面特征或单边圆角/倒角表达，changes 返回空数组、localFeature 返回 null，\
并在 summary 中明确说明需要新增哪种 CAD 特征。\n\
必须保证壁厚、底厚、顶盖厚度大于 0，间隙不小于 0，圆角与倒角不小于 0。\n\
当前参数：{}\n\
用户指令：{}{}\n\
返回符合输出 Schema 的 JSON。",
        serde_json::to_string(parameters).unwrap_or_else(|_| "{}".into()),
        command,
        local_context
    )
}

#[derive(Debug, PartialEq, Eq)]
enum LocalSelectionMode {
    Face,
    Edge,
    EdgeChain,
}

#[derive(Debug)]
struct SelectedLocalTarget {
    mode: LocalSelectionMode,
    part_id: String,
    stable_face_id: String,
    stable_edge_id: Option<String>,
    selected_edges: Vec<CodexSelectedEdgeTarget>,
    geometry_type: String,
    /// 当前修订中由 OpenCascade 解析出的真实 U 切向；只用于校验方向轮廓上下文。
    surface_tangent_u: Option<[f64; 3]>,
}

fn selected_local_target(selection_context: &Value) -> Result<SelectedLocalTarget, String> {
    let mode = match selection_context
        .get("selectionMode")
        .and_then(Value::as_str)
    {
        Some("click") => LocalSelectionMode::Face,
        Some("edge") => LocalSelectionMode::Edge,
        Some("edge-chain") => LocalSelectionMode::EdgeChain,
        _ => return Err("Codex 局部特征只允许点击单个稳定面、单条稳定边或手工多选边链".into()),
    };
    if mode == LocalSelectionMode::EdgeChain {
        let selections = selection_context
            .get("edgeSelections")
            .and_then(Value::as_array)
            .ok_or_else(|| "手工多选边链缺少逐边选择数组".to_string())?;
        if !(2..=64).contains(&selections.len()) {
            return Err("手工多选边链必须包含 2 至 64 条稳定边".into());
        }
        let revision = selection_context
            .get("revision")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "手工多选边链缺少 CAD 修订号".to_string())?;
        let mut part_id: Option<String> = None;
        let mut selected_edges = Vec::with_capacity(selections.len());
        let mut stable_face_id = String::new();
        let mut geometry_type = String::new();
        let mut surface_tangent_u = None;
        let mut unique = std::collections::HashSet::new();
        for (index, selection) in selections.iter().enumerate() {
            let object = selection
                .as_object()
                .ok_or_else(|| format!("手工边链第 {} 条目标格式无效", index + 1))?;
            let face = object
                .get("face")
                .and_then(Value::as_object)
                .ok_or_else(|| format!("手工边链第 {} 条目标缺少稳定面", index + 1))?;
            let edge = object
                .get("edge")
                .and_then(Value::as_object)
                .ok_or_else(|| format!("手工边链第 {} 条目标缺少稳定边", index + 1))?;
            let hit = object
                .get("hit")
                .and_then(Value::as_object)
                .ok_or_else(|| format!("手工边链第 {} 条目标缺少精确命中", index + 1))?;
            let current_part = face
                .get("partId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("手工边链第 {} 条目标缺少零件 ID", index + 1))?;
            let current_face = face
                .get("stableId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("手工边链第 {} 条目标缺少稳定面 ID", index + 1))?;
            let current_edge = edge
                .get("stableEdgeId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("手工边链第 {} 条目标缺少稳定边 ID", index + 1))?;
            if part_id
                .as_deref()
                .is_some_and(|value| value != current_part)
            {
                return Err("手工多选边链只能选择同一个 CAD 零件中的边".into());
            }
            part_id.get_or_insert_with(|| current_part.to_string());
            if edge.get("partId").and_then(Value::as_str) != Some(current_part)
                || edge.get("stableFaceId").and_then(Value::as_str) != Some(current_face)
                || hit.get("partId").and_then(Value::as_str) != Some(current_part)
                || hit.get("stableId").and_then(Value::as_str) != Some(current_face)
                || hit.get("stableEdgeId").and_then(Value::as_str) != Some(current_edge)
            {
                return Err(format!(
                    "手工边链第 {} 条稳定面、稳定边与命中不一致",
                    index + 1
                ));
            }
            let surface_uv = hit.get("surfaceUv").and_then(Value::as_object);
            let precise = hit.get("resolutionStatus").and_then(Value::as_str) == Some("resolved")
                && hit.get("precision").and_then(Value::as_str) == Some("opencascade")
                && surface_uv
                    .and_then(|value| Some((value.get("u")?.as_f64()?, value.get("v")?.as_f64()?)))
                    .is_some_and(|(u, v)| u.is_finite() && v.is_finite());
            if !precise {
                return Err(format!(
                    "手工边链第 {} 条尚未完成 OpenCascade 精确解析",
                    index + 1
                ));
            }
            if !unique.insert((current_face.to_string(), current_edge.to_string())) {
                return Err("手工多选边链包含重复稳定边".into());
            }
            if index == 0 {
                stable_face_id = current_face.to_string();
                geometry_type = face
                    .get("geometryType")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                surface_tangent_u = hit
                    .get("surfaceTangentU")
                    .and_then(Value::as_object)
                    .and_then(|value| {
                        Some([
                            value.get("x")?.as_f64()?,
                            value.get("y")?.as_f64()?,
                            value.get("z")?.as_f64()?,
                        ])
                    })
                    .filter(|values| values.iter().all(|value| value.is_finite()));
            }
            selected_edges.push(CodexSelectedEdgeTarget {
                stable_face_id: current_face.to_string(),
                stable_edge_id: current_edge.to_string(),
            });
        }
        let _ = revision;
        return Ok(SelectedLocalTarget {
            mode,
            part_id: part_id.unwrap_or_default(),
            stable_face_id,
            stable_edge_id: None,
            selected_edges,
            geometry_type,
            surface_tangent_u,
        });
    }
    let faces = selection_context
        .get("faces")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex 局部特征缺少稳定面数组".to_string())?;
    if faces.len() != 1 {
        return Err("Codex 局部特征第一版只能绑定一个稳定面".into());
    }
    let face = faces[0]
        .as_object()
        .ok_or_else(|| "Codex 局部特征稳定面格式无效".to_string())?;
    let geometry_type = face
        .get("geometryType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex 局部特征缺少目标面几何类型".to_string())?;
    let part_id = face
        .get("partId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex 局部特征缺少零件 ID".to_string())?;
    let stable_face_id = face
        .get("stableId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex 局部特征缺少稳定面 ID".to_string())?;
    let hit = selection_context
        .get("hit")
        .and_then(Value::as_object)
        .ok_or_else(|| "Codex 局部特征缺少点击命中信息".to_string())?;
    if hit.get("partId").and_then(Value::as_str) != Some(part_id)
        || hit.get("stableId").and_then(Value::as_str) != Some(stable_face_id)
    {
        return Err("CAD 稳定面描述与点击命中不一致，请重新点击目标面或目标边".into());
    }
    let surface_uv = hit.get("surfaceUv").and_then(Value::as_object);
    let precise_hit = hit.get("resolutionStatus").and_then(Value::as_str) == Some("resolved")
        && hit.get("precision").and_then(Value::as_str) == Some("opencascade")
        && surface_uv
            .and_then(|value| Some((value.get("u")?.as_f64()?, value.get("v")?.as_f64()?)))
            .is_some_and(|(u, v)| u.is_finite() && v.is_finite());
    if !precise_hit {
        return Err("当前点击位置尚未完成 OpenCascade 精确解析，Codex 不得生成局部特征".into());
    }
    let surface_tangent_u = hit
        .get("surfaceTangentU")
        .and_then(Value::as_object)
        .and_then(|value| {
            Some([
                value.get("x")?.as_f64()?,
                value.get("y")?.as_f64()?,
                value.get("z")?.as_f64()?,
            ])
        })
        .filter(|values| values.iter().all(|value| value.is_finite()));

    let stable_edge_id = match mode {
        LocalSelectionMode::Face => {
            if selection_context
                .get("edge")
                .is_some_and(|value| !value.is_null())
                || hit
                    .get("stableEdgeId")
                    .is_some_and(|value| !value.is_null())
            {
                return Err("点击稳定面上下文不能携带稳定边，请重新选择目标平面".into());
            }
            None
        }
        LocalSelectionMode::Edge => {
            let edge = selection_context
                .get("edge")
                .and_then(Value::as_object)
                .ok_or_else(|| "点击稳定边上下文缺少边描述".to_string())?;
            let edge_id = edge
                .get("stableEdgeId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "点击稳定边上下文缺少稳定边 ID".to_string())?;
            if edge.get("partId").and_then(Value::as_str) != Some(part_id)
                || edge.get("stableFaceId").and_then(Value::as_str) != Some(stable_face_id)
                || hit.get("stableEdgeId").and_then(Value::as_str) != Some(edge_id)
            {
                return Err("CAD 稳定边描述与点击命中不一致，请重新点击目标边".into());
            }
            Some(edge_id.to_string())
        }
        LocalSelectionMode::EdgeChain => unreachable!("手工边链已在前置分支返回"),
    };

    Ok(SelectedLocalTarget {
        mode,
        part_id: part_id.to_string(),
        stable_face_id: stable_face_id.to_string(),
        stable_edge_id,
        selected_edges: Vec::new(),
        geometry_type: geometry_type.to_string(),
        surface_tangent_u,
    })
}

fn validate_codex_model_result(
    result: &CodexModelCommandResult,
    selection_context: Option<&Value>,
) -> Result<(), String> {
    if result.summary.trim().is_empty() || result.summary.chars().count() > 2_000 {
        return Err("Codex 返回的中文摘要为空或过长".into());
    }
    if result.changes.len() > PARAMETER_NAMES.len() {
        return Err("Codex 返回的参数修改数量超出允许范围".into());
    }
    for change in &result.changes {
        if !PARAMETER_NAMES
            .iter()
            .any(|(client_name, _)| *client_name == change.parameter)
        {
            return Err(format!(
                "Codex 返回了不允许修改的参数：{}",
                change.parameter
            ));
        }
        if !change.value.is_finite() {
            return Err(format!("Codex 参数 {} 不是有限数值", change.parameter));
        }
        if change.reason.trim().is_empty() || change.reason.chars().count() > 500 {
            return Err(format!("Codex 参数 {} 的中文原因无效", change.parameter));
        }
    }

    let Some(feature) = result.local_feature.as_ref() else {
        return Ok(());
    };
    if !result.changes.is_empty() {
        return Err("Codex 不能在同一计划中同时修改整模参数和稳定 CAD 局部特征".into());
    }
    let context = selection_context
        .ok_or_else(|| "Codex 返回了局部特征，但当前没有 CAD 稳定面或稳定边选择".to_string())?;
    let target = selected_local_target(context)?;
    if feature.part_id != target.part_id || feature.stable_face_id != target.stable_face_id {
        return Err("Codex 计划试图修改当前选择之外的零件或稳定面，已拒绝执行".into());
    }

    let manual_edge_chain_operation = matches!(
        feature.operation.as_str(),
        "fillet-edge-manual-chain" | "chamfer-edge-manual-chain"
    );
    let edge_operation = manual_edge_chain_operation
        || matches!(
            feature.operation.as_str(),
            "fillet-edge"
                | "chamfer-edge"
                | "fillet-edge-loop"
                | "chamfer-edge-loop"
                | "fillet-edge-chain"
                | "chamfer-edge-chain"
        );
    let edge_loop_operation = matches!(
        feature.operation.as_str(),
        "fillet-edge-loop" | "chamfer-edge-loop"
    );
    match target.mode {
        LocalSelectionMode::Face => {
            if edge_operation {
                return Err("点击稳定面时不能执行圆角或倒角，请先使用点击选边工具".into());
            }
            if feature.stable_edge_id.is_some() {
                return Err("点击稳定面计划不能携带稳定边 ID".into());
            }
            if !feature.selected_edges.is_empty() {
                return Err("点击稳定面计划不能携带手工边列表".into());
            }
        }
        LocalSelectionMode::Edge => {
            if !edge_operation || manual_edge_chain_operation {
                return Err(
                    "点击稳定边时只允许执行单边、切线连续边链或平面边界整圈圆角与倒角".into(),
                );
            }
            if feature.stable_edge_id.as_deref() != target.stable_edge_id.as_deref() {
                return Err("Codex 计划试图修改当前选择之外的稳定边，已拒绝执行".into());
            }
            if !feature.selected_edges.is_empty() {
                return Err("单边或自动边链计划不能携带手工边列表".into());
            }
        }
        LocalSelectionMode::EdgeChain => {
            if !manual_edge_chain_operation {
                return Err("手工多选边链只允许执行手工边链圆角或倒角".into());
            }
            if feature.stable_edge_id.is_some() {
                return Err("手工多选边链计划不能携带单一种子稳定边 ID".into());
            }
            if feature.selected_edges != target.selected_edges {
                return Err("Codex 计划增删、排序或替换了手工选择边列表，已拒绝执行".into());
            }
        }
    }

    if target.geometry_type != "PLANE" && edge_loop_operation {
        return Err("整圈边圆角或倒角第一版只支持平面边界，请重新选择平面所属边".into());
    }

    if target.geometry_type != "PLANE"
        && !matches!(
            feature.operation.as_str(),
            "add-cylinder"
                | "cut-cylinder"
                | "add-rectangle"
                | "cut-rectangle"
                | "cut-slot"
                | "fillet-edge"
                | "chamfer-edge"
                | "fillet-edge-chain"
                | "chamfer-edge-chain"
                | "fillet-edge-manual-chain"
                | "chamfer-edge-manual-chain"
        )
    {
        return Err("当前选中的是非平面曲面；当前只支持圆形凸台、圆孔、矩形凸台、矩形孔、受限槽孔，或对所选稳定边执行单边或切线连续边链圆角与倒角".into());
    }
    let directional_profile = matches!(
        feature.operation.as_str(),
        "add-rectangle" | "cut-rectangle" | "cut-slot"
    );
    if target.geometry_type != "PLANE" && directional_profile {
        let [x, y, z] = target.surface_tangent_u.ok_or_else(|| {
            "当前曲面方向轮廓缺少 OpenCascade 真实 U 切向，Codex 不得生成或改写该切向".to_string()
        })?;
        if (x * x + y * y + z * z).sqrt() < 0.5 {
            return Err(
                "当前曲面方向轮廓的 OpenCascade 真实 U 切向已退化，请重新点击目标面".into(),
            );
        }
    }

    if !matches!(
        feature.operation.as_str(),
        "add-cylinder"
            | "cut-cylinder"
            | "add-rectangle"
            | "cut-rectangle"
            | "cut-slot"
            | "offset-face-outward"
            | "offset-face-inward"
            | "fillet-edge"
            | "chamfer-edge"
            | "fillet-edge-loop"
            | "chamfer-edge-loop"
            | "fillet-edge-chain"
            | "chamfer-edge-chain"
            | "fillet-edge-manual-chain"
            | "chamfer-edge-manual-chain"
    ) {
        return Err("Codex 返回了未知的稳定 CAD 局部特征操作".into());
    }
    let maximum_depth = if edge_operation { 50.0 } else { 200.0 };
    if !feature.depth_mm.is_finite()
        || !(0.2..=maximum_depth).contains(&feature.depth_mm)
        || !feature.rotation_deg.is_finite()
        || !(-180.0..=180.0).contains(&feature.rotation_deg)
    {
        return Err(if edge_operation {
            "Codex 返回的圆角半径、倒角距离或旋转角超出安全范围".into()
        } else {
            "Codex 返回的局部修改深度或旋转角超出安全范围".into()
        });
    }
    let cylinder = matches!(feature.operation.as_str(), "add-cylinder" | "cut-cylinder");
    let whole_face = matches!(
        feature.operation.as_str(),
        "offset-face-outward" | "offset-face-inward"
    );
    if edge_operation {
        if feature.radius_mm.is_some()
            || feature.width_mm.is_some()
            || feature.height_mm.is_some()
            || feature.length_mm.is_some()
            || feature.rotation_deg.abs() > 1e-9
        {
            return Err("Codex 圆角或倒角计划不能携带平面轮廓尺寸或旋转角".into());
        }
    } else if whole_face {
        if feature.radius_mm.is_some()
            || feature.width_mm.is_some()
            || feature.height_mm.is_some()
            || feature.length_mm.is_some()
            || feature.rotation_deg.abs() > 1e-9
        {
            return Err("Codex 整面拉伸或偏移计划的尺寸字段不符合安全协议".into());
        }
    } else if cylinder {
        if feature
            .radius_mm
            .is_none_or(|value| !value.is_finite() || !(0.5..=100.0).contains(&value))
            || feature.width_mm.is_some()
            || feature.height_mm.is_some()
            || feature.length_mm.is_some()
            || feature.rotation_deg.abs() > 1e-9
        {
            return Err("Codex 圆柱计划的尺寸字段不符合安全协议".into());
        }
    } else {
        let width = feature
            .width_mm
            .ok_or_else(|| "Codex 矩形或槽孔计划缺少宽度".to_string())?;
        if feature.radius_mm.is_some() || !width.is_finite() || !(0.5..=200.0).contains(&width) {
            return Err("Codex 矩形或槽孔计划的宽度或半径字段无效".into());
        }
        if feature.operation == "cut-slot" {
            let length = feature
                .length_mm
                .ok_or_else(|| "Codex 槽孔计划缺少长度".to_string())?;
            if feature.height_mm.is_some()
                || !length.is_finite()
                || !(1.0..=200.0).contains(&length)
                || length < width
            {
                return Err("Codex 槽孔计划的长度或高度字段无效".into());
            }
        } else {
            let height = feature
                .height_mm
                .ok_or_else(|| "Codex 矩形计划缺少高度".to_string())?;
            if feature.length_mm.is_some()
                || !height.is_finite()
                || !(0.5..=200.0).contains(&height)
            {
                return Err("Codex 矩形计划的高度或长度字段无效".into());
            }
        }
    }
    if feature.reason.trim().is_empty() || feature.reason.chars().count() > 500 {
        return Err("Codex 返回的局部特征中文原因无效".into());
    }
    Ok(())
}

fn image_analysis_schema() -> Value {
    let parameters: Vec<&str> = PARAMETER_NAMES
        .iter()
        .map(|(client_name, _)| *client_name)
        .collect();
    json!({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "summary": { "type": "string" },
        "objectType": { "type": "string" },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "estimatedParameters": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "parameter": { "type": "string", "enum": parameters },
              "value": { "type": "number" },
              "reason": { "type": "string" }
            },
            "required": ["parameter", "value", "reason"]
          }
        },
        "interfaces": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": { "type": "string" },
              "type": { "type": "string", "enum": ["USB-C", "按钮", "LED", "排针", "电源接口", "未知"] },
              "side": { "type": "string" },
              "positionXPercent": { "type": "number", "minimum": 0, "maximum": 100 },
              "positionYPercent": { "type": "number", "minimum": 0, "maximum": 100 },
              "widthMm": { "type": "number", "minimum": 0 },
              "heightMm": { "type": "number", "minimum": 0 },
              "horizontalOffsetMm": { "type": "number" },
              "bottomOffsetMm": { "type": "number", "minimum": 0 },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
              "requiresOpening": { "type": "boolean" },
              "openingShape": { "type": "string", "enum": ["circle", "rectangle", "rounded-rectangle", "slot"] }
            },
            "required": ["id", "type", "side", "positionXPercent", "positionYPercent", "widthMm", "heightMm", "horizontalOffsetMm", "bottomOffsetMm", "confidence", "requiresOpening"]
          }
        },
        "warnings": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["summary", "objectType", "confidence", "estimatedParameters", "interfaces", "warnings"]
    })
}

#[tauri::command]
pub async fn analyze_reference_image(
    file_name: String,
    image_bytes: Vec<u8>,
    view_type: String,
    calibration: ImageCalibration,
    parameters: Value,
    state: tauri::State<'_, BackendState>,
) -> Result<ImageAnalysisResult, String> {
    if image_bytes.is_empty() {
        return Err("导入图片为空".into());
    }
    if image_bytes.len() > 20 * 1024 * 1024 {
        return Err("图片不能超过 20 MB".into());
    }
    if calibration.image_width_px <= 0.0 || calibration.image_height_px <= 0.0 {
        return Err("图片原始像素尺寸无效".into());
    }
    if !calibration.pixel_distance.is_finite() || calibration.pixel_distance < 1.0 {
        return Err("请在图片上选择两个不同的标定点".into());
    }
    if !calibration.real_distance_mm.is_finite() || calibration.real_distance_mm <= 0.0 {
        return Err("真实尺寸标定必须大于 0 毫米".into());
    }
    if !calibration.mm_per_pixel.is_finite() || calibration.mm_per_pixel <= 0.0 {
        return Err("毫米/像素标定比例无效".into());
    }

    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .codex_lock
            .lock()
            .map_err(|_| "Codex 执行锁已损坏".to_string())?;
        let codex = state.paths.codex_path.as_ref().ok_or_else(|| {
            "未找到 Codex 命令行工具，请先安装或设置 FORM_AI_CODEX_PATH".to_string()
        })?;
        if !codex_authenticated(&state.paths) {
            return Err("Codex 尚未登录，请先在 Codex 桌面端或命令行工具中完成登录".into());
        }

        fs::create_dir_all(&state.paths.artifacts_dir)
            .map_err(|error| format!("无法创建运行目录：{error}"))?;
        let extension = Path::new(&file_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
            .unwrap_or_else(|| "png".into());
        let image_path = state
            .paths
            .artifacts_dir
            .join(format!(".reference-image-{}.{}", now_id(), extension));
        let schema_path = state.paths.artifacts_dir.join(".codex-image-analysis.schema.json");
        let output_path = state.paths.artifacts_dir.join(".codex-image-analysis.json");
        fs::write(&image_path, image_bytes)
            .map_err(|error| format!("无法保存待识别图片：{error}"))?;
        fs::write(
            &schema_path,
            serde_json::to_vec_pretty(&image_analysis_schema())
                .map_err(|error| format!("无法序列化图片识别规则：{error}"))?,
        )
        .map_err(|error| format!("无法写入图片识别规则：{error}"))?;

        let prompt = format!(
            "你是 FormAI 的三维打印建模视觉分析器。请分析附图，为后续参数化 CAD 建模提供可靠输入。\n\
图片视角：{}。双点尺寸标定数据：{}。\n\
当前模型参数：{}。\n\
标定点坐标基于原始图片像素，比例已经由用户确认。必须使用该比例估算可见接口的宽高。\n\
识别 USB-C、按钮、LED、排针、电源接口和其他需要避让的结构。接口中心位置使用图片左上角为原点的百分比坐标；horizontalOffsetMm 表示接口相对该面的水平中心偏移，图片右侧为正；bottomOffsetMm 表示开孔底边相对外壳底边的距离。\n\
只有需要穿过外壳或保持外部可操作空间的接口才设置 requiresOpening=true。每个接口提供稳定且唯一的中文或英文 id。\n\
openingShape 只描述接口所在二维平面的开孔轮廓：USB-C 优先 rounded-rectangle，按钮、LED 和近似圆形电源接口优先 circle，排针优先 rectangle，长圆孔优先 slot；不确定时使用 rounded-rectangle 并写入 warnings。这不是相机位姿求解或摄影测量。\n\
只能在 estimatedParameters 中返回图中有足够证据估计的参数；单张图片无法可靠推断的尺寸不要猜测。\n\
如果外壳边界不完整、透视畸变明显、标定线不与接口面共面或缺少其他视角，必须写入 warnings。所有说明使用中文。",
            view_type,
            serde_json::to_string(&calibration).unwrap_or_else(|_| "{}".into()),
            serde_json::to_string(&parameters).unwrap_or_else(|_| "{}".into())
        );
        let arguments = vec![
            "exec".into(),
            "--ephemeral".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
            "--color".into(),
            "never".into(),
            "--image".into(),
            image_path.display().to_string(),
            "--output-schema".into(),
            schema_path.display().to_string(),
            "--output-last-message".into(),
            output_path.display().to_string(),
            "-C".into(),
            state.paths.project_root.display().to_string(),
            "-".into(),
        ];
        let output = run_process_with_input(
            codex,
            &arguments,
            &state.paths.project_root,
            Some(&prompt),
        )?;
        let _ = fs::remove_file(&image_path);
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("图片识别失败，状态码：{}", output.status)
            } else {
                message
            });
        }
        let response = fs::read_to_string(&output_path)
            .map_err(|error| format!("无法读取图片识别结果：{error}"))?;
        serde_json::from_str(&response)
            .map_err(|error| format!("图片识别结果格式错误：{error}"))
    })
    .await
    .map_err(|error| format!("图片识别后台任务失败：{error}"))?
}

#[tauri::command]
pub async fn run_codex_model_command(
    command: String,
    parameters: Value,
    selection_context: Option<Value>,
    screenshot_bytes: Option<Vec<u8>>,
    state: tauri::State<'_, BackendState>,
) -> Result<CodexModelCommandResult, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("建模指令不能为空".into());
    }
    if command.chars().count() > 2_000 {
        return Err("建模指令过长，请控制在 2000 字以内".into());
    }
    if let Some(context) = selection_context.as_ref() {
        let size = serde_json::to_vec(context)
            .map_err(|error| format!("局部选择上下文格式错误：{error}"))?
            .len();
        if size > 128 * 1024 {
            return Err("局部选择上下文过大，请减少框选面数量后重试".into());
        }
    }
    if let Some(bytes) = screenshot_bytes.as_ref() {
        if selection_context.is_none() {
            return Err("局部截图缺少对应的 CAD 选择上下文".into());
        }
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("局部截图不能超过 4 MB".into());
        }
        if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            return Err("局部截图必须是有效的 PNG 图片".into());
        }
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .codex_lock
            .lock()
            .map_err(|_| "Codex 执行锁已损坏".to_string())?;
        let codex = state.paths.codex_path.as_ref().ok_or_else(|| {
            "未找到 Codex 命令行工具，请先安装或设置 FORM_AI_CODEX_PATH".to_string()
        })?;
        if !codex_authenticated(&state.paths) {
            return Err("Codex 尚未登录，请先在 Codex 桌面端或命令行工具中完成登录".into());
        }

        fs::create_dir_all(&state.paths.artifacts_dir)
            .map_err(|error| format!("无法创建运行目录：{error}"))?;
        let schema_path = state
            .paths
            .artifacts_dir
            .join(".codex-model-command.schema.json");
        let output_path = state.paths.artifacts_dir.join(".codex-last-message.json");
        fs::write(
            &schema_path,
            serde_json::to_vec_pretty(&codex_output_schema())
                .map_err(|error| format!("无法序列化 Codex 输出规则：{error}"))?,
        )
        .map_err(|error| format!("无法写入 Codex 输出规则：{error}"))?;

        let screenshot_path = screenshot_bytes.as_ref().map(|_| {
            state
                .paths
                .artifacts_dir
                .join(format!(".codex-local-selection-{}.png", now_id()))
        });
        if let (Some(path), Some(bytes)) = (screenshot_path.as_ref(), screenshot_bytes.as_ref()) {
            fs::write(path, bytes).map_err(|error| format!("无法保存局部选择截图：{error}"))?;
        }
        let mut arguments = vec![
            "exec".into(),
            "--ephemeral".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
            "--color".into(),
            "never".into(),
        ];
        if let Some(path) = screenshot_path.as_ref() {
            arguments.extend(["--image".into(), path.display().to_string()]);
        }
        arguments.extend([
            "--output-schema".into(),
            schema_path.display().to_string(),
            "--output-last-message".into(),
            output_path.display().to_string(),
            "-C".into(),
            state.paths.project_root.display().to_string(),
            "-".into(),
        ]);
        let prompt = codex_prompt(&command, &parameters, selection_context.as_ref());
        let output_result =
            run_process_with_input(codex, &arguments, &state.paths.project_root, Some(&prompt));
        if let Some(path) = screenshot_path.as_ref() {
            let _ = fs::remove_file(path);
        }
        let output = output_result?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("Codex 执行失败，状态码：{}", output.status)
            } else {
                message
            });
        }
        let response = fs::read_to_string(&output_path)
            .map_err(|error| format!("无法读取 Codex 结果：{error}"))?;
        let result: CodexModelCommandResult = serde_json::from_str(&response)
            .map_err(|error| format!("Codex 返回格式错误：{error}"))?;
        validate_codex_model_result(&result, selection_context.as_ref())?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("Codex 后台任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "formai-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ))
    }

    fn mesh_element_selection(triangle_index: u64, element_index: u64) -> Value {
        serde_json::json!({
            "triangleIndex": triangle_index,
            "elementIndex": element_index,
            "triangleMm": [
                { "x": 0.0, "y": 0.0, "z": 0.0 },
                { "x": 10.0, "y": 0.0, "z": 0.0 },
                { "x": 0.0, "y": 10.0, "z": 0.0 }
            ]
        })
    }

    #[test]
    fn resolves_arbitrary_cad_part_for_mesh_branch() {
        let manifest = json!({
            "revision": "cad-revision-1",
            "parts": [
                { "id": "ornament-left", "label": "左侧装饰件", "stlFile": "ornament-left.stl" },
                { "id": "figure-head", "label": "头部", "stlFile": "figure-head.stl" }
            ]
        });
        let resolved = resolve_cad_mesh_branch_source(&manifest, "cad-revision-1", "figure-head")
            .expect("任意清单零件都应可创建网格分支");
        assert_eq!(resolved, ("头部".into(), "figure-head.stl".into()));
    }

    #[test]
    fn rejects_stale_unknown_and_unsafe_cad_mesh_branch_sources() {
        let manifest = json!({
            "revision": "cad-revision-2",
            "parts": [{ "id": "part-a", "label": "零件甲", "stlFile": "../outside.stl" }]
        });
        assert!(
            resolve_cad_mesh_branch_source(&manifest, "cad-revision-old", "part-a")
                .expect_err("旧修订必须被拒绝")
                .contains("发生变化")
        );
        assert!(
            resolve_cad_mesh_branch_source(&manifest, "cad-revision-2", "missing")
                .expect_err("未知零件必须被拒绝")
                .contains("没有找到零件")
        );
        assert!(
            resolve_cad_mesh_branch_source(&manifest, "cad-revision-2", "part-a")
                .expect_err("路径穿越文件必须被拒绝")
                .contains("文件名无效")
        );
    }

    #[test]
    fn validates_mesh_element_selection_collection() {
        let selections = vec![mesh_element_selection(1, 0), mesh_element_selection(2, 2)];
        let serialized = validate_mesh_element_selections("vertex", "box", &selections)
            .expect("合法多元素集合应通过");
        assert!(serialized.contains("triangleIndex"));
    }

    #[test]
    fn rejects_empty_and_oversized_mesh_element_collections() {
        assert!(validate_mesh_element_selections("vertex", "click", &[])
            .expect_err("空集合必须被拒绝")
            .contains("1 至 512"));
        let selections = vec![mesh_element_selection(1, 0); 513];
        assert!(
            validate_mesh_element_selections("vertex", "box", &selections)
                .expect_err("超过上限必须被拒绝")
                .contains("1 至 512")
        );
    }

    #[test]
    fn rejects_invalid_mesh_element_method_and_face_index() {
        let selections = vec![mesh_element_selection(1, 0)];
        assert!(
            validate_mesh_element_selections("vertex", "lasso", &selections)
                .expect_err("非法选择方式必须被拒绝")
                .contains("点击或框选")
        );
        let face = vec![mesh_element_selection(1, 1)];
        assert!(validate_mesh_element_selections("face", "box", &face)
            .expect_err("面的元素索引必须为零")
            .contains("不匹配"));
    }

    #[test]
    fn rejects_mesh_element_missing_or_extra_fields() {
        let missing = vec![serde_json::json!({
            "triangleIndex": 1,
            "elementIndex": 0
        })];
        assert!(
            validate_mesh_element_selections("vertex", "click", &missing)
                .expect_err("缺字段必须被拒绝")
                .contains("缺失或不允许")
        );
        let extra = vec![serde_json::json!({
            "triangleIndex": 1,
            "elementIndex": 0,
            "triangleMm": [
                { "x": 0.0, "y": 0.0, "z": 0.0 },
                { "x": 10.0, "y": 0.0, "z": 0.0 },
                { "x": 0.0, "y": 10.0, "z": 0.0 }
            ],
            "command": "不允许"
        })];
        assert!(validate_mesh_element_selections("vertex", "click", &extra)
            .expect_err("额外字段必须被拒绝")
            .contains("缺失或不允许"));
    }

    #[test]
    fn rejects_mesh_element_coordinate_and_triangle_index_out_of_range() {
        let mut coordinate = mesh_element_selection(1, 0);
        coordinate["triangleMm"][0]["x"] = serde_json::json!(1_000_000.1);
        assert!(
            validate_mesh_element_selections("vertex", "click", &[coordinate])
                .expect_err("超范围坐标必须被拒绝")
                .contains("安全范围")
        );
        let triangle = vec![mesh_element_selection(5_000_001, 0)];
        assert!(
            validate_mesh_element_selections("vertex", "click", &triangle)
                .expect_err("超范围三角面索引必须被拒绝")
                .contains("三角面索引超过")
        );
    }

    #[test]
    fn validates_single_mesh_face_extrusion_parameters() {
        let added = validate_mesh_face_extrusion("face", "click", 1, Some("add".into()), Some(2.0))
            .expect("合法向外加料应通过");
        assert_eq!(added, ("add".into(), 2.0));

        let cut = validate_mesh_face_extrusion("face", "click", 1, Some("cut".into()), Some(0.2))
            .expect("合法向内压入应通过");
        assert_eq!(cut, ("cut".into(), 0.2));
    }

    #[test]
    fn rejects_invalid_mesh_face_extrusion_selection_mode_and_distance() {
        for (kind, method, count) in [
            ("vertex", "click", 1),
            ("face", "box", 1),
            ("face", "click", 2),
        ] {
            assert!(validate_mesh_face_extrusion(
                kind,
                method,
                count,
                Some("add".into()),
                Some(2.0),
            )
            .is_err());
        }
        assert!(validate_mesh_face_extrusion(
            "face",
            "click",
            1,
            Some("未知方向".into()),
            Some(2.0),
        )
        .is_err());
        for distance in [0.1, 100.01, f64::NAN] {
            assert!(validate_mesh_face_extrusion(
                "face",
                "click",
                1,
                Some("cut".into()),
                Some(distance),
            )
            .is_err());
        }
    }

    #[test]
    fn validates_mesh_element_move_rotate_and_scale_parameters() {
        let moved =
            validate_mesh_element_transform("move", Some(0.2), None, Some(-0.1), None, None, None)
                .expect("有效位移应通过");
        assert_eq!(moved.displacement, [0.2, 0.0, -0.1]);

        let rotated = validate_mesh_element_transform(
            "rotate",
            None,
            None,
            None,
            Some("z".into()),
            Some(10.0),
            None,
        )
        .expect("有效旋转应通过");
        assert_eq!(rotated.rotation_axis, "z");
        assert_eq!(rotated.rotation_degrees, 10.0);

        let scaled =
            validate_mesh_element_transform("scale", None, None, None, None, None, Some(0.9))
                .expect("有效缩放应通过");
        assert_eq!(scaled.scale_factor, 0.9);
    }

    #[test]
    fn rejects_invalid_mesh_element_rotation_parameters() {
        for (axis, degrees) in [
            (Some("任意轴".into()), Some(10.0)),
            (None, Some(10.0)),
            (Some("x".into()), Some(0.0)),
            (Some("y".into()), Some(180.1)),
        ] {
            assert!(validate_mesh_element_transform(
                "rotate", None, None, None, axis, degrees, None
            )
            .is_err());
        }
    }

    #[test]
    fn rejects_invalid_mesh_element_scale_and_unknown_operation() {
        for scale_factor in [0.24, 1.0, 4.01] {
            assert!(validate_mesh_element_transform(
                "scale",
                None,
                None,
                None,
                None,
                None,
                Some(scale_factor),
            )
            .is_err());
        }
        assert!(
            validate_mesh_element_transform("twist", None, None, None, None, None, None,)
                .unwrap_err()
                .contains("位移、旋转或缩放")
        );
    }

    #[test]
    fn cad_surface_hit_request_rejects_non_finite_coordinates() {
        let error = validate_cad_surface_hit_request(
            "revision-1",
            "part-1",
            "face-1",
            0,
            &[0.0, 0.0, f64::NAN, 0.0, 0.0, 1.0],
        )
        .expect_err("非有限坐标必须被拒绝");
        assert!(error.contains("有限数值"));
    }

    #[test]
    fn cad_surface_hit_request_rejects_negative_triangle_index() {
        let error = validate_cad_surface_hit_request(
            "revision-1",
            "part-1",
            "face-1",
            -1,
            &[0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        )
        .expect_err("负三角面索引必须被拒绝");
        assert!(error.contains("三角面索引无效"));
    }

    #[test]
    fn cad_surface_hit_request_rejects_overlong_identifier() {
        let identifier = "a".repeat(201);
        let error = validate_cad_surface_hit_request(
            &identifier,
            "part-1",
            "face-1",
            0,
            &[0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        )
        .expect_err("过长标识必须被拒绝");
        assert!(error.contains("选择标识无效"));
    }

    #[test]
    fn codex_prompt_includes_verified_local_face_context() {
        let parameters = json!({"wallThickness": 2.0});
        let context = json!({
            "protocol": "FormAI-CAD-局部编辑上下文",
            "faces": [{"stableId": "face-123", "partId": "body"}],
            "hit": {"pointMm": {"x": 1.0, "y": 2.0, "z": 3.0}}
        });
        let prompt = codex_prompt("这里增加一个凸台", &parameters, Some(&context));
        assert!(prompt.contains("已验证的 CAD 局部选择上下文"));
        assert!(prompt.contains("face-123"));
        assert!(prompt.contains("fillet-edge-chain/chamfer-edge-chain"));
        assert!(prompt.contains("fillet-edge-loop/chamfer-edge-loop"));
        assert!(prompt.contains("不得把 STL 三角面索引当作跨重建永久标识"));
    }

    fn valid_local_feature_selection() -> Value {
        json!({
            "selectionMode": "click",
            "faces": [{
                "partId": "body",
                "stableId": "face-top",
                "geometryType": "PLANE"
            }],
            "hit": {
                "partId": "body",
                "stableId": "face-top",
                "precision": "opencascade",
                "resolutionStatus": "resolved",
                "surfaceUv": {"u": 1.0, "v": 2.0}
            }
        })
    }

    fn local_feature_result(operation: &str) -> CodexModelCommandResult {
        let cylinder = matches!(operation, "add-cylinder" | "cut-cylinder");
        let whole_face = matches!(operation, "offset-face-outward" | "offset-face-inward");
        let slot = operation == "cut-slot";
        CodexModelCommandResult {
            summary: "已生成受限的稳定面局部特征计划".into(),
            changes: vec![],
            local_feature: Some(CodexLocalCadFeaturePlan {
                operation: operation.into(),
                part_id: "body".into(),
                stable_face_id: "face-top".into(),
                stable_edge_id: None,
                selected_edges: Vec::new(),
                radius_mm: cylinder.then_some(2.0),
                width_mm: (!cylinder && !whole_face).then_some(5.0),
                height_mm: (!cylinder && !whole_face && !slot).then_some(8.0),
                length_mm: slot.then_some(14.0),
                depth_mm: 6.0,
                rotation_deg: 0.0,
                reason: "按用户要求修改当前点击平面".into(),
            }),
        }
    }

    fn valid_local_edge_selection() -> Value {
        json!({
            "selectionMode": "edge",
            "faces": [{
                "partId": "body",
                "stableId": "face-top",
                "geometryType": "PLANE"
            }],
            "edge": {
                "partId": "body",
                "stableFaceId": "face-top",
                "stableEdgeId": "edge-top-front"
            },
            "hit": {
                "partId": "body",
                "stableId": "face-top",
                "stableEdgeId": "edge-top-front",
                "precision": "opencascade",
                "resolutionStatus": "resolved",
                "surfaceUv": {"u": 1.0, "v": 2.0}
            }
        })
    }

    fn edge_feature_result(operation: &str) -> CodexModelCommandResult {
        CodexModelCommandResult {
            summary: "已生成受限的稳定边特征计划".into(),
            changes: vec![],
            local_feature: Some(CodexLocalCadFeaturePlan {
                operation: operation.into(),
                part_id: "body".into(),
                stable_face_id: "face-top".into(),
                stable_edge_id: Some("edge-top-front".into()),
                selected_edges: Vec::new(),
                radius_mm: None,
                width_mm: None,
                height_mm: None,
                length_mm: None,
                depth_mm: 2.0,
                rotation_deg: 0.0,
                reason: "按用户要求修改当前点击边".into(),
            }),
        }
    }

    fn manual_edge_selection_item(stable_face_id: &str, stable_edge_id: &str) -> Value {
        json!({
            "face": {
                "partId": "body",
                "stableId": stable_face_id,
                "geometryType": "PLANE"
            },
            "edge": {
                "partId": "body",
                "stableFaceId": stable_face_id,
                "stableEdgeId": stable_edge_id
            },
            "hit": {
                "partId": "body",
                "stableId": stable_face_id,
                "stableEdgeId": stable_edge_id,
                "precision": "opencascade",
                "resolutionStatus": "resolved",
                "surfaceUv": {"u": 1.0, "v": 2.0}
            }
        })
    }

    fn valid_manual_edge_selection() -> Value {
        json!({
            "selectionMode": "edge-chain",
            "revision": "revision-manual-chain",
            "edgeSelections": [
                manual_edge_selection_item("face-top", "edge-top-front"),
                manual_edge_selection_item("face-top", "edge-top-right")
            ]
        })
    }

    fn manual_edge_feature_result(operation: &str) -> CodexModelCommandResult {
        CodexModelCommandResult {
            summary: "已生成受限的手工边链特征计划".into(),
            changes: vec![],
            local_feature: Some(CodexLocalCadFeaturePlan {
                operation: operation.into(),
                part_id: "body".into(),
                stable_face_id: "face-top".into(),
                stable_edge_id: None,
                selected_edges: vec![
                    CodexSelectedEdgeTarget {
                        stable_face_id: "face-top".into(),
                        stable_edge_id: "edge-top-front".into(),
                    },
                    CodexSelectedEdgeTarget {
                        stable_face_id: "face-top".into(),
                        stable_edge_id: "edge-top-right".into(),
                    },
                ],
                radius_mm: None,
                width_mm: None,
                height_mm: None,
                length_mm: None,
                depth_mm: 1.0,
                rotation_deg: 0.0,
                reason: "按用户手工选择顺序修改两条相邻边".into(),
            }),
        }
    }

    #[test]
    fn accepts_valid_codex_manual_edge_chain_plans() {
        let context = valid_manual_edge_selection();
        for operation in ["fillet-edge-manual-chain", "chamfer-edge-manual-chain"] {
            validate_codex_model_result(&manual_edge_feature_result(operation), Some(&context))
                .expect("合法手工多选边链圆角或倒角计划应通过协议校验");
        }
    }

    #[test]
    fn rejects_codex_manual_edge_chain_list_add_remove_reorder_or_replace() {
        let context = valid_manual_edge_selection();
        let mutations: Vec<Box<dyn Fn(&mut Vec<CodexSelectedEdgeTarget>)>> = vec![
            Box::new(|edges| {
                edges.push(CodexSelectedEdgeTarget {
                    stable_face_id: "face-top".into(),
                    stable_edge_id: "edge-extra".into(),
                })
            }),
            Box::new(|edges| {
                edges.pop();
            }),
            Box::new(|edges| edges.swap(0, 1)),
            Box::new(|edges| edges[1].stable_edge_id = "edge-replaced".into()),
        ];
        for mutation in mutations {
            let mut result = manual_edge_feature_result("fillet-edge-manual-chain");
            mutation(
                &mut result
                    .local_feature
                    .as_mut()
                    .expect("feature")
                    .selected_edges,
            );
            assert!(validate_codex_model_result(&result, Some(&context))
                .expect_err("Codex 不得改变用户手工选择边列表")
                .contains("增删、排序或替换"));
        }
    }

    #[test]
    fn rejects_invalid_manual_edge_selection_count_or_unresolved_hit() {
        let mut too_few = valid_manual_edge_selection();
        too_few["edgeSelections"] =
            json!([manual_edge_selection_item("face-top", "edge-top-front")]);
        assert!(validate_codex_model_result(
            &manual_edge_feature_result("fillet-edge-manual-chain"),
            Some(&too_few),
        )
        .expect_err("少于两条手工边必须拒绝")
        .contains("2 至 64"));

        let mut too_many = valid_manual_edge_selection();
        too_many["edgeSelections"] = Value::Array(
            (0..65)
                .map(|index| manual_edge_selection_item("face-top", &format!("edge-{index}")))
                .collect(),
        );
        assert!(validate_codex_model_result(
            &manual_edge_feature_result("fillet-edge-manual-chain"),
            Some(&too_many),
        )
        .expect_err("超过六十四条手工边必须拒绝")
        .contains("2 至 64"));

        let mut unresolved = valid_manual_edge_selection();
        unresolved["edgeSelections"][1]["hit"]["resolutionStatus"] = json!("pending");
        assert!(validate_codex_model_result(
            &manual_edge_feature_result("fillet-edge-manual-chain"),
            Some(&unresolved),
        )
        .expect_err("任一手工边未完成精确解析必须拒绝")
        .contains("尚未完成 OpenCascade 精确解析"));
    }

    #[test]
    fn rejects_manual_and_single_edge_operation_mode_mismatch() {
        assert!(validate_codex_model_result(
            &manual_edge_feature_result("fillet-edge-manual-chain"),
            Some(&valid_local_edge_selection()),
        )
        .expect_err("单边上下文不得执行手工边链操作")
        .contains("点击稳定边时只允许"));

        assert!(validate_codex_model_result(
            &edge_feature_result("fillet-edge"),
            Some(&valid_manual_edge_selection()),
        )
        .expect_err("手工边链上下文不得退化为单边操作")
        .contains("手工多选边链只允许"));

        let context = valid_manual_edge_selection();
        let mut seeded = manual_edge_feature_result("chamfer-edge-manual-chain");
        seeded
            .local_feature
            .as_mut()
            .expect("feature")
            .stable_edge_id = Some("edge-top-front".into());
        assert!(validate_codex_model_result(&seeded, Some(&context))
            .expect_err("手工边链计划不得携带单一种子边")
            .contains("不能携带单一种子"));

        let context = valid_local_edge_selection();
        let mut ordinary = edge_feature_result("chamfer-edge");
        ordinary
            .local_feature
            .as_mut()
            .expect("feature")
            .selected_edges = vec![CodexSelectedEdgeTarget {
            stable_face_id: "face-top".into(),
            stable_edge_id: "edge-top-front".into(),
        }];
        assert!(validate_codex_model_result(&ordinary, Some(&context))
            .expect_err("普通单边计划必须保持 selectedEdges 为空")
            .contains("不能携带手工边列表"));
    }

    #[test]
    fn accepts_valid_codex_edge_feature_plans() {
        let context = valid_local_edge_selection();
        for operation in [
            "fillet-edge",
            "chamfer-edge",
            "fillet-edge-loop",
            "chamfer-edge-loop",
            "fillet-edge-chain",
            "chamfer-edge-chain",
        ] {
            validate_codex_model_result(&edge_feature_result(operation), Some(&context))
                .expect("合法的点击单边、切线连续边链或平面边界整圈圆角与倒角计划应通过");
        }
    }

    #[test]
    fn rejects_codex_edge_plan_without_or_switching_stable_edge() {
        let context = valid_local_edge_selection();
        let mut missing = edge_feature_result("fillet-edge");
        missing
            .local_feature
            .as_mut()
            .expect("feature")
            .stable_edge_id = None;
        assert!(validate_codex_model_result(&missing, Some(&context))
            .expect_err("缺少稳定边 ID 必须被拒绝")
            .contains("当前选择之外的稳定边"));

        let mut switched = edge_feature_result("chamfer-edge");
        switched
            .local_feature
            .as_mut()
            .expect("feature")
            .stable_edge_id = Some("edge-other".into());
        assert!(validate_codex_model_result(&switched, Some(&context))
            .expect_err("切换稳定边必须被拒绝")
            .contains("当前选择之外的稳定边"));
    }

    #[test]
    fn rejects_codex_operation_that_does_not_match_selection_mode() {
        assert!(validate_codex_model_result(
            &edge_feature_result("fillet-edge"),
            Some(&valid_local_feature_selection())
        )
        .expect_err("点击稳定面不得执行边操作")
        .contains("点击稳定面时不能执行圆角或倒角"));

        assert!(validate_codex_model_result(
            &local_feature_result("cut-cylinder"),
            Some(&valid_local_edge_selection())
        )
        .expect_err("点击稳定边不得执行平面操作")
        .contains("点击稳定边时只允许执行单边、切线连续边链或平面边界整圈圆角与倒角"));
    }

    #[test]
    fn rejects_codex_edge_plan_with_profile_fields_rotation_or_large_size() {
        let context = valid_local_edge_selection();
        let mut profile = edge_feature_result("fillet-edge");
        profile.local_feature.as_mut().expect("feature").width_mm = Some(2.0);
        assert!(validate_codex_model_result(&profile, Some(&context))
            .expect_err("边操作携带平面尺寸必须被拒绝")
            .contains("不能携带平面轮廓尺寸"));

        let mut rotation = edge_feature_result("chamfer-edge");
        rotation
            .local_feature
            .as_mut()
            .expect("feature")
            .rotation_deg = 1.0;
        assert!(validate_codex_model_result(&rotation, Some(&context))
            .expect_err("边操作携带旋转角必须被拒绝")
            .contains("不能携带平面轮廓尺寸或旋转角"));

        let mut large = edge_feature_result("fillet-edge");
        large.local_feature.as_mut().expect("feature").depth_mm = 50.01;
        assert!(validate_codex_model_result(&large, Some(&context))
            .expect_err("边尺寸超过 50 毫米必须被拒绝")
            .contains("超出安全范围"));
    }

    #[test]
    fn accepts_curved_owner_face_and_rejects_inconsistent_edge_context() {
        let result = edge_feature_result("fillet-edge");
        let mut curved = valid_local_edge_selection();
        curved["faces"][0]["geometryType"] = json!("CYLINDER");
        validate_codex_model_result(&result, Some(&curved))
            .expect("曲面所属单条稳定边圆角计划应通过受限 JSON 校验");

        let mut mismatch = valid_local_edge_selection();
        mismatch["hit"]["stableEdgeId"] = json!("edge-other");
        assert!(validate_codex_model_result(&result, Some(&mismatch))
            .expect_err("边描述与命中不一致必须被拒绝")
            .contains("稳定边描述与点击命中不一致"));
    }

    #[test]
    fn rejects_edge_loop_operation_on_curved_owner_face() {
        let mut curved = valid_local_edge_selection();
        curved["faces"][0]["geometryType"] = json!("CYLINDER");
        for operation in ["fillet-edge-loop", "chamfer-edge-loop"] {
            assert!(
                validate_codex_model_result(&edge_feature_result(operation), Some(&curved))
                    .expect_err("非平面曲面所属边不得执行整圈圆角或倒角")
                    .contains("只支持平面边界")
            );
        }

        for operation in [
            "fillet-edge",
            "chamfer-edge",
            "fillet-edge-chain",
            "chamfer-edge-chain",
        ] {
            validate_codex_model_result(&edge_feature_result(operation), Some(&curved))
                .expect("非平面曲面所属单边或切线连续边链计划应通过");
        }
    }

    #[test]
    fn accepts_valid_codex_planar_feature_plans() {
        let context = valid_local_feature_selection();
        for operation in [
            "add-cylinder",
            "cut-cylinder",
            "add-rectangle",
            "cut-rectangle",
            "cut-slot",
            "offset-face-outward",
            "offset-face-inward",
        ] {
            validate_codex_model_result(&local_feature_result(operation), Some(&context))
                .expect("合法的点击单平面局部轮廓特征计划应通过");
        }
    }

    #[test]
    fn rejects_codex_plan_targeting_another_part_or_face() {
        let context = valid_local_feature_selection();
        let mut wrong_part = local_feature_result("cut-cylinder");
        wrong_part.local_feature.as_mut().expect("feature").part_id = "cover".into();
        assert!(validate_codex_model_result(&wrong_part, Some(&context))
            .expect_err("其他零件必须被拒绝")
            .contains("当前选择之外"));

        let mut wrong_face = local_feature_result("add-cylinder");
        wrong_face
            .local_feature
            .as_mut()
            .expect("feature")
            .stable_face_id = "face-other".into();
        assert!(validate_codex_model_result(&wrong_face, Some(&context))
            .expect_err("其他稳定面必须被拒绝")
            .contains("当前选择之外"));
    }

    #[test]
    fn rejects_codex_local_feature_without_selection_or_with_parameter_changes() {
        let feature = local_feature_result("cut-cylinder");
        assert!(validate_codex_model_result(&feature, None)
            .expect_err("没有选择上下文时不得返回局部特征")
            .contains("当前没有 CAD 稳定面或稳定边选择"));

        let mut mixed = local_feature_result("add-cylinder");
        mixed.changes.push(CodexParameterChange {
            parameter: "wallThickness".into(),
            value: 2.4,
            reason: "同时修改壁厚".into(),
        });
        assert!(
            validate_codex_model_result(&mixed, Some(&valid_local_feature_selection()))
                .expect_err("参数修改与局部特征不得混合")
                .contains("不能在同一计划中同时修改")
        );
    }

    #[test]
    fn rejects_codex_local_feature_for_unsupported_selection_geometry() {
        let result = local_feature_result("cut-cylinder");

        let mut box_selection = valid_local_feature_selection();
        box_selection["selectionMode"] = json!("box");
        assert!(validate_codex_model_result(&result, Some(&box_selection))
            .expect_err("框选必须被拒绝")
            .contains("只允许点击单个稳定面、单条稳定边或手工多选边链"));

        let mut multiple_faces = valid_local_feature_selection();
        multiple_faces["faces"] = json!([
            {"partId": "body", "stableId": "face-top", "geometryType": "PLANE"},
            {"partId": "body", "stableId": "face-side", "geometryType": "PLANE"}
        ]);
        assert!(validate_codex_model_result(&result, Some(&multiple_faces))
            .expect_err("多面选择必须被拒绝")
            .contains("只能绑定一个稳定面"));

        let mut curved_face = valid_local_feature_selection();
        curved_face["faces"][0]["geometryType"] = json!("CYLINDER");
        curved_face["hit"]["surfaceTangentU"] = json!({"x": 0.0, "y": 1.0, "z": 0.0});
        validate_codex_model_result(&result, Some(&curved_face)).expect("曲面圆孔计划必须通过");
        validate_codex_model_result(&local_feature_result("add-cylinder"), Some(&curved_face))
            .expect("曲面圆形凸台计划必须通过");
        validate_codex_model_result(&local_feature_result("add-rectangle"), Some(&curved_face))
            .expect("曲面矩形凸台计划必须通过");
        validate_codex_model_result(&local_feature_result("cut-rectangle"), Some(&curved_face))
            .expect("曲面矩形孔计划必须通过");
        validate_codex_model_result(&local_feature_result("cut-slot"), Some(&curved_face))
            .expect("曲面受限槽孔计划必须通过");
        for operation in ["offset-face-outward"] {
            assert!(validate_codex_model_result(
                &local_feature_result(operation),
                Some(&curved_face)
            )
            .expect_err("曲面不受支持的操作必须被拒绝")
            .contains("只支持圆形凸台、圆孔、矩形凸台、矩形孔、受限槽孔，或对所选稳定边执行单边或切线连续边链圆角与倒角"));
        }

        let mut missing_tangent = curved_face.clone();
        missing_tangent["hit"]["surfaceTangentU"] = Value::Null;
        assert!(validate_codex_model_result(
            &local_feature_result("cut-rectangle"),
            Some(&missing_tangent)
        )
        .expect_err("曲面矩形缺失真实 U 切向必须被拒绝")
        .contains("Codex 不得生成或改写该切向"));

        let mut missing_uv = curved_face.clone();
        missing_uv["hit"]["surfaceUv"] = Value::Null;
        assert!(validate_codex_model_result(&result, Some(&missing_uv))
            .expect_err("缺失曲面 UV 必须被拒绝")
            .contains("尚未完成 OpenCascade 精确解析"));
    }

    #[test]
    fn rejects_codex_local_feature_with_mixed_profile_dimensions() {
        let context = valid_local_feature_selection();

        let mut cylinder_with_width = local_feature_result("add-cylinder");
        cylinder_with_width
            .local_feature
            .as_mut()
            .expect("feature")
            .width_mm = Some(5.0);
        assert!(
            validate_codex_model_result(&cylinder_with_width, Some(&context))
                .expect_err("圆柱携带矩形宽度必须被拒绝")
                .contains("尺寸字段不符合安全协议")
        );

        let mut rectangle_with_length = local_feature_result("cut-rectangle");
        rectangle_with_length
            .local_feature
            .as_mut()
            .expect("feature")
            .length_mm = Some(14.0);
        assert!(
            validate_codex_model_result(&rectangle_with_length, Some(&context))
                .expect_err("矩形携带槽孔长度必须被拒绝")
                .contains("高度或长度字段无效")
        );

        let mut slot_with_height = local_feature_result("cut-slot");
        slot_with_height
            .local_feature
            .as_mut()
            .expect("feature")
            .height_mm = Some(8.0);
        assert!(
            validate_codex_model_result(&slot_with_height, Some(&context))
                .expect_err("槽孔携带矩形高度必须被拒绝")
                .contains("长度或高度字段无效")
        );

        let mut whole_face_with_width = local_feature_result("offset-face-inward");
        whole_face_with_width
            .local_feature
            .as_mut()
            .expect("feature")
            .width_mm = Some(5.0);
        assert!(
            validate_codex_model_result(&whole_face_with_width, Some(&context))
                .expect_err("整面计划携带轮廓宽度必须被拒绝")
                .contains("尺寸字段不符合安全协议")
        );

        let mut whole_face_with_rotation = local_feature_result("offset-face-outward");
        whole_face_with_rotation
            .local_feature
            .as_mut()
            .expect("feature")
            .rotation_deg = 15.0;
        assert!(
            validate_codex_model_result(&whole_face_with_rotation, Some(&context))
                .expect_err("整面计划携带旋转角必须被拒绝")
                .contains("尺寸字段不符合安全协议")
        );
    }

    #[test]
    fn rejects_codex_local_feature_with_out_of_range_dimensions() {
        let context = valid_local_feature_selection();
        let mut radius = local_feature_result("add-cylinder");
        radius.local_feature.as_mut().expect("feature").radius_mm = Some(0.49);
        assert!(validate_codex_model_result(&radius, Some(&context))
            .expect_err("半径越界必须被拒绝")
            .contains("尺寸字段不符合安全协议"));

        let mut depth = local_feature_result("cut-cylinder");
        depth.local_feature.as_mut().expect("feature").depth_mm = 200.01;
        assert!(validate_codex_model_result(&depth, Some(&context))
            .expect_err("深度越界必须被拒绝")
            .contains("深度或旋转角超出"));
    }

    fn create_snapshot_fixture() -> (PathBuf, PathBuf) {
        let artifacts_dir = temporary_test_directory("version-snapshot");
        let snapshot_dir = artifacts_dir.join("versions").join("100-测试版本");
        fs::create_dir_all(&snapshot_dir).expect("create snapshot directory");
        fs::write(
            snapshot_dir.join("generation-result.json"),
            serde_json::to_vec_pretty(&json!({
              "status": "ok",
              "revision": "100",
              "outputs": ["model-main.stl", "model-main.step"],
              "parts": [{
                "id": "main",
                "role": "primary",
                "stlFile": "model-main.stl",
                "stepFile": "model-main.step"
              }],
              "assemblyFile": "model-assembly.3mf"
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");
        fs::write(
            snapshot_dir.join("model-main.stl"),
            b"solid model\nendsolid model\n",
        )
        .expect("write STL");
        fs::write(
            snapshot_dir.join("model-main.step"),
            b"ISO-10303-21;\nEND-ISO-10303-21;\n",
        )
        .expect("write STEP");
        fs::write(
            snapshot_dir.join("not-declared.stl"),
            b"solid model\nendsolid model\n",
        )
        .expect("write undeclared STL");
        (artifacts_dir, snapshot_dir)
    }

    fn create_uploaded_snapshot_fixture() -> (PathBuf, PathBuf) {
        let artifacts_dir = temporary_test_directory("uploaded-version-snapshot");
        let snapshot_dir = artifacts_dir.join("versions").join("200-上传模型");
        fs::create_dir_all(&snapshot_dir).expect("create uploaded snapshot directory");
        fs::write(
            snapshot_dir.join("version.json"),
            serde_json::to_vec_pretty(&json!({
              "id": "200",
              "label": "上传模型",
              "modelSource": "uploaded-stl",
              "modelRevision": "revision-200"
            }))
            .expect("serialize uploaded version metadata"),
        )
        .expect("write uploaded version metadata");
        fs::write(
            snapshot_dir.join("imported-model-result.json"),
            serde_json::to_vec_pretty(&json!({
              "status": "ok",
              "revision": "revision-200",
              "id": "uploaded-model",
              "sourceKind": "uploaded-stl",
              "sourceFile": "imported-model-working.stl",
              "originalSourceFile": "imported-model.stl",
              "outputs": UPLOADED_MODEL_SNAPSHOT_FILES
            }))
            .expect("serialize uploaded model manifest"),
        )
        .expect("write uploaded model manifest");
        for file_name in UPLOADED_MODEL_SNAPSHOT_FILES {
            fs::write(snapshot_dir.join(file_name), b"snapshot model")
                .expect("write uploaded snapshot file");
        }
        (artifacts_dir, snapshot_dir)
    }

    #[test]
    fn validates_uploaded_snapshot_revision_source_and_fixed_files() {
        let (artifacts_dir, snapshot_dir) = create_uploaded_snapshot_fixture();
        let resolved = version_snapshot_directory(
            snapshot_dir.to_str().expect("snapshot path"),
            &artifacts_dir,
        )
        .expect("resolve uploaded snapshot");
        validate_uploaded_model_snapshot(&resolved, "revision-200")
            .expect("valid uploaded snapshot");
        assert!(
            validate_uploaded_model_snapshot(&resolved, "revision-other")
                .expect_err("revision mismatch should fail")
                .contains("修订号不一致")
        );

        let mut metadata = read_version_snapshot_metadata_at(&resolved).expect("read metadata");
        metadata["modelSource"] = json!("cad");
        fs::write(
            resolved.join("version.json"),
            serde_json::to_vec_pretty(&metadata).expect("serialize modified metadata"),
        )
        .expect("write modified metadata");
        assert!(validate_uploaded_model_snapshot(&resolved, "revision-200")
            .expect_err("CAD source should fail")
            .contains("不是上传 STL"));
        fs::remove_dir_all(artifacts_dir).expect("remove uploaded snapshot fixture");
    }

    #[test]
    fn rejects_uploaded_snapshot_missing_working_step() {
        let (artifacts_dir, snapshot_dir) = create_uploaded_snapshot_fixture();
        fs::remove_file(snapshot_dir.join("imported-model-working.step"))
            .expect("remove working STEP");
        let resolved = version_snapshot_directory(
            snapshot_dir.to_str().expect("snapshot path"),
            &artifacts_dir,
        )
        .expect("resolve uploaded snapshot");
        assert!(validate_uploaded_model_snapshot(&resolved, "revision-200")
            .expect_err("missing STEP should fail")
            .contains("缺少文件"));
        fs::remove_dir_all(artifacts_dir).expect("remove uploaded snapshot fixture");
    }

    #[test]
    fn normalizes_frontend_parameters_for_python_worker() {
        let normalized = normalize_parameters(&json!({
          "boardLength": 58.0,
          "boardWidth": 28.0,
          "boardThickness": 1.6,
          "boardComponentHeight": 8.5,
          "clearanceXY": 0.3,
          "clearanceZ": 0.5,
          "wallThickness": 2.0,
          "baseThickness": 2.0,
          "lidThickness": 2.0,
          "cornerRadius": 4.0,
          "edgeChamfer": 0.6,
          "usbPortWidth": 11.0,
          "usbPortHeight": 6.0,
          "usbPortBottom": 2.7,
          "usbPortOffsetY": 1.5
        }))
        .expect("parameters should normalize");
        assert_eq!(normalized["corner_radius"], 4.0);
        assert_eq!(normalized["wall_thickness"], 2.0);
        assert_eq!(normalized["usb_port_offset_y"], 1.5);
    }

    #[test]
    fn normalizes_custom_interface_openings_for_python_worker() {
        let mut source = json!({
          "boardLength": 58.0,
          "boardWidth": 28.0,
          "boardThickness": 1.6,
          "boardComponentHeight": 8.5,
          "clearanceXY": 0.3,
          "clearanceZ": 0.5,
          "wallThickness": 2.0,
          "baseThickness": 2.0,
          "lidThickness": 2.0,
          "cornerRadius": 4.0,
          "edgeChamfer": 0.6,
          "usbPortWidth": 11.0,
          "usbPortHeight": 6.0,
          "usbPortBottom": 2.7,
          "usbPortOffsetY": 0.0
        });
        source["interfaceOpenings"] = json!([{
          "id": "usb-c-1",
          "label": "USB-C 接口",
          "sourceType": "USB-C",
          "face": "front",
          "shape": "rounded-rectangle",
          "widthMm": 12.0,
          "heightMm": 6.0,
          "centerUMm": 1.5,
          "centerVMm": -0.3,
          "positionReference": "face-center-bottom",
          "horizontalOffsetMm": 1.5,
          "bottomOffsetMm": 3.0,
          "cornerRadiusMm": 1.5,
          "minimumEdgeMarginMm": 1.2,
          "minimumSpacingMm": 1.2,
          "sourceConfidence": 0.94
        }]);
        let normalized = normalize_parameters(&source).expect("opening should normalize");
        assert_eq!(normalized["interface_openings"][0]["source_type"], "USB-C");
        assert_eq!(normalized["interface_openings"][0]["center_u_mm"], 1.5);
        assert_eq!(
            normalized["interface_openings"][0]["shape"],
            "rounded-rectangle"
        );
        assert_eq!(
            normalized["interface_openings"][0]["position_reference"],
            "face-center-bottom"
        );
        assert_eq!(
            normalized["interface_openings"][0]["horizontal_offset_mm"],
            1.5
        );
        assert_eq!(normalized["interface_openings"][0]["bottom_offset_mm"], 3.0);

        source["interfaceOpenings"][0]
            .as_object_mut()
            .expect("opening object")
            .remove("bottomOffsetMm");
        let error = normalize_parameters(&source).expect_err("incomplete anchor should fail");
        assert!(error.contains("照片定位锚点不完整"));
    }

    #[test]
    fn rejects_unknown_generated_files() {
        assert!(validate_generated_file("model-body.stl", Path::new(".")).is_ok());
        assert!(validate_generated_file("manufacturing-negative.step", Path::new(".")).is_ok());
        assert!(
            validate_generated_file("local-cad-feature-preflight-result.json", Path::new("."))
                .is_ok()
        );
        assert!(validate_generated_file("../../etc/passwd", Path::new(".")).is_err());
    }

    #[test]
    fn accepts_manifest_declared_generic_face_selection_assets() {
        let artifacts_dir = temporary_test_directory("generated-face-selection-assets");
        fs::create_dir_all(&artifacts_dir).expect("create artifacts directory");
        fs::write(
            artifacts_dir.join("generation-result.json"),
            r#"{"outputs":["custom-shell-selection.stl","custom-shell-face-map.json","../outside.stl"]}"#,
        )
        .expect("write generation manifest");
        fs::write(
            artifacts_dir.join("custom-shell-selection.stl"),
            b"solid selection\nendsolid selection\n",
        )
        .expect("write selection STL");
        fs::write(
            artifacts_dir.join("custom-shell-face-map.json"),
            br#"{"status":"ok","faces":[]}"#,
        )
        .expect("write face map");

        let files = generated_file_names(&artifacts_dir);
        assert!(files
            .iter()
            .any(|file| file == "custom-shell-selection.stl"));
        assert!(files
            .iter()
            .any(|file| file == "custom-shell-face-map.json"));
        assert!(!files.iter().any(|file| file == "../outside.stl"));
        assert!(validate_generated_file("custom-shell-selection.stl", &artifacts_dir).is_ok());
        assert!(validate_generated_file("custom-shell-face-map.json", &artifacts_dir).is_ok());
        assert!(validate_generated_file("custom-shell-unknown.stl", &artifacts_dir).is_err());
        assert!(validate_generated_file("../outside.stl", &artifacts_dir).is_err());
        fs::remove_dir_all(artifacts_dir).expect("remove generated asset fixture");
    }

    #[test]
    fn resolves_current_imported_model_working_file_and_rejects_invalid_paths() {
        let root = std::env::temp_dir().join(format!(
            "formai-imported-source-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create temporary directory");
        fs::write(
            root.join("imported-model-working.stl"),
            b"solid model\nendsolid model\n",
        )
        .expect("write working STL");
        fs::write(
            root.join("imported-model-result.json"),
            r#"{"sourceFile":"imported-model-working.stl"}"#,
        )
        .expect("write manifest");
        assert_eq!(
            imported_model_source_file(&root).expect("resolve working STL"),
            "imported-model-working.stl"
        );

        fs::write(
            root.join("imported-model-result.json"),
            r#"{"sourceFile":"../../outside.stl"}"#,
        )
        .expect("write invalid manifest");
        assert!(imported_model_source_file(&root)
            .expect_err("reject traversal")
            .contains("工作文件名无效"));

        fs::write(
            root.join("imported-model-result.json"),
            r#"{"sourceFile":"missing.stl"}"#,
        )
        .expect("write missing manifest");
        assert!(imported_model_source_file(&root)
            .expect_err("reject missing file")
            .contains("没有找到上传模型工作文件"));
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn snapshot_file_list_only_contains_current_cad_manifest_outputs() {
        let artifacts_dir = temporary_test_directory("snapshot-file-list");
        fs::create_dir_all(&artifacts_dir).expect("create artifacts directory");
        fs::write(
            artifacts_dir.join("generation-result.json"),
            serde_json::to_vec_pretty(&json!({
              "status": "ok",
              "outputs": ["model-main.stl", "model-main.step", "model-assembly.3mf", "model-main-selection.stl", "model-main-face-map.json"],
              "parts": [{
                "id": "main",
                "stlFile": "model-main.stl",
                "stepFile": "model-main.step"
              }],
              "assemblyFile": "model-assembly.3mf"
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");
        for file_name in [
            "model-main.stl",
            "model-main.step",
            "model-assembly.3mf",
            "model-main-selection.stl",
            "model-main-face-map.json",
        ] {
            fs::write(artifacts_dir.join(file_name), b"fixture").expect("write model file");
        }
        fs::write(
            artifacts_dir.join("version-difference-result.json"),
            r#"{"outputs":["version-difference-old-added.stl"]}"#,
        )
        .expect("write difference result");
        fs::write(
            artifacts_dir.join("version-difference-old-added.stl"),
            b"solid difference\nendsolid difference\n",
        )
        .expect("write difference STL");
        fs::write(
            artifacts_dir.join("wall-thickness-result.json"),
            r#"{"outputs":[]}"#,
        )
        .expect("write wall result");

        let files =
            version_snapshot_generated_file_names(&artifacts_dir).expect("resolve snapshot files");
        assert_eq!(
            files,
            vec![
                "generation-result.json",
                "model-main.stl",
                "model-main.step",
                "model-assembly.3mf",
                "model-main-selection.stl",
                "model-main-face-map.json"
            ]
        );
        assert!(!files.iter().any(|file| file.contains("version-difference")));
        assert!(!files.iter().any(|file| file.contains("wall-thickness")));
        fs::remove_dir_all(artifacts_dir).expect("remove snapshot fixture");
    }

    #[test]
    fn snapshot_file_list_rejects_missing_or_traversing_declared_files() {
        let artifacts_dir = temporary_test_directory("snapshot-file-validation");
        fs::create_dir_all(&artifacts_dir).expect("create artifacts directory");
        fs::write(
            artifacts_dir.join("generation-result.json"),
            r#"{"outputs":["../outside.step"],"parts":[]}"#,
        )
        .expect("write invalid manifest");
        assert!(version_snapshot_generated_file_names(&artifacts_dir)
            .expect_err("reject traversal")
            .contains("文件名无效"));

        fs::write(
            artifacts_dir.join("generation-result.json"),
            r#"{"outputs":["missing.step"],"parts":[]}"#,
        )
        .expect("write missing manifest");
        assert!(version_snapshot_generated_file_names(&artifacts_dir)
            .expect_err("reject missing file")
            .contains("声明的文件不存在"));
        fs::remove_dir_all(artifacts_dir).expect("remove snapshot fixture");
    }

    #[test]
    fn reads_manifest_and_declared_file_from_version_snapshot() {
        let (artifacts_dir, snapshot_dir) = create_snapshot_fixture();
        let resolved = version_snapshot_directory(
            snapshot_dir.to_str().expect("snapshot path"),
            &artifacts_dir,
        )
        .expect("resolve snapshot directory");
        let manifest = read_version_snapshot_manifest_at(&resolved).expect("read manifest");
        assert_eq!(manifest["revision"], "100");
        let file_path = version_snapshot_file_path(
            snapshot_dir.to_str().expect("snapshot path"),
            "model-main.stl",
            &artifacts_dir,
        )
        .expect("resolve declared STL");
        assert_eq!(
            file_path,
            fs::canonicalize(snapshot_dir.join("model-main.stl")).expect("canonical STL path")
        );
        fs::remove_dir_all(artifacts_dir).expect("remove snapshot fixture");
    }

    #[test]
    fn validates_snapshot_step_files_for_exact_difference() {
        let (artifacts_dir, snapshot_dir) = create_snapshot_fixture();
        let resolved = version_snapshot_directory(
            snapshot_dir.to_str().expect("snapshot path"),
            &artifacts_dir,
        )
        .expect("resolve snapshot directory");
        let manifest = read_version_snapshot_manifest_at(&resolved).expect("read manifest");
        validate_version_snapshot_step_files(&resolved, &manifest)
            .expect("declared direct STEP should be accepted");

        fs::remove_file(snapshot_dir.join("model-main.step")).expect("remove STEP");
        assert!(validate_version_snapshot_step_files(&resolved, &manifest)
            .expect_err("missing STEP should fail")
            .contains("缺少零件 STEP 文件"));
        fs::remove_dir_all(artifacts_dir).expect("remove snapshot fixture");
    }

    #[test]
    fn validates_only_declared_exact_difference_stl_outputs() {
        let artifacts_dir = temporary_test_directory("version-difference-output");
        fs::create_dir_all(&artifacts_dir).expect("create artifacts directory");
        fs::write(
            artifacts_dir.join("version-difference-001-added.stl"),
            b"solid difference\nendsolid difference\n",
        )
        .expect("write difference STL");
        let result = json!({
            "status": "ok",
            "outputs": ["version-difference-001-added.stl"]
        });
        validate_version_difference_outputs(&artifacts_dir, &result)
            .expect("valid difference output should pass");

        let invalid = json!({"status": "ok", "outputs": ["../outside.stl"]});
        assert!(
            validate_version_difference_outputs(&artifacts_dir, &invalid)
                .expect_err("traversal should fail")
                .contains("输出文件名无效")
        );
        let undeclared_name = json!({"status": "ok", "outputs": ["model-body.stl"]});
        assert!(
            validate_version_difference_outputs(&artifacts_dir, &undeclared_name)
                .expect_err("unscoped name should fail")
                .contains("输出文件名无效")
        );
        fs::remove_dir_all(artifacts_dir).expect("remove difference fixture");
    }

    #[test]
    fn rejects_version_snapshot_path_traversal_and_outside_directories() {
        let (artifacts_dir, snapshot_dir) = create_snapshot_fixture();
        assert!(version_snapshot_file_path(
            snapshot_dir.to_str().expect("snapshot path"),
            "../model-main.stl",
            &artifacts_dir,
        )
        .expect_err("reject traversal")
        .contains("不允许访问版本快照文件"));

        let outside_dir = temporary_test_directory("outside-version-snapshot");
        fs::create_dir_all(&outside_dir).expect("create outside directory");
        assert!(version_snapshot_directory(
            outside_dir.to_str().expect("outside path"),
            &artifacts_dir,
        )
        .expect_err("reject outside directory")
        .contains("版本快照目录之外"));
        fs::remove_dir_all(outside_dir).expect("remove outside directory");
        fs::remove_dir_all(artifacts_dir).expect("remove snapshot fixture");
    }

    #[test]
    fn rejects_undeclared_version_snapshot_files() {
        let (artifacts_dir, snapshot_dir) = create_snapshot_fixture();
        assert!(version_snapshot_file_path(
            snapshot_dir.to_str().expect("snapshot path"),
            "not-declared.stl",
            &artifacts_dir,
        )
        .expect_err("reject undeclared file")
        .contains("清单未声明文件"));
        fs::remove_dir_all(artifacts_dir).expect("remove snapshot fixture");
    }

    #[test]
    fn reports_missing_version_snapshot_manifest_in_chinese() {
        let artifacts_dir = temporary_test_directory("missing-version-manifest");
        let snapshot_dir = artifacts_dir.join("versions").join("101-空快照");
        fs::create_dir_all(&snapshot_dir).expect("create empty snapshot");
        let resolved = version_snapshot_directory(
            snapshot_dir.to_str().expect("snapshot path"),
            &artifacts_dir,
        )
        .expect("resolve snapshot directory");
        assert!(read_version_snapshot_manifest_at(&resolved)
            .expect_err("missing manifest should fail")
            .contains("缺少精确模型清单"));
        fs::remove_dir_all(artifacts_dir).expect("remove empty snapshot fixture");
    }

    fn transformed_export_fixture(artifacts_dir: &Path) -> TransformedExportRequest {
        fs::write(
            artifacts_dir.join("model-body.stl"),
            b"solid body\nendsolid body\n",
        )
        .expect("write source STL");
        TransformedExportRequest {
            output_file_name: "测试模型-视口变换.stl".into(),
            format: "stl".into(),
            objects: vec![TransformedExportObject {
                id: "body".into(),
                name: "模型主体".into(),
                source_file: "model-body.stl".into(),
                color: "#d9d4c8".into(),
                transform: ExportObjectTransform {
                    position_mm: ExportVector3 {
                        x: 1.0,
                        y: 2.0,
                        z: 3.0,
                    },
                    rotation_deg: ExportVector3 {
                        x: 0.0,
                        y: 90.0,
                        z: 0.0,
                    },
                    scale: 1.25,
                },
                base_position_display_mm: None,
            }],
        }
    }

    #[test]
    fn validates_safe_transformed_export_request() {
        let artifacts_dir = temporary_test_directory("transformed-export");
        fs::create_dir_all(&artifacts_dir).expect("create artifacts");
        let request = transformed_export_fixture(&artifacts_dir);
        validate_transformed_export_request(&request, &artifacts_dir)
            .expect("valid request should pass");
        fs::remove_dir_all(artifacts_dir).expect("remove export fixture");
    }

    #[test]
    fn rejects_transformed_export_traversal_and_invalid_scale() {
        let artifacts_dir = temporary_test_directory("invalid-transformed-export");
        fs::create_dir_all(&artifacts_dir).expect("create artifacts");
        let mut request = transformed_export_fixture(&artifacts_dir);
        request.output_file_name = "../escape.stl".into();
        assert!(
            validate_transformed_export_request(&request, &artifacts_dir)
                .expect_err("traversal should fail")
                .contains("文件名或格式不合法")
        );
        request.output_file_name = "安全输出.stl".into();
        request.objects[0].transform.scale = 100.0;
        assert!(
            validate_transformed_export_request(&request, &artifacts_dir)
                .expect_err("invalid scale should fail")
                .contains("缩放不合法")
        );
        fs::remove_dir_all(artifacts_dir).expect("remove export fixture");
    }
}
