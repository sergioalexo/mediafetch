import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type {
  AppUpdateStatus,
  BinaryProgress,
  BinaryStatus,
  DownloadTask,
  HistoryEntry,
  Settings,
} from "./types";
import * as api from "./api";

export type Page = "downloads" | "queue" | "history" | "stats" | "settings" | "binaries";

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
      if (entry.status === "completed") {
        get().toast({
          title: "Download complete",
          description: entry.title,
          variant: "success",
        });
      } else {
        get().toast({
          title: "Download failed",
          description: entry.title,
          variant: "error",
        });
      }
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

// Convenient selectors
export const useQueue = () => useApp((s) => s.queue);
export const useSettings = () => useApp((s) => s.settings);
