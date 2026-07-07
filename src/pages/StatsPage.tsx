import { useMemo } from "react";
import { CheckCircle2, Clock, Download, Gauge, HardDrive, XCircle } from "lucide-react";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { formatBytes, formatEta, formatSpeed } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { SpeedGraph } from "@/components/SpeedGraph";

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Download;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <div className="text-lg font-bold leading-tight">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatsPage() {
  const history = useApp((s) => s.history);
  const samples = useApp((s) => s.speedSamples);
  const queue = useApp((s) => s.queue);
  const t = useT();

  const stats = useMemo(() => {
    const completed = history.filter((h) => h.status === "completed");
    const failed = history.filter((h) => h.status === "failed");
    const totalBytes = completed.reduce((s, h) => s + (h.filesize || 0), 0);
    const totalTime = completed.reduce((s, h) => s + (h.elapsedSecs || 0), 0);
    const speeds = completed.filter((h) => h.avgSpeed > 0);
    const avgSpeed = speeds.length
      ? speeds.reduce((s, h) => s + h.avgSpeed, 0) / speeds.length
      : 0;
    return { completed: completed.length, failed: failed.length, totalBytes, totalTime, avgSpeed };
  }, [history]);

  const activeCount = queue.filter((t) => t.status === "downloading").length;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">{t("s.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("s.subtitle")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat icon={CheckCircle2} label={t("s.completed")} value={String(stats.completed)} />
        <Stat icon={XCircle} label={t("s.failed")} value={String(stats.failed)} />
        <Stat
          icon={HardDrive}
          label={t("s.totalDownloaded")}
          value={formatBytes(stats.totalBytes)}
        />
        <Stat icon={Gauge} label={t("s.avgSpeed")} value={formatSpeed(stats.avgSpeed)} />
        <Stat icon={Clock} label={t("s.timeDownloading")} value={formatEta(stats.totalTime)} />
        <Stat icon={Download} label={t("s.activeNow")} value={String(activeCount)} />
      </div>

      <Card>
        <CardContent className="p-4">
          <SpeedGraph samples={samples} height={160} />
        </CardContent>
      </Card>
    </div>
  );
}
