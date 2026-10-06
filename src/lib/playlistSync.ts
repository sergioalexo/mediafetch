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
