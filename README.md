# MediaFetch

A cross-platform media download manager — a graphical interface for **yt-dlp** + **FFmpeg**, built with Tauri, React, TypeScript, Tailwind CSS, shadcn/ui and Motion.

![stack](https://img.shields.io/badge/Tauri-2-blue) ![stack](https://img.shields.io/badge/React-19-61dafb) ![stack](https://img.shields.io/badge/TypeScript-7-3178c6)

## Disclaimer

MediaFetch is an independent graphical user interface (GUI) for the open-source projects [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org/) and [gallery-dl](https://github.com/mikf/gallery-dl). It is not affiliated with, endorsed by, or sponsored by YouTube, Google, SoundCloud, Vimeo, Instagram, Meta, or any other content platform. MediaFetch does not host, store, index, or distribute any media or content.

MediaFetch does not circumvent digital rights management (DRM) or other technological protection measures (TPMs). Content protected by DRM is not supported.

Downloading content from YouTube, SoundCloud, Vimeo, and many other online platforms may violate their respective Terms of Service unless the platform explicitly permits downloading or the rights holder has granted permission.

Only download content that:

- you created or own;
- is in the public domain;
- is distributed under a permissive license (such as Creative Commons);
- or for which you have the explicit permission or legal right to download and use.

You are solely responsible for ensuring that your use of this software complies with all applicable laws, copyright regulations, licensing terms, and the Terms of Service of any platform you access.

The developer does not encourage, promote, or endorse copyright infringement, unauthorized downloading, or any unlawful use of this software.

This software is provided "as is", without warranty of any kind, express or implied, as described in the [MIT License](LICENSE). To the fullest extent permitted by applicable law, the developer shall not be liable for any claims, damages, or other liability arising from the use or misuse of this software.

## Features

**Downloads**
- Paste one or many URLs (one per line, or however the source separated them)
- Drag & drop URLs from the browser
- Every link is analyzed first and staged as a card, downloaded with a **preset**: a named bundle of quality/format choices, with per-service defaults (e.g. YouTube Music → MP3 320)
- Playlist and channel downloads with per-item selection; tracks already in your history are marked and left unticked

**Video**
- Quality presets: best available, or capped at 4K / 1440p / 1080p / 720p / 480p
- Subtitles per preset (languages, embedded) or globally (download and/or embed)

**Audio**
- Extract audio to MP3, FLAC, WAV, AAC or OPUS at best available quality
- MP3 320 kbps default for YouTube Music and SoundCloud links
- Configurable sample rate (48 kHz default, 44.1 kHz, 96 kHz, or Original), globally or per preset
- A one-line hint to convert a Spotify / Apple Music / Tidal / Deezer playlist to YouTube Music via Tune My Music, since those links can't be fetched directly

**Photos & videos (social media)**
- Built-in "Photos & videos" preset that downloads pictures as well as video, via **gallery-dl**
- Grabs a whole profile, album or multi-photo post in one task, with per-item selection
- Default preset for Instagram links, which need sign-in cookies — including for public posts
- Without gallery-dl installed the same links still download, video only (yt-dlp cannot see still images)
- Settings → Cookies has a **Check cookies** button that reports how many cookies a source actually yields

**Advanced**
- SponsorBlock integration (remove segments or mark chapters, per-category)
- Browser cookies or cookies.txt support
- Proxy support
- Download speed limiting
- Download archive (skip previously downloaded media)
- Per-service auto-download: pasted links from chosen sites queue as soon as they are analyzed (already-downloaded media stays as a card); Ctrl+Shift+V pastes without auto-downloading
- Metadata and thumbnail embedding
- Custom yt-dlp / FFmpeg arguments per preset, with a preview of the exact command line

**Queue**
- Pause / resume / retry / cancel / reorder
- Configurable parallel downloads (1–8)
- Display order: active downloads at the top, queued/paused/failed below, completed last (collapsible past 20)
- Smooth with large playlists — big playlist groups, the history, the log book and playlist checklists only render the rows in view

**History**
- Search, and filter by All / Downloaded / Failed, with a one-click Retry on failed entries
- Correctness: success is only recorded once a file is actually produced; a failed-then-retried download leaves one completed entry, not a leftover failure
- Back up and import history as a file — merges in, never replaces, so restoring a backup never loses what's already there

**Extras**
- Statistics with live speed graph and ETA
- Log book: every command run and every line the tools printed, copyable for bug reports
- Native desktop notifications
- Dark / light / auto theme, or a custom theme — create your own with a live-preview color editor, import/export as JSON, or pick one from the community gallery
- First-run setup walks through installing components and picking defaults

**Components** (`src-tauri/src/binaries.rs` + Components page)
- Self-managed yt-dlp, FFmpeg, Deno (the JavaScript runtime yt-dlp needs for YouTube) and gallery-dl components
- Links to the official upstream GitHub repositories ([yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp), [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), [mikf/gallery-dl](https://github.com/mikf/gallery-dl) via its [standalone builds](https://github.com/gdl-org/builds), [denoland/deno](https://github.com/denoland/deno))
- Installed version detection and latest-release checking
- One-click installation and updates, with an optional auto-update-on-startup for every managed component, and a one-step rollback to the previous version

## Development

Prerequisites: Node.js 22+ (Vite 8 needs 20.19 or newer; CI uses 24), Rust (MSVC toolchain on Windows).

```sh
npm install
npm run tauri dev     # run the app in dev mode
npm run tauri build   # produce the installer
npm test              # frontend unit tests (Vitest)
cd src-tauri && cargo test   # backend unit tests
```

The `@tauri-apps/*` npm packages are pinned to exactly the versions of the matching Rust crates in `src-tauri/Cargo.lock` — the release build fails when the two drift apart, so update them together.

Tailwind CSS deliberately stays on 3.4: v4 requires Safari 16.4+, and on macOS the app renders in the system WebKit, so v4 would break styling on macOS 12 and older.

On first launch, open the **Components** page and install yt-dlp and FFmpeg, or ensure both are available on your system PATH.

- **Windows:** managed binaries are stored in `%APPDATA%/com.mediafetch.app/bin`
- **macOS:** yt-dlp installs from the Components page, while FFmpeg is detected from Homebrew (`brew install ffmpeg`)

## Releases

Versions are driven by git tags. To publish a release:

1. Update the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`) and `package.json` (+ `package-lock.json`) — keep them in sync.
2. Commit the changes.
3. Tag and push:

```sh
git tag v0.2.0
git push --tags
```

GitHub Actions builds the **Windows NSIS installer** and the **macOS universal DMG** and publishes them under [GitHub Releases](https://github.com/sergioalexo/mediafetch/releases). Each release lists exactly which file to grab per platform, and the two installers are labeled by operating system ("Windows 10/11 installer", "macOS disk image") so users don't have to guess:

| Platform | Asset |
| --- | --- |
| Windows 10/11 (64-bit) | `MediaFetch_<version>_x64-setup.exe` |
| macOS (Apple Silicon + Intel) | `MediaFetch_<version>_universal.dmg` |

The macOS build is currently not notarized by Apple, so the first launch is blocked by Gatekeeper: open **System Settings → Privacy & Security** and click **"Open Anyway"** next to the MediaFetch message (on macOS Sonoma and older: right-click the app → Open → Open), or run `xattr -cr /Applications/MediaFetch.app`. This is only needed once per install.

The application checks for new GitHub releases on startup and supports in-place updates through the Components page. Update artifacts are signed using Tauri's signing system (CI uses the `TAURI_SIGNING_PRIVATE_KEY` repository secret; the private key lives in `~/.tauri/mediafetch.key` — **keep a backup, without it updates can't be signed**).

## Architecture

```
src/                  React frontend (Vite + Tailwind + shadcn/ui + Motion)
  pages/              Workspace, History, Statistics, Log book, Settings, Components
  components/         queue rows, dialogs, theme editor; ui/ is vendored shadcn/ui
  lib/store.ts        zustand store, synced with backend events
  lib/presets.ts      presets, per-service defaults, "already downloaded" index
  lib/history.ts      history merge rule (mirrors history.rs)
  lib/i18n.tsx        en / uk / ru dictionaries
src-tauri/src/
  main.rs             Tauri commands and app setup
  downloader.rs       queue engine: spawns yt-dlp / gallery-dl, parses progress,
                      pause/resume, auto-retry, the log book
  binaries.rs         component manager: version checks, installs, rollback
  metadata.rs         URL analysis (yt-dlp -J, gallery-dl fallback)
  cookies.rs          "Check cookies" diagnostics
  history.rs          download history, backup and import
  settings.rs         persisted settings and one-time migrations
  themes.rs           custom and community themes, validated
  notify.rs           native notifications
```

## License

[MIT](LICENSE)
