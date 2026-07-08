# MediaFetch

A cross-platform media download manager — a graphical interface for **yt-dlp** + **FFmpeg**, built with Tauri, React, TypeScript, Tailwind CSS, shadcn/ui and Framer Motion.

![stack](https://img.shields.io/badge/Tauri-2-blue) ![stack](https://img.shields.io/badge/React-18-61dafb) ![stack](https://img.shields.io/badge/TypeScript-5-3178c6)

## Disclaimer

MediaFetch is an independent graphical user interface (GUI) for the open-source projects [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/). It is not affiliated with, endorsed by, or sponsored by YouTube, Google, SoundCloud, Vimeo, or any other content platform. MediaFetch does not host, store, index, or distribute any media or content.

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
- Paste one or many URLs (one per line)
- Drag & drop URLs from the browser
- Playlist and channel downloads with per-item selection
- Single-video analysis with full format listing

**Video**
- Resolution / FPS picker with HDR indicator
- Codec labels (AV1, VP9, H.264, …)
- Audio language selection for multi-audio videos
- Subtitle selection (download and/or embed)

**Audio**
- Extract audio to MP3, FLAC, WAV, AAC or OPUS at best available quality

**Advanced**
- SponsorBlock integration (remove segments or mark chapters, per-category)
- Browser cookies or cookies.txt support
- Proxy support
- Download speed limiting
- Download archive (skip previously downloaded media)
- Metadata editing (title, artist, album, genre)
- Thumbnail embedding

**Queue**
- Pause / resume / retry / cancel / reorder
- Configurable parallel downloads (1–8)

**Extras**
- Download history with search
- Statistics with live speed graph and ETA
- Native desktop notifications
- Dark / light theme

**Components** (`src-tauri/src/binaries.rs` + Components page)
- Self-managed yt-dlp and FFmpeg components
- Links to the official upstream GitHub repositories ([yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp), [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds))
- Installed version detection and latest-release checking
- One-click installation and updates

## Development

Prerequisites: Node.js 18+, Rust (MSVC toolchain on Windows).

```sh
npm install
npm run tauri dev     # run the app in dev mode
npm run tauri build   # produce the installer
```

On first launch, open the **Components** page and install yt-dlp and FFmpeg, or ensure both are available on your system PATH.

- **Windows:** managed binaries are stored in `%APPDATA%/com.mediafetch.app/bin`
- **macOS:** yt-dlp installs from the Components page, while FFmpeg is detected from Homebrew (`brew install ffmpeg`)

## Releases

Versions are driven by git tags. To publish a release:

1. Update the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` (keep them in sync).
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
src/                  React frontend (Vite + Tailwind + shadcn/ui + Framer Motion)
  pages/              Workspace, History, Statistics, Settings, Components
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
