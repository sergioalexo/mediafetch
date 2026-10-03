# MediaFetch v0.3.0 — implementation plan

Written for an implementing agent (Sonnet). Work phase by phase, in order; each phase is one commit
(or a few) and must pass the checks at the bottom before you move on. File paths are relative to the
repo root. All new UI strings go into **all three** dictionaries in `src/lib/i18n.tsx` (`en`, `uk`, `ru`);
the `Record<MsgKey, string>` typing will fail the build if one is missing.

Stack reminder: Tauri 2 (Rust, `src-tauri/src`), React 18 + Zustand (`src/lib/store.ts`), Tailwind 3 +
shadcn/ui, Framer Motion. Backend events: `queue-changed` (full queue snapshot), `task-progress`
(one task, throttled to 250 ms per task), `history-added`, `binary-progress`.

---

## Phase 1 — History correctness: never count failures, really remember downloads

**Problems found in the code**

1. `finish_history` (`src-tauri/src/downloader.rs` ~L1340) uses `task.id` as the history id. A task that
   fails, then is retried by hand and succeeds, writes **two entries with the same id** (one failed, one
   completed). `remove_history_entry` then deletes both, and the failed one keeps showing.
2. Success is decided only by `exit.success()` (~L1092). yt-dlp can exit 0 without producing a file
   (e.g. "has already been recorded in the archive", or a skipped/unavailable item) and that is recorded
   as `completed`.
3. `history.rs` caps the file at `MAX_ENTRIES = 2000`, and failed entries take up slots. A few big
   playlists push older successful downloads out, so the app "forgets" them.
4. `isAlreadyDownloaded` (`src/lib/presets.ts`) matches by exact URL or `h.url.includes(id)`. A track
   downloaded from `music.youtube.com/watch?v=X` isn't recognized when it shows up as
   `youtube.com/watch?v=X&list=…`. It's also O(history × entries) on every analysis.
5. The History page header (`h.recorded`) counts failed entries as "recorded".

**Changes**

- `src-tauri/src/types.rs` + `src/lib/types.ts` → `HistoryEntry` gets two new optional fields
  (`#[serde(default)]`, so old files still load):
  - `mediaKey: Option<String>`, a canonical `"<extractor_key>:<id>"`, e.g. `"Youtube:dQw4w9WgXcQ"`
  - `source: Option<String>`: `"local"` | `"imported"`
- Capture the media key and final path from yt-dlp itself: add
  `--print "after_move:MFDONE|%(extractor_key)s|%(id)s|%(filepath)s"` in `build_args`, parse `MFDONE|`
  lines in the stdout loop the same way `MFPROG|` is parsed, and store them on the task (new
  `media_key` field on `DownloadTask`, `#[serde(default)]`). Keep `--print` from muting progress
  output; yt-dlp's `--print` implies `--quiet` unless `--no-quiet` is passed, so check that `--no-quiet`
  (or `--progress`) is already in the args and add it if not.
- Success rule: mark `Completed` only if exit is 0 **and** (at least one `MFDONE` line was seen **or** the
  output file exists). For gallery-dl keep today's per-file counting. If exit is 0 and nothing was
  produced, check the log for "already been recorded in the archive" / "has already been downloaded":
  that counts as completed with `alreadyHad = true` and **no new history entry**. Anything else counts
  as `Failed` with the error "yt-dlp finished without producing a file".
- `history.rs::add`: when the new entry is `completed`, first remove any existing entry with the same
  `id` **or** the same `mediaKey` that has `status == "failed"`, so a later success replaces the failure.
- Retention: failed entries are capped separately (keep the newest 500 failed). Completed entries are
  effectively unlimited (cap at 100 000 as a safety valve). See Phase 3 for the storage format change
  that makes this cheap.
- Frontend: replace `isAlreadyDownloaded` with a memoized index built once per history change:
  `downloadedIndex = { keys: Set<mediaKey>, urls: Set<normalizedUrl>, ids: Set<videoId> }` from
  **completed entries only**. Add `normalizeUrl()` / `extractMediaId()` in `src/lib/utils.ts`
  (YouTube/YT Music `v=` / `youtu.be/` / `shorts/`, SoundCloud path) so lookups are O(1). Playlist
  entries already carry `entry.id` from analysis. Match on that first.
- Show an "Already downloaded" badge on playlist rows in the draft card (`WorkspacePage.tsx`, the
  entries list ~L643), and keep those rows unticked by default (current behavior, now reliable).
- History page: header shows `"{completed} downloaded · {failed} failed"`. Add a filter chip row:
  All / Downloaded / Failed. Failed rows get a "Retry" button that re-enqueues the URL.
- Stats page already separates the two. Leave it.

## Phase 2 — Back up and import download history (merge, never replace)

- Rust (`src-tauri/src/history.rs` + commands registered in `main.rs`):
  - `export_history(path: String) -> Result<usize, String>` writes
    `{ "app": "MediaFetch", "format": 1, "exportedAt": <unix>, "entries": [...], "archive": [<lines of download-archive.txt>] }`
    (include `archive` only if that file exists).
  - `import_history(path: String) -> Result<ImportReport, String>` with `ImportReport { added, skipped, archiveAdded }`.
    Accept **both** the export format above **and** a bare `HistoryEntry[]` array (a raw `history.json`
    copied from another PC). Merge rules, under `HISTORY_LOCK`:
    - skip if an entry with the same `id` exists
    - skip if the incoming entry is completed and an existing completed entry has the same `mediaKey`
      (or, when either lacks a key, the same normalized URL)
    - a completed import replaces an existing *failed* entry for the same media (same rule as Phase 1)
    - mark added entries `source: "imported"`, then sort all entries by `downloadedAt` desc and apply the
      retention caps
    - archive lines are merged as a set into `download-archive.txt` in the download dir
  - After import, emit `history-replaced` with the full list (the frontend replaces `history` in the store).
- Frontend: `src/lib/api.ts` wrappers; buttons **Back up history…** and **Import history…** on the History
  page header and in Settings → Data. Use `@tauri-apps/plugin-dialog` `save()` / `open()` with a
  `*.mediafetch-history.json` filter and a default name `mediafetch-history-YYYY-MM-DD.json`. Toast
  afterwards: "Imported 214 downloads, skipped 37 already in your history".
- Validate input: reject files over 50 MB, entries missing `url`/`status`, unknown `status` values.
  Never trust `filename` from an import for "Open file" unless the file exists.

## Phase 3 — Performance with 300+ item playlists, and queue ordering

**Why it glitches today**

- Every `task-progress` event (≈4/s per active task) runs `queue.map(...)` and re-renders the **whole**
  `WorkspacePage`. That page subscribes to `queue`, rebuilds `rendered`/`filteredRendered`/`totalEta`,
  and renders every `QueueItem` (each a `motion.div`).
- `TaskGroup` (`WorkspacePage.tsx` ~L678) does `queue.filter` + `queue.indexOf` per task, which is O(n²)
  per render. Same for `queue.indexOf(row.task!)` in the main list.
- `queue-changed` sends the entire queue (300+ tasks with full `options`) on every status change.
- The draft card renders all 300 playlist rows with checkboxes and thumbnails at once.
- The speed sampler `setInterval` writes to the store every second even when idle, re-rendering
  subscribers of the whole state.

**Changes**

1. **Normalize the queue in the store**: `taskIds: string[]` (backend order) + `tasks: Record<id, DownloadTask>`.
   `task-progress` updates only `tasks[id]`. Components select narrowly:
   `useApp(s => s.tasks[id])` inside `QueueItem`, and use `useShallow` from `zustand/react/shallow`
   for array selections. Keep `queue` as a derived selector for the few places that need the whole list.
2. **Batch progress events**: buffer incoming `task-progress` payloads in a `Map<id, task>` and flush once
   per `requestAnimationFrame` (or 100 ms), the same pattern already used for `app-log`.
3. **`React.memo` on `QueueItem`** with props reduced to `id` (+ stable callbacks). Remove per-item
   `motion.div` layout animations from queue rows; keep a cheap CSS fade-in only. Keep Framer Motion for
   page transitions and dialogs only.
4. **Virtualize long lists** with `@tanstack/react-virtual`: the queue list, the playlist entries inside
   a draft card, and the History page. Use a fixed or measured row height; the scroll container is
   `<main className="overflow-y-auto">` in `App.tsx`, so pass that element as the scroll parent (or give
   the list its own scroll box with a max height).
5. **Precompute groups** once per `taskIds`/status change: `Map<groupId, string[]>` plus an index map
   `id → position`, replacing every `filter`/`indexOf` in render.
6. **Backend**: in `emit_queue`, debounce to at most one `queue-changed` per 150 ms (coalesce bursts
   such as enqueueing 300 items, or "clear finished"). Keep `task-progress` at 250 ms, but skip the emit
   if nothing changed.
7. **Speed sampler**: only append a sample while something is downloading. Pause the interval when the
   queue is idle.
8. **History storage**: switch `history.json` (whole-file rewrite on every completion) to append-only
   `history.jsonl`, one entry per line. Remove, clear, and import rewrite the file atomically via the
   existing tmp-file-and-rename method. On first load, migrate `history.json` → `history.jsonl` and keep
   `history.json.bak`.
9. Analysis of big playlists: confirm `analyze_url` uses `--flat-playlist` (it should, since only entries
   are needed). If thumbnails per entry are loaded eagerly, add `loading="lazy"` and `decoding="async"`
   to `<img>`.

**Queue ordering ("downloading at the top, finished at the bottom")**

Display order only. The backend `taskIds` order still decides what starts next. In the memoized row
builder in `WorkspacePage.tsx`, sort rows by a status rank, stable within a rank:

| rank | status |
|---|---|
| 0 | `downloading`, `postprocessing` |
| 1 | `queued` |
| 2 | `paused` |
| 3 | `failed`, `cancelled` |
| 4 | `completed` |

- A playlist **group** ranks by its best member (any active → 0). Inside an expanded group, apply the
  same sort, and show a header summary: `12 / 300 done · 2 downloading · 1 failed` plus an aggregate
  progress bar.
- Active rows always show the progress bar, speed, and ETA (already in `QueueItem`). Make sure
  `postprocessing` shows an indeterminate bar labelled "Converting…".
- Drag-to-reorder stays limited to rank-1 (`queued`) rows, and maps the drop back to an index in the
  backend order.
- Add a small "Completed (N)" collapsible divider before rank 4, collapsed by default when N > 20.

## Phase 4 — Audio defaults: MP3 320 for YouTube Music & SoundCloud, sample rate

**MP3 320 by default**

- `src-tauri/src/settings.rs`: add a built-in preset `audio-mp3-320` ("Music · MP3 320",
  `kind: "audio"`, `audio_format: "mp3"`, `audio_quality: "320"`). Add a one-time migration
  `"music-320-defaults"` (same pattern as `SOCIAL_MEDIA_MIGRATION`): seed the preset if missing, then
  `service_presets.entry("youtube-music")` and `entry("soundcloud")` → `.or_insert("audio-mp3-320")`, so an
  existing user choice is never overwritten. New installs get the mapping from `Default`.
- In the preset hint for 320, note that SoundCloud streams are usually 128–256 kbps, so 320 is
  "max compatibility, not more detail". Keep it short.

**Sample rate (default 48 kHz)**

- `Settings` (Rust + TS): `audio_sample_rate: String`, values `"48000"` (default) | `"44100"` |
  `"96000"` | `"original"`. Optional per-preset override `sampleRate?: string | null` on `Preset`
  (`null` = use the global setting). UI: Settings → Audio, a select with a hint. Preset dialog: an
  optional override.
- `build_args` (`downloader.rs` ~L590): when `is_audio && audio_format != "source"` and the rate isn't
  `"original"`, pass `-ar <rate>` to the ExtractAudio postprocessor. **Merge into a single
  `ExtractAudio:` string** together with the existing `-joint_stereo 1` (e.g.
  `ExtractAudio:-joint_stereo 1 -ar 48000`) instead of passing a second `--postprocessor-args
  ExtractAudio:…`; don't rely on how yt-dlp combines repeated keys.
- Clamp per format, so ffmpeg never errors:
  - mp3 / aac: 44100 or 48000. If 96000 is chosen, use 48000 and show a hint in the UI.
  - opus: always 48000.
  - flac / wav: any of the three.
  - `source`: no resampling. Show "Sample rate doesn't apply to Original".
- `formatNote` / `presetSummary` shows the rate when not default, e.g. `MP3 · 320 kbps · 44.1 kHz`.
- Update `preview_command` output (CommandPreviewDialog) so it reflects the new args. Add a Rust unit test
  for `build_args` covering mp3+48k+joint stereo, opus, flac 96k, and source.

## Phase 5 — Tune My Music hint

- Constant `TUNEMYMUSIC_URL = "https://www.tunemymusic.com/transfer/apple-music-to-youtube-music"` in
  `src/lib/presets.ts`.
- Workspace empty state and under the paste box: a one-line tip, "Playlist on Apple Music, Spotify or
  elsewhere? Convert it to YouTube Music with Tune My Music, then paste the link here." Open it via
  `api.openExternal`.
- When a pasted URL is `open.spotify.com`, `music.apple.com`, `tidal.com` or `deezer.com` (unsupported or
  DRM), don't fail silently. Show the draft card in an "unsupported" state with that same Tune My Music
  button. Add these hosts to a small `CONVERTIBLE_HOSTS` list next to `SERVICES`.
- Also shown on the last onboarding step (Phase 6).

## Phase 6 — First-run onboarding

New component `src/components/OnboardingDialog.tsx`, mounted in `App.tsx` next to `DisclaimerDialog`.
New settings fields: `onboarding_completed: bool` (default `false`). The migration marks it `true` for
existing installs whose settings file already has `disclaimer_accepted: true`, so current users aren't
interrupted. Settings → About gets a "Run setup again" button.

Steps (one dialog, step state machine, non-dismissable until Skip or Finish, with a progress dots row):

1. **Hello**: big "Hello 👋" title and a single **Hello** button.
2. **Introduction**: two or three sentences on what MediaFetch is (a GUI for yt-dlp + FFmpeg, paste links,
   get files). Buttons: **Skip** (sets `onboarding_completed`, closes) and **Continue setup**.
3. **Disclaimer**: reuse the disclaimer text (`d.p1…d.p5`) here and set `disclaimerAccepted` on accept,
   so new users don't see two separate modals. `DisclaimerDialog` then only opens from Settings or when
   onboarding was skipped without acceptance. Skip must still require acceptance before downloading;
   keep `DisclaimerDialog`'s blocking behavior as the fallback.
4. **Components**: "Do you want to automatically download all the components?" **Yes, download all** /
   **Not now**. On Yes, install the missing ones **sequentially** via `api.installBinary`: yt-dlp, FFmpeg,
   Deno, gallery-dl. Show one row per component with:
   - a progress bar driven by the existing `binaryProgress[name]` store state (`downloading` → `extracting` → `done` / `error`)
   - a one-line explanation:
     - yt-dlp: "Downloads video and audio from YouTube, SoundCloud and 1000+ sites."
     - FFmpeg: "Converts and merges audio/video (MP3 320, sample rate, thumbnails)."
     - Deno: "JavaScript runtime yt-dlp needs to read YouTube pages."
     - gallery-dl: "Optional — downloads photos from Instagram and other galleries."
   - on error, a Retry button for that row. **Continue** is enabled when all rows are done, or failed
     with the user choosing to continue anyway.
5. **Defaults**: download folder (existing picker), audio format/quality (pre-set MP3 320), sample rate
   (48 kHz). Short, all pre-filled.
6. **Done**: the Tune My Music tip (Phase 5) and **Start downloading**.

Notes: the dialog must not flash before settings load (same guard as `DisclaimerDialog`). Use the existing
`ui/dialog` and `ui/progress` components.

## Phase 7 — Custom themes (create, import/export, share to the repo)

**Theme format** (`themes/<slug>.json` in the repo; user themes in `<app_config_dir>/themes/`):

```json
{
  "format": 1,
  "id": "midnight-teal",
  "name": "Midnight Teal",
  "author": "github-username",
  "base": "dark",
  "radius": "0.75rem",
  "colors": {
    "background": "200 30% 6%", "foreground": "180 20% 94%",
    "card": "...", "card-foreground": "...", "popover": "...", "popover-foreground": "...",
    "primary": "...", "primary-foreground": "...", "secondary": "...", "secondary-foreground": "...",
    "muted": "...", "muted-foreground": "...", "accent": "...", "accent-foreground": "...",
    "destructive": "...", "destructive-foreground": "...", "success": "...", "success-foreground": "...",
    "border": "...", "input": "...", "ring": "..."
  }
}
```

The keys are exactly the CSS variables in `src/index.css`. Missing keys fall back to the `base` palette.

- **Applying**: extend `Settings.theme` to `"auto" | "dark" | "light" | "custom:<id>"`. In `applyTheme`
  (`store.ts`), for custom: toggle `.dark` per `base`, then `document.documentElement.style.setProperty('--<key>', value)`
  for each color. Clear those inline properties when switching back to a built-in theme.
- **Validation** (security: themes come from strangers): accept only the whitelisted keys, and each
  value must match `^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$`; radius must match
  `^\d(\.\d+)?rem$`. Reject everything else. Never inject raw CSS. Write one validator in TS and mirror
  it in Rust for files loaded from disk.
- **Rust**: commands `list_themes`, `save_theme(theme)`, `delete_theme(id)`, `import_theme(path)`,
  `export_theme(id, path)`, `fetch_community_themes()`. The last one GETs
  `https://raw.githubusercontent.com/sergioalexo/mediafetch/main/themes/index.json`, then each file,
  with a 10 s timeout and graceful offline failure, reusing the reqwest client from `binaries.rs`.
- **UI**: Settings → Appearance:
  - a grid of theme cards (mini preview: background, card, primary swatch) for Built-in, My themes, and Community
  - **Create theme**: an editor dialog that starts from the current theme, with a color input per token
    (convert hex ↔ HSL in `src/lib/utils.ts`) and a **live preview**: apply it to the app while editing,
    revert on cancel
  - **Export** (.json), **Import** (.json)
  - **Share to MediaFetch**: opens `https://github.com/sergioalexo/mediafetch/new/main/themes?filename=<id>.json&value=<url-encoded json>`
    (GitHub's prefilled new-file page creates a fork + PR for non-owners). Fall back to copying the JSON
    to the clipboard and opening the `themes/` folder page if the URL would exceed about 8 KB.
- **Repo**: add `themes/README.md` (how to make and submit a theme), `themes/index.json` (list of
  `{id, name, author, file}`), two starter themes, and a CI job in `.github/workflows/` (e.g.
  `themes.yml`, on PRs touching `themes/**`) that runs a small Node script validating every theme against
  the same rules and checking that `index.json` is in sync.

## Phase 8 — Update everything (dependencies + components)

**Components (yt-dlp, FFmpeg, Deno, gallery-dl)**

- Generalize `autoUpdateYtdlp` to `autoUpdateComponents: bool` (default **true** for new installs; keep
  the old field readable and migrate its value). On startup, after `refreshBinaries(true)`, update every
  *managed* component with `updateAvailable`, sequentially, in the background, with a toast when done.
  Rename the toggle on the Components page accordingly.
- Sidebar: show a dot on "Components" when any update is available.

**JS dependencies.** Run `npm outdated` to start. As of today:

1. Safe, in-range: `npm update` (Radix, `@tauri-apps/*` incl. CLI 2.12, zustand, postcss, autoprefixer).
   Build and smoke test, then commit.
2. Majors, **one commit each**, building after every step:
   - `react`/`react-dom` 19 + `@types/react*` 19. Check `forwardRef` usage in `src/components/ui/*` (still
     works) and any `defaultProps`.
   - `vite` 7 (or 8 if `@vitejs/plugin-react` 6 and the Tauri template support it) + `@vitejs/plugin-react`.
   - `framer-motion` → the `motion` package (`import { motion } from "motion/react"`).
   - `lucide-react` 1.x. Some icons were renamed; fix the imports the compiler flags.
   - **Tailwind 4 + `tailwind-merge` 3** together. Run `npx @tailwindcss/upgrade`, move the config into
     CSS (`@theme`), keep the HSL CSS-variable tokens (Phase 7 depends on them), and drop
     `autoprefixer`/`postcss.config.js` if the Vite plugin replaces them. This is the riskiest bump; do it
     last and check every page in light, dark, and a custom theme.
   - TypeScript: move to the latest 5.x/6.x that Vite and tsc support. Skip 7.x unless `tsc && vite build`
     works unchanged.
3. Add `@tanstack/react-virtual` (Phase 3).

**Rust.** In `src-tauri`, run `cargo update`, then check for newer majors of `reqwest`, `zip`, `winreg`,
`tauri-winrt-notification`. Bump the Tauri plugins to match the JS plugin versions (they must stay on the
same minor). Run `cargo clippy -- -D warnings` and fix what it reports.

## Phase 9 — Release

- Bump the version to **0.3.0** in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
- Update the README feature list: queue ordering, history backup/import, onboarding, themes, sample rate,
  MP3 320 defaults, Tune My Music.
- Don't tag or push without the maintainer's go-ahead (the release workflow signs and publishes).

---

## Checks after every phase

```sh
npm run build                       # tsc + vite build
cd src-tauri && cargo check && cargo test && cargo clippy -- -D warnings
npm run tauri dev                   # manual smoke test
```

**Add tests** (none exist today):

- Vitest for pure TS: queue row sorting/ranking, `normalizeUrl` / `extractMediaId`, the downloaded index,
  the theme validator, hex↔HSL.
- Rust `#[cfg(test)]`: history merge rules (dedupe by id, by `mediaKey`, completed replaces failed, caps),
  `build_args` audio cases, theme validation.

**Manual acceptance checklist**

- [ ] Paste a 300+ track YouTube Music playlist and download all. The UI stays smooth (no stutter when
      scrolling or typing), active downloads stay at the top with live progress, finished ones sink to
      the bottom.
- [ ] Kill the network mid-download: failed items show as Failed, are **not** in the "downloaded" count,
      and re-analysing the playlist pre-selects them again.
- [ ] Retry a failed item until it succeeds: the history shows one completed entry, no leftover failure.
- [ ] Restart the app, re-paste the same playlist: every completed track shows "Already downloaded" and
      is unticked.
- [ ] Back up the history, clear it, import twice: the counts are correct and the second import adds 0.
- [ ] Import a backup into a non-empty history: it merges and nothing is lost.
- [ ] Fresh profile (delete the app config/data dirs): the onboarding runs Hello → Intro → Disclaimer →
      Components (all four install with progress) → Defaults → Done.
- [ ] Existing profile: no onboarding pops up.
- [ ] YT Music and SoundCloud links default to the MP3 320 preset. The command preview shows
      `--audio-quality 320K` and `-ar 48000`. `ffprobe` on the output shows 48000 Hz.
- [ ] Create a theme, export it, delete it, import it, apply it. A malformed or malicious theme file is
      rejected with a clear message.
- [ ] A Spotify link shows the Tune My Music suggestion.
