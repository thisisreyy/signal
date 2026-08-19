import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { formatDuration, formatTime } from "../format";
import { hostOf, triggerCheck } from "../lib";
import { ChangePill, CheckStatusPill } from "./pills";

/** Runs as plain sentences; click one to see the per-site details. */
export function ActivityFeed({ runs }: { runs: Doc<"runs">[] }) {
  const [openRunId, setOpenRunId] = useState<Id<"runs"> | null>(null);

  return (
    <section className="feed">
      <div className="feed-head">
        <h2>Activity</h2>
        <SimulateCrashButton />
      </div>
      <ul>
        {runs.map((run) => (
          <FeedItem
            key={run._id}
            run={run}
            open={openRunId === run._id}
            onToggle={() => setOpenRunId(openRunId === run._id ? null : run._id)}
          />
        ))}
        {runs.length === 0 && <li className="feed-empty">Nothing yet — press “Check now”.</li>}
      </ul>
    </section>
  );
}

function describe(run: Doc<"runs">): { icon: string; tone: string; text: string } {
  if (run.status === "running") {
    return { icon: "◌", tone: "idle", text: `Checking ${run.urlsTotal} sites…` };
  }
  if (run.status === "failed") {
    const crashed = run.urlsCompleted < run.urlsTotal;
    return {
      icon: "✕",
      tone: "bad",
      text: crashed
        ? `Check crashed partway (${run.urlsCompleted} of ${run.urlsTotal} sites done) — nothing lost, the next check healed itself`
        : `Check failed — ${run.error ?? "unknown error"}`,
    };
  }
  if (run.changesCount > 0) {
    return {
      icon: "Δ",
      tone: "warn",
      text: `Checked ${run.urlsCompleted} sites — ${run.changesCount} ${run.changesCount === 1 ? "change" : "changes"} since last time`,
    };
  }
  return {
    icon: "✓",
    tone: "good",
    text: `Checked ${run.urlsCompleted} sites — no changes`,
  };
}

function FeedItem({
  run,
  open,
  onToggle,
}: {
  run: Doc<"runs">;
  open: boolean;
  onToggle: () => void;
}) {
  const { icon, tone, text } = describe(run);
  return (
    <li className={`feed-item ${open ? "open" : ""}`}>
      <button className="feed-row" onClick={onToggle} aria-expanded={open}>
        <span className="feed-time">{formatTime(run.startedAt)}</span>
        <span className={`feed-icon feed-icon-${tone}`}>{icon}</span>
        <span className="feed-text">{text}</span>
        <span className="feed-meta">
          {run.trigger === "cron" ? "auto" : "manual"}
          {run.finishedAt && <> · {formatDuration(run.finishedAt - run.startedAt)}</>}
        </span>
        <span className="feed-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && <FeedDetail runId={run._id} />}
    </li>
  );
}

function FeedDetail({ runId }: { runId: Id<"runs"> }) {
  const data = useQuery(api.runs.get, { runId });
  if (!data) return <div className="feed-detail quiet">Loading…</div>;

  return (
    <div className="feed-detail">
      {data.run.error && (
        <p className="feed-detail-error">Why it stopped: {data.run.error}</p>
      )}
      <table>
        <tbody>
          {data.checks.map((check) => (
            <tr key={check._id}>
              <td className="url">{hostOf(check.url)}</td>
              <td><CheckStatusPill check={check} /></td>
              <td className="num">{check.latencyMs !== undefined ? `${check.latencyMs}ms` : "—"}</td>
              <td><ChangePill change={check.change} /></td>
            </tr>
          ))}
          {data.checks.length === 0 && (
            <tr><td className="quiet">It stopped before reaching any site.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The recovery demo as one safe button: deliberately crash the next check
 * midway, run it, then disarm — the feed shows the crash and the self-heal.
 */
function SimulateCrashButton() {
  const setInjectFailure = useMutation(api.admin.setInjectFailure);
  const [busy, setBusy] = useState(false);

  async function simulate() {
    setBusy(true);
    try {
      await setInjectFailure({ injectFailure: true });
      await triggerCheck();
    } finally {
      await setInjectFailure({ injectFailure: false });
      setBusy(false);
    }
  }

  return (
    <button
      className="btn btn-ghost"
      onClick={simulate}
      disabled={busy}
      title="Deliberately crash one check midway to watch the system heal itself"
    >
      {busy ? "Crashing one check…" : "⚡ Simulate a crash"}
    </button>
  );
}
