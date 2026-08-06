import { invoke } from "@tauri-apps/api/core";
import type {
  AnalyzeResult,
  AppLogLine,
  AppUpdateStatus,
  BinaryStatus,
  CookieCheck,
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
export const testCookies = () => invoke<CookieCheck>("test_cookies");

// ---- URL analysis ----
export const analyzeUrl = (url: string) => invoke<AnalyzeResult>("analyze_url", { url });
export const previewCommand = (options: DownloadOptions) =>
  invoke<string>("preview_command", { options });

// ---- Queue ----
export const getQueue = () => invoke<DownloadTask[]>("get_queue");
export const getTaskLog = (id: string) => invoke<string[]>("get_task_log", { id });
export const getAppLog = () => invoke<AppLogLine[]>("get_app_log");
export const clearAppLog = () => invoke<void>("clear_app_log");
export const enqueue = (items: DownloadOptions[]) =>
  invoke<void>("enqueue", { items });
export const pauseTask = (id: string) => invoke<void>("pause_task", { id });
export const resumeTask = (id: string) => invoke<void>("resume_task", { id });
export const cancelTask = (id: string) => invoke<void>("cancel_task", { id });
export const pauseAllTasks = () => invoke<void>("pause_all_tasks");
export const cancelAllTasks = () => invoke<void>("cancel_all_tasks");
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

// ---- App updates ----
export const checkAppUpdate = () => invoke<AppUpdateStatus>("check_app_update");

// ---- Diagnostics (issue reporting) ----
export interface Diagnostics {
  appVersion: string;
  os: string;
  arch: string;
  ytdlpVersion: string | null;
  ffmpegVersion: string | null;
  gallerydlVersion: string | null;
}
export const collectDiagnostics = () => invoke<Diagnostics>("collect_diagnostics");

// ---- Binaries module ----
export const getBinariesStatus = (checkLatest: boolean) =>
  invoke<BinaryStatus[]>("get_binaries_status", { checkLatest });
export const installBinary = (name: string, version?: string) =>
  invoke<void>("install_binary", { name, version: version ?? null });
export const rollbackBinary = (name: string) =>
  invoke<void>("rollback_binary", { name });
export const uninstallBinary = (name: string) =>
  invoke<void>("uninstall_binary", { name });
export const resetComponents = () => invoke<void>("reset_components");
export const listBinaryVersions = (name: string) =>
  invoke<string[]>("list_binary_versions", { name });
