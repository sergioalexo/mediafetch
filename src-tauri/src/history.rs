use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::fsutil::write_atomic;
use crate::types::{now_unix, HistoryEntry};

/// Reject an import file bigger than this outright — a malformed or hostile
/// file has no business being this large, and reading it in whole as a
/// String would otherwise be the first thing this code does with it.
const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

/// What `export_history` writes to disk, and the shape `import_history`
/// accepts (in addition to a bare `HistoryEntry[]` array — a raw
/// `history.json` copied from another install).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    app: String,
    format: u32,
    exported_at: u64,
    entries: Vec<HistoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archive: Option<Vec<String>>,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub skipped: usize,
    pub archive_added: usize,
}

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
    retain_newest(entries, MAX_FAILED_ENTRIES, MAX_COMPLETED_ENTRIES);
}

/// Sort newest first, then keep at most `max_failed` failed and
/// `max_completed` completed entries.
fn retain_newest(entries: &mut Vec<HistoryEntry>, max_failed: usize, max_completed: usize) {
    entries.sort_by_key(|e| std::cmp::Reverse(e.downloaded_at));
    let (mut failed, mut completed) = (0usize, 0usize);
    entries.retain(|e| {
        let (count, max) = if e.status == "failed" {
            (&mut failed, max_failed)
        } else {
            (&mut completed, max_completed)
        };
        *count += 1;
        *count <= max
    });
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

fn save(app: &AppHandle, entries: &[HistoryEntry]) {
    let Ok(path) = history_path(app) else {
        return;
    };
    let Ok(json) = serde_json::to_string(entries) else {
        return;
    };
    let _ = write_atomic(&path, json.as_bytes());
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

/// Add one entry to an already-loaded list, without touching disk. Shared by
/// `add` (one entry) and `import` (many); src/lib/history.ts mirrors it so the
/// UI's copy stays identical to the file.
///
/// The newest outcome for a piece of media supersedes an earlier *failure*
/// of it: a success clears it, and a repeat failure replaces it rather than
/// stacking up. An entry with the same id is the same task's earlier outcome
/// (a manual retry reuses the id), so it is replaced too — two entries can
/// never share an id. A completed entry is never removed by a later failure.
pub fn merge_one(entries: &mut Vec<HistoryEntry>, entry: HistoryEntry) {
    entries.retain(|e| e.id != entry.id && !(e.status == "failed" && same_media(e, &entry)));
    entries.insert(0, entry);
}

/// Merge a batch of incoming entries into an already-loaded list, applying
/// the import rules: skip a duplicate id, skip a completed entry whose media
/// already has a completed entry, let a completed import replace an
/// existing failure. Pure — no disk I/O — so it's unit-testable on its own.
fn merge_import(entries: &mut Vec<HistoryEntry>, incoming: Vec<HistoryEntry>) -> ImportReport {
    let mut report = ImportReport::default();
    for mut entry in incoming {
        if !valid_import_entry(&entry) {
            report.skipped += 1;
            continue;
        }
        let dup_by_id = entries.iter().any(|e| e.id == entry.id);
        // A completed entry is a duplicate of another completed one for the
        // same media; a failure adds nothing once the media has any entry.
        let dup_media = entries.iter().any(|e| {
            same_media(e, &entry) && (entry.status == "failed" || e.status == "completed")
        });
        if dup_by_id || dup_media {
            report.skipped += 1;
            continue;
        }
        entry.source = Some("imported".into());
        merge_one(entries, entry);
        report.added += 1;
    }
    report
}

fn archive_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("download-archive.txt"))
        .map_err(|e| e.to_string())
}

fn read_archive_lines(path: &PathBuf) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Write the current history (and the download archive, if present) to a
/// single backup file the user chose a location for.
pub fn export(app: &AppHandle, path: &str) -> Result<usize, String> {
    let entries = load(app);
    let archive = archive_path(app).ok().filter(|p| p.exists()).map(|p| read_archive_lines(&p));
    let file = ExportFile {
        app: "MediaFetch".into(),
        format: 1,
        exported_at: now_unix(),
        entries: entries.clone(),
        archive,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(entries.len())
}

/// Validate one incoming entry well enough that a malformed or hand-edited
/// file can't corrupt the real history: a URL, a known status, nothing else
/// required (old exports predate several optional fields).
fn valid_import_entry(e: &HistoryEntry) -> bool {
    !e.url.trim().is_empty() && matches!(e.status.as_str(), "completed" | "failed")
}

/// Merge a backup (this app's export format, or a bare `HistoryEntry[]`
/// array copied straight from another install's `history.json`) into the
/// current history. Never replaces — only adds what isn't already there.
pub fn import(app: &AppHandle, path: &str) -> Result<ImportReport, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("That file is larger than 50 MB — it doesn't look like a history backup."
            .into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;

    let (incoming, incoming_archive): (Vec<HistoryEntry>, Vec<String>) =
        if let Ok(file) = serde_json::from_str::<ExportFile>(&text) {
            (file.entries, file.archive.unwrap_or_default())
        } else if let Ok(bare) = serde_json::from_str::<Vec<HistoryEntry>>(&text) {
            (bare, Vec::new())
        } else {
            return Err("Not a MediaFetch history file.".into());
        };

    let _guard = HISTORY_LOCK.lock().unwrap();
    let mut entries = read_unlocked(app);
    let mut report = merge_import(&mut entries, incoming);
    apply_retention(&mut entries);
    save(app, &entries);
    drop(_guard);

    if !incoming_archive.is_empty() {
        if let Ok(path) = archive_path(app) {
            let mut lines: std::collections::BTreeSet<String> =
                read_archive_lines(&path).into_iter().collect();
            let before = lines.len();
            for line in incoming_archive {
                if !line.trim().is_empty() {
                    lines.insert(line);
                }
            }
            report.archive_added = lines.len().saturating_sub(before);
            if report.archive_added > 0 {
                let joined = lines.into_iter().collect::<Vec<_>>().join("\n");
                let _ = write_atomic(&path, (joined + "\n").as_bytes());
            }
        }
    }

    Ok(report)
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
    fn a_repeat_failure_replaces_the_earlier_one() {
        let mut entries = vec![entry("1", "https://x.com/a", "failed", Some("X:a"), 1)];
        merge_one(&mut entries, entry("1", "https://x.com/a", "failed", Some("X:a"), 2));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].downloaded_at, 2);
    }

    #[test]
    fn a_failure_never_removes_a_completed_entry() {
        let mut entries = vec![entry("1", "https://x.com/a", "completed", Some("X:a"), 1)];
        merge_one(&mut entries, entry("2", "https://x.com/a", "failed", Some("X:a"), 2));
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.status == "completed"));
    }

    #[test]
    fn ids_stay_unique() {
        let mut entries = vec![entry("1", "https://x.com/a", "failed", None, 1)];
        merge_one(&mut entries, entry("1", "https://x.com/b", "failed", None, 2));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "https://x.com/b");
    }

    #[test]
    fn import_skips_a_failure_for_media_already_in_history() {
        let mut entries = vec![entry("1", "https://x.com/a", "completed", Some("X:a"), 1)];
        let report = merge_import(
            &mut entries,
            vec![entry("2", "https://x.com/a", "failed", Some("X:a"), 5)],
        );
        assert_eq!(report.added, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(entries.len(), 1);
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
        // Small caps instead of generating thousands of rows.
        retain_newest(&mut entries, 3, 2);
        assert_eq!(entries.iter().filter(|e| e.status == "failed").count(), 3);
        assert_eq!(entries.iter().filter(|e| e.status == "completed").count(), 2);
        // Newest kept, within each bucket.
        assert_eq!(entries.iter().find(|e| e.status == "completed").unwrap().id, "14");
        assert_eq!(entries.iter().find(|e| e.status == "failed").unwrap().id, "9");
    }

    #[test]
    fn import_skips_an_existing_id() {
        let mut entries = vec![entry("1", "https://x.com/a", "completed", None, 1)];
        let report = merge_import(
            &mut entries,
            vec![entry("1", "https://x.com/a", "completed", None, 1)],
        );
        assert_eq!(report.added, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn import_skips_a_completed_duplicate_of_the_same_media_under_a_different_id() {
        let mut entries = vec![entry("1", "https://x.com/a", "completed", Some("X:a"), 1)];
        let report = merge_import(
            &mut entries,
            vec![entry("2", "https://x.com/a", "completed", Some("X:a"), 5)],
        );
        assert_eq!(report.added, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn import_replaces_a_failed_entry_with_a_completed_one() {
        let mut entries = vec![entry("1", "https://x.com/a", "failed", Some("X:a"), 1)];
        let report = merge_import(
            &mut entries,
            vec![entry("2", "https://x.com/a", "completed", Some("X:a"), 5)],
        );
        assert_eq!(report.added, 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "completed");
        assert_eq!(entries[0].source.as_deref(), Some("imported"));
    }

    #[test]
    fn import_adds_a_new_entry_and_marks_it_imported() {
        let mut entries = vec![entry("1", "https://x.com/a", "completed", None, 1)];
        let report = merge_import(
            &mut entries,
            vec![entry("2", "https://x.com/b", "completed", None, 2)],
        );
        assert_eq!(report.added, 1);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries.iter().find(|e| e.id == "2").unwrap().source.as_deref(),
            Some("imported")
        );
    }

    #[test]
    fn import_skips_an_entry_missing_a_url_or_with_an_unknown_status() {
        let mut entries: Vec<HistoryEntry> = Vec::new();
        let mut no_url = entry("1", "https://x.com/a", "completed", None, 1);
        no_url.url = "".into();
        let mut bad_status = entry("2", "https://x.com/b", "completed", None, 1);
        bad_status.status = "weird".into();
        let report = merge_import(&mut entries, vec![no_url, bad_status]);
        assert_eq!(report.added, 0);
        assert_eq!(report.skipped, 2);
        assert!(entries.is_empty());
    }

    #[test]
    fn importing_twice_adds_nothing_the_second_time() {
        let mut entries = vec![entry("1", "https://x.com/a", "completed", Some("X:a"), 1)];
        let backup = vec![entry("1", "https://x.com/a", "completed", Some("X:a"), 1)];
        merge_import(&mut entries, backup.clone());
        let report = merge_import(&mut entries, backup);
        assert_eq!(report.added, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(entries.len(), 1);
    }
}
