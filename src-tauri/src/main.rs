// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod binaries;
mod downloader;
mod history;
mod metadata;
mod notify;
mod settings;
mod types;

use downloader::AppState;
use settings::Settings;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use types::{now_unix, DownloadOptions, DownloadTask, HistoryEntry, TaskStatus};

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

// ---------- Analysis ----------

#[tauri::command]
async fn analyze_url(app: AppHandle, url: String) -> Result<metadata::AnalyzeResult, String> {
    let settings = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap().clone();
        s
    };
    metadata::analyze(&app, &url, &settings).await
}

/// Preview the exact yt-dlp command line a download would run, without
/// starting it — lets you sanity-check a preset (including custom args)
/// before committing to a download.
#[tauri::command]
fn preview_command(app: AppHandle, state: State<AppState>, options: DownloadOptions) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let ytdlp = binaries::ytdlp_path(&app)?;
    let args = downloader::build_args(&app, &options, &settings, false)?;
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
    Ok(format!("{} {}", ytdlp.to_string_lossy(), quoted.join(" ")))
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

#[tauri::command]
fn enqueue(app: AppHandle, state: State<AppState>, items: Vec<DownloadOptions>) {
    {
        let mut q = state.queue.lock().unwrap();
        for opts in items {
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
                options: opts,
            });
        }
    }
    downloader::emit_queue(&app);
    downloader::pump(&app);
}

#[tauri::command]
fn pause_task(app: AppHandle, state: State<AppState>, id: String) {
    let should_kill = {
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            let was_running = matches!(
                t.status,
                TaskStatus::Downloading | TaskStatus::Postprocessing
            );
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

#[tauri::command]
fn cancel_task(app: AppHandle, state: State<AppState>, id: String) {
    let should_kill = {
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            let was_running = matches!(
                t.status,
                TaskStatus::Downloading | TaskStatus::Postprocessing
            );
            if !matches!(t.status, TaskStatus::Completed | TaskStatus::Failed) {
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

#[tauri::command]
fn pause_all_tasks(app: AppHandle, state: State<AppState>) {
    let running_ids: Vec<String> = {
        let mut q = state.queue.lock().unwrap();
        q.iter_mut()
            .filter_map(|t| {
                let was_running = matches!(
                    t.status,
                    TaskStatus::Downloading | TaskStatus::Postprocessing
                );
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

#[tauri::command]
fn cancel_all_tasks(app: AppHandle, state: State<AppState>) {
    let running_ids: Vec<String> = {
        let mut q = state.queue.lock().unwrap();
        q.iter_mut()
            .filter_map(|t| {
                let was_running = matches!(
                    t.status,
                    TaskStatus::Downloading | TaskStatus::Postprocessing
                );
                if !matches!(t.status, TaskStatus::Completed | TaskStatus::Failed) {
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

#[tauri::command]
fn remove_task(app: AppHandle, state: State<AppState>, id: String) {
    let was_running = {
        let q = state.queue.lock().unwrap();
        q.iter().any(|t| {
            t.id == id
                && matches!(
                    t.status,
                    TaskStatus::Downloading | TaskStatus::Postprocessing
                )
        })
    };
    if was_running {
        // Mark cancelled first so the exit handler doesn't record a failure.
        let mut q = state.queue.lock().unwrap();
        if let Some(t) = q.iter_mut().find(|t| t.id == id) {
            t.status = TaskStatus::Cancelled;
        }
        drop(q);
        downloader::kill_task_process(&app, &id);
    }
    {
        let mut q = state.queue.lock().unwrap();
        q.retain(|t| t.id != id);
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
    let (finished, remaining): (Vec<_>, Vec<_>) = q.drain(..).partition(|t| {
        matches!(
            t.status,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        )
    });
    *q = remaining;
    drop(q);
    for t in finished {
        downloader::clear_log(&app, &t.id);
    }
    downloader::emit_queue(&app);
}

// ---------- History ----------

#[tauri::command]
fn get_history(app: AppHandle) -> Vec<HistoryEntry> {
    history::load(&app)
}

#[tauri::command]
fn clear_history(app: AppHandle) {
    history::clear(&app);
}

#[tauri::command]
fn remove_history_entry(app: AppHandle, id: String) {
    history::remove(&app, &id);
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
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
async fn check_app_update(app: AppHandle, state: State<'_, AppState>) -> Result<AppUpdateStatus, ()> {
    let current_version = app.package_info().version.to_string();
    let proxy = state.settings.lock().unwrap().proxy.trim().to_string();
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
}

/// Snapshot of the local environment for a bug report. Deliberately limited to
/// non-identifying info (versions, OS, CPU arch) — never paths, cookies or URLs.
#[tauri::command]
fn collect_diagnostics(app: AppHandle) -> Diagnostics {
    Diagnostics {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ytdlp_version: binaries::tool_version(&app, binaries::YTDLP),
        ffmpeg_version: binaries::tool_version(&app, binaries::FFMPEG),
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

#[tauri::command]
fn rollback_binary(app: AppHandle, name: String) -> Result<(), String> {
    binaries::rollback(&app, &name)
}

fn main() {
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
            notify::register_app_identity(&handle);
            let loaded = settings::load(&handle);
            let auto_update = loaded.auto_update_ytdlp;
            app.manage(AppState::new(loaded));

            if auto_update {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    // Only touch a copy we manage ourselves — never overwrite
                    // a system-installed yt-dlp the user put on their PATH.
                    let statuses = binaries::get_status(&handle, true).await;
                    if let Some(s) = statuses
                        .iter()
                        .find(|s| s.name == binaries::YTDLP && s.managed && s.update_available)
                    {
                        let _ = binaries::install(&handle, &s.name, None).await;
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
            analyze_url,
            preview_command,
            get_queue,
            get_task_log,
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
            show_in_folder,
            open_file,
            open_external,
            get_binaries_status,
            install_binary,
            rollback_binary,
            list_binary_versions,
            check_app_update,
            collect_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running MediaFetch");
}
