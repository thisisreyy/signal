import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "../../convex/_generated/api";
import { ActivityFeed } from "./components/ActivityFeed";
import { Hero } from "./components/Hero";
import { KeywordCard } from "./components/KeywordCard";
import { SignalsFeed } from "./components/SignalsFeed";
import { TrackingPanel } from "./components/TrackingPanel";
import { useCalm } from "./components/motion";
import { DiscoveryView } from "./components/discovery/DiscoveryView";
import { triggerCheck, useNowTick } from "./lib";

/** Static, restrained page depth — two fixed radial illuminations. */
function BackgroundDepth() {
  return (
    <div className="bg-depth" aria-hidden="true">
      <div className="bg-layer bg-a" />
      <div className="bg-layer bg-b" />
    </div>
  );
}

export default function App() {
  const runs = useQuery(api.runs.list, { limit: 30 });
  const state = useQuery(api.admin.state, {});
  const config = useQuery(api.admin.getConfig, {});
  const setPaused = useMutation(api.admin.setPaused);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [view, setView] = useState<"rankings" | "discovery">("rankings");
  const calm = useCalm();
  useNowTick();

  if (runs === undefined || state === undefined || config === undefined) {
    return (
      <div className="loading">
        <span className="loading-dot" aria-hidden="true" />
        <span>Waking the agent…</span>
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
    <>
      <BackgroundDepth />
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <motion.span
              className="logo"
              aria-hidden="true"
              initial={calm ? false : { scale: 0.6, opacity: 0, rotate: -12 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 210, damping: 16 }}
            >
              <span className={`logo-dot ${state.paused ? "logo-paused" : "logo-live"}`} />
            </motion.span>
            <h1>Signal</h1>
            <nav className="nav" aria-label="Sections">
              <button
                className={`nav-tab ${view === "rankings" ? "active" : ""}`}
                onClick={() => setView("rankings")}
              >
                Rankings
              </button>
              <button
                className={`nav-tab ${view === "discovery" ? "active" : ""}`}
                onClick={() => setView("discovery")}
              >
                Discovery
              </button>
            </nav>
            {latestSource === "simulated" && view === "rankings" && (
              <span
                className="chip-tag chip-demo"
                title="No SERPER_API_KEY configured — rankings are fabricated demo data. Add the key to switch to real Google results."
              >
                demo data
              </span>
            )}
          </div>
          <div className="controls" hidden={view !== "rankings"}>
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

        {view === "discovery" ? (
          <DiscoveryView />
        ) : (
          <>
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

            <section className="observatory">
              <div className="obs-grid">
                <SignalsFeed businessDomain={config.business.domain} />
                <TrackingPanel config={config} />
              </div>
            </section>

            <ActivityFeed runs={runs} />
          </>
        )}

        <footer className="footer quiet">
          Signal watches your search rankings on a schedule, remembers every run,
          and heals itself when a check crashes.
        </footer>
      </div>
    </>
  );
}
