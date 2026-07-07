// Builds a prefilled GitHub "new issue" URL and opens it in the browser.
//
// We deliberately do NOT submit anything automatically: the user always lands
// on GitHub's issue form with the report pre-filled, so they can review, edit
// and remove anything before posting. Diagnostics are limited to app / tool
// versions and OS — no paths, cookies or credentials.

import * as api from "./api";

const REPO = "sergioalexo/mediafetch";

export type ReportKind = "bug" | "enhancement";

export interface ReportContext {
  /** A failing download URL to include (e.g. from a failed queue item). */
  url?: string;
  /** An error message to include verbatim in a code block. */
  error?: string;
}

async function environmentBlock(): Promise<string> {
  const diag = await api.collectDiagnostics().catch(() => null);
  if (!diag) return "- (could not collect environment info)";
  return [
    `- MediaFetch: ${diag.appVersion}`,
    `- OS: ${diag.os} (${diag.arch})`,
    `- yt-dlp: ${diag.ytdlpVersion ?? "not installed"}`,
    `- FFmpeg: ${diag.ffmpegVersion ?? "not installed"}`,
  ].join("\n");
}

/** Open GitHub's new-issue form, pre-filled for a bug report or an idea. */
export async function openIssueReport(
  kind: ReportKind,
  ctx: ReportContext = {}
): Promise<void> {
  const env = await environmentBlock();
  const isBug = kind === "bug";

  const sections: string[] = isBug
    ? [
        "<!-- Thanks for reporting! Please review before submitting and remove anything private (URLs, cookies, personal info). -->",
        "## What happened?",
        "",
        "## Steps to reproduce",
        "1. ",
        "2. ",
        "## What did you expect?",
        "",
        ...(ctx.url ? [`## Source URL`, "```", ctx.url, "```"] : []),
        ...(ctx.error ? [`## Error output`, "```", ctx.error.trim(), "```"] : []),
        "## Environment",
        env,
      ]
    : [
        "<!-- Thanks for the suggestion! -->",
        "## What would you like to see?",
        "",
        "## Why would it be useful?",
        "",
        "## Environment",
        env,
      ];

  const title = isBug ? "[Bug] " : "[Idea] ";
  const label = isBug ? "bug" : "enhancement";
  const body = sections.join("\n\n");

  const url =
    `https://github.com/${REPO}/issues/new` +
    `?title=${encodeURIComponent(title)}` +
    `&labels=${encodeURIComponent(label)}` +
    `&body=${encodeURIComponent(body)}`;

  await api.openExternal(url);
}
