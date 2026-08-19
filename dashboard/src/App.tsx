import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Header } from "./components/Header";
import { StatTiles } from "./components/StatTiles";
import { RunList } from "./components/RunList";
import { RunDetail } from "./components/RunDetail";

export default function App() {
  const runs = useQuery(api.runs.list, { limit: 50 });
  const state = useQuery(api.admin.state, {});
  const config = useQuery(api.admin.getConfig, {});
  const [selectedRunId, setSelectedRunId] = useState<Id<"runs"> | null>(null);

  if (runs === undefined || state === undefined || config === undefined) {
    return (
      <div className="loading">
        <span className="logo-dot logo-live" /> Connecting to Convex…
      </div>
    );
  }

  const activeRunId = selectedRunId ?? runs[0]?._id ?? null;

  return (
    <div className="app">
      <Header state={state} config={config} />
      <StatTiles runs={runs} lastSuccessfulAt={state.lastSuccessfulAt} />
      <main className="columns">
        <RunList runs={runs} activeRunId={activeRunId} onSelect={setSelectedRunId} />
        {activeRunId ? (
          <RunDetail runId={activeRunId} />
        ) : (
          <section className="panel detail quiet">
            No runs yet — press “Run now” or wait for the next cron tick.
          </section>
        )}
      </main>
      <footer className="footer quiet">
        Signal · durable, idempotent, recoverable URL monitoring on Convex +
        Cloudflare Workers
      </footer>
    </div>
  );
}
