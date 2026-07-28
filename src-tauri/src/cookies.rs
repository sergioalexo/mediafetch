//! Cookie-source diagnostics — answers "are my cookies actually reaching
//! yt-dlp?", which is otherwise invisible until a download fails.

use serde::Serialize;
use tauri::AppHandle;

use crate::binaries;
use crate::settings::Settings;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieCheck {
    /// "browser" | "file" | "none"
    pub source: String,
    /// Browser name or file path, for display.
    pub detail: String,
    pub ok: bool,
    /// Cookies the source yielded, when we could count them.
    pub count: Option<u32>,
    /// One-line outcome, ready to show.
    pub message: String,
    /// What to do about it, when there is something to do.
    pub hint: Option<String>,
}

/// A URL that makes yt-dlp build its cookie jar and then stop. Cookies are
/// extracted before the URL is fetched, and file:// is refused outright
/// without a security opt-in — so the probe reads the browser's cookie
/// database without sending a single request anywhere.
const PROBE_URL: &str = "file:///mediafetch-cookie-check";

pub async fn check(app: &AppHandle, settings: &Settings) -> CookieCheck {
    if !settings.cookies_file.trim().is_empty() {
        return check_file(&settings.cookies_file);
    }
    if !settings.cookies_from_browser.trim().is_empty() {
        return check_browser(app, settings.cookies_from_browser.trim()).await;
    }
    CookieCheck {
        source: "none".into(),
        detail: String::new(),
        ok: false,
        count: None,
        message: "No cookie source is set.".into(),
        hint: Some(
            "Sites that require a sign-in (Instagram profiles and posts, private or \
             age-restricted videos) need cookies. Pick a browser you're logged in with, \
             or select a cookies.txt file."
                .into(),
        ),
    }
}

/// Count the entries in a Netscape-format cookies.txt.
fn check_file(path: &str) -> CookieCheck {
    let mut check = CookieCheck {
        source: "file".into(),
        detail: path.to_string(),
        ok: false,
        count: None,
        message: String::new(),
        hint: None,
    };

    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            check.message = format!("Can't read the cookies file: {e}");
            check.hint = Some("Pick the file again — it may have been moved or deleted.".into());
            return check;
        }
    };

    // Netscape format: one cookie per line, seven tab-separated fields.
    // Comment lines start with '#' ("#HttpOnly_" is a real cookie, though).
    let count = text
        .lines()
        .filter(|l| {
            let l = l.trim();
            !l.is_empty()
                && (!l.starts_with('#') || l.starts_with("#HttpOnly_"))
                && l.split('\t').count() >= 7
        })
        .count() as u32;

    check.count = Some(count);
    if count > 0 {
        check.ok = true;
        check.message = format!("{count} cookies loaded from the file.");
    } else {
        check.message = "The file holds no cookies in Netscape format.".into();
        check.hint = Some(
            "Export it again with a cookies.txt browser extension, making sure you're \
             signed in to the site at the time."
                .into(),
        );
    }
    check
}

async fn check_browser(app: &AppHandle, browser: &str) -> CookieCheck {
    let mut check = CookieCheck {
        source: "browser".into(),
        detail: browser.to_string(),
        ok: false,
        count: None,
        message: String::new(),
        hint: None,
    };

    let ytdlp = match binaries::ytdlp_path(app) {
        Ok(p) => p,
        Err(e) => {
            check.message = e;
            return check;
        }
    };

    let mut cmd = tokio::process::Command::new(&ytdlp);
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.args([
        "--cookies-from-browser",
        browser,
        "--simulate",
        "--no-progress",
        "--encoding",
        "utf-8",
        "--",
        PROBE_URL,
    ]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(binaries::CREATE_NO_WINDOW);
    }

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            check.message = format!("Couldn't run yt-dlp: {e}");
            return check;
        }
    };
    // The probe URL always errors at the end; only the cookie stage matters.
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let pretty = pretty_browser(browser);

    if let Some(count) = extracted_count(&text) {
        check.count = Some(count);
        check.ok = count > 0;
        check.message = if count > 0 {
            format!("{count} cookies read from {pretty}.")
        } else {
            format!("{pretty} returned no cookies.")
        };
        if count == 0 {
            check.hint = Some(format!(
                "Sign in to the site in {pretty} first, then test again."
            ));
        } else if text.contains("could not be decrypted") {
            check.hint =
                Some("Some cookies couldn't be decrypted; sign-in may still fail.".into());
        }
        return check;
    }

    // Extraction failed outright — the reason decides what the user can do.
    check.message = format!("Couldn't read cookies from {pretty}.");
    check.hint = Some(if text.contains("Could not copy") && text.contains("cookie database") {
        format!(
            "{pretty} is running and holds its cookie database locked. Close it completely \
             — including anything left in the system tray or background — then test again."
        )
    } else if text.contains("Failed to decrypt with DPAPI") {
        format!(
            "Windows blocks reading cookies from {pretty}: Chrome-based browsers (Chrome 127 \
             and newer, and the Brave/Edge builds on the same base) encrypt them so only the \
             browser itself can open them. Use Firefox instead, or export a cookies.txt file \
             with a browser extension and select it below."
        )
    } else if text.contains("could not find") {
        format!("No {pretty} profile found on this computer.")
    } else {
        let detail = text
            .lines()
            .find(|l| l.contains("ERROR"))
            .unwrap_or("yt-dlp gave no reason")
            .trim()
            .to_string();
        detail
    });
    check
}

/// "Extracted 715 cookies from firefox" -> 715
fn extracted_count(text: &str) -> Option<u32> {
    let idx = text.find("Extracted ")?;
    text[idx + "Extracted ".len()..]
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn pretty_browser(browser: &str) -> String {
    match browser {
        "chrome" => "Chrome".into(),
        "firefox" => "Firefox".into(),
        "edge" => "Edge".into(),
        "brave" => "Brave".into(),
        "opera" => "Opera".into(),
        "vivaldi" => "Vivaldi".into(),
        other => other.to_string(),
    }
}
