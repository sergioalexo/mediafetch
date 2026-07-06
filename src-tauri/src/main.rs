// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod binaries;
mod downloader;
mod history;
mod metadata;
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

// ---------- Queue ----------

#[tauri::command]
fn get_queue(state: State<AppState>) -> Vec<DownloadTask> {
    state.queue.lock().unwrap().clone()
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
    {
        let mut q = state.queue.lock().unwrap();
        q.retain(|t| {
            !matches!(
                t.status,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
            )
        });
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

// ---------- Binaries module ----------

#[tauri::command]
async fn get_binaries_status(
    app: AppHandle,
    check_latest: bool,
) -> Vec<binaries::BinaryStatus> {
    binaries::get_status(&app, check_latest).await
}

#[tauri::command]
async fn install_binary(app: AppHandle, name: String) -> Result<(), String> {
    binaries::install(&app, &name).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = settings::load(&handle);
            app.manage(AppState::new(loaded));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            pick_download_dir,
            pick_cookies_file,
            analyze_url,
            get_queue,
            enqueue,
            pause_task,
            resume_task,
            cancel_task,
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
            install_binary
        ])
        .run(tauri::generate_context!())
        .expect("error while running MediaFetch");
}
