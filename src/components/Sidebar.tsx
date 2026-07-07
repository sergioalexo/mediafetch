import { motion } from "framer-motion";
import {
  Download,
  History,
  ListOrdered,
  Moon,
  Package,
  BarChart3,
  Settings,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { useApp, type Page } from "@/lib/store";
import { useT, type MsgKey } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import logoBlack from "@/assets/logo-sergioalexo-black.svg";
import logoWhite from "@/assets/logo-sergioalexo-white.svg";

const NAV: { page: Page; label: MsgKey; icon: typeof Download }[] = [
  { page: "downloads", label: "nav.download", icon: Download },
  { page: "queue", label: "nav.queue", icon: ListOrdered },
  { page: "history", label: "nav.history", icon: History },
  { page: "stats", label: "nav.stats", icon: BarChart3 },
  { page: "binaries", label: "nav.components", icon: Package },
  { page: "settings", label: "nav.settings", icon: Settings },
];

export function Sidebar() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const queue = useApp((s) => s.queue);
  const binaries = useApp((s) => s.binaries);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);

  const appUpdate = useApp((s) => s.appUpdate);
  const t = useT();

  const activeCount = queue.filter(
    (t) => t.status === "downloading" || t.status === "queued" || t.status === "postprocessing"
  ).length;
  const updatesAvailable =
    binaries.filter((b) => b.updateAvailable || !b.installed).length +
    (appUpdate?.updateAvailable ? 1 : 0);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card/50">
      <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-lg shadow-primary/25">
          <Download className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <button
            onClick={() => void api.openExternal("https://sergioalexo.com")}
            title="sergioalexo.com"
            className="block opacity-100 transition-opacity hover:opacity-70"
          >
            <img
              src={logoBlack}
              alt="SERGIO ALEXO"
              draggable={false}
              className="mb-1 h-2.5 w-auto select-none dark:hidden"
            />
            <img
              src={logoWhite}
              alt="SERGIO ALEXO"
              draggable={false}
              className="mb-1 hidden h-2.5 w-auto select-none dark:block"
            />
          </button>
          <div className="text-sm font-bold leading-tight">
            <span className="text-muted-foreground">/ </span>MediaFetch
          </div>
          <div className="text-[10px] text-muted-foreground">
            {appUpdate ? `v${appUpdate.currentVersion} · ` : ""}yt-dlp · ffmpeg
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ page: p, label, icon: Icon }) => {
          const active = page === p;
          return (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={cn(
                "relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {active && (
                <motion.div
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-lg bg-accent"
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
              <Icon className="relative z-10 h-4 w-4" />
              <span className="relative z-10 flex-1 text-left font-medium">{t(label)}</span>
              {p === "queue" && activeCount > 0 && (
                <Badge className="relative z-10 h-5 min-w-5 justify-center px-1.5">
                  {activeCount}
                </Badge>
              )}
              {p === "binaries" && updatesAvailable > 0 && (
                <span className="relative z-10 h-2 w-2 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <button
          onClick={() =>
            updateSettings({ theme: settings?.theme === "dark" ? "light" : "dark" })
          }
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {settings?.theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          <span className="font-medium">
            {settings?.theme === "dark" ? t("theme.light") : t("theme.dark")}
          </span>
        </button>
      </div>
    </aside>
  );
}
