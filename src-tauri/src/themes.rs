//! Custom themes: validated bundles of CSS-variable colors a user can apply,
//! save, import/export, or share to the project's `themes/` folder on GitHub.
//! Themes come from strangers, so every value is validated before it ever
//! reaches a `<style>` rule — see `validate` and `COLOR_KEYS`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The exact CSS variables a theme may set — mirrors src/index.css. Anything
/// else in a theme file's `colors` map is rejected outright.
pub const COLOR_KEYS: [&str; 21] = [
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "destructive-foreground",
    "success",
    "success-foreground",
    "border",
    "input",
    "ring",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub format: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub author: Option<String>,
    pub base: String, // "dark" | "light"
    #[serde(default)]
    pub radius: Option<String>,
    pub colors: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityTheme {
    pub id: String,
    pub name: String,
    pub file: String,
}

/// `"<num> <num>% <num>%"` (hue, saturation %, lightness %) — the exact shape
/// an HSL CSS custom property takes in this codebase, e.g. "346 77% 50%".
fn is_valid_hsl(value: &str) -> bool {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 3 {
        return false;
    }
    let hue_ok = parts[0].parse::<f64>().map(|h| (0.0..=360.0).contains(&h)).unwrap_or(false);
    let pct_ok = |s: &str| {
        s.strip_suffix('%')
            .and_then(|n| n.parse::<f64>().ok())
            .map(|v| (0.0..=100.0).contains(&v))
            .unwrap_or(false)
    };
    hue_ok && pct_ok(parts[1]) && pct_ok(parts[2])
}

fn is_valid_radius(value: &str) -> bool {
    value
        .strip_suffix("rem")
        .and_then(|n| n.parse::<f64>().ok())
        .map(|v| (0.0..=5.0).contains(&v))
        .unwrap_or(false)
}

/// Validate a theme loaded from disk or a remote source: never trust
/// anything that was ever a stranger's file. Rejects an unknown color key,
/// a malformed value, a bad radius, or a base other than dark/light — never
/// injects raw CSS, only known custom-property values.
pub fn validate(theme: &Theme) -> Result<(), String> {
    if theme.format != 1 {
        return Err(format!("Unsupported theme format: {}", theme.format));
    }
    if theme.id.trim().is_empty() || !theme.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Theme id must be lowercase letters, digits and hyphens only".into());
    }
    if theme.name.trim().is_empty() {
        return Err("Theme name is required".into());
    }
    if theme.base != "dark" && theme.base != "light" {
        return Err("Theme base must be \"dark\" or \"light\"".into());
    }
    if let Some(radius) = &theme.radius {
        if !is_valid_radius(radius) {
            return Err(format!("Invalid radius: {radius}"));
        }
    }
    for (key, value) in &theme.colors {
        if !COLOR_KEYS.contains(&key.as_str()) {
            return Err(format!("Unknown color key: {key}"));
        }
        if !is_valid_hsl(value) {
            return Err(format!("Invalid color value for {key}: {value}"));
        }
    }
    Ok(())
}

fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn slug_ok(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[tauri::command]
pub fn list_themes(app: AppHandle) -> Result<Vec<Theme>, String> {
    let dir = themes_dir(&app)?;
    let mut themes = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(theme) = serde_json::from_str::<Theme>(&text) {
                if validate(&theme).is_ok() {
                    themes.push(theme);
                }
            }
        }
    }
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(themes)
}

#[tauri::command]
pub fn save_theme(app: AppHandle, theme: Theme) -> Result<(), String> {
    validate(&theme)?;
    if !slug_ok(&theme.id) {
        return Err("Theme id must be lowercase letters, digits and hyphens only".into());
    }
    let path = themes_dir(&app)?.join(format!("{}.json", theme.id));
    let json = serde_json::to_string_pretty(&theme).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_theme(app: AppHandle, id: String) -> Result<(), String> {
    if !slug_ok(&id) {
        return Err("Invalid theme id".into());
    }
    let path = themes_dir(&app)?.join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn import_theme(app: AppHandle, path: String) -> Result<Theme, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 1024 * 1024 {
        return Err("That file is larger than 1 MB — it doesn't look like a theme.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let theme: Theme = serde_json::from_str(&text).map_err(|e| format!("Not a theme file: {e}"))?;
    validate(&theme)?;
    save_theme(app, theme.clone())?;
    Ok(theme)
}

#[tauri::command]
pub fn export_theme(app: AppHandle, id: String, path: String) -> Result<(), String> {
    if !slug_ok(&id) {
        return Err("Invalid theme id".into());
    }
    let src = themes_dir(&app)?.join(format!("{id}.json"));
    let text = std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
    let theme: Theme = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    validate(&theme)?;
    std::fs::write(path, serde_json::to_string_pretty(&theme).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

const COMMUNITY_INDEX_URL: &str =
    "https://raw.githubusercontent.com/sergioalexo/mediafetch/main/themes/index.json";

/// Fetch the community theme catalog (index + each listed file), validating
/// every one before it's handed to the frontend. Offline or a bad response
/// fails gracefully with an empty-ish error the UI can show as "couldn't
/// reach the theme gallery" rather than crashing.
#[tauri::command]
pub async fn fetch_community_themes(app: AppHandle) -> Result<Vec<Theme>, String> {
    let proxy = crate::binaries::app_proxy(&app);
    let index_text = crate::binaries::http_client(&proxy)?
        .get(COMMUNITY_INDEX_URL)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the theme gallery: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Couldn't reach the theme gallery: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let entries: Vec<CommunityTheme> =
        serde_json::from_str(&index_text).map_err(|e| e.to_string())?;

    let mut themes = Vec::new();
    for entry in entries {
        let url = format!(
            "https://raw.githubusercontent.com/sergioalexo/mediafetch/main/themes/{}",
            entry.file
        );
        let Ok(client) = crate::binaries::http_client(&proxy) else { continue };
        let Ok(resp) = client.get(&url).timeout(std::time::Duration::from_secs(10)).send().await
        else {
            continue;
        };
        let Ok(text) = resp.text().await else { continue };
        let Ok(theme) = serde_json::from_str::<Theme>(&text) else { continue };
        if validate(&theme).is_ok() {
            themes.push(theme);
        }
    }
    Ok(themes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_theme() -> Theme {
        let mut colors = std::collections::BTreeMap::new();
        colors.insert("background".to_string(), "200 30% 6%".to_string());
        colors.insert("primary".to_string(), "180 70% 50%".to_string());
        Theme {
            format: 1,
            id: "midnight-teal".into(),
            name: "Midnight Teal".into(),
            author: Some("tester".into()),
            base: "dark".into(),
            radius: Some("0.75rem".into()),
            colors,
        }
    }

    #[test]
    fn a_well_formed_theme_validates() {
        assert!(validate(&base_theme()).is_ok());
    }

    #[test]
    fn rejects_an_unknown_color_key() {
        let mut theme = base_theme();
        theme.colors.insert("background-image".into(), "url(javascript:alert(1))".into());
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_a_non_hsl_value() {
        let mut theme = base_theme();
        theme.colors.insert("primary".into(), "red".into());
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_raw_css_injection_attempts() {
        let mut theme = base_theme();
        theme
            .colors
            .insert("primary".into(), "0 0% 0%; } body { display: none".into());
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_an_out_of_range_hue_or_percentage() {
        let mut theme = base_theme();
        theme.colors.insert("primary".into(), "400 50% 50%".into());
        assert!(validate(&theme).is_err());
        theme.colors.insert("primary".into(), "200 150% 50%".into());
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_an_unknown_base() {
        let mut theme = base_theme();
        theme.base = "sepia".into();
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_a_bad_radius() {
        let mut theme = base_theme();
        theme.radius = Some("1.5em".into());
        assert!(validate(&theme).is_err());
        theme.radius = Some("-1rem".into());
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_an_unsupported_format_version() {
        let mut theme = base_theme();
        theme.format = 2;
        assert!(validate(&theme).is_err());
    }

    #[test]
    fn rejects_a_malformed_id() {
        let mut theme = base_theme();
        theme.id = "../../etc/passwd".into();
        assert!(validate(&theme).is_err());
        assert!(!slug_ok(&theme.id));
    }
}
