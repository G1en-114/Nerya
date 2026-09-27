use serde_json::{json, Value};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "macos")]
mod mac {
    use std::{ffi::{CStr, CString}, os::raw::c_char, sync::OnceLock};
    use tauri::Manager;
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    extern "C" {
        fn nerya_notifications_init(callback: extern "C" fn());
        fn nerya_notification_permission() -> i32;
        fn nerya_notification_authorize() -> i32;
        fn nerya_notification_send(id: *const c_char, body: *const c_char) -> i32;
        fn nerya_notification_delivered(id: *const c_char) -> i32;
        fn nerya_vault_key(output: *mut c_char, capacity: usize) -> i32;
    }
    extern "C" fn open() {
        if let Some(app) = APP.get() {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
                }
            });
        }
    }
    pub fn initialize(app: tauri::AppHandle) {
        let _ = APP.set(app);
        unsafe { nerya_notifications_init(open); }
    }
    fn permission_name(code: i32) -> Result<&'static str, String> {
        match code {
            0 => Ok("prompt"), 1 => Ok("denied"), 2 => Ok("granted"), 3 => Ok("quiet"),
            _ => Err("notification_permission_failed".into()),
        }
    }
    pub fn permission(request: bool) -> Result<&'static str, String> {
        permission_name(unsafe { if request { nerya_notification_authorize() } else { nerya_notification_permission() } })
    }
    pub fn send(id: &str, body: &str, receipt: bool) -> Result<&'static str, String> {
        let id = CString::new(id).map_err(|_| "notification_delivery_failed")?;
        let body = CString::new(body).map_err(|_| "notification_delivery_failed")?;
        if unsafe { nerya_notification_send(id.as_ptr(), body.as_ptr()) } != 0 {
            return Err("notification_delivery_failed".into());
        }
        if receipt {
            for _ in 0..6 {
                if unsafe { nerya_notification_delivered(id.as_ptr()) } == 1 { return Ok("delivered"); }
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
        Ok("accepted") // Accepted is deliberately not described as visible/delivered.
    }
    pub fn vault_key() -> Result<String, String> {
        let mut output = [0 as c_char; 128];
        if unsafe { nerya_vault_key(output.as_mut_ptr(), output.len()) } != 0 {
            return Err("system_keychain_unavailable".into());
        }
        let result = unsafe { CStr::from_ptr(output.as_ptr()) }.to_str()
            .map(str::to_owned).map_err(|_| "system_keychain_unavailable".into());
        output.fill(0);
        result
    }
}

pub fn initialize(_app: tauri::AppHandle) {
    #[cfg(target_os = "macos")] mac::initialize(_app);
}
pub fn permission(_app: &tauri::AppHandle, request: bool) -> Result<&'static str, String> {
    #[cfg(target_os = "macos")] { mac::permission(request) }
    #[cfg(not(target_os = "macos"))] {
        let value = if request { _app.notification().request_permission() } else { _app.notification().permission_state() }
            .map_err(|_| "notification_permission_failed")?;
        Ok(if serde_json::to_value(value).unwrap_or(Value::Null) == "granted" { "granted" } else { "denied" })
    }
}
pub fn authorize(app: &tauri::AppHandle) -> Result<(), String> {
    match permission(app, true)? {
        "granted" | "quiet" => Ok(()), _ => Err("notification_permission_denied".into()),
    }
}
pub fn send(app: &tauri::AppHandle, count: u64, language: &str, receipt: bool) -> Result<Value, String> {
    let permission = permission(app, false)?;
    if !matches!(permission, "granted" | "quiet") { return Err("notification_permission_denied".into()); }
    let body = if language == "zh" { format!("收件箱有 {count} 条新动态，请打开 Nerya 查看。") }
        else { format!("{count} new inbox update(s). Open Nerya to review.") };
    #[cfg(target_os = "macos")]
    let result = {
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let id = format!("nerya-{}-{serial}", std::process::id());
        mac::send(&id, &body, receipt)?
    };
    #[cfg(not(target_os = "macos"))]
    let result = {
        let _ = receipt;
        app.notification().builder().title("Nerya").body(body).show().map_err(|_| "notification_delivery_failed")?;
        "accepted"
    };
    Ok(json!({"delivery": if result == "delivered" { "delivered" } else { "submitted" }, "permission": permission}))
}
#[cfg(target_os = "macos")]
pub use mac::vault_key;
