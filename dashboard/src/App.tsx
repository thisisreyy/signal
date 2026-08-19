import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ActivityFeed } from "./components/ActivityFeed";
import { Hero } from "./components/Hero";
import { KeywordCard } from "./components/KeywordCard";
import { SignalsFeed } from "./components/SignalsFeed";
import { TrackingPanel } from "./components/TrackingPanel";
import { triggerCheck, useNowTick } from "./lib";

export default function App() {
  const runs = useQuery(api.runs.list, { limit: 30 });
  const state = useQuery(api.admin.state, {});
  const config = useQuery(api.admin.getConfig, {});
  const setPaused = useMutation(api.admin.setPaused);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  useNowTick();

  if (runs === undefined || state === undefined || config === undefined) {
    return (
      <div className="loading">
        <span className="hero-dot hero-dot-good" /> Waking up…
      </div>
    );
  }

  const latestSource = runs.find((r) => r.status !== "running")?.source;

  async function checkNow() {
    setChecking(true);
    setCheckError(null);
    try {
      await triggerCheck();
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <span className={`logo-dot ${state.paused ? "logo-paused" : "logo-live"}`} />
          </span>
          <h1>Signal</h1>
          {latestSource === "simulated" && (
            <span
              className="chip-tag chip-demo"
              title="No SERPER_API_KEY configured — rankings are fabricated demo data. Add the key to switch to real Google results."
            >
              demo data
            </span>
          )}
        </div>
        <div className="controls">
          {checkError && <span className="trigger-error" role="alert">✕ {checkError}</span>}
          <label className="switch" title="Check rankings automatically every day">
            <input
              type="checkbox"
              checked={!state.paused}
              onChange={(e) => setPaused({ paused: !e.target.checked })}
            />
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            Auto-check
          </label>
          <button className="btn btn-primary" onClick={checkNow} disabled={checking}>
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>
      </header>

      <Hero
        businessName={config.business.name}
        keywordCount={config.keywords.length}
        paused={state.paused}
        lastSuccessfulAt={state.lastSuccessfulAt}
      />

      <section className="sites" aria-label="Tracked keywords">
        {config.keywords.map((keyword) => (
          <KeywordCard key={keyword} keyword={keyword} />
        ))}
      </section>

      <div className="two-col">
        <SignalsFeed businessDomain={config.business.domain} />
        <TrackingPanel config={config} />
      </div>

      <ActivityFeed runs={runs} />

      <footer className="footer quiet">
        Signal watches your search rankings on a schedule, remembers every run,
        and heals itself when a check crashes.
      </footer>
    </div>
  );
}
