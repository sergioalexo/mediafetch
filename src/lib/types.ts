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

export type AudioFormat = "mp3" | "flac" | "wav" | "aac" | "opus";

export type BitrateMode = "cbr" | "vbr";

export interface MetadataOverrides {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
}

export interface DownloadOptions {
  url: string;
  kind: DownloadKind;
  /** yt-dlp -f selector, e.g. "137+bestaudio" or "bv[height<=1080]+ba/b" */
  format?: string | null;
  /** human readable label, e.g. "1080p60 · AV1 · HDR" */
  formatNote?: string | null;
  audioFormat?: AudioFormat | null;
  /** "cbr" | "vbr" — MP3 bitrate mode. */
  bitrateMode?: BitrateMode | null;
  /** Source audio bitrate in kbps, known from analysis. */
  sourceAbr?: number | null;
  playlist: boolean;
  playlistItems?: string | null;
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
}

export interface Preset {
  id: string;
  name: string;
  kind: DownloadKind;
  /** quality preset value, e.g. "best" | "1080" */
  videoPreset: string;
  audioFormat: AudioFormat;
  bitrateMode: BitrateMode;
  subtitleLangs?: string | null;
  embedSubs?: boolean | null;
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
  writeSubs: boolean;
  embedSubs: boolean;
  subLangs: string;
  outputTemplate: string;
  notifications: boolean;
  concurrentFragments: number;
  theme: "dark" | "light";
  presets: Preset[];
  defaultPresetId: string;
  /** The user confirmed the legal disclaimer on first launch. */
  disclaimerAccepted: boolean;
  language: "en" | "uk" | "ru";
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

// ---- History ----

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
}
