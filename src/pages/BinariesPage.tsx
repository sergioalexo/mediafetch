import {
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import type { BinaryStatus } from "@/lib/types";
import { useApp } from "@/lib/store";
import * as api from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

function BinaryCard({ bin }: { bin: BinaryStatus }) {
  const progress = useApp((s) => s.binaryProgress[bin.name]);
  const toast = useApp((s) => s.toast);
  const busy = progress && (progress.phase === "downloading" || progress.phase === "extracting");

  const install = async () => {
    try {
      await api.installBinary(bin.name);
    } catch (e) {
      toast({ title: `Failed to update ${bin.name}`, description: String(e), variant: "error" });
    }
  };

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Terminal className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{bin.name}</span>
                {bin.installed ? (
                  bin.updateAvailable ? (
                    <Badge className="gap-1">
                      <ArrowUpCircle className="h-3 w-3" /> Update available
                    </Badge>
                  ) : (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Up to date
                    </Badge>
                  )
                ) : (
                  <Badge variant="destructive" className="gap-1">
                    <XCircle className="h-3 w-3" /> Not installed
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void api.openExternal(bin.repoUrl)}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                {bin.repoUrl.replace("https://", "")} <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="shrink-0">
            {bin.installed && !bin.updateAvailable ? null : (
              <Button size="sm" onClick={install} disabled={!!busy}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {bin.installed ? "Update" : "Install"}
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-secondary/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">Installed version</div>
            <div className="font-mono font-medium">
              {bin.currentVersion ?? "—"}
            </div>
          </div>
          <div className="rounded-lg bg-secondary/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">Latest release</div>
            <div className="font-mono font-medium">{bin.latestVersion ?? "checking…"}</div>
          </div>
        </div>

        {busy && (
          <div className="mt-3">
            <Progress
              value={
                progress.total > 0 ? (progress.downloaded / progress.total) * 100 : undefined
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {progress.phase === "extracting"
                ? "Extracting…"
                : `Downloading ${formatBytes(progress.downloaded)}${
                    progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""
                  }`}
            </div>
          </div>
        )}

        {bin.path && (
          <div className="mt-3 truncate font-mono text-[11px] text-muted-foreground" title={bin.path}>
            {bin.path}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BinariesPage() {
  const binaries = useApp((s) => s.binaries);
  const loading = useApp((s) => s.binariesLoading);
  const refresh = useApp((s) => s.refreshBinaries);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Components</h1>
          <p className="text-sm text-muted-foreground">
            MediaFetch is powered by yt-dlp and FFmpeg. Manage their versions here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading}>
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          Check for updates
        </Button>
      </div>

      <div className="space-y-3">
        {binaries.map((b) => (
          <BinaryCard key={b.name} bin={b} />
        ))}
        {binaries.length === 0 && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-14 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking components…
          </div>
        )}
      </div>
    </div>
  );
}
