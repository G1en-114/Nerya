#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, webview::NewWindowResponse, Manager, WebviewUrl, WebviewWindow};
mod notifications;
use tauri_plugin_opener::OpenerExt;

type Reply = Result<Value, String>;
#[derive(Default)]
struct Inner {
    snapshot: Mutex<Value>,
    notification_error: Mutex<Option<String>>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    serial: AtomicU64,
    stopping: AtomicBool,
}
#[derive(Clone, Default)]
struct Desktop(Arc<Inner>);

fn same_origin(actual: &tauri::Url, expected: &str) -> bool {
    tauri::Url::parse(expected).map(|url| actual.origin() == url.origin()).unwrap_or(false)
}
fn trusted_app_url(url: &tauri::Url, snapshot: &Value) -> bool {
    url.scheme() == "tauri" ||
        (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")) ||
        snapshot["local_url"].as_str().is_some_and(|expected| same_origin(url, expected))
}
fn external_browser_url(url: &tauri::Url, snapshot: &Value) -> bool {
    matches!(url.scheme(), "http" | "https") && !trusted_app_url(url, snapshot)
}
fn trusted_window(window: &WebviewWindow, state: &Desktop) -> Result<(), String> {
    let url = window.url().map_err(|_| "window_unavailable")?;
    let snapshot = state.0.snapshot.lock().map_err(|_| "desktop_lock_failed")?;
    if window.label() == "main" && trusted_app_url(&url, &snapshot) { Ok(()) }
    else { Err("untrusted_desktop_origin".into()) }
}
fn request(state: Desktop, options: Value) -> Reply {
    let id = state.0.serial.fetch_add(1, Ordering::Relaxed);
    let (send, receive) = mpsc::channel();
    state.0.pending.lock().map_err(|_| "desktop_lock_failed")?.insert(id, send);
    let result = (|| {
        let mut input = state.0.stdin.lock().map_err(|_| "desktop_lock_failed")?;
        let stream = input.as_mut().ok_or("desktop_not_running")?;
        writeln!(stream, "{}", json!({"id": id, "action": "configure", "options": options}))
            .and_then(|_| stream.flush()).map_err(|_| "desktop_not_running")?;
        drop(input);
        receive.recv_timeout(Duration::from_secs(20)).map_err(|_| "desktop_command_timeout")?
    })();
    state.0.pending.lock().map_err(|_| "desktop_lock_failed")?.remove(&id);
    result
}

fn desktop_snapshot(app: &tauri::AppHandle, state: &Desktop) -> Reply {
    let mut snapshot = state.0.snapshot.lock().map_err(|_| "desktop_lock_failed")?.clone();
    snapshot["desktop_version"] = json!(env!("CARGO_PKG_VERSION"));
    if snapshot["phase"] == "ready" {
        snapshot["notification_permission"] = json!(notifications::permission(app, false).unwrap_or("unknown"));
        snapshot["notification_error"] = json!(state.0.notification_error.lock().map_err(|_| "desktop_lock_failed")?.clone());
    }
    Ok(snapshot)
}
#[tauri::command]
async fn desktop_status(app: tauri::AppHandle, window: WebviewWindow, state: tauri::State<'_, Desktop>) -> Reply {
    trusted_window(&window, &state)?;
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || desktop_snapshot(&app, &owned))
        .await.map_err(|_| "desktop_command_failed")?
}
#[tauri::command]
async fn desktop_configure(app: tauri::AppHandle, window: WebviewWindow,
                           state: tauri::State<'_, Desktop>, options: Value) -> Reply {
    trusted_window(&window, &state)?;
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if options.get("notifications") == Some(&Value::Bool(true)) { notifications::authorize(&app)?; }
        request(owned.clone(), options)?;
        *owned.0.notification_error.lock().map_err(|_| "desktop_lock_failed")? = None;
        desktop_snapshot(&app, &owned)
    }).await.map_err(|_| "desktop_command_failed")?
}
#[tauri::command]
async fn desktop_test_notification(app: tauri::AppHandle, window: WebviewWindow,
                                  state: tauri::State<'_, Desktop>) -> Reply {
    trusted_window(&window, &state)?;
    let snapshot = state.0.snapshot.lock().map_err(|_| "desktop_lock_failed")?.clone();
    if snapshot["notifications"] != true { return Err("notifications_disabled".into()); }
    let owned = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = notifications::send(&app, 1, snapshot["language"].as_str().unwrap_or("en"), true);
        *owned.0.notification_error.lock().map_err(|_| "desktop_lock_failed")? = result.as_ref().err().cloned();
        result
    }).await.map_err(|_| "desktop_command_failed")?
}
#[tauri::command]
fn desktop_notification_settings(app: tauri::AppHandle, window: WebviewWindow, state: tauri::State<Desktop>) -> Result<(), String> {
    trusted_window(&window, &state)?;
    #[cfg(target_os = "macos")]
    return app.opener().open_url("x-apple.systempreferences:com.apple.Notifications-Settings.extension", None::<&str>)
        .map_err(|_| "notification_settings_unavailable".into());
    #[cfg(target_os = "windows")]
    return app.opener().open_url("ms-settings:notifications", None::<&str>)
        .map_err(|_| "notification_settings_unavailable".into());
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("notification_settings_unavailable".into())
}
#[tauri::command]
fn desktop_start_dragging(window: WebviewWindow, state: tauri::State<Desktop>) -> Result<(), String> {
    trusted_window(&window, &state)?;
    window.start_dragging().map_err(|_| "window_drag_unavailable".into())
}
#[tauri::command]
fn desktop_quit(app: tauri::AppHandle, window: WebviewWindow, state: tauri::State<Desktop>) -> Result<(), String> {
    trusted_window(&window, &state)?;
    app.exit(0);
    Ok(())
}

fn stop(state: &Desktop) {
    if state.0.stopping.swap(true, Ordering::SeqCst) { return; }
    if let Ok(mut input) = state.0.stdin.lock() {
        if let Some(mut stream) = input.take() { let _ = writeln!(stream, "{}", json!({"action": "shutdown"})); }
    }
    if let Ok(mut guard) = state.0.child.lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) { break; }
                thread::sleep(Duration::from_millis(80));
            }
            // The supervisor owns a private process group. Do not touch other Nerya instances.
            #[cfg(unix)]
            unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
            #[cfg(windows)]
            if matches!(child.try_wait(), Ok(None)) {
                let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn manifest_path(base: &Path, manifest: &Value, key: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(manifest[key].as_str().ok_or("invalid_runtime_manifest")?);
    if !cfg!(debug_assertions) && (path.is_absolute() || path.components().any(|p| matches!(p, std::path::Component::ParentDir))) {
        return Err("invalid_packaged_resource".into());
    }
    Ok(base.join(path))
}
fn launch(app: tauri::AppHandle, state: Desktop) -> Result<(), String> {
    let resources = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime")
    } else { app.path().resource_dir().map_err(|_| "resources_unavailable")?.join("runtime") };
    let manifest: Value = serde_json::from_slice(&fs::read(resources.join("manifest.json"))
        .map_err(|_| "runtime_not_packaged")?).map_err(|_| "invalid_runtime_manifest")?;
    if !cfg!(debug_assertions) && manifest["dev"] == true { return Err("development_runtime_in_release".into()); }
    let data = app.path().app_data_dir().map_err(|_| "data_directory_unavailable")?;
    fs::create_dir_all(&data).map_err(|_| "data_directory_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).map_err(|_| "data_directory_unavailable")?;
    }
    let log = OpenOptions::new().create(true).append(true).open(data.join("desktop-runtime.log"))
        .map_err(|_| "runtime_log_unavailable")?;
    let python = manifest_path(&resources, &manifest, "python")?;
    let mut command = Command::new(python);
    #[cfg(target_os = "macos")]
    command.env("NERYA_VAULT_PASSPHRASE", notifications::vault_key()?);
    command.args(["-u"]).arg(resources.join("runtime_host.py"))
        .arg("--resources").arg(&resources).arg("--data-dir").arg(&data)
        .current_dir(&data).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log))
        .env("PYTHONNOUSERSITE", "1").env("PYTHONDONTWRITEBYTECODE", "1")
        .env_remove("PYTHONHOME");
    let python_paths = manifest["python_paths"].as_array().ok_or("invalid_runtime_manifest")?
        .iter().map(|value| resources.join(value.as_str().unwrap_or(""))).collect::<Vec<_>>();
    command.env("PYTHONPATH", std::env::join_paths(python_paths).map_err(|_| "invalid_runtime_manifest")?);
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "runtime_launch_failed")?;
    let output = child.stdout.take().ok_or("runtime_pipe_failed")?;
    *state.0.stdin.lock().unwrap() = child.stdin.take();
    *state.0.child.lock().unwrap() = Some(child);
    let mut navigated = false;
    for line in BufReader::new(output).lines() {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(id) = event["id"].as_u64() {
            if let Some(sender) = state.0.pending.lock().unwrap().remove(&id) {
                let result = event["error"].as_str().map(|e| Err(e.to_owned())).unwrap_or_else(|| Ok(event["result"].clone()));
                let _ = sender.send(result);
            }
        } else if event["event"] == "state" {
            let snapshot = event["state"].clone();
            *state.0.snapshot.lock().unwrap() = snapshot.clone();
            if !navigated && snapshot["phase"] == "ready" {
                if let (Some(window), Some(base)) = (app.get_webview_window("main"), snapshot["local_url"].as_str()) {
                    let url = format!("{}{}", base, snapshot["start_path"].as_str().unwrap_or("/"));
                    if let Ok(url) = tauri::Url::parse(&url) {
                        window.navigate(url).map_err(|_| "desktop_navigation_failed")?;
                        navigated = true;
                    }
                }
            }
        } else if event["event"] == "notification" && state.0.snapshot.lock().unwrap()["notifications"] == true {
            let result = notifications::send(&app, event["count"].as_u64().unwrap_or(1), event["language"].as_str().unwrap_or("en"), false);
            *state.0.notification_error.lock().unwrap() = result.err();
        }
    }
    if !state.0.stopping.load(Ordering::SeqCst) { return Err("runtime_stopped".into()); }
    Ok(())
}

fn main() {
    let state = Desktop::default();
    *state.0.snapshot.lock().unwrap() = json!({"phase": "starting", "sharing": false, "notifications": false});
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![desktop_status, desktop_configure, desktop_test_notification, desktop_notification_settings, desktop_start_dragging, desktop_quit])
        .setup(|app| {
            notifications::initialize(app.handle().clone());
            let navigation_handle = app.handle().clone();
            let navigation_state = app.state::<Desktop>().inner().clone();
            let new_window_handle = app.handle().clone();
            let new_window_state = app.state::<Desktop>().inner().clone();
            let window_builder = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Nerya").inner_size(1280.0, 850.0).min_inner_size(760.0, 560.0);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            window_builder.on_navigation(move |url| {
                let snapshot = navigation_state.0.snapshot.lock().unwrap();
                if trusted_app_url(url, &snapshot) { return true; }
                if external_browser_url(url, &snapshot) {
                    let _ = navigation_handle.opener().open_url(url.as_str(), None::<&str>);
                }
                false
            }).on_new_window(move |url, _features| {
                let internal = {
                    let snapshot = new_window_state.0.snapshot.lock().unwrap();
                    trusted_app_url(&url, &snapshot)
                };
                if internal {
                    if let Some(window) = new_window_handle.get_webview_window("main") {
                        let _ = window.navigate(url);
                    }
                } else if matches!(url.scheme(), "https" | "http") {
                    let _ = new_window_handle.opener().open_url(url.as_str(), None::<&str>);
                }
                NewWindowResponse::Deny
            }).build()?;
            let show = MenuItem::with_id(app, "show", "Open Nerya / 打开", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Nerya / 退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new().tooltip("Nerya").menu(&menu).on_menu_event(|app, event| {
                match event.id.as_ref() {
                    "show" => if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); },
                    "quit" => app.exit(0),
                    _ => {}
                }
            });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;
            let handle = app.handle().clone();
            let owned = app.state::<Desktop>().inner().clone();
            // Keep runtime startup isolated so dev-mode source changes can restart cleanly.
            thread::spawn(move || {
                if let Err(error) = launch(handle.clone(), owned.clone()) {
                    owned.0.snapshot.lock().unwrap()["phase"] = json!("failed");
                    owned.0.snapshot.lock().unwrap()["error"] = json!(error);
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate(tauri::Url::parse(if cfg!(target_os = "windows") { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" }).unwrap());
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); }
        })
        .build(tauri::generate_context!()).expect("Cannot initialize Nerya desktop");
    app.run(move |_app, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            if let Some(window) = _app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        if matches!(event, tauri::RunEvent::Exit) { stop(&state); }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipc_origin_is_exact_including_port() {
        let expected = "http://127.0.0.1:18380";
        assert!(same_origin(&tauri::Url::parse("http://127.0.0.1:18380/settings").unwrap(), expected));
        for url in ["http://127.0.0.1:1", "http://localhost:18380", "https://127.0.0.1:18380", "http://example.com"] {
            assert!(!same_origin(&tauri::Url::parse(url).unwrap(), expected));
        }
    }

    #[test]
    fn external_links_are_distinguished_from_app_navigation() {
        let snapshot = json!({"local_url": "http://127.0.0.1:18380"});
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "http://127.0.0.1:18380/settings",
        ] {
            let url = tauri::Url::parse(url).unwrap();
            assert!(trusted_app_url(&url, &snapshot));
            assert!(!external_browser_url(&url, &snapshot));
        }
        for url in ["https://example.com/docs", "http://example.com/help"] {
            let url = tauri::Url::parse(url).unwrap();
            assert!(!trusted_app_url(&url, &snapshot));
            assert!(external_browser_url(&url, &snapshot));
        }
        let file = tauri::Url::parse("file:///tmp/private.txt").unwrap();
        assert!(!trusted_app_url(&file, &snapshot));
        assert!(!external_browser_url(&file, &snapshot));
    }
}
