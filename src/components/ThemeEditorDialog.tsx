import { useEffect, useRef, useState } from "react";
import type { Theme, ThemeColorKey } from "@/lib/theme";
import { applyCustomTheme, hexToHsl, hslToHex, THEME_COLOR_KEYS } from "@/lib/theme";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

let themeSeq = 0;

function blankTheme(base: "dark" | "light", seed?: Theme): Theme {
  const colors: Partial<Record<ThemeColorKey, string>> = {};
  const root = getComputedStyle(document.documentElement);
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = seed?.colors[key] ?? (root.getPropertyValue(`--${key}`).trim() || "0 0% 50%");
  }
  return {
    format: 1,
    id: seed?.id ?? `theme-${Date.now()}-${++themeSeq}`,
    name: seed?.name ?? "My theme",
    author: seed?.author ?? null,
    base: seed?.base ?? base,
    radius: seed?.radius ?? "0.625rem",
    colors,
  };
}

/** Create or edit a custom theme, with the page repainted live while the
 * dialog is open (and reverted to whatever was applied before, on cancel). */
export function ThemeEditorDialog({
  theme,
  open,
  onOpenChange,
}: {
  /** Pass an existing theme to edit, or null to create a new one. */
  theme: Theme | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const settings = useApp((s) => s.settings);
  const saveCustomTheme = useApp((s) => s.saveCustomTheme);
  const customThemes = useApp((s) => s.customThemes);
  const t = useT();
  const [draft, setDraft] = useState<Theme>(() => blankTheme("dark"));
  const previousApplied = useRef<string>(settings?.theme ?? "auto");

  useEffect(() => {
    if (!open) return;
    const base = (document.documentElement.classList.contains("dark") ? "dark" : "light") as
      | "dark"
      | "light";
    const initial = theme ? { ...theme, colors: { ...theme.colors } } : blankTheme(base);
    setDraft(initial);
    previousApplied.current = settings?.theme ?? "auto";
    applyCustomTheme(initial);
    return () => {
      // Revert the live preview on close — the real applied theme comes
      // back through the store's own applyTheme the next time it runs, or
      // immediately here if nothing changed it meanwhile.
      const current = useApp.getState().settings?.theme;
      if (current === previousApplied.current) {
        const id = current?.startsWith("custom:") ? current.slice(7) : null;
        const applied = id ? customThemes.find((x) => x.id === id) ?? null : null;
        applyCustomTheme(applied);
        if (!id) {
          document.documentElement.classList.toggle(
            "dark",
            current === "dark" ||
              (current === "auto" &&
                window.matchMedia?.("(prefers-color-scheme: dark)").matches)
          );
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, theme]);

  const update = (patch: Partial<Theme>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    applyCustomTheme(next);
  };
  const updateColor = (key: ThemeColorKey, value: string) => {
    const next = { ...draft, colors: { ...draft.colors, [key]: value } };
    setDraft(next);
    applyCustomTheme(next);
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name) return;
    const toSave: Theme = { ...draft, name };
    await saveCustomTheme(toSave);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{theme ? t("th.editTitle") : t("th.createTitle")}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("th.name")}</Label>
            <Input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("th.base")}</Label>
              <Select value={draft.base} onValueChange={(v) => update({ base: v as "dark" | "light" })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">{t("theme.dark")}</SelectItem>
                  <SelectItem value="light">{t("theme.light")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("th.radius")}</Label>
              <Input
                value={draft.radius ?? ""}
                onChange={(e) => update({ radius: e.target.value })}
                placeholder="0.625rem"
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {THEME_COLOR_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 rounded-md border p-1.5">
                <input
                  type="color"
                  value={hslToHex(draft.colors[key] ?? "0 0% 50%")}
                  onChange={(e) => updateColor(key, hexToHsl(e.target.value))}
                  className="h-6 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <span className="truncate text-xs text-muted-foreground">{key}</span>
              </label>
            ))}
          </div>
        </div>

        <DialogFooter className="justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("th.cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("th.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { blankTheme };
