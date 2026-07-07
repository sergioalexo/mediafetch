//! Download queue engine: spawns yt-dlp processes, parses progress,
//! enforces the parallel-download limit and drives pause/resume/retry.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::binaries;
use crate::history;
use crate::settings::Settings;
use crate::types::{now_unix, DownloadTask, HistoryEntry, TaskStatus};

pub struct AppState {
    pub queue: Mutex<Vec<DownloadTask>>,
    pub pids: Mutex<HashMap<String, u32>>,
    pub settings: Mutex<Settings>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            queue: Mutex::new(Vec::new()),
            pids: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings),
        }
    }
}

const PROGRESS_TEMPLATE: &str = "download:MFPROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.playlist_count)s|%(info.title)s";
const PP_TEMPLATE: &str = "postprocess:MFPP";

pub fn emit_queue(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snapshot = state.queue.lock().unwrap().clone();
    let _ = app.emit("queue-changed", &snapshot);
}

fn emit_task(app: &AppHandle, task: &DownloadTask) {
    let _ = app.emit("task-progress", task);
}

/// Mutate a task by id and return a clone of the updated task.
fn with_task<F: FnOnce(&mut DownloadTask)>(
    app: &AppHandle,
    id: &str,
    f: F,
) -> Option<DownloadTask> {
    let state = app.state::<AppState>();
    let mut q = state.queue.lock().unwrap();
    let task = q.iter_mut().find(|t| t.id == id)?;
    f(task);
    Some(task.clone())
}

fn task_status(app: &AppHandle, id: &str) -> Option<TaskStatus> {
    let state = app.state::<AppState>();
    let q = state.queue.lock().unwrap();
    q.iter().find(|t| t.id == id).map(|t| t.status)
}

#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(binaries::CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
pub fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
}

pub fn kill_task_process(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let pid = state.pids.lock().unwrap().remove(id);
    if let Some(pid) = pid {
        kill_tree(pid);
    }
}

/// Start queued tasks while there are free parallel slots.
pub fn pump(app: &AppHandle) {
    let state = app.state::<AppState>();
    let max_parallel = state.settings.lock().unwrap().max_parallel.max(1);

    let mut to_start = Vec::new();
    {
        let mut q = state.queue.lock().unwrap();
        let running = q
            .iter()
            .filter(|t| {
                matches!(
                    t.status,
                    TaskStatus::Downloading | TaskStatus::Postprocessing
                )
            })
            .count() as u32;
        let mut slots = max_parallel.saturating_sub(running);
        for t in q.iter_mut() {
            if slots == 0 {
                break;
            }
            if t.status == TaskStatus::Queued {
                t.status = TaskStatus::Downloading;
                t.started_at = Some(now_unix());
                t.error = None;
                to_start.push(t.clone());
                slots -= 1;
            }
        }
    }

    if to_start.is_empty() {
        return;
    }
    emit_queue(app);
    for task in to_start {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_download(app, task).await;
        });
    }
}

fn build_args(
    app: &AppHandle,
    task: &DownloadTask,
    settings: &Settings,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let opts = &task.options;
    let is_audio = opts.kind == "audio";

    args.extend([
        "--newline".into(),
        "--no-warnings".into(),
        "--progress-template".into(),
        PROGRESS_TEMPLATE.into(),
        "--progress-template".into(),
        PP_TEMPLATE.into(),
    ]);

    // Output location
    std::fs::create_dir_all(&settings.download_dir).map_err(|e| e.to_string())?;
    let template = if settings.output_template.trim().is_empty() {
        "%(title)s [%(id)s].%(ext)s"
    } else {
        settings.output_template.trim()
    };
    args.extend([
        "-o".into(),
        std::path::Path::new(&settings.download_dir)
            .join(template)
            .to_string_lossy()
            .into_owned(),
    ]);

    if let Some(ffdir) = binaries::ffmpeg_dir(app) {
        args.extend(["--ffmpeg-location".into(), ffdir.to_string_lossy().into_owned()]);
    }

    // Network
    if settings.concurrent_fragments > 1 {
        args.extend(["-N".into(), settings.concurrent_fragments.to_string()]);
    }
    if !settings.rate_limit.trim().is_empty() {
        args.extend(["--limit-rate".into(), settings.rate_limit.trim().to_string()]);
    }
    if !settings.proxy.trim().is_empty() {
        args.extend(["--proxy".into(), settings.proxy.trim().to_string()]);
    }
    if !settings.cookies_file.is_empty() {
        args.extend(["--cookies".into(), settings.cookies_file.clone()]);
    } else if !settings.cookies_from_browser.is_empty() {
        args.extend([
            "--cookies-from-browser".into(),
            settings.cookies_from_browser.clone(),
        ]);
    }

    // Download archive
    if settings.use_download_archive {
        if let Ok(dir) = app.path().app_data_dir() {
            args.extend([
                "--download-archive".into(),
                dir.join("download-archive.txt").to_string_lossy().into_owned(),
            ]);
        }
    }

    // SponsorBlock
    if settings.sponsorblock_mode != "off" && !settings.sponsorblock_categories.is_empty() {
        let cats = settings.sponsorblock_categories.join(",");
        match settings.sponsorblock_mode.as_str() {
            "remove" => args.extend(["--sponsorblock-remove".into(), cats]),
            "mark" => args.extend(["--sponsorblock-mark".into(), cats]),
            _ => {}
        }
    }

    // Embedding
    let audio_format = opts.audio_format.as_deref().unwrap_or("mp3");
    if settings.embed_thumbnail && !(is_audio && audio_format == "wav") {
        args.push("--embed-thumbnail".into());
    }
    if settings.embed_metadata {
        args.push("--embed-metadata".into());
    }

    // Subtitles (video only)
    if !is_audio {
        let langs = opts
            .subtitle_langs
            .clone()
            .filter(|l| !l.is_empty())
            .or_else(|| {
                if settings.write_subs || settings.embed_subs {
                    Some(settings.sub_langs.clone()).filter(|l| !l.trim().is_empty())
                } else {
                    None
                }
            });
        // Only pull subtitles automatically when the task asked for them,
        // or the user enabled writing them globally.
        let wanted = opts.subtitle_langs.is_some() || settings.write_subs;
        if wanted {
            if let Some(langs) = langs {
                args.extend(["--sub-langs".into(), langs]);
                if settings.write_subs {
                    args.push("--write-subs".into());
                }
                if opts.embed_subs.unwrap_or(settings.embed_subs) {
                    args.push("--embed-subs".into());
                }
            }
        }
    }

    // Format selection
    if is_audio {
        args.extend(["-f".into(), opts.format.clone().unwrap_or_else(|| "ba/b".into())]);
        args.extend(["-x".into(), "--audio-format".into(), audio_format.to_string()]);
        if audio_format == "mp3" && opts.bitrate_mode.as_deref().unwrap_or("cbr") == "cbr" {
            let kbps = cbr_bitrate(opts.source_abr);
            args.extend(["--audio-quality".into(), format!("{kbps}K")]);
            args.extend([
                "--postprocessor-args".into(),
                "ExtractAudio:-joint_stereo 1".into(),
            ]);
        } else {
            args.extend(["--audio-quality".into(), "0".into()]);
        }
    } else {
        args.extend([
            "-f".into(),
            opts.format.clone().unwrap_or_else(|| "bv*+ba/b".into()),
        ]);
    }

    // Playlist handling
    if opts.playlist {
        args.push("--yes-playlist".into());
        if let Some(items) = opts.playlist_items.clone().filter(|i| !i.is_empty()) {
            args.extend(["--playlist-items".into(), items]);
        }
    } else {
        args.push("--no-playlist".into());
    }

    // Metadata overrides via the ffmpeg metadata postprocessor
    if let Some(meta) = &opts.metadata {
        let mut parts: Vec<String> = Vec::new();
        for (key, value) in [
            ("title", &meta.title),
            ("artist", &meta.artist),
            ("album", &meta.album),
            ("genre", &meta.genre),
        ] {
            if let Some(v) = value.as_deref().filter(|v| !v.trim().is_empty()) {
                let safe = v.replace('"', "'");
                parts.push(format!("-metadata \"{key}={safe}\""));
            }
        }
        if !parts.is_empty() {
            args.push("--postprocessor-args".into());
            args.push(format!("Metadata:{}", parts.join(" ")));
        }
    }

    args.push("--".into());
    args.push(opts.url.clone());
    Ok(args)
}

/// Pick the smallest standard MP3 CBR bitrate that covers the source
/// audio bitrate, so the encode matches the actual source quality.
fn cbr_bitrate(source_abr: Option<f64>) -> u32 {
    const RATES: [u32; 8] = [64, 96, 128, 160, 192, 224, 256, 320];
    let abr = match source_abr.filter(|a| *a > 0.0) {
        Some(a) => a,
        None => return 192, // unknown source: sane middle ground
    };
    RATES
        .iter()
        .copied()
        .find(|r| f64::from(*r) >= abr)
        .unwrap_or(320)
}

/// Quick metadata-only probe for the source audio bitrate (kbps).
async fn probe_abr(app: &AppHandle, url: &str, settings: &Settings) -> Option<f64> {
    let ytdlp = binaries::ytdlp_path(app).ok()?;
    let mut cmd = tokio::process::Command::new(&ytdlp);
    cmd.args([
        "--print",
        "%(abr)s|%(tbr)s",
        "-f",
        "ba/b",
        "--no-playlist",
        "--no-warnings",
    ]);
    if !settings.proxy.trim().is_empty() {
        cmd.args(["--proxy", settings.proxy.trim()]);
    }
    if !settings.cookies_file.is_empty() {
        cmd.args(["--cookies", &settings.cookies_file]);
    } else if !settings.cookies_from_browser.is_empty() {
        cmd.args(["--cookies-from-browser", &settings.cookies_from_browser]);
    }
    cmd.arg("--").arg(url);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let mut parts = line.trim().split('|');
    let abr = parts.next().and_then(|f| parse_f64(f));
    abr.or_else(|| parts.next().and_then(|f| parse_f64(f)))
}

fn parse_f64(field: &str) -> Option<f64> {
    let t = field.trim();
    if t.is_empty() || t == "NA" || t == "None" {
        return None;
    }
    t.parse::<f64>().ok()
}

async fn run_download(app: AppHandle, mut task: DownloadTask) {
    let settings = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        s.clone()
    };

    // CBR needs the source bitrate to pick a matching encode rate; probe it
    // when the task was queued without prior analysis (e.g. playlist tracks).
    if task.options.kind == "audio"
        && task.options.audio_format.as_deref().unwrap_or("mp3") == "mp3"
        && task.options.bitrate_mode.as_deref().unwrap_or("cbr") == "cbr"
        && task.options.source_abr.is_none()
        && !task.options.playlist
    {
        task.options.source_abr = probe_abr(&app, &task.options.url, &settings).await;
    }

    let ytdlp = match binaries::ytdlp_path(&app) {
        Ok(p) => p,
        Err(e) => {
            fail_task(&app, &task, &settings, e).await;
            return;
        }
    };
    let args = match build_args(&app, &task, &settings) {
        Ok(a) => a,
        Err(e) => {
            fail_task(&app, &task, &settings, e).await;
            return;
        }
    };

    let mut cmd = tokio::process::Command::new(&ytdlp);
    cmd.args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            fail_task(&app, &task, &settings, format!("Failed to start yt-dlp: {e}")).await;
            return;
        }
    };

    if let Some(pid) = child.id() {
        let state = app.state::<AppState>();
        state.pids.lock().unwrap().insert(task.id.clone(), pid);
    }

    // Collect stderr in the background for error reporting.
    let stderr = child.stderr.take();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut tail: VecDeque<String> = VecDeque::with_capacity(16);
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tail.len() >= 15 {
                    tail.pop_front();
                }
                if !line.trim().is_empty() {
                    tail.push_back(line);
                }
            }
        }
        tail
    });

    // Parse stdout progress.
    let dest_re = regex::Regex::new(
        r#"^\[(?:download|ExtractAudio)\] Destination: (.+)$"#,
    )
    .unwrap();
    let merge_re = regex::Regex::new(r#"^\[Merger\] Merging formats into "(.+)"$"#).unwrap();
    let move_re = regex::Regex::new(r#"^\[MoveFiles\] Moving file "(?:.+)" to "(.+)"$"#).unwrap();
    let already_re =
        regex::Regex::new(r#"^\[download\] (.+) has already been downloaded"#).unwrap();

    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        let mut last_emit = std::time::Instant::now();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end();
            let mut updated: Option<DownloadTask> = None;
            let mut force_emit = false;

            if let Some(rest) = line.strip_prefix("MFPROG|") {
                let fields: Vec<&str> = rest.splitn(8, '|').collect();
                if fields.len() == 8 {
                    let downloaded = parse_f64(fields[0]).unwrap_or(0.0);
                    let total = parse_f64(fields[1]).or_else(|| parse_f64(fields[2]));
                    let speed = parse_f64(fields[3]);
                    let eta = parse_f64(fields[4]);
                    let pl_index = parse_f64(fields[5]).map(|x| x as u32);
                    let pl_count = parse_f64(fields[6]).map(|x| x as u32);
                    let title = fields[7].trim();

                    updated = with_task(&app, &task.id, |t| {
                        if t.status == TaskStatus::Downloading
                            || t.status == TaskStatus::Postprocessing
                        {
                            t.status = TaskStatus::Downloading;
                        }
                        t.downloaded_bytes = downloaded as u64;
                        if let Some(total) = total {
                            t.total_bytes = total as u64;
                            if total > 0.0 {
                                t.progress = (downloaded / total * 100.0).clamp(0.0, 100.0);
                            }
                        }
                        t.speed = speed.unwrap_or(0.0);
                        t.eta = eta.unwrap_or(0.0);
                        if pl_count.is_some() {
                            t.playlist_index = pl_index;
                            t.playlist_count = pl_count;
                        }
                        if !title.is_empty() && title != "NA" && t.options.title.is_none() {
                            t.title = title.to_string();
                        }
                    });
                }
            } else if line.starts_with("MFPP") {
                updated = with_task(&app, &task.id, |t| {
                    if t.status == TaskStatus::Downloading {
                        t.status = TaskStatus::Postprocessing;
                        t.speed = 0.0;
                        t.eta = 0.0;
                    }
                });
                force_emit = true;
            } else if let Some(caps) = dest_re
                .captures(line)
                .or_else(|| merge_re.captures(line))
                .or_else(|| move_re.captures(line))
                .or_else(|| already_re.captures(line))
            {
                let path = caps.get(1).map(|m| m.as_str().to_string());
                updated = with_task(&app, &task.id, |t| {
                    t.filename = path;
                });
            }

            if let Some(t) = updated {
                if force_emit || last_emit.elapsed().as_millis() > 250 {
                    last_emit = std::time::Instant::now();
                    emit_task(&app, &t);
                }
            }
        }
    }

    let exit = child.wait().await;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    {
        let state = app.state::<AppState>();
        state.pids.lock().unwrap().remove(&task.id);
    }

    // If the user paused or cancelled, the kill caused the non-zero exit —
    // leave the status they chose in place.
    let status_now = task_status(&app, &task.id);
    if matches!(status_now, Some(TaskStatus::Paused) | Some(TaskStatus::Cancelled) | None) {
        emit_queue(&app);
        pump(&app);
        return;
    }

    let success = exit.map(|s| s.success()).unwrap_or(false);
    if success {
        let done = with_task(&app, &task.id, |t| {
            t.status = TaskStatus::Completed;
            t.progress = 100.0;
            t.speed = 0.0;
            t.eta = 0.0;
            t.completed_at = Some(now_unix());
        });
        if let Some(t) = done {
            finish_history(&app, &t, &settings, true).await;
        }
    } else {
        let error = stderr_tail
            .iter()
            .rev()
            .find(|l| l.contains("ERROR"))
            .cloned()
            .or_else(|| stderr_tail.back().cloned())
            .unwrap_or_else(|| "yt-dlp exited with an error".into());
        let done = with_task(&app, &task.id, |t| {
            t.status = TaskStatus::Failed;
            t.error = Some(error.clone());
            t.completed_at = Some(now_unix());
        });
        if let Some(t) = done {
            finish_history(&app, &t, &settings, false).await;
        }
    }

    emit_queue(&app);
    pump(&app);
}

async fn fail_task(app: &AppHandle, task: &DownloadTask, settings: &Settings, error: String) {
    let done = with_task(app, &task.id, |t| {
        t.status = TaskStatus::Failed;
        t.error = Some(error);
        t.completed_at = Some(now_unix());
    });
    if let Some(t) = done {
        finish_history(app, &t, settings, false).await;
    }
    emit_queue(app);
    pump(app);
}

async fn finish_history(app: &AppHandle, task: &DownloadTask, settings: &Settings, ok: bool) {
    let filesize = task
        .filename
        .as_deref()
        .and_then(|f| std::fs::metadata(f).ok())
        .map(|m| m.len())
        .unwrap_or(task.downloaded_bytes);
    let elapsed = task
        .completed_at
        .zip(task.started_at)
        .map(|(a, b)| a.saturating_sub(b))
        .unwrap_or(0);
    let entry = HistoryEntry {
        id: task.id.clone(),
        url: task.url.clone(),
        title: task.title.clone(),
        filename: task.filename.clone(),
        filesize,
        kind: task.options.kind.clone(),
        format_note: task.options.format_note.clone(),
        downloaded_at: now_unix(),
        elapsed_secs: elapsed,
        avg_speed: if elapsed > 0 {
            filesize as f64 / elapsed as f64
        } else {
            0.0
        },
        status: if ok { "completed".into() } else { "failed".into() },
    };
    history::add(app, entry.clone());
    let _ = app.emit("history-added", &entry);

    if settings.notifications {
        let (done_title, fail_title) = match settings.language.as_str() {
            "uk" => ("Завантаження завершено", "Помилка завантаження"),
            "ru" => ("Загрузка завершена", "Ошибка загрузки"),
            _ => ("Download complete", "Download failed"),
        };
        crate::notify::show(app, if ok { done_title } else { fail_title }, &task.title);
    }
}
