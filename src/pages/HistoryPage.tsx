import { useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HistoryEntry } from "@/lib/types";
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
import { backUpHistory, importHistoryBackup } from "@/lib/historyBackup";
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

  // History is the one record of what was downloaded; one stray click
  // shouldn't be able to wipe it.
  const clearAll = async () => {
    if (!(await ask(t("h.clearConfirm"), { title: t("h.clearAll"), kind: "warning" }))) return;
    await api.clearHistory();
    useApp.setState({ history: [] });
    toast({ title: t("h.cleared"), variant: "default" });
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
          <Button variant="outline" size="sm" onClick={() => void backUpHistory()}>
            <Download className="h-3.5 w-3.5" /> {t("h.backup")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void importHistoryBackup()}>
            <Upload className="h-3.5 w-3.5" /> {t("h.import")}
          </Button>
          {history.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => void clearAll()}>
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

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">
          {history.length === 0 ? t("h.none") : t("h.noMatches")}
        </div>
      ) : (
        <HistoryRows entries={filtered} retryHistoryEntry={retryHistoryEntry} toast={toast} />
      )}
    </div>
  );
}

/**
 * Plain list under 50 rows (the common case — no scroll box, no measuring).
 * Past that, a fixed-height virtualized list: a history of a few thousand
 * entries used to mount every row's thumbnail/buttons/tooltips at once.
 */
function HistoryRows({
  entries,
  retryHistoryEntry,
  toast,
}: {
  entries: HistoryEntry[];
  retryHistoryEntry: (h: HistoryEntry) => Promise<void>;
  toast: ReturnType<typeof useApp.getState>["toast"];
}) {
  const ROW_HEIGHT = 68; // row + gap, measured from the non-virtualized layout
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = entries.length > 50;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (!virtualize) {
    return (
      <div className="space-y-1.5">
        {entries.map((h) => (
          <HistoryRow key={h.id} h={h} retryHistoryEntry={retryHistoryEntry} toast={toast} />
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
      <div
        style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
      >
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={entries[row.index].id}
            className="absolute left-0 top-0 w-full pb-1.5"
            style={{ height: row.size, transform: `translateY(${row.start}px)` }}
          >
            <HistoryRow
              h={entries[row.index]}
              retryHistoryEntry={retryHistoryEntry}
              toast={toast}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryRow({
  h,
  retryHistoryEntry,
  toast,
}: {
  h: HistoryEntry;
  retryHistoryEntry: (h: HistoryEntry) => Promise<void>;
  toast: ReturnType<typeof useApp.getState>["toast"];
}) {
  const t = useT();
  const host = hostname(h.url);
  // The file may have been moved or deleted since; say so instead of
  // leaving an unhandled rejection behind a button that did nothing.
  const tryOpen = (action: () => Promise<void>) =>
    action().catch((e) =>
      toast({ title: t("q.openFailed"), description: String(e), variant: "error" })
    );
  return (
    <div className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
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
                <Button
                  size="iconSm"
                  variant="ghost"
                  onClick={() => void tryOpen(() => api.openFile(h.filename!))}
                >
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
                  onClick={() => void tryOpen(() => api.showInFolder(h.filename!))}
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
                onClick={() =>
                  navigator.clipboard.writeText(h.url).then(
                    () => toast({ title: t("h.urlCopied"), variant: "default" }),
                    () => toast({ title: t("dl.clipboardUnavailable"), variant: "error" })
                  )
                }
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
                // Drop it locally — re-reading the whole history (possibly
                // tens of thousands of entries) for one removal was wasteful.
                useApp.setState((s) => ({ history: s.history.filter((e) => e.id !== h.id) }));
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
}
