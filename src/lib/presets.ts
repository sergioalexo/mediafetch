// Shared per-download preset constants and helpers used by the Workspace,
// the preset editor and the store. Keeps yt-dlp format strings in one place.

import type {
  AnalyzeResult,
  AudioFormat,
  AudioQuality,
  BitrateMode,
  DownloadOptions,
  Engine,
  HistoryEntry,
  Preset,
  SampleRate,
} from "./types";
import type { MsgKey } from "./i18n";
import { extractMediaId, normalizeUrl } from "./utils";

export const AUDIO_FORMATS: { value: AudioFormat; label: string; hint: MsgKey }[] = [
  { value: "mp3", label: "MP3", hint: "dl.hintUniversal" },
  { value: "flac", label: "FLAC", hint: "dl.hintLossless" },
  { value: "wav", label: "WAV", hint: "dl.hintUncompressed" },
  { value: "aac", label: "AAC", hint: "dl.hintEfficient" },
  { value: "opus", label: "OPUS", hint: "dl.hintBestQuality" },
  { value: "source", label: "Original", hint: "dl.hintOriginal" },
];

/** Formats that are lossy re-encodes and take a bitrate/quality setting. */
export const LOSSY_FORMATS: AudioFormat[] = ["mp3", "aac", "opus"];

/** Bitrate/quality options for lossy audio. Numeric labels are literal kbps. */
export const AUDIO_QUALITIES: { value: AudioQuality; label: string | null; hint: MsgKey }[] = [
  { value: "match", label: null, hint: "dl.qMatch" },
  { value: "320", label: "320 kbps", hint: "dl.qForced" },
  { value: "256", label: "256 kbps", hint: "dl.qForced" },
  { value: "192", label: "192 kbps", hint: "dl.qForced" },
  { value: "128", label: "128 kbps", hint: "dl.qForced" },
  { value: "vbr", label: null, hint: "dl.qVbr" },
];

/** Resolve a preset's audio quality, mapping the legacy bitrateMode field. */
export function presetAudioQuality(preset: {
  audioQuality?: AudioQuality | null;
  bitrateMode?: BitrateMode | null;
}): AudioQuality {
  if (preset.audioQuality) return preset.audioQuality;
  return preset.bitrateMode === "vbr" ? "vbr" : "match";
}

/** Short human label for an audio quality value. */
export function audioQualityLabel(q: AudioQuality, t: (k: MsgKey) => string): string {
  const found = AUDIO_QUALITIES.find((a) => a.value === q);
  if (!found) return q;
  return found.label ?? t(found.hint === "dl.qVbr" ? "dl.qVbrShort" : "dl.qMatchShort");
}

export const SAMPLE_RATES: { value: SampleRate; label: MsgKey }[] = [
  { value: "48000", label: "dl.sr48" },
  { value: "44100", label: "dl.sr44" },
  { value: "96000", label: "dl.sr96" },
  { value: "original", label: "dl.srOriginal" },
];

/** Formats that don't take a sample rate override at all — "Original" keeps
 * the source stream untouched, so resampling doesn't apply. */
export function sampleRateApplies(format: AudioFormat): boolean {
  return format !== "source";
}

/** Clamp a requested sample rate to what each format can actually encode —
 * mirrors the Rust side (downloader::resolve_sample_rate) so the preview and
 * summary never show a rate the backend would silently correct. */
export function clampSampleRate(rate: SampleRate, format: AudioFormat): SampleRate {
  if (rate === "original") return rate;
  if ((format === "mp3" || format === "aac") && rate === "96000") return "48000";
  if (format === "opus") return "48000";
  return rate;
}

/** Short human label for a sample rate value, e.g. "48 kHz". */
export function sampleRateLabel(rate: SampleRate, t: (k: MsgKey) => string): string {
  if (rate === "original") return t("dl.srOriginal");
  return `${Number(rate) / 1000} kHz`;
}

export const VIDEO_PRESETS: {
  value: string;
  label: MsgKey | null;
  fixed?: string;
  f: string;
}[] = [
  // Trailing "/ba" covers audio-only sources (e.g. YouTube Music "song"
  // pages with no video stream at all), which otherwise hard-fail with
  // "Requested format is not available" once bv*+ba and b both fail.
  { value: "best", label: "dl.bestAvailable", f: "bv*+ba/b/ba" },
  { value: "2160", label: null, fixed: "4K (2160p)", f: "bv*[height<=2160]+ba/b/ba" },
  { value: "1440", label: null, fixed: "1440p", f: "bv*[height<=1440]+ba/b/ba" },
  { value: "1080", label: null, fixed: "1080p", f: "bv*[height<=1080]+ba/b/ba" },
  { value: "720", label: null, fixed: "720p", f: "bv*[height<=720]+ba/b/ba" },
  { value: "480", label: null, fixed: "480p", f: "bv*[height<=480]+ba/b/ba" },
  // Photos and videos as the site stores them. A still image is a single
  // format with no codecs, so "b" has to come first — bv*+ba would try to
  // merge a picture with itself, and a height filter would reject it.
  { value: "media", label: "dl.mediaOriginal", f: "b/bv*+ba/bv/ba" },
];

/** Video presets that can also produce still images (photo posts). */
export const IMAGE_CAPABLE_PRESETS = ["media"];

export function videoPresetLabel(
  value: string,
  t: (k: MsgKey) => string
): string {
  const p = VIDEO_PRESETS.find((p) => p.value === value) ?? VIDEO_PRESETS[0];
  return p.label ? t(p.label) : p.fixed ?? p.value;
}

/** Short human summary of a preset, e.g. "1080p" or "MP3 · 320 kbps". */
export function presetSummary(
  preset: Preset,
  t: (k: MsgKey) => string,
  globalSampleRate: SampleRate = "48000"
): string {
  if (preset.kind === "audio") {
    const fmt = audioFormatLabel(preset.audioFormat);
    const rate = clampSampleRate(preset.sampleRate ?? globalSampleRate, preset.audioFormat);
    // Only worth calling out when it differs from the 48 kHz default —
    // showing it on every single preset would be noise.
    const rateSuffix =
      sampleRateApplies(preset.audioFormat) && rate !== "48000"
        ? ` · ${sampleRateLabel(rate, t)}`
        : "";
    // Lossless / original formats have no meaningful bitrate to show.
    if (!LOSSY_FORMATS.includes(preset.audioFormat)) return `${fmt}${rateSuffix}`;
    return `${fmt} · ${audioQualityLabel(presetAudioQuality(preset), t)}${rateSuffix}`;
  }
  return videoPresetLabel(preset.videoPreset, t);
}

/** Display label for an audio format value. */
export function audioFormatLabel(f: AudioFormat): string {
  return AUDIO_FORMATS.find((x) => x.value === f)?.label ?? f.toUpperCase();
}

/** O(1) lookup structure built once per history change, from completed entries only. */
export interface DownloadedIndex {
  keys: Set<string>;
  urls: Set<string>;
  ids: Set<string>;
}

/** Memoized per history array identity — rebuilding on every `isAlreadyDownloaded`
 * call was O(history × entries) on every playlist analysis. */
const downloadedIndexCache = new WeakMap<HistoryEntry[], DownloadedIndex>();

export function buildDownloadedIndex(history: HistoryEntry[]): DownloadedIndex {
  const cached = downloadedIndexCache.get(history);
  if (cached) return cached;
  const keys = new Set<string>();
  const urls = new Set<string>();
  const ids = new Set<string>();
  for (const h of history) {
    if (h.status !== "completed") continue;
    if (h.mediaKey) keys.add(h.mediaKey);
    urls.add(normalizeUrl(h.url));
    const id = extractMediaId(h.url);
    if (id) ids.add(id);
  }
  const index: DownloadedIndex = { keys, urls, ids };
  downloadedIndexCache.set(history, index);
  return index;
}

/** True when a completed history entry matches this URL / media id. Playlist
 * entries carry `id` from analysis already — matched first. */
export function isAlreadyDownloaded(
  history: HistoryEntry[],
  url: string,
  id?: string | null
): boolean {
  const index = buildDownloadedIndex(history);
  if (id && index.ids.has(id)) return true;
  const extracted = extractMediaId(url);
  if (extracted && index.ids.has(extracted)) return true;
  return index.urls.has(normalizeUrl(url));
}

interface BuildContext {
  url: string;
  title?: string | null;
  thumbnail?: string | null;
  sourceAbr?: number | null;
  groupId?: string | null;
  groupTitle?: string | null;
  /** Let the tool walk the whole link itself (see `Preset.fetchAll`). */
  playlist?: boolean;
  /** 1-based item selection, when not everything is wanted. */
  playlistItems?: string | null;
  engine?: Engine;
  /** Items this task should produce, when analysis counted them. */
  expectedItems?: number | null;
  /** The current global default, for the formatNote display only — the
   * backend resolves the real fallback itself when sampleRate is omitted. */
  globalSampleRate?: SampleRate;
}

/** True when this preset downloads a link's items in one run. */
export function isFetchAll(preset: Preset): boolean {
  return preset.kind !== "audio" && !!preset.fetchAll;
}

/**
 * Which tool runs a download.
 *
 * gallery-dl is the only one that sees still images, so a preset asking for
 * it wins whenever it's installed. When it isn't, the link still downloads
 * through yt-dlp — videos and reels work either way, just without photos.
 * Analysis gets the last word only when yt-dlp couldn't read the link at all.
 */
export function resolveEngine(
  preset: Preset,
  analyzed: Engine | undefined,
  galleryInstalled: boolean
): Engine {
  if (preset.kind === "audio") return "ytdlp"; // gallery-dl has no audio extraction
  if (preset.engine === "gallerydl" && galleryInstalled) return "gallerydl";
  return analyzed === "gallerydl" ? "gallerydl" : "ytdlp";
}

/** Build the yt-dlp DownloadOptions for one item from a preset. */
export function optionsFromPreset(
  preset: Preset,
  ctx: BuildContext,
  t: (k: MsgKey) => string
): DownloadOptions {
  const audio = preset.kind === "audio";
  const vp = VIDEO_PRESETS.find((p) => p.value === preset.videoPreset) ?? VIDEO_PRESETS[0];
  return {
    url: ctx.url,
    kind: preset.kind,
    engine: ctx.engine ?? "ytdlp",
    expectedItems: ctx.expectedItems ?? null,
    format: audio ? "ba/b" : vp.f,
    formatNote: audio
      ? presetSummary(preset, t, ctx.globalSampleRate ?? "48000")
      : videoPresetLabel(vp.value, t),
    audioFormat: audio ? preset.audioFormat : null,
    audioQuality: audio ? presetAudioQuality(preset) : null,
    sourceAbr: audio ? ctx.sourceAbr ?? null : null,
    sampleRate: audio ? preset.sampleRate ?? null : null,
    playlist: ctx.playlist ?? false,
    playlistItems: ctx.playlistItems ?? null,
    includeImages: !audio && IMAGE_CAPABLE_PRESETS.includes(preset.videoPreset),
    subtitleLangs: !audio && preset.subtitleLangs ? preset.subtitleLangs : null,
    embedSubs: !audio ? preset.embedSubs ?? null : null,
    metadata: null,
    title: ctx.title ?? null,
    thumbnail: ctx.thumbnail ?? null,
    groupId: ctx.groupId ?? null,
    groupTitle: ctx.groupTitle ?? null,
    customYtdlpArgs: preset.customYtdlpArgs ?? null,
    customFfmpegArgs: preset.customFfmpegArgs ?? null,
  };
}

// ---- Service detection (per-service default presets) ----

export interface ServiceDef {
  key: string;
  label: string;
  hosts: string[]; // hostname suffixes; more specific services must come first
}

/** Order matters: music.youtube.com must match before youtube.com. */
export const SERVICES: ServiceDef[] = [
  { key: "youtube-music", label: "YouTube Music", hosts: ["music.youtube.com"] },
  { key: "youtube", label: "YouTube", hosts: ["youtube.com", "youtu.be"] },
  { key: "soundcloud", label: "SoundCloud", hosts: ["soundcloud.com"] },
  { key: "instagram", label: "Instagram", hosts: ["instagram.com"] },
  { key: "tiktok", label: "TikTok", hosts: ["tiktok.com"] },
  { key: "x", label: "X (Twitter)", hosts: ["twitter.com", "x.com"] },
  { key: "vimeo", label: "Vimeo", hosts: ["vimeo.com"] },
  { key: "twitch", label: "Twitch", hosts: ["twitch.tv"] },
  { key: "facebook", label: "Facebook", hosts: ["facebook.com", "fb.watch"] },
];

/** Prefilled to land straight on the Apple Music -> YouTube Music transfer,
 * since that's the pairing MediaFetch can actually do something with next. */
export const TUNEMYMUSIC_URL =
  "https://www.tunemymusic.com/transfer/apple-music-to-youtube-music";

/** Hosts yt-dlp can't fetch at all (DRM-gated streaming services) — pasting
 * one of these is worth a "convert it first" hint instead of a bare failure. */
export const CONVERTIBLE_HOSTS = [
  "open.spotify.com",
  "music.apple.com",
  "tidal.com",
  "deezer.com",
];

/** True when a URL's host is one of CONVERTIBLE_HOSTS. */
export function isConvertibleHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return CONVERTIBLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Which known service a URL belongs to, or null. */
export function detectService(url: string): ServiceDef | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const svc of SERVICES) {
    if (svc.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return svc;
  }
  return null;
}

/** Preset id to use for a URL: the service mapping, else the global default. */
export function presetIdForUrl(
  url: string,
  servicePresets: Record<string, string>,
  defaultPresetId: string,
  presetExists: (id: string) => boolean
): string {
  const svc = detectService(url);
  const mapped = svc ? servicePresets[svc.key] : undefined;
  return mapped && presetExists(mapped) ? mapped : defaultPresetId;
}

/** Whether a pasted URL's service has auto-download switched on. */
export function autoDownloadForUrl(
  url: string,
  serviceAutoDownload: Record<string, boolean>
): boolean {
  const svc = detectService(url);
  return svc ? !!serviceAutoDownload[svc.key] : false;
}

/** Best source audio bitrate (kbps) from an analysis, for CBR matching. */
export function sourceAbrOf(result: AnalyzeResult | null | undefined): number | null {
  if (!result || result.kind !== "video") return null;
  const abrs = result.formats
    .filter((f) => f.acodec && f.acodec !== "none")
    .map((f) => f.abr ?? 0);
  const max = Math.max(0, ...abrs);
  return max > 0 ? max : null;
}
