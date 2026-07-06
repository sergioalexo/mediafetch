use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::types::HistoryEntry;

static HISTORY_LOCK: Mutex<()> = Mutex::new(());

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("history.json"))
}

pub fn load(app: &AppHandle) -> Vec<HistoryEntry> {
    let _guard = HISTORY_LOCK.lock().unwrap();
    history_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, entries: &[HistoryEntry]) {
    if let Ok(path) = history_path(app) {
        if let Ok(json) = serde_json::to_string(entries) {
            let _ = std::fs::write(path, json);
        }
    }
}

pub fn add(app: &AppHandle, entry: HistoryEntry) {
    let mut entries = load(app);
    let _guard = HISTORY_LOCK.lock().unwrap();
    entries.insert(0, entry);
    entries.truncate(2000);
    save(app, &entries);
}

pub fn remove(app: &AppHandle, id: &str) {
    let mut entries = load(app);
    let _guard = HISTORY_LOCK.lock().unwrap();
    entries.retain(|e| e.id != id);
    save(app, &entries);
}

pub fn clear(app: &AppHandle) {
    let _guard = HISTORY_LOCK.lock().unwrap();
    save(app, &[]);
}
