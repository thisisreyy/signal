import type { Doc } from "../../../convex/_generated/dataModel";
import { formatAgo, formatDuration, formatTime } from "../format";
import { Sparkline } from "./Sparkline";

/** Headline numbers computed client-side from the reactive run list. */
export function StatTiles({
  runs,
  lastSuccessfulAt,
}: {
  runs: Doc<"runs">[];
  lastSuccessfulAt: number | null;
}) {
  const finished = runs.filter((r) => r.status !== "running");
  const succeeded = finished.filter((r) => r.status === "succeeded");
  const successRate =
    finished.length > 0 ? Math.round((succeeded.length / finished.length) * 100) : null;

  const durations = succeeded
    .filter((r) => r.finishedAt !== undefined)
    .map((r) => ({ startedAt: r.startedAt, ms: r.finishedAt! - r.startedAt }));
  const avgDuration =
    durations.length > 0
      ? Math.round(durations.reduce((sum, d) => sum + d.ms, 0) / durations.length)
      : null;
  const trend = durations
    .slice(0, 12)
    .reverse()
    .map((d) => ({ label: formatTime(d.startedAt), value: d.ms }));

  const changes = finished.reduce((sum, r) => sum + r.changesCount, 0);

  return (
    <section className="tiles" aria-label="Summary">
      <div className="tile">
        <span className="tile-label">Success rate</span>
        <span className="tile-value">
          {successRate !== null ? `${successRate}%` : "—"}
        </span>
        <span className="tile-hint">last {finished.length} runs</span>
      </div>
      <div className="tile">
        <span className="tile-label">Avg run duration</span>
        <span className="tile-value">
          {avgDuration !== null ? formatDuration(avgDuration) : "—"}
        </span>
        <Sparkline points={trend} formatValue={formatDuration} />
      </div>
      <div className="tile">
        <span className="tile-label">Changes detected</span>
        <span className="tile-value">{changes}</span>
        <span className="tile-hint">across {finished.length} runs</span>
      </div>
      <div className="tile">
        <span className="tile-label">Last success</span>
        <span className="tile-value">
          {lastSuccessfulAt ? formatAgo(lastSuccessfulAt) : "never"}
        </span>
        <span className="tile-hint">
          {lastSuccessfulAt ? `at ${formatTime(lastSuccessfulAt)}` : "no successful run yet"}
        </span>
      </div>
    </section>
  );
}
