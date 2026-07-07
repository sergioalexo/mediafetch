// Reusable per-download option controls, shared by the preset editor.

import { AudioLines, Film, Music } from "lucide-react";
import type { AudioFormat, AudioQuality, DownloadKind } from "@/lib/types";
import {
  AUDIO_FORMATS,
  AUDIO_QUALITIES,
  LOSSY_FORMATS,
  VIDEO_PRESETS,
  videoPresetLabel,
} from "@/lib/presets";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function KindTabs({
  kind,
  setKind,
}: {
  kind: DownloadKind;
  setKind: (k: DownloadKind) => void;
}) {
  const t = useT();
  return (
    <Tabs value={kind} onValueChange={(v) => setKind(v as DownloadKind)}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="video">
          <Film className="h-3.5 w-3.5" /> {t("dl.video")}
        </TabsTrigger>
        <TabsTrigger value="audio">
          <AudioLines className="h-3.5 w-3.5" /> {t("dl.audioOnly")}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export function VideoPresetSelect({
  preset,
  setPreset,
}: {
  preset: string;
  setPreset: (p: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{t("dl.qualityPreset")}</Label>
      <Select value={preset} onValueChange={setPreset}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VIDEO_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {videoPresetLabel(p.value, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AudioOptions({
  format,
  onFormatChange,
  quality,
  onQualityChange,
}: {
  format: AudioFormat;
  onFormatChange: (v: AudioFormat) => void;
  quality: AudioQuality;
  onQualityChange: (v: AudioQuality) => void;
}) {
  const t = useT();
  const showQuality = LOSSY_FORMATS.includes(format);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("dl.audioFormat")}</Label>
        <div className="grid grid-cols-3 gap-2">
          {AUDIO_FORMATS.map((f) => (
            <button
              key={f.value}
              onClick={() => onFormatChange(f.value)}
              className={cn(
                "flex flex-col items-center rounded-lg border px-2 py-2 text-xs transition-colors",
                format === f.value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              <Music className="mb-1 h-3.5 w-3.5" />
              <span className="font-semibold">{f.label}</span>
              <span className="text-[10px] opacity-70">{t(f.hint)}</span>
            </button>
          ))}
        </div>
      </div>
      {showQuality && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t("dl.bitrate")}</Label>
          <Select value={quality} onValueChange={(v) => onQualityChange(v as AudioQuality)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUDIO_QUALITIES.map((q) => (
                <SelectItem key={q.value} value={q.value}>
                  {q.label ?? t(q.value === "match" ? "dl.qMatchShort" : "dl.qVbrShort")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground opacity-70">
            {t(AUDIO_QUALITIES.find((q) => q.value === quality)?.hint ?? "dl.qMatch")}
          </p>
        </div>
      )}
    </div>
  );
}
