import { useState } from "react";
import {
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  RotateCcw,
  ScrollText,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { useT, type MsgKey } from "@/lib/i18n";
import * as api from "@/lib/api";
import { presetSummary, sampleRateLabel, TUNEMYMUSIC_URL } from "@/lib/presets";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Step = "hello" | "intro" | "disclaimer" | "components" | "defaults" | "done";
const STEPS: Step[] = ["hello", "intro", "disclaimer", "components", "defaults", "done"];

/** Install order matters here: Deno before yt-dlp would be backwards, but
 * yt-dlp works (just without JS-challenge support) if Deno fails, so the
 * sequence is least-to-most optional. */
const IS_MAC = navigator.userAgent.includes("Mac");
const COMPONENTS: { name: string; purpose: MsgKey }[] = [
  { name: "yt-dlp", purpose: "c.purpose.ytdlp" },
  { name: "ffmpeg", purpose: "c.purpose.ffmpeg" },
  { name: "deno", purpose: "c.purpose.deno" },
  { name: "gallery-dl", purpose: "c.purpose.gallerydl" },
];

/**
 * First-run setup: Hello -> Introduction -> Disclaimer -> Components ->
 * Defaults -> Done. Non-dismissable (no outside click / Escape) until Skip
 * or Finish, so it can't be half-abandoned into a confusing state.
 */
export function OnboardingDialog() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const binaries = useApp((s) => s.binaries);
  const binaryProgress = useApp((s) => s.binaryProgress);
  const refreshBinaries = useApp((s) => s.refreshBinaries);
  const t = useT();

  const [step, setStep] = useState<Step>("hello");
  const [installing, setInstalling] = useState(false);
  const [failedComponents, setFailedComponents] = useState<Set<string>>(new Set());
  const [continueAnyway, setContinueAnyway] = useState(false);

  // Don't flash before settings load (same guard as DisclaimerDialog), and
  // never show it again once finished.
  if (!settings || settings.onboardingCompleted) return null;

  const stepIndex = STEPS.indexOf(step);

  const finish = () => {
    void updateSettings({ onboardingCompleted: true });
  };

  const installAll = async () => {
    setInstalling(true);
    setContinueAnyway(false);
    const failed = new Set<string>();
    for (const c of COMPONENTS) {
      const already = binaries.find((b) => b.name === c.name)?.installed;
      // No upstream macOS FFmpeg build exists to install — it comes from
      // Homebrew, which the row below explains instead of a failed install.
      if (already || (IS_MAC && c.name === "ffmpeg")) continue;
      try {
        await api.installBinary(c.name);
      } catch {
        failed.add(c.name);
      }
      await refreshBinaries(false);
    }
    setFailedComponents(failed);
    setInstalling(false);
  };

  const retryOne = async (name: string) => {
    setInstalling(true);
    try {
      await api.installBinary(name);
      setFailedComponents((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    } catch {
      setFailedComponents((prev) => new Set(prev).add(name));
    }
    await refreshBinaries(false);
    setInstalling(false);
  };

  const allDone = COMPONENTS.every((c) => {
    const bin = binaries.find((b) => b.name === c.name);
    return bin?.installed || failedComponents.has(c.name) || (IS_MAC && c.name === "ffmpeg");
  });

  const audioPreset =
    settings.presets.find((p) => p.id === "audio-mp3-320") ??
    settings.presets.find((p) => p.kind === "audio");

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-w-xl"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 pt-1">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={`h-1.5 w-6 rounded-full transition-colors ${
                i <= stepIndex ? "bg-primary" : "bg-secondary"
              }`}
            />
          ))}
        </div>

        {step === "hello" && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <h1 className="text-3xl font-bold">{t("ob.hello")}</h1>
            <Button size="lg" onClick={() => setStep("intro")}>
              {t("ob.helloBtn")}
            </Button>
          </div>
        )}

        {step === "intro" && (
          <div className="space-y-4 py-4">
            <DialogHeader>
              <DialogTitle>{t("ob.introTitle")}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t("ob.introP1")}</p>
            <p className="text-sm text-muted-foreground">{t("ob.introP2")}</p>
            <DialogFooter className="justify-between">
              <Button variant="ghost" onClick={finish}>
                {t("ob.skip")}
              </Button>
              <Button onClick={() => setStep("disclaimer")}>{t("ob.continueSetup")}</Button>
            </DialogFooter>
          </div>
        )}

        {step === "disclaimer" && (
          <div className="space-y-3 py-2">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ScrollText className="h-5 w-5 text-primary" /> {t("d.title")}
              </DialogTitle>
              <DialogDescription>{t("d.subtitle")}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[40vh] space-y-3 overflow-y-auto text-sm text-muted-foreground">
              <p>{t("d.p1")}</p>
              <p>{t("d.p2")}</p>
              <p>{t("d.p3")}</p>
              <p>{t("d.p4")}</p>
              <p>{t("d.p5")}</p>
            </div>
            <DialogFooter className="justify-between">
              <Button
                variant="ghost"
                onClick={() => {
                  // Skip here still requires accepting before any download
                  // runs — DisclaimerDialog's blocking modal is the fallback.
                  finish();
                }}
              >
                {t("ob.skip")}
              </Button>
              <Button
                onClick={() => {
                  void updateSettings({ disclaimerAccepted: true });
                  setStep("components");
                }}
              >
                {t("d.accept")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "components" && (
          <div className="space-y-3 py-2">
            <DialogHeader>
              <DialogTitle>{t("ob.componentsTitle")}</DialogTitle>
              <DialogDescription>{t("ob.componentsSubtitle")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {COMPONENTS.map((c) => {
                const bin = binaries.find((b) => b.name === c.name);
                const prog = binaryProgress[c.name];
                const failed = failedComponents.has(c.name);
                const done = !!bin?.installed && !failed;
                const active =
                  installing && prog && (prog.phase === "downloading" || prog.phase === "extracting");
                return (
                  <div key={c.name} className="rounded-lg border p-2.5">
                    <div className="flex items-center gap-2">
                      {done ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                      ) : failed ? (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      ) : active ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : (
                        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="text-sm font-medium">{c.name}</span>
                      {failed && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto"
                          disabled={installing}
                          onClick={() => void retryOne(c.name)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> {t("ob.retry")}
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{t(c.purpose)}</p>
                    {IS_MAC && c.name === "ffmpeg" && !bin?.installed && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t("c.homebrew1")}{" "}
                        <code className="select-text font-mono text-foreground">
                          brew install ffmpeg
                        </code>{" "}
                        {t("c.homebrew2")}
                      </p>
                    )}
                    {active && (
                      <Progress
                        value={
                          prog.total > 0 ? Math.min(100, (prog.downloaded / prog.total) * 100) : 0
                        }
                        className="mt-1.5 h-1"
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {!allDone && !installing && (
              <Button className="w-full" onClick={() => void installAll()}>
                <Download className="h-4 w-4" /> {t("ob.installAll")}
              </Button>
            )}
            {failedComponents.size > 0 && !continueAnyway && (
              <button
                onClick={() => setContinueAnyway(true)}
                className="block w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {t("ob.continueAnyway")}
              </button>
            )}
            <DialogFooter className="justify-between">
              <Button variant="ghost" onClick={finish}>
                {t("ob.skip")}
              </Button>
              <Button
                disabled={!allDone && !continueAnyway}
                onClick={() => setStep("defaults")}
              >
                {t("ob.continueSetup")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "defaults" && (
          <div className="space-y-4 py-2">
            <DialogHeader>
              <DialogTitle>{t("ob.defaultsTitle")}</DialogTitle>
              <DialogDescription>{t("ob.defaultsSubtitle")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between rounded-lg border p-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate" title={settings.downloadDir}>
                    {settings.downloadDir}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const dir = await api.pickDownloadDir();
                    if (dir) void updateSettings({ downloadDir: dir });
                  }}
                >
                  {t("set.change")}
                </Button>
              </div>
              {audioPreset && (
                <div className="flex items-center justify-between rounded-lg border p-2.5 text-sm">
                  <span className="text-muted-foreground">{t("ob.audioDefault")}</span>
                  <span className="font-medium">
                    {presetSummary(audioPreset, t, settings.audioSampleRate)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between rounded-lg border p-2.5 text-sm">
                <span className="text-muted-foreground">{t("set.sampleRate")}</span>
                <span className="font-medium">{sampleRateLabel(settings.audioSampleRate, t)}</span>
              </div>
            </div>
            <DialogFooter className="justify-end">
              <Button onClick={() => setStep("done")}>{t("ob.continueSetup")}</Button>
            </DialogFooter>
          </div>
        )}

        {step === "done" && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <Sparkles className="h-10 w-10 text-primary" />
            <h2 className="text-xl font-bold">{t("ob.doneTitle")}</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("ws.tuneMyMusicTip")}{" "}
              <button
                onClick={() => void api.openExternal(TUNEMYMUSIC_URL)}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t("ws.tuneMyMusic")}
              </button>
            </p>
            <Button size="lg" onClick={finish}>
              {t("ob.start")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
