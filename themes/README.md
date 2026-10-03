# MediaFetch themes

A theme is a JSON file that sets MediaFetch's CSS color tokens. Browse the
built-in gallery from Settings → Appearance → Community to try these before
you write your own.

## Format

```json
{
  "format": 1,
  "id": "midnight-teal",
  "name": "Midnight Teal",
  "author": "your-github-username",
  "base": "dark",
  "radius": "0.75rem",
  "colors": {
    "background": "200 30% 6%",
    "foreground": "180 20% 94%",
    "card": "...",
    "card-foreground": "...",
    "popover": "...",
    "popover-foreground": "...",
    "primary": "...",
    "primary-foreground": "...",
    "secondary": "...",
    "secondary-foreground": "...",
    "muted": "...",
    "muted-foreground": "...",
    "accent": "...",
    "accent-foreground": "...",
    "destructive": "...",
    "destructive-foreground": "...",
    "success": "...",
    "success-foreground": "...",
    "border": "...",
    "input": "...",
    "ring": "..."
  }
}
```

- `id` — lowercase letters, digits and hyphens only; it's also the filename
  (`<id>.json`).
- `base` — `"dark"` or `"light"`. Decides which built-in look a missing color
  key falls back to.
- `radius` — optional corner radius, e.g. `"0.75rem"`. Matches
  `^\d(\.\d+)?rem$`, at most `5rem`.
- Every color is an HSL triple **without** the `hsl(...)` wrapper —
  `"<hue> <saturation>% <lightness>%"`, e.g. `"346 77% 50%"`. Matches
  `^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$`, with the hue clamped
  to 0–360 and both percentages to 0–100.
- You don't have to set every key — a missing one falls back to the `base`
  palette. At minimum, set `background`, `foreground`, `card`, `primary` and
  `border` to get something that looks intentional.

Anything outside this (an unknown key, a non-HSL value, raw CSS) is rejected
— both when MediaFetch loads a theme from disk and in CI below.

## Making one

The easiest way is **Settings → Appearance → Create theme** inside the app:
it starts from your current theme, gives you a color picker per token, and
previews live while you edit. **Export** writes the JSON file this README
describes.

## Submitting it here

From the theme's card in Settings → Appearance, **Share to MediaFetch**
opens a prefilled "create file" page on GitHub for `themes/<id>.json` and
walks you through opening a pull request (GitHub forks the repo for you if
you don't have push access). If the generated link would be too long, the
JSON is copied to your clipboard instead — paste it into a new file under
`themes/` yourself.

Also update `themes/index.json` with `{ "id", "name", "author", "file" }` for
your theme — CI checks it's in sync and that your theme file validates.

## Local check

```sh
node themes/validate.mjs
```
