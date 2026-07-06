# MediaFetch

A modern desktop GUI for **yt-dlp** + **FFmpeg**, built with Tauri, React, TypeScript, Tailwind CSS, shadcn/ui and Framer Motion.

![stack](https://img.shields.io/badge/Tauri-2-blue) ![stack](https://img.shields.io/badge/React-18-61dafb) ![stack](https://img.shields.io/badge/TypeScript-5-3178c6)

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

On first launch, open the **Components** page and install yt-dlp and FFmpeg (or make sure both are on your PATH). Binaries are stored in `%APPDATA%/com.mediafetch.app/bin`.

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

