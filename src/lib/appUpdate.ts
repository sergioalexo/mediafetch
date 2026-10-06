import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Download and install the newest MediaFetch release, then relaunch. Pass an
 * `update` already obtained from `check()` to skip a second lookup. Resolves
 * "none" when there is nothing newer; throws if the download/install fails.
 */
export async function installAppUpdate(
  onProgress?: (downloaded: number, total: number) => void,
  known?: Update | null,
): Promise<"none" | "installed"> {
  const update = known ?? (await check());
  if (!update) return "none";
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") {
      total = e.data.contentLength ?? 0;
      onProgress?.(0, total);
    } else if (e.event === "Progress") {
      downloaded += e.data.chunkLength;
      onProgress?.(downloaded, total);
    }
  });
  // On Windows the app exits while the installer runs; this is a no-op there.
  await relaunch();
  return "installed";
}
