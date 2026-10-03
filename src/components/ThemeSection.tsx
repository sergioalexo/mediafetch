import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Check, ExternalLink, Palette, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { Theme } from "@/lib/theme";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import { ThemeEditorDialog } from "@/components/ThemeEditorDialog";

/** GitHub's prefilled "create a new file" page — the easiest way for a
 * non-owner to open a PR that adds a theme, without touching git directly. */
function shareUrl(theme: Theme): string {
  const json = JSON.stringify(theme, null, 2);
  const encoded = encodeURIComponent(json);
  return `https://github.com/sergioalexo/mediafetch/new/main/themes?filename=${theme.id}.json&value=${encoded}`;
}

function ThemeCard({
  name,
  colors,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onExport,
  onShare,
}: {
  name: string;
  colors: { background: string; card: string; primary: string };
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  onShare?: () => void;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border p-2 text-left transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "hover:border-foreground/30"
      )}
    >
      <button onClick={onSelect} className="block w-full">
        <div
          className="mb-2 flex h-10 items-center gap-1.5 rounded-md p-1.5"
          style={{ background: `hsl(${colors.background})` }}
        >
          <div className="h-full w-5 rounded-sm" style={{ background: `hsl(${colors.card})` }} />
          <div
            className="h-3 w-3 rounded-full"
            style={{ background: `hsl(${colors.primary})` }}
          />
        </div>
        <div className="flex items-center gap-1 text-xs font-medium">
          {selected && <Check className="h-3 w-3 shrink-0 text-primary" />}
          <span className="truncate">{name}</span>
        </div>
      </button>
      {(onEdit || onDelete || onExport || onShare) && (
        <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onEdit && (
            <button
              onClick={onEdit}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("pd.edit")}
            </button>
          )}
          {onExport && (
            <button
              onClick={onExport}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("th.export")}
            </button>
          )}
          {onShare && (
            <button
              onClick={onShare}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("th.share")}
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="ml-auto text-[10px] text-destructive underline underline-offset-2 hover:opacity-80"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const BUILT_IN = [
  { id: "auto", name: "theme.auto" as const, colors: { background: "0 0% 100%", card: "0 0% 96%", primary: "346 77% 50%" } },
  { id: "light", name: "theme.light" as const, colors: { background: "0 0% 100%", card: "0 0% 96%", primary: "346 77% 50%" } },
  { id: "dark", name: "theme.dark" as const, colors: { background: "240 10% 5%", card: "240 8% 8%", primary: "346 82% 56%" } },
];

export function ThemeSection() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const customThemes = useApp((s) => s.customThemes);
  const communityThemes = useApp((s) => s.communityThemes);
  const themesLoading = useApp((s) => s.themesLoading);
  const loadCommunityThemes = useApp((s) => s.loadCommunityThemes);
  const deleteCustomTheme = useApp((s) => s.deleteCustomTheme);
  const importCustomTheme = useApp((s) => s.importCustomTheme);
  const exportCustomTheme = useApp((s) => s.exportCustomTheme);
  const toast = useApp((s) => s.toast);
  const t = useT();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Theme | null>(null);

  if (!settings) return null;
  const current = settings.theme;

  const applyBuiltIn = (id: string) => void updateSettings({ theme: id });
  const applyCustom = (id: string) => void updateSettings({ theme: `custom:${id}` });

  const importFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Theme", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    try {
      await importCustomTheme(path);
      toast({ title: t("th.imported"), variant: "default" });
    } catch (e) {
      toast({ title: t("th.importFailed"), description: String(e), variant: "error" });
    }
  };

  const exportFile = async (theme: Theme) => {
    const path = await save({
      defaultPath: `${theme.id}.json`,
      filters: [{ name: "Theme", extensions: ["json"] }],
    });
    if (!path) return;
    await exportCustomTheme(theme.id, path);
    toast({ title: t("th.exported"), variant: "default" });
  };

  const share = async (theme: Theme) => {
    const url = shareUrl(theme);
    if (url.length > 8000) {
      await navigator.clipboard.writeText(JSON.stringify(theme, null, 2));
      toast({ title: t("th.shareTooBig"), variant: "default" });
      await api.openExternal("https://github.com/sergioalexo/mediafetch/tree/main/themes");
      return;
    }
    await api.openExternal(url);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t("th.builtIn")}</p>
        <div className="grid grid-cols-3 gap-2">
          {BUILT_IN.map((b) => (
            <ThemeCard
              key={b.id}
              name={t(b.name)}
              colors={b.colors}
              selected={current === b.id}
              onSelect={() => applyBuiltIn(b.id)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">{t("th.myThemes")}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={importFile}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Upload className="h-3 w-3" /> {t("th.import")}
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus className="h-3 w-3" /> {t("th.create")}
            </button>
          </div>
        </div>
        {customThemes.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {t("th.noCustom")}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {customThemes.map((th) => (
              <ThemeCard
                key={th.id}
                name={th.name}
                colors={{
                  background: th.colors.background ?? "0 0% 50%",
                  card: th.colors.card ?? "0 0% 50%",
                  primary: th.colors.primary ?? "0 0% 50%",
                }}
                selected={current === `custom:${th.id}`}
                onSelect={() => applyCustom(th.id)}
                onEdit={() => {
                  setEditing(th);
                  setEditorOpen(true);
                }}
                onExport={() => void exportFile(th)}
                onShare={() => void share(th)}
                onDelete={() => void deleteCustomTheme(th.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">{t("th.community")}</p>
          <button
            onClick={() => void loadCommunityThemes()}
            disabled={themesLoading}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", themesLoading && "animate-spin")} />
            {t("th.fetchCommunity")}
          </button>
        </div>
        {communityThemes.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {t("th.noCommunity")}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {communityThemes.map((th) => (
              <ThemeCard
                key={th.id}
                name={th.name}
                colors={{
                  background: th.colors.background ?? "0 0% 50%",
                  card: th.colors.card ?? "0 0% 50%",
                  primary: th.colors.primary ?? "0 0% 50%",
                }}
                selected={current === `custom:${th.id}`}
                onSelect={async () => {
                  await useApp.getState().saveCustomTheme(th);
                  applyCustom(th.id);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <a
        href="https://github.com/sergioalexo/mediafetch/tree/main/themes"
        onClick={(e) => {
          e.preventDefault();
          void api.openExternal("https://github.com/sergioalexo/mediafetch/tree/main/themes");
        }}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Palette className="h-3 w-3" />
        <ExternalLink className="h-3 w-3" /> themes/
      </a>

      <ThemeEditorDialog theme={editing} open={editorOpen} onOpenChange={setEditorOpen} />
    </div>
  );
}
