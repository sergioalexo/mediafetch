#!/usr/bin/env node
// Validates every theme file in themes/ against the same rules the app
// itself enforces (src-tauri/src/themes.rs::validate, src/lib/theme.ts),
// and checks that themes/index.json lists exactly the theme files present.
// Run from the repo root: `node themes/validate.mjs`.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const THEMES_DIR = dirname(fileURLToPath(import.meta.url));

const COLOR_KEYS = [
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

const HSL_RE = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/;
const RADIUS_RE = /^\d(\.\d+)?rem$/;

function isValidHsl(value) {
  if (typeof value !== "string" || !HSL_RE.test(value)) return false;
  const [h, s, l] = value.split(" ");
  const hue = parseFloat(h);
  const pct = (v) => parseFloat(v.replace("%", ""));
  return hue >= 0 && hue <= 360 && pct(s) <= 100 && pct(l) <= 100;
}

function isValidRadius(value) {
  return typeof value === "string" && RADIUS_RE.test(value) && parseFloat(value) <= 5;
}

function validateTheme(theme, file) {
  const errors = [];
  if (theme.format !== 1) errors.push(`${file}: unsupported format ${theme.format}`);
  if (typeof theme.id !== "string" || !/^[a-z0-9-]+$/i.test(theme.id)) {
    errors.push(`${file}: invalid id "${theme.id}"`);
  }
  if (`${theme.id}.json` !== file) {
    errors.push(`${file}: id "${theme.id}" doesn't match filename`);
  }
  if (typeof theme.name !== "string" || !theme.name.trim()) {
    errors.push(`${file}: missing name`);
  }
  if (theme.base !== "dark" && theme.base !== "light") {
    errors.push(`${file}: base must be "dark" or "light", got "${theme.base}"`);
  }
  if (theme.radius != null && !isValidRadius(theme.radius)) {
    errors.push(`${file}: invalid radius "${theme.radius}"`);
  }
  if (typeof theme.colors !== "object" || theme.colors === null) {
    errors.push(`${file}: colors must be an object`);
  } else {
    for (const [key, value] of Object.entries(theme.colors)) {
      if (!COLOR_KEYS.includes(key)) errors.push(`${file}: unknown color key "${key}"`);
      else if (!isValidHsl(value)) errors.push(`${file}: invalid value for ${key}: "${value}"`);
    }
  }
  return errors;
}

function main() {
  const files = readdirSync(THEMES_DIR).filter(
    (f) => f.endsWith(".json") && f !== "index.json"
  );
  const errors = [];

  for (const file of files) {
    let theme;
    try {
      theme = JSON.parse(readFileSync(join(THEMES_DIR, file), "utf8"));
    } catch (e) {
      errors.push(`${file}: invalid JSON (${e.message})`);
      continue;
    }
    errors.push(...validateTheme(theme, file));
  }

  const index = JSON.parse(readFileSync(join(THEMES_DIR, "index.json"), "utf8"));
  const indexFiles = new Set(index.map((e) => e.file));
  const themeFiles = new Set(files);
  for (const f of themeFiles) {
    if (!indexFiles.has(f)) errors.push(`index.json is missing an entry for ${f}`);
  }
  for (const f of indexFiles) {
    if (!themeFiles.has(f)) errors.push(`index.json lists ${f}, which doesn't exist`);
  }

  if (errors.length > 0) {
    console.error("Theme validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
  console.log(`All ${files.length} theme(s) and index.json are valid.`);
}

main();
