import { describe, expect, it } from "vitest";
import { hexToHsl, hslToHex, validateTheme } from "./theme";

function goodTheme() {
  return {
    format: 1,
    id: "midnight-teal",
    name: "Midnight Teal",
    author: "someone",
    base: "dark",
    radius: "0.75rem",
    colors: {
      background: "200 30% 6%",
      primary: "180 70% 50%",
    },
  };
}

describe("validateTheme", () => {
  it("accepts a well-formed theme", () => {
    const r = validateTheme(goodTheme());
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported format version", () => {
    const r = validateTheme({ ...goodTheme(), format: 2 });
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed id", () => {
    const r = validateTheme({ ...goodTheme(), id: "../../etc/passwd" });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown base", () => {
    const r = validateTheme({ ...goodTheme(), base: "sepia" });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown color key", () => {
    const theme = goodTheme();
    (theme.colors as Record<string, string>)["background-image"] = "url(javascript:alert(1))";
    const r = validateTheme(theme);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-HSL color value", () => {
    const theme = goodTheme();
    (theme.colors as Record<string, string>).primary = "red";
    const r = validateTheme(theme);
    expect(r.ok).toBe(false);
  });

  it("rejects a raw-CSS injection attempt", () => {
    const theme = goodTheme();
    (theme.colors as Record<string, string>).primary = "0 0% 0%; } body { display: none";
    const r = validateTheme(theme);
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-range hue or percentage", () => {
    const theme = goodTheme();
    (theme.colors as Record<string, string>).primary = "400 50% 50%";
    expect(validateTheme(theme).ok).toBe(false);
    (theme.colors as Record<string, string>).primary = "200 150% 50%";
    expect(validateTheme(theme).ok).toBe(false);
  });

  it("rejects a bad radius", () => {
    expect(validateTheme({ ...goodTheme(), radius: "1.5em" }).ok).toBe(false);
    expect(validateTheme({ ...goodTheme(), radius: "-1rem" }).ok).toBe(false);
  });

  it("rejects a non-object input", () => {
    expect(validateTheme("not a theme").ok).toBe(false);
    expect(validateTheme(null).ok).toBe(false);
  });
});

describe("hex <-> HSL", () => {
  it("round-trips a handful of colors within rounding tolerance", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#123456", "#ffffff", "#000000"]) {
      const hsl = hexToHsl(hex);
      const back = hslToHex(hsl);
      // Rounding to whole-percent HSL can shift a channel by a notch.
      const diff = (a: string, b: string) =>
        Math.max(
          ...[0, 2, 4].map((i) => Math.abs(parseInt(a.slice(i + 1, i + 3), 16) - parseInt(b.slice(i + 1, i + 3), 16)))
        );
      expect(diff(hex, back)).toBeLessThanOrEqual(2);
    }
  });

  it("falls back to black for a malformed hex", () => {
    expect(hexToHsl("not-a-color")).toBe("0 0% 0%");
  });
});
