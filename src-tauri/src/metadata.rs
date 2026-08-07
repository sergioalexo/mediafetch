//! URL analysis: runs `yt-dlp -J` and condenses the result for the UI.

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::binaries;
use crate::downloader;
use crate::settings::Settings;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFormat {
    pub format_id: String,
    pub ext: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub dynamic_range: Option<String>,
    pub filesize: Option<u64>,
    pub tbr: Option<f64>,
    pub abr: Option<f64>,
    pub language: Option<String>,
    pub format_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub lang: String,
    pub name: String,
    pub auto: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub kind: String, // "video" | "playlist"
    /// Tool that can actually fetch this link: "ytdlp" or "gallerydl".
    pub engine: String,
    pub url: String,
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub formats: Vec<VideoFormat>,
    pub subtitles: Vec<SubtitleTrack>,
    pub audio_languages: Vec<String>,
    pub entry_count: Option<u64>,
    pub entries: Vec<PlaylistEntry>,
}

/// Ask gallery-dl whether it can handle a link yt-dlp gave up on.
///
/// Returns `None` when gallery-dl isn't installed or doesn't recognise the
/// URL, so the caller can surface yt-dlp's original error instead. A gallery
/// is staged as a single item: unlike a playlist, its contents have no
/// separate pages to queue individually — gallery-dl walks the link itself.
async fn analyze_gallery(
    app: &AppHandle,
    url: &str,
    settings: &Settings,
) -> Option<Result<AnalyzeResult, String>> {
    let gallerydl = binaries::gallerydl_path(app).ok()?;

    let mut cmd = tokio::process::Command::new(&gallerydl);
    // One item is enough to prove the extractor works, and --simulate keeps
    // it to metadata — nothing is written.
    cmd.args(["--simulate", "--range", "1-1"]);
    if !settings.cookies_file.is_empty() {
        cmd.args(["--cookies", &settings.cookies_file]);
    } else if !settings.cookies_from_browser.is_empty() {
        cmd.args(["--cookies-from-browser", &settings.cookies_from_browser]);
    }
    if !settings.proxy.is_empty() {
        cmd.args(["--proxy", &settings.proxy]);
    }
    cmd.arg("--").arg(url);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }

    let output = cmd.output().await.ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    // Exit 64 is gallery-dl's "no extractor for this URL" — not our link.
    if output.status.code() == Some(64) || text.contains("Unsupported URL") {
        return None;
    }

    // It recognises the site but the session doesn't hold. Say so here rather
    // than letting the download fail with the same thing minutes later.
    if text.contains("redirect to login") || text.contains("login required") {
        return Some(Err(format!(
            "{} needs you to be signed in. Add cookies in Settings → Cookies, then \
             check them with the button there.",
            gallery_title(url)
        )));
    }
    if !output.status.success() {
        let detail = text
            .lines()
            .rev()
            .find(|l| l.contains("[error]"))
            .unwrap_or("gallery-dl could not read this link")
            .trim()
            .to_string();
        return Some(Err(detail));
    }

    Some(Ok(AnalyzeResult {
        kind: "video".into(),
        engine: "gallerydl".into(),
        url: url.to_string(),
        id: String::new(),
        title: gallery_title(url),
        uploader: None,
        thumbnail: None,
        duration: None,
        formats: vec![],
        subtitles: vec![],
        audio_languages: vec![],
        entry_count: None,
        entries: vec![],
    }))
}

/// A readable name for a gallery link, e.g. "instagram.com/nasa".
fn gallery_title(url: &str) -> String {
    let rest = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .trim_start_matches("www.");
    let trimmed = rest
        .split(['?', '#'])
        .next()
        .unwrap_or(rest)
        .trim_end_matches('/');
    if trimmed.is_empty() {
        url.to_string()
    } else {
        trimmed.to_string()
    }
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string())
}
fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

/// One `yt-dlp -J` run. Returns the JSON on success, or (message, full stderr).
async fn probe(
    app: &AppHandle,
    url: &str,
    settings: &Settings,
    pinned_client: bool,
) -> Result<Vec<u8>, (String, String)> {
    let ytdlp = binaries::ytdlp_path(app).map_err(|e| (e.clone(), e))?;

    let mut cmd = tokio::process::Command::new(&ytdlp);
    // Force UTF-8 stdio — piped output otherwise falls back to the OS ANSI
    // codepage, which mangles non-Latin titles and leaves the JSON below
    // undecodable (see downloader.rs).
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.args(["-J", "--flat-playlist", "--no-warnings", "--encoding", "utf-8"]);
    // `-J` still runs format selection, so analysis fails on exactly the same
    // empty format lists a download would — it has to extract through the same
    // player clients the downloader uses, or it rejects links that would in
    // fact have downloaded fine.
    if pinned_client {
        cmd.args(downloader::youtube_extractor_args(app));
    } else {
        cmd.args(downloader::js_runtime_args(app));
    }
    if !settings.proxy.is_empty() {
        cmd.args(["--proxy", &settings.proxy]);
    }
    if !settings.cookies_file.is_empty() {
        cmd.args(["--cookies", &settings.cookies_file]);
    } else if !settings.cookies_from_browser.is_empty() {
        cmd.args(["--cookies-from-browser", &settings.cookies_from_browser]);
    }
    cmd.arg("--").arg(url);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }

    // Record the command before running it: if this is the attempt that
    // fails, the user can copy something that reproduces it verbatim.
    let log_id = downloader::analyze_log_id(url);
    downloader::push_log(
        app,
        &log_id,
        format!(
            "$ {} {}",
            ytdlp.to_string_lossy(),
            cmd.as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        ),
    );

    let output = cmd
        .output()
        .await
        .map_err(|e| (format!("Failed to run yt-dlp: {e}"), String::new()))?;
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    for line in stderr.lines().filter(|l| !l.trim().is_empty()) {
        downloader::push_log(app, &log_id, line.trim_end().to_string());
    }
    let last = stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR") || !l.trim().is_empty())
        .unwrap_or("yt-dlp failed")
        .trim()
        .to_string();
    Err((last, stderr))
}

pub async fn analyze(app: &AppHandle, url: &str, settings: &Settings) -> Result<AnalyzeResult, String> {
    // Start each analysis with a clean transcript so a retry doesn't hand the
    // user the previous attempt's noise.
    downloader::clear_log(app, &downloader::analyze_log_id(url));

    let stdout = match probe(app, url, settings, true).await {
        Ok(out) => out,
        Err((message, stderr)) => {
            // An empty format list is often just one bad extraction: yt-dlp's
            // own client rotation gets a second, differently-signed shot at it.
            let retried = if downloader::is_no_formats_error(&stderr) {
                probe(app, url, settings, false).await
            } else {
                Err((message, stderr))
            };
            match retried {
                Ok(out) => out,
                Err((message, _)) => {
                    // Photo posts and profile galleries are invisible to yt-dlp
                    // — it only ever sees video formats — so a failure here is
                    // exactly where gallery-dl earns its place.
                    return match analyze_gallery(app, url, settings).await {
                        Some(result) => result,
                        None => Err(message),
                    };
                }
            }
        }
    };

    // Nothing needs the transcript of an analysis that worked, and these are
    // keyed by URL — keeping them would grow the log store for the whole
    // session, one entry per link the user ever pasted.
    downloader::clear_log(app, &downloader::analyze_log_id(url));

    let info: Value =
        serde_json::from_slice(&stdout).map_err(|e| format!("Bad yt-dlp output: {e}"))?;

    let is_playlist = info.get("_type").and_then(|t| t.as_str()) == Some("playlist");

    if is_playlist {
        let entries: Vec<PlaylistEntry> = info
            .get("entries")
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|e| PlaylistEntry {
                        id: s(e, "id").unwrap_or_default(),
                        title: s(e, "title").unwrap_or_else(|| "Untitled".into()),
                        url: s(e, "url").or_else(|| s(e, "webpage_url")).unwrap_or_default(),
                        duration: f(e, "duration"),
                        thumbnail: s(e, "thumbnail"),
                    })
                    .collect()
            })
            .unwrap_or_default();

        return Ok(AnalyzeResult {
            kind: "playlist".into(),
            engine: "ytdlp".into(),
            url: url.to_string(),
            id: s(&info, "id").unwrap_or_default(),
            title: s(&info, "title").unwrap_or_else(|| "Playlist".into()),
            uploader: s(&info, "uploader").or_else(|| s(&info, "channel")),
            thumbnail: None,
            duration: None,
            formats: vec![],
            subtitles: vec![],
            audio_languages: vec![],
            entry_count: info
                .get("playlist_count")
                .and_then(|c| c.as_u64())
                .or(Some(entries.len() as u64)),
            entries,
        });
    }

    // ---- single video ----
    let formats: Vec<VideoFormat> = info
        .get("formats")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|fm| {
                    let format_id = s(fm, "format_id")?;
                    Some(VideoFormat {
                        format_id,
                        ext: s(fm, "ext").unwrap_or_default(),
                        height: f(fm, "height").map(|h| h as u32),
                        width: f(fm, "width").map(|w| w as u32),
                        fps: f(fm, "fps"),
                        vcodec: s(fm, "vcodec"),
                        acodec: s(fm, "acodec"),
                        dynamic_range: s(fm, "dynamic_range"),
                        filesize: f(fm, "filesize")
                            .or_else(|| f(fm, "filesize_approx"))
                            .map(|x| x as u64),
                        tbr: f(fm, "tbr"),
                        abr: f(fm, "abr"),
                        language: s(fm, "language"),
                        format_note: s(fm, "format_note"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut audio_languages: Vec<String> = formats
        .iter()
        .filter(|fm| {
            fm.acodec.as_deref().map(|a| a != "none").unwrap_or(false)
                && fm.vcodec.as_deref().map(|v| v == "none").unwrap_or(true)
        })
        .filter_map(|fm| fm.language.clone())
        .collect();
    audio_languages.sort();
    audio_languages.dedup();
    if audio_languages.len() < 2 {
        audio_languages.clear();
    }

    let subtitles: Vec<SubtitleTrack> = info
        .get("subtitles")
        .and_then(|x| x.as_object())
        .map(|map| {
            map.iter()
                .map(|(lang, tracks)| SubtitleTrack {
                    lang: lang.clone(),
                    name: tracks
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|t| s(t, "name"))
                        .unwrap_or_else(|| lang.clone()),
                    auto: false,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(AnalyzeResult {
        kind: "video".into(),
        engine: "ytdlp".into(),
        url: url.to_string(),
        id: s(&info, "id").unwrap_or_default(),
        title: s(&info, "title").unwrap_or_else(|| "Untitled".into()),
        uploader: s(&info, "uploader").or_else(|| s(&info, "channel")),
        thumbnail: s(&info, "thumbnail"),
        duration: f(&info, "duration"),
        formats,
        subtitles,
        audio_languages,
        entry_count: None,
        entries: vec![],
    })
}
