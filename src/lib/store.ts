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
  isAlreadyDownloaded,
  isFetchAll,
  optionsFromPreset,
  presetIdForUrl,
  resolveEngine,
  sourceAbrOf,
} from "./presets";
import { extractUrls } from "./utils";

export type Page = "downloads" | "history" | "stats" | "logs" | "settings" | "binaries";

/** Log lines held in the UI. Matches the backend ring buffer's capacity. */
const LOG_LIMIT = 5000;

// Incoming log lines are batched (see the "app-log" listener in init).
const logBuffer: AppLogLine[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** A pasted link staged in the Workspace: analyzed but not yet downloading. */
export interface Draft {
  id: string;
  url: string;
  presetId: string;
  status: "analyzing" | "ready" | "error";
  result?: AnalyzeResult | null;
  error?: string | null;
  /** Selected playlist entry indices (only for playlist results). */
  selected: number[];
  collapsed: boolean;
  addedAt: number;
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

  queue: DownloadTask[];
  history: HistoryEntry[];
  speedSamples: SpeedSample[];

  // Workspace staging (session-only, cleared on app restart).
  drafts: Draft[];
  addUrls: (text: string) => void;
  setDraftPreset: (id: string, presetId: string) => void;
  toggleDraftEntry: (id: string, index: number) => void;
  setDraftEntriesAll: (id: string, selected: boolean) => void;
  toggleDraftCollapsed: (id: string) => void;
  removeDraft: (id: string) => void;
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
    const settings = await api.getSettings();
    set({ settings });
    applyTheme(settings.theme);
  },
  updateSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ settings: next });
    if (patch.theme) applyTheme(patch.theme);
    await api.saveSettings(next);
  },

  queue: [],
  history: [],
  speedSamples: [],

  drafts: [],
  addUrls: (text) => {
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
        status: "analyzing",
        result: null,
        selected: [],
        collapsed: false,
        addedAt: Date.now(),
      }));
    if (fresh.length === 0) return;
    set((s) => ({ drafts: [...s.drafts, ...fresh] }));
    for (const d of fresh) scheduleAnalyze(get, set, d.id);
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
  downloadDraft: async (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (!draft || draft.status !== "ready" || !draft.result) return;
    const items = buildDraftItems(get, draft);
    if (items.length === 0) return;
    await api.enqueue(items);
    set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
    get().setPage("downloads");
  },
  downloadAllDrafts: async () => {
    const ready = get().drafts.filter((d) => d.status === "ready" && d.result);
    const items = ready.flatMap((d) => buildDraftItems(get, d));
    if (items.length === 0) return;
    await api.enqueue(items);
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

    await listen<DownloadTask>("task-progress", (e) => {
      set((s) => ({
        queue: s.queue.map((t) => (t.id === e.payload.id ? e.payload : t)),
      }));
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

    // Aggregate speed sampling for the live graph (keep last 120 samples ≈ 2 min).
    setInterval(() => {
      const speed = get()
        .queue.filter((t) => t.status === "downloading")
        .reduce((sum, t) => sum + (t.speed || 0), 0);
      set((s) => ({
        speedSamples: [...s.speedSamples, { t: Date.now(), speed }].slice(-120),
      }));
    }, 1000);
  },
}));

function applyTheme(theme: "dark" | "light") {
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
