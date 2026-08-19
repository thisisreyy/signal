import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ActivityFeed } from "./components/ActivityFeed";
import { Hero } from "./components/Hero";
import { AddSiteCard, SiteCard } from "./components/SiteCard";
import { triggerCheck, useNowTick } from "./lib";

export default function App() {
  const sites = useQuery(api.admin.sites, {});
  const runs = useQuery(api.runs.list, { limit: 30 });
  const state = useQuery(api.admin.state, {});
  const setPaused = useMutation(api.admin.setPaused);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  useNowTick();

  if (sites === undefined || runs === undefined || state === undefined) {
    return (
      <div className="loading">
        <span className="hero-dot hero-dot-good" /> Waking up…
      </div>
    );
  }

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
        </div>
        <div className="controls">
          {checkError && <span className="trigger-error" role="alert">✕ {checkError}</span>}
          <label className="switch" title="Run a check automatically every 5 minutes">
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

      <Hero sites={sites} paused={state.paused} lastSuccessfulAt={state.lastSuccessfulAt} />

      <section className="sites" aria-label="Watched sites">
        {sites.map((site) => (
          <SiteCard key={site.url} site={site} />
        ))}
        <AddSiteCard />
      </section>

      <ActivityFeed runs={runs} />

      <footer className="footer quiet">
        Signal checks your sites on a schedule, remembers everything, and heals
        itself when a check crashes.
      </footer>
    </div>
  );
}
