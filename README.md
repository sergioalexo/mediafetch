# MediaFetch

A modern desktop GUI for **yt-dlp** + **FFmpeg**, built with Tauri, React, TypeScript, Tailwind CSS, shadcn/ui and Framer Motion.

![stack](https://img.shields.io/badge/Tauri-2-blue) ![stack](https://img.shields.io/badge/React-18-61dafb) ![stack](https://img.shields.io/badge/TypeScript-5-3178c6)

## Disclaimer

MediaFetch is an independent GUI for the open-source tools yt-dlp and FFmpeg, provided for **educational, research and personal-archival purposes only**. It does not host, index, provide or promote any content.

- Downloading content from YouTube, SoundCloud, Vimeo and most other streaming platforms **may violate their Terms of Service** unless the platform offers an explicit download feature or the rights holder permits it.
- Only download content that **you own**, that is in the **public domain**, that is distributed under a **permissive license** (e.g. Creative Commons), or for which you have the rights holder's **explicit permission**. Downloading or redistributing copyrighted material without authorization may be illegal in your jurisdiction.
- **You are solely responsible** for how you use this software and for complying with the terms of any service you use it with and with applicable law. The developer assumes **no liability for misuse** and does not endorse or encourage any violation of platform terms or copyright law.
- This software is provided **"as is", without warranty of any kind**, under the [MIT License](LICENSE).

## Features

**Downloads**
- Paste one or many URLs (one per line), drag & drop URLs from the browser
- Playlist and channel downloads with per-item selection
- Single-video analysis with full format listing

**Video**
- Resolution / FPS picker with HDR indicator and codec labels (AV1, VP9, H.264, …)
- Audio language selection for multi-audio videos
- Subtitle selection (write and/or embed)

**Audio**
- Extract to MP3, FLAC, WAV, AAC or OPUS at best quality

**Advanced**
- SponsorBlock (remove segments or mark chapters, per-category)
- Cookies from browser or cookies.txt
- Proxy and download speed limiting
- Download archive (skip already-downloaded videos)
- Metadata editing (title / artist / album / genre) and thumbnail embedding

**Queue**
- Pause / resume / retry / cancel / reorder
- Configurable parallel downloads (1–8)

**Extras**
- Download history with search
- Statistics with a live speed graph and ETA
- Native notifications on completion
- Dark / light theme

**Components module** (`src-tauri/src/binaries.rs` + Components page)
- yt-dlp and FFmpeg are managed as self-contained components
- Links to the upstream GitHub repos ([yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp), [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds))
- Shows the installed version, checks the latest GitHub release, flags updates and installs/updates in one click

## Development

Prerequisites: Node.js 18+, Rust (MSVC toolchain on Windows).

```sh
npm install
npm run tauri dev     # run the app in dev mode
npm run tauri build   # produce the installer (NSIS)
```

On first launch, open the **Components** page and install yt-dlp and FFmpeg (or make sure both are on your PATH). On Windows binaries are stored in `%APPDATA%/com.mediafetch.app/bin`. On macOS, yt-dlp installs from the Components page too, while FFmpeg comes from Homebrew (`brew install ffmpeg`) and is picked up automatically.

## Releases

Versions are driven by git tags. To publish a release:

1. Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` (keep them in sync).
2. Commit, then tag and push: `git tag v0.2.0 && git push --tags`.
3. The **Release** GitHub Actions workflow builds the Windows NSIS installer and the macOS universal DMG and publishes both at [Releases](https://github.com/sergioalexo/mediafetch/releases).

The macOS build is not notarized by Apple, so the first launch is blocked by Gatekeeper: open **System Settings → Privacy & Security** and click **"Open Anyway"** next to the MediaFetch message (on macOS Sonoma and older: right-click the app → Open → Open), or run `xattr -cr /Applications/MediaFetch.app`. This is only needed once per install.

The app checks the latest GitHub release on startup and shows an update notice on the Components page, where it can download and install the update in place (updater artifacts are signed in CI with the `TAURI_SIGNING_PRIVATE_KEY` repository secret; the private key lives in `~/.tauri/mediafetch.key` — **keep a backup, without it updates can't be signed**).

## Architecture

```
src/                  React frontend (Vite + Tailwind + shadcn/ui + Framer Motion)
  pages/              Downloads, Queue, History, Statistics, Settings, Components
  lib/store.ts        zustand store, synced with backend events
src-tauri/src/
  downloader.rs       queue engine: spawns yt-dlp, parses progress, pause/resume
  binaries.rs         component manager: version checks + updates from GitHub
  metadata.rs         URL analysis (yt-dlp -J)
  settings.rs         persisted settings
  history.rs          download history
```

## License

[MIT](LICENSE)

