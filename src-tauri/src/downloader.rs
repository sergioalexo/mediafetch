//! Download queue engine: spawns yt-dlp processes, parses progress,
//! enforces the parallel-download limit and drives pause/resume/retry.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
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

/// Append one line to a task's transcript and notify any open log viewer.
fn push_log(app: &AppHandle, id: &str, line: String) {
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
    let _ = app.emit(
        "task-log",
        &TaskLogLine {
            id: id.to_string(),
            line,
        },
    );
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

fn force_utf8_io(cmd: &mut tokio::process::Command) {
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

/// Per-attempt adjustments an auto-retry applies to work around whatever
/// killed the previous attempt. A retry that changes nothing just fails again.
#[derive(Debug, Clone, Copy, Default)]
pub struct RetryTweaks {
    /// Download without concurrent fragments (`-N`).
    pub single_connection: bool,
    /// Let yt-dlp pick its own YouTube player clients instead of our pinned
    /// ones, so the attempt gets a freshly signed set of media URLs.
    pub default_player_client: bool,
}

pub fn build_args(
    app: &AppHandle,
    opts: &DownloadOptions,
    settings: &Settings,
    tweaks: RetryTweaks,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let is_audio = opts.kind == "audio";

    args.extend([
        "--newline".into(),
        "--no-warnings".into(),
        ENCODING_ARGS[0].into(),
        ENCODING_ARGS[1].into(),
        "--progress-template".into(),
        PROGRESS_TEMPLATE.into(),
        "--progress-template".into(),
        PP_TEMPLATE.into(),
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

    // Prefer the "android_vr" YouTube player client: as of mid-2026 the
    // "web"/"ios"/"mweb" clients frequently return zero playable formats for
    // otherwise-normal videos (surfacing as "Requested format is not
    // available") once YouTube's bot/PO-token checks kick in, while
    // android_vr still serves full format lists without a token. Keep "web"
    // as a fallback so cookie-gated (private/members-only) videos, which
    // android_vr can't authenticate for, still resolve.
    //
    // A retry after an HTTP 403 drops the pin instead: those media URLs are
    // dead for good, so the retry is only worth anything if it re-extracts
    // through different clients than the ones that just got refused.
    if !tweaks.default_player_client {
        args.extend([
            "--extractor-args".into(),
            "youtube:player_client=android_vr,web".into(),
        ]);
    }

    // Network
    if settings.concurrent_fragments > 1 && !tweaks.single_connection {
        args.extend(["-N".into(), settings.concurrent_fragments.to_string()]);
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
    if settings.fragment_retries > 0 {
        args.extend(["--fragment-retries".into(), settings.fragment_retries.to_string()]);
    }
    if settings.sleep_requests > 0.0 {
        args.extend(["--sleep-requests".into(), settings.sleep_requests.to_string()]);
    }
    if !settings.impersonate.trim().is_empty() {
        args.extend(["--impersonate".into(), settings.impersonate.trim().to_string()]);
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
            // Joint stereo squeezes more quality from constant-bitrate MP3.
            if audio_format == "mp3" && quality != "vbr" && settings.joint_stereo {
                args.extend([
                    "--postprocessor-args".into(),
                    "ExtractAudio:-joint_stereo 1".into(),
                ]);
            }
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
    let settings = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        s.clone()
    };

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

    let ytdlp = match binaries::ytdlp_path(&app) {
        Ok(p) => p,
        Err(e) => {
            fail_task(&app, &task, &settings, e).await;
            return;
        }
    };
    let tweaks = RetryTweaks {
        single_connection: task.force_single_connection,
        default_player_client: task.use_default_player_client,
    };
    let args = match build_args(&app, &task.options, &settings, tweaks) {
        Ok(a) => a,
        Err(e) => {
            fail_task(&app, &task, &settings, e).await;
            return;
        }
    };

    let mut cmd = tokio::process::Command::new(&ytdlp);
    force_utf8_io(&mut cmd);
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

    // Fresh transcript for this run — a retry shouldn't mix in the previous
    // attempt's output.
    clear_log(&app, &task.id);
    if task.force_single_connection {
        push_log(&app, &task.id, "Retrying without concurrent fragments (-N) to rule out write contention.".into());
    }
    if task.use_default_player_client {
        push_log(&app, &task.id, "Retrying with yt-dlp's default player clients to get fresh media URLs.".into());
    }
    push_log(&app, &task.id, format!("$ {} {}", ytdlp.to_string_lossy(), args.join(" ")));

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
    let dest_re = regex::Regex::new(
        r#"^\[(?:download|ExtractAudio)\] Destination: (.+)$"#,
    )
    .unwrap();
    let merge_re = regex::Regex::new(r#"^\[Merger\] Merging formats into "(.+)"$"#).unwrap();
    let move_re = regex::Regex::new(r#"^\[MoveFiles\] Moving file "(?:.+)" to "(.+)"$"#).unwrap();
    let already_re =
        regex::Regex::new(r#"^\[download\] (.+) has already been downloaded"#).unwrap();

    if let Some(stdout) = child.stdout.take() {
        let mut last_emit = std::time::Instant::now();
        read_lines(stdout, |line| {
            let line = line.trim_end();
            let mut updated: Option<DownloadTask> = None;
            let mut force_emit = false;

            // The two progress-template markers are internal bookkeeping,
            // not real yt-dlp output — everything else is worth logging.
            if !line.is_empty() && !line.starts_with("MFPROG|") && !line.starts_with("MFPP") {
                push_log(&app, &task.id, line.to_string());
            }

            if let Some(rest) = line.strip_prefix("MFPROG|") {
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
            } else if let Some(caps) = dest_re
                .captures(line)
                .or_else(|| merge_re.captures(line))
                .or_else(|| move_re.captures(line))
                .or_else(|| already_re.captures(line))
            {
                let path = caps.get(1).map(|m| m.as_str().to_string());
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
        let raw_error = stderr_tail
            .iter()
            .rev()
            .find(|l| l.contains("ERROR"))
            .cloned()
            .or_else(|| stderr_tail.back().cloned())
            .unwrap_or_else(|| "yt-dlp exited with an error".into());
        let failure = classify_failure(&raw_error);
        let error = friendly_error(&raw_error, failure);

        if task.retry_count < settings.auto_retry_limit {
            // Some failures (file locked by AV scan, a brief network blip)
            // reliably succeed on a plain retry — don't make the user click
            // for those. A short pause gives whatever held the file/network
            // a moment to clear.
            //
            // What went wrong decides what the retry should do differently.
            let (delay, note) = match failure {
                FailureKind::Refused => (8, " with yt-dlp's default player clients"),
                FailureKind::Write => (6, " without concurrent fragments"),
                FailureKind::Other => (3, ""),
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
                t.status = TaskStatus::Queued;
                t.retry_count += 1;
                match failure {
                    FailureKind::Refused => t.use_default_player_client = true,
                    FailureKind::Write => t.force_single_connection = true,
                    FailureKind::Other => {}
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

/// Why an attempt failed, in the only terms a retry can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    /// The server turned down the extracted media URL (403/429). That URL is
    /// spent — only a fresh extraction can help.
    Refused,
    /// yt-dlp could not open the output file, typically several tasks'
    /// fragment threads writing into the same folder at once.
    Write,
    Other,
}

fn classify_failure(error: &str) -> FailureKind {
    let lower = error.to_lowercase();
    if lower.contains("http error 403")
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
