import { useMemo, useState, type ClipboardEvent, type DragEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Download,
  Film,
  Link2,
  ListVideo,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { DownloadTask, Preset } from "@/lib/types";
import { useApp, type Draft } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { isAlreadyDownloaded, presetSummary } from "@/lib/presets";
import { cn, extractUrls, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueueItem } from "@/components/QueueItem";
import { PresetDialog } from "@/components/PresetDialog";
import * as api from "@/lib/api";

export function WorkspacePage() {
  const settings = useApp((s) => s.settings);
  const drafts = useApp((s) => s.drafts);
  const queue = useApp((s) => s.queue);
  const addUrls = useApp((s) => s.addUrls);
  const downloadAll = useApp((s) => s.downloadAllDrafts);
  const downloadNext = useApp((s) => s.downloadNextDraft);
  const setDefaultPreset = useApp((s) => s.setDefaultPreset);
  const t = useT();

  const [input, setInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [editPreset, setEditPreset] = useState<Preset | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const activePresetId = settings?.defaultPresetId ?? "";
  const presets = settings?.presets ?? [];

  const commit = (text: string) => {
    if (extractUrls(text).length === 0) return;
    addUrls(text);
    setInput("");
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (extractUrls(text).length > 0) {
      e.preventDefault();
      commit(text);
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
        return n + (d.result.kind === "playlist" ? d.selected.length : 1);
      }, 0),
    [drafts]
  );

  // Group live tasks by their playlist groupId, preserving first-seen order.
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
    return rows;
  }, [queue]);

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
          <SelectTrigger className="h-9 w-56">
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
          title={t("ws.managePresets")}
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
          title={t("set.newPreset")}
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit(input);
            }
          }}
          placeholder={"https://www.youtube.com/watch?v=…\nhttps://soundcloud.com/…"}
          className="min-h-[64px] resize-none border-0 shadow-none focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            {extractUrls(input).length > 0
              ? t("dl.urlsDetected", { n: extractUrls(input).length })
              : t("dl.noUrls")}
          </div>
          <Button size="sm" onClick={() => commit(input)} disabled={extractUrls(input).length === 0}>
            <ClipboardPaste className="h-3.5 w-3.5" /> {t("dl.paste")}
          </Button>
        </div>
      </div>

      {/* Action bar */}
      {readyCount > 0 && (
        <div className="flex items-center gap-2">
          <Button onClick={() => void downloadAll()}>
            <Download className="h-4 w-4" /> {t("ws.downloadAll", { n: readyCount })}
          </Button>
          <Button variant="outline" onClick={() => void downloadNext()}>
            <Play className="h-4 w-4" /> {t("ws.downloadNext")}
          </Button>
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
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("q.title")} · {queue.length}
            </span>
            {queue.some((t) => ["completed", "failed", "cancelled"].includes(t.status)) && (
              <Button variant="ghost" size="sm" onClick={() => api.clearFinished()}>
                <Trash2 className="h-3.5 w-3.5" /> {t("ws.clearDone")}
              </Button>
            )}
          </div>
          <AnimatePresence initial={false}>
            {rendered.map((row) =>
              row.type === "group" ? (
                <TaskGroup key={row.groupId} groupId={row.groupId!} />
              ) : (
                <QueueItem
                  key={row.task!.id}
                  task={row.task!}
                  index={queue.indexOf(row.task!)}
                  count={queue.length}
                  compact
                />
              )
            )}
          </AnimatePresence>
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

  const presets = settings?.presets ?? [];
  const isPlaylist = draft.result?.kind === "playlist";

  const presetPicker = (
    <Select value={draft.presetId} onValueChange={(v) => setDraftPreset(draft.id, v)}>
      <SelectTrigger className="h-7 w-40 text-xs">
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
          <Badge variant="secondary" className="ml-auto shrink-0">
            {t("ws.analyzing")}
          </Badge>
        </div>
      )}

      {draft.status === "error" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={draft.error ?? ""}>
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
          <Button size="sm" onClick={() => void downloadDraft(draft.id)}>
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="iconSm" onClick={() => removeDraft(draft.id)}>
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
              </div>
            </div>
            {presetPicker}
            <Button
              size="sm"
              onClick={() => void downloadDraft(draft.id)}
              disabled={draft.selected.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="iconSm" onClick={() => removeDraft(draft.id)}>
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
              <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
                {draft.result.entries.map((entry, i) => (
                  <label
                    key={entry.id + i}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
                  >
                    <Checkbox
                      checked={draft.selected.includes(i)}
                      onCheckedChange={() => toggleEntry(draft.id, i)}
                    />
                    <span className="w-6 shrink-0 text-right text-muted-foreground">{i + 1}.</span>
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
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

/** A collapsible header for downloaded/queued tasks that share a playlist. */
function TaskGroup({ groupId }: { groupId: string }) {
  const queue = useApp((s) => s.queue);
  const [collapsed, setCollapsed] = useState(false);
  const tasks = queue.filter((t) => t.options.groupId === groupId);
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
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
              index={queue.indexOf(task)}
              count={queue.length}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}
