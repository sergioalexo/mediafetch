//! URL analysis: runs `yt-dlp -J` and condenses the result for the UI.

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::binaries;
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

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string())
}
fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

pub async fn analyze(app: &AppHandle, url: &str, settings: &Settings) -> Result<AnalyzeResult, String> {
    let ytdlp = binaries::ytdlp_path(app)?;

    let mut cmd = tokio::process::Command::new(&ytdlp);
    cmd.args(["-J", "--flat-playlist", "--no-warnings"]);
    if !settings.proxy.is_empty() {
        cmd.args(["--proxy", &settings.proxy]);
    }
    if !settings.cookies_file.is_empty() {
        cmd.args(["--cookies", &settings.cookies_file]);
    } else if !settings.cookies_from_browser.is_empty() {
        cmd.args(["--cookies-from-browser", &settings.cookies_from_browser]);
    }
    cmd.arg("--").arg(url);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }

    let output = cmd.output().await.map_err(|e| format!("Failed to run yt-dlp: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| l.contains("ERROR") || !l.trim().is_empty())
            .unwrap_or("yt-dlp failed");
        return Err(last.trim().to_string());
    }

    let info: Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Bad yt-dlp output: {e}"))?;

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
