import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { formatAgo, formatDateTime, formatDuration, formatTime } from "./format";

// In production the dashboard is served BY the worker, so relative URLs work;
// in local dev Vite (5173) and wrangler (8787) are separate processes.
const WORKER_URL = (import.meta.env.VITE_WORKER_URL as string | undefined) ?? "";

export default function App() {
  const runs = useQuery(api.runs.list, { limit: 50 });
  const state = useQuery(api.admin.state, {});
  const config = useQuery(api.admin.getConfig, {});
  const [selectedRunId, setSelectedRunId] = useState<Id<"runs"> | null>(null);

  const latestRunId = runs?.[0]?._id ?? null;
  const activeRunId = selectedRunId ?? latestRunId;

  if (runs === undefined || state === undefined || config === undefined) {
    return <div className="loading">Connecting to Convex…</div>;
  }

  return (
    <div className="app">
      <Header state={state} config={config} />
      <main className="columns">
        <RunList runs={runs} activeRunId={activeRunId} onSelect={setSelectedRunId} />
        {activeRunId ? (
          <RunDetail runId={activeRunId} />
        ) : (
          <section className="detail empty">No runs yet — trigger one above.</section>
        )}
      </main>
    </div>
  );
}

type AgentState = { paused: boolean; lastSuccessfulAt: number | null };
type AgentConfig = { urls: string[]; injectFailure: boolean };

function Header({ state, config }: { state: AgentState; config: AgentConfig }) {
  const setPaused = useMutation(api.admin.setPaused);
  const setInjectFailure = useMutation(api.admin.setInjectFailure);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  async function triggerRun() {
    setTriggering(true);
    setTriggerError(null);
    try {
      // One key per click: a retried request can't start a second run.
      const runKey = `manual-${crypto.randomUUID()}`;
      const response = await fetch(`${WORKER_URL}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runKey }),
      });
      if (!response.ok) throw new Error(`worker responded ${response.status}`);
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error));
    } finally {
      setTriggering(false);
    }
  }

  return (
    <header className="header">
      <div className="brand">
        <span className={`dot ${state.paused ? "dot-paused" : "dot-live"}`} />
        <h1>Signal</h1>
        <span className="subtitle">
          {state.paused ? "paused" : "watching"} {config.urls.length} URLs
          {state.lastSuccessfulAt && (
            <> · last success {formatAgo(state.lastSuccessfulAt)}</>
          )}
        </span>
      </div>
      <div className="controls">
        <label className="toggle" title="Deliberately fail the next run midway to demonstrate recovery">
          <input
            type="checkbox"
            checked={config.injectFailure}
            onChange={(e) => setInjectFailure({ injectFailure: e.target.checked })}
          />
          Inject failure
        </label>
        <button onClick={() => setPaused({ paused: !state.paused })}>
          {state.paused ? "Resume agent" : "Pause agent"}
        </button>
        <button className="primary" onClick={triggerRun} disabled={triggering}>
          {triggering ? "Running…" : "Run now"}
        </button>
        {triggerError && <span className="trigger-error">{triggerError}</span>}
      </div>
    </header>
  );
}

function RunList({
  runs,
  activeRunId,
  onSelect,
}: {
  runs: Doc<"runs">[];
  activeRunId: Id<"runs"> | null;
  onSelect: (id: Id<"runs">) => void;
}) {
  return (
    <section className="timeline">
      <h2>Run history</h2>
      <ul>
        {runs.map((run) => (
          <li key={run._id}>
            <button
              className={`run-row ${run._id === activeRunId ? "active" : ""}`}
              onClick={() => onSelect(run._id)}
            >
              <StatusBadge status={run.status} />
              <span className="run-time">{formatTime(run.startedAt)}</span>
              <span className="run-trigger">{run.trigger}</span>
              <span className="run-progress">
                {run.urlsCompleted}/{run.urlsTotal}
              </span>
              {run.changesCount > 0 && (
                <span className="changes-badge">
                  {run.changesCount} change{run.changesCount > 1 ? "s" : ""}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunDetail({ runId }: { runId: Id<"runs"> }) {
  const data = useQuery(api.runs.get, { runId });
  if (data === undefined) return <section className="detail">Loading…</section>;
  if (data === null) return <section className="detail">Run not found.</section>;
  const { run, checks } = data;

  return (
    <section className="detail">
      <div className="detail-header">
        <StatusBadge status={run.status} />
        <h2>{formatDateTime(run.startedAt)}</h2>
        <span className="meta">
          {run.trigger} · {run.urlsCompleted}/{run.urlsTotal} URLs
          {run.finishedAt && <> · took {formatDuration(run.finishedAt - run.startedAt)}</>}
        </span>
      </div>
      {run.error && <div className="run-error">Run error: {run.error}</div>}
      {run.status === "failed" && run.urlsCompleted < run.urlsTotal && (
        <div className="recovery-note">
          This run stopped after {run.urlsCompleted} of {run.urlsTotal} URLs. The
          recorded results are kept, the checkpoint did not advance, and the next
          run diffed against the last successful run as if this one never happened.
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Status</th>
            <th>Latency</th>
            <th>Change vs last success</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check._id}>
              <td className="url">{check.url}</td>
              <td>
                {check.error ? (
                  <span className="pill pill-failed">{check.error}</span>
                ) : (
                  <span className={`pill ${check.ok ? "pill-ok" : "pill-failed"}`}>
                    {check.statusCode}
                  </span>
                )}
              </td>
              <td>{check.latencyMs !== undefined ? `${check.latencyMs}ms` : "—"}</td>
              <td>
                <ChangeCell change={check.change} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ChangeCell({ change }: { change?: Doc<"checks">["change"] }) {
  if (!change) return <span className="no-change">no change</span>;
  switch (change.kind) {
    case "new":
      return <span className="pill pill-new">new URL</span>;
    case "broke":
      return <span className="pill pill-failed">broke (was {change.prevStatusCode ?? "ok"})</span>;
    case "recovered":
      return <span className="pill pill-ok">recovered (was {change.prevStatusCode ?? "down"})</span>;
    case "statusChanged":
      return <span className="pill pill-warn">{change.prevStatusCode} → now</span>;
  }
}

function StatusBadge({ status }: { status: Doc<"runs">["status"] }) {
  const label = { running: "running", succeeded: "ok", failed: "failed" }[status];
  return <span className={`pill pill-status-${status}`}>{label}</span>;
}
