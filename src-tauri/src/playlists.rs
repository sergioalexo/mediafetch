//! Watched playlists: probe each one on demand, diff it against its own
//! yt-dlp archive file, and hand the songs that aren't there yet back to the
//! frontend to queue. Nothing here polls — a timer could call
//! [`check_playlists`] later without changes.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::downloader::{self, settings_snapshot, AppState};
use crate::metadata::{probe, s, thumbnail_of};
use crate::settings::{self, Settings};
use crate::types::now_unix;

/// One playlist song, as far as a flat probe knows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: Option<String>,
    /// yt-dlp extractor name as it appears in archive lines ("youtube").
    #[serde(skip)]
    pub extractor: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistProbe {
    pub title: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCheck {
    pub playlist_id: String,
    pub title: String,
    pub new_entries: Vec<Entry>,
    /// The playlist's own archive; tasks pass it as `archiveFile`.
    pub archive_file: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// Another sync was already in flight; nothing was checked.
    pub already_running: bool,
    pub checks: Vec<PlaylistCheck>,
}

static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

/// Releases the sync flag however the check ends, early returns included.
struct SyncGuard;

impl SyncGuard {
    fn acquire() -> Option<Self> {
        SYNC_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, Ordering::Release);
    }
}

fn archive_path(app: &AppHandle, playlist_id: &str) -> Result<PathBuf, String> {
    // The id becomes a file name; only ever accept the shape we generate.
    if playlist_id.is_empty()
        || !playlist_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid playlist id".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("playlist-archives");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{playlist_id}.txt")))
}

/// Ids recorded in an archive file's text. Lines are `<extractor> <id>`;
/// blank or malformed lines are ignored. Only the id is kept, so an entry is
/// recognised whichever extractor spelling wrote it.
fn parse_archive(text: &str) -> HashSet<String> {
    text.lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        .map(String::from)
        .collect()
}

/// A missing or unreadable file means nothing has been downloaded yet.
fn read_archive(path: &std::path::Path) -> HashSet<String> {
    std::fs::read_to_string(path)
        .map(|t| parse_archive(&t))
        .unwrap_or_default()
}

/// Title and songs out of a `yt-dlp -J --flat-playlist` result. Entries
/// without an id, and YouTube's placeholders for removed songs, are dropped.
fn parse_entries(info: &Value) -> (String, Vec<Entry>) {
    let title = s(info, "title").unwrap_or_else(|| "Playlist".into());
    let entries = info
        .get("entries")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let id = s(e, "id").filter(|i| !i.is_empty())?;
                    let title = s(e, "title").unwrap_or_else(|| "Untitled".into());
                    if title == "[Deleted video]" || title == "[Private video]" {
                        return None;
                    }
                    let url = s(e, "url")
                        .or_else(|| s(e, "webpage_url"))
                        .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
                    let extractor = s(e, "ie_key")
                        .map(|k| k.to_lowercase())
                        .unwrap_or_else(|| "youtube".into());
                    Some(Entry { id, title, url, thumbnail: thumbnail_of(e), extractor })
                })
                .collect()
        })
        .unwrap_or_default();
    (title, entries)
}

/// The songs not yet in the archive, in playlist order.
fn diff_new(entries: Vec<Entry>, archived: &HashSet<String>) -> Vec<Entry> {
    entries.into_iter().filter(|e| !archived.contains(&e.id)).collect()
}

async fn list_entries(
    app: &AppHandle,
    url: &str,
    settings: &Settings,
) -> Result<(String, Vec<Entry>), String> {
    let stdout = probe(app, url, settings).await?;
    downloader::clear_log(app, &downloader::analyze_log_id(url));
    let info: Value =
        serde_json::from_slice(&stdout).map_err(|e| format!("Bad yt-dlp output: {e}"))?;
    Ok(parse_entries(&info))
}

/// Cheap shape check before spending a network call on a pasted URL.
fn is_playlist_url(url: &str) -> bool {
    url.contains("list=")
}

/// Record the outcome of a check on the stored playlist and persist it. A
/// playlist removed while the check ran is simply skipped.
fn record_check(app: &AppHandle, check: &PlaylistCheck) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        let Some(p) = settings.watched_playlists.iter_mut().find(|p| p.id == check.playlist_id)
        else {
            return;
        };
        p.last_checked = Some(now_unix());
        match &check.error {
            Some(e) => p.last_error = Some(e.clone()),
            None => {
                p.last_error = None;
                p.last_new_count = Some(check.new_entries.len() as u32);
            }
        }
        settings.clone()
    };
    let _ = settings::save(app, &snapshot);
}

/// Validate a pasted URL and prefill the add dialog.
#[tauri::command]
pub async fn probe_playlist(app: AppHandle, url: String) -> Result<PlaylistProbe, String> {
    let url = url.trim().to_string();
    if !is_playlist_url(&url) {
        return Err("That link isn't a playlist (it has no list= part).".into());
    }
    let settings = settings_snapshot(&app);
    let (title, entries) = list_entries(&app, &url, &settings).await?;
    if entries.is_empty() {
        return Err("No songs found in that playlist.".into());
    }
    Ok(PlaylistProbe { title, count: entries.len() })
}

/// "Only new songs from now on": mark everything currently in the playlist as
/// already downloaded.
#[tauri::command]
pub async fn seed_playlist_archive(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let path = archive_path(&app, &id)?;
    let settings = settings_snapshot(&app);
    let (_, entries) = list_entries(&app, url.trim(), &settings).await?;
    let known = read_archive(&path);
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for e in entries.iter().filter(|e| !known.contains(&e.id)) {
        text.push_str(&format!("{} {}\n", e.extractor, e.id));
    }
    crate::fsutil::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())
}

/// Probe each enabled playlist (or just `ids`) one after another and report
/// the songs that aren't in its archive. A second call while one is running
/// returns at once instead of starting another.
#[tauri::command]
pub async fn check_playlists(
    app: AppHandle,
    ids: Option<Vec<String>>,
) -> Result<SyncOutcome, String> {
    let Some(_guard) = SyncGuard::acquire() else {
        return Ok(SyncOutcome { already_running: true, checks: Vec::new() });
    };
    let settings = settings_snapshot(&app);
    let targets: Vec<_> = settings
        .watched_playlists
        .iter()
        .filter(|p| match &ids {
            Some(ids) => ids.contains(&p.id),
            None => p.enabled,
        })
        .cloned()
        .collect();

    let mut checks = Vec::new();
    for (i, p) in targets.iter().enumerate() {
        // Sequential on purpose, with the user's request throttle between
        // playlists, to stay gentle on YouTube.
        if i > 0 && settings.sleep_requests > 0.0 {
            tokio::time::sleep(std::time::Duration::from_secs_f64(settings.sleep_requests)).await;
        }
        let archive = archive_path(&app, &p.id)?;
        let mut check = PlaylistCheck {
            playlist_id: p.id.clone(),
            title: p.title.clone(),
            new_entries: Vec::new(),
            archive_file: archive.to_string_lossy().into_owned(),
            error: None,
        };
        match list_entries(&app, &p.url, &settings).await {
            Ok((_, entries)) => check.new_entries = diff_new(entries, &read_archive(&archive)),
            Err(e) => check.error = Some(e),
        }
        record_check(&app, &check);
        checks.push(check);
    }
    Ok(SyncOutcome { already_running: false, checks })
}

/// Bind `shortcut` system-wide; pressing it asks the frontend to run a sync.
/// The frontend owns the sync flow (it knows presets and shows the toast), so
/// this only emits the request.
fn register_sync_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let parsed: Shortcut = shortcut
        .parse()
        .map_err(|_| format!("\"{shortcut}\" isn't a valid shortcut."))?;
    app.global_shortcut()
        .on_shortcut(parsed, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit("playlist-sync-requested", ());
            }
        })
        .map_err(|_| format!("Couldn't register {shortcut} — another app may be using it."))
}

/// Startup registration. A shortcut that fails here (taken by another app
/// since last run) is logged, not fatal; the Sync button still works.
pub fn register_saved_shortcut(app: &AppHandle) {
    let shortcut = settings_snapshot(app).playlist_sync_shortcut;
    if shortcut.trim().is_empty() {
        return;
    }
    if let Err(e) = register_sync_shortcut(app, shortcut.trim()) {
        downloader::push_log(app, "app", e);
    }
}

/// Swap the sync hotkey ("" turns it off). The old one stays bound if the new
/// one can't be registered, and nothing is saved in that case.
#[tauri::command]
pub fn set_playlist_sync_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    let old = settings_snapshot(&app).playlist_sync_shortcut;
    let old = old.trim();
    if shortcut == old {
        return Ok(());
    }
    if !old.is_empty() {
        if let Ok(parsed) = old.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(parsed);
        }
    }
    if !shortcut.is_empty() {
        if let Err(e) = register_sync_shortcut(&app, &shortcut) {
            // Put the previous binding back rather than leave none.
            if !old.is_empty() {
                let _ = register_sync_shortcut(&app, old);
            }
            return Err(e);
        }
    }
    let state = app.state::<AppState>();
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.playlist_sync_shortcut = shortcut;
        settings.clone()
    };
    settings::save(&app, &snapshot)
}

/// Called when a playlist is removed from the list.
#[tauri::command(async)]
pub fn delete_playlist_archive(app: AppHandle, id: String) -> Result<(), String> {
    match std::fs::remove_file(archive_path(&app, &id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn archive_keeps_the_id_and_skips_blank_or_malformed_lines() {
        let ids = parse_archive("youtube abc\n\n  \nsoundcloud 123 extra\nlonely\r\nyoutube def\r\n");
        assert_eq!(ids, HashSet::from(["abc".to_string(), "123".into(), "def".into()]));
    }

    #[test]
    fn missing_archive_is_empty() {
        assert!(read_archive(std::path::Path::new("no/such/archive.txt")).is_empty());
    }

    fn info() -> Value {
        json!({
            "title": "Mix",
            "entries": [
                {"id": "a", "title": "A", "url": "https://www.youtube.com/watch?v=a", "ie_key": "Youtube"},
                {"id": "b", "title": "[Deleted video]"},
                {"id": "c", "title": "[Private video]"},
                {"title": "No id"},
                {"id": "d", "title": "D", "thumbnails": [{"url": "https://i/d.jpg"}]},
            ]
        })
    }

    #[test]
    fn entries_skip_placeholders_and_idless_items() {
        let (title, entries) = parse_entries(&info());
        assert_eq!(title, "Mix");
        let ids: Vec<_> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["a", "d"]);
        assert_eq!(entries[0].extractor, "youtube");
        // No url in the probe: built from the id.
        assert_eq!(entries[1].url, "https://www.youtube.com/watch?v=d");
        assert_eq!(entries[1].thumbnail.as_deref(), Some("https://i/d.jpg"));
    }

    #[test]
    fn diff_returns_only_unarchived_entries_in_order() {
        let (_, entries) = parse_entries(&info());
        let archived = HashSet::from(["a".to_string()]);
        let new = diff_new(entries, &archived);
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].id, "d");
    }

    #[test]
    fn only_urls_with_a_list_are_playlists() {
        assert!(is_playlist_url("https://music.youtube.com/playlist?list=PL1"));
        assert!(!is_playlist_url("https://www.youtube.com/watch?v=abc"));
    }

    #[test]
    fn second_sync_is_refused_until_the_first_ends() {
        let first = SyncGuard::acquire();
        assert!(first.is_some());
        assert!(SyncGuard::acquire().is_none());
        drop(first);
        assert!(SyncGuard::acquire().is_some());
    }
}
