import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ListMusic, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { WatchedPlaylist } from "@/lib/types";
import { flushSettings, useApp } from "@/lib/store";
import { useLang, useT } from "@/lib/i18n";
import { shortcutFromEvent, shortcutLabel } from "@/lib/playlistSync";
import * as api from "@/lib/api";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** "5 minutes ago" in the UI language, from unix seconds. */
function ago(lang: string, unixSecs: number): string {
  const secs = Math.round(unixSecs - Date.now() / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  }
  return rtf.format(0, "second");
}

/** Press-a-combination field for the global sync hotkey. */
function ShortcutRow() {
  const settings = useApp((s) => s.settings)!;
  const t = useT();
  const [capturing, setCapturing] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const combo = shortcutFromEvent(e);
      if (combo) {
        setCandidate(combo);
        setCapturing(false);
        setError(null);
      } else if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
        setError(t("pl.needModifier"));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, t]);

  const apply = async (shortcut: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.setPlaylistSyncShortcut(shortcut);
      // The backend saved it; mirror locally without a second save round trip.
      useApp.setState({ settings: { ...useApp.getState().settings!, playlistSyncShortcut: shortcut } });
      setCandidate(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const current = settings.playlistSyncShortcut;
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("pl.shortcut")}</div>
          <div className="text-xs text-muted-foreground">{t("pl.shortcutHint")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <kbd className="rounded-md border bg-muted px-2 py-1 font-mono text-xs">
            {capturing
              ? t("pl.press")
              : candidate
                ? shortcutLabel(candidate)
                : current
                  ? shortcutLabel(current)
                  : t("pl.shortcutNone")}
          </kbd>
          {candidate ? (
            <>
              <Button size="sm" onClick={() => void apply(candidate)} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("pd.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCandidate(null)}>
                {t("pd.cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setCapturing((c) => !c);
                }}
              >
                {t("pl.change")}
              </Button>
              {current && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void apply("")}
                  disabled={saving}
                >
                  {t("pl.disable")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function PlaylistRow({ playlist }: { playlist: WatchedPlaylist }) {
  const settings = useApp((s) => s.settings)!;
  const updateSettings = useApp((s) => s.updateSettings);
  const lang = useLang();
  const t = useT();

  const patch = (p: Partial<WatchedPlaylist>) =>
    void updateSettings({
      watchedPlaylists: settings.watchedPlaylists.map((w) =>
        w.id === playlist.id ? { ...w, ...p } : w
      ),
    });

  const remove = async () => {
    if (!(await ask(t("pl.removeConfirm"), { title: playlist.title, kind: "warning" }))) return;
    await updateSettings({
      watchedPlaylists: settings.watchedPlaylists.filter((w) => w.id !== playlist.id),
    });
    await flushSettings();
    await api.deletePlaylistArchive(playlist.id).catch(() => {});
  };

  return (
    <div className="space-y-1.5 py-3">
      <div className="flex items-center gap-3">
        <Switch checked={playlist.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        <div className="min-w-0 flex-1">
          <Input
            className="h-7 border-transparent px-1.5 text-sm font-medium shadow-none hover:border-input focus-visible:border-input"
            value={playlist.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
          <div className="truncate px-1.5 text-[11px] text-muted-foreground">{playlist.url}</div>
        </div>
        <Select value={playlist.presetId} onValueChange={(v) => patch({ presetId: v })}>
          <SelectTrigger className="w-44">
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
        <Button
          size="icon"
          variant="ghost"
          className="text-destructive"
          title={t("pl.remove")}
          onClick={() => void remove()}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="pl-12 text-xs">
        {playlist.lastError ? (
          <span className="text-destructive">{playlist.lastError}</span>
        ) : playlist.lastChecked ? (
          <span className="text-muted-foreground">
            {t("pl.checkedAgo", { when: ago(lang, playlist.lastChecked) })}
            {playlist.lastNewCount != null && ` · ${t("pl.newCount", { n: playlist.lastNewCount })}`}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("pl.neverChecked")}</span>
        )}
      </div>
    </div>
  );
}

/** Settings card: the watched-playlist list, Sync now, and the sync hotkey. */
export function PlaylistSection() {
  const settings = useApp((s) => s.settings);
  const running = useApp((s) => s.playlistSync.running);
  const syncPlaylists = useApp((s) => s.syncPlaylists);
  const t = useT();
  const [adding, setAdding] = useState(false);

  if (!settings) return null;
  const playlists = settings.watchedPlaylists;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <ListMusic className="h-4 w-4 text-primary" /> {t("pl.title")}
          </span>
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void syncPlaylists()}
              disabled={running || !playlists.some((p) => p.enabled)}
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {running ? t("pl.syncing") : t("pl.syncNow")}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> {t("pl.add")}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        {playlists.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">{t("pl.empty")}</p>
        ) : (
          playlists.map((p) => <PlaylistRow key={p.id} playlist={p} />)
        )}
        <ShortcutRow />
        <p className="pt-3 text-xs text-muted-foreground">{t("pl.hint")}</p>
      </CardContent>
      <PlaylistDialog open={adding} onOpenChange={setAdding} />
    </Card>
  );
}
