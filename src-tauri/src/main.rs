#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
#[derive(serde::Deserialize)]
struct Session {
    url: String,
    token: String,
    pid: u32,
}
struct EngineChild {
    child: Mutex<Option<CommandChild>>,
    owned: AtomicBool,
    exiting: AtomicBool,
    terminated: AtomicBool,
    exit_ready: AtomicBool,
}
fn session() -> Result<Session, String> {
    let root = std::env::var_os("SHADER_DATA_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".shader")))
        .ok_or("Home directory unavailable")?;
    let bytes = std::fs::read(root.join("session.json"))
        .map_err(|_| "Camera engine is starting. Try again shortly.")?;
    let s: Session = serde_json::from_slice(&bytes).map_err(|_| "Invalid engine session")?;
    let url = reqwest::Url::parse(&s.url).map_err(|_| "Invalid engine address")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || s.token.len() != 64
    {
        return Err("Invalid local engine session".into());
    }
    Ok(s)
}
#[tauri::command]
async fn camera_command(
    name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let s = session()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .no_proxy()
        .build()
        .map_err(|_| "Could not create engine client")?;
    let response = client
        .post(format!("{}/rpc", s.url))
        .bearer_auth(s.token)
        .json(&serde_json::json!({"name":name,"args":args,"actor":"ui"}))
        .send()
        .await
        .map_err(|_| "Camera engine is unavailable. Restart Shader.")?;
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Invalid engine response")?;
    if let Some(e) = value.get("error") {
        return Err(e.as_str().unwrap_or("Camera command failed").into());
    }
    Ok(value["result"].clone())
}
#[tauri::command]
async fn choose_recording_directory(
    app: tauri::AppHandle,
    current: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file().set_title("Choose recording folder");
        if let Some(path) = current.filter(|p| std::path::Path::new(p).is_dir()) {
            picker = picker.set_directory(path);
        }
        picker
            .blocking_pick_folder()
            .map(|f| {
                f.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

// The Windows updater exits directly after starting NSIS, so stop the owned engine first.
#[tauri::command]
async fn prepare_update_restart(app: tauri::AppHandle) -> Result<(), String> {
    let status = camera_command("system_status".into(), serde_json::json!({})).await?;
    if !status["recorder"]["active"].is_null() {
        return Err("Stop and finalize the recording before installing an update".into());
    }
    let cameras = status["cameras"]
        .as_array()
        .ok_or("Camera state unavailable")?;
    if cameras
        .iter()
        .any(|camera| camera["writing"].as_bool().unwrap_or(true))
    {
        return Err("Wait for camera changes to finish before installing an update".into());
    }
    let jobs = status["presetJobs"]
        .as_array()
        .ok_or("Preset state unavailable")?;
    if jobs
        .iter()
        .any(|job| matches!(job["status"].as_str(), Some("queued" | "running")))
    {
        return Err("Wait for camera preset recalls to finish before installing".into());
    }
    let session = session()?;
    let owned = app
        .state::<EngineChild>()
        .child
        .lock()
        .unwrap()
        .as_ref()
        .map(|child| child.pid() == session.pid)
        .unwrap_or(false);
    if !owned {
        return Err("Restart Shader with its own camera engine before installing an update".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    client
        .post(format!("{}/shutdown", session.url))
        .bearer_auth(session.token)
        .send()
        .await
        .map_err(|_| "Could not stop camera engine safely")?
        .error_for_status()
        .map_err(|_| "Camera engine refused shutdown")?;
    for _ in 0..100 {
        if app.state::<EngineChild>().terminated.load(Ordering::SeqCst) {
            app.state::<EngineChild>()
                .exit_ready
                .store(true, Ordering::SeqCst);
            return Ok(());
        }
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(50))
        })
        .await;
    }
    Err("Camera engine did not stop in time. Restart Shader before trying again.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(EngineChild {
            child: Mutex::new(None),
            owned: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
        })
        .setup(|app| {
            // macOS native Quit bypasses ExitRequested; a normal menu item routes through AppHandle::exit.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(submenu) = item {
                        for (index, item) in submenu.items()?.into_iter().enumerate() {
                            if let MenuItemKind::Predefined(item) = item {
                                if item.text()?.starts_with("Quit") {
                                    submenu.remove(&item)?;
                                    submenu.insert(
                                        &MenuItem::with_id(
                                            app,
                                            "shader-quit",
                                            "Quit Shader",
                                            true,
                                            Some("CmdOrCtrl+Q"),
                                        )?,
                                        index,
                                    )?;
                                }
                            }
                        }
                    }
                }
                app.set_menu(menu)?;
                app.on_menu_event(|handle, event| {
                    if event.id().as_ref() == "shader-quit" {
                        handle.exit(0);
                    }
                });
            }
            let decklink_bridge = if cfg!(target_os = "windows") {
                std::env::var_os("SHADER_DECKLINK_BRIDGE")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(
                        app.path()
                            .resource_dir()?
                            .join("decklink/shader-decklink.exe"),
                    )
            } else {
                std::path::PathBuf::new()
            };
            let (mut events, child) = app
                .shell()
                .sidecar("shader-engine")?
                .env(
                    "SHADER_FFMPEG",
                    std::env::var_os("SHADER_FFMPEG")
                        .map(std::path::PathBuf::from)
                        .unwrap_or(std::env::current_exe()?.with_file_name(
                            if cfg!(target_os = "windows") {
                                "ffmpeg.exe"
                            } else {
                                "ffmpeg"
                            },
                        )),
                )
                .env(
                    "SHADER_SONY_BRIDGE",
                    std::env::var_os("SHADER_SONY_BRIDGE")
                        .map(std::path::PathBuf::from)
                        .unwrap_or(app.path().resource_dir()?.join(
                            if cfg!(target_os = "windows") {
                                "sony/shader-sony.exe"
                            } else {
                                "sony/shader-sony"
                            },
                        )),
                )
                .env("SHADER_DECKLINK_BRIDGE", decklink_bridge)
                .env(
                    "SHADER_RECORDER",
                    std::env::var_os("SHADER_RECORDER")
                        .map(std::path::PathBuf::from)
                        .unwrap_or(app.path().resource_dir()?.join(
                            if cfg!(target_os = "windows") {
                                "recorder/shader-recorder.exe"
                            } else {
                                "recorder/shader-recorder"
                            },
                        )),
                )
                .spawn()?;
            *app.state::<EngineChild>().child.lock().unwrap() = Some(child);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                if value["ready"] == true && value["reused"] != true {
                                    handle
                                        .state::<EngineChild>()
                                        .owned
                                        .store(true, Ordering::SeqCst);
                                }
                            }
                        }
                        CommandEvent::Terminated(_) => {
                            handle
                                .state::<EngineChild>()
                                .terminated
                                .store(true, Ordering::SeqCst);
                        }
                        CommandEvent::Error(_) => {
                            eprintln!("Shader camera engine process reported an error")
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            camera_command,
            prepare_update_restart,
            choose_recording_directory
        ])
        .build(tauri::generate_context!())
        .expect("Could not launch Shader")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                let state = app.state::<EngineChild>();
                let owns_session = session()
                    .ok()
                    .map(|s| {
                        state
                            .child
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|c| c.pid() == s.pid)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if (state.owned.load(Ordering::SeqCst) || owns_session)
                    && !state.exit_ready.load(Ordering::SeqCst)
                {
                    api.prevent_exit();
                    if state.exiting.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Ok(s) = session() {
                            if let Ok(client) = reqwest::Client::builder()
                                .timeout(std::time::Duration::from_secs(10))
                                .no_proxy()
                                .build()
                            {
                                let result = client
                                    .post(format!("{}/shutdown", s.url))
                                    .bearer_auth(s.token)
                                    .send()
                                    .await;
                                if result
                                    .as_ref()
                                    .map(|r| !r.status().is_success())
                                    .unwrap_or(true)
                                {
                                    handle
                                        .state::<EngineChild>()
                                        .exiting
                                        .store(false, Ordering::SeqCst);
                                    if let Some(window) = handle.get_webview_window("main") {
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                    let _ = handle.emit(
                                        "recorder-needs-attention",
                                        "Stop and finalize recording before quitting",
                                    );
                                    return;
                                }
                            }
                        }
                        // Wait for the engine to remove its descriptor and release the singleton
                        // lock. Receiving the HTTP response alone does not mean it has exited.
                        let waiter = handle.clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            for _ in 0..60 {
                                if waiter
                                    .state::<EngineChild>()
                                    .terminated
                                    .load(Ordering::SeqCst)
                                {
                                    break;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                        })
                        .await;
                        handle
                            .state::<EngineChild>()
                            .exit_ready
                            .store(true, Ordering::SeqCst);
                        handle.exit(0);
                    });
                }
            }
            tauri::RunEvent::Exit => {
                if let Some(child) = app.state::<EngineChild>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
