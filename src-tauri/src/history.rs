use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::types::HistoryEntry;

/// Serializes the whole read-modify-write cycle, not just the write. Two
/// downloads finishing at the same moment used to read the same list, then
/// write their own copy back one after the other — losing an entry every time.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

/// Entries kept on disk. Older ones are dropped as new downloads land.
const MAX_ENTRIES: usize = 2000;

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
        entries.insert(0, entry);
        entries.truncate(MAX_ENTRIES);
    });
}

pub fn remove(app: &AppHandle, id: &str) {
    update(app, |entries| entries.retain(|e| e.id != id));
}

pub fn clear(app: &AppHandle) {
    update(app, |entries| entries.clear());
}
