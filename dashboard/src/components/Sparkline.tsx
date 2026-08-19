import { useRef, useState } from "react";

/**
 * 12-point trend sparkline for a stat tile: 2px line in the de-emphasis hue,
 * current point in the accent with a surface ring, hover reveals each value.
 */
export function Sparkline({
  points,
  formatValue,
  width = 120,
  height = 36,
  invert = false,
}: {
  points: { label: string; value: number }[];
  formatValue: (value: number) => string;
  width?: number;
  height?: number;
  /** For ranks: lower value = better = drawn higher. */
  invert?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (points.length < 2) return null;

  const pad = 6;
  const max = Math.max(...points.map((p) => p.value));
  const min = Math.min(...points.map((p) => p.value));
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (v: number) => {
    const t = (v - min) / span;
    return pad + (invert ? t : 1 - t) * (height - pad * 2);
  };
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  const last = points.length - 1;
  const active = hover ?? last;

  function onMove(event: React.MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = (event.clientX - rect.left - pad) / (rect.width - pad * 2);
    const index = Math.round(rel * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  }

  return (
    <div className="spark">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Trend, latest ${formatValue(points[last]!.value)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <path d={path} className="spark-line" fill="none" />
        <circle
          cx={x(active)}
          cy={y(points[active]!.value)}
          r={4}
          className={active === last && hover === null ? "spark-dot-accent" : "spark-dot"}
        />
      </svg>
      <span className={`spark-value ${hover !== null ? "" : "spark-value-hidden"}`}>
        {hover !== null && `${points[hover]!.label} · ${formatValue(points[hover]!.value)}`}
      </span>
    </div>
  );
}
