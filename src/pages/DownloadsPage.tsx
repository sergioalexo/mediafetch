import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  ClipboardPaste,
  Download,
  Film,
  Link2,
  ListVideo,
  Loader2,
  Music,
  Pencil,
  Search,
  Subtitles,
  X,
} from "lucide-react";
import type {
  AnalyzeResult,
  AudioFormat,
  BitrateMode,
  DownloadKind,
  DownloadOptions,
  VideoFormat,
} from "@/lib/types";
import * as api from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn, codecLabel, extractUrls, formatBytes, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

const AUDIO_FORMATS: { value: AudioFormat; label: string; hint: string }[] = [
  { value: "mp3", label: "MP3", hint: "universal" },
  { value: "flac", label: "FLAC", hint: "lossless" },
  { value: "wav", label: "WAV", hint: "uncompressed" },
  { value: "aac", label: "AAC", hint: "efficient" },
  { value: "opus", label: "OPUS", hint: "best quality/size" },
];

const PRESETS = [
  { value: "best", label: "Best available", f: "bv*+ba/b" },
  { value: "2160", label: "4K (2160p)", f: "bv*[height<=2160]+ba/b" },
  { value: "1440", label: "1440p", f: "bv*[height<=1440]+ba/b" },
  { value: "1080", label: "1080p", f: "bv*[height<=1080]+ba/b" },
  { value: "720", label: "720p", f: "bv*[height<=720]+ba/b" },
  { value: "480", label: "480p", f: "bv*[height<=480]+ba/b" },
];

/** True when a completed history entry matches this URL / media id. */
function isAlreadyDownloaded(url: string, id?: string | null): boolean {
  const hist = useApp.getState().history;
  return hist.some(
    (h) =>
      h.status === "completed" &&
      (h.url === url || (!!id && id.length >= 6 && h.url.includes(id)))
  );
}

interface QualityChoice {
  key: string;
  label: string;
  hdr: boolean;
  codec: string;
  fps?: number | null;
  height?: number | null;
  filesize?: number | null;
  formatId: string;
}

function buildQualityChoices(formats: VideoFormat[]): QualityChoice[] {
  const video = formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.height);
  // Highest bitrate per (height, fps, codec, dynamicRange)
  const byKey = new Map<string, VideoFormat>();
  for (const f of video) {
    const key = `${f.height}|${Math.round(f.fps ?? 0)}|${codecLabel(f.vcodec)}|${f.dynamicRange ?? "SDR"}`;
    const prev = byKey.get(key);
    if (!prev || (f.tbr ?? 0) > (prev.tbr ?? 0)) byKey.set(key, f);
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        (b.height ?? 0) - (a.height ?? 0) ||
        (b.fps ?? 0) - (a.fps ?? 0) ||
        (b.tbr ?? 0) - (a.tbr ?? 0)
    )
    .map((f) => {
      const fps = Math.round(f.fps ?? 0);
      const hdr = !!f.dynamicRange && f.dynamicRange !== "SDR";
      const codec = codecLabel(f.vcodec);
      return {
        key: f.formatId,
        label: `${f.height}p${fps > 30 ? fps : ""}`,
        hdr,
        codec,
        fps: f.fps,
        height: f.height,
        filesize: f.filesize,
        formatId: f.formatId,
      };
    });
}

export function DownloadsPage() {
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const setPage = useApp((s) => s.setPage);
  const updateSettings = useApp((s) => s.updateSettings);
  const history = useApp((s) => s.history);

  const [input, setInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // --- selection state (restored from settings, persisted on change) ---
  const [kind, setKindState] = useState<DownloadKind>(settings?.lastKind ?? "video");
  const [formatId, setFormatId] = useState<string>("");
  const [preset, setPresetState] = useState(settings?.lastPreset || "best");
  const [audioFormat, setAudioFormatState] = useState<AudioFormat>(
    settings?.lastAudioFormat ?? "mp3"
  );
  const [bitrateMode, setBitrateModeState] = useState<BitrateMode>(
    settings?.audioBitrateMode ?? "cbr"
  );
  const [audioLang, setAudioLang] = useState<string>("default");
  const [subLangs, setSubLangs] = useState<string[]>([]);
  const [showMeta, setShowMeta] = useState(false);
  const [meta, setMeta] = useState({ title: "", artist: "", album: "", genre: "" });
  const [selectedEntries, setSelectedEntries] = useState<Set<number>>(new Set());

  // Settings may still be loading on the very first mount — apply them once.
  const restoredFromSettings = useRef(!!settings);
  useEffect(() => {
    if (!settings || restoredFromSettings.current) return;
    restoredFromSettings.current = true;
    setKindState(settings.lastKind ?? "video");
    setPresetState(settings.lastPreset || "best");
    setAudioFormatState(settings.lastAudioFormat ?? "mp3");
    setBitrateModeState(settings.audioBitrateMode ?? "cbr");
  }, [settings]);

  const setKind = (k: DownloadKind) => {
    setKindState(k);
    void updateSettings({ lastKind: k });
  };
  const setPreset = (p: string) => {
    setPresetState(p);
    void updateSettings({ lastPreset: p });
  };
  const setAudioFormat = (f: AudioFormat) => {
    setAudioFormatState(f);
    void updateSettings({ lastAudioFormat: f });
  };
  const setBitrateMode = (m: BitrateMode) => {
    setBitrateModeState(m);
    void updateSettings({ audioBitrateMode: m });
  };

  const urls = useMemo(() => extractUrls(input), [input]);

  const qualityChoices = useMemo(
    () => (result && result.kind === "video" ? buildQualityChoices(result.formats) : []),
    [result]
  );

  // Best source audio bitrate (kbps) — used to match CBR encode quality.
  const sourceAbr = useMemo(() => {
    if (!result || result.kind !== "video") return null;
    const abrs = result.formats
      .filter((f) => f.acodec && f.acodec !== "none")
      .map((f) => f.abr ?? 0);
    const max = Math.max(0, ...abrs);
    return max > 0 ? max : null;
  }, [result]);

  // Which playlist entries are already in the download history.
  const entryDownloaded = useMemo(
    () =>
      result?.kind === "playlist"
        ? result.entries.map((e) => isAlreadyDownloaded(e.url, e.id))
        : [],
    [result, history]
  );

  const videoDownloaded = useMemo(
    () =>
      result?.kind === "video" ? isAlreadyDownloaded(result.url, result.id) : false,
    [result, history]
  );

  const reset = () => {
    setResult(null);
    setAnalyzeError(null);
    setFormatId("");
    setSubLangs([]);
    setShowMeta(false);
    setMeta({ title: "", artist: "", album: "", genre: "" });
    setSelectedEntries(new Set());
    setAudioLang("default");
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInput((cur) => (cur ? cur + "\n" + text : text));
    } catch {
      toast({ title: "Clipboard unavailable", variant: "error" });
    }
  };

  const analyze = async () => {
    if (urls.length === 0) return;
    reset();
    setAnalyzing(true);
    try {
      const r = await api.analyzeUrl(urls[0]);
      setResult(r);
      if (r.kind === "playlist") {
        // Pre-select everything except tracks already in the history —
        // the user can still tick those back on to re-download.
        setSelectedEntries(
          new Set(
            r.entries
              .map((_, i) => i)
              .filter((i) => !isAlreadyDownloaded(r.entries[i].url, r.entries[i].id))
          )
        );
      } else {
        const choices = buildQualityChoices(r.formats);
        if (choices.length) setFormatId(choices[0].formatId);
      }
      if (r.audioLanguages.length) setAudioLang(r.audioLanguages[0]);
    } catch (e) {
      setAnalyzeError(String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const buildFormat = (): { format: string; note: string } => {
    if (kind === "audio") return { format: "ba/b", note: audioFormat.toUpperCase() };
    if (result && formatId) {
      const c = qualityChoices.find((q) => q.formatId === formatId);
      const audioSel =
        audioLang !== "default" ? `ba[language^=${audioLang}]/ba/b` : "ba/b";
      return {
        format: `${formatId}+${audioSel.split("/")[0]}/${formatId}+ba/${formatId}/b`,
        note: c ? `${c.label} · ${c.codec}${c.hdr ? " · HDR" : ""}` : "custom",
      };
    }
    const p = PRESETS.find((p) => p.value === preset) ?? PRESETS[0];
    return { format: p.f, note: p.label };
  };

  const metaOverrides = () => {
    const m = {
      title: meta.title.trim() || undefined,
      artist: meta.artist.trim() || undefined,
      album: meta.album.trim() || undefined,
      genre: meta.genre.trim() || undefined,
    };
    return m.title || m.artist || m.album || m.genre ? m : null;
  };

  const enqueueSingle = async () => {
    if (!result) return;
    const { format, note } = buildFormat();
    const opts: DownloadOptions = {
      url: result.url,
      kind,
      format: kind === "video" ? format : "ba/b",
      formatNote: note,
      audioFormat: kind === "audio" ? audioFormat : null,
      bitrateMode: kind === "audio" ? bitrateMode : null,
      sourceAbr: kind === "audio" ? sourceAbr : null,
      playlist: false,
      subtitleLangs: subLangs.length ? subLangs.join(",") : null,
      audioLang: audioLang !== "default" ? audioLang : null,
      metadata: metaOverrides(),
      title: result.title,
      thumbnail: result.thumbnail,
    };
    await api.enqueue([opts]);
    toast({ title: "Added to queue", description: result.title, variant: "success" });
    setInput("");
    reset();
    setPage("queue");
  };

  const enqueuePlaylist = async () => {
    if (!result) return;
    const p = PRESETS.find((p) => p.value === preset) ?? PRESETS[0];
    // Each selected track becomes its own task, so every track gets its own
    // queue row and history entry.
    const items: DownloadOptions[] = [...selectedEntries]
      .sort((a, b) => a - b)
      .map((i) => result.entries[i])
      .filter((e) => !!e.url)
      .map((e) => ({
        url: e.url,
        kind,
        format: kind === "video" ? p.f : "ba/b",
        formatNote: kind === "video" ? p.label : audioFormat.toUpperCase(),
        audioFormat: kind === "audio" ? audioFormat : null,
        bitrateMode: kind === "audio" ? bitrateMode : null,
        playlist: false,
        metadata: null,
        title: e.title,
        thumbnail: e.thumbnail,
      }));
    if (items.length === 0) return;
    await api.enqueue(items);
    toast({
      title: "Playlist added to queue",
      description: `${items.length} track(s) · ${result.title}`,
      variant: "success",
    });
    setInput("");
    reset();
    setPage("queue");
  };

  const enqueueMany = async () => {
    const p = PRESETS.find((p) => p.value === preset) ?? PRESETS[0];
    const items: DownloadOptions[] = urls.map((url) => ({
      url,
      kind,
      format: kind === "video" ? p.f : "ba/b",
      formatNote: kind === "video" ? p.label : audioFormat.toUpperCase(),
      audioFormat: kind === "audio" ? audioFormat : null,
      bitrateMode: kind === "audio" ? bitrateMode : null,
      playlist: false,
      metadata: null,
    }));
    await api.enqueue(items);
    toast({ title: `${items.length} downloads queued`, variant: "success" });
    setInput("");
    reset();
    setPage("queue");
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const text =
      e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (text) {
      const found = extractUrls(text);
      if (found.length) {
        setInput((cur) => (cur ? cur + "\n" : "") + found.join("\n"));
      }
    }
  };

  const toggleSub = (lang: string) =>
    setSubLangs((cur) => (cur.includes(lang) ? cur.filter((l) => l !== lang) : [...cur, lang]));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Download</h1>
        <p className="text-sm text-muted-foreground">
          Paste video, playlist or channel URLs — one per line. Drag &amp; drop works too.
        </p>
      </div>

      {/* URL input / drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-xl border-2 border-dashed p-3 transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border"
        )}
      >
        <Textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (result || analyzeError) reset();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && urls.length > 0) {
              e.preventDefault();
              void analyze();
            }
          }}
          placeholder={"https://www.youtube.com/watch?v=…\nhttps://vimeo.com/…"}
          className="min-h-[72px] resize-none border-0 shadow-none focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            {urls.length === 0
              ? "No URLs detected"
              : `${urls.length} URL${urls.length > 1 ? "s" : ""} detected`}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={paste}>
              <ClipboardPaste className="h-3.5 w-3.5" /> Paste
            </Button>
            {input && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setInput("");
                  reset();
                }}
              >
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
            {urls.length === 1 && (
              <Button size="sm" onClick={analyze} disabled={analyzing}>
                {analyzing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                Analyze
              </Button>
            )}
          </div>
        </div>
      </div>

      {analyzing && (
        <Card>
          <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Fetching media information…
          </CardContent>
        </Card>
      )}

      {analyzeError && (
        <Card className="border-destructive/40">
          <CardContent className="p-4">
            <div className="text-sm font-medium text-destructive">Could not analyze URL</div>
            <div className="mt-1 break-all text-xs text-muted-foreground">{analyzeError}</div>
          </CardContent>
        </Card>
      )}

      {/* ---- Multiple URLs: quick queue ---- */}
      {urls.length > 1 && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ListVideo className="h-4 w-4 text-primary" />
              {urls.length} URLs — queue them all with one preset
            </div>
            <KindTabs kind={kind} setKind={setKind} />
            {kind === "video" ? (
              <PresetSelect preset={preset} setPreset={setPreset} />
            ) : (
              <AudioOptions
                format={audioFormat}
                onFormatChange={setAudioFormat}
                bitrateMode={bitrateMode}
                onBitrateModeChange={setBitrateMode}
              />
            )}
            <Button className="w-full" onClick={enqueueMany}>
              <Download className="h-4 w-4" /> Add {urls.length} downloads to queue
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ---- Single video ---- */}
      <AnimatePresence>
        {result && result.kind === "video" && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="flex gap-3">
                  {result.thumbnail && (
                    <img
                      src={result.thumbnail}
                      alt=""
                      className="h-20 w-36 shrink-0 rounded-lg object-cover"
                      draggable={false}
                    />
                  )}
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-sm font-semibold">{result.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {result.uploader}
                      {result.duration ? ` · ${formatDuration(result.duration)}` : ""}
                    </div>
                    {qualityChoices.some((q) => q.hdr) && (
                      <Badge variant="hdr" className="mt-1.5">
                        HDR available
                      </Badge>
                    )}
                    {videoDownloaded && (
                      <Badge
                        variant="secondary"
                        className="ml-1.5 mt-1.5 border-amber-500/40 bg-amber-500/15 text-amber-500"
                      >
                        Already downloaded
                      </Badge>
                    )}
                  </div>
                </div>

                <KindTabs kind={kind} setKind={setKind} />

                {kind === "video" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Quality</Label>
                      <Select value={formatId} onValueChange={setFormatId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select quality" />
                        </SelectTrigger>
                        <SelectContent>
                          {qualityChoices.map((q) => (
                            <SelectItem key={q.key} value={q.formatId}>
                              <span className="flex items-center gap-2">
                                <span className="font-medium">{q.label}</span>
                                <span className="text-muted-foreground">{q.codec}</span>
                                {q.hdr && (
                                  <span className="rounded bg-gradient-to-r from-amber-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                                    HDR
                                  </span>
                                )}
                                {q.filesize ? (
                                  <span className="text-xs text-muted-foreground">
                                    ~{formatBytes(q.filesize)}
                                  </span>
                                ) : null}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Audio language</Label>
                      <Select value={audioLang} onValueChange={setAudioLang}>
                        <SelectTrigger disabled={result.audioLanguages.length === 0}>
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default</SelectItem>
                          {result.audioLanguages.map((l) => (
                            <SelectItem key={l} value={l}>
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : (
                  <AudioOptions
                format={audioFormat}
                onFormatChange={setAudioFormat}
                bitrateMode={bitrateMode}
                onBitrateModeChange={setBitrateMode}
              />
                )}

                {/* Subtitles */}
                {result.subtitles.length > 0 && kind === "video" && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Subtitles className="h-3.5 w-3.5" /> Subtitles
                      {subLangs.length > 0 && (
                        <Badge variant="secondary" className="px-1.5 py-0">
                          {subLangs.length}
                        </Badge>
                      )}
                    </Label>
                    <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto rounded-md border p-2.5">
                      {result.subtitles
                        .filter((s) => !s.auto)
                        .map((s) => (
                          <label
                            key={s.lang}
                            className="flex cursor-pointer items-center gap-1.5 text-xs"
                          >
                            <Checkbox
                              checked={subLangs.includes(s.lang)}
                              onCheckedChange={() => toggleSub(s.lang)}
                            />
                            {s.name || s.lang}
                          </label>
                        ))}
                      {result.subtitles.filter((s) => !s.auto).length === 0 && (
                        <span className="text-xs text-muted-foreground">
                          Only auto-generated captions available
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Metadata editing */}
                <div>
                  <button
                    onClick={() => setShowMeta((v) => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit metadata {showMeta ? "▾" : "▸"}
                  </button>
                  <AnimatePresence>
                    {showMeta && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="grid grid-cols-2 gap-3 pt-3">
                          {(
                            [
                              ["title", "Title"],
                              ["artist", "Artist"],
                              ["album", "Album"],
                              ["genre", "Genre"],
                            ] as const
                          ).map(([k, label]) => (
                            <div key={k} className="space-y-1">
                              <Label className="text-xs text-muted-foreground">{label}</Label>
                              <Input
                                value={meta[k]}
                                onChange={(e) => setMeta({ ...meta, [k]: e.target.value })}
                                placeholder={k === "title" ? result.title : ""}
                                className="h-8"
                              />
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <Separator />
                <Button className="w-full" onClick={enqueueSingle} disabled={!settings}>
                  <Download className="h-4 w-4" /> Download{" "}
                  {kind === "audio" ? audioFormat.toUpperCase() : ""}
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- Playlist / channel ---- */}
      <AnimatePresence>
        {result && result.kind === "playlist" && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="flex items-center gap-2">
                  <ListVideo className="h-5 w-5 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{result.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {result.entryCount ?? result.entries.length} videos
                      {result.uploader ? ` · ${result.uploader}` : ""}
                    </div>
                  </div>
                </div>

                <KindTabs kind={kind} setKind={setKind} />
                {kind === "video" ? (
                  <PresetSelect preset={preset} setPreset={setPreset} />
                ) : (
                  <AudioOptions
                format={audioFormat}
                onFormatChange={setAudioFormat}
                bitrateMode={bitrateMode}
                onBitrateModeChange={setBitrateMode}
              />
                )}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      Items ({selectedEntries.size}/{result.entries.length} selected)
                    </Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() =>
                        setSelectedEntries(
                          selectedEntries.size === result.entries.length
                            ? new Set()
                            : new Set(result.entries.map((_, i) => i))
                        )
                      }
                    >
                      {selectedEntries.size === result.entries.length
                        ? "Deselect all"
                        : "Select all"}
                    </Button>
                  </div>
                  <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
                    {result.entries.map((entry, i) => (
                      <label
                        key={entry.id + i}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
                      >
                        <Checkbox
                          checked={selectedEntries.has(i)}
                          onCheckedChange={() =>
                            setSelectedEntries((cur) => {
                              const next = new Set(cur);
                              if (next.has(i)) next.delete(i);
                              else next.add(i);
                              return next;
                            })
                          }
                        />
                        <span className="w-6 shrink-0 text-right text-muted-foreground">
                          {i + 1}.
                        </span>
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        {entryDownloaded[i] && (
                          <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/15 px-1 text-[10px] font-medium text-amber-500">
                            downloaded
                          </span>
                        )}
                        {entry.duration ? (
                          <span className="shrink-0 font-mono text-muted-foreground">
                            {formatDuration(entry.duration)}
                          </span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                </div>

                <Button
                  className="w-full"
                  onClick={enqueuePlaylist}
                  disabled={selectedEntries.size === 0}
                >
                  <Download className="h-4 w-4" /> Download {selectedEntries.size} item
                  {selectedEntries.size === 1 ? "" : "s"}
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function KindTabs({
  kind,
  setKind,
}: {
  kind: DownloadKind;
  setKind: (k: DownloadKind) => void;
}) {
  return (
    <Tabs value={kind} onValueChange={(v) => setKind(v as DownloadKind)}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="video">
          <Film className="h-3.5 w-3.5" /> Video
        </TabsTrigger>
        <TabsTrigger value="audio">
          <AudioLines className="h-3.5 w-3.5" /> Audio only
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function PresetSelect({
  preset,
  setPreset,
}: {
  preset: string;
  setPreset: (p: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Quality preset</Label>
      <Select value={preset} onValueChange={setPreset}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AudioOptions({
  format,
  onFormatChange,
  bitrateMode,
  onBitrateModeChange,
}: {
  format: AudioFormat;
  onFormatChange: (v: AudioFormat) => void;
  bitrateMode: BitrateMode;
  onBitrateModeChange: (v: BitrateMode) => void;
}) {
  return (
    <div className="space-y-3">
      <AudioFormatSelect value={format} onChange={onFormatChange} />
      {format === "mp3" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Bitrate mode</Label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["cbr", "CBR", "constant · joint stereo · matches source quality"],
                ["vbr", "VBR", "variable · V0 best quality"],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                onClick={() => onBitrateModeChange(value)}
                className={cn(
                  "flex flex-col items-center rounded-lg border px-2 py-2 text-xs transition-colors",
                  bitrateMode === value
                    ? "border-primary bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                <span className="font-semibold">{label}</span>
                <span className="text-[10px] opacity-70">{hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AudioFormatSelect({
  value,
  onChange,
}: {
  value: AudioFormat;
  onChange: (v: AudioFormat) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Audio format</Label>
      <div className="grid grid-cols-5 gap-2">
        {AUDIO_FORMATS.map((f) => (
          <button
            key={f.value}
            onClick={() => onChange(f.value)}
            className={cn(
              "flex flex-col items-center rounded-lg border px-2 py-2 text-xs transition-colors",
              value === f.value
                ? "border-primary bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-accent"
            )}
          >
            <Music className="mb-1 h-3.5 w-3.5" />
            <span className="font-semibold">{f.label}</span>
            <span className="text-[10px] opacity-70">{f.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
