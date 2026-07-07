import type { ReactNode } from "react";
import {
  Cookie,
  FolderOpen,
  Gauge,
  Globe,
  ScrollText,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import type { Settings } from "@/lib/types";
import { useApp } from "@/lib/store";
import { LANGUAGES, useT, type MsgKey } from "@/lib/i18n";
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
            <Input
              className="w-64 font-mono text-xs"
              value={settings.outputTemplate}
              onChange={(e) => set({ outputTemplate: e.target.value })}
            />
          </Row>
          <Row label={t("set.notifications")} hint={t("set.notificationsHint")}>
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
    </div>
  );
}
