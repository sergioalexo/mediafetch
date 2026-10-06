import type { DownloadOptions, Preset, Settings, WatchedPlaylist } from "./types";
import type { MsgKey } from "./i18n";
import { optionsFromPreset } from "./presets";

/** One song the backend found missing from a playlist's archive. */
export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  thumbnail?: string | null;
}

export interface PlaylistCheck {
  playlistId: string;
  title: string;
  newEntries: PlaylistEntry[];
  /** The playlist's own yt-dlp archive, passed on so each song is recorded there. */
  archiveFile: string;
  error?: string | null;
}

export interface SyncOutcome {
  /** Another sync was already in flight; nothing was checked. */
  alreadyRunning: boolean;
  checks: PlaylistCheck[];
}

/** The preset a playlist's songs download with; a deleted one falls back to the default. */
export function presetForPlaylist(
  settings: Pick<Settings, "presets" | "defaultPresetId">,
  playlist: Pick<WatchedPlaylist, "presetId">
): Preset | null {
  return (
    settings.presets.find((p) => p.id === playlist.presetId) ??
    settings.presets.find((p) => p.id === settings.defaultPresetId) ??
    settings.presets[0] ??
    null
  );
}

/**
 * Queue items for a check's new songs: one task per song, grouped under the
 * playlist, each writing to the playlist's own archive. Empty when there is
 * nothing new, the playlist was removed meanwhile, or no preset exists.
 */
export function buildSyncItems(
  check: PlaylistCheck,
  settings: Pick<Settings, "presets" | "defaultPresetId" | "watchedPlaylists" | "audioSampleRate">,
  t: (k: MsgKey) => string
): DownloadOptions[] {
  const playlist = settings.watchedPlaylists.find((p) => p.id === check.playlistId);
  if (!playlist || check.newEntries.length === 0) return [];
  const preset = presetForPlaylist(settings, playlist);
  if (!preset) return [];
  return check.newEntries.map((e) => ({
    ...optionsFromPreset(
      preset,
      {
        url: e.url,
        title: e.title,
        thumbnail: e.thumbnail,
        groupId: playlist.id,
        groupTitle: playlist.title,
        globalSampleRate: settings.audioSampleRate,
      },
      t
    ),
    archiveFile: check.archiveFile,
  }));
}

const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph"];

/** Plugin spelling of `KeyboardEvent.code`, or null for keys it cannot bind. */
function shortcutKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete",
  };
  return named[code] ?? null;
}

/**
 * The `CommandOrControl+Shift+M` string for a keydown, or null while only
 * modifiers are held, the key cannot be bound, or no modifier is down (a bare
 * letter as a global hotkey would swallow typing everywhere).
 */
export function shortcutFromEvent(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
): string | null {
  if (MODIFIER_KEYS.includes(e.key)) return null;
  const key = shortcutKey(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return mods.length ? [...mods, key].join("+") : null;
}

/** "CommandOrControl+Shift+M" as shown to the user. */
export function shortcutLabel(shortcut: string): string {
  return shortcut.replace("CommandOrControl", "Ctrl");
}
