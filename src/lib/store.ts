import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type {
  AnalyzeResult,
  AppLogLine,
  AppUpdateStatus,
  BinaryProgress,
  BinaryStatus,
  DownloadOptions,
  DownloadTask,
  Engine,
  HistoryEntry,
  Preset,
  Settings,
} from "./types";
import * as api from "./api";
import { translate, type MsgKey } from "./i18n";
import {
  autoDownloadForUrl,
  isAlreadyDownloaded,
  isConvertibleHost,
  isFetchAll,
  optionsFromPreset,
  presetIdForUrl,
  resolveEngine,
  sourceAbrOf,
} from "./presets";
import { extractUrls } from "./utils";
import { applyCustomTheme, customThemeId, type Theme } from "./theme";

export type Page = "downloads" | "history" | "stats" | "logs" | "settings" | "binaries";

/** Log lines held in the UI. Matches the backend ring buffer's capacity. */
const LOG_LIMIT = 5000;

// Incoming log lines are batched (see the "app-log" listener in init).
const logBuffer: AppLogLine[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Incoming task-progress events are batched the same way (see "task-progress").
const progressBuffer = new Map<string, DownloadTask>();
let progressFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** A pasted link staged in the Workspace: analyzed but not yet downloading. */
export interface Draft {
  id: string;
  url: string;
  presetId: string;
  status: "analyzing" | "ready" | "error" | "unsupported";
  result?: AnalyzeResult | null;
  error?: string | null;
  /** Selected playlist entry indices (only for playlist results). */
  selected: number[];
  collapsed: boolean;
  addedAt: number;
  /** Queue this draft on its own as soon as analysis succeeds (per-service rule). */
  autoDownload: boolean;
}

let draftSeq = 0;
const ANALYZE_LIMIT = 3;

interface SpeedSample {
  t: number; // epoch ms
  speed: number; // bytes/sec (sum over active tasks)
}

interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: "default" | "success" | "error";
}

interface AppState {
  page: Page;
  setPage: (p: Page) => void;

  settings: Settings | null;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;

  // Custom themes (lib/theme.ts). Built-in auto/dark/light stay plain
  // Settings.theme values; a custom one is "custom:<id>" into this list.
  customThemes: Theme[];
  communityThemes: Theme[];
  themesLoading: boolean;
  loadThemes: () => Promise<void>;
  loadCommunityThemes: () => Promise<void>;
  saveCustomTheme: (theme: Theme) => Promise<void>;
  deleteCustomTheme: (id: string) => Promise<void>;
  importCustomTheme: (path: string) => Promise<Theme>;
  exportCustomTheme: (id: string, path: string) => Promise<void>;

  queue: DownloadTask[];
  history: HistoryEntry[];
  speedSamples: SpeedSample[];

  // Workspace staging (session-only, cleared on app restart).
  drafts: Draft[];
  /** `bypassAuto` stages links as plain drafts, ignoring the per-service auto-download rule. */
  addUrls: (text: string, opts?: { bypassAuto?: boolean }) => void;
  setDraftPreset: (id: string, presetId: string) => void;
  toggleDraftEntry: (id: string, index: number) => void;
  setDraftEntriesAll: (id: string, selected: boolean) => void;
  toggleDraftCollapsed: (id: string) => void;
  removeDraft: (id: string) => void;
  /** Queue items directly, reporting any the backend skipped as duplicates. */
  enqueueItems: (items: DownloadOptions[]) => Promise<void>;
  /** Re-enqueue a failed history entry's URL under its service's default preset. */
  retryHistoryEntry: (h: HistoryEntry) => Promise<void>;
  downloadDraft: (id: string) => Promise<void>;
  downloadAllDrafts: () => Promise<void>;
  downloadNextDraft: () => Promise<void>;

  // Preset helpers (presets live in settings).
  activePreset: () => Preset | null;
  presetById: (id: string) => Preset | null;
  setDefaultPreset: (id: string) => Promise<void>;

  // App-wide log book (every command and line the tools printed).
  appLog: AppLogLine[];
  loadAppLog: () => Promise<void>;
  clearAppLog: () => Promise<void>;

  binaries: BinaryStatus[];
  binaryProgress: Record<string, BinaryProgress>;
  binariesLoading: boolean;
  refreshBinaries: (checkLatest: boolean) => Promise<void>;

  appUpdate: AppUpdateStatus | null;
  checkAppUpdate: () => Promise<void>;

  showDisclaimer: boolean;
  setShowDisclaimer: (v: boolean) => void;

  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;

  init: () => Promise<void>;
}

let toastId = 0;
let initialized = false;

export const useApp = create<AppState>((set, get) => ({
  page: "downloads",
  setPage: (p) => set({ page: p }),

  settings: null,
  loadSettings: async () => {
    // Custom themes have to be in hand before a "custom:<id>" theme setting
    // can be applied, so this loads first.
    await get().loadThemes();
    const settings = await api.getSettings();
    set({ settings });
    applyTheme(settings.theme, get().customThemes);
  },
  updateSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ settings: next });
    if (patch.theme !== undefined) applyTheme(patch.theme, get().customThemes);
    await api.saveSettings(next);
  },

  customThemes: [],
  communityThemes: [],
  themesLoading: false,
  loadThemes: async () => {
    try {
      const customThemes = await api.listThemes();
      set({ customThemes });
    } catch {
      // A fresh profile has no themes dir yet; nothing to load.
    }
  },
  loadCommunityThemes: async () => {
    set({ themesLoading: true });
    try {
      const communityThemes = await api.fetchCommunityThemes();
      set({ communityThemes });
    } catch (e) {
      get().toast({ title: translate(get().settings?.language ?? "en", "th.fetchFailed"), description: String(e), variant: "error" });
    } finally {
      set({ themesLoading: false });
    }
  },
  saveCustomTheme: async (theme) => {
    await api.saveTheme(theme);
    await get().loadThemes();
    // Editing the currently-applied theme should repaint immediately.
    const settings = get().settings;
    if (settings && customThemeId(settings.theme) === theme.id) {
      applyTheme(settings.theme, get().customThemes);
    }
  },
  deleteCustomTheme: async (id) => {
    await api.deleteTheme(id);
    await get().loadThemes();
    const settings = get().settings;
    if (settings && customThemeId(settings.theme) === id) {
      void get().updateSettings({ theme: "auto" });
    }
  },
  importCustomTheme: async (path) => {
    const theme = await api.importTheme(path);
    await get().loadThemes();
    return theme;
  },
  exportCustomTheme: (id, path) => api.exportTheme(id, path),

  queue: [],
  history: [],
  speedSamples: [],

  drafts: [],
  addUrls: (text, opts) => {
    const urls = extractUrls(text);
    const existing = new Set(get().drafts.map((d) => d.url));
    const s = get().settings;
    const fresh: Draft[] = urls
      .filter((u) => !existing.has(u))
      .map((url) => ({
        id: `d${++draftSeq}`,
        url,
        // Service-specific default preset (e.g. Instagram -> video,
        // YouTube Music -> audio), falling back to the global default.
        presetId: presetIdForUrl(
          url,
          s?.servicePresets ?? {},
          s?.defaultPresetId ?? "",
          (id) => !!s?.presets.some((p) => p.id === id)
        ),
        // Spotify/Apple Music/Tidal/Deezer links aren't fetchable at all
        // (DRM-gated streaming) — skip straight to the Tune My Music hint
        // instead of burning an analyze call that can only fail.
        status: isConvertibleHost(url) ? ("unsupported" as const) : ("analyzing" as const),
        result: null,
        selected: [],
        collapsed: false,
        addedAt: Date.now(),
        // Unsupported links can never download, so the rule never applies.
        autoDownload:
          !opts?.bypassAuto &&
          !isConvertibleHost(url) &&
          autoDownloadForUrl(url, s?.serviceAutoDownload ?? {}),
      }));
    if (fresh.length === 0) return;
    // Newest links go on top so a fresh paste is always the first card.
    set((s) => ({ drafts: [...fresh, ...s.drafts] }));
    for (const d of fresh) {
      if (d.status === "analyzing") scheduleAnalyze(get, set, d.id);
    }
  },
  setDraftPreset: (id, presetId) =>
    set((s) => ({
      drafts: s.drafts.map((d) => (d.id === id ? { ...d, presetId } : d)),
    })),
  toggleDraftEntry: (id, index) =>
    set((s) => ({
      drafts: s.drafts.map((d) => {
        if (d.id !== id) return d;
        const has = d.selected.includes(index);
        return {
          ...d,
          selected: has
            ? d.selected.filter((i) => i !== index)
            : [...d.selected, index],
        };
      }),
    })),
  setDraftEntriesAll: (id, selected) =>
    set((s) => ({
      drafts: s.drafts.map((d) =>
        d.id === id
          ? {
              ...d,
              selected:
                selected && d.result?.kind === "playlist"
                  ? d.result.entries.map((_, i) => i)
                  : [],
            }
          : d
      ),
    })),
  toggleDraftCollapsed: (id) =>
    set((s) => ({
      drafts: s.drafts.map((d) => (d.id === id ? { ...d, collapsed: !d.collapsed } : d)),
    })),
  removeDraft: (id) => set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) })),
  enqueueItems: (items) => enqueueReportingDuplicates(get, items),
  retryHistoryEntry: async (h) => {
    const s = get().settings;
    const presetId = presetIdForUrl(
      h.url,
      s?.servicePresets ?? {},
      s?.defaultPresetId ?? "",
      (id) => !!s?.presets.some((p) => p.id === id)
    );
    const preset = s?.presets.find((p) => p.id === presetId) ?? s?.presets[0];
    if (!preset) return;
    const lang = s?.language ?? "en";
    const options = optionsFromPreset(
      preset,
      { url: h.url, title: h.title },
      (k) => translate(lang, k)
    );
    await enqueueReportingDuplicates(get, [options]);
  },
  downloadDraft: async (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (!draft || draft.status !== "ready" || !draft.result) return;
    const items = buildDraftItems(get, draft);
    if (items.length === 0) return;
    await enqueueReportingDuplicates(get, items);
    set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
    get().setPage("downloads");
  },
  downloadAllDrafts: async () => {
    const ready = get().drafts.filter((d) => d.status === "ready" && d.result);
    const items = ready.flatMap((d) => buildDraftItems(get, d));
    if (items.length === 0) return;
    await enqueueReportingDuplicates(get, items);
    const ids = new Set(ready.map((d) => d.id));
    set((s) => ({ drafts: s.drafts.filter((d) => !ids.has(d.id)) }));
  },
  downloadNextDraft: async () => {
    const next = get().drafts.find((d) => d.status === "ready" && d.result);
    if (next) await get().downloadDraft(next.id);
  },

  activePreset: () => {
    const s = get().settings;
    if (!s) return null;
    return s.presets.find((p) => p.id === s.defaultPresetId) ?? s.presets[0] ?? null;
  },
  presetById: (id) => get().settings?.presets.find((p) => p.id === id) ?? null,
  setDefaultPreset: async (id) => {
    await get().updateSettings({ defaultPresetId: id });
  },

  appLog: [],
  loadAppLog: async () => {
    set({ appLog: await api.getAppLog() });
  },
  clearAppLog: async () => {
    await api.clearAppLog();
    set({ appLog: [] });
  },

  binaries: [],
  binaryProgress: {},
  binariesLoading: false,
  refreshBinaries: async (checkLatest) => {
    set({ binariesLoading: true });
    try {
      const binaries = await api.getBinariesStatus(checkLatest);
      set({ binaries });
    } finally {
      set({ binariesLoading: false });
    }
  },

  appUpdate: null,
  checkAppUpdate: async () => {
    try {
      const appUpdate = await api.checkAppUpdate();
      set({ appUpdate });
    } catch {
      // offline or rate limited — try again next launch
    }
  },

  showDisclaimer: false,
  setShowDisclaimer: (v) => set({ showDisclaimer: v }),

  toasts: [],
  toast: (t) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  init: async () => {
    if (initialized) return;
    initialized = true;

    await get().loadSettings();
    const [queue, history] = await Promise.all([api.getQueue(), api.getHistory()]);
    set({ queue, history });
    void get().refreshBinaries(true);
    void get().checkAppUpdate();

    await listen<DownloadTask[]>("queue-changed", (e) => {
      set({ queue: e.payload });
    });

    // Buffered the same way app-log is: a 300-item queue downloading several
    // tasks at once emits task-progress several times a second per task, and
    // applying each one with its own `queue.map` re-rendered the whole
    // Workspace page that many times.
    await listen<DownloadTask>("task-progress", (e) => {
      progressBuffer.set(e.payload.id, e.payload);
      if (progressFlushTimer === null) {
        progressFlushTimer = setTimeout(() => {
          progressFlushTimer = null;
          const updates = new Map(progressBuffer);
          progressBuffer.clear();
          set((s) => ({
            queue: s.queue.map((t) => updates.get(t.id) ?? t),
          }));
        }, 100);
      }
    });

    await listen<HistoryEntry>("history-added", (e) => {
      set((s) => ({ history: [e.payload, ...s.history] }));
      const entry = e.payload;
      const lang = get().settings?.language ?? "en";
      if (entry.status === "completed") {
        get().toast({
          title: translate(lang, "t.downloadComplete"),
          description: entry.title,
          variant: "success",
        });
      } else {
        get().toast({
          title: translate(lang, "t.downloadFailed"),
          description: entry.title,
          variant: "error",
        });
      }
    });

    // Fired after a history import merges entries in on the Rust side —
    // replace the whole list rather than trying to patch in just what's new.
    await listen<HistoryEntry[]>("history-replaced", (e) => {
      set({ history: e.payload });
    });

    // The log book streams in live; seed it with whatever was recorded before
    // the window opened (the startup version line, mainly).
    await get().loadAppLog();
    // Buffered: a verbose download emits hundreds of lines a second, and
    // appending one at a time rebuilt the whole 5000-line array — and
    // re-rendered the log page — for every one of them.
    await listen<AppLogLine>("app-log", (e) => {
      logBuffer.push(e.payload);
      if (logFlushTimer === null) {
        logFlushTimer = setTimeout(() => {
          logFlushTimer = null;
          const batch = logBuffer.splice(0, logBuffer.length);
          if (batch.length > 0) {
            set((s) => ({ appLog: [...s.appLog, ...batch].slice(-LOG_LIMIT) }));
          }
        }, 150);
      }
    });
    await listen("app-log-cleared", () => {
      logBuffer.length = 0;
      set({ appLog: [] });
    });

    await listen<BinaryProgress>("binary-progress", (e) => {
      set((s) => ({
        binaryProgress: { ...s.binaryProgress, [e.payload.name]: e.payload },
      }));
      if (e.payload.phase === "done") {
        void get().refreshBinaries(true);
      }
    });

    // Fired once the background startup update pass finishes (auto_update_
    // components), naming whichever components it actually updated.
    await listen<string[]>("components-updated", (e) => {
      void get().refreshBinaries(false);
      const lang = get().settings?.language ?? "en";
      get().toast({
        title: translate(lang, "c.componentsUpdated"),
        description: e.payload.join(", "),
        variant: "default",
      });
    });

    // Aggregate speed sampling for the live graph (keep last 120 samples ≈ 2 min).
    // Skipped entirely while nothing is downloading — an idle queue of 300
    // finished items has no business re-rendering every subscriber once a
    // second just to append a zero.
    setInterval(() => {
      const active = get().queue.filter((t) => t.status === "downloading");
      if (active.length === 0) return;
      const speed = active.reduce((sum, t) => sum + (t.speed || 0), 0);
      set((s) => ({
        speedSamples: [...s.speedSamples, { t: Date.now(), speed }].slice(-120),
      }));
    }, 1000);
  },
}));

// "auto" tracks the OS preference live, so the window follows Windows/macOS
// flipping to dark without a restart. Older settings files say "dark"/"light".
const systemDark =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
let unwatchSystem: (() => void) | null = null;

function applyTheme(theme: string, customThemes: Theme[]) {
  unwatchSystem?.();
  unwatchSystem = null;

  const customId = customThemeId(theme);
  if (customId) {
    const found = customThemes.find((t) => t.id === customId);
    // A theme that was deleted out from under the setting (e.g. on another
    // install, before a backup was restored) falls back to the built-in
    // dark look rather than applying nothing.
    applyCustomTheme(found ?? null);
    if (!found) document.documentElement.classList.toggle("dark", true);
    return;
  }
  // Switching back to a built-in theme clears any inline custom properties
  // a previous custom theme left on the root.
  applyCustomTheme(null);

  if (theme === "auto") {
    const sync = () =>
      document.documentElement.classList.toggle("dark", !!systemDark?.matches);
    sync();
    if (systemDark) {
      systemDark.addEventListener("change", sync);
      unwatchSystem = () => systemDark.removeEventListener("change", sync);
    }
    return;
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// ---- Draft analysis (concurrency-limited) & item building ----

type Get = () => AppState;
type SetState = (
  partial:
    | AppState
    | Partial<AppState>
    | ((s: AppState) => AppState | Partial<AppState>)
) => void;

let analyzing = 0;
const pendingAnalyze: string[] = [];

function scheduleAnalyze(get: Get, set: SetState, id: string) {
  pendingAnalyze.push(id);
  pumpAnalyze(get, set);
}

function pumpAnalyze(get: Get, set: SetState) {
  while (analyzing < ANALYZE_LIMIT && pendingAnalyze.length > 0) {
    const id = pendingAnalyze.shift()!;
    if (!get().drafts.some((d) => d.id === id)) continue;
    analyzing++;
    void runAnalyze(get, set, id).finally(() => {
      analyzing--;
      pumpAnalyze(get, set);
    });
  }
}

/**
 * Enqueue, then say so when the backend dropped duplicates. Adding two
 * playlists that share a song is the common way to hit this, and a silently
 * shorter queue than the button promised is worse than a one-line toast.
 */
async function enqueueReportingDuplicates(get: Get, items: DownloadOptions[]) {
  const skipped = await api.enqueue(items);
  if (!skipped) return;
  const lang = get().settings?.language ?? "en";
  get().toast({
    title: translate(lang, "t.duplicatesSkipped"),
    description: translate(lang, "t.nDuplicatesSkipped", { n: skipped }),
    variant: "default",
  });
}

async function runAnalyze(get: Get, set: SetState, id: string) {
  const draft = get().drafts.find((d) => d.id === id);
  if (!draft) return;
  try {
    const r = await api.analyzeUrl(draft.url);
    set((s) => ({
      drafts: s.drafts.map((d) => {
        if (d.id !== id) return d;
        // Pre-select playlist tracks that are not already in the history.
        const selected =
          r.kind === "playlist"
            ? r.entries
                .map((_, i) => i)
                .filter(
                  (i) => !isAlreadyDownloaded(s.history, r.entries[i].url, r.entries[i].id)
                )
            : [];
        return { ...d, status: "ready" as const, result: r, selected };
      }),
    }));
    // Per-service auto-download: queue it now, as the Download button would.
    // Anything already downloaded (a video in history, or a playlist with no
    // new tracks left) stays as a regular card showing its "downloaded" badge.
    const done = get().drafts.find((d) => d.id === id);
    const history = get().history;
    const alreadyHave =
      r.kind === "playlist"
        ? (done?.selected.length ?? 0) === 0
        : isAlreadyDownloaded(history, r.url, r.id) ||
          isAlreadyDownloaded(history, draft.url);
    if (done?.autoDownload && done.status === "ready" && !alreadyHave) {
      const lang = get().settings?.language ?? "en";
      get().toast({
        title: translate(lang, "t.autoQueued", { title: r.title }),
        variant: "default",
      });
      await get().downloadDraft(id);
    }
  } catch (e) {
    set((s) => ({
      drafts: s.drafts.map((d) =>
        d.id === id ? { ...d, status: "error" as const, error: String(e) } : d
      ),
    }));
  }
}

/** The preset a draft will actually download with. */
function presetForDraft(s: Settings, draft: Draft): Preset | null {
  return (
    s.presets.find((p) => p.id === draft.presetId) ??
    s.presets.find((p) => p.id === s.defaultPresetId) ??
    s.presets[0] ??
    null
  );
}

/**
 * How a draft will be queued, decided in one place so the Workspace's counts
 * and labels can't drift from what actually gets enqueued.
 */
export function draftPlan(
  get: Get,
  draft: Draft
): { engine: Engine; oneTask: boolean; taskCount: number } {
  const s = get().settings;
  const r = draft.result;
  const preset = s ? presetForDraft(s, draft) : null;
  if (!s || !r || !preset) return { engine: "ytdlp", oneTask: false, taskCount: 0 };

  const galleryInstalled = !!get().binaries.find(
    (b) => b.name === "gallery-dl" && b.installed
  );
  const engine = resolveEngine(preset, r.engine, galleryInstalled);
  // "Fetch all" hands the original link to the tool and lets it walk the
  // whole thing — the only way to get an Instagram profile or a multi-photo
  // post, whose items have no separate page of their own to queue.
  // gallery-dl always works this way.
  const oneTask = isFetchAll(preset) || engine === "gallerydl";
  const selectable = r.kind === "playlist";
  // An empty selection means the user unticked everything — nothing to do.
  const taskCount = oneTask
    ? selectable && draft.selected.length === 0
      ? 0
      : 1
    : selectable
      ? draft.selected.length
      : 1;
  return { engine, oneTask, taskCount };
}

export function buildDraftItems(get: Get, draft: Draft): DownloadOptions[] {
  const s = get().settings;
  if (!s || !draft.result) return [];
  const preset = presetForDraft(s, draft);
  if (!preset) return [];
  const lang = s.language ?? "en";
  const t = (k: MsgKey) => translate(lang, k);
  const r = draft.result;
  const { engine, oneTask, taskCount } = draftPlan(get, draft);

  if (oneTask) {
    if (taskCount === 0) return [];
    const all = r.kind !== "playlist" || draft.selected.length === r.entries.length;
    return [
      optionsFromPreset(
        preset,
        {
          url: draft.url,
          title: r.title,
          thumbnail: r.thumbnail,
          sourceAbr: sourceAbrOf(r),
          playlist: true,
          engine,
          // Deselected items become an explicit 1-based item list; both tools
          // take the same "1,3,5-8" syntax.
          playlistItems: all
            ? null
            : [...draft.selected].sort((a, b) => a - b).map((i) => i + 1).join(","),
          // gallery-dl reports no totals, so give it the count when we know it.
          expectedItems:
            r.kind === "playlist" ? (all ? r.entries.length : draft.selected.length) : null,
        },
        t
      ),
    ];
  }

  if (r.kind === "playlist") {
    const groupId = `${draft.id}-${draft.addedAt}`;
    return [...draft.selected]
      .sort((a, b) => a - b)
      .map((i) => r.entries[i])
      .filter((e) => !!e && !!e.url)
      .map((e) =>
        optionsFromPreset(
          preset,
          { url: e.url, title: e.title, thumbnail: e.thumbnail, groupId, groupTitle: r.title },
          t
        )
      );
  }
  return [
    optionsFromPreset(
      preset,
      { url: r.url, title: r.title, thumbnail: r.thumbnail, sourceAbr: sourceAbrOf(r) },
      t
    ),
  ];
}

// Convenient selectors
export const useQueue = () => useApp((s) => s.queue);
export const useSettings = () => useApp((s) => s.settings);
