import { memo, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bug,
  Copy,
  ExternalLink,
  FolderOpen,
  Music,
  Pause,
  Play,
  RotateCcw,
  Terminal,
  Trash2,
  Video,
  X,
} from "lucide-react";
import type { DownloadTask } from "@/lib/types";
import * as api from "@/lib/api";
import { openIssueReport } from "@/lib/report";
import { useT, type MsgKey } from "@/lib/i18n";
import { cn, formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TaskLogDialog } from "@/components/TaskLogDialog";

const STATUS_LABEL: Record<DownloadTask["status"], MsgKey> = {
  queued: "q.status.queued",
  downloading: "q.status.downloading",
  postprocessing: "q.status.postprocessing",
  paused: "q.status.paused",
  completed: "q.status.completed",
  failed: "q.status.failed",
  cancelled: "q.status.cancelled",
};

function statusBadgeVariant(status: DownloadTask["status"]) {
  switch (status) {
    case "completed":
      return "success" as const;
    case "failed":
      return "destructive" as const;
    case "downloading":
    case "postprocessing":
      return "default" as const;
    default:
      return "secondary" as const;
  }
}

function IconButton({
  tip,
  onClick,
  children,
  variant = "ghost",
}: {
  tip: string;
  onClick: () => void;
  children: ReactNode;
  variant?: "ghost" | "destructive";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="iconSm" variant={variant} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export const QueueItem = memo(function QueueItem({
  task,
  index,
  count,
  compact = false,
  dragProps,
}: {
  task: DownloadTask;
  index: number;
  count: number;
  compact?: boolean;
  /** Native HTML5 drag-and-drop handlers for manual queue reordering. */
  dragProps?: {
    draggable?: boolean;
    onDragStart?: () => void;
    onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
    onDrop?: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnd?: () => void;
    dragging?: boolean;
  };
}) {
  const t = useT();
  const [showLog, setShowLog] = useState(false);
  const active = task.status === "downloading" || task.status === "postprocessing";
  const finished =
    task.status === "completed" || task.status === "failed" || task.status === "cancelled";

  return (
    <div
      // A cheap CSS fade-in instead of a Framer Motion layout animation —
      // the previous version ran a spring on every one of 300 rows on every
      // reorder/status change. Framer Motion stays for page transitions and
      // dialogs, where there's one of them, not hundreds.
      draggable={dragProps?.draggable}
      onDragStart={dragProps?.onDragStart}
      onDragOver={dragProps?.onDragOver}
      onDrop={dragProps?.onDrop}
      onDragEnd={dragProps?.onDragEnd}
      className={cn(
        "queue-row-in rounded-xl border bg-card shadow-sm",
        compact ? "p-2" : "p-3",
        active && "border-primary/30",
        dragProps?.dragging && "opacity-50"
      )}
    >
      <div className={cn("flex", compact ? "gap-2.5" : "gap-3")}>
        {task.thumbnail ? (
          <img
            src={task.thumbnail}
            alt=""
            className={cn(
              "shrink-0 rounded-md object-cover",
              compact ? "h-12 w-20" : "h-16 w-28"
            )}
            draggable={false}
          />
        ) : (
          <div
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md bg-secondary",
              compact ? "h-12 w-20" : "h-16 w-28"
            )}
          >
            {task.options.kind === "audio" ? (
              <Music className="h-6 w-6 text-muted-foreground" />
            ) : (
              <Video className="h-6 w-6 text-muted-foreground" />
            )}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" title={task.title}>
                {task.title || task.url}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant={statusBadgeVariant(task.status)} className="px-1.5 py-0">
                  {t(STATUS_LABEL[task.status])}
                </Badge>
                {task.options.formatNote && <span>{task.options.formatNote}</span>}
                {task.options.kind === "audio" && task.options.audioFormat && (
                  <span className="uppercase">{task.options.audioFormat}</span>
                )}
                {task.playlistCount != null && task.playlistIndex != null && (
                  <span>{t("q.itemOf", { i: task.playlistIndex, n: task.playlistCount })}</span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton tip={t("q.openLink")} onClick={() => void api.openExternal(task.url)}>
                <ExternalLink className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton tip={t("q.viewLog")} onClick={() => setShowLog(true)}>
                <Terminal className="h-3.5 w-3.5" />
              </IconButton>
              {index > 0 && !finished && task.status !== "downloading" && (
                <IconButton tip={t("q.moveUp")} onClick={() => api.reorderTask(task.id, index - 1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {index < count - 1 && !finished && task.status !== "downloading" && (
                <IconButton
                  tip={t("q.moveDown")}
                  onClick={() => api.reorderTask(task.id, index + 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {(task.status === "downloading" || task.status === "queued") && (
                <IconButton tip={t("q.pause")} onClick={() => api.pauseTask(task.id)}>
                  <Pause className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {task.status === "paused" && (
                <IconButton tip={t("q.resume")} onClick={() => api.resumeTask(task.id)}>
                  <Play className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {(task.status === "failed" || task.status === "cancelled") && (
                <IconButton tip={t("q.retry")} onClick={() => api.retryTask(task.id)}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {task.status === "failed" && (
                <IconButton
                  tip={t("q.report")}
                  onClick={() =>
                    void openIssueReport("bug", {
                      url: task.url,
                      error: task.error ?? undefined,
                    })
                  }
                >
                  <Bug className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {task.status === "completed" && task.filename && (
                <IconButton
                  tip={t("q.showInFolder")}
                  onClick={() => api.showInFolder(task.filename!)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </IconButton>
              )}
              {!finished ? (
                <IconButton tip={t("q.cancel")} onClick={() => api.cancelTask(task.id)}>
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              ) : (
                <IconButton tip={t("q.remove")} onClick={() => api.removeTask(task.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </div>
          </div>

          {task.status === "postprocessing" ? (
            <div className="mt-2">
              <Progress
                value={100}
                className="h-1.5"
                indicatorClassName="animate-pulse opacity-60"
              />
              <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                {t("q.converting")}
              </div>
            </div>
          ) : (
            (active || task.status === "paused") && (
              <div className="mt-2">
                <Progress
                  value={task.progress}
                  className={cn("h-1.5", task.status === "paused" && "opacity-50")}
                />
                <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span>
                    {formatBytes(task.downloadedBytes)}
                    {task.totalBytes > 0 && ` / ${formatBytes(task.totalBytes)}`}
                    {"  ·  "}
                    {task.progress.toFixed(1)}%
                  </span>
                  {task.status === "downloading" && (
                    <span>
                      {formatSpeed(task.speed)} · ETA {formatEta(task.eta)}
                    </span>
                  )}
                </div>
              </div>
            )
          )}

          {task.status === "failed" && task.error && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
              <span className="min-w-0 flex-1 select-text truncate" title={task.error}>
                {task.error}
              </span>
              <button
                type="button"
                className="shrink-0 opacity-70 hover:opacity-100"
                title={t("q.copyError")}
                onClick={() => void navigator.clipboard.writeText(task.error ?? "")}
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>
      <TaskLogDialog
        taskId={showLog ? task.id : null}
        title={task.title || task.url}
        onClose={() => setShowLog(false)}
      />
    </div>
  );
});
