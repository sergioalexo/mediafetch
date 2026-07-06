import { useMemo } from "react";
import { formatSpeed } from "@/lib/utils";

interface Props {
  samples: { t: number; speed: number }[];
  height?: number;
  className?: string;
}

/** Lightweight SVG area chart of download speed over time. */
export function SpeedGraph({ samples, height = 120, className }: Props) {
  const { path, area, max } = useMemo(() => {
    const w = 100; // viewBox units, stretched by CSS
    const h = 100;
    if (samples.length < 2) return { path: "", area: "", max: 0 };
    const max = Math.max(...samples.map((s) => s.speed), 1);
    const step = w / (samples.length - 1);
    const pts = samples.map((s, i) => {
      const x = i * step;
      const y = h - (s.speed / max) * (h - 8) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const path = `M ${pts.join(" L ")}`;
    const area = `${path} L 100,100 L 0,100 Z`;
    return { path, area, max };
  }, [samples]);

  const current = samples.length ? samples[samples.length - 1].speed : 0;

  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">Speed</span>
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-muted-foreground">peak {formatSpeed(max)}</span>
          <span className="font-mono text-sm font-semibold text-primary">
            {formatSpeed(current)}
          </span>
        </div>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ height }}
        className="w-full rounded-md border bg-secondary/30"
      >
        {area && (
          <>
            <defs>
              <linearGradient id="speedFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.35" />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#speedFill)" />
            <path
              d={path}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
    </div>
  );
}
