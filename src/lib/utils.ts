import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { TaskStatus } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Display order only — the backend queue order still decides what starts
 * next. Active work floats to the top, finished work sinks to the bottom.
 */
const STATUS_RANK: Record<TaskStatus, number> = {
  downloading: 0,
  postprocessing: 0,
  queued: 1,
  paused: 2,
  failed: 3,
  cancelled: 3,
  completed: 4,
};

export function statusRank(status: TaskStatus): number {
  return STATUS_RANK[status];
}

/**
 * Stable sort of anything with a status by display rank — active first,
 * then queued, paused, failed/cancelled, completed last. Ties keep their
 * original relative order (`Array.prototype.sort` is stable in every engine
 * this app ships on).
 */
export function sortByStatusRank<T extends { status: TaskStatus }>(items: T[]): T[] {
  return [...items].sort((a, b) => statusRank(a.status) - statusRank(b.status));
}

/** The rank of a group of tasks is its most-active member's rank. */
export function groupRank(statuses: TaskStatus[]): number {
  return statuses.reduce((best, s) => Math.min(best, statusRank(s)), 4);
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : decimals)} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatDuration(seconds?: number | null): string {
  if (seconds == null || seconds <= 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatDate(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const URL_RE = /https?:\/\/[^\s"'<>\])]+/g;

/**
 * Extract every http(s) URL from arbitrary text (paste / drop payloads).
 *
 * Pasting a batch of links is the normal way to use the app, and they arrive
 * however the source happened to separate them: newlines, spaces, commas, or
 * loose in a sentence. Whitespace the regex handles on its own; the rest needs
 * splitting on any separator that sits directly before the next link, and
 * trimming the sentence punctuation that would otherwise ride along.
 */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? [];
  const urls = found
    // Split only where another link actually begins, so a comma inside a URL
    // (map coordinates, some CDN paths) is left alone.
    .flatMap((run) => run.split(/[,;|]*(?=https?:\/\/)/g))
    .map((u) => u.trim().replace(/[.,;:!?]+$/, ""))
    .filter((u) => /^https?:\/\/\S+$/.test(u));
  return [...new Set(urls)];
}

/** Human-friendly source host for a URL, e.g. "youtube.com" (no "www."). */
export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The video/track id a URL points at, for the services we know how to read
 * one from, independent of which host or playlist context it was pasted
 * from (`music.youtube.com/watch?v=X` vs `youtube.com/watch?v=X&list=…`).
 */
export function extractMediaId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "youtube.com" || host === "music.youtube.com" || host.endsWith(".youtube.com")) {
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/);
    if (m) return m[1];
  }
  if (host === "youtu.be") {
    const m = u.pathname.match(/^\/([^/?#]+)/);
    if (m) return m[1];
  }
  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) {
    // SoundCloud has no stable short id in the URL itself — the path
    // (artist/track) *is* the identity, so normalizeUrl is what matches it.
    return null;
  }
  return null;
}

/**
 * A URL stripped down to the part that actually identifies the item: no
 * query string, no fragment, no trailing slash, scheme/host lowercased.
 * Lets a playlist link (`…&list=…`) and the bare track link match.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^music\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    // The id lives in the query string on some hosts (YouTube's "v="), and
    // stripping the whole query would collapse every video on the same path
    // into one key. Keep only that identifying param, drop the rest
    // (playlist/list/index and tracking params carry no identity of their
    // own).
    const id = u.searchParams.get("v");
    return id ? `${host}${path}?v=${id}` : `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
