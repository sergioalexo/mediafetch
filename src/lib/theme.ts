// Custom theme type, validation (mirrors src-tauri/src/themes.rs::validate
// — keep the two in lockstep) and hex<->HSL conversion for the theme editor.
// Themes may come from strangers (import, the community gallery), so every
// value is checked against this whitelist before it's ever applied as a CSS
// custom property.

/** The exact CSS variables a theme may set — mirrors src/index.css. */
export const THEME_COLOR_KEYS = [
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
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

export interface Theme {
  format: number;
  id: string;
  name: string;
  author?: string | null;
  base: "dark" | "light";
  radius?: string | null;
  colors: Partial<Record<ThemeColorKey, string>>;
}

const HSL_RE = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/;
const RADIUS_RE = /^\d(\.\d+)?rem$/;

function hueInRange(value: string): boolean {
  const hue = parseFloat(value.split(/\s+/)[0]);
  return hue >= 0 && hue <= 360;
}

function percentsInRange(value: string): boolean {
  const pcts = value.match(/(\d+(\.\d+)?)%/g) ?? [];
  return pcts.every((p) => parseFloat(p) <= 100);
}

export function isValidHsl(value: string): boolean {
  return HSL_RE.test(value) && hueInRange(value) && percentsInRange(value);
}

export function isValidRadius(value: string): boolean {
  if (!RADIUS_RE.test(value)) return false;
  return parseFloat(value) <= 5;
}

/** Validate a theme from disk, an import, or the community gallery. Never
 * trust the input: reject an unknown key, a malformed value, a bad radius,
 * or an id/base that isn't well-formed. Never returns something that could
 * be used to inject raw CSS — only known custom-property values. */
export function validateTheme(theme: unknown): { ok: true; theme: Theme } | { ok: false; error: string } {
  if (typeof theme !== "object" || theme === null) {
    return { ok: false, error: "Not a theme object" };
  }
  const t = theme as Record<string, unknown>;
  if (t.format !== 1) return { ok: false, error: `Unsupported theme format: ${t.format}` };
  if (typeof t.id !== "string" || !/^[a-z0-9-]+$/i.test(t.id)) {
    return { ok: false, error: "Theme id must be lowercase letters, digits and hyphens only" };
  }
  if (typeof t.name !== "string" || !t.name.trim()) {
    return { ok: false, error: "Theme name is required" };
  }
  if (t.base !== "dark" && t.base !== "light") {
    return { ok: false, error: 'Theme base must be "dark" or "light"' };
  }
  if (t.radius != null) {
    if (typeof t.radius !== "string" || !isValidRadius(t.radius)) {
      return { ok: false, error: `Invalid radius: ${String(t.radius)}` };
    }
  }
  const colors = t.colors;
  if (typeof colors !== "object" || colors === null) {
    return { ok: false, error: "colors must be an object" };
  }
  const safeColors: Partial<Record<ThemeColorKey, string>> = {};
  for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
    if (!THEME_COLOR_KEYS.includes(key as ThemeColorKey)) {
      return { ok: false, error: `Unknown color key: ${key}` };
    }
    if (typeof value !== "string" || !isValidHsl(value)) {
      return { ok: false, error: `Invalid color value for ${key}: ${String(value)}` };
    }
    safeColors[key as ThemeColorKey] = value;
  }
  return {
    ok: true,
    theme: {
      format: 1,
      id: t.id,
      name: t.name,
      author: typeof t.author === "string" ? t.author : null,
      base: t.base,
      radius: typeof t.radius === "string" ? t.radius : null,
      colors: safeColors,
    },
  };
}

/** #rrggbb -> "h s% l%" (no "hsl(...)" wrapper — that's the raw custom-property form this app stores). */
export function hexToHsl(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "0 0% 0%";
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** "h s% l%" -> #rrggbb. */
export function hslToHex(hsl: string): string {
  const parts = hsl.trim().split(/\s+/);
  const h = parseFloat(parts[0] ?? "0");
  const s = parseFloat((parts[1] ?? "0%").replace("%", "")) / 100;
  const l = parseFloat((parts[2] ?? "0%").replace("%", "")) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Apply (or clear) a custom theme's CSS variables on the document root. */
export function applyCustomTheme(theme: Theme | null) {
  const root = document.documentElement;
  if (!theme) {
    for (const key of THEME_COLOR_KEYS) root.style.removeProperty(`--${key}`);
    root.style.removeProperty("--radius");
    return;
  }
  root.classList.toggle("dark", theme.base === "dark");
  for (const key of THEME_COLOR_KEYS) {
    const value = theme.colors[key];
    if (value) root.style.setProperty(`--${key}`, value);
    else root.style.removeProperty(`--${key}`);
  }
  if (theme.radius) root.style.setProperty("--radius", theme.radius);
  else root.style.removeProperty("--radius");
}

export const CUSTOM_THEME_PREFIX = "custom:";

export function customThemeId(theme: string): string | null {
  return theme.startsWith(CUSTOM_THEME_PREFIX) ? theme.slice(CUSTOM_THEME_PREFIX.length) : null;
}
