import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { formatTime } from "../format";
import { StatusPill } from "./pills";

export function RunList({
  runs,
  activeRunId,
  onSelect,
}: {
  runs: Doc<"runs">[];
  activeRunId: Id<"runs"> | null;
  onSelect: (id: Id<"runs">) => void;
}) {
  return (
    <section className="panel timeline" aria-label="Run history">
      <div className="panel-title">
        <h2>Run history</h2>
        <span className="quiet">{runs.length} runs</span>
      </div>
      <ul>
        {runs.map((run) => (
          <li key={run._id}>
            <button
              className={`run-row ${run._id === activeRunId ? "active" : ""}`}
              onClick={() => onSelect(run._id)}
            >
              <StatusPill status={run.status} />
              <span className="run-time">{formatTime(run.startedAt)}</span>
              <span className={`chip chip-${run.trigger}`}>{run.trigger}</span>
              <span className="run-right">
                {run.changesCount > 0 && (
                  <span className="pill pill-warning pill-small">
                    <span className="pill-icon">Δ</span> {run.changesCount}
                  </span>
                )}
                <span className="quiet run-progress">
                  {run.urlsCompleted}/{run.urlsTotal}
                </span>
              </span>
            </button>
          </li>
        ))}
        {runs.length === 0 && (
          <li className="empty-list">No runs yet — trigger one from the header.</li>
        )}
      </ul>
    </section>
  );
}
