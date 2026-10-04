import { memo, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Film,
  Link2,
  ListVideo,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { DownloadOptions, DownloadTask, Preset } from "@/lib/types";
import { buildDraftItems, draftPlan, useApp, type Draft } from "@/lib/store";
import { useT, type MsgKey } from "@/lib/i18n";
import {
  isAlreadyDownloaded,
  optionsFromPreset,
  presetSummary,
  sourceAbrOf,
  TUNEMYMUSIC_URL,
} from "@/lib/presets";
import { cn, extractUrls, formatDuration, formatEta, groupRank, statusRank } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { QueueItem } from "@/components/QueueItem";
import { PresetDialog } from "@/components/PresetDialog";
import { CommandPreviewDialog } from "@/components/CommandPreviewDialog";
import * as api from "@/lib/api";

export function WorkspacePage() {
  const settings = useApp((s) => s.settings);
  const drafts = useApp((s) => s.drafts);
  const queue = useApp((s) => s.queue);
  const binaries = useApp((s) => s.binaries);
  const addUrls = useApp((s) => s.addUrls);
  const downloadAll = useApp((s) => s.downloadAllDrafts);
  const downloadNext = useApp((s) => s.downloadNextDraft);
  const setDefaultPreset = useApp((s) => s.setDefaultPreset);
  const t = useT();

  const [input, setInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [editPreset, setEditPreset] = useState<Preset | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [queueFilter, setQueueFilter] = useState("");
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [completedCollapsed, setCompletedCollapsed] = useState<boolean | null>(null);

  const activePresetId = settings?.defaultPresetId ?? "";
  const presets = settings?.presets ?? [];

  // Set while Ctrl+Shift+V / Shift+Insert is held so the paste it triggers
  // skips the per-service auto-download rule.
  const bypassNextPaste = useRef(false);

  const commit = (text: string, bypassAuto = false) => {
    if (extractUrls(text).length === 0) return;
    addUrls(text, { bypassAuto });
    setInput("");
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const bypass = bypassNextPaste.current;
    bypassNextPaste.current = false;
    const text = e.clipboardData.getData("text");
    if (extractUrls(text).length > 0) {
      e.preventDefault();
      commit(text, bypass);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const text =
      e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (text) commit(text);
  };

  const readyCount = useMemo(
    () =>
      drafts.reduce((n, d) => {
        if (d.status !== "ready" || !d.result) return n;
        return n + draftPlan(useApp.getState, d).taskCount;
      }, 0),
    // Presets and installed components both feed the plan (a fetch-all preset
    // or gallery-dl collapses a whole link into a single task).
    [drafts, presets, binaries]
  );

  // Position in the backend order, by id — replaces O(n) `queue.indexOf` /
  // `queue.findIndex` calls that used to run once per row, per render.
  const idIndex = useMemo(() => {
    const m = new Map<string, number>();
    queue.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [queue]);

  // Members of each playlist group, precomputed once per queue change —
  // replaces the `queue.filter(... groupId ...)` that used to run for every
  // group row, every render (TaskGroup, and the search filter below).
  const groupsMap = useMemo(() => {
    const m = new Map<string, DownloadTask[]>();
    for (const t of queue) {
      const gid = t.options.groupId;
      if (!gid) continue;
      const arr = m.get(gid);
      if (arr) arr.push(t);
      else m.set(gid, [t]);
    }
    return m;
  }, [queue]);

  // Group live tasks by their playlist groupId (first-seen order), newest
  // download first, then sort for display only: active work at the top,
  // finished work at the bottom (rendered.rank table). The backend queue
  // order still decides what starts next — this never touches it. Tasks
  // inside a group keep their playlist order -- see TaskGroup.
  const rendered = useMemo(() => {
    const seen = new Set<string>();
    const rows: { type: "single" | "group"; task?: DownloadTask; groupId?: string }[] = [];
    for (const task of queue) {
      const gid = task.options.groupId;
      if (gid) {
        if (seen.has(gid)) continue;
        seen.add(gid);
        rows.push({ type: "group", groupId: gid });
      } else {
        rows.push({ type: "single", task });
      }
    }
    rows.reverse();
    const rank = (row: (typeof rows)[number]) =>
      row.type === "single"
        ? statusRank(row.task!.status)
        : groupRank((groupsMap.get(row.groupId!) ?? []).map((t) => t.status));
    return rows
      .map((row, i) => ({ row, i, rank: rank(row) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((r) => r.row);
  }, [queue, groupsMap]);

  const filteredRendered = useMemo(() => {
    const q = queueFilter.trim().toLowerCase();
    if (!q) return rendered;
    const matches = (task: DownloadTask) =>
      task.title.toLowerCase().includes(q) || task.url.toLowerCase().includes(q);
    return rendered.filter((row) => {
      if (row.type === "single") return matches(row.task!);
      const groupTasks = groupsMap.get(row.groupId!) ?? [];
      return groupTasks.some(matches) || (groupTasks[0]?.options.groupTitle ?? "")
        .toLowerCase()
        .includes(q);
    });
  }, [rendered, groupsMap, queueFilter]);

  // Rough ETA across everything currently downloading — bytes remaining over
  // combined active speed. Queued-but-not-started tasks aren't included since
  // there's no reliable speed estimate for them yet.
  const totalEta = useMemo(() => {
    const active = queue.filter((t) => t.status === "downloading" && t.totalBytes > 0);
    const remaining = active.reduce((s, t) => s + Math.max(0, t.totalBytes - t.downloadedBytes), 0);
    const speed = active.reduce((s, t) => s + t.speed, 0);
    return speed > 0 ? remaining / speed : null;
  }, [queue]);

  const resumeAll = () => {
    for (const t of queue) {
      if (t.status === "paused") void api.resumeTask(t.id);
    }
  };

  const reorderableId = (row: (typeof rendered)[number]): string | null =>
    row.type === "single" && row.task && row.task.status !== "downloading" && !["completed", "failed", "cancelled"].includes(row.task.status)
      ? row.task.id
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("nav.download")}</h1>
          <p className="text-sm text-muted-foreground">{t("dl.subtitle")}</p>
        </div>
      </div>

      {/* Preset bar */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("ws.preset")}</span>
        <Select value={activePresetId} onValueChange={(v) => void setDefaultPreset(v)}>
          <SelectTrigger className="h-9 w-56" title={t("tip.presetBar")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  {p.kind === "audio" ? (
                    <AudioLines className="h-3.5 w-3.5" />
                  ) : (
                    <Film className="h-3.5 w-3.5" />
                  )}
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{presetSummary(p, t)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditPreset(presets.find((p) => p.id === activePresetId) ?? null);
            setDialogOpen(true);
          }}
          title={t("tip.editPreset")}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditPreset(null);
            setDialogOpen(true);
          }}
          title={t("tip.newPreset")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Paste box */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-xl border-2 border-dashed p-3 transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border"
        )}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onBlur={() => (bypassNextPaste.current = false)}
          onKeyUp={() => (bypassNextPaste.current = false)}
          title={t("dl.pasteTip")}
          onKeyDown={(e) => {
            if (
              ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") ||
              (e.shiftKey && e.key === "Insert")
            ) {
              bypassNextPaste.current = true;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit(input);
            }
          }}
          placeholder={"https://www.youtube.com/watch?v=…\nhttps://soundcloud.com/…"}
          className="min-h-[64px] resize-none border-0 shadow-none focus-visible:ring-0"
        />
        {extractUrls(input).length > 0 && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            <span>{t("dl.urlsDetected", { n: extractUrls(input).length })}</span>
            <span className="text-muted-foreground/70">· {t("dl.enterHint")}</span>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {t("ws.tuneMyMusicTip")}{" "}
        <button
          onClick={() => void api.openExternal(TUNEMYMUSIC_URL)}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t("ws.tuneMyMusic")}
        </button>
      </p>

      {/* Action bar */}
      {readyCount > 0 && (
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={() => void downloadAll()}>
                <Download className="h-4 w-4" /> {t("ws.downloadAll", { n: readyCount })}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("tip.downloadAll")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" onClick={() => void downloadNext()}>
                <Play className="h-4 w-4" /> {t("ws.downloadNext")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("tip.downloadNext")}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Drafts (staged, not yet downloading) */}
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </AnimatePresence>
      </div>

      {/* Live queue + finished (persist until app restart) */}
      {queue.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>
                {t("q.title")} · {queue.length}
              </span>
              {totalEta != null && <span>· {t("q.totalEta", { eta: formatEta(totalEta) })}</span>}
            </div>
            <div className="flex items-center gap-1">
              {queue.some((t) =>
                ["queued", "downloading", "postprocessing"].includes(t.status)
              ) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={() => void api.pauseAllTasks()}>
                      <Pause className="h-3.5 w-3.5" /> {t("ws.pauseAll")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("tip.pauseAll")}</TooltipContent>
                </Tooltip>
              )}
              {queue.some((t) => t.status === "paused") && (
                <Button variant="ghost" size="sm" onClick={resumeAll}>
                  <Play className="h-3.5 w-3.5" /> {t("q.resumeAll")}
                </Button>
              )}
              {queue.some((t) =>
                ["queued", "downloading", "postprocessing", "paused"].includes(t.status)
              ) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={() => void api.cancelAllTasks()}>
                      <Square className="h-3.5 w-3.5" /> {t("ws.stopAll")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("tip.stopAll")}</TooltipContent>
                </Tooltip>
              )}
              {queue.some((t) => ["completed", "failed", "cancelled"].includes(t.status)) && (
                <Button variant="ghost" size="sm" onClick={() => api.clearFinished()}>
                  <Trash2 className="h-3.5 w-3.5" /> {t("ws.clearDone")}
                </Button>
              )}
            </div>
          </div>

          {queue.length > 4 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={queueFilter}
                onChange={(e) => setQueueFilter(e.target.value)}
                placeholder={t("q.search")}
                className="h-8 pl-8 text-xs"
              />
            </div>
          )}

          {(() => {
            const rowRank = (row: (typeof filteredRendered)[number]) =>
              row.type === "single"
                ? statusRank(row.task!.status)
                : groupRank((groupsMap.get(row.groupId!) ?? []).map((t) => t.status));
            const activeRows = filteredRendered.filter((r) => rowRank(r) < 4);
            const doneRows = filteredRendered.filter((r) => rowRank(r) === 4);
            const collapsed = completedCollapsed ?? doneRows.length > 20;

            const renderRow = (row: (typeof filteredRendered)[number]) => {
              const dragId = reorderableId(row);
              return row.type === "group" ? (
                <TaskGroup
                  key={row.groupId}
                  tasks={groupsMap.get(row.groupId!) ?? []}
                  idIndex={idIndex}
                  queueLength={queue.length}
                />
              ) : (
                <QueueItem
                  key={row.task!.id}
                  task={row.task!}
                  index={idIndex.get(row.task!.id) ?? 0}
                  count={queue.length}
                  compact
                  dragProps={
                    dragId
                      ? {
                          draggable: true,
                          onDragStart: () => setDragTaskId(dragId),
                          onDragOver: (e) => e.preventDefault(),
                          onDrop: (e) => {
                            e.preventDefault();
                            if (dragTaskId && dragTaskId !== dragId) {
                              void api.reorderTask(dragTaskId, idIndex.get(dragId) ?? 0);
                            }
                            setDragTaskId(null);
                          },
                          onDragEnd: () => setDragTaskId(null),
                          dragging: dragTaskId === dragId,
                        }
                      : undefined
                  }
                />
              );
            };

            return (
              <>
                <AnimatePresence initial={false}>{activeRows.map(renderRow)}</AnimatePresence>
                {doneRows.length > 0 && (
                  <button
                    onClick={() => setCompletedCollapsed(!collapsed)}
                    className="flex w-full items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    {t("q.completedCount", { n: doneRows.length })}
                  </button>
                )}
                {!collapsed && (
                  <AnimatePresence initial={false}>{doneRows.map(renderRow)}</AnimatePresence>
                )}
              </>
            );
          })()}
        </div>
      )}

      {drafts.length === 0 && queue.length === 0 && (
        <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">
          {t("ws.empty")}
        </div>
      )}

      <PresetDialog preset={editPreset} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

/**
 * Copy a failed analysis: the URL, the error, and the yt-dlp transcript behind
 * it (the command line included), so it can be pasted straight into a report.
 */
async function copyAnalyzeFailure(draft: Draft, t: (k: MsgKey) => string) {
  const { toast } = useApp.getState();
  const lines = await api.getTaskLog(`analyze:${draft.url}`).catch(() => [] as string[]);
  const text = [draft.url, "", draft.error ?? "", "", ...lines].join("\n").trim();
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: t("ws.errorCopied"), variant: "success" });
  } catch {
    toast({ title: t("dl.clipboardUnavailable"), variant: "error" });
  }
}

/** One staged, analyzed (or analyzing) link. */
function DraftCard({ draft }: { draft: Draft }) {
  const settings = useApp((s) => s.settings);
  const history = useApp((s) => s.history);
  const setDraftPreset = useApp((s) => s.setDraftPreset);
  const toggleEntry = useApp((s) => s.toggleDraftEntry);
  const setAll = useApp((s) => s.setDraftEntriesAll);
  const toggleCollapsed = useApp((s) => s.toggleDraftCollapsed);
  const removeDraft = useApp((s) => s.removeDraft);
  const downloadDraft = useApp((s) => s.downloadDraft);
  const addUrls = useApp((s) => s.addUrls);
  const t = useT();
  const [previewOptions, setPreviewOptions] = useState<DownloadOptions | null>(null);
  const entriesScrollRef = useRef<HTMLDivElement>(null);

  const presets = settings?.presets ?? [];
  const isPlaylist = draft.result?.kind === "playlist";
  const { oneTask } = draftPlan(useApp.getState, draft);
  const entryCount = draft.result?.entries.length ?? 0;
  const entriesVirtualizer = useVirtualizer({
    count: entryCount,
    getScrollElement: () => entriesScrollRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  const previewCommand = () => {
    const items = buildDraftItems(useApp.getState, draft);
    if (items[0]) setPreviewOptions(items[0]);
  };

  const downloadQuickAudio = () => {
    if (!settings || !draft.result || isPlaylist) return;
    const preset =
      settings.presets.find((p) => p.kind === "audio") ??
      settings.presets.find((p) => p.id === settings.defaultPresetId) ??
      settings.presets[0];
    if (!preset) return;
    const opts = optionsFromPreset(
      { ...preset, kind: "audio" },
      {
        url: draft.result.url,
        title: draft.result.title,
        thumbnail: draft.result.thumbnail,
        sourceAbr: sourceAbrOf(draft.result),
      },
      t
    );
    void useApp.getState().enqueueItems([opts]);
    removeDraft(draft.id);
  };

  const presetPicker = (
    <Select value={draft.presetId} onValueChange={(v) => setDraftPreset(draft.id, v)}>
      <SelectTrigger className="h-7 w-40 text-xs" title={t("tip.draftPreset")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {presets.map((p) => (
          <SelectItem key={p.id} value={p.id} className="text-xs">
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 500, damping: 40 }}
      className="rounded-xl border bg-card p-3 shadow-sm"
    >
      {draft.status === "analyzing" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="truncate">{draft.url}</span>
          {draft.autoDownload && (
            <Badge variant="outline" className="ml-auto shrink-0">
              {t("ws.auto")}
            </Badge>
          )}
          <Badge variant="secondary" className={cn("shrink-0", !draft.autoDownload && "ml-auto")}>
            {t("ws.analyzing")}
          </Badge>
        </div>
      )}

      {draft.status === "unsupported" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={draft.url}>
            {draft.url}
          </span>
          <Badge variant="secondary" className="shrink-0">
            {t("ws.unsupported")}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void api.openExternal(TUNEMYMUSIC_URL)}
          >
            <ExternalLink className="h-3.5 w-3.5" /> {t("ws.tuneMyMusic")}
          </Button>
          <Button variant="ghost" size="iconSm" onClick={() => removeDraft(draft.id)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {draft.status === "error" && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={draft.url}>
              {draft.url}
            </span>
            <Badge variant="destructive" className="shrink-0">
              {t("ws.errorStatus")}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => addUrls(draft.url)}>
              {t("ws.retryAnalyze")}
            </Button>
            <Button variant="ghost" size="iconSm" onClick={() => removeDraft(draft.id)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          {draft.error && (
            // What yt-dlp actually said, in full, with a way to take it
            // somewhere useful — the tooltip it used to live in was unusable.
            <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
              <div className="break-words">{draft.error}</div>
              <button
                onClick={() => void copyAnalyzeFailure(draft, t)}
                className="mt-1 flex items-center gap-1 underline underline-offset-2 opacity-70 hover:opacity-100"
              >
                <Terminal className="h-3 w-3" /> {t("ws.copyError")}
              </button>
            </div>
          )}
        </div>
      )}

      {draft.status === "ready" && draft.result && !isPlaylist && (
        <div className="flex items-center gap-3">
          {draft.result.thumbnail ? (
            <img
              src={draft.result.thumbnail}
              alt=""
              className="h-12 w-20 shrink-0 rounded-md object-cover"
              draggable={false}
            />
          ) : (
            <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-md bg-secondary">
              <Film className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={draft.result.title}>
              {draft.result.title}
            </div>
            <div className="mt-1 flex items-center gap-2">
              {presetPicker}
              {isAlreadyDownloaded(history, draft.result.url, draft.result.id) && (
                <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1 text-[10px] font-medium text-amber-500">
                  {t("dl.downloadedBadge")}
                </span>
              )}
            </div>
          </div>
          {presets.find((p) => p.id === draft.presetId)?.kind !== "audio" && (
            <Button
              variant="outline"
              size="iconSm"
              onClick={downloadQuickAudio}
              title={t("tip.audioOnly")}
            >
              <AudioLines className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="iconSm"
            onClick={previewCommand}
            title={t("tip.previewCommand")}
          >
            <Terminal className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={() => void downloadDraft(draft.id)} title={t("tip.downloadOne")}>
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            onClick={() => removeDraft(draft.id)}
            title={t("tip.removeDraft")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {draft.status === "ready" && draft.result && isPlaylist && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => toggleCollapsed(draft.id)}
              className="text-muted-foreground hover:text-foreground"
            >
              {draft.collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
            <ListVideo className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{draft.result.title}</div>
              <div className="text-xs text-muted-foreground">
                {t("ws.tracks", { n: draft.result.entries.length })} ·{" "}
                {t("ws.selectedCount", {
                  a: draft.selected.length,
                  b: draft.result.entries.length,
                })}
                {oneTask && <> · {t("ws.oneTask")}</>}
              </div>
            </div>
            {presetPicker}
            <Button
              variant="ghost"
              size="iconSm"
              onClick={previewCommand}
              disabled={draft.selected.length === 0}
              title={t("tip.previewCommand")}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              onClick={() => void downloadDraft(draft.id)}
              disabled={draft.selected.length === 0}
              title={t("tip.downloadOne")}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={() => removeDraft(draft.id)}
              title={t("tip.removeDraft")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {!draft.collapsed && (
            <div className="ml-6 space-y-0.5">
              <button
                onClick={() =>
                  setAll(draft.id, draft.selected.length !== draft.result!.entries.length)
                }
                className="mb-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {draft.selected.length === draft.result.entries.length
                  ? t("dl.deselectAll")
                  : t("dl.selectAll")}
              </button>
              <div ref={entriesScrollRef} className="max-h-56 overflow-y-auto rounded-md border p-1.5">
                <div
                  style={{
                    height: entriesVirtualizer.getTotalSize(),
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {entriesVirtualizer.getVirtualItems().map((row) => {
                    const entry = draft.result!.entries[row.index];
                    const i = row.index;
                    return (
                      <label
                        key={entry.id + i}
                        className="absolute left-0 top-0 flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
                        style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                      >
                        <Checkbox
                          checked={draft.selected.includes(i)}
                          onCheckedChange={() => toggleEntry(draft.id, i)}
                        />
                        <span className="w-6 shrink-0 text-right text-muted-foreground">
                          {i + 1}.
                        </span>
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        {isAlreadyDownloaded(history, entry.url, entry.id) && (
                          <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/15 px-1 text-[10px] font-medium text-amber-500">
                            {t("dl.downloadedBadge")}
                          </span>
                        )}
                        {entry.duration ? (
                          <span className="shrink-0 font-mono text-muted-foreground">
                            {formatDuration(entry.duration)}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <CommandPreviewDialog options={previewOptions} onClose={() => setPreviewOptions(null)} />
    </motion.div>
  );
}

/** A collapsible header for downloaded/queued tasks that share a playlist. */
const TaskGroup = memo(function TaskGroup({
  tasks,
  idIndex,
  queueLength,
}: {
  tasks: DownloadTask[];
  idIndex: Map<string, number>;
  queueLength: number;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const title = tasks[0].options.groupTitle ?? "Playlist";

  return (
    <div className="rounded-xl border bg-card/60 p-2 shadow-sm">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-1 py-1 text-left"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        <ListVideo className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
        {failed > 0 && (
          <Badge variant="destructive" className="shrink-0">
            {t("q.failedCount", { n: failed })}
          </Badge>
        )}
        <Badge variant="secondary" className="shrink-0">
          {done}/{tasks.length}
        </Badge>
      </button>
      {!collapsed && (
        <div className="mt-1 space-y-1.5 pl-2">
          {tasks.map((task) => (
            <QueueItem
              key={task.id}
              task={task}
              index={idIndex.get(task.id) ?? 0}
              count={queueLength}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
});
