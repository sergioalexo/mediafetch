// The log book: every command MediaFetch runs and every line those tools
// print, across downloads and analyses alike. Release builds are windowed and
// have no console, so this is the only place a failure can be read in full —
// and copied into a bug report.

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Copy, Search, Terminal, Trash2, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import type { AppLogLine } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Filter = "all" | "errors";

/** "14:32:07" on the user's clock. */
function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false });
}

/** yt-dlp marks its own errors; commands are the lines we prefix with "$". */
function isError(l: AppLogLine): boolean {
  return /ERROR|\[error\]|Traceback/.test(l.line);
}

function toText(lines: AppLogLine[]): string {
  return lines.map((l) => `[${clock(l.ts)}] ${l.scope}: ${l.line}`).join("\n");
}

export function LogsPage() {
  const logs = useApp((s) => s.appLog);
  const clearLog = useApp((s) => s.clearAppLog);
  const toast = useApp((s) => s.toast);
  const t = useT();

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((l) => {
      if (filter === "errors" && !isError(l)) return false;
      if (!q) return true;
      return l.line.toLowerCase().includes(q) || l.scope.toLowerCase().includes(q);
    });
  }, [logs, filter, query]);

  // Up to 5000 lines, appended several times a second during a download:
  // only the ones in view are mounted. Lines wrap, so each is measured.
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => boxRef.current,
    estimateSize: () => 18,
    overscan: 20,
    getItemKey: (i) => visible[i].seq,
  });

  // Keep the newest line in view while following, the way a terminal does.
  useEffect(() => {
    if (!follow) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [visible, follow]);

  const copy = async () => {
    if (visible.length === 0) return;
    try {
      await navigator.clipboard.writeText(toText(visible));
      toast({ title: t("book.copied", { n: visible.length }), variant: "success" });
    } catch {
      toast({ title: t("dl.clipboardUnavailable"), variant: "error" });
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t("book.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("book.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            <Copy className="h-3.5 w-3.5" /> {t("book.copyVisible")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void clearLog()}>
            <Trash2 className="h-3.5 w-3.5" /> {t("book.clear")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {(["all", "errors"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                filter === f
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(f === "all" ? "book.filterAll" : "book.filterErrors")}
            </button>
          ))}
        </div>

        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("book.search")}
            className="h-8 pl-9 pr-8 text-xs"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Button
          variant={follow ? "default" : "outline"}
          size="sm"
          onClick={() => setFollow((v) => !v)}
          title={t("book.followHint")}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" /> {t("book.follow")}
        </Button>
        <Badge variant="secondary" className="font-mono">
          {t("book.lines", { n: visible.length })}
        </Badge>
      </div>

      <div
        ref={boxRef}
        onWheel={() => setFollow(false)}
        className="h-[calc(100vh-15rem)] overflow-auto rounded-xl border bg-card/60 p-3 font-mono text-[11px] leading-relaxed"
      >
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Terminal className="h-6 w-6" />
            <span className="text-xs">{t("book.empty")}</span>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const l = visible[row.index];
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 flex w-full gap-2 whitespace-pre-wrap break-all"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <span className="shrink-0 select-none text-muted-foreground/60">
                    {clock(l.ts)}
                  </span>
                  <span
                    className="w-32 shrink-0 select-none truncate text-muted-foreground/60"
                    title={l.scope}
                  >
                    {l.scope}
                  </span>
                  <span
                    className={cn(
                      isError(l)
                        ? "text-destructive"
                        : l.line.startsWith("$")
                          ? "text-primary"
                          : "text-foreground/80"
                    )}
                  >
                    {l.line}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
