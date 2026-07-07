import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AudioFormat, BitrateMode, DownloadKind, Preset } from "@/lib/types";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [bitrateMode, setBitrateMode] = useState<BitrateMode>("cbr");
  const [subLangs, setSubLangs] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? "");
    setKind(preset?.kind ?? "video");
    setVideoPreset(preset?.videoPreset ?? "best");
    setAudioFormat(preset?.audioFormat ?? "mp3");
    setBitrateMode(preset?.bitrateMode ?? "cbr");
    setSubLangs(preset?.subtitleLangs ?? "");
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
      bitrateMode,
      subtitleLangs: kind === "video" && subLangs.trim() ? subLangs.trim() : null,
      embedSubs: kind === "video" && subLangs.trim() ? true : null,
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
              bitrateMode={bitrateMode}
              onBitrateModeChange={setBitrateMode}
            />
          )}
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
