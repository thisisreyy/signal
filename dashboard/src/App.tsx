import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { motion, useScroll, useTransform } from "framer-motion";
import { api } from "../../convex/_generated/api";
import { ActivityFeed } from "./components/ActivityFeed";
import { Hero } from "./components/Hero";
import { KeywordCard } from "./components/KeywordCard";
import { Observatory } from "./components/Observatory";
import { SignalsFeed } from "./components/SignalsFeed";
import { TrackingPanel } from "./components/TrackingPanel";
import { useCalm } from "./components/motion";
import { triggerCheck, useNowTick } from "./lib";

/**
 * Restrained page depth: two fixed radial illuminations that drift a few
 * percent with scroll. Transform/opacity only, pointer-events none, and
 * fully static under reduced motion or on small screens.
 */
function BackgroundDepth() {
  const calm = useCalm();
  const { scrollYProgress } = useScroll();
  const yA = useTransform(scrollYProgress, (v) => `${-4 + v * 10}%`);
  const yB = useTransform(scrollYProgress, (v) => `${4 - v * 10}%`);
  const oA = useTransform(scrollYProgress, (v) => (v < 0.5 ? 1 - v * 0.8 : 0.6 + (v - 0.5) * 0.5));

  if (calm) {
    return (
      <div className="bg-depth" aria-hidden="true">
        <div className="bg-layer bg-a" />
        <div className="bg-layer bg-b" />
      </div>
    );
  }
  return (
    <div className="bg-depth" aria-hidden="true">
      <motion.div className="bg-layer bg-a" style={{ y: yA, opacity: oA }} />
      <motion.div className="bg-layer bg-b" style={{ y: yB }} />
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
          {config.keywords.map((keyword, index) => (
            <KeywordCard key={keyword} keyword={keyword} index={index} />
          ))}
        </section>

        <Observatory
          left={<SignalsFeed businessDomain={config.business.domain} />}
          right={<TrackingPanel config={config} />}
        />

        <ActivityFeed runs={runs} />

        <footer className="footer quiet">
          Signal watches your search rankings on a schedule, remembers every run,
          and heals itself when a check crashes.
        </footer>
      </div>
    </>
  );
}
