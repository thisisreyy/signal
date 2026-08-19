import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";

// In production the dashboard is served BY the worker, so relative URLs work;
// in local dev Vite (5173) and wrangler (8787) are separate processes.
const WORKER_URL = (import.meta.env.VITE_WORKER_URL as string | undefined) ?? "";

export type AgentState = { paused: boolean; lastSuccessfulAt: number | null };
export type AgentConfig = { urls: string[]; injectFailure: boolean };

export function Header({ state, config }: { state: AgentState; config: AgentConfig }) {
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
        <span className="logo" aria-hidden="true">
          <span className={`logo-dot ${state.paused ? "logo-paused" : "logo-live"}`} />
        </span>
        <div className="brand-text">
          <h1>Signal</h1>
          <span className="quiet">
            {state.paused ? "Paused" : "Live"} · watching {config.urls.length} URLs
          </span>
        </div>
      </div>

      <div className="controls">
        {triggerError && (
          <span className="trigger-error" role="alert">
            ✕ {triggerError}
          </span>
        )}
        <label
          className={`switch ${config.injectFailure ? "switch-armed" : ""}`}
          title="Deliberately fail the next run midway to demonstrate recovery"
        >
          <input
            type="checkbox"
            checked={config.injectFailure}
            onChange={(e) => setInjectFailure({ injectFailure: e.target.checked })}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          Inject failure
        </label>
        <button className="btn" onClick={() => setPaused({ paused: !state.paused })}>
          {state.paused ? "Resume agent" : "Pause agent"}
        </button>
        <button className="btn btn-primary" onClick={triggerRun} disabled={triggering}>
          {triggering ? "Running…" : "Run now"}
        </button>
      </div>
    </header>
  );
}
