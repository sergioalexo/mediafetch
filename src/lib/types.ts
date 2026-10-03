// ---- Shared types (mirror the Rust structs in src-tauri) ----

export type TaskStatus =
  | "queued"
  | "downloading"
  | "postprocessing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type DownloadKind = "video" | "audio";

export type AudioFormat = "mp3" | "flac" | "wav" | "aac" | "opus" | "source";

/** Legacy MP3 bitrate mode (superseded by AudioQuality). */
export type BitrateMode = "cbr" | "vbr";

/** Sample rate for re-encoded audio. "original" skips resampling entirely. */
export type SampleRate = "48000" | "44100" | "96000" | "original";

/**
 * Bitrate/quality for lossy encoded audio (mp3/aac/opus).
 * - "match": nearest standard CBR that covers the source bitrate.
 * - "320" | "256" | "192" | "128": forced constant bitrate (kbps).
 * - "vbr": variable bitrate, best quality.
 */
export type AudioQuality = "match" | "320" | "256" | "192" | "128" | "vbr";

export interface MetadataOverrides {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
}

/** Tool that runs a download. gallery-dl is the one that can fetch photos. */
export type Engine = "ytdlp" | "gallerydl";

export interface DownloadOptions {
  url: string;
  kind: DownloadKind;
  engine?: Engine | null;
  /** Items expected, when analysis knew — drives gallery-dl progress. */
  expectedItems?: number | null;
  /** yt-dlp -f selector, e.g. "137+bestaudio" or "bv[height<=1080]+ba/b" */
  format?: string | null;
  /** human readable label, e.g. "1080p60 · AV1 · HDR" */
  formatNote?: string | null;
  audioFormat?: AudioFormat | null;
  /** Bitrate/quality for lossy audio. */
  audioQuality?: AudioQuality | null;
  /** Legacy MP3 bitrate mode; kept for backward compat. */
  bitrateMode?: BitrateMode | null;
  /** Source audio bitrate in kbps, known from analysis. */
  sourceAbr?: number | null;
  playlist: boolean;
  playlistItems?: string | null;
  /** The format may resolve to a still image — skip media postprocessors. */
  includeImages?: boolean | null;
  subtitleLangs?: string | null;
  embedSubs?: boolean | null;
  audioLang?: string | null;
  metadata?: MetadataOverrides | null;
  /** Known in advance from analysis — used for queue display. */
  title?: string | null;
  thumbnail?: string | null;
  /** Shared id for tasks from the same analyzed playlist (collapsible group). */
  groupId?: string | null;
  groupTitle?: string | null;
  /** Extra raw yt-dlp CLI arguments, shell-quoted (advanced). */
  customYtdlpArgs?: string | null;
  /** Extra raw ffmpeg arguments passed via --postprocessor-args (advanced). */
  customFfmpegArgs?: string | null;
  /** Per-task sample rate override; null uses the global setting. */
  sampleRate?: SampleRate | null;
}

export interface Preset {
  id: string;
  name: string;
  kind: DownloadKind;
  /** quality preset value, e.g. "best" | "1080" */
  videoPreset: string;
  audioFormat: AudioFormat;
  audioQuality: AudioQuality;
  /** Legacy field; superseded by audioQuality. */
  bitrateMode?: BitrateMode | null;
  subtitleLangs?: string | null;
  embedSubs?: boolean | null;
  /**
   * Download everything the link contains (profile, album, carousel post) as
   * one task, rather than one task per item.
   */
  fetchAll?: boolean | null;
  /**
   * "gallerydl" routes links through gallery-dl whenever it's installed —
   * the only way to get photo posts. Anything else lets analysis decide.
   */
  engine?: Engine | null;
  /** Extra raw yt-dlp CLI arguments, shell-quoted (advanced). */
  customYtdlpArgs?: string | null;
  /** Extra raw ffmpeg arguments passed via --postprocessor-args (advanced). */
  customFfmpegArgs?: string | null;
  /** Optional override; null uses the global setting. */
  sampleRate?: SampleRate | null;
}

export interface DownloadTask {
  id: string;
  url: string;
  title: string;
  thumbnail?: string | null;
  status: TaskStatus;
  progress: number; // 0..100
  downloadedBytes: number;
  totalBytes: number;
  speed: number; // bytes/sec
  eta: number; // seconds
  filename?: string | null;
  error?: string | null;
  addedAt: number; // unix seconds
  startedAt?: number | null;
  completedAt?: number | null;
  playlistIndex?: number | null;
  playlistCount?: number | null;
  /** Automatic retries already attempted for this task. */
  retryCount: number;
  /** Set by auto-retry after a write failure: skip concurrent fragments. */
  forceSingleConnection: boolean;
  /** Set by auto-retry after a 403/429: re-extract with yt-dlp's own player clients. */
  useDefaultPlayerClient: boolean;
  /** Canonical "<extractor_key>:<id>", captured once yt-dlp finishes. */
  mediaKey?: string | null;
  options: DownloadOptions;
}

export interface Settings {
  downloadDir: string;
  maxParallel: number;
  rateLimit: string; // "" | "500K" | "2M" ...
  proxy: string;
  cookiesFile: string;
  cookiesFromBrowser: string; // "" | "chrome" | "firefox" | "edge" | "brave" | "opera" | "vivaldi"
  useDownloadArchive: boolean;
  sponsorblockMode: "off" | "remove" | "mark";
  sponsorblockCategories: string[];
  embedThumbnail: boolean;
  embedMetadata: boolean;
  /** Use joint stereo when encoding constant-bitrate MP3. */
  jointStereo: boolean;
  /** Default sample rate for re-encoded audio; a preset's own override wins. */
  audioSampleRate: SampleRate;
  writeSubs: boolean;
  embedSubs: boolean;
  subLangs: string;
  outputTemplate: string;
  notifications: boolean;
  concurrentFragments: number;
  /** Whole-download retries; 0 lets yt-dlp use its own default. */
  retries: number;
  /** Per-fragment retries (DASH/HLS); 0 lets yt-dlp use its own default. */
  fragmentRetries: number;
  /** Seconds to sleep between requests (throttling); 0 = off. */
  sleepRequests: number;
  /** yt-dlp --impersonate target, e.g. "chrome"; empty = off. */
  impersonate: string;
  /** Check for and install a newer yt-dlp automatically on startup. */
  /** Legacy yt-dlp-only flag; kept readable for migration only. */
  autoUpdateYtdlp: boolean;
  /** Auto-update every managed component (yt-dlp, FFmpeg, Deno, gallery-dl). */
  autoUpdateComponents: boolean;
  /** ASCII-only filenames (yt-dlp --restrict-filenames) — workaround for Unicode/Windows errors. */
  restrictFilenames: boolean;
  /** Auto re-queue a failed download this many times before leaving it Failed. 0 disables. */
  autoRetryLimit: number;
  /** "auto" follows the OS light/dark preference. */
  /** `"custom:<id>"` applies a saved custom theme (lib/theme.ts). */
  theme: "auto" | "dark" | "light" | string;
  presets: Preset[];
  defaultPresetId: string;
  /** Per-service default preset overrides: service key -> preset id. */
  servicePresets: Record<string, string>;
  /** Ids of one-time settings migrations already applied (backend-owned). */
  migrations?: string[];
  /** The user confirmed the legal disclaimer on first launch. */
  disclaimerAccepted: boolean;
  language: "en" | "uk" | "ru";
  /** The first-run onboarding flow has been finished (or reset to run again). */
  onboardingCompleted: boolean;
}

// ---- Cookie diagnostics ----

export interface CookieCheck {
  source: "browser" | "file" | "none";
  /** Browser name or file path, for display. */
  detail: string;
  ok: boolean;
  count?: number | null;
  message: string;
  hint?: string | null;
}

// ---- URL analysis ----

export interface VideoFormat {
  formatId: string;
  ext: string;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  dynamicRange?: string | null; // "SDR" | "HDR10" | "HLG" ...
  filesize?: number | null;
  tbr?: number | null;
  abr?: number | null;
  language?: string | null;
  formatNote?: string | null;
}

export interface SubtitleTrack {
  lang: string;
  name: string;
  auto: boolean;
}

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration?: number | null;
  thumbnail?: string | null;
}

export interface AnalyzeResult {
  kind: "video" | "playlist";
  /** Tool that can actually fetch this link. */
  engine: Engine;
  url: string;
  id: string;
  title: string;
  uploader?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  formats: VideoFormat[];
  subtitles: SubtitleTrack[];
  audioLanguages: string[];
  entryCount?: number | null;
  entries: PlaylistEntry[];
}

// ---- Binaries module ----

export interface BinaryStatus {
  name: string; // "yt-dlp" | "ffmpeg"
  repoUrl: string;
  releasesUrl: string;
  path?: string | null;
  installed: boolean;
  managed: boolean; // true if installed into our bin dir (updatable)
  currentVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable: boolean;
  /** Version kept in the rollback slot (the one replaced by the last update). */
  previousVersion?: string | null;
}

export interface BinaryProgress {
  name: string;
  phase: "downloading" | "extracting" | "done" | "error";
  downloaded: number;
  total: number;
  message?: string | null;
}

// ---- App updates ----

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  releasesUrl: string;
}

// ---- Log book ----

/** One line of the app-wide log book (mirrors downloader::AppLogLine). */
export interface AppLogLine {
  seq: number;
  ts: number; // unix seconds
  /** Task id, or "analyze:<url>" for an analysis. */
  source: string;
  /** Short human label for the source. */
  scope: string;
  line: string;
}

// ---- History ----

export interface ImportReport {
  added: number;
  skipped: number;
  archiveAdded: number;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  filename?: string | null;
  filesize: number;
  kind: DownloadKind;
  formatNote?: string | null;
  downloadedAt: number; // unix seconds
  elapsedSecs: number;
  avgSpeed: number; // bytes/sec
  status: "completed" | "failed";
  /** Canonical "<extractor_key>:<id>", when yt-dlp reported one. */
  mediaKey?: string | null;
  /** "local" (this install downloaded it) | "imported" (merged from a backup). */
  source?: "local" | "imported" | null;
}
