import { describe, expect, it } from "vitest";
import { isAlreadyDownloaded } from "./presets";
import type { HistoryEntry } from "./types";

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
