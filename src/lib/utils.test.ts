import { describe, expect, it } from "vitest";
import { extractMediaId, normalizeUrl } from "./utils";

describe("extractMediaId", () => {
  it("reads the YouTube video id from v=", () => {
    expect(extractMediaId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("reads the same id from a YouTube Music link", () => {
    expect(extractMediaId("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("reads the id from a youtu.be short link", () => {
    expect(extractMediaId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("reads the id from a /shorts/ link", () => {
    expect(extractMediaId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for an unrecognized host", () => {
    expect(extractMediaId("https://example.com/watch?v=abc")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(extractMediaId("not a url")).toBeNull();
  });
});

describe("normalizeUrl", () => {
  it("matches a YouTube Music link against its plain YouTube equivalent", () => {
    expect(normalizeUrl("https://music.youtube.com/watch?v=X")).toBe(
      normalizeUrl("https://www.youtube.com/watch?v=X&list=PL123")
    );
  });

  it("ignores a trailing slash", () => {
    expect(normalizeUrl("https://soundcloud.com/artist/track/")).toBe(
      normalizeUrl("https://soundcloud.com/artist/track")
    );
  });

  it("distinguishes different paths", () => {
    expect(normalizeUrl("https://soundcloud.com/artist/track-a")).not.toBe(
      normalizeUrl("https://soundcloud.com/artist/track-b")
    );
  });

  it("falls back to a trimmed lowercase string for a malformed URL", () => {
    expect(normalizeUrl(" Not A URL ")).toBe("not a url");
  });
});
