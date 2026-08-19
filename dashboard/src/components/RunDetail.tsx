import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { formatDateTime, formatDuration } from "../format";
import { ChangePill, CheckStatusPill, StatusPill } from "./pills";

export function RunDetail({ runId }: { runId: Id<"runs"> }) {
  const data = useQuery(api.runs.get, { runId });
  if (data === undefined) {
    return <section className="panel detail quiet">Loading…</section>;
  }
  if (data === null) {
    return <section className="panel detail quiet">Run not found.</section>;
  }
  const { run, checks } = data;
  const maxLatency = Math.max(...checks.map((c) => c.latencyMs ?? 0), 1);

  return (
    <section className="panel detail" aria-label="Run detail">
      <div className="detail-header">
        <StatusPill status={run.status} />
        <h2>{formatDateTime(run.startedAt)}</h2>
        <span className="quiet">
          {run.trigger} trigger · {run.urlsCompleted}/{run.urlsTotal} URLs
          {run.finishedAt && <> · {formatDuration(run.finishedAt - run.startedAt)}</>}
        </span>
      </div>

      {run.error && (
        <div className="note note-critical">
          <span className="pill-icon">✕</span> {run.error}
        </div>
      )}
      {run.status === "failed" && run.urlsCompleted < run.urlsTotal && (
        <div className="note note-info">
          <span className="pill-icon">↺</span> This run stopped after{" "}
          {run.urlsCompleted} of {run.urlsTotal} URLs. Recorded results are kept,
          the checkpoint did not advance, and the next run diffs against the last
          successful run as if this one never happened.
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th className="th-latency">Latency</th>
              <th>Change vs last success</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check._id}>
                <td className="url">{check.url}</td>
                <td>
                  <CheckStatusPill check={check} />
                </td>
                <td className="latency-cell">
                  {check.latencyMs !== undefined ? (
                    <LatencyMeter value={check.latencyMs} max={maxLatency} />
                  ) : (
                    <span className="quiet">—</span>
                  )}
                </td>
                <td>
                  <ChangePill change={check.change} />
                </td>
              </tr>
            ))}
            {checks.length === 0 && (
              <tr>
                <td colSpan={4} className="quiet">
                  No checks recorded for this run.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Magnitude as bar length in a single sequential hue; the unfilled track is a
 * lighter step of the same ramp. The value rides beside it in text ink.
 */
function LatencyMeter({ value, max }: { value: number; max: number }) {
  const percent = Math.max(4, Math.round((value / max) * 100));
  return (
    <span className="meter" title={`${value}ms`}>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="meter-value">{value}ms</span>
    </span>
  );
}
