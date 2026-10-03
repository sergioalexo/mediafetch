import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AudioFormat, AudioQuality, DownloadKind, Preset, SampleRate } from "@/lib/types";
import { presetAudioQuality } from "@/lib/presets";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AudioOptions, KindTabs, VideoPresetSelect } from "@/components/PresetControls";

let presetSeq = 0;

/** Create or edit a preset. Pass `preset` to edit, or null to create. */
export function PresetDialog({
  preset,
  open,
  onOpenChange,
}: {
  preset: Preset | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const t = useT();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<DownloadKind>("video");
  const [videoPreset, setVideoPreset] = useState("best");
  const [audioFormat, setAudioFormat] = useState<AudioFormat>("mp3");
  const [audioQuality, setAudioQuality] = useState<AudioQuality>("match");
  const [sampleRate, setSampleRate] = useState<SampleRate | null>(null);
  const [subLangs, setSubLangs] = useState("");
  const [fetchAll, setFetchAll] = useState(false);
  const [useGallery, setUseGallery] = useState(false);
  const [customYtdlpArgs, setCustomYtdlpArgs] = useState("");
  const [customFfmpegArgs, setCustomFfmpegArgs] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? "");
    setKind(preset?.kind ?? "video");
    setVideoPreset(preset?.videoPreset ?? "best");
    setAudioFormat(preset?.audioFormat ?? "mp3");
    setAudioQuality(preset ? presetAudioQuality(preset) : "match");
    setSampleRate(preset?.sampleRate ?? null);
    setSubLangs(preset?.subtitleLangs ?? "");
    setFetchAll(!!preset?.fetchAll);
    setUseGallery(preset?.engine === "gallerydl");
    setCustomYtdlpArgs(preset?.customYtdlpArgs ?? "");
    setCustomFfmpegArgs(preset?.customFfmpegArgs ?? "");
  }, [open, preset]);

  if (!settings) return null;

  const save = () => {
    const trimmed = name.trim() || (kind === "audio" ? "Audio" : "Video");
    const next: Preset = {
      id: preset?.id ?? `preset-${Date.now()}-${++presetSeq}`,
      name: trimmed,
      kind,
      videoPreset,
      audioFormat,
      audioQuality,
      sampleRate: kind === "audio" ? sampleRate : null,
      subtitleLangs: kind === "video" && subLangs.trim() ? subLangs.trim() : null,
      embedSubs: kind === "video" && subLangs.trim() ? true : null,
      fetchAll: kind === "video" && fetchAll ? true : null,
      engine: kind === "video" && useGallery ? "gallerydl" : null,
      customYtdlpArgs: customYtdlpArgs.trim() || null,
      customFfmpegArgs: customFfmpegArgs.trim() || null,
    };
    const presets = preset
      ? settings.presets.map((p) => (p.id === preset.id ? next : p))
      : [...settings.presets, next];
    void updateSettings({ presets, defaultPresetId: settings.defaultPresetId || next.id });
    onOpenChange(false);
  };

  const remove = () => {
    if (!preset || settings.presets.length <= 1) return;
    const presets = settings.presets.filter((p) => p.id !== preset.id);
    const defaultPresetId =
      settings.defaultPresetId === preset.id ? presets[0].id : settings.defaultPresetId;
    // Drop service mappings that pointed at the removed preset.
    const servicePresets = Object.fromEntries(
      Object.entries(settings.servicePresets ?? {}).filter(([, v]) => v !== preset.id)
    );
    void updateSettings({ presets, defaultPresetId, servicePresets });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{preset ? t("pd.edit") : t("pd.new")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("pd.name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("pd.namePlaceholder")}
            />
          </div>

          <KindTabs kind={kind} setKind={setKind} />

          {kind === "video" ? (
            <>
              <VideoPresetSelect preset={videoPreset} setPreset={setVideoPreset} />
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={fetchAll}
                  onCheckedChange={(v) => setFetchAll(v === true)}
                />
                <span className="space-y-0.5">
                  <span className="block text-xs font-medium">{t("pd.fetchAll")}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {t("pd.fetchAllHint")}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={useGallery}
                  onCheckedChange={(v) => setUseGallery(v === true)}
                />
                <span className="space-y-0.5">
                  <span className="block text-xs font-medium">{t("pd.useGallery")}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {t("pd.useGalleryHint")}
                  </span>
                </span>
              </label>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("pd.subLangs")}</Label>
                <Input
                  className="font-mono text-xs"
                  value={subLangs}
                  onChange={(e) => setSubLangs(e.target.value)}
                  placeholder="en,uk"
                />
              </div>
            </>
          ) : (
            <AudioOptions
              format={audioFormat}
              onFormatChange={setAudioFormat}
              quality={audioQuality}
              onQualityChange={setAudioQuality}
              sampleRate={sampleRate}
              onSampleRateChange={setSampleRate}
            />
          )}

          <div className="space-y-3 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">{t("pd.advanced")}</p>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("pd.customYtdlp")}</Label>
              <Textarea
                className="min-h-[44px] font-mono text-xs"
                value={customYtdlpArgs}
                onChange={(e) => setCustomYtdlpArgs(e.target.value)}
                placeholder="--extractor-args youtube:player_client=web,default"
              />
              <p className="text-[11px] text-muted-foreground">{t("pd.customYtdlpHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("pd.customFfmpeg")}</Label>
              <Textarea
                className="min-h-[44px] font-mono text-xs"
                value={customFfmpegArgs}
                onChange={(e) => setCustomFfmpegArgs(e.target.value)}
                placeholder="-vf scale=1280:-2"
              />
              <p className="text-[11px] text-muted-foreground">{t("pd.customFfmpegHint")}</p>
            </div>
          </div>
        </div>

        <DialogFooter className="justify-between">
          {preset && settings.presets.length > 1 ? (
            <Button variant="ghost" className="text-destructive" onClick={remove}>
              <Trash2 className="h-3.5 w-3.5" /> {t("pd.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("pd.cancel")}
            </Button>
            <Button onClick={save}>{t("pd.save")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
