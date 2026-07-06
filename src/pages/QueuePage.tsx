import { AnimatePresence } from "framer-motion";
import { ListX, PackageOpen } from "lucide-react";
import { useApp } from "@/lib/store";
import * as api from "@/lib/api";
import { QueueItem } from "@/components/QueueItem";
import { SpeedGraph } from "@/components/SpeedGraph";
import { Button } from "@/components/ui/button";

export function QueuePage() {
  const queue = useApp((s) => s.queue);
  const samples = useApp((s) => s.speedSamples);

  const active = queue.filter(
    (t) => t.status === "downloading" || t.status === "postprocessing"
  );
  const finished = queue.filter(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled"
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Queue</h1>
          <p className="text-sm text-muted-foreground">
            {active.length > 0
              ? `${active.length} active · ${queue.filter((t) => t.status === "queued").length} waiting`
              : queue.length === 0
                ? "Nothing queued"
                : `${queue.length} item${queue.length > 1 ? "s" : ""}`}
          </p>
        </div>
        {finished.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => api.clearFinished()}>
            <ListX className="h-3.5 w-3.5" /> Clear finished
          </Button>
        )}
      </div>

      {active.length > 0 && <SpeedGraph samples={samples} height={90} />}

      {queue.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
          <PackageOpen className="h-10 w-10 opacity-40" />
          <div className="text-sm">The queue is empty — add a URL on the Download page.</div>
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {queue.map((task, i) => (
              <QueueItem key={task.id} task={task} index={i} count={queue.length} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
