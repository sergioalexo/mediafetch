use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub download_dir: String,
    pub max_parallel: u32,
    pub rate_limit: String,
    pub proxy: String,
    pub cookies_file: String,
    pub cookies_from_browser: String,
    pub use_download_archive: bool,
    pub sponsorblock_mode: String, // "off" | "remove" | "mark"
    pub sponsorblock_categories: Vec<String>,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub write_subs: bool,
    pub embed_subs: bool,
    pub sub_langs: String,
    pub output_template: String,
    pub notifications: bool,
    pub concurrent_fragments: u32,
    pub theme: String,
    // Last used selections on the Downloads page, restored on start.
    pub last_kind: String,          // "video" | "audio"
    pub last_preset: String,        // quality preset value, e.g. "best" | "1080"
    pub last_audio_format: String,  // "mp3" | "flac" | ...
    pub audio_bitrate_mode: String, // "cbr" | "vbr"
    // The user confirmed the legal disclaimer on first launch.
    pub disclaimer_accepted: bool,
    pub language: String, // "en" | "uk" | "ru"
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: String::new(),
            max_parallel: 2,
            rate_limit: String::new(),
            proxy: String::new(),
            cookies_file: String::new(),
            cookies_from_browser: String::new(),
            use_download_archive: false,
            sponsorblock_mode: "off".into(),
            sponsorblock_categories: vec!["sponsor".into()],
            embed_thumbnail: true,
            embed_metadata: true,
            write_subs: false,
            embed_subs: true,
            sub_langs: "en".into(),
            output_template: "%(title)s [%(id)s].%(ext)s".into(),
            notifications: true,
            concurrent_fragments: 4,
            theme: "dark".into(),
            last_kind: "video".into(),
            last_preset: "best".into(),
            last_audio_format: "mp3".into(),
            audio_bitrate_mode: "cbr".into(),
            disclaimer_accepted: false,
            language: "en".into(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let mut settings: Settings = settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    if settings.download_dir.is_empty() {
        let base = app
            .path()
            .download_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        settings.download_dir = base.join("MediaFetch").to_string_lossy().into_owned();
    }
    settings
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
