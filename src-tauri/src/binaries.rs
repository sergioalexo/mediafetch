//! Self-contained manager for the external tools MediaFetch depends on
//! (yt-dlp, FFmpeg, Deno and gallery-dl). Handles discovery, version
//! detection, update checks against the upstream GitHub repositories and
//! in-place installs/updates with a one-step rollback slot.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

pub const YTDLP: &str = "yt-dlp";
pub const FFMPEG: &str = "ffmpeg";
pub const GALLERYDL: &str = "gallery-dl";
/// The JavaScript runtime yt-dlp uses to solve YouTube's signature and `n`
/// challenges. Optional, but without one (or Node on PATH) most YouTube
/// player clients return storyboard images and no audio or video at all.
pub const DENO: &str = "deno";

/// Everything that differs between the managed components.
struct Component {
    name: &'static str,
    /// Where the release assets are published.
    release_repo: &'static str,
    /// The project itself, for the Components page's source link.
    home_url: &'static str,
    version_arg: &'static str,
}

const COMPONENTS: [Component; 4] = [
    Component {
        name: YTDLP,
        release_repo: "yt-dlp/yt-dlp",
        home_url: "https://github.com/yt-dlp/yt-dlp",
        version_arg: "--version",
    },
    Component {
        name: GALLERYDL,
        // gallery-dl's own repository publishes no binaries; the project's
        // standalone executables are built and released here.
        release_repo: "gdl-org/builds",
        home_url: "https://github.com/mikf/gallery-dl",
        version_arg: "--version",
    },
    Component {
        name: DENO,
        release_repo: "denoland/deno",
        home_url: "https://github.com/denoland/deno",
        version_arg: "--version",
    },
    Component {
        name: FFMPEG,
        release_repo: "BtbN/FFmpeg-Builds",
        home_url: "https://github.com/BtbN/FFmpeg-Builds",
        version_arg: "-version",
    },
];

fn component(name: &str) -> Result<&'static Component, String> {
    COMPONENTS
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| format!("Unknown binary: {name}"))
}

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
const YTDLP_ASSET: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const YTDLP_ASSET: &str = "yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const YTDLP_ASSET: &str = "yt-dlp";

#[cfg(windows)]
const GALLERYDL_ASSET: &str = "gallery-dl_windows.exe";
#[cfg(target_os = "macos")]
const GALLERYDL_ASSET: &str = "gallery-dl_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const GALLERYDL_ASSET: &str = "gallery-dl_linux";

// Deno ships one zip per target, each containing a single `deno` executable.
#[cfg(all(windows, target_arch = "x86_64"))]
const DENO_ASSET: &str = "deno-x86_64-pc-windows-msvc.zip";
#[cfg(all(windows, target_arch = "aarch64"))]
const DENO_ASSET: &str = "deno-aarch64-pc-windows-msvc.zip";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const DENO_ASSET: &str = "deno-aarch64-apple-darwin.zip";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const DENO_ASSET: &str = "deno-x86_64-apple-darwin.zip";
#[cfg(all(unix, not(target_os = "macos"), target_arch = "aarch64"))]
const DENO_ASSET: &str = "deno-aarch64-unknown-linux-gnu.zip";
#[cfg(all(unix, not(target_os = "macos"), target_arch = "x86_64"))]
const DENO_ASSET: &str = "deno-x86_64-unknown-linux-gnu.zip";

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
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
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

/// Locate a helper executable on PATH by bare name (adds ".exe" on Windows).
/// Used for the JavaScript runtimes yt-dlp needs for YouTube extraction.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    find_on_path(&exe_name(name))
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

pub fn gallerydl_path(app: &AppHandle) -> Result<PathBuf, String> {
    resolve(app, GALLERYDL).map(|(p, _)| p).ok_or_else(|| {
        "gallery-dl is not installed. Open the Components page to install it — it's what \
         downloads photo posts and profile galleries."
            .to_string()
    })
}

pub fn ffmpeg_dir(app: &AppHandle) -> Option<PathBuf> {
    resolve(app, FFMPEG).map(|(p, _)| p.parent().map(|d| d.to_path_buf()).unwrap_or(p))
}

/// Files that make up a managed component (first entry is the main exe).
fn component_files(name: &str) -> Vec<String> {
    match name {
        YTDLP | GALLERYDL | DENO => vec![exe_name(name)],
        FFMPEG => vec![exe_name(FFMPEG), exe_name("ffprobe"), FFMPEG_TAG_FILE.to_string()],
        _ => Vec::new(),
    }
}

/// Which FFmpeg build is installed — FFmpeg's own version string doesn't say
/// which release it came from, so the installer records it here.
const FFMPEG_TAG_FILE: &str = "ffmpeg.tag";

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

/// Remove a managed component's installed files and any rollback backup,
/// leaving it uninstalled so the existing Install button fetches it fresh.
/// A last-resort fix for a component that's misbehaving or corrupted.
pub fn uninstall(app: &AppHandle, name: &str) -> Result<(), String> {
    let dir = bin_dir(app)?;
    let files = component_files(name);
    if files.is_empty() {
        return Err(format!("Unknown binary: {name}"));
    }
    for f in &files {
        let _ = std::fs::remove_file(dir.join(f));
        let _ = std::fs::remove_file(dir.join("previous").join(f));
    }
    remove_leftovers(&dir, name);
    Ok(())
}

/// Wipe every managed component and rollback backup, plus yt-dlp's own
/// on-disk network/extractor cache — a complete reset for when components
/// are broken in a way a single reinstall doesn't fix. PATH-installed
/// (unmanaged) tools are never touched.
pub fn reset_all(app: &AppHandle) -> Result<(), String> {
    if let Some((path, _)) = resolve(app, YTDLP) {
        let mut cmd = std::process::Command::new(&path);
        cmd.arg("--rm-cache-dir");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = cmd.output(); // best-effort; a missing/broken yt-dlp shouldn't block the reset
    }
    let dir = bin_dir(app)?;
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

fn run_version(path: &Path, arg: &str) -> Option<String> {
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

/// The version a component reports, reduced to the part its release tags use
/// where they differ: "deno 2.5.1 (stable, …)" -> "2.5.1", and
/// "ffmpeg version N-118000-g1234abc-20260601 Copyright …" -> the build token.
fn parse_version(name: &str, first_line: &str) -> String {
    let token = match name {
        DENO => first_line.split_whitespace().nth(1),
        FFMPEG => first_line.split_whitespace().nth(2),
        _ => return first_line.to_string(),
    };
    token.unwrap_or("unknown").to_string()
}

fn installed_version(name: &str, path: &Path) -> Option<String> {
    let arg = component(name).ok()?.version_arg;
    run_version(path, arg).map(|line| parse_version(name, &line))
}

/// First line of `<tool> --version` (or `-version` for ffmpeg), if the tool is
/// resolvable. Used for the diagnostics block in issue reports.
pub fn tool_version(app: &AppHandle, name: &str) -> Option<String> {
    let (path, _) = resolve(app, name)?;
    run_version(&path, component(name).ok()?.version_arg)
}

/// The proxy configured in the app settings ("" when unset).
pub(crate) fn app_proxy(app: &AppHandle) -> String {
    let state = app.state::<crate::downloader::AppState>();
    let s = state.settings.lock().unwrap();
    s.proxy.trim().to_string()
}

pub(crate) fn http_client(proxy: &str) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!(
            "MediaFetch/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/sergioalexo/mediafetch)"
        ))
        // A dead connection used to leave an install spinning forever. There
        // is deliberately no overall timeout — a 150 MB FFmpeg build on a slow
        // line is fine — but a stall this long is not.
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60));
    if !proxy.is_empty() {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy).map_err(|e| format!("invalid proxy setting: {e}"))?,
        );
    }
    builder.build().map_err(|e| e.to_string())
}

/// Latest release tag of a GitHub repository, e.g. "v0.2.0".
pub async fn latest_release_tag(repo: &str, proxy: &str) -> Result<String, String> {
    latest_release(repo, proxy).await.map(|r| r.tag_name)
}

async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str, proxy: &str) -> Result<T, String> {
    let client = http_client(proxy)?;
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

async fn latest_release(repo: &str, proxy: &str) -> Result<GhRelease, String> {
    fetch_json(
        &format!("https://api.github.com/repos/{repo}/releases/latest"),
        proxy,
    )
    .await
}

async fn release_by_tag(repo: &str, tag: &str, proxy: &str) -> Result<GhRelease, String> {
    fetch_json(
        &format!("https://api.github.com/repos/{repo}/releases/tags/{tag}"),
        proxy,
    )
    .await
}

/// What identifies a release for update checks: normally its tag.
///
/// BtbN's FFmpeg "latest" release is the exception — it is rebuilt in place
/// under the same `latest` tag every day, so comparing tags never saw an
/// update and the managed FFmpeg stayed at whatever was first installed. Its
/// name carries the build stamp ("Latest Auto-Build (2026-10-06 13:06)"),
/// which is also the dated tag the same build is published under
/// ("autobuild-2026-10-06-13-06").
fn build_id(name: &str, release: &GhRelease) -> String {
    if name != FFMPEG || release.tag_name != "latest" {
        return release.tag_name.clone();
    }
    let stamp = release
        .name
        .as_deref()
        .and_then(|n| n.rsplit_once('('))
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(stamp, _)| stamp.trim())
        .filter(|s| !s.is_empty());
    match (stamp, &release.published_at) {
        (Some(stamp), _) => format!("autobuild-{}", stamp.replace([' ', ':'], "-")),
        (None, Some(published)) => format!("latest-{published}"),
        (None, None) => release.tag_name.clone(),
    }
}

/// gallery-dl reports "1.32.9-dev:2026.07.28" — the part after the colon is
/// the build date, which is exactly what the build repo tags its releases
/// with, so that is what an update check can compare.
fn gallerydl_build(version: &str) -> Option<&str> {
    version.split_once(':').map(|(_, build)| build.trim())
}

/// Recent release tags of a component, newest first.
pub async fn list_versions(app: &AppHandle, name: &str) -> Result<Vec<String>, String> {
    let repo = component(name)?.release_repo;
    let releases: Vec<GhRelease> = fetch_json(
        &format!("https://api.github.com/repos/{repo}/releases?per_page=20"),
        &app_proxy(app),
    )
    .await?;
    Ok(releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .map(|r| r.tag_name)
        .collect())
}

/// Build id of the latest release, or None when the lookup fails (offline,
/// rate limited).
async fn latest_build_id(name: &str, proxy: &str) -> Option<String> {
    let repo = component(name).ok()?.release_repo;
    latest_release(repo, proxy).await.ok().map(|r| build_id(name, &r))
}

/// What can be learned about a component without the network.
struct LocalStatus {
    resolved: Option<(PathBuf, bool)>,
    current: Option<String>,
    previous: Option<String>,
    /// The build id recorded at install time (FFmpeg only).
    installed_build: Option<String>,
}

fn local_status(app: &AppHandle, name: &str) -> LocalStatus {
    let resolved = resolve(app, name);
    LocalStatus {
        current: resolved.as_ref().and_then(|(p, _)| installed_version(name, p)),
        previous: previous_exe(app, name).and_then(|p| installed_version(name, &p)),
        installed_build: (name == FFMPEG)
            .then(|| bin_dir(app).ok())
            .flatten()
            .and_then(|dir| std::fs::read_to_string(dir.join(FFMPEG_TAG_FILE)).ok())
            .map(|s| s.trim().to_string()),
        resolved,
    }
}

/// Whether the latest release is newer than what's installed, comparing in
/// whatever terms each component's versions and release tags share.
fn update_available(name: &str, local: &LocalStatus, latest: &str) -> bool {
    let managed = local.resolved.as_ref().is_some_and(|(_, m)| *m);
    let Some(current) = local.current.as_deref() else {
        return false;
    };
    match name {
        // Only meaningful for a managed install, where the build was recorded.
        FFMPEG => managed && local.installed_build.as_deref().is_some_and(|b| b != latest),
        GALLERYDL => gallerydl_build(current) != Some(latest.trim_start_matches('v')),
        DENO => current != latest.trim_start_matches('v'),
        _ => current != latest,
    }
}

pub async fn get_status(app: &AppHandle, check_latest: bool) -> Vec<BinaryStatus> {
    let proxy = app_proxy(app);

    // Everything at once: the release lookups, and the local version probes
    // on the blocking pool. One after another, the page waited for four GitHub
    // requests plus up to eight process spawns — and a cold `yt-dlp
    // --version` alone can take a second.
    let latest = futures_util::future::join_all(COMPONENTS.iter().map(|c| {
        let proxy = &proxy;
        async move {
            if check_latest {
                latest_build_id(c.name, proxy).await
            } else {
                None
            }
        }
    }));
    let local = futures_util::future::join_all(COMPONENTS.iter().map(|c| {
        let (app, name) = (app.clone(), c.name);
        tauri::async_runtime::spawn_blocking(move || local_status(&app, name))
    }));
    let (latest, local) = tokio::join!(latest, local);

    COMPONENTS
        .iter()
        .zip(latest)
        .zip(local)
        .filter_map(|((c, latest), local)| {
            let local = local.ok()?;
            Some(BinaryStatus {
                name: c.name.into(),
                repo_url: c.home_url.into(),
                releases_url: format!("https://github.com/{}/releases", c.release_repo),
                path: local
                    .resolved
                    .as_ref()
                    .map(|(p, _)| p.to_string_lossy().into_owned()),
                installed: local.resolved.is_some(),
                managed: local.resolved.as_ref().is_some_and(|(_, m)| *m),
                update_available: latest
                    .as_deref()
                    .is_some_and(|l| update_available(c.name, &local, l)),
                current_version: local.current.clone(),
                latest_version: latest,
                previous_version: local.previous,
            })
        })
        .collect()
}

fn emit_progress(app: &AppHandle, name: &str, phase: &str, downloaded: u64, total: u64, message: Option<String>) {
    let _ = app.emit(
        "binary-progress",
        &BinaryProgress {
            name: name.into(),
            phase: phase.into(),
            downloaded,
            total,
            message,
        },
    );
}

/// Stream a release asset to `dest`, reporting progress. A partial file never
/// outlives a failure — one left behind used to sit in the bin dir for good.
async fn download_to(app: &AppHandle, name: &str, asset: &GhAsset, dest: &Path) -> Result<(), String> {
    let result = stream_to_file(app, name, asset, dest).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

async fn stream_to_file(app: &AppHandle, name: &str, asset: &GhAsset, dest: &Path) -> Result<(), String> {
    let url = &asset.browser_download_url;
    let client = http_client(&app_proxy(app))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download of {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download of {url} failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(asset.size);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download of {url} failed: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() > Duration::from_millis(150) {
            last_emit = std::time::Instant::now();
            emit_progress(app, name, "downloading", downloaded, total, None);
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    if total > 0 && downloaded != total {
        return Err(format!(
            "download of {url} was cut short ({downloaded} of {total} bytes)"
        ));
    }
    Ok(())
}

pub async fn install(app: &AppHandle, name: &str, version: Option<&str>) -> Result<(), String> {
    let result = install_inner(app, name, version).await;
    match &result {
        Ok(()) => emit_progress(app, name, "done", 0, 0, None),
        Err(e) => emit_progress(app, name, "error", 0, 0, Some(e.clone())),
    }
    result
}

/// The asset a component installs from, for this platform.
fn pick_asset<'a>(name: &str, release: &'a GhRelease) -> Result<&'a GhAsset, String> {
    let find = |pred: &dyn Fn(&str) -> bool| release.assets.iter().find(|a| pred(&a.name));
    let asset = match name {
        YTDLP => find(&|n| n == YTDLP_ASSET),
        GALLERYDL => find(&|n| n == GALLERYDL_ASSET),
        DENO => find(&|n| n == DENO_ASSET),
        FFMPEG => find(&|n| n == "ffmpeg-master-latest-win64-gpl.zip")
            .or_else(|| find(&|n| n.contains("master") && n.ends_with("win64-gpl.zip")))
            .or_else(|| find(&|n| n.ends_with("win64-gpl.zip"))),
        other => return Err(format!("Unknown binary: {other}")),
    };
    asset.ok_or_else(|| {
        format!(
            "Release {} of {name} has no build for this platform",
            release.tag_name
        )
    })
}

/// Scratch files an interrupted install of `name` can leave in the bin dir —
/// both this version's names and the older `<name>.part` ones.
fn remove_leftovers(dir: &Path, name: &str) {
    let mut stale = vec![
        format!("{name}-download.part"),
        format!("{name}.part"),
        format!("{name}-download.zip"),
    ];
    for f in component_files(name) {
        stale.push(format!("{f}.new"));
        stale.push(format!("{f}.old"));
    }
    for f in stale {
        let _ = std::fs::remove_file(dir.join(f));
    }
}

async fn install_inner(app: &AppHandle, name: &str, version: Option<&str>) -> Result<(), String> {
    if cfg!(not(windows)) && name == FFMPEG {
        return Err(
            "Automatic FFmpeg install is only available on Windows. Install it with \
             Homebrew (`brew install ffmpeg`) — MediaFetch will detect it automatically."
                .to_string(),
        );
    }
    let repo = component(name)?.release_repo;
    let dir = bin_dir(app)?;
    remove_leftovers(&dir, name);

    let proxy = app_proxy(app);
    let release = match version {
        Some(tag) => release_by_tag(repo, tag, &proxy).await?,
        None => latest_release(repo, &proxy).await?,
    };
    let asset = pick_asset(name, &release)?;
    let download = dir.join(format!("{name}-download.part"));
    download_to(app, name, asset, &download).await?;

    // Only now that the new build is safely on disk does the current one move
    // to the rollback slot. Backing up first meant a failed download replaced
    // the rollback copy with the very version it was there to preserve.
    if let Err(e) = backup_current(app, name) {
        let _ = std::fs::remove_file(&download);
        return Err(e);
    }

    if asset.name.ends_with(".zip") {
        emit_progress(app, name, "extracting", 0, 0, None);
    }
    let placed = {
        let (download, dir, name, zipped) =
            (download.clone(), dir.clone(), name.to_string(), asset.name.ends_with(".zip"));
        tokio::task::spawn_blocking(move || place(&name, &download, &dir, zipped))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
    };
    let _ = std::fs::remove_file(&download);
    placed?;

    if name == FFMPEG {
        std::fs::write(dir.join(FFMPEG_TAG_FILE), build_id(name, &release))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move a downloaded build into place: a bare executable as-is, a zip by
/// extracting the component's executables from it.
fn place(name: &str, download: &Path, dir: &Path, zipped: bool) -> Result<(), String> {
    let exes: Vec<String> = component_files(name)
        .into_iter()
        .filter(|f| f.as_str() != FFMPEG_TAG_FILE)
        .collect();
    if zipped {
        extract_files(download, dir, &exes)?;
    } else {
        replace_file(download, &dir.join(&exes[0]))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for exe in &exes {
            let path = dir.join(exe);
            if path.is_file() {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Move `src` over `dest`. Windows refuses to overwrite an executable that is
/// running — a download still using yt-dlp or ffmpeg — but does allow
/// renaming it, so the running copy is moved aside first; it's cleaned up by
/// the next install (`remove_leftovers`).
fn replace_file(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    let mut aside = dest.as_os_str().to_owned();
    aside.push(".old");
    let aside = PathBuf::from(aside);
    let _ = std::fs::remove_file(&aside);
    if dest.exists() {
        std::fs::rename(dest, &aside).map_err(|e| {
            format!("Could not replace {} (is it in use?): {e}", dest.display())
        })?;
    }
    std::fs::rename(src, dest).map_err(|e| e.to_string())
}

/// Extract the named files from a zip into `dir`, wherever they sit inside
/// it. The first name is required; the rest (ffprobe) are taken if present.
fn extract_files(zip_path: &Path, dir: &Path, wanted: &[String]) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut found = vec![false; wanted.len()];
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.name().replace('\\', "/");
        let base = entry_name.rsplit('/').next().unwrap_or(&entry_name);
        let Some(slot) = wanted.iter().position(|w| w == base) else {
            continue;
        };
        if found[slot] {
            continue;
        }
        let dest = dir.join(&wanted[slot]);
        let mut staged = dest.as_os_str().to_owned();
        staged.push(".new");
        let staged = PathBuf::from(staged);
        {
            let mut out = std::fs::File::create(&staged).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        replace_file(&staged, &dest)?;
        found[slot] = true;
    }
    if !found[0] {
        return Err(format!("{} not found inside the downloaded archive", wanted[0]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, name: Option<&str>, published_at: Option<&str>) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            name: name.map(String::from),
            published_at: published_at.map(String::from),
            assets: Vec::new(),
            prerelease: false,
            draft: false,
        }
    }

    fn install_crypto_provider() {
        // What main() does first thing; reqwest is built without one.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn the_http_client_builds_once_a_crypto_provider_is_installed() {
        install_crypto_provider();
        assert!(http_client("").is_ok());
        assert!(http_client("socks5://127.0.0.1:1080").is_ok());
        assert!(http_client("not a proxy url").is_err());
    }

    /// Real network: run with `cargo test -- --ignored` to check TLS (OS
    /// root store via rustls-platform-verifier) and the release lookups end
    /// to end against GitHub.
    #[tokio::test]
    #[ignore = "needs network access"]
    async fn latest_releases_resolve_against_github() {
        install_crypto_provider();
        for c in &COMPONENTS {
            let id = latest_build_id(c.name, "").await;
            assert!(id.is_some(), "no latest release for {}", c.name);
            if c.name == FFMPEG {
                assert!(id.unwrap().starts_with("autobuild-"));
            }
        }
    }

    #[test]
    fn ffmpeg_latest_resolves_to_its_dated_build() {
        let r = release("latest", Some("Latest Auto-Build (2026-10-06 13:06)"), None);
        assert_eq!(build_id(FFMPEG, &r), "autobuild-2026-10-06-13-06");
    }

    #[test]
    fn ffmpeg_latest_without_a_stamp_falls_back_to_the_publish_time() {
        let r = release("latest", Some("Latest"), Some("2026-10-06T13:28:21Z"));
        assert_eq!(build_id(FFMPEG, &r), "latest-2026-10-06T13:28:21Z");
    }

    #[test]
    fn other_releases_are_identified_by_tag() {
        let r = release("2026.08.19", Some("yt-dlp 2026.08.19"), None);
        assert_eq!(build_id(YTDLP, &r), "2026.08.19");
        let r = release("autobuild-2026-10-05-13-07", Some("Auto-Build 2026-10-05 13:07"), None);
        assert_eq!(build_id(FFMPEG, &r), "autobuild-2026-10-05-13-07");
    }

    #[test]
    fn versions_are_reduced_to_what_release_tags_use() {
        assert_eq!(
            parse_version(DENO, "deno 2.9.7 (stable, release, x86_64-pc-windows-msvc)"),
            "2.9.7"
        );
        assert_eq!(
            parse_version(FFMPEG, "ffmpeg version N-125478-gc6498178bb-20260706 Copyright (c)"),
            "N-125478-gc6498178bb-20260706"
        );
        assert_eq!(parse_version(YTDLP, "2026.08.19"), "2026.08.19");
    }

    fn local(current: &str, managed: bool, build: Option<&str>) -> LocalStatus {
        LocalStatus {
            resolved: Some((PathBuf::from("x"), managed)),
            current: Some(current.into()),
            previous: None,
            installed_build: build.map(String::from),
        }
    }

    #[test]
    fn an_old_ffmpeg_latest_tag_now_reports_an_update() {
        // Installs made before build ids recorded the literal "latest".
        let l = local("N-1", true, Some("latest"));
        assert!(update_available(FFMPEG, &l, "autobuild-2026-10-06-13-06"));
        let l = local("N-1", true, Some("autobuild-2026-10-06-13-06"));
        assert!(!update_available(FFMPEG, &l, "autobuild-2026-10-06-13-06"));
    }

    #[test]
    fn an_unmanaged_ffmpeg_is_never_offered_an_update() {
        let l = local("N-1", false, None);
        assert!(!update_available(FFMPEG, &l, "autobuild-2026-10-06-13-06"));
    }

    #[test]
    fn gallery_dl_and_deno_compare_against_their_tag_formats() {
        assert!(!update_available(GALLERYDL, &local("1.32.9-dev:2026.10.06", true, None), "2026.10.06"));
        assert!(update_available(GALLERYDL, &local("1.32.9-dev:2026.07.28", true, None), "2026.10.06"));
        assert!(!update_available(DENO, &local("2.9.7", true, None), "v2.9.7"));
        assert!(update_available(DENO, &local("2.9.6", true, None), "v2.9.7"));
    }
}
