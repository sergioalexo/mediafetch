import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The Tauri CLI sets TAURI_ENV_* while it runs `beforeDevCommand` /
// `beforeBuildCommand`, so the build can tell which platform it targets.
const platform = process.env.TAURI_ENV_PLATFORM;
const debug = !!process.env.TAURI_ENV_DEBUG;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // What the webviews actually run: WebView2 is evergreen Chromium, but
    // macOS uses the system WebKit, which on the oldest supported macOS is
    // Safari 13 — older than Vite's own default target.
    target: platform === "windows" ? "chrome105" : "safari13",
    minify: !debug,
    sourcemap: debug,
    // The bundle is read from local disk by the webview, never over a
    // network, so splitting it into chunks wouldn't make anything faster.
    chunkSizeWarningLimit: 1500,
  },
});
