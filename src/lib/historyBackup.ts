// Back up / import the download history — shared by the History page and
// Settings → Data, which used to carry a copy each.

import { open, save } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { translate, type MsgKey } from "./i18n";
import { useApp } from "./store";

const FILTERS = [{ name: "MediaFetch history", extensions: ["json"] }];

function t(key: MsgKey, vars?: Record<string, string | number>) {
  return translate(useApp.getState().settings?.language ?? "en", key, vars);
}

/** Ask where to save, then write the history (and download archive) there. */
export async function backUpHistory(): Promise<void> {
  const { toast } = useApp.getState();
  const date = new Date().toISOString().slice(0, 10);
  const path = await save({ defaultPath: `mediafetch-history-${date}.json`, filters: FILTERS });
  if (!path) return;
  try {
    const n = await api.exportHistory(path);
    toast({ title: t("h.backedUp", { n }), variant: "default" });
  } catch (e) {
    toast({ title: t("h.backupFailed"), description: String(e), variant: "error" });
  }
}

/**
 * Pick a backup and merge it in — never replaces. The backend announces the
 * merged result with `history-replaced`, which the store applies.
 */
export async function importHistoryBackup(): Promise<void> {
  const { toast } = useApp.getState();
  const path = await open({ multiple: false, filters: FILTERS });
  if (!path || Array.isArray(path)) return;
  try {
    const report = await api.importHistory(path);
    toast({
      title: t("h.imported", { n: report.added }),
      description: t("h.importedSkipped", { n: report.skipped }),
      variant: "default",
    });
  } catch (e) {
    toast({ title: t("h.importFailed"), description: String(e), variant: "error" });
  }
}
