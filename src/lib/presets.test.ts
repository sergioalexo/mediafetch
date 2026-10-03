import { describe, expect, it } from "vitest";
import { clampSampleRate, isAlreadyDownloaded, presetSummary } from "./presets";
import type { HistoryEntry, Preset } from "./types";
import type { MsgKey } from "./i18n";

const t = (k: MsgKey) => k as string;

function h(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: "1",
    url: "https://youtube.com/watch?v=X",
    title: "t",
    filesize: 0,
    kind: "video",
    downloadedAt: 0,
    elapsedSecs: 0,
    avgSpeed: 0,
    status: "completed",
    ...partial,
  };
}

describe("isAlreadyDownloaded", () => {
  it("matches an exact completed URL", () => {
    const history = [h({ url: "https://youtube.com/watch?v=X" })];
    expect(isAlreadyDownloaded(history, "https://youtube.com/watch?v=X")).toBe(true);
  });

  it("matches a YouTube Music link against a plain YouTube completed entry, by id", () => {
    const history = [h({ url: "https://youtube.com/watch?v=X" })];
    expect(
      isAlreadyDownloaded(history, "https://music.youtube.com/watch?v=X&list=RD", "X")
    ).toBe(true);
  });

  it("ignores failed entries", () => {
    const history = [h({ url: "https://youtube.com/watch?v=X", status: "failed" })];
    expect(isAlreadyDownloaded(history, "https://youtube.com/watch?v=X")).toBe(false);
  });

  it("does not match an unrelated URL", () => {
    const history = [h({ url: "https://youtube.com/watch?v=X" })];
    expect(isAlreadyDownloaded(history, "https://youtube.com/watch?v=Y", "Y")).toBe(false);
  });

  it("matches by mediaKey even when the URL differs entirely", () => {
    const history = [h({ url: "https://youtube.com/watch?v=X", mediaKey: "Youtube:X" })];
    expect(isAlreadyDownloaded(history, "https://youtu.be/X", "X")).toBe(true);
  });
});

describe("clampSampleRate", () => {
  it("falls back 96kHz to 48kHz for mp3 and aac", () => {
    expect(clampSampleRate("96000", "mp3")).toBe("48000");
    expect(clampSampleRate("96000", "aac")).toBe("48000");
  });

  it("forces opus to 48kHz regardless of the request", () => {
    expect(clampSampleRate("44100", "opus")).toBe("48000");
  });

  it("leaves flac/wav unclamped", () => {
    expect(clampSampleRate("96000", "flac")).toBe("96000");
    expect(clampSampleRate("96000", "wav")).toBe("96000");
  });

  it("never resamples 'original'", () => {
    expect(clampSampleRate("original", "mp3")).toBe("original");
  });
});

describe("presetSummary sample rate display", () => {
  function preset(partial: Partial<Preset>): Preset {
    return {
      id: "p",
      name: "p",
      kind: "audio",
      videoPreset: "best",
      audioFormat: "mp3",
      audioQuality: "320",
      ...partial,
    };
  }

  it("shows the rate only when it differs from the 48kHz default", () => {
    const atDefault = presetSummary(preset({ sampleRate: "48000" }), t);
    const at44 = presetSummary(preset({ sampleRate: "44100" }), t);
    expect(atDefault).not.toContain("kHz");
    expect(at44).toContain("44.1 kHz");
  });

  it("uses the global default when the preset has no override", () => {
    const withGlobalOverride = presetSummary(preset({ sampleRate: null }), t, "44100");
    expect(withGlobalOverride).toContain("44.1 kHz");
  });

  it("never shows a rate for 'source' audio", () => {
    const source = presetSummary(preset({ audioFormat: "source", sampleRate: "44100" }), t);
    expect(source).not.toContain("kHz");
  });
});
