use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// A named bundle of per-download media parameters the user can pick as default.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub kind: String,         // "video" | "audio"
    pub video_preset: String, // quality preset value, e.g. "best" | "1080"
    pub audio_format: String, // "mp3" | "flac" | ...
    pub bitrate_mode: String, // "cbr" | "vbr"
    #[serde(default)]
    pub subtitle_langs: Option<String>,
    #[serde(default)]
    pub embed_subs: Option<bool>,
}

fn default_presets() -> Vec<Preset> {
    vec![
        Preset {
            id: "video-best".into(),
            name: "Video · Best".into(),
            kind: "video".into(),
            video_preset: "best".into(),
            audio_format: "mp3".into(),
            bitrate_mode: "cbr".into(),
            subtitle_langs: None,
            embed_subs: None,
        },
        Preset {
            id: "audio-mp3".into(),
            name: "Audio · MP3".into(),
            kind: "audio".into(),
            video_preset: "best".into(),
            audio_format: "mp3".into(),
            bitrate_mode: "cbr".into(),
            subtitle_langs: None,
            embed_subs: None,
        },
    ]
}

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
    // Named per-download presets and the one selected as default.
    pub presets: Vec<Preset>,
    pub default_preset_id: String,
    // Per-service default preset overrides: service key -> preset id.
    pub service_presets: std::collections::HashMap<String, String>,
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
            output_template: "%(artist,uploader)s - %(title)s.%(ext)s".into(),
            notifications: true,
            concurrent_fragments: 4,
            theme: "dark".into(),
            presets: default_presets(),
            default_preset_id: "video-best".into(),
            service_presets: std::collections::HashMap::new(),
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
    // Settings files written before presets existed load with an empty list.
    if settings.presets.is_empty() {
        settings.presets = default_presets();
    }
    // Migrate the pre-0.1.4 default filename template to the new default.
    if settings.output_template.trim() == "%(title)s [%(id)s].%(ext)s" {
        settings.output_template = "%(artist,uploader)s - %(title)s.%(ext)s".into();
    }
    if !settings.presets.iter().any(|p| p.id == settings.default_preset_id) {
        settings.default_preset_id = settings.presets[0].id.clone();
    }
    settings
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
