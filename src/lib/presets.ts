// Shared per-download preset constants and helpers used by the Workspace,
// the preset editor and the store. Keeps yt-dlp format strings in one place.

import type {
  AnalyzeResult,
  AudioFormat,
  DownloadOptions,
  HistoryEntry,
  Preset,
} from "./types";
import type { MsgKey } from "./i18n";

export const AUDIO_FORMATS: { value: AudioFormat; label: string; hint: MsgKey }[] = [
  { value: "mp3", label: "MP3", hint: "dl.hintUniversal" },
  { value: "flac", label: "FLAC", hint: "dl.hintLossless" },
  { value: "wav", label: "WAV", hint: "dl.hintUncompressed" },
  { value: "aac", label: "AAC", hint: "dl.hintEfficient" },
  { value: "opus", label: "OPUS", hint: "dl.hintBestQuality" },
];

export const VIDEO_PRESETS: {
  value: string;
  label: MsgKey | null;
  fixed?: string;
  f: string;
}[] = [
  { value: "best", label: "dl.bestAvailable", f: "bv*+ba/b" },
  { value: "2160", label: null, fixed: "4K (2160p)", f: "bv*[height<=2160]+ba/b" },
  { value: "1440", label: null, fixed: "1440p", f: "bv*[height<=1440]+ba/b" },
  { value: "1080", label: null, fixed: "1080p", f: "bv*[height<=1080]+ba/b" },
  { value: "720", label: null, fixed: "720p", f: "bv*[height<=720]+ba/b" },
  { value: "480", label: null, fixed: "480p", f: "bv*[height<=480]+ba/b" },
];

export function videoPresetLabel(
  value: string,
  t: (k: MsgKey) => string
): string {
  const p = VIDEO_PRESETS.find((p) => p.value === value) ?? VIDEO_PRESETS[0];
  return p.label ? t(p.label) : p.fixed ?? p.value;
}

/** Short human summary of a preset, e.g. "1080p" or "MP3 · CBR". */
export function presetSummary(preset: Preset, t: (k: MsgKey) => string): string {
  if (preset.kind === "audio") {
    return `${preset.audioFormat.toUpperCase()} · ${preset.bitrateMode.toUpperCase()}`;
  }
  return videoPresetLabel(preset.videoPreset, t);
}

/** True when a completed history entry matches this URL / media id. */
export function isAlreadyDownloaded(
  history: HistoryEntry[],
  url: string,
  id?: string | null
): boolean {
  return history.some(
    (h) =>
      h.status === "completed" &&
      (h.url === url || (!!id && id.length >= 6 && h.url.includes(id)))
  );
}

interface BuildContext {
  url: string;
  title?: string | null;
  thumbnail?: string | null;
  sourceAbr?: number | null;
  groupId?: string | null;
  groupTitle?: string | null;
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
    format: audio ? "ba/b" : vp.f,
    formatNote: audio ? preset.audioFormat.toUpperCase() : videoPresetLabel(vp.value, t),
    audioFormat: audio ? preset.audioFormat : null,
    bitrateMode: audio ? preset.bitrateMode : null,
    sourceAbr: audio ? ctx.sourceAbr ?? null : null,
    playlist: false,
    subtitleLangs: !audio && preset.subtitleLangs ? preset.subtitleLangs : null,
    embedSubs: !audio ? preset.embedSubs ?? null : null,
    metadata: null,
    title: ctx.title ?? null,
    thumbnail: ctx.thumbnail ?? null,
    groupId: ctx.groupId ?? null,
    groupTitle: ctx.groupTitle ?? null,
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

/** Best source audio bitrate (kbps) from an analysis, for CBR matching. */
export function sourceAbrOf(result: AnalyzeResult | null | undefined): number | null {
  if (!result || result.kind !== "video") return null;
  const abrs = result.formats
    .filter((f) => f.acodec && f.acodec !== "none")
    .map((f) => f.abr ?? 0);
  const max = Math.max(0, ...abrs);
  return max > 0 ? max : null;
}
