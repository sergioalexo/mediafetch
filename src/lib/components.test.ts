import { describe, expect, it } from "vitest";
import { componentAction } from "./components";
import type { BinaryStatus } from "./types";

const bin = (over: Partial<BinaryStatus>): BinaryStatus => ({
  name: "yt-dlp",
  repoUrl: "",
  releasesUrl: "",
  installed: true,
  managed: true,
  updateAvailable: false,
  ...over,
});

describe("componentAction", () => {
  it("installs a missing component", () => {
    expect(componentAction("yt-dlp", undefined, false)).toBe("install");
    expect(componentAction("yt-dlp", bin({ installed: false }), false)).toBe("install");
  });
  it("updates a managed component with a newer release", () => {
    expect(componentAction("yt-dlp", bin({ updateAvailable: true }), false)).toBe("update");
  });
  it("leaves an up-to-date managed component alone", () => {
    expect(componentAction("yt-dlp", bin({}), false)).toBeNull();
  });
  it("never touches an unmanaged (system PATH) binary", () => {
    expect(componentAction("yt-dlp", bin({ managed: false, updateAvailable: true }), false)).toBeNull();
  });
  it("skips ffmpeg on macOS", () => {
    expect(componentAction("ffmpeg", bin({ name: "ffmpeg", installed: false }), true)).toBeNull();
    expect(componentAction("ffmpeg", bin({ name: "ffmpeg", installed: false }), false)).toBe("install");
  });
});
