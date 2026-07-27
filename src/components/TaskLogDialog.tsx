import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy } from "lucide-react";
import * as api from "@/lib/api";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

interface TaskLogLine {
  id: string;
  line: string;
}

/** Live stdout/stderr transcript for one task — the "open a terminal" view. */
export function TaskLogDialog({
  taskId,
  title,
  onClose,
}: {
  taskId: string | null;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setLines([]);
    void api.getTaskLog(taskId).then((initial) => {
      if (!cancelled) setLines(initial);
    });
    const unlisten = listen<TaskLogLine>("task-log", (e) => {
      if (e.payload.id !== taskId) return;
      setLines((prev) => [...prev, e.payload.line]);
    });
    return () => {
      cancelled = true;
      void unlisten.then((f) => f());
    };
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <Dialog open={!!taskId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{t("log.title", { title })}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-96 rounded-md border bg-black/90">
          <div className="select-text p-3 font-mono text-[11px] leading-relaxed text-green-400">
            {lines.length === 0 ? (
              <div className="text-muted-foreground">{t("log.empty")}</div>
            ) : (
              lines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap break-all",
                    /error/i.test(l) && "text-red-400"
                  )}
                >
                  {l}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
        <DialogFooter>
          {lines.some((l) => /error/i.test(l)) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(
                  lines.filter((l) => /error/i.test(l)).join("\n")
                );
                toast({ title: t("log.copied"), variant: "default" });
              }}
            >
              <Copy className="h-3.5 w-3.5" /> {t("log.copyErrors")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(lines.join("\n"));
              toast({ title: t("log.copied"), variant: "default" });
            }}
          >
            <Copy className="h-3.5 w-3.5" /> {t("log.copyAll")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
