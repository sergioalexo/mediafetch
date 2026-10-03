use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::types::HistoryEntry;

/// Serializes the whole read-modify-write cycle, not just the write. Two
/// downloads finishing at the same moment used to read the same list, then
/// write their own copy back one after the other — losing an entry every time.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

/// Failed entries are capped tightly: they're clutter, not a record worth
/// keeping forever. Completed ones are the actual point of this file, so
/// they get a very high safety-valve cap instead of a real limit.
const MAX_FAILED_ENTRIES: usize = 500;
const MAX_COMPLETED_ENTRIES: usize = 100_000;

/// Apply the retention caps, keeping the newest of each bucket.
fn apply_retention(entries: &mut Vec<HistoryEntry>) {
    entries.sort_by_key(|e| std::cmp::Reverse(e.downloaded_at));
    let mut kept: Vec<HistoryEntry> = Vec::with_capacity(entries.len());
    let mut completed = 0usize;
    let mut failed = 0usize;
    for e in entries.drain(..) {
        if e.status == "failed" {
            if failed >= MAX_FAILED_ENTRIES {
                continue;
            }
            failed += 1;
        } else {
            if completed >= MAX_COMPLETED_ENTRIES {
                continue;
            }
            completed += 1;
        }
        kept.push(e);
    }
    *entries = kept;
}

/// True when two entries refer to the same piece of media: the same canonical
/// media key, or — when either lacks one — the same URL.
fn same_media(a: &HistoryEntry, b: &HistoryEntry) -> bool {
    match (&a.media_key, &b.media_key) {
        (Some(x), Some(y)) => x == y,
        _ => a.url == b.url,
    }
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("history.json"))
}

/// Read the file. Callers must already hold HISTORY_LOCK.
fn read_unlocked(app: &AppHandle) -> Vec<HistoryEntry> {
    history_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn load(app: &AppHandle) -> Vec<HistoryEntry> {
    let _guard = HISTORY_LOCK.lock().unwrap();
    read_unlocked(app)
}

/// Write via a temporary file and rename, so an interrupted write leaves the
/// previous history intact instead of a half-written file that parses as empty.
fn save(app: &AppHandle, entries: &[HistoryEntry]) {
    let Ok(path) = history_path(app) else {
        return;
    };
    let Ok(json) = serde_json::to_string(entries) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    // std::fs::rename replaces the destination on every platform we ship
    // (MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows), so the old file
    // stays readable right up to the swap. On failure the previous history is
    // still on disk untouched — only the temp file needs clearing.
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Read-modify-write the history under one lock.
fn update<F: FnOnce(&mut Vec<HistoryEntry>)>(app: &AppHandle, f: F) {
    let _guard = HISTORY_LOCK.lock().unwrap();
    let mut entries = read_unlocked(app);
    f(&mut entries);
    save(app, &entries);
}

pub fn add(app: &AppHandle, entry: HistoryEntry) {
    update(app, |entries| {
        // A later success replaces an earlier failure for the same media —
        // a track that failed, then was retried by hand and succeeded, should
        // leave one completed entry, not two with the same id.
        merge_one(entries, entry);
        apply_retention(entries);
    });
}

pub fn remove(app: &AppHandle, id: &str) {
    update(app, |entries| entries.retain(|e| e.id != id));
}

pub fn clear(app: &AppHandle) {
    update(app, |entries| entries.clear());
}

/// Apply the completed-replaces-failed merge rule to an already-loaded list,
/// without touching disk. Shared by `add` (one entry) and `import` (many).
pub fn merge_one(entries: &mut Vec<HistoryEntry>, entry: HistoryEntry) {
    if entry.status == "completed" {
        entries.retain(|e| !(e.status == "failed" && same_media(e, &entry)));
    }
    entries.insert(0, entry);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, url: &str, status: &str, media_key: Option<&str>, at: u64) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            url: url.into(),
            title: id.into(),
            filename: None,
            filesize: 0,
            kind: "video".into(),
            format_note: None,
            downloaded_at: at,
            elapsed_secs: 0,
            avg_speed: 0.0,
            status: status.into(),
            media_key: media_key.map(String::from),
            source: Some("local".into()),
        }
    }

    #[test]
    fn same_media_by_key_ignores_url() {
        let a = entry("1", "https://youtube.com/watch?v=X", "failed", Some("Youtube:X"), 1);
        let b = entry("2", "https://music.youtube.com/watch?v=X", "completed", Some("Youtube:X"), 2);
        assert!(same_media(&a, &b));
    }

    #[test]
    fn same_media_falls_back_to_url_without_a_key() {
        let a = entry("1", "https://example.com/a", "failed", None, 1);
        let b = entry("2", "https://example.com/a", "completed", None, 2);
        let c = entry("3", "https://example.com/b", "completed", None, 2);
        assert!(same_media(&a, &b));
        assert!(!same_media(&a, &c));
    }

    #[test]
    fn completed_replaces_failed_for_same_media() {
        let mut entries = vec![entry("1", "https://x.com/a", "failed", Some("X:a"), 1)];
        merge_one(&mut entries, entry("1", "https://x.com/a", "completed", Some("X:a"), 2));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "completed");
    }

    #[test]
    fn completed_does_not_remove_unrelated_failures() {
        let mut entries = vec![entry("1", "https://x.com/a", "failed", Some("X:a"), 1)];
        merge_one(&mut entries, entry("2", "https://x.com/b", "completed", Some("X:b"), 2));
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn retention_caps_failed_and_completed_separately() {
        let mut entries: Vec<HistoryEntry> = (0..10)
            .map(|i| entry(&i.to_string(), "https://x.com", "failed", None, i as u64))
            .chain(
                (10..15).map(|i| entry(&i.to_string(), "https://x.com", "completed", None, i as u64)),
            )
            .collect();
        // Shrink the caps for the test instead of generating thousands of rows.
        entries.sort_by_key(|e| std::cmp::Reverse(e.downloaded_at));
        let mut kept = Vec::new();
        let (mut completed, mut failed) = (0usize, 0usize);
        for e in entries.drain(..) {
            if e.status == "failed" {
                if failed >= 3 {
                    continue;
                }
                failed += 1;
            } else {
                if completed >= 2 {
                    continue;
                }
                completed += 1;
            }
            kept.push(e);
        }
        assert_eq!(kept.iter().filter(|e| e.status == "failed").count(), 3);
        assert_eq!(kept.iter().filter(|e| e.status == "completed").count(), 2);
        // Newest kept, within each bucket.
        assert_eq!(kept.iter().find(|e| e.status == "completed").unwrap().id, "14");
    }
}
