import { describe, expect, it } from "vitest";
import {
  buildSyncItems,
  presetForPlaylist,
  shortcutFromEvent,
  shortcutLabel,
  type PlaylistCheck,
} from "./playlistSync";
import type { MsgKey } from "./i18n";
import type { Preset, WatchedPlaylist } from "./types";

const t = (k: MsgKey) => k as string;

function preset(id: string, audioQuality: Preset["audioQuality"] = "320"): Preset {
  return {
    id,
    name: id,
    kind: "audio",
    videoPreset: "best",
    audioFormat: "mp3",
    audioQuality,
  };
}

const playlist: WatchedPlaylist = {
  id: "pl-1",
  url: "https://music.youtube.com/playlist?list=PL1",
  title: "Mix",
  enabled: true,
  presetId: "audio-mp3-320",
};

const settings = {
  presets: [preset("audio-mp3", "match"), preset("audio-mp3-320")],
  defaultPresetId: "audio-mp3",
  watchedPlaylists: [playlist],
  audioSampleRate: "48000" as const,
};

const check: PlaylistCheck = {
  playlistId: "pl-1",
  title: "Mix",
  archiveFile: "archives/pl-1.txt",
  newEntries: [
    { id: "a", title: "A", url: "https://www.youtube.com/watch?v=a", thumbnail: "https://i/a.jpg" },
    { id: "b", title: "B", url: "https://www.youtube.com/watch?v=b" },
  ],
};

describe("buildSyncItems", () => {
  it("makes one grouped task per song, bound to the playlist archive", () => {
    const items = buildSyncItems(check, settings, t);
    expect(items.map((i) => i.url)).toEqual([
      "https://www.youtube.com/watch?v=a",
      "https://www.youtube.com/watch?v=b",
    ]);
    for (const i of items) {
      expect(i.archiveFile).toBe("archives/pl-1.txt");
      expect(i.groupId).toBe("pl-1");
      expect(i.groupTitle).toBe("Mix");
      expect(i.playlist).toBe(false);
      expect(i.audioQuality).toBe("320");
    }
    expect(items[0].title).toBe("A");
    expect(items[0].thumbnail).toBe("https://i/a.jpg");
  });

  it("falls back to the default preset when the playlist's preset was deleted", () => {
    const orphaned = { ...settings, watchedPlaylists: [{ ...playlist, presetId: "gone" }] };
    const items = buildSyncItems(check, orphaned, t);
    expect(items[0].audioQuality).toBe("match");
  });

  it("queues nothing when there is nothing new or the playlist is gone", () => {
    expect(buildSyncItems({ ...check, newEntries: [] }, settings, t)).toEqual([]);
    expect(buildSyncItems(check, { ...settings, watchedPlaylists: [] }, t)).toEqual([]);
  });
});

describe("presetForPlaylist", () => {
  it("falls back to the first preset when the default is gone too", () => {
    const s = { presets: [preset("x")], defaultPresetId: "gone" };
    expect(presetForPlaylist(s, { presetId: "gone" })?.id).toBe("x");
  });
});

describe("shortcutFromEvent", () => {
  const ev = (o: Partial<KeyboardEvent>) => ({
    key: "m",
    code: "KeyM",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...o,
  });

  it("spells Ctrl+Shift+M the way the plugin expects", () => {
    const s = shortcutFromEvent(ev({ ctrlKey: true, shiftKey: true }));
    expect(s).toBe("CommandOrControl+Shift+M");
    expect(shortcutLabel(s!)).toBe("Ctrl+Shift+M");
  });

  it("ignores a bare modifier, an unbindable key and a key without modifiers", () => {
    expect(shortcutFromEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(ev({ code: "ContextMenu", ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(ev({}))).toBeNull();
  });

  it("maps digits, function and arrow keys", () => {
    expect(shortcutFromEvent(ev({ key: "5", code: "Digit5", altKey: true }))).toBe("Alt+5");
    expect(shortcutFromEvent(ev({ key: "F5", code: "F5", shiftKey: true }))).toBe("Shift+F5");
    expect(shortcutFromEvent(ev({ key: "ArrowUp", code: "ArrowUp", metaKey: true }))).toBe(
      "CommandOrControl+Up"
    );
  });
});
