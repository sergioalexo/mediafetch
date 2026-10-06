import type { BinaryStatus } from "./types";

/**
 * Which components onboarding should install or update. Missing ones are
 * installed; managed ones with a newer release are updated. A copy found on
 * the system PATH (unmanaged) is never touched, and macOS has no upstream
 * FFmpeg build to install (it comes from Homebrew).
 */
export function componentAction(
  name: string,
  bin: BinaryStatus | undefined,
  isMac: boolean,
): "install" | "update" | null {
  if (isMac && name === "ffmpeg") return null;
  if (!bin?.installed) return "install";
  if (bin.managed && bin.updateAvailable) return "update";
  return null;
}
