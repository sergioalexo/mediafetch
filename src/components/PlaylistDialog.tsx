import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { WatchedPlaylist } from "@/lib/types";
import { flushSettings, useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MUSIC_320_PRESET_ID = "audio-mp3-320";

/** Add a watched playlist: validate the link, pick a preset and a starting point. */
export function PlaylistDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const t = useT();

  const [url, setUrl] = useState("");
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<{ title: string; count: number } | null>(null);
  const [title, setTitle] = useState("");
  const [presetId, setPresetId] = useState("");
  const [onlyNew, setOnlyNew] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setProbed(null);
    setTitle("");
    setOnlyNew(true);
    setError(null);
    const presets = useApp.getState().settings?.presets ?? [];
    setPresetId(
      presets.find((p) => p.id === MUSIC_320_PRESET_ID)?.id ??
        useApp.getState().settings?.defaultPresetId ??
        ""
    );
  }, [open]);

  if (!settings) return null;

  const check = async () => {
    setProbing(true);
    setError(null);
    setProbed(null);
    try {
      // The probe reads the saved cookie/proxy settings.
      await flushSettings();
      const r = await api.probePlaylist(url.trim());
      setProbed(r);
      setTitle(r.title);
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  };

  const add = async () => {
    if (!probed) return;
    setAdding(true);
    setError(null);
    const id = crypto.randomUUID();
    try {
      // "Only new songs" is the archive being pre-filled with today's list.
      if (onlyNew) await api.seedPlaylistArchive(id, url.trim());
      const playlist: WatchedPlaylist = {
        id,
        url: url.trim(),
        title: title.trim() || probed.title,
        enabled: true,
        presetId,
      };
      await updateSettings({ watchedPlaylists: [...settings.watchedPlaylists, playlist] });
      await flushSettings();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const modes = [
    { only: true, label: t("pl.modeNew"), hint: t("pl.modeNewHint") },
    { only: false, label: t("pl.modeAll"), hint: t("pl.modeAllHint") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("pl.add")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("pl.url")}</Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setProbed(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url.trim() && !probing) void check();
                }}
                placeholder={t("pl.urlPlaceholder")}
                autoFocus
              />
              <Button variant="outline" onClick={() => void check()} disabled={!url.trim() || probing}>
                {probing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("pl.check")}
              </Button>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          {probed && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("pl.nameLabel")} · {t("pl.found", { n: probed.count })}
                </Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("pl.preset")}</Label>
                <Select value={presetId} onValueChange={setPresetId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {settings.presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                {modes.map((m) => (
                  <label
                    key={String(m.only)}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5",
                      onlyNew === m.only && "border-primary ring-1 ring-primary"
                    )}
                  >
                    <input
                      type="radio"
                      name="playlist-start"
                      className="mt-0.5 accent-[hsl(var(--primary))]"
                      checked={onlyNew === m.only}
                      onChange={() => setOnlyNew(m.only)}
                    />
                    <span className="space-y-0.5">
                      <span className="block text-xs font-medium">{m.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("pd.cancel")}
          </Button>
          <Button onClick={() => void add()} disabled={!probed || !presetId || adding}>
            {adding && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("pl.addBtn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
