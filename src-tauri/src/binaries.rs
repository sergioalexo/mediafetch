//! Self-contained manager for the external tools MediaFetch depends on
//! (yt-dlp and FFmpeg). Handles discovery, version detection, update checks
//! against the upstream GitHub repositories and in-place installs/updates.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub const YTDLP: &str = "yt-dlp";
pub const FFMPEG: &str = "ffmpeg";

const YTDLP_REPO: &str = "yt-dlp/yt-dlp";
const FFMPEG_REPO: &str = "BtbN/FFmpeg-Builds";

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
const YTDLP_ASSET: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const YTDLP_ASSET: &str = "yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const YTDLP_ASSET: &str = "yt-dlp";

#[cfg(windows)]
fn exe_name(name: &str) -> String {
    format!("{name}.exe")
}
#[cfg(not(windows))]
fn exe_name(name: &str) -> String {
    name.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub name: String,
    pub repo_url: String,
    pub releases_url: String,
    pub path: Option<String>,
    pub installed: bool,
    pub managed: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    /// Version kept in the rollback slot (the one replaced by the last update).
    pub previous_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryProgress {
    pub name: String,
    pub phase: String, // downloading | extracting | done | error
    pub downloaded: u64,
    pub total: u64,
    pub message: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

pub fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn find_on_path(exe: &str) -> Option<PathBuf> {
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // GUI apps launched from Finder don't inherit the shell PATH, so the
    // Homebrew locations are checked explicitly.
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = PathBuf::from(dir).join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Resolve a tool: prefer the managed copy in our bin dir, fall back to PATH.
/// Returns (path, managed).
pub fn resolve(app: &AppHandle, name: &str) -> Option<(PathBuf, bool)> {
    let exe = exe_name(name);
    if let Ok(dir) = bin_dir(app) {
        let managed = dir.join(&exe);
        if managed.is_file() {
            return Some((managed, true));
        }
    }
    find_on_path(&exe).map(|p| (p, false))
}

pub fn ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    resolve(app, YTDLP).map(|(p, _)| p).ok_or_else(|| {
        "yt-dlp is not installed. Open the Components page to install it.".to_string()
    })
}

pub fn ffmpeg_dir(app: &AppHandle) -> Option<PathBuf> {
    resolve(app, FFMPEG).map(|(p, _)| p.parent().map(|d| d.to_path_buf()).unwrap_or(p))
}

/// Files that make up a managed component (first entry is the main exe).
fn component_files(name: &str) -> Vec<String> {
    match name {
        YTDLP => vec![exe_name(YTDLP)],
        FFMPEG => vec![exe_name(FFMPEG), exe_name("ffprobe"), "ffmpeg.tag".to_string()],
        _ => Vec::new(),
    }
}

/// Path of the rollback copy of a component's main exe, if one exists.
fn previous_exe(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let files = component_files(name);
    let p = bin_dir(app).ok()?.join("previous").join(files.first()?);
    p.is_file().then_some(p)
}

/// Keep a copy of the currently installed component so the user can
/// roll back if the new version misbehaves.
fn backup_current(app: &AppHandle, name: &str) -> Result<(), String> {
    let dir = bin_dir(app)?;
    let files = component_files(name);
    if files.is_empty() || !dir.join(&files[0]).is_file() {
        return Ok(()); // nothing installed yet
    }
    let prev = dir.join("previous");
    std::fs::create_dir_all(&prev).map_err(|e| e.to_string())?;
    for f in &files {
        let src = dir.join(f);
        if src.is_file() {
            std::fs::copy(&src, prev.join(f)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Swap the installed component with the rollback copy. Running it again
/// switches back, so the user can hop between the two versions freely.
pub fn rollback(app: &AppHandle, name: &str) -> Result<(), String> {
    let dir = bin_dir(app)?;
    let prev = dir.join("previous");
    let files = component_files(name);
    if files.is_empty() {
        return Err(format!("Unknown binary: {name}"));
    }
    if !prev.join(&files[0]).is_file() {
        return Err("No previous version available to roll back to.".into());
    }
    for f in &files {
        let cur = dir.join(f);
        let old = prev.join(f);
        let tmp = dir.join(format!("{f}.swap"));
        let _ = std::fs::remove_file(&tmp);
        if cur.is_file() {
            std::fs::rename(&cur, &tmp)
                .map_err(|e| format!("Could not replace {f} (is it in use?): {e}"))?;
        }
        if old.is_file() {
            std::fs::rename(&old, &cur).map_err(|e| e.to_string())?;
        }
        if tmp.is_file() {
            std::fs::rename(&tmp, &old).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn run_version(path: &PathBuf, arg: &str) -> Option<String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg(arg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.trim().to_string())
}

fn ffmpeg_installed_tag(app: &AppHandle) -> Option<String> {
    let tag_file = bin_dir(app).ok()?.join("ffmpeg.tag");
    std::fs::read_to_string(tag_file).ok().map(|s| s.trim().to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("MediaFetch/0.1 (https://github.com)")
        .build()
        .map_err(|e| e.to_string())
}

/// Latest release tag of a GitHub repository, e.g. "v0.2.0".
pub async fn latest_release_tag(repo: &str) -> Result<String, String> {
    latest_release(repo).await.map(|r| r.tag_name)
}

async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let client = http_client()?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }
    resp.json::<T>()
        .await
        .map_err(|e| format!("Bad GitHub API response: {e}"))
}

async fn latest_release(repo: &str) -> Result<GhRelease, String> {
    fetch_json(&format!(
        "https://api.github.com/repos/{repo}/releases/latest"
    ))
    .await
}

async fn release_by_tag(repo: &str, tag: &str) -> Result<GhRelease, String> {
    fetch_json(&format!(
        "https://api.github.com/repos/{repo}/releases/tags/{tag}"
    ))
    .await
}

fn repo_for(name: &str) -> Result<&'static str, String> {
    match name {
        YTDLP => Ok(YTDLP_REPO),
        FFMPEG => Ok(FFMPEG_REPO),
        other => Err(format!("Unknown binary: {other}")),
    }
}

/// Recent release tags of a component, newest first.
pub async fn list_versions(name: &str) -> Result<Vec<String>, String> {
    let repo = repo_for(name)?;
    let releases: Vec<GhRelease> = fetch_json(&format!(
        "https://api.github.com/repos/{repo}/releases?per_page=20"
    ))
    .await?;
    Ok(releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .map(|r| r.tag_name)
        .collect())
}

pub async fn get_status(app: &AppHandle, check_latest: bool) -> Vec<BinaryStatus> {
    let mut out = Vec::new();

    // ---- yt-dlp ----
    let ytdlp = resolve(app, YTDLP);
    let ytdlp_version = ytdlp.as_ref().and_then(|(p, _)| run_version(p, "--version"));
    let ytdlp_latest = if check_latest {
        latest_release(YTDLP_REPO).await.ok().map(|r| r.tag_name)
    } else {
        None
    };
    out.push(BinaryStatus {
        name: YTDLP.into(),
        repo_url: format!("https://github.com/{YTDLP_REPO}"),
        releases_url: format!("https://github.com/{YTDLP_REPO}/releases"),
        path: ytdlp.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
        installed: ytdlp.is_some(),
        managed: ytdlp.as_ref().map(|(_, m)| *m).unwrap_or(false),
        update_available: match (&ytdlp_version, &ytdlp_latest) {
            (Some(cur), Some(latest)) => cur != latest,
            _ => false,
        },
        current_version: ytdlp_version,
        latest_version: ytdlp_latest,
        previous_version: previous_exe(app, YTDLP).and_then(|p| run_version(&p, "--version")),
    });

    // ---- ffmpeg ----
    let ffmpeg = resolve(app, FFMPEG);
    let ffmpeg_version = ffmpeg.as_ref().and_then(|(p, _)| {
        run_version(p, "-version").map(|line| {
            // "ffmpeg version N-118000-g1234abc-20260601 Copyright ..." -> version token
            line.split_whitespace()
                .nth(2)
                .unwrap_or("unknown")
                .to_string()
        })
    });
    let installed_tag = ffmpeg_installed_tag(app);
    let ffmpeg_latest = if check_latest {
        latest_release(FFMPEG_REPO).await.ok().map(|r| r.tag_name)
    } else {
        None
    };
    let managed = ffmpeg.as_ref().map(|(_, m)| *m).unwrap_or(false);
    out.push(BinaryStatus {
        name: FFMPEG.into(),
        repo_url: format!("https://github.com/{FFMPEG_REPO}"),
        releases_url: format!("https://github.com/{FFMPEG_REPO}/releases"),
        path: ffmpeg.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
        installed: ffmpeg.is_some(),
        managed,
        update_available: match (&installed_tag, &ffmpeg_latest) {
            // Only meaningful for managed installs where we recorded the tag.
            (Some(cur), Some(latest)) if managed => cur != latest,
            _ => false,
        },
        current_version: ffmpeg_version,
        latest_version: ffmpeg_latest,
        previous_version: previous_exe(app, FFMPEG).and_then(|p| {
            run_version(&p, "-version")
                .map(|line| line.split_whitespace().nth(2).unwrap_or("unknown").to_string())
        }),
    });

    out
}

fn emit_progress(app: &AppHandle, p: BinaryProgress) {
    let _ = app.emit("binary-progress", &p);
}

async fn download_with_progress(
    app: &AppHandle,
    name: &str,
    url: &str,
    expected_size: u64,
    dest: &PathBuf,
) -> Result<(), String> {
    let client = http_client()?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(expected_size);
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() > 150 {
            last_emit = std::time::Instant::now();
            emit_progress(
                app,
                BinaryProgress {
                    name: name.into(),
                    phase: "downloading".into(),
                    downloaded,
                    total,
                    message: None,
                },
            );
        }
    }
    drop(file);
    // Replace any existing file.
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn install(app: &AppHandle, name: &str, version: Option<&str>) -> Result<(), String> {
    let result = install_inner(app, name, version).await;
    match &result {
        Ok(()) => emit_progress(
            app,
            BinaryProgress {
                name: name.into(),
                phase: "done".into(),
                downloaded: 0,
                total: 0,
                message: None,
            },
        ),
        Err(e) => emit_progress(
            app,
            BinaryProgress {
                name: name.into(),
                phase: "error".into(),
                downloaded: 0,
                total: 0,
                message: Some(e.clone()),
            },
        ),
    }
    result
}

async fn install_inner(app: &AppHandle, name: &str, version: Option<&str>) -> Result<(), String> {
    let dir = bin_dir(app)?;
    backup_current(app, name)?;
    let release = match version {
        Some(tag) => release_by_tag(repo_for(name)?, tag).await?,
        None => latest_release(repo_for(name)?).await?,
    };
    match name {
        YTDLP => {
            let asset = release
                .assets
                .iter()
                .find(|a| a.name == YTDLP_ASSET)
                .ok_or_else(|| format!("{YTDLP_ASSET} asset not found in this release"))?;
            let dest = dir.join(exe_name(YTDLP));
            download_with_progress(app, name, &asset.browser_download_url, asset.size, &dest)
                .await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        #[cfg(not(windows))]
        FFMPEG => Err(
            "Automatic FFmpeg install is only available on Windows. Install it with \
             Homebrew (`brew install ffmpeg`) — MediaFetch will detect it automatically."
                .to_string(),
        ),
        #[cfg(windows)]
        FFMPEG => {
            let asset = release
                .assets
                .iter()
                .find(|a| a.name == "ffmpeg-master-latest-win64-gpl.zip")
                .or_else(|| {
                    release
                        .assets
                        .iter()
                        .find(|a| a.name.contains("master") && a.name.ends_with("win64-gpl.zip"))
                })
                .or_else(|| {
                    release
                        .assets
                        .iter()
                        .find(|a| a.name.ends_with("win64-gpl.zip"))
                })
                .ok_or("No win64-gpl FFmpeg build found in this release")?;
            let zip_path = dir.join("ffmpeg-download.zip");
            download_with_progress(app, name, &asset.browser_download_url, asset.size, &zip_path)
                .await?;

            emit_progress(
                app,
                BinaryProgress {
                    name: name.into(),
                    phase: "extracting".into(),
                    downloaded: 0,
                    total: 0,
                    message: None,
                },
            );

            let dir2 = dir.clone();
            let zip2 = zip_path.clone();
            tokio::task::spawn_blocking(move || extract_ffmpeg(&zip2, &dir2))
                .await
                .map_err(|e| e.to_string())??;

            let _ = std::fs::remove_file(&zip_path);
            std::fs::write(dir.join("ffmpeg.tag"), &release.tag_name)
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        other => Err(format!("Unknown binary: {other}")),
    }
}

#[cfg(windows)]
fn extract_ffmpeg(zip_path: &PathBuf, dest_dir: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let wanted = ["ffmpeg.exe", "ffprobe.exe"];
    let mut extracted = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.name().replace('\\', "/");
        if let Some(fname) = wanted
            .iter()
            .find(|w| entry_name.ends_with(&format!("bin/{w}")))
        {
            let out_path = dest_dir.join(fname);
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            extracted += 1;
        }
    }
    if extracted == 0 {
        return Err("ffmpeg.exe not found inside the downloaded archive".into());
    }
    Ok(())
}
