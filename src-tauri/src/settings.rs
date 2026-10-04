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
    pub audio_format: String, // "mp3" | "flac" | "wav" | "aac" | "opus" | "source"
    // "match" | "320" | "256" | "192" | "128" | "vbr" (lossy formats only).
    #[serde(default = "default_audio_quality")]
    pub audio_quality: String,
    // Legacy MP3 bitrate mode ("cbr" | "vbr"), kept for backward compat.
    #[serde(default)]
    pub bitrate_mode: Option<String>,
    #[serde(default)]
    pub subtitle_langs: Option<String>,
    #[serde(default)]
    pub embed_subs: Option<bool>,
    /// Download everything a link contains (profile, album, carousel post) as
    /// one task, instead of expanding it into one task per item.
    #[serde(default)]
    pub fetch_all: Option<bool>,
    /// Preferred download tool: "gallerydl" to route links through gallery-dl
    /// whenever it's installed (the only way to get photos), anything else to
    /// let the link's analysis decide.
    #[serde(default)]
    pub engine: Option<String>,
    /// Extra raw yt-dlp CLI arguments, shell-quoted (advanced).
    #[serde(default)]
    pub custom_ytdlp_args: Option<String>,
    /// Extra raw ffmpeg arguments passed via --postprocessor-args (advanced).
    #[serde(default)]
    pub custom_ffmpeg_args: Option<String>,
    /// Per-preset sample rate override: "48000" | "44100" | "96000" |
    /// "original". `None` means use the global setting.
    #[serde(default)]
    pub sample_rate: Option<String>,
}

fn default_audio_quality() -> String {
    "match".into()
}

pub const SOCIAL_MEDIA_PRESET_ID: &str = "social-media";
pub const MUSIC_320_PRESET_ID: &str = "audio-mp3-320";

/// Marker for the one-time seeding of [`social_media_preset`] into settings
/// files written before it existed. Recorded so deleting the preset sticks.
const SOCIAL_MEDIA_MIGRATION: &str = "social-media-preset";
const AUTO_THEME_MIGRATION: &str = "auto-theme";
const MUSIC_320_MIGRATION: &str = "music-320-defaults";
const ONBOARDING_MIGRATION: &str = "onboarding-skip-existing";
const AUTO_UPDATE_COMPONENTS_MIGRATION: &str = "auto-update-components";

/// Photos *and* videos, exactly as the site stores them. The "media" quality
/// preset resolves to a single progressive file, which is the only thing an
/// Instagram photo has — a bv*+ba selector would reject it outright.
fn social_media_preset() -> Preset {
    Preset {
        id: SOCIAL_MEDIA_PRESET_ID.into(),
        name: "Photos & videos".into(),
        kind: "video".into(),
        video_preset: "media".into(),
        audio_format: "mp3".into(),
        audio_quality: "match".into(),
        bitrate_mode: None,
        subtitle_langs: None,
        embed_subs: None,
        fetch_all: Some(true),
        // Photos only exist for gallery-dl; it falls back to yt-dlp when the
        // component isn't installed, so a reel link still works either way.
        engine: Some("gallerydl".into()),
        custom_ytdlp_args: None,
        custom_ffmpeg_args: None,
        sample_rate: None,
    }
}

/// Music services stream well below 320 kbps already (SoundCloud is usually
/// 128–256 kbps) — this is "max compatibility, not more detail", but it's
/// the safe default every player and device handles.
fn music_320_preset() -> Preset {
    Preset {
        id: MUSIC_320_PRESET_ID.into(),
        name: "Music · MP3 320".into(),
        kind: "audio".into(),
        video_preset: "best".into(),
        audio_format: "mp3".into(),
        audio_quality: "320".into(),
        bitrate_mode: None,
        subtitle_langs: None,
        embed_subs: None,
        fetch_all: None,
        engine: None,
        custom_ytdlp_args: None,
        custom_ffmpeg_args: None,
        sample_rate: None,
    }
}

fn default_presets() -> Vec<Preset> {
    vec![
        Preset {
            id: "video-best".into(),
            name: "Video · Best".into(),
            kind: "video".into(),
            video_preset: "best".into(),
            audio_format: "mp3".into(),
            audio_quality: "match".into(),
            bitrate_mode: None,
            subtitle_langs: None,
            embed_subs: None,
            fetch_all: None,
            engine: None,
            custom_ytdlp_args: None,
            custom_ffmpeg_args: None,
            sample_rate: None,
        },
        Preset {
            id: "audio-mp3".into(),
            name: "Audio · MP3".into(),
            kind: "audio".into(),
            video_preset: "best".into(),
            audio_format: "mp3".into(),
            audio_quality: "match".into(),
            bitrate_mode: None,
            subtitle_langs: None,
            embed_subs: None,
            fetch_all: None,
            engine: None,
            custom_ytdlp_args: None,
            custom_ffmpeg_args: None,
            sample_rate: None,
        },
        social_media_preset(),
        music_320_preset(),
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
    /// Use joint stereo when encoding constant-bitrate MP3 (better quality
    /// per bit; off encodes plain stereo channels independently).
    pub joint_stereo: bool,
    /// Default sample rate for re-encoded audio: "48000" | "44100" | "96000"
    /// | "original" (no resampling). A preset's own `sampleRate` overrides it.
    pub audio_sample_rate: String,
    pub write_subs: bool,
    pub embed_subs: bool,
    pub sub_langs: String,
    pub output_template: String,
    pub notifications: bool,
    pub concurrent_fragments: u32,
    /// Retries for a whole download; 0 lets yt-dlp use its own default.
    pub retries: u32,
    /// Retries per fragment (DASH/HLS); 0 lets yt-dlp use its own default.
    pub fragment_retries: u32,
    /// Seconds to sleep between requests (throttling, helps avoid 403s); 0 = off.
    pub sleep_requests: f64,
    /// yt-dlp --impersonate target, e.g. "chrome"; empty = off.
    pub impersonate: String,
    /// Legacy yt-dlp-only auto-update flag, kept readable so an existing
    /// install's choice can be migrated into `auto_update_components`.
    pub auto_update_ytdlp: bool,
    /// Check for and install newer releases of every *managed* component
    /// (yt-dlp, FFmpeg, Deno, gallery-dl) automatically on startup.
    pub auto_update_components: bool,
    /// yt-dlp --restrict-filenames: ASCII-only filenames. Workaround for
    /// Windows/Unicode filesystem errors on some setups; strips accents
    /// instead of preserving them, so it's opt-in.
    pub restrict_filenames: bool,
    /// Automatically re-queue a failed download this many times before
    /// leaving it Failed for the user to handle. 0 disables auto-retry.
    pub auto_retry_limit: u32,
    /// "auto" (follow the OS), "dark" or "light".
    pub theme: String,
    // Named per-download presets and the one selected as default.
    pub presets: Vec<Preset>,
    pub default_preset_id: String,
    // Per-service default preset overrides: service key -> preset id.
    pub service_presets: std::collections::HashMap<String, String>,
    /// Per-service auto-download on paste: service key -> true. Absent = off.
    pub service_auto_download: std::collections::HashMap<String, bool>,
    /// Ids of one-time settings migrations already applied.
    pub migrations: Vec<String>,
    // The user confirmed the legal disclaimer on first launch.
    pub disclaimer_accepted: bool,
    pub language: String, // "en" | "uk" | "ru"
    /// The first-run onboarding flow has been finished (or explicitly reset
    /// from Settings → About to run again).
    pub onboarding_completed: bool,
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
            joint_stereo: true,
            audio_sample_rate: "48000".into(),
            write_subs: false,
            embed_subs: true,
            sub_langs: "en".into(),
            output_template: "%(artist,uploader)s - %(title)s.%(ext)s".into(),
            notifications: true,
            concurrent_fragments: 4,
            retries: 0,
            fragment_retries: 0,
            sleep_requests: 0.0,
            impersonate: String::new(),
            auto_update_ytdlp: false,
            auto_update_components: true,
            restrict_filenames: false,
            auto_retry_limit: 2,
            theme: "auto".into(),
            presets: default_presets(),
            default_preset_id: "video-best".into(),
            service_presets: std::collections::HashMap::new(),
            service_auto_download: std::collections::HashMap::new(),
            migrations: Vec::new(),
            disclaimer_accepted: false,
            onboarding_completed: false,
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
    // Needed before the fallback below kicks in, to tell "a settings file
    // that already existed" apart from "a brand-new install" for the
    // auto-update-components migration.
    let file_existed = settings_path(app)
        .ok()
        .map(|p| p.exists())
        .unwrap_or(false);
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
    // Seed the photos-and-videos preset once, and make it the Instagram
    // default — Instagram is the service whose links are usually pictures.
    // Both steps are skipped afterwards, so removing either one sticks.
    if !settings.migrations.iter().any(|m| m == SOCIAL_MEDIA_MIGRATION) {
        settings.migrations.push(SOCIAL_MEDIA_MIGRATION.into());
        if !settings.presets.iter().any(|p| p.id == SOCIAL_MEDIA_PRESET_ID) {
            settings.presets.push(social_media_preset());
        }
        settings
            .service_presets
            .entry("instagram".into())
            .or_insert_with(|| SOCIAL_MEDIA_PRESET_ID.into());
        let _ = save(app, &settings);
    }
    // Theme used to be a dark/light toggle defaulting to dark; move existing
    // installs onto the new "follow the system" default once.
    if !settings.migrations.iter().any(|m| m == AUTO_THEME_MIGRATION) {
        settings.migrations.push(AUTO_THEME_MIGRATION.into());
        settings.theme = "auto".into();
        let _ = save(app, &settings);
    }
    // Seed the MP3 320 preset once, and make it the YouTube Music / SoundCloud
    // default — an existing user choice for either service is never
    // overwritten (`.or_insert`), only a missing one is filled in.
    if !settings.migrations.iter().any(|m| m == MUSIC_320_MIGRATION) {
        settings.migrations.push(MUSIC_320_MIGRATION.into());
        if !settings.presets.iter().any(|p| p.id == MUSIC_320_PRESET_ID) {
            settings.presets.push(music_320_preset());
        }
        settings
            .service_presets
            .entry("youtube-music".into())
            .or_insert_with(|| MUSIC_320_PRESET_ID.into());
        settings
            .service_presets
            .entry("soundcloud".into())
            .or_insert_with(|| MUSIC_320_PRESET_ID.into());
        let _ = save(app, &settings);
    }
    // The onboarding flow is new; an install that already accepted the
    // disclaimer clearly isn't a first run, so it's marked done rather than
    // interrupting an existing user. A fresh profile has disclaimer_accepted
    // still false here and runs onboarding normally.
    if !settings.migrations.iter().any(|m| m == ONBOARDING_MIGRATION) {
        settings.migrations.push(ONBOARDING_MIGRATION.into());
        if settings.disclaimer_accepted {
            settings.onboarding_completed = true;
        }
        let _ = save(app, &settings);
    }
    // Generalizes the yt-dlp-only toggle to every managed component. An
    // existing install's explicit choice carries over; a brand-new one gets
    // the new default (true) rather than the old field's default (false).
    if !settings.migrations.iter().any(|m| m == AUTO_UPDATE_COMPONENTS_MIGRATION) {
        settings.migrations.push(AUTO_UPDATE_COMPONENTS_MIGRATION.into());
        if file_existed {
            settings.auto_update_components = settings.auto_update_ytdlp;
        }
        let _ = save(app, &settings);
    }
    settings
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
