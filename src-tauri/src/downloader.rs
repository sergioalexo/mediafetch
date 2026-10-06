//! Download queue engine: spawns yt-dlp processes, parses progress,
//! enforces the parallel-download limit and drives pause/resume/retry.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::binaries;
use crate::history;
use crate::settings::Settings;
use crate::types::{now_unix, DownloadOptions, DownloadTask, HistoryEntry, TaskStatus};

pub struct AppState {
    pub queue: Mutex<Vec<DownloadTask>>,
    pub pids: Mutex<HashMap<String, u32>>,
    pub settings: Mutex<Settings>,
    /// Full stdout/stderr transcript per task, for the log viewer. Capped
    /// per task so a very long download can't grow this unbounded.
    pub logs: Mutex<HashMap<String, Vec<String>>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            queue: Mutex::new(Vec::new()),
            pids: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings),
            logs: Mutex::new(HashMap::new()),
        }
    }
}

const LOG_CAP: usize = 5000;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskLogLine {
    id: String,
    line: String,
}

/// One line of the app-wide log book, tagged with where it came from. Per-task
/// transcripts get cleared on retry and dropped with the task; this is the
/// record that survives to be copied after the fact.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLogLine {
    pub seq: u64,
    pub ts: u64,
    /// Task id, or "analyze:<url>" for an analysis.
    pub source: String,
    /// Short human label for the source (task title, or "analyze").
    pub scope: String,
    pub line: String,
}

/// The app-wide log book. Separate from the per-task transcripts on purpose:
/// those are scoped to one attempt of one task, and this has to answer "what
/// did the app just do?" after that task is gone.
static APP_LOG: OnceLock<Mutex<(u64, VecDeque<AppLogLine>)>> = OnceLock::new();

fn app_log() -> &'static Mutex<(u64, VecDeque<AppLogLine>)> {
    APP_LOG.get_or_init(|| Mutex::new((0, VecDeque::new())))
}

pub fn app_log_all() -> Vec<AppLogLine> {
    app_log().lock().unwrap().1.iter().cloned().collect()
}

pub fn app_log_clear(app: &AppHandle) {
    {
        let mut book = app_log().lock().unwrap();
        book.1.clear();
    }
    let _ = app.emit("app-log-cleared", ());
}

/// Human label for a log source: the task's title, or "analyze" for an
/// analysis run, falling back to the raw id.
fn scope_for(app: &AppHandle, id: &str) -> String {
    if let Some(url) = id.strip_prefix("analyze:") {
        return format!("analyze {url}");
    }
    let state = app.state::<AppState>();
    let queue = state.queue.lock().unwrap();
    queue
        .iter()
        .find(|t| t.id == id)
        .map(|t| {
            let title = if t.title.trim().is_empty() { &t.url } else { &t.title };
            title.chars().take(60).collect()
        })
        .unwrap_or_else(|| id.to_string())
}

/// Log id for a URL analysis. Analyses aren't queue tasks, but they run the
/// same tool and fail the same ways, so they share the transcript store —
/// which is what lets the UI hand the user a copyable failure.
pub fn analyze_log_id(url: &str) -> String {
    format!("analyze:{url}")
}

/// Append one line to a task's transcript and notify any open log viewer.
pub fn push_log(app: &AppHandle, id: &str, line: String) {
    let state = app.state::<AppState>();
    {
        let mut logs = state.logs.lock().unwrap();
        let buf = logs.entry(id.to_string()).or_default();
        buf.push(line.clone());
        if buf.len() > LOG_CAP {
            let excess = buf.len() - LOG_CAP;
            buf.drain(0..excess);
        }
    }
    // Resolved before the log lock is taken. scope_for reads the queue, and
    // taking queue-inside-log here while every other path takes them the other
    // way round is how an ABBA deadlock gets built.
    let scope = scope_for(app, id);

    let entry = {
        let mut book = app_log().lock().unwrap();
        book.0 += 1;
        let entry = AppLogLine {
            seq: book.0,
            ts: now_unix(),
            source: id.to_string(),
            scope,
            line: line.clone(),
        };
        if book.1.len() >= LOG_CAP {
            book.1.pop_front();
        }
        book.1.push_back(entry.clone());
        entry
    };

    let _ = app.emit(
        "task-log",
        &TaskLogLine {
            id: id.to_string(),
            line,
        },
    );
    let _ = app.emit("app-log", &entry);
}

pub fn get_log(app: &AppHandle, id: &str) -> Vec<String> {
    let state = app.state::<AppState>();
    let logs = state.logs.lock().unwrap();
    logs.get(id).cloned().unwrap_or_default()
}

pub fn clear_log(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    state.logs.lock().unwrap().remove(id);
}

/// Numeric fields only, deliberately. Progress lines are written straight to
/// the stream by yt-dlp's multiline printer, bypassing `--encoding` — a title
/// carried here arrives in the OS ANSI codepage with every character it can't
/// represent silently dropped. The title comes from the destination path
/// instead, which does go through the encoding-aware writer.
const PROGRESS_TEMPLATE: &str = "download:MFPROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.playlist_count)s";
const PP_TEMPLATE: &str = "postprocess:MFPP";
/// Printed once the final file is in place. This is the only reliable way to
/// know a file was actually produced — yt-dlp can exit 0 having done nothing
/// (an already-archived or unavailable item), and `[download] Destination:`
/// lines fire per-fragment/per-format, not once per finished item.
const DONE_TEMPLATE: &str = "after_move:MFDONE|%(extractor_key)s|%(id)s|%(filepath)s";

/// Minimum gap between two `queue-changed` emissions. Enqueueing 300 items or
/// clearing a long finished list used to fire one full-queue snapshot per
/// mutation; this coalesces a burst into at most one emit per window.
const QUEUE_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);

struct QueueEmitState {
    last: std::time::Instant,
    pending: bool,
}

fn queue_emit_state() -> &'static Mutex<QueueEmitState> {
    static STATE: OnceLock<Mutex<QueueEmitState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(QueueEmitState {
            last: std::time::Instant::now() - QUEUE_EMIT_INTERVAL,
            pending: false,
        })
    })
}

fn emit_queue_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snapshot = state.queue.lock().unwrap().clone();
    let _ = app.emit("queue-changed", &snapshot);
}

/// Debounced `queue-changed`: emits immediately if the last emit was more
/// than `QUEUE_EMIT_INTERVAL` ago, otherwise schedules exactly one trailing
/// emit for the end of the window (further calls inside the same window are
/// no-ops — the trailing emit always reflects the latest queue state).
pub fn emit_queue(app: &AppHandle) {
    let wait = {
        let mut s = queue_emit_state().lock().unwrap();
        let elapsed = s.last.elapsed();
        if elapsed >= QUEUE_EMIT_INTERVAL {
            s.last = std::time::Instant::now();
            None
        } else if s.pending {
            return;
        } else {
            s.pending = true;
            Some(QUEUE_EMIT_INTERVAL - elapsed)
        }
    };
    match wait {
        None => emit_queue_now(app),
        Some(wait) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(wait).await;
                {
                    let mut s = queue_emit_state().lock().unwrap();
                    s.last = std::time::Instant::now();
                    s.pending = false;
                }
                emit_queue_now(&app);
            });
        }
    }
}

/// After an import merges entries in on the Rust side, tell the frontend to
/// replace its whole `history` with what's actually on disk now, rather than
/// trying to patch in just what was added.
pub fn emit_history_replaced(app: &AppHandle) {
    let _ = app.emit("history-replaced", &history::load(app));
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

/// A copy of the current settings, taken without holding the lock across
/// whatever the caller does next (an `.await`, a process spawn).
pub fn settings_snapshot(app: &AppHandle) -> Settings {
    app.state::<AppState>().settings.lock().unwrap().clone()
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
    // Kill spawned children (ffmpeg post-processors) first, then the
    // process itself — plain `kill` would orphan them on macOS/Linux.
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-P", &pid.to_string()])
        .output();
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
}

/// When yt-dlp's output is piped rather than attached to a console — as ours
/// always is — its Python runtime encodes text I/O with the OS ANSI codepage
/// instead of UTF-8 (cp1252 on a typical Windows install). Non-Latin titles
/// then come out as mojibake or invalid bytes.
///
/// `--encoding utf-8` is what actually fixes this: the PyInstaller-frozen
/// yt-dlp.exe we ship ignores `PYTHONUTF8`/`PYTHONIOENCODING` entirely. The
/// env vars stay for the case where yt-dlp resolves to a plain-Python install
/// on PATH, where they do work.
const ENCODING_ARGS: [&str; 2] = ["--encoding", "utf-8"];

/// yt-dlp solves YouTube's signature and `n` challenges with a JavaScript
/// runtime, and only enables Deno by default. Without one, most player clients
/// hand back storyboard images and nothing else. If Deno is missing but
/// another supported runtime is installed, point yt-dlp at it explicitly — GUI
/// apps don't inherit a login shell's PATH, so the full path goes along.
///
/// Which YouTube player clients to use is deliberately left to yt-dlp. A
/// client pinned here goes stale the day YouTube changes something: the
/// android_vr pin this app used to carry started getting every format 403'd
/// on 2026-08-17, while yt-dlp simply dropped it from its maintained defaults.
/// yt-dlp is kept current by the Components page, so its defaults are the
/// ones that keep working. Shared by downloads, analysis and the bitrate probe.
pub fn js_runtime_args(app: &AppHandle) -> Vec<String> {
    match js_runtime_spec(app) {
        Some(spec) if ytdlp_supports_js_runtimes(app) => vec!["--js-runtimes".into(), spec],
        _ => Vec::new(),
    }
}

/// [`js_runtime_args`] from async code. Resolving it can block — the first
/// call after a yt-dlp install or update runs `yt-dlp --help` — so it goes to
/// the blocking pool instead of stalling an async worker.
pub async fn js_runtime_args_async(app: &AppHandle) -> Vec<String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || js_runtime_args(&app))
        .await
        .unwrap_or_default()
}

/// The runtime to hand yt-dlp, as `name:path`. Deno first (yt-dlp's own
/// preference), including a copy MediaFetch manages in its bin dir — that one
/// isn't on PATH, so yt-dlp would never find it on its own. Deliberately
/// uncached: installing Deno from the Components page has to take effect on
/// the very next download, not the next launch.
pub fn js_runtime_spec(app: &AppHandle) -> Option<String> {
    if let Some((path, _)) = binaries::resolve(app, binaries::DENO) {
        return Some(format!("deno:{}", path.to_string_lossy()));
    }
    ["node", "bun"].iter().find_map(|name| {
        binaries::find_executable(name).map(|path| format!("{name}:{}", path.to_string_lossy()))
    })
}

/// `--js-runtimes` is a recent flag and the Components page can roll yt-dlp
/// back to a build that would reject it outright. Cached per binary (size +
/// mtime), so an install or rollback re-checks by itself.
type FileStamp = (u64, u64);

pub fn ytdlp_supports_js_runtimes(app: &AppHandle) -> bool {
    static CACHE: OnceLock<Mutex<Option<(FileStamp, bool)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    let Ok(path) = binaries::ytdlp_path(app) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    let stamp = (
        meta.len(),
        meta.modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );
    if let Some((cached, supported)) = *cache.lock().unwrap() {
        if cached == stamp {
            return supported;
        }
    }

    let mut cmd = std::process::Command::new(&path);
    cmd.arg("--help");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }
    let supported = cmd
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("--js-runtimes"))
        .unwrap_or(false);
    *cache.lock().unwrap() = Some((stamp, supported));
    supported
}

pub fn force_utf8_io(cmd: &mut tokio::process::Command) {
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
}

/// Read a child pipe line by line, tolerating anything that comes through it.
///
/// `BufReader::lines()` fails a whole line with `InvalidData` when it isn't
/// valid UTF-8, and our read loops treated any error as end-of-stream. One
/// mis-encoded byte therefore stopped us draining the pipe and dropped the
/// read end, after which yt-dlp's next write to stdout failed — surfacing as
/// "unable to open for writing: [Errno 22] Invalid argument", because yt-dlp
/// prints the destination inside the same `try` that opens the output file.
/// Decoding lossily keeps the pipe drained no matter what yt-dlp emits.
async fn read_lines<R, F>(reader: R, mut on_line: F)
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(String),
{
    let mut reader = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                on_line(String::from_utf8_lossy(&buf).into_owned());
            }
        }
    }
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
        let running = q.iter().filter(|t| t.status.is_running()).count() as u32;
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

/// Per-attempt adjustments an auto-retry applies to work around whatever
/// killed the previous attempt. A retry that changes nothing just fails again.
#[derive(Debug, Clone, Copy, Default)]
pub struct RetryTweaks {
    /// Download without concurrent fragments (`-N`).
    pub single_connection: bool,
}

/// `--cookies <file>` or `--cookies-from-browser <name>` — spelled the same in
/// yt-dlp and gallery-dl. A cookies.txt file wins over a browser.
pub fn cookie_args(settings: &Settings) -> Vec<String> {
    if !settings.cookies_file.trim().is_empty() {
        vec!["--cookies".into(), settings.cookies_file.clone()]
    } else if !settings.cookies_from_browser.trim().is_empty() {
        vec![
            "--cookies-from-browser".into(),
            settings.cookies_from_browser.trim().to_string(),
        ]
    } else {
        Vec::new()
    }
}

/// How every yt-dlp run reaches a site: proxy, browser impersonation and
/// cookies. Analysis, the bitrate probe and the download all share this —
/// whenever they differed, analysis rejected links the download could have
/// fetched (a site that needs `--impersonate`, say), or the other way round.
pub fn network_args(settings: &Settings) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if !settings.proxy.trim().is_empty() {
        args.extend(["--proxy".into(), settings.proxy.trim().to_string()]);
    }
    if !settings.impersonate.trim().is_empty() {
        args.extend(["--impersonate".into(), settings.impersonate.trim().to_string()]);
    }
    args.extend(cookie_args(settings));
    args
}

pub fn build_args(
    app: &AppHandle,
    opts: &DownloadOptions,
    settings: &Settings,
    tweaks: RetryTweaks,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let is_audio = opts.kind == "audio";

    // Warnings are deliberately kept. They carry the reason a format went
    // missing ("Only images are available for download", "…requires a GVS PO
    // Token"), which is exactly what the log book exists to show — suppressing
    // them left a bare "Requested format is not available" and no way to tell
    // why. Error reporting is unaffected: it looks for ERROR lines first.
    args.extend([
        "--newline".into(),
        ENCODING_ARGS[0].into(),
        ENCODING_ARGS[1].into(),
        // --print implies --quiet unless --no-quiet is passed; without this
        // the MFDONE line would come through, but every normal progress and
        // destination line this file also depends on would not.
        "--no-quiet".into(),
        "--progress-template".into(),
        PROGRESS_TEMPLATE.into(),
        "--progress-template".into(),
        PP_TEMPLATE.into(),
        "--print".into(),
        DONE_TEMPLATE.into(),
    ]);

    // Sanitize titles into valid Windows filenames and cap the filename
    // length — long titles combined with a deep download folder otherwise
    // blow past MAX_PATH and yt-dlp fails with "OSError: [Errno 22]
    // Invalid argument" when it tries to open the file.
    #[cfg(windows)]
    args.extend(["--windows-filenames".into(), "--trim-filenames".into(), "150".into()]);

    // Opt-in workaround: transliterate to ASCII instead of keeping accents.
    // Some Windows setups still fail to write non-ASCII filenames even with
    // --windows-filenames and UTF-8 I/O forced; this sidesteps that entirely.
    if settings.restrict_filenames {
        args.push("--restrict-filenames".into());
    }

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

    // The JS runtime for YouTube's challenges (see js_runtime_args).
    args.extend(js_runtime_args(app));

    // Network
    if settings.concurrent_fragments > 1 && !tweaks.single_connection {
        args.extend(["-N".into(), settings.concurrent_fragments.to_string()]);
    }
    if !settings.rate_limit.trim().is_empty() {
        args.extend(["--limit-rate".into(), settings.rate_limit.trim().to_string()]);
    }
    if settings.retries > 0 {
        args.extend(["--retries".into(), settings.retries.to_string()]);
    }
    if settings.fragment_retries > 0 {
        args.extend(["--fragment-retries".into(), settings.fragment_retries.to_string()]);
    }
    if settings.sleep_requests > 0.0 {
        args.extend(["--sleep-requests".into(), settings.sleep_requests.to_string()]);
    }
    args.extend(network_args(settings));

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
    //
    // A task that may pull still images (Instagram photos and carousel posts)
    // skips both postprocessors. yt-dlp routes them by codec, and an image
    // format carries no vcodec/acodec at all, so it is treated as a video and
    // the processors run on the .jpg: EmbedThumbnail then aborts the whole
    // download, since only audio/video containers can hold a thumbnail, and
    // the metadata processor re-muxes the picture through ffmpeg for nothing.
    let audio_format = opts.audio_format.as_deref().unwrap_or("mp3");
    let include_images = opts.include_images.unwrap_or(false);
    if settings.embed_thumbnail && !include_images && !(is_audio && audio_format == "wav") {
        args.push("--embed-thumbnail".into());
    }
    if settings.embed_metadata && !include_images {
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
        args.push("-x".into());
        // "source" keeps the original audio stream — no re-encode, no format flag.
        if audio_format != "source" {
            args.extend(["--audio-format".into(), audio_format.to_string()]);
        }
        // Bitrate/quality only applies to lossy re-encoded formats.
        if is_lossy_audio(audio_format) {
            let quality = resolve_audio_quality(opts);
            let arg = match quality {
                "vbr" => "0".to_string(),
                "match" => format!("{}K", cbr_bitrate(opts.source_abr)),
                kbps => format!("{kbps}K"), // forced CBR, e.g. "320"
            };
            args.extend(["--audio-quality".into(), arg]);
        }

        if let Some(pp) = extract_audio_pp_args(opts, settings, audio_format) {
            args.push("--postprocessor-args".into());
            args.push(pp);
        }
    } else {
        args.extend([
            "-f".into(),
            // Trailing "/ba" falls back to audio-only when the source has no
            // video stream at all (e.g. YouTube Music), instead of hard
            // failing with "Requested format is not available".
            opts.format.clone().unwrap_or_else(|| "bv*+ba/b/ba".into()),
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

    // Advanced/custom passthrough, set per-preset.
    if let Some(extra) = opts.custom_ffmpeg_args.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--postprocessor-args".into());
        args.push(format!("ffmpeg:{}", extra.trim()));
    }
    if let Some(extra) = opts.custom_ytdlp_args.as_deref().filter(|s| !s.trim().is_empty()) {
        args.extend(shell_split(extra).map_err(|e| format!("Custom yt-dlp arguments: {e}"))?);
    }

    args.push("--".into());
    args.push(opts.url.clone());
    Ok(args)
}

/// True when this task should run through gallery-dl instead of yt-dlp.
pub fn is_gallery(opts: &DownloadOptions) -> bool {
    opts.engine.as_deref() == Some("gallerydl")
}

/// Build the gallery-dl command line for a task.
///
/// gallery-dl covers what yt-dlp structurally cannot: photo posts and whole
/// profile galleries, where the media are still images and never appear as
/// downloadable "formats". It takes the whole link in one run, so there is no
/// format selection here — only where the files land and which items to take.
pub fn build_gallerydl_args(
    opts: &DownloadOptions,
    settings: &Settings,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();

    // Galleries are behind a login on most sites — Instagram redirects even
    // public posts to its sign-in page for an anonymous request.
    args.extend(cookie_args(settings));

    // gallery-dl lays out <download dir>/<site>/<account>/… by itself, which
    // keeps a profile grab from flooding the top-level download folder.
    std::fs::create_dir_all(&settings.download_dir).map_err(|e| e.to_string())?;
    args.extend(["-d".into(), settings.download_dir.clone()]);

    // The draft's item selection, already 1-based — gallery-dl's --range takes
    // the same "1,3,5-8" syntax as yt-dlp's --playlist-items.
    if let Some(items) = opts.playlist_items.clone().filter(|i| !i.is_empty()) {
        args.extend(["--range".into(), items]);
    }

    if !settings.rate_limit.trim().is_empty() {
        args.extend(["--limit-rate".into(), settings.rate_limit.trim().to_string()]);
    }
    if !settings.proxy.trim().is_empty() {
        args.extend(["--proxy".into(), settings.proxy.trim().to_string()]);
    }
    if settings.retries > 0 {
        args.extend(["--retries".into(), settings.retries.to_string()]);
    }
    if settings.sleep_requests > 0.0 {
        args.extend(["--sleep-request".into(), settings.sleep_requests.to_string()]);
    }

    args.push("--".into());
    args.push(opts.url.clone());
    Ok(args)
}

/// Minimal POSIX-ish shell tokenizer for user-supplied CLI arguments: splits
/// on whitespace, honours single/double quotes and backslash escapes. Good
/// enough for yt-dlp flag values that contain spaces (e.g. extractor-args).
fn shell_split(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '\\' && q == '"' {
                    if let Some(&next) = chars.peek() {
                        if next == '"' || next == '\\' {
                            current.push(chars.next().unwrap());
                            continue;
                        }
                    }
                    current.push(c);
                } else {
                    current.push(c);
                }
            }
            None => {
                if c.is_whitespace() {
                    if in_token {
                        args.push(std::mem::take(&mut current));
                        in_token = false;
                    }
                } else if c == '\'' || c == '"' {
                    quote = Some(c);
                    in_token = true;
                } else if c == '\\' {
                    if let Some(next) = chars.next() {
                        current.push(next);
                        in_token = true;
                    }
                } else {
                    current.push(c);
                    in_token = true;
                }
            }
        }
    }
    if quote.is_some() {
        return Err("unterminated quote".into());
    }
    if in_token {
        args.push(current);
    }
    Ok(args)
}

/// The `ExtractAudio:` postprocessor arguments for an audio task, if any.
///
/// Joint stereo (mp3 CBR) and the sample rate both land on ffmpeg's
/// ExtractAudio postprocessor — merged into one `ExtractAudio:` string rather
/// than two separate --postprocessor-args, since yt-dlp doesn't promise to
/// combine repeated keys for the same postprocessor. "source" keeps the
/// original stream, so nothing applies to it.
fn extract_audio_pp_args(opts: &DownloadOptions, settings: &Settings, audio_format: &str) -> Option<String> {
    if audio_format == "source" {
        return None;
    }
    let mut pp_args: Vec<String> = Vec::new();
    if audio_format == "mp3" && resolve_audio_quality(opts) != "vbr" && settings.joint_stereo {
        pp_args.push("-joint_stereo 1".into());
    }
    if let Some(rate) = resolve_sample_rate(opts, settings, audio_format) {
        pp_args.push(format!("-ar {rate}"));
    }
    (!pp_args.is_empty()).then(|| format!("ExtractAudio:{}", pp_args.join(" ")))
}

/// Formats that are lossy re-encodes and honour a bitrate/quality setting.
fn is_lossy_audio(format: &str) -> bool {
    matches!(format, "mp3" | "aac" | "opus")
}

/// Resolve the bitrate/quality for lossy audio, mapping the legacy
/// `bitrate_mode` field when a task predates the `audio_quality` option.
fn resolve_audio_quality(opts: &DownloadOptions) -> &str {
    if let Some(q) = opts.audio_quality.as_deref().filter(|s| !s.is_empty()) {
        return q;
    }
    match opts.bitrate_mode.as_deref() {
        Some("vbr") => "vbr",
        _ => "match",
    }
}

/// Resolve the sample rate to pass to ffmpeg's ExtractAudio postprocessor
/// (`-ar <rate>`), or `None` when no resampling should happen at all.
///
/// Precedence: the task's own override, else the preset's, else the global
/// setting. Clamped per format so ffmpeg never errors on a rate it can't
/// encode: mp3/aac accept 44100 or 48000 (96000 falls back to 48000), opus is
/// always 48000, flac/wav take any of the three, and "source" never resamples.
fn resolve_sample_rate(opts: &DownloadOptions, settings: &Settings, audio_format: &str) -> Option<String> {
    let requested = opts
        .sample_rate
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&settings.audio_sample_rate);
    if requested == "original" {
        return None;
    }
    let rate = match audio_format {
        "mp3" | "aac" => {
            if requested == "96000" {
                "48000"
            } else {
                requested
            }
        }
        "opus" => "48000",
        // flac/wav and anything else: no clamp, any of the three is valid.
        _ => requested,
    };
    Some(rate.to_string())
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
    force_utf8_io(&mut cmd);
    cmd.args([
        "--print",
        "%(abr)s|%(tbr)s",
        "-f",
        "ba/b",
        "--no-playlist",
        "--no-warnings",
    ]);
    cmd.args(ENCODING_ARGS);
    // Extract the same way the download will. Without the JS runtime the probe
    // hits YouTube's empty format lists, returns nothing, and "match source"
    // quietly encodes at the 192 kbps fallback — below the source — on exactly
    // the tracks the download itself handles fine.
    cmd.args(js_runtime_args_async(app).await);
    cmd.args(network_args(settings));
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
    let abr = parts.next().and_then(parse_f64);
    abr.or_else(|| parts.next().and_then(parse_f64))
}

/// The file a yt-dlp output line names as where media is (or will be)
/// written: a download/extraction destination, the merge target, the final
/// move, or a file that was already there.
fn destination_path(line: &str) -> Option<&str> {
    static PATTERNS: LazyLock<[regex::Regex; 4]> = LazyLock::new(|| {
        [
            r#"^\[(?:download|ExtractAudio)\] Destination: (.+)$"#,
            r#"^\[Merger\] Merging formats into "(.+)"$"#,
            r#"^\[MoveFiles\] Moving file "(?:.+)" to "(.+)"$"#,
            r#"^\[download\] (.+) has already been downloaded"#,
        ]
        .map(|re| regex::Regex::new(re).expect("valid destination pattern"))
    });
    PATTERNS
        .iter()
        .find_map(|re| re.captures(line))
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
}

/// Filename without its extension, for use as a display title.
fn file_stem(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

fn parse_f64(field: &str) -> Option<f64> {
    let t = field.trim();
    if t.is_empty() || t == "NA" || t == "None" {
        return None;
    }
    t.parse::<f64>().ok()
}

async fn run_download(app: AppHandle, mut task: DownloadTask) {
    let settings = settings_snapshot(&app);

    // "Match source" needs the source bitrate to pick a matching encode rate;
    // probe it when the task was queued without prior analysis (e.g. playlist
    // tracks).
    if task.options.kind == "audio"
        && is_lossy_audio(task.options.audio_format.as_deref().unwrap_or("mp3"))
        && resolve_audio_quality(&task.options) == "match"
        && task.options.source_abr.is_none()
        && !task.options.playlist
    {
        task.options.source_abr = probe_abr(&app, &task.options.url, &settings).await;
    }

    let gallery = is_gallery(&task.options);
    let tool = if gallery {
        binaries::gallerydl_path(&app)
    } else {
        binaries::ytdlp_path(&app)
    };
    let tool = match tool {
        Ok(p) => p,
        Err(e) => {
            fail_task(&app, &task, &settings, e).await;
            return;
        }
    };
    let tweaks = RetryTweaks {
        single_connection: task.force_single_connection,
    };
    // Off the async runtime: building the arguments touches the disk, and the
    // first build after a yt-dlp install runs `yt-dlp --help` once to see
    // which flags it supports (ytdlp_supports_js_runtimes).
    let built = {
        let (app, opts, settings) = (app.clone(), task.options.clone(), settings.clone());
        tauri::async_runtime::spawn_blocking(move || {
            if gallery {
                build_gallerydl_args(&opts, &settings)
            } else {
                build_args(&app, &opts, &settings, tweaks)
            }
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
    };
    let args = match built {
        Ok(a) => a,
        Err(e) => {
            fail_task(&app, &task, &settings, e).await;
            return;
        }
    };

    // The task was paused, cancelled or removed while the bitrate probe or
    // the argument build ran — there was no process yet for that to kill.
    if !task_status(&app, &task.id).is_some_and(TaskStatus::is_running) {
        emit_queue(&app);
        pump(&app);
        return;
    }

    let mut cmd = tokio::process::Command::new(&tool);
    force_utf8_io(&mut cmd);
    cmd.args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }

    let tool_name = if gallery { "gallery-dl" } else { "yt-dlp" };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            fail_task(&app, &task, &settings, format!("Failed to start {tool_name}: {e}")).await;
            return;
        }
    };

    if let Some(pid) = child.id() {
        let state = app.state::<AppState>();
        state.pids.lock().unwrap().insert(task.id.clone(), pid);
    }
    // A pause or cancel that landed between the check above and the pid
    // being registered found nothing to kill. Honour it now, or the process
    // would run to completion under a task that says it's paused.
    if !task_status(&app, &task.id).is_some_and(TaskStatus::is_running) {
        kill_task_process(&app, &task.id);
        let _ = child.wait().await;
        emit_queue(&app);
        pump(&app);
        return;
    }

    // Fresh transcript for this run — a retry shouldn't mix in the previous
    // attempt's output.
    clear_log(&app, &task.id);
    if task.force_single_connection {
        push_log(&app, &task.id, "Retrying without concurrent fragments (-N) to rule out write contention.".into());
    }
    push_log(&app, &task.id, format!("$ {} {}", tool.to_string_lossy(), args.join(" ")));

    // Collect stderr in the background for error reporting, and mirror every
    // line into the shared transcript so the log viewer sees it live.
    let stderr = child.stderr.take();
    let stderr_app = app.clone();
    let stderr_id = task.id.clone();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut tail: VecDeque<String> = VecDeque::with_capacity(16);
        if let Some(stderr) = stderr {
            read_lines(stderr, |line| {
                if !line.trim().is_empty() {
                    push_log(&stderr_app, &stderr_id, line.clone());
                    if tail.len() >= 15 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            })
            .await;
        }
        tail
    });

    // Parse stdout progress.
    let mut saw_mfdone = false;
    let mut already_had = false;
    // The output file as *this* run reported it. `task.filename` can't stand
    // in for it: a retry inherits the previous attempt's path, and that file
    // existing says nothing about whether this run produced anything.
    let mut produced: Option<String> = None;
    if gallery {
        run_gallery_stdout(&app, &mut child, &task).await;
    } else if let Some(stdout) = child.stdout.take() {
        let mut last_emit = std::time::Instant::now();
        read_lines(stdout, |line| {
            let line = line.trim_end();
            let mut updated: Option<DownloadTask> = None;
            let mut force_emit = false;

            // The two progress-template markers are internal bookkeeping,
            // not real yt-dlp output — everything else is worth logging.
            if !line.is_empty()
                && !line.starts_with("MFPROG|")
                && !line.starts_with("MFPP")
                && !line.starts_with("MFDONE|")
            {
                push_log(&app, &task.id, line.to_string());
            }

            if line.contains("has already been recorded in the archive")
                || line.contains("has already been downloaded")
            {
                already_had = true;
            }

            if let Some(rest) = line.strip_prefix("MFDONE|") {
                let fields: Vec<&str> = rest.splitn(3, '|').collect();
                if fields.len() == 3 {
                    saw_mfdone = true;
                    let extractor_key = fields[0].trim();
                    let id = fields[1].trim();
                    let path = fields[2].trim().to_string();
                    if !path.is_empty() {
                        produced = Some(path.clone());
                    }
                    let media_key = if !extractor_key.is_empty() && !id.is_empty() {
                        Some(format!("{extractor_key}:{id}"))
                    } else {
                        None
                    };
                    updated = with_task(&app, &task.id, |t| {
                        if t.options.title.is_none() {
                            if let Some(stem) = file_stem(&path) {
                                t.title = stem;
                            }
                        }
                        if !path.is_empty() {
                            t.filename = Some(path.clone());
                        }
                        if media_key.is_some() {
                            t.media_key = media_key.clone();
                        }
                    });
                }
            } else if let Some(rest) = line.strip_prefix("MFPROG|") {
                let fields: Vec<&str> = rest.splitn(7, '|').collect();
                if fields.len() == 7 {
                    let downloaded = parse_f64(fields[0]).unwrap_or(0.0);
                    let total = parse_f64(fields[1]).or_else(|| parse_f64(fields[2]));
                    let speed = parse_f64(fields[3]);
                    let eta = parse_f64(fields[4]);
                    let pl_index = parse_f64(fields[5]).map(|x| x as u32);
                    let pl_count = parse_f64(fields[6]).map(|x| x as u32);

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
            } else if let Some(path) = destination_path(line) {
                let path = Some(path.to_string());
                produced.clone_from(&path);
                updated = with_task(&app, &task.id, |t| {
                    // A task queued without prior analysis has no title yet;
                    // the destination stem is the title as the output template
                    // rendered it, and unlike the progress lines it survives
                    // the trip through yt-dlp's encoding-aware writer.
                    if t.options.title.is_none() {
                        if let Some(stem) = path.as_deref().and_then(file_stem) {
                            t.title = stem;
                        }
                    }
                    t.filename = path;
                });
            }

            if let Some(t) = updated {
                if force_emit || last_emit.elapsed().as_millis() > 250 {
                    last_emit = std::time::Instant::now();
                    emit_task(&app, &t);
                }
            }
        })
        .await;
    }

    let exit = child.wait().await;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    {
        let state = app.state::<AppState>();
        state.pids.lock().unwrap().remove(&task.id);
    }

    // If the user paused, cancelled or removed it, the kill caused the
    // non-zero exit — leave the status they chose in place.
    if !task_status(&app, &task.id).is_some_and(TaskStatus::is_running) {
        emit_queue(&app);
        pump(&app);
        return;
    }

    let exit_ok = exit.map(|s| s.success()).unwrap_or(false);
    // gallery-dl keeps its own per-file counting; a yt-dlp exit of 0 only
    // means something was produced once MFDONE fired or the destination file
    // this run named actually exists — it can also exit 0 having done nothing
    // at all (an already-archived or unavailable item).
    let file_exists = produced
        .as_deref()
        .is_some_and(|f| std::path::Path::new(f).exists());
    let media_produced = gallery || saw_mfdone || file_exists;

    if exit_ok && media_produced {
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
    } else if exit_ok && !gallery && already_had {
        // Nothing new was produced, but nothing failed either — don't add a
        // second history entry for a track already in the archive.
        with_task(&app, &task.id, |t| {
            t.status = TaskStatus::Completed;
            t.progress = 100.0;
            t.speed = 0.0;
            t.eta = 0.0;
            t.completed_at = Some(now_unix());
        });
    } else {
        let raw_error = if exit_ok {
            "yt-dlp finished without producing a file".to_string()
        } else {
            stderr_tail
                .iter()
                .rev()
                .find(|l| l.contains("ERROR"))
                .cloned()
                .or_else(|| stderr_tail.back().cloned())
                .unwrap_or_else(|| "yt-dlp exited with an error".into())
        };
        let failure = classify_failure(&raw_error);
        let error = friendly_error(&raw_error, failure);

        // A missing sign-in stays missing however many times we try.
        if task.retry_count < settings.auto_retry_limit && failure != FailureKind::Auth {
            // Some failures (file locked by AV scan, a brief network blip)
            // reliably succeed on a plain retry — don't make the user click
            // for those. A short pause gives whatever held the file/network
            // a moment to clear.
            //
            // What went wrong decides what the retry should do differently.
            // A refused media URL is spent, but every run extracts afresh, so
            // a longer pause (rate limiting) is all a 403/429 retry needs.
            //
            // The write tweak is a yt-dlp flag, so a gallery-dl task just
            // retries plainly — and gets a free resume, since gallery-dl
            // skips the files the previous attempt already wrote.
            let (delay, note) = match failure {
                _ if gallery => (3, ""),
                FailureKind::Refused => (8, " with freshly extracted media URLs"),
                FailureKind::Write => (6, " without concurrent fragments"),
                FailureKind::Auth | FailureKind::Other => (3, ""),
            };
            push_log(
                &app,
                &task.id,
                format!(
                    "Auto-retrying ({}/{}){note}…",
                    task.retry_count + 1,
                    settings.auto_retry_limit,
                ),
            );
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            with_task(&app, &task.id, |t| {
                // Paused or cancelled during the pause above: the user's
                // choice stands, rather than being re-queued over the top.
                if !t.status.is_running() {
                    return;
                }
                t.status = TaskStatus::Queued;
                t.retry_count += 1;
                if !gallery && failure == FailureKind::Write {
                    t.force_single_connection = true;
                }
                t.progress = 0.0;
                t.downloaded_bytes = 0;
                t.speed = 0.0;
                t.eta = 0.0;
                t.error = Some(error.clone());
            });
        } else {
            let done = with_task(&app, &task.id, |t| {
                t.status = TaskStatus::Failed;
                t.error = Some(error.clone());
                t.completed_at = Some(now_unix());
            });
            if let Some(t) = done {
                finish_history(&app, &t, &settings, false).await;
            }
        }
    }

    emit_queue(&app);
    pump(&app);
}

/// Drive progress from gallery-dl's stdout.
///
/// gallery-dl has no progress protocol to hook into: it prints one absolute
/// path per file, prefixed with "# " when the file was already there and got
/// skipped. So a file line is the unit of progress, and the byte counter is
/// summed by stat-ing each finished file.
async fn run_gallery_stdout(
    app: &AppHandle,
    child: &mut tokio::process::Child,
    task: &DownloadTask,
) {
    let Some(stdout) = child.stdout.take() else {
        return;
    };
    let expected = task.options.expected_items.unwrap_or(0);
    let started = std::time::Instant::now();
    let mut files: u32 = 0;
    let mut bytes: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    read_lines(stdout, |line| {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        push_log(app, &task.id, line.to_string());

        // Everything gallery-dl says about its own progress is a bare path;
        // its status and error chatter is bracketed ("[instagram][error] …").
        let (path, skipped) = match line.strip_prefix("# ") {
            Some(rest) => (rest.trim(), true),
            None if !line.starts_with('[') => (line, false),
            None => return,
        };
        if path.is_empty() {
            return;
        }

        files += 1;
        if !skipped {
            bytes += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }
        let elapsed = started.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 { bytes as f64 / elapsed } else { 0.0 };

        let updated = with_task(app, &task.id, |t| {
            if t.status == TaskStatus::Downloading || t.status == TaskStatus::Postprocessing {
                t.status = TaskStatus::Downloading;
            }
            t.downloaded_bytes = bytes;
            t.speed = speed;
            t.playlist_index = Some(files);
            // A gallery's size is only known when analysis counted the items;
            // a whole profile has no total until it finishes.
            if expected > 0 {
                t.playlist_count = Some(expected);
                t.progress = (f64::from(files) / f64::from(expected) * 100.0).clamp(0.0, 100.0);
                let remaining = expected.saturating_sub(files);
                t.eta = if files > 0 {
                    elapsed / f64::from(files) * f64::from(remaining)
                } else {
                    0.0
                };
            }
            if let Some(name) = std::path::Path::new(path).file_name() {
                t.filename = Some(path.to_string());
                if t.options.title.is_none() {
                    t.title = name.to_string_lossy().into_owned();
                }
            }
        });

        if let Some(t) = updated {
            if last_emit.elapsed().as_millis() > 250 {
                last_emit = std::time::Instant::now();
                emit_task(app, &t);
            }
        }
    })
    .await;
}

/// Why an attempt failed, in the only terms a retry can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    /// The server turned down the extracted media URL (403/429). That URL is
    /// spent — only a fresh extraction can help.
    Refused,
    /// yt-dlp could not open the output file, typically several tasks'
    /// fragment threads writing into the same folder at once.
    Write,
    /// The site wants a signed-in session (Instagram profiles and private
    /// posts, age-gated videos). Nothing to retry — it needs cookies.
    Auth,
    Other,
}

fn classify_failure(error: &str) -> FailureKind {
    let lower = error.to_lowercase();
    if lower.contains("login required")
        || lower.contains("redirect to login")
        || lower.contains("requested content is not available")
        || lower.contains("use --cookies")
        || lower.contains("--cookies-from-browser")
        || lower.contains("sign in to confirm")
        || lower.contains("private video")
        || lower.contains("only available for registered users")
    {
        FailureKind::Auth
    } else if lower.contains("http error 403")
        || lower.contains("403: forbidden")
        || lower.contains("http error 429")
        || lower.contains("too many requests")
    {
        FailureKind::Refused
    } else if lower.contains("unable to open for writing")
        || lower.contains("errno 22")
        || lower.contains("invalid argument")
    {
        FailureKind::Write
    } else {
        FailureKind::Other
    }
}

/// Append an actionable hint to error patterns we can actually explain,
/// so the failure isn't just an opaque yt-dlp exception.
fn friendly_error(error: &str, failure: FailureKind) -> String {
    let hint = match failure {
        FailureKind::Write => Some(
            "Usually an output path or filename that's too long — try a shorter download \
             folder path, or turn on ASCII-only filenames in Settings.",
        ),
        FailureKind::Refused => Some(
            "YouTube refused the media URL. Retrying re-extracts it, which normally clears \
             this; if it keeps happening, update yt-dlp on the Components page, lower the \
             parallel-download count, or add cookies (Settings → Cookies).",
        ),
        FailureKind::Auth => Some(
            "The site wants a signed-in session for this link. Add your cookies in \
             Settings → Cookies (a cookies.txt file, or import them from a browser you're \
             logged in with). Instagram profiles and private posts always need this.",
        ),
        FailureKind::Other => None,
    };
    match hint {
        Some(h) => format!("{error}\n\n{h}"),
        None => error.to_string(),
    }
}

async fn fail_task(app: &AppHandle, task: &DownloadTask, settings: &Settings, error: String) {
    clear_log(app, &task.id);
    push_log(app, &task.id, error.clone());
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
    // A gallery task wrote many files; its running total is the real size,
    // where `filename` only holds whichever file happened to come last.
    let filesize = if is_gallery(&task.options) {
        task.downloaded_bytes
    } else {
        task.filename
            .as_deref()
            .and_then(|f| std::fs::metadata(f).ok())
            .map(|m| m.len())
            .unwrap_or(task.downloaded_bytes)
    };
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
        media_key: task.media_key.clone(),
        source: Some("local".into()),
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

#[cfg(test)]
mod audio_tests {
    use super::*;

    fn opts(audio_quality: &str, sample_rate: Option<&str>) -> DownloadOptions {
        DownloadOptions {
            audio_quality: Some(audio_quality.into()),
            sample_rate: sample_rate.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn mp3_at_the_default_48k_clamps_unchanged() {
        let settings = Settings { audio_sample_rate: "48000".into(), ..Default::default() };
        assert_eq!(resolve_sample_rate(&opts("320", None), &settings, "mp3"), Some("48000".into()));
    }

    #[test]
    fn mp3_requesting_96k_falls_back_to_48k() {
        let settings = Settings { audio_sample_rate: "96000".into(), ..Default::default() };
        assert_eq!(resolve_sample_rate(&opts("320", None), &settings, "mp3"), Some("48000".into()));
    }

    #[test]
    fn aac_requesting_96k_also_falls_back_to_48k() {
        let settings = Settings { audio_sample_rate: "96000".into(), ..Default::default() };
        assert_eq!(resolve_sample_rate(&opts("320", None), &settings, "aac"), Some("48000".into()));
    }

    #[test]
    fn opus_is_always_48k_regardless_of_the_setting() {
        let settings = Settings { audio_sample_rate: "44100".into(), ..Default::default() };
        assert_eq!(resolve_sample_rate(&opts("vbr", None), &settings, "opus"), Some("48000".into()));
    }

    #[test]
    fn flac_at_96k_is_not_clamped() {
        let settings = Settings { audio_sample_rate: "96000".into(), ..Default::default() };
        assert_eq!(resolve_sample_rate(&opts("vbr", None), &settings, "flac"), Some("96000".into()));
    }

    #[test]
    fn source_never_resamples() {
        let settings = Settings { audio_sample_rate: "48000".into(), ..Default::default() };
        // build_args itself skips resolve_sample_rate entirely for "source";
        // this documents that "original" (the explicit per-task choice) also
        // resolves to no resampling for any format.
        assert_eq!(
            resolve_sample_rate(&opts("match", Some("original")), &settings, "mp3"),
            None
        );
    }

    #[test]
    fn a_per_task_override_wins_over_the_global_setting() {
        let settings = Settings { audio_sample_rate: "48000".into(), ..Default::default() };
        assert_eq!(
            resolve_sample_rate(&opts("320", Some("44100")), &settings, "mp3"),
            Some("44100".into())
        );
    }

    #[test]
    fn mp3_320_with_joint_stereo_merges_into_one_extractaudio_postprocessor_arg() {
        let opts = DownloadOptions {
            url: "https://example.com/x".into(),
            kind: "audio".into(),
            format: Some("ba/b".into()),
            audio_format: Some("mp3".into()),
            audio_quality: Some("320".into()),
            ..Default::default()
        };
        let settings = Settings {
            joint_stereo: true,
            audio_sample_rate: "48000".into(),
            ..Default::default()
        };
        assert_eq!(
            extract_audio_pp_args(&opts, &settings, "mp3").as_deref(),
            Some("ExtractAudio:-joint_stereo 1 -ar 48000")
        );
    }

    #[test]
    fn vbr_mp3_skips_joint_stereo_and_source_gets_no_postprocessor_args() {
        let settings = Settings {
            joint_stereo: true,
            audio_sample_rate: "44100".into(),
            ..Default::default()
        };
        assert_eq!(
            extract_audio_pp_args(&opts("vbr", None), &settings, "mp3").as_deref(),
            Some("ExtractAudio:-ar 44100")
        );
        assert_eq!(extract_audio_pp_args(&opts("match", None), &settings, "source"), None);
    }

    #[test]
    fn cookies_file_wins_over_a_browser_and_blanks_are_ignored() {
        let mut settings = Settings {
            cookies_file: "C:/c.txt".into(),
            cookies_from_browser: "firefox".into(),
            ..Default::default()
        };
        assert_eq!(cookie_args(&settings), ["--cookies", "C:/c.txt"]);
        settings.cookies_file = "  ".into();
        assert_eq!(cookie_args(&settings), ["--cookies-from-browser", "firefox"]);
        settings.cookies_from_browser = String::new();
        assert!(cookie_args(&settings).is_empty());
    }

    #[test]
    fn destination_lines_name_the_output_file() {
        assert_eq!(
            destination_path("[ExtractAudio] Destination: C:\\Music\\a - b.mp3"),
            Some("C:\\Music\\a - b.mp3")
        );
        assert_eq!(
            destination_path("[Merger] Merging formats into \"C:\\v\\x.mkv\""),
            Some("C:\\v\\x.mkv")
        );
        assert_eq!(destination_path("[download]  42.0% of 3.00MiB"), None);
    }
}
