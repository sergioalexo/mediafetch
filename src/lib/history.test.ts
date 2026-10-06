import { describe, expect, it } from "vitest";
import { mergeHistoryEntry, sameMedia } from "./history";
import type { HistoryEntry } from "./types";

function h(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: "1",
    url: "https://x.com/a",
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

describe("sameMedia", () => {
  it("compares media keys when both have one, ignoring the URL", () => {
    expect(
      sameMedia(
        h({ url: "https://youtube.com/watch?v=X", mediaKey: "Youtube:X" }),
        h({ url: "https://music.youtube.com/watch?v=X", mediaKey: "Youtube:X" })
      )
    ).toBe(true);
  });

  it("falls back to the URL when either lacks a key", () => {
    expect(sameMedia(h({ mediaKey: "X:a" }), h({}))).toBe(true);
    expect(sameMedia(h({}), h({ url: "https://x.com/b" }))).toBe(false);
  });
});

describe("mergeHistoryEntry (mirrors history.rs merge_one)", () => {
  it("puts the new entry first", () => {
    const merged = mergeHistoryEntry([h({ id: "a", url: "https://x.com/old" })], h({ id: "b" }));
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("lets a success replace an earlier failure of the same media", () => {
    const merged = mergeHistoryEntry(
      [h({ id: "1", status: "failed", mediaKey: "X:a" })],
      h({ id: "2", status: "completed", mediaKey: "X:a" })
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("completed");
  });

  it("lets a repeat failure replace the earlier one instead of stacking", () => {
    const merged = mergeHistoryEntry(
      [h({ id: "1", status: "failed", downloadedAt: 1 })],
      h({ id: "1", status: "failed", downloadedAt: 2 })
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].downloadedAt).toBe(2);
  });

  it("never removes a completed entry for a later failure", () => {
    const merged = mergeHistoryEntry(
      [h({ id: "1", status: "completed" })],
      h({ id: "2", status: "failed" })
    );
    expect(merged).toHaveLength(2);
  });

  it("keeps ids unique", () => {
    const merged = mergeHistoryEntry(
      [h({ id: "1", url: "https://x.com/a", status: "failed" })],
      h({ id: "1", url: "https://x.com/b", status: "failed" })
    );
    expect(merged.map((e) => e.id)).toEqual(["1"]);
  });
});
