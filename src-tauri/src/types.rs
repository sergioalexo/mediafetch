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

impl TaskStatus {
    /// Owns a process and one of the parallel-download slots.
    pub fn is_running(self) -> bool {
        matches!(self, Self::Downloading | Self::Postprocessing)
    }

    /// Still going to produce something: running, waiting its turn, or paused.
    pub fn is_live(self) -> bool {
        self.is_running() || matches!(self, Self::Queued | Self::Paused)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetadataOverrides {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOptions {
    pub url: String,
    pub kind: String, // "video" | "audio"
    /// Which tool runs the download: "ytdlp" (default) or "gallerydl".
    /// gallery-dl is the one that can fetch photo posts and profile galleries.
    #[serde(default)]
    pub engine: Option<String>,
    /// Items this task is expected to produce, when known from analysis —
    /// gallery-dl reports no totals of its own, so this drives its progress.
    #[serde(default)]
    pub expected_items: Option<u32>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub format_note: Option<String>,
    #[serde(default)]
    pub audio_format: Option<String>,
    /// "match" | "320" | "256" | "192" | "128" | "vbr" — lossy audio bitrate/quality.
    #[serde(default)]
    pub audio_quality: Option<String>,
    /// Legacy "cbr" | "vbr" MP3 bitrate mode, kept for backward compat.
    #[serde(default)]
    pub bitrate_mode: Option<String>,
    /// Source audio bitrate in kbps, known from analysis.
    #[serde(default)]
    pub source_abr: Option<f64>,
    #[serde(default)]
    pub playlist: bool,
    #[serde(default)]
    pub playlist_items: Option<String>,
    /// The format selector may resolve to a still image (Instagram photos,
    /// carousel posts). Media postprocessors can't handle those, so they are
    /// skipped for the whole task.
    #[serde(default)]
    pub include_images: Option<bool>,
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
    /// Extra raw yt-dlp CLI arguments, shell-quoted (advanced).
    #[serde(default)]
    pub custom_ytdlp_args: Option<String>,
    /// Extra raw ffmpeg arguments passed via --postprocessor-args (advanced).
    #[serde(default)]
    pub custom_ffmpeg_args: Option<String>,
    /// Per-task sample rate override: "48000" | "44100" | "96000" |
    /// "original". `None` means use the global setting.
    #[serde(default)]
    pub sample_rate: Option<String>,
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
    /// Number of automatic retries already attempted for this task.
    #[serde(default)]
    pub retry_count: u32,
    /// Set by an auto-retry after a file-write failure (Errno 22 and
    /// similar): skip concurrent-fragment downloading for this attempt,
    /// since parallel writes into a busy folder (many tasks × several
    /// fragment threads each) are a likely trigger.
    #[serde(default)]
    pub force_single_connection: bool,
    /// Canonical `"<extractor_key>:<id>"`, captured from yt-dlp's own
    /// `after_move` print once the run finishes (see MFDONE in downloader.rs).
    #[serde(default)]
    pub media_key: Option<String>,
    /// Which run currently owns the task — a fresh number every time it
    /// starts. A run whose number no longer matches was superseded (paused
    /// and quickly resumed, say) and must leave the task alone. Backend-only.
    #[serde(skip)]
    pub run: u64,
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
    /// Canonical `"<extractor_key>:<id>"`, when yt-dlp reported one. Old
    /// entries predate this and have none.
    #[serde(default)]
    pub media_key: Option<String>,
    /// "local" (this install downloaded it) | "imported" (merged in from a
    /// backup). Old entries predate this and default to "local" on read.
    #[serde(default)]
    pub source: Option<String>,
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
