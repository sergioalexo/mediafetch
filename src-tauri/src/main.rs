// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod binaries;
mod cookies;
mod downloader;
mod fsutil;
mod history;
mod metadata;
mod notify;
mod settings;
mod themes;
mod types;

use downloader::{settings_snapshot, AppState};
use settings::Settings;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use types::{now_unix, DownloadOptions, DownloadTask, HistoryEntry, TaskStatus};

// A plain `fn` command runs on the main thread — the one that also drives the
// window — so anything that spawns a process (taskkill, `yt-dlp --version`),
// or reads/writes a file that can grow large (history), is marked
// `#[tauri::command(async)]`, which runs it on a worker thread instead.

// ---------- Settings ----------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    settings::save(&app, &settings)?;
    *state.settings.lock().unwrap() = settings;
    // A raised parallel limit may allow more tasks to start.
    downloader::pump(&app);
    Ok(())
}

#[tauri::command]
async fn pick_download_dir(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_cookies_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Cookies", &["txt"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Report whether the configured cookie source actually yields cookies —
/// otherwise the only symptom is a download failing much later.
#[tauri::command]
async fn test_cookies(app: AppHandle) -> cookies::CookieCheck {
    let settings = settings_snapshot(&app);
    cookies::check(&app, &settings).await
}

// ---------- Analysis ----------

#[tauri::command]
async fn analyze_url(app: AppHandle, url: String) -> Result<metadata::AnalyzeResult, String> {
    let settings = settings_snapshot(&app);
    metadata::analyze(&app, &url, &settings).await
}

/// Preview the exact command line a download would run, without starting it —
/// lets you sanity-check a preset (including custom args) before committing to
/// a download. Shows whichever tool the task would actually use.
#[tauri::command(async)]
fn preview_command(app: AppHandle, options: DownloadOptions) -> Result<String, String> {
    let settings = settings_snapshot(&app);
    let gallery = downloader::is_gallery(&options);
    let tool = if gallery {
        binaries::gallerydl_path(&app)?
    } else {
        binaries::ytdlp_path(&app)?
    };
    let args = if gallery {
        downloader::build_gallerydl_args(&options, &settings)?
    } else {
        downloader::build_args(&app, &options, &settings, Default::default())?
    };
    let quoted: Vec<String> = args
        .iter()
        .map(|a| {
            if a.is_empty() || a.chars().any(char::is_whitespace) {
                format!("\"{}\"", a.replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect();
    Ok(format!("{} {}", tool.to_string_lossy(), quoted.join(" ")))
}

// ---------- Queue ----------

#[tauri::command]
fn get_queue(state: State<AppState>) -> Vec<DownloadTask> {
    state.queue.lock().unwrap().clone()
}

#[tauri::command]
fn get_task_log(app: AppHandle, id: String) -> Vec<String> {
    downloader::get_log(&app, &id)
}

/// The app-wide log book — everything the app has run this session.
#[tauri::command]
fn get_app_log() -> Vec<downloader::AppLogLine> {
    downloader::app_log_all()
}

#[tauri::command]
fn clear_app_log(app: AppHandle) {
    downloader::app_log_clear(&app);
}

/// Whether two requests would fetch the same thing the same way. Deliberately
/// strict: a URL queued as audio and again as video is two real outputs, so
/// only an identical request counts as a duplicate.
fn same_request(a: &DownloadOptions, b: &DownloadOptions) -> bool {
    a.url == b.url
        && a.kind == b.kind
        && a.engine == b.engine
        && a.format == b.format
        && a.audio_format == b.audio_format
        && a.audio_quality == b.audio_quality
        && a.playlist == b.playlist
        && a.playlist_items == b.playlist_items
}

/// Queue the given items, skipping any already covered by a live task, and
/// return how many were skipped. Two playlists routinely share a song; without
/// this it gets fetched twice, and with `max_parallel > 1` the copies can run
/// at once, so neither sees the other's finished file and they fight over the
/// same `.part`. Checking inside the same lock also dedupes within `items`.
#[tauri::command]
fn enqueue(app: AppHandle, state: State<AppState>, items: Vec<DownloadOptions>) -> usize {
    let mut skipped = 0usize;
    {
        let mut q = state.queue.lock().unwrap();
        for opts in items {
            // Only a live task blocks a duplicate. A completed, failed or
            // cancelled one stays in the queue until restart, and re-adding
            // those is a deliberate re-download.
            let duplicate = q
                .iter()
                .any(|t| t.status.is_live() && same_request(&t.options, &opts));
            if duplicate {
                skipped += 1;
                continue;
            }
            q.push(DownloadTask {
                id: uuid::Uuid::new_v4().to_string(),
                url: opts.url.clone(),
                title: opts.title.clone().unwrap_or_else(|| opts.url.clone()),
                thumbnail: opts.thumbnail.clone(),
                status: TaskStatus::Queued,
                progress: 0.0,
                downloaded_bytes: 0,
                total_bytes: 0,
                speed: 0.0,
                eta: 0.0,
                filename: None,
                error: None,
                added_at: now_unix(),
                started_at: None,
                completed_at: None,
                playlist_index: None,
                playlist_count: None,
                retry_count: 0,
                force_single_connection: false,
                media_key: None,
                options: opts,
            });
        }
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
    skipped
}

#[tauri::command(async)]
fn pause_task(app: AppHandle, state: State<AppState>, id: String) {
    let should_kill = {
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            let was_running = t.status.is_running();
            if was_running || t.status == TaskStatus::Queued {
                t.status = TaskStatus::Paused;
                t.speed = 0.0;
                t.eta = 0.0;
            }
            was_running
        } else {
            false
        }
    };
    if should_kill {
        downloader::kill_task_process(&app, &id);
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command]
fn resume_task(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            if t.status == TaskStatus::Paused {
                t.status = TaskStatus::Queued;
            }
        }
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command(async)]
fn cancel_task(app: AppHandle, state: State<AppState>, id: String) {
    let should_kill = {
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            let was_running = t.status.is_running();
            if t.status.is_live() {
                t.status = TaskStatus::Cancelled;
                t.speed = 0.0;
                t.eta = 0.0;
            }
            was_running
        } else {
            false
        }
    };
    if should_kill {
        downloader::kill_task_process(&app, &id);
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command(async)]
fn pause_all_tasks(app: AppHandle, state: State<AppState>) {
    let running_ids: Vec<String> = {
        let mut q = state.queue.lock().unwrap();
        q.iter_mut()
            .filter_map(|t| {
                let was_running = t.status.is_running();
                if was_running || t.status == TaskStatus::Queued {
                    t.status = TaskStatus::Paused;
                    t.speed = 0.0;
                    t.eta = 0.0;
                    was_running.then(|| t.id.clone())
                } else {
                    None
                }
            })
            .collect()
    };
    for id in running_ids {
        downloader::kill_task_process(&app, &id);
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command(async)]
fn cancel_all_tasks(app: AppHandle, state: State<AppState>) {
    let running_ids: Vec<String> = {
        let mut q = state.queue.lock().unwrap();
        q.iter_mut()
            .filter_map(|t| {
                let was_running = t.status.is_running();
                if t.status.is_live() {
                    t.status = TaskStatus::Cancelled;
                    t.speed = 0.0;
                    t.eta = 0.0;
                    was_running.then(|| t.id.clone())
                } else {
                    None
                }
            })
            .collect()
    };
    for id in running_ids {
        downloader::kill_task_process(&app, &id);
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command]
fn retry_task(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            if matches!(t.status, TaskStatus::Failed | TaskStatus::Cancelled) {
                t.status = TaskStatus::Queued;
                t.progress = 0.0;
                t.downloaded_bytes = 0;
                t.speed = 0.0;
                t.eta = 0.0;
                t.error = None;
                t.completed_at = None;
                t.retry_count = 0;
                t.force_single_connection = false;
            }
        }
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command(async)]
fn remove_task(app: AppHandle, state: State<AppState>, id: String) {
    // Dropping the task from the queue is what tells its exit handler not to
    // record anything; the kill comes after, outside the lock.
    let was_running = {
        let mut q = state.queue.lock().unwrap();
        let was_running = q.iter().any(|t| t.id == id && t.status.is_running());
        q.retain(|t| t.id != id);
        was_running
    };
    if was_running {
        downloader::kill_task_process(&app, &id);
    }
    downloader::clear_log(&app, &id);
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command]
fn reorder_task(app: AppHandle, state: State<AppState>, id: String, new_index: usize) {
    {
        let mut q = state.queue.lock().unwrap();
        if let Some(pos) = q.iter().position(|t| t.id == id) {
            let task = q.remove(pos);
            let idx = new_index.min(q.len());
            q.insert(idx, task);
        }
    }
    downloader::emit_queue(&app);
}

#[tauri::command]
fn clear_finished(app: AppHandle, state: State<AppState>) {
    let mut q = state.queue.lock().unwrap();
    let (finished, remaining): (Vec<_>, Vec<_>) = q.drain(..).partition(|t| !t.status.is_live());
    *q = remaining;
    drop(q);
    for t in finished {
        downloader::clear_log(&app, &t.id);
    }
    downloader::emit_queue(&app);
}

// ---------- History ----------

#[tauri::command(async)]
fn get_history(app: AppHandle) -> Vec<HistoryEntry> {
    history::load(&app)
}

#[tauri::command(async)]
fn clear_history(app: AppHandle) {
    history::clear(&app);
}

#[tauri::command(async)]
fn remove_history_entry(app: AppHandle, id: String) {
    history::remove(&app, &id);
}

#[tauri::command(async)]
fn export_history(app: AppHandle, path: String) -> Result<usize, String> {
    history::export(&app, &path)
}

#[tauri::command(async)]
fn import_history(app: AppHandle, path: String) -> Result<history::ImportReport, String> {
    let report = history::import(&app, &path)?;
    downloader::emit_history_replaced(&app);
    Ok(report)
}

/// A file from history may have been moved or deleted since; say so plainly
/// instead of surfacing the OS's "cannot find the path" error.
fn existing_path(path: &str) -> Result<&str, String> {
    if std::path::Path::new(path).exists() {
        Ok(path)
    } else {
        Err(format!("The file is no longer there: {path}"))
    }
}

#[tauri::command(async)]
fn show_in_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(existing_path(&path)?).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn open_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(existing_path(&path)?, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https URLs can be opened".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

// ---------- App updates ----------

const APP_REPO: &str = "sergioalexo/mediafetch";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateStatus {
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    releases_url: String,
}

/// "1.2.10" > "1.2.9" — numeric per-segment comparison.
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    parse(latest) > parse(current)
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<AppUpdateStatus, ()> {
    let current_version = app.package_info().version.to_string();
    let proxy = binaries::app_proxy(&app);
    let latest_version = binaries::latest_release_tag(APP_REPO, &proxy)
        .await
        .ok()
        .map(|t| t.trim_start_matches('v').to_string());
    let update_available = latest_version
        .as_deref()
        .map(|l| version_newer(l, &current_version))
        .unwrap_or(false);
    Ok(AppUpdateStatus {
        current_version,
        latest_version,
        update_available,
        releases_url: format!("https://github.com/{APP_REPO}/releases"),
    })
}

// ---------- Diagnostics / issue reporting ----------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    app_version: String,
    os: String,
    arch: String,
    ytdlp_version: Option<String>,
    ffmpeg_version: Option<String>,
    gallerydl_version: Option<String>,
}

/// Snapshot of the local environment for a bug report. Deliberately limited to
/// non-identifying info (versions, OS, CPU arch) — never paths, cookies or URLs.
#[tauri::command(async)]
fn collect_diagnostics(app: AppHandle) -> Diagnostics {
    Diagnostics {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ytdlp_version: binaries::tool_version(&app, binaries::YTDLP),
        ffmpeg_version: binaries::tool_version(&app, binaries::FFMPEG),
        gallerydl_version: binaries::tool_version(&app, binaries::GALLERYDL),
    }
}

// ---------- Binaries module ----------

#[tauri::command]
async fn get_binaries_status(
    app: AppHandle,
    check_latest: bool,
) -> Vec<binaries::BinaryStatus> {
    binaries::get_status(&app, check_latest).await
}

#[tauri::command]
async fn install_binary(
    app: AppHandle,
    name: String,
    version: Option<String>,
) -> Result<(), String> {
    binaries::install(&app, &name, version.as_deref()).await
}

#[tauri::command]
async fn list_binary_versions(app: AppHandle, name: String) -> Result<Vec<String>, String> {
    binaries::list_versions(&app, &name).await
}

#[tauri::command(async)]
fn rollback_binary(app: AppHandle, name: String) -> Result<(), String> {
    binaries::rollback(&app, &name)
}

#[tauri::command(async)]
fn uninstall_binary(app: AppHandle, name: String) -> Result<(), String> {
    binaries::uninstall(&app, &name)
}

#[tauri::command(async)]
fn reset_components(app: AppHandle) -> Result<(), String> {
    binaries::reset_all(&app)
}

fn main() {
    // reqwest is built without a bundled TLS crypto provider (see
    // Cargo.toml), so one has to be installed before the first request.
    // tauri-plugin-updater installs this same one; whichever runs first wins.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            // yt-dlp/ffmpeg children are plain OS processes, not tied to our
            // process lifetime — without this they keep running orphaned
            // after the window (and app) closes.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let pids: Vec<u32> = state.pids.lock().unwrap().values().copied().collect();
                for pid in pids {
                    downloader::kill_tree(pid);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = settings::load(&handle);
            let auto_update = loaded.auto_update_components;
            app.manage(AppState::new(loaded));

            // Everything below spawns processes or touches the registry, so it
            // runs in the background rather than holding the window back.
            let startup = handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                notify::register_app_identity(&startup);
                // Open the log book with the versions any bug report needs —
                // and with whether a JS runtime was found, which decides
                // whether YouTube extraction works at all.
                downloader::push_log(
                    &startup,
                    "app",
                    format!(
                        "MediaFetch {} on {} {} · yt-dlp {} · ffmpeg {} · JS runtime: {}",
                        startup.package_info().version,
                        std::env::consts::OS,
                        std::env::consts::ARCH,
                        binaries::tool_version(&startup, binaries::YTDLP)
                            .unwrap_or_else(|| "not installed".into()),
                        binaries::tool_version(&startup, binaries::FFMPEG)
                            .unwrap_or_else(|| "not installed".into()),
                        downloader::js_runtime_spec(&startup).unwrap_or_else(
                            || "none — install Deno from Components, or YouTube formats may be missing".into(),
                        ),
                    ),
                );
                // Warm the `yt-dlp --help` flag probe now, so the first
                // download doesn't pay for it.
                downloader::ytdlp_supports_js_runtimes(&startup);
            });

            if auto_update {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    // Only touch copies we manage ourselves — never overwrite
                    // a system-installed binary the user put on their PATH.
                    let statuses = binaries::get_status(&handle, true).await;
                    let mut updated = Vec::new();
                    for s in statuses.iter().filter(|s| s.managed && s.update_available) {
                        if binaries::install(&handle, &s.name, None).await.is_ok() {
                            updated.push(s.name.clone());
                        }
                    }
                    if !updated.is_empty() {
                        let _ = handle.emit("components-updated", &updated);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            pick_download_dir,
            pick_cookies_file,
            test_cookies,
            analyze_url,
            preview_command,
            get_queue,
            get_task_log,
            get_app_log,
            clear_app_log,
            enqueue,
            pause_task,
            resume_task,
            cancel_task,
            pause_all_tasks,
            cancel_all_tasks,
            retry_task,
            remove_task,
            reorder_task,
            clear_finished,
            get_history,
            clear_history,
            remove_history_entry,
            export_history,
            import_history,
            show_in_folder,
            open_file,
            open_external,
            get_binaries_status,
            install_binary,
            rollback_binary,
            uninstall_binary,
            reset_components,
            list_binary_versions,
            check_app_update,
            collect_diagnostics,
            themes::list_themes,
            themes::save_theme,
            themes::delete_theme,
            themes::import_theme,
            themes::export_theme,
            themes::fetch_community_themes
        ])
        .run(tauri::generate_context!())
        .expect("error while running MediaFetch");
}

#[cfg(test)]
mod tests {
    use super::same_request;
    use crate::types::DownloadOptions;

    fn opts(url: &str, kind: &str) -> DownloadOptions {
        DownloadOptions {
            url: url.into(),
            kind: kind.into(),
            ..Default::default()
        }
    }

    #[test]
    fn same_url_and_kind_is_a_duplicate() {
        assert!(same_request(
            &opts("https://y.tld/watch?v=a", "audio"),
            &opts("https://y.tld/watch?v=a", "audio")
        ));
    }

    #[test]
    fn audio_and_video_of_one_url_are_not_duplicates() {
        assert!(!same_request(
            &opts("https://y.tld/watch?v=a", "audio"),
            &opts("https://y.tld/watch?v=a", "video")
        ));
    }

    #[test]
    fn different_urls_are_not_duplicates() {
        assert!(!same_request(
            &opts("https://y.tld/watch?v=a", "audio"),
            &opts("https://y.tld/watch?v=b", "audio")
        ));
    }

    #[test]
    fn different_quality_of_one_url_is_not_a_duplicate() {
        let mut a = opts("https://y.tld/watch?v=a", "audio");
        let mut b = a.clone();
        a.audio_quality = Some("320".into());
        b.audio_quality = Some("128".into());
        assert!(!same_request(&a, &b));
    }

    #[test]
    fn different_slices_of_one_playlist_are_not_duplicates() {
        let mut a = opts("https://y.tld/playlist?list=p", "audio");
        a.playlist = true;
        let mut b = a.clone();
        a.playlist_items = Some("1-5".into());
        b.playlist_items = Some("6-10".into());
        assert!(!same_request(&a, &b));
    }

    #[test]
    fn grouping_and_display_fields_do_not_affect_identity() {
        // The same track reached through two playlists carries a different
        // groupId and title, and must still register as a duplicate.
        let mut a = opts("https://y.tld/watch?v=a", "audio");
        let mut b = a.clone();
        a.group_id = Some("g1".into());
        a.group_title = Some("Playlist One".into());
        a.title = Some("Track".into());
        b.group_id = Some("g2".into());
        b.group_title = Some("Playlist Two".into());
        b.thumbnail = Some("https://img.tld/b.jpg".into());
        assert!(same_request(&a, &b));
    }
}
