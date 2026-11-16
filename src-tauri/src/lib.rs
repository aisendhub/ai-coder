use tauri::Manager;

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  // Only allow the local ai-coder server to be opened from the webview.
  let local = url.starts_with("http://localhost:")
    || url.starts_with("http://127.0.0.1:")
    || url.starts_with("https://localhost:")
    || url.starts_with("https://127.0.0.1:");
  if !local {
    return Err("refusing to open a non-local URL".into());
  }
  open::that(url).map_err(|error| error.to_string())
}

/// Restart the local API server (scripts/restart-server.sh). The script owns
/// the port cleanup, detached start and health wait, so the webview only has
/// to reload once this returns Ok.
#[tauri::command]
fn restart_server() -> Result<String, String> {
  let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .ok_or_else(|| "cannot resolve repo root".to_string())?
    .to_path_buf();
  let script = root.join("scripts").join("restart-server.sh");
  if !script.is_file() {
    return Err(format!("restart script not found at {}", script.display()));
  }
  let output = std::process::Command::new("bash")
    .arg(&script)
    .current_dir(&root)
    .output()
    .map_err(|error| error.to_string())?;
  if output.status.success() {
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
  } else {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
  }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Reopening the app focuses the existing window instead of spawning a
    // second instance.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .invoke_handler(tauri::generate_handler![open_external, restart_server])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
