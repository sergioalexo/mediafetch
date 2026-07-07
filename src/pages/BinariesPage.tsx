import { useState } from "react";
import { check as checkUpdater } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
  Undo2,
  XCircle,
} from "lucide-react";
import type { BinaryStatus } from "@/lib/types";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import * as api from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const IS_MAC = navigator.userAgent.includes("Mac");

function BinaryCard({ bin }: { bin: BinaryStatus }) {
  // No official macOS FFmpeg builds exist upstream — it comes from Homebrew.
  const homebrewOnly = IS_MAC && bin.name === "ffmpeg";
  const progress = useApp((s) => s.binaryProgress[bin.name]);
  const toast = useApp((s) => s.toast);
  const refresh = useApp((s) => s.refreshBinaries);
  const t = useT();
  const [versions, setVersions] = useState<string[] | null>(null);
  const busy = progress && (progress.phase === "downloading" || progress.phase === "extracting");

  const install = async (version?: string) => {
    try {
      if (version) {
        toast({
          title: t("c.installingVersion", { name: bin.name, v: version }),
          variant: "default",
        });
      }
      await api.installBinary(bin.name, version);
    } catch (e) {
      toast({
        title: t("c.updateFailed", { name: bin.name }),
        description: String(e),
        variant: "error",
      });
    }
  };

  const loadVersions = async () => {
    if (versions) return;
    try {
      setVersions(await api.listBinaryVersions(bin.name));
    } catch (e) {
      toast({
        title: t("c.listFailed", { name: bin.name }),
        description: String(e),
        variant: "error",
      });
    }
  };

  const rollback = async () => {
    try {
      await api.rollbackBinary(bin.name);
      toast({
        title: t("c.switchedTo", { name: bin.name, v: bin.previousVersion ?? "" }),
        description: t("c.switchBack"),
        variant: "success",
      });
      await refresh(true);
    } catch (e) {
      toast({
        title: t("c.rollbackFailed", { name: bin.name }),
        description: String(e),
        variant: "error",
      });
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
                      <ArrowUpCircle className="h-3 w-3" /> {t("c.updateAvailable")}
                    </Badge>
                  ) : (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" /> {t("c.upToDate")}
                    </Badge>
                  )
                ) : (
                  <Badge variant="destructive" className="gap-1">
                    <XCircle className="h-3 w-3" /> {t("c.notInstalled")}
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

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {homebrewOnly ? (
              !bin.installed && (
                <div className="max-w-52 rounded-lg border px-3 py-2 text-right text-xs text-muted-foreground">
                  {t("c.homebrew1")}
                  <div className="mt-0.5 select-text font-mono text-foreground">
                    brew install ffmpeg
                  </div>
                  {t("c.homebrew2")}
                </div>
              )
            ) : bin.installed && !bin.updateAvailable ? null : (
              <Button size="sm" onClick={() => install()} disabled={!!busy}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {bin.installed ? t("c.update") : t("c.install")}
              </Button>
            )}
            {bin.previousVersion && bin.previousVersion !== bin.currentVersion && (
              <Button size="sm" variant="outline" onClick={rollback} disabled={!!busy}>
                <Undo2 className="h-3.5 w-3.5" /> {t("c.rollback")}
              </Button>
            )}
            {!homebrewOnly && (
            <Select
              value=""
              onValueChange={(tag) => void install(tag)}
              onOpenChange={(open) => {
                if (open) void loadVersions();
              }}
              disabled={!!busy}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder={t("c.otherVersion")} />
              </SelectTrigger>
              <SelectContent>
                {versions === null && (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> {t("c.loadingReleases")}
                  </div>
                )}
                {versions?.map((v) => (
                  <SelectItem key={v} value={v} className="font-mono text-xs">
                    {v}
                    {v === bin.currentVersion || v === bin.latestVersion
                      ? v === bin.currentVersion
                        ? `  ${t("c.installed")}`
                        : `  ${t("c.latest")}`
                      : ""}
                  </SelectItem>
                ))}
                {versions?.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t("c.noReleases")}
                  </div>
                )}
              </SelectContent>
            </Select>
            )}
          </div>
        </div>

        <div
          className={
            bin.previousVersion
              ? "mt-4 grid grid-cols-3 gap-3 text-sm"
              : "mt-4 grid grid-cols-2 gap-3 text-sm"
          }
        >
          <div className="rounded-lg bg-secondary/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("c.installedVersion")}</div>
            <div className="font-mono font-medium">
              {bin.currentVersion ?? "—"}
            </div>
          </div>
          <div className="rounded-lg bg-secondary/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("c.latestRelease")}</div>
            <div className="font-mono font-medium">{bin.latestVersion ?? "…"}</div>
          </div>
          {bin.previousVersion && (
            <div className="rounded-lg bg-secondary/50 px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("c.rollbackVersion")}</div>
              <div className="font-mono font-medium">{bin.previousVersion}</div>
            </div>
          )}
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
                ? t("c.extracting")
                : `${t("c.downloading")} ${formatBytes(progress.downloaded)}${
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

function AppUpdateCard() {
  const appUpdate = useApp((s) => s.appUpdate);
  const toast = useApp((s) => s.toast);
  const t = useT();
  const [installing, setInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  if (!appUpdate) return null;

  const installUpdate = async () => {
    setInstalling(true);
    try {
      const update = await checkUpdater();
      if (!update) {
        toast({
          title: t("c.noUpdate"),
          description: t("c.alreadyLatest"),
          variant: "default",
        });
        return;
      }
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
          setUpdateProgress({ downloaded: 0, total });
        } else if (e.event === "Progress") {
          downloaded += e.data.chunkLength;
          setUpdateProgress({ downloaded, total });
        }
      });
      // On Windows the app exits while the installer runs; this is a no-op there.
      await relaunch();
    } catch (e) {
      toast({
        title: t("c.selfUpdateFailed"),
        description: t("c.openingReleases", { e: String(e) }),
        variant: "error",
      });
      void api.openExternal(appUpdate.releasesUrl);
    } finally {
      setInstalling(false);
      setUpdateProgress(null);
    }
  };

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary shadow-lg shadow-primary/25">
              <Download className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">MediaFetch</span>
                {appUpdate.updateAvailable ? (
                  <Badge className="gap-1">
                    <ArrowUpCircle className="h-3 w-3" /> {t("c.updateAvailable")}
                  </Badge>
                ) : (
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {t("c.upToDate")}
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void api.openExternal(appUpdate.releasesUrl)}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                {appUpdate.releasesUrl.replace("https://", "")}{" "}
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>
          {appUpdate.updateAvailable && (
            <Button size="sm" onClick={installUpdate} disabled={installing}>
              {installing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t("c.installUpdate")}
            </Button>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-secondary/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("c.installedVersion")}</div>
            <div className="font-mono font-medium">v{appUpdate.currentVersion}</div>
          </div>
          <div className="rounded-lg bg-secondary/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("c.latestRelease")}</div>
            <div className="font-mono font-medium">
              {appUpdate.latestVersion ? `v${appUpdate.latestVersion}` : "—"}
            </div>
          </div>
        </div>

        {updateProgress && (
          <div className="mt-3">
            <Progress
              value={
                updateProgress.total > 0
                  ? (updateProgress.downloaded / updateProgress.total) * 100
                  : undefined
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {t("c.downloading")} {formatBytes(updateProgress.downloaded)}
              {updateProgress.total > 0 ? ` / ${formatBytes(updateProgress.total)}` : ""}
            </div>
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
  const checkAppUpdate = useApp((s) => s.checkAppUpdate);
  const t = useT();

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{t("c.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("c.subtitle")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refresh(true);
            void checkAppUpdate();
          }}
          disabled={loading}
        >
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          {t("c.checkUpdates")}
        </Button>
      </div>

      <div className="space-y-3">
        <AppUpdateCard />
        {binaries.map((b) => (
          <BinaryCard key={b.name} bin={b} />
        ))}
        {binaries.length === 0 && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-14 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("c.checking")}
          </div>
        )}
      </div>
    </div>
  );
}
