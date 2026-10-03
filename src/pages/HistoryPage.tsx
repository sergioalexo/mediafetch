import { useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Music,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import * as api from "@/lib/api";
import { cn, formatBytes, formatDate, formatEta, formatSpeed, hostname } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type StatusFilter = "all" | "completed" | "failed";

export function HistoryPage() {
  const history = useApp((s) => s.history);
  const toast = useApp((s) => s.toast);
  const retryHistoryEntry = useApp((s) => s.retryHistoryEntry);
  const t = useT();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const counts = useMemo(() => {
    let completed = 0;
    let failed = 0;
    for (const h of history) {
      if (h.status === "completed") completed++;
      else if (h.status === "failed") failed++;
    }
    return { completed, failed };
  }, [history]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter((h) => {
      if (statusFilter !== "all" && h.status !== statusFilter) return false;
      if (!q) return true;
      return h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q);
    });
  }, [history, query, statusFilter]);

  const refresh = async () => {
    const items = await api.getHistory();
    useApp.setState({ history: items });
  };

  const backUp = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `mediafetch-history-${date}.mediafetch-history.json`,
      filters: [{ name: "MediaFetch history", extensions: ["mediafetch-history.json", "json"] }],
    });
    if (!path) return;
    const n = await api.exportHistory(path);
    toast({ title: t("h.backedUp", { n }), variant: "default" });
  };

  const importBackup = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "MediaFetch history", extensions: ["mediafetch-history.json", "json"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const report = await api.importHistory(path);
      await refresh();
      toast({
        title: t("h.imported", { n: report.added }),
        description: t("h.importedSkipped", { n: report.skipped }),
        variant: "default",
      });
    } catch (e) {
      toast({ title: t("h.importFailed"), description: String(e), variant: "error" });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{t("h.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("h.recordedSplit", { ok: counts.completed, failed: counts.failed })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void backUp()}>
            <Download className="h-3.5 w-3.5" /> {t("h.backup")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void importBackup()}>
            <Upload className="h-3.5 w-3.5" /> {t("h.import")}
          </Button>
          {history.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await api.clearHistory();
                await refresh();
                toast({ title: t("h.cleared"), variant: "default" });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> {t("h.clearAll")}
            </Button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("h.search")}
          className="pl-9"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {(["all", "completed", "failed"] as StatusFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
              statusFilter === f
                ? "border-primary bg-primary/10 text-primary"
                : "border-transparent text-muted-foreground hover:bg-accent"
            )}
          >
            {f === "all" && t("h.filterAll")}
            {f === "completed" && t("h.filterDownloaded")}
            {f === "failed" && t("h.filterFailed")}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        {filtered.map((h) => {
          const host = hostname(h.url);
          return (
          <div
            key={h.id}
            className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary">
              {h.kind === "audio" ? (
                <Music className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Video className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={h.title}>
                {h.title}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {host && (
                  <span className="inline-flex items-center gap-1" title={h.url}>
                    <Globe className="h-3 w-3" /> {host}
                  </span>
                )}
                <span>{host ? "· " : ""}{formatDate(h.downloadedAt)}</span>
                {h.filesize > 0 && <span>· {formatBytes(h.filesize)}</span>}
                {h.elapsedSecs > 0 && <span>· {t("h.took", { t: formatEta(h.elapsedSecs) })}</span>}
                {h.avgSpeed > 0 && (
                  <span>
                    · {formatSpeed(h.avgSpeed)} {t("h.avg")}
                  </span>
                )}
                {h.formatNote && <span>· {h.formatNote}</span>}
              </div>
            </div>
            {h.status === "failed" && <Badge variant="destructive">{t("h.failed")}</Badge>}
            <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              {h.status === "failed" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="iconSm"
                      variant="ghost"
                      onClick={async () => {
                        await retryHistoryEntry(h);
                        toast({ title: t("h.retried"), variant: "default" });
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("h.retry")}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="iconSm" variant="ghost" onClick={() => void api.openExternal(h.url)}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("q.openLink")}</TooltipContent>
              </Tooltip>
              {h.filename && h.status === "completed" && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="iconSm" variant="ghost" onClick={() => api.openFile(h.filename!)}>
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("h.openFile")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="iconSm"
                        variant="ghost"
                        onClick={() => api.showInFolder(h.filename!)}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("q.showInFolder")}</TooltipContent>
                  </Tooltip>
                </>
              )}
              {h.url && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="iconSm"
                      variant="ghost"
                      onClick={async () => {
                        await navigator.clipboard.writeText(h.url);
                        toast({ title: t("h.urlCopied"), variant: "default" });
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("h.copyUrl")}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="iconSm"
                    variant="ghost"
                    onClick={async () => {
                      await api.removeHistoryEntry(h.id);
                      await refresh();
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("h.removeEntry")}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">
            {history.length === 0 ? t("h.none") : t("h.noMatches")}
          </div>
        )}
      </div>
    </div>
  );
}
