import { useState, type ReactNode } from "react";
import {
  AudioLines,
  Cookie,
  Film,
  FolderOpen,
  Gauge,
  Globe,
  Info,
  Layers,
  Pencil,
  Plus,
  ScrollText,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import type { Preset, Settings } from "@/lib/types";
import { useApp } from "@/lib/store";
import { LANGUAGES, useT, type MsgKey } from "@/lib/i18n";
import { presetSummary, SERVICES } from "@/lib/presets";
import { PresetDialog } from "@/components/PresetDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const SB_CATEGORIES: [string, MsgKey][] = [
  ["sponsor", "set.sbSponsor"],
  ["intro", "set.sbIntro"],
  ["outro", "set.sbOutro"],
  ["selfpromo", "set.sbSelfpromo"],
  ["interaction", "set.sbInteraction"],
  ["music_offtopic", "set.sbOfftopic"],
  ["preview", "set.sbPreview"],
];

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
  const setShowDisclaimer = useApp((s) => s.setShowDisclaimer);
  const t = useT();
  const [editPreset, setEditPreset] = useState<Preset | null>(null);
  const [presetDialog, setPresetDialog] = useState(false);
  const [tplGuide, setTplGuide] = useState(false);

  if (!settings) return null;
  const set = (patch: Partial<Settings>) => void updateSettings(patch);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">{t("set.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("set.subtitle")}</p>
      </div>

      {/* General */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4 text-primary" /> {t("set.general")}
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label={t("set.language")}>
            <Select
              value={settings.language ?? "en"}
              onValueChange={(v) => set({ language: v as Settings["language"] })}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map(({ value, label, Flag }) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      <Flag /> {label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("set.downloadFolder")}>
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
                {t("set.change")}
              </Button>
            </div>
          </Row>
          <Row label={t("set.parallel")} hint={t("set.atATime", { n: settings.maxParallel })}>
            <Slider
              className="w-40"
              min={1}
              max={8}
              step={1}
              value={[settings.maxParallel]}
              onValueChange={([v]) => set({ maxParallel: v })}
            />
          </Row>
          <Row label={t("set.template")} hint={t("set.templateHint")}>
            <div className="flex items-center gap-1.5">
              <Input
                className="w-64 font-mono text-xs"
                value={settings.outputTemplate}
                onChange={(e) => set({ outputTemplate: e.target.value })}
              />
              <Button
                variant="ghost"
                size="iconSm"
                onClick={() => setTplGuide(true)}
                title={t("tpl.info")}
              >
                <Info className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Row>
          <Row label={t("set.notifications")} hint={t("set.notificationsHint")}>
            <Switch
              checked={settings.notifications}
              onCheckedChange={(v) => set({ notifications: v })}
            />
          </Row>
        </CardContent>
      </Card>

      {/* Presets */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" /> {t("set.presets")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditPreset(null);
                setPresetDialog(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" /> {t("set.newPreset")}
            </Button>
          </CardTitle>
          <p className="text-xs text-muted-foreground">{t("set.presetsHint")}</p>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {settings.presets.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              {p.kind === "audio" ? (
                <AudioLines className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted-foreground">{presetSummary(p, t)}</span>
              {settings.defaultPresetId === p.id && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t("set.defaultPreset")}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {settings.defaultPresetId !== p.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => set({ defaultPresetId: p.id })}
                  >
                    {t("set.defaultPreset")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="iconSm"
                  onClick={() => {
                    setEditPreset(p);
                    setPresetDialog(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}

          {/* Per-service defaults */}
          <div className="pt-3">
            <div className="text-sm font-medium">{t("set.servicePresets")}</div>
            <div className="text-xs text-muted-foreground">{t("set.servicePresetsHint")}</div>
            <div className="mt-2 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              {SERVICES.map((svc) => (
                <div key={svc.key} className="flex items-center justify-between gap-2 py-1">
                  <span className="text-sm">{svc.label}</span>
                  <Select
                    value={settings.servicePresets?.[svc.key] ?? "default"}
                    onValueChange={(v) => {
                      const sp = { ...(settings.servicePresets ?? {}) };
                      if (v === "default") delete sp[svc.key];
                      else sp[svc.key] = v;
                      set({ servicePresets: sp });
                    }}
                  >
                    <SelectTrigger className="h-7 w-40 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default" className="text-xs">
                        {t("set.useGlobalDefault")}
                      </SelectItem>
                      {settings.presets.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="text-xs">
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Media */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SlidersHorizontal className="h-4 w-4 text-primary" /> {t("set.media")}
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label={t("set.embedThumb")} hint={t("set.embedThumbHint")}>
            <Switch
              checked={settings.embedThumbnail}
              onCheckedChange={(v) => set({ embedThumbnail: v })}
            />
          </Row>
          <Row label={t("set.embedMeta")} hint={t("set.embedMetaHint")}>
            <Switch
              checked={settings.embedMetadata}
              onCheckedChange={(v) => set({ embedMetadata: v })}
            />
          </Row>
          <Row label={t("set.embedSubs")} hint={t("set.embedSubsHint")}>
            <Switch
              checked={settings.embedSubs}
              onCheckedChange={(v) => set({ embedSubs: v })}
            />
          </Row>
          <Row label={t("set.writeSubs")} hint={t("set.writeSubsHint")}>
            <Switch
              checked={settings.writeSubs}
              onCheckedChange={(v) => set({ writeSubs: v })}
            />
          </Row>
          <Row label={t("set.subLangs")} hint={t("set.subLangsHint")}>
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
          <Row label={t("set.sbMode")} hint={t("set.sbModeHint")}>
            <Select
              value={settings.sponsorblockMode}
              onValueChange={(v) => set({ sponsorblockMode: v as Settings["sponsorblockMode"] })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t("set.sbOff")}</SelectItem>
                <SelectItem value="remove">{t("set.sbRemove")}</SelectItem>
                <SelectItem value="mark">{t("set.sbMark")}</SelectItem>
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
                  {t(label)}
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
            <Globe className="h-4 w-4 text-primary" /> {t("set.network")}
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label={t("set.speedLimit")} hint={t("set.speedLimitHint")}>
            <div className="flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="w-28 font-mono text-xs"
                value={settings.rateLimit}
                onChange={(e) => set({ rateLimit: e.target.value })}
                placeholder={t("set.unlimited")}
              />
            </div>
          </Row>
          <Row label={t("set.proxy")} hint={t("set.proxyHint")}>
            <Input
              className="w-64 font-mono text-xs"
              value={settings.proxy}
              onChange={(e) => set({ proxy: e.target.value })}
              placeholder="socks5://127.0.0.1:1080"
            />
          </Row>
          <Row label={t("set.fragments")} hint={t("set.fragmentsHint")}>
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
            <Cookie className="h-4 w-4 text-primary" /> {t("set.cookies")}
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label={t("set.cookiesBrowser")} hint={t("set.cookiesBrowserHint")}>
            <Select
              value={settings.cookiesFromBrowser || "none"}
              onValueChange={(v) => set({ cookiesFromBrowser: v === "none" ? "" : v })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("set.sbOff")}</SelectItem>
                <SelectItem value="chrome">Chrome</SelectItem>
                <SelectItem value="firefox">Firefox</SelectItem>
                <SelectItem value="edge">Edge</SelectItem>
                <SelectItem value="brave">Brave</SelectItem>
                <SelectItem value="opera">Opera</SelectItem>
                <SelectItem value="vivaldi">Vivaldi</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label={t("set.cookiesFile")} hint={t("set.cookiesFileHint")}>
            <div className="flex items-center gap-2">
              <span
                className="max-w-52 truncate font-mono text-xs text-muted-foreground"
                title={settings.cookiesFile}
              >
                {settings.cookiesFile || t("set.notSet")}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const f = await api.pickCookiesFile();
                  if (f) set({ cookiesFile: f });
                }}
              >
                {t("set.browse")}
              </Button>
              {settings.cookiesFile && (
                <Button variant="ghost" size="sm" onClick={() => set({ cookiesFile: "" })}>
                  {t("set.clear")}
                </Button>
              )}
            </div>
          </Row>
          <Row label={t("set.archive")} hint={t("set.archiveHint")}>
            <Switch
              checked={settings.useDownloadArchive}
              onCheckedChange={(v) => {
                set({ useDownloadArchive: v });
                if (v)
                  toast({
                    title: t("set.archiveEnabled"),
                    description: t("set.archiveEnabledDesc"),
                    variant: "default",
                  });
              }}
            />
          </Row>
        </CardContent>
      </Card>

      {/* Legal */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScrollText className="h-4 w-4 text-primary" /> {t("set.legal")}
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          <Row label={t("set.disclaimer")} hint={t("set.disclaimerHint")}>
            <Button variant="outline" size="sm" onClick={() => setShowDisclaimer(true)}>
              {t("set.view")}
            </Button>
          </Row>
        </CardContent>
      </Card>

      <PresetDialog preset={editPreset} open={presetDialog} onOpenChange={setPresetDialog} />

      {/* Filename template guide */}
      <Dialog open={tplGuide} onOpenChange={setTplGuide}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" /> {t("tpl.info")}
            </DialogTitle>
            <DialogDescription>{t("tpl.intro")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t("tpl.fields")}
              </div>
              <div className="space-y-1 rounded-md border p-2.5 text-xs">
                {(
                  [
                    ["%(title)s", "tpl.f.title"],
                    ["%(artist)s", "tpl.f.artist"],
                    ["%(uploader)s", "tpl.f.uploader"],
                    ["%(artist,uploader)s", "tpl.f.artistFallback"],
                    ["%(album)s", "tpl.f.album"],
                    ["%(id)s", "tpl.f.id"],
                    ["%(ext)s", "tpl.f.ext"],
                    ["%(playlist_index)s", "tpl.f.index"],
                    ["%(upload_date)s", "tpl.f.date"],
                  ] as [string, MsgKey][]
                ).map(([field, desc]) => (
                  <div key={field} className="flex items-baseline gap-3">
                    <code className="w-44 shrink-0 select-text font-mono text-primary">
                      {field}
                    </code>
                    <span className="text-muted-foreground">{t(desc)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t("tpl.examples")}
              </div>
              <div className="space-y-1.5">
                {(
                  [
                    ["tpl.e.artistTitle", "%(artist,uploader)s - %(title)s.%(ext)s"],
                    ["tpl.e.titleId", "%(title)s [%(id)s].%(ext)s"],
                    ["tpl.e.numbered", "%(playlist_index)02d - %(title)s.%(ext)s"],
                    ["tpl.e.dated", "%(upload_date)s %(title)s.%(ext)s"],
                  ] as [MsgKey, string][]
                ).map(([label, tpl]) => (
                  <div
                    key={tpl}
                    className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs">{t(label)}</div>
                      <code className="select-text break-all font-mono text-[11px] text-muted-foreground">
                        {tpl}
                      </code>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 text-xs"
                      onClick={() => {
                        set({ outputTemplate: tpl });
                        setTplGuide(false);
                      }}
                    >
                      {t("tpl.use")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
