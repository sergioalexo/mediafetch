use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Downloading,
    Postprocessing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetadataOverrides {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOptions {
    pub url: String,
    pub kind: String, // "video" | "audio"
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub format_note: Option<String>,
    #[serde(default)]
    pub audio_format: Option<String>,
    /// "cbr" | "vbr" — MP3 bitrate mode.
    #[serde(default)]
    pub bitrate_mode: Option<String>,
    /// Source audio bitrate in kbps, known from analysis.
    #[serde(default)]
    pub source_abr: Option<f64>,
    #[serde(default)]
    pub playlist: bool,
    #[serde(default)]
    pub playlist_items: Option<String>,
    #[serde(default)]
    pub subtitle_langs: Option<String>,
    #[serde(default)]
    pub embed_subs: Option<bool>,
    #[serde(default)]
    pub audio_lang: Option<String>,
    #[serde(default)]
    pub metadata: Option<MetadataOverrides>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// Shared id for tasks that came from the same analyzed playlist,
    /// so the UI can group them under one collapsible header.
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub status: TaskStatus,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed: f64,
    pub eta: f64,
    pub filename: Option<String>,
    pub error: Option<String>,
    pub added_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub playlist_index: Option<u32>,
    pub playlist_count: Option<u32>,
    pub options: DownloadOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub filename: Option<String>,
    pub filesize: u64,
    pub kind: String,
    pub format_note: Option<String>,
    pub downloaded_at: u64,
    pub elapsed_secs: u64,
    pub avg_speed: f64,
    pub status: String, // "completed" | "failed"
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
