//! Native notifications with a proper sender identity.
//!
//! On Windows a toast is attributed to an AppUserModelID. Unless that id is
//! registered, the toast shows up as "Windows PowerShell" (dev) or the raw
//! identifier (installed). We register the id with a display name and icon
//! at startup and send toasts with it directly, so notifications always show
//! "SERGIO ALEXO / MediaFetch".

use tauri::AppHandle;

pub const APP_USER_MODEL_ID: &str = "com.mediafetch.app";
pub const DISPLAY_NAME: &str = "SERGIO ALEXO / MediaFetch";

#[cfg(windows)]
pub fn register_app_identity(app: &AppHandle) {
    use tauri::Manager;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    // Windows needs an icon file on disk to show next to the toast.
    let icon_path = app.path().app_data_dir().ok().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join("notification-icon.png");
        if !path.is_file() {
            std::fs::write(&path, include_bytes!("../icons/128x128.png")).ok()?;
        }
        Some(path)
    });

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = format!(r"Software\Classes\AppUserModelId\{APP_USER_MODEL_ID}");
    if let Ok((key, _)) = hkcu.create_subkey(&key_path) {
        let _ = key.set_value("DisplayName", &DISPLAY_NAME);
        if let Some(icon) = icon_path {
            let _ = key.set_value("IconUri", &icon.to_string_lossy().as_ref());
        }
    }
}

#[cfg(not(windows))]
pub fn register_app_identity(_app: &AppHandle) {}

#[cfg(windows)]
pub fn show(_app: &AppHandle, title: &str, body: &str) {
    use tauri_winrt_notification::Toast;
    let _ = Toast::new(APP_USER_MODEL_ID)
        .title(title)
        .text1(body)
        .show();
}

#[cfg(not(windows))]
pub fn show(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}
