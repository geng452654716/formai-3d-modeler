mod backend;

use backend::{
    analyze_reference_image, analyze_wall_thickness, backend_status, create_version_snapshot,
    export_generated_file, export_transformed_model, generate_cad, import_stl_model,
    load_version_snapshot, read_generated_file, read_version_snapshot_file,
    resolve_cad_surface_hit, run_codex_model_command, run_local_cad_feature, run_local_stl_edit,
    run_manufacturing_split, run_mesh_element_edit, run_version_geometry_difference, BackendState,
};
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::Manager;

#[cfg(target_os = "macos")]
fn build_chinese_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let about = AboutMetadata {
        name: Some("FormAI".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        comments: Some("面向三维打印的 AI 参数化建模软件".into()),
        copyright: Some("© 2026 FormAI".into()),
        ..Default::default()
    };

    let application_menu = Submenu::with_items(
        app,
        "FormAI",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 FormAI"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏 FormAI"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他应用"))?,
            &PredefinedMenuItem::show_all(app, Some("显示全部"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("退出 FormAI"))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[&PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放窗口"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &application_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let resource_dir = app.path().resource_dir().ok();
            let app_data_dir = app.path().app_data_dir().ok();
            app.manage(BackendState::new(resource_dir, app_data_dir));
            #[cfg(target_os = "macos")]
            app.set_menu(build_chinese_menu(app)?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_status,
            analyze_reference_image,
            generate_cad,
            import_stl_model,
            run_manufacturing_split,
            run_local_stl_edit,
            run_mesh_element_edit,
            run_local_cad_feature,
            resolve_cad_surface_hit,
            analyze_wall_thickness,
            run_version_geometry_difference,
            read_generated_file,
            load_version_snapshot,
            read_version_snapshot_file,
            export_generated_file,
            export_transformed_model,
            create_version_snapshot,
            run_codex_model_command
        ])
        .run(tauri::generate_context!())
        .expect("FormAI 运行失败");
}
