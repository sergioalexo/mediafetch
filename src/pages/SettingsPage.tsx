import type { ReactNode } from "react";
import { Cookie, FolderOpen, Gauge, Globe, Shield, SlidersHorizontal } from "lucide-react";
import type { Settings } from "@/lib/types";
import { useApp } from "@/lib/store";
import * as api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

const SB_CATEGORIES = [
  ["sponsor", "Sponsor"],
  ["intro", "Intro"],
  ["outro", "Outro"],
  ["selfpromo", "Self-promo"],
  ["interaction", "Interaction reminder"],
  ["music_offtopic", "Non-music section"],
  ["preview", "Preview/recap"],
] as const;

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const toast = useApp((s) => s.toast);

  if (!settings) return null;
  const set = (patch: Partial<Settings>) => void updateSettings(patch);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">Defaults applied to every download</p>
      </div>

      {/* General */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4 text-primary" /> General
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label="Download folder">
            <div className="flex items-center gap-2">
              <span
                className="max-w-64 truncate font-mono text-xs text-muted-foreground"
                title={settings.downloadDir}
              >
                {settings.downloadDir}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const dir = await api.pickDownloadDir();
                  if (dir) set({ downloadDir: dir });
                }}
              >
                Change
              </Button>
            </div>
          </Row>
          <Row label="Parallel downloads" hint={`${settings.maxParallel} at a time`}>
            <Slider
              className="w-40"
              min={1}
              max={8}
              step={1}
              value={[settings.maxParallel]}
              onValueChange={([v]) => set({ maxParallel: v })}
            />
          </Row>
          <Row label="Filename template" hint="yt-dlp output template">
            <Input
              className="w-64 font-mono text-xs"
              value={settings.outputTemplate}
              onChange={(e) => set({ outputTemplate: e.target.value })}
            />
          </Row>
          <Row label="Notifications" hint="Notify when downloads finish">
            <Switch
              checked={settings.notifications}
              onCheckedChange={(v) => set({ notifications: v })}
            />
          </Row>
        </CardContent>
      </Card>

      {/* Media */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SlidersHorizontal className="h-4 w-4 text-primary" /> Media defaults
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label="Embed thumbnail" hint="Cover art in the media file">
            <Switch
              checked={settings.embedThumbnail}
              onCheckedChange={(v) => set({ embedThumbnail: v })}
            />
          </Row>
          <Row label="Embed metadata" hint="Title, uploader, date…">
            <Switch
              checked={settings.embedMetadata}
              onCheckedChange={(v) => set({ embedMetadata: v })}
            />
          </Row>
          <Row label="Embed subtitles" hint="Mux selected subtitles into the video">
            <Switch
              checked={settings.embedSubs}
              onCheckedChange={(v) => set({ embedSubs: v })}
            />
          </Row>
          <Row label="Save subtitle files" hint="Write .srt/.vtt next to the video">
            <Switch
              checked={settings.writeSubs}
              onCheckedChange={(v) => set({ writeSubs: v })}
            />
          </Row>
          <Row label="Default subtitle languages" hint='Comma separated, e.g. "en,ru"'>
            <Input
              className="w-40 font-mono text-xs"
              value={settings.subLangs}
              onChange={(e) => set({ subLangs: e.target.value })}
              placeholder="en"
            />
          </Row>
        </CardContent>
      </Card>

      {/* SponsorBlock */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Shield className="h-4 w-4 text-primary" /> SponsorBlock
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label="Mode" hint="Remove segments or add chapter marks">
            <Select
              value={settings.sponsorblockMode}
              onValueChange={(v) => set({ sponsorblockMode: v as Settings["sponsorblockMode"] })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="remove">Remove segments</SelectItem>
                <SelectItem value="mark">Mark as chapters</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          {settings.sponsorblockMode !== "off" && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 py-3">
              {SB_CATEGORIES.map(([value, label]) => (
                <label key={value} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={settings.sponsorblockCategories.includes(value)}
                    onCheckedChange={(checked) =>
                      set({
                        sponsorblockCategories: checked
                          ? [...settings.sponsorblockCategories, value]
                          : settings.sponsorblockCategories.filter((c) => c !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Network */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Globe className="h-4 w-4 text-primary" /> Network
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label="Speed limit" hint='e.g. "2M" or "500K" — empty for unlimited'>
            <div className="flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="w-28 font-mono text-xs"
                value={settings.rateLimit}
                onChange={(e) => set({ rateLimit: e.target.value })}
                placeholder="unlimited"
              />
            </div>
          </Row>
          <Row label="Proxy" hint="http://, https:// or socks5://">
            <Input
              className="w-64 font-mono text-xs"
              value={settings.proxy}
              onChange={(e) => set({ proxy: e.target.value })}
              placeholder="socks5://127.0.0.1:1080"
            />
          </Row>
          <Row label="Fragments per download" hint="Concurrent connections per file">
            <Slider
              className="w-40"
              min={1}
              max={16}
              step={1}
              value={[settings.concurrentFragments]}
              onValueChange={([v]) => set({ concurrentFragments: v })}
            />
          </Row>
        </CardContent>
      </Card>

      {/* Privacy / advanced */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Cookie className="h-4 w-4 text-primary" /> Cookies &amp; advanced
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label="Cookies from browser" hint="Use your browser session for age/member content">
            <Select
              value={settings.cookiesFromBrowser || "none"}
              onValueChange={(v) => set({ cookiesFromBrowser: v === "none" ? "" : v })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Off</SelectItem>
                <SelectItem value="chrome">Chrome</SelectItem>
                <SelectItem value="firefox">Firefox</SelectItem>
                <SelectItem value="edge">Edge</SelectItem>
                <SelectItem value="brave">Brave</SelectItem>
                <SelectItem value="opera">Opera</SelectItem>
                <SelectItem value="vivaldi">Vivaldi</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Cookies file" hint="Netscape cookies.txt (overrides browser)">
            <div className="flex items-center gap-2">
              <span
                className="max-w-52 truncate font-mono text-xs text-muted-foreground"
                title={settings.cookiesFile}
              >
                {settings.cookiesFile || "not set"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const f = await api.pickCookiesFile();
                  if (f) set({ cookiesFile: f });
                }}
              >
                Browse
              </Button>
              {settings.cookiesFile && (
                <Button variant="ghost" size="sm" onClick={() => set({ cookiesFile: "" })}>
                  Clear
                </Button>
              )}
            </div>
          </Row>
          <Row
            label="Download archive"
            hint="Skip videos that were already downloaded before"
          >
            <Switch
              checked={settings.useDownloadArchive}
              onCheckedChange={(v) => {
                set({ useDownloadArchive: v });
                if (v)
                  toast({
                    title: "Download archive enabled",
                    description: "Already-downloaded videos will be skipped.",
                    variant: "default",
                  });
              }}
            />
          </Row>
        </CardContent>
      </Card>
    </div>
  );
}
