import { invoke } from "@tauri-apps/api/core";
import type {
  AnalyzeResult,
  BinaryStatus,
  DownloadOptions,
  DownloadTask,
  HistoryEntry,
  Settings,
} from "./types";

// ---- Settings ----
export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });
export const pickDownloadDir = () => invoke<string | null>("pick_download_dir");
export const pickCookiesFile = () => invoke<string | null>("pick_cookies_file");

// ---- URL analysis ----
export const analyzeUrl = (url: string) => invoke<AnalyzeResult>("analyze_url", { url });

// ---- Queue ----
export const getQueue = () => invoke<DownloadTask[]>("get_queue");
export const enqueue = (items: DownloadOptions[]) =>
  invoke<void>("enqueue", { items });
export const pauseTask = (id: string) => invoke<void>("pause_task", { id });
export const resumeTask = (id: string) => invoke<void>("resume_task", { id });
export const cancelTask = (id: string) => invoke<void>("cancel_task", { id });
export const retryTask = (id: string) => invoke<void>("retry_task", { id });
export const removeTask = (id: string) => invoke<void>("remove_task", { id });
export const reorderTask = (id: string, newIndex: number) =>
  invoke<void>("reorder_task", { id, newIndex });
export const clearFinished = () => invoke<void>("clear_finished");

// ---- History ----
export const getHistory = () => invoke<HistoryEntry[]>("get_history");
export const clearHistory = () => invoke<void>("clear_history");
export const removeHistoryEntry = (id: string) =>
  invoke<void>("remove_history_entry", { id });
export const showInFolder = (path: string) => invoke<void>("show_in_folder", { path });
export const openFile = (path: string) => invoke<void>("open_file", { path });
export const openExternal = (url: string) => invoke<void>("open_external", { url });

// ---- Binaries module ----
export const getBinariesStatus = (checkLatest: boolean) =>
  invoke<BinaryStatus[]>("get_binaries_status", { checkLatest });
export const installBinary = (name: string) => invoke<void>("install_binary", { name });
