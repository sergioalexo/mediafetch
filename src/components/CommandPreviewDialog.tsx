import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import * as api from "@/lib/api";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import type { DownloadOptions } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Preview the exact yt-dlp command line a preset+link would run, before downloading. */
export function CommandPreviewDialog({
  options,
  onClose,
}: {
  options: DownloadOptions | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!options) return;
    setCommand("");
    setError(null);
    api.previewCommand(options).then(setCommand, (e) => setError(String(e)));
  }, [options]);

  return (
    <Dialog open={!!options} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("cmd.title")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 overflow-auto rounded-md border bg-black/90 p-3">
          <code className="select-text whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-green-400">
            {error ? <span className="text-red-400">{error}</span> : command || "…"}
          </code>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={!command}
            onClick={() => {
              void navigator.clipboard.writeText(command);
              toast({ title: t("log.copied"), variant: "default" });
            }}
          >
            <Copy className="h-3.5 w-3.5" /> {t("cmd.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
