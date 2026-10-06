// The UI's copy of the download history has to follow the same merge rule
// as the file the backend writes (src-tauri/src/history.rs, `merge_one`),
// or the History page shows entries the file no longer has until a restart.

import type { HistoryEntry } from "./types";

/** Same piece of media: the same canonical key, or — when either lacks one — the same URL. */
export function sameMedia(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.mediaKey && b.mediaKey) return a.mediaKey === b.mediaKey;
  return a.url === b.url;
}

/**
 * Add a freshly recorded entry, newest first. It replaces any entry with the
 * same id (the same task's earlier outcome — a manual retry reuses the id) and
 * any earlier *failure* of the same media. A completed entry is never removed
 * by a later failure.
 */
export function mergeHistoryEntry(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [
    entry,
    ...history.filter(
      (e) => e.id !== entry.id && !(e.status === "failed" && sameMedia(e, entry))
    ),
  ];
}
