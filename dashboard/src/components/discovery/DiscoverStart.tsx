import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { formatAgo } from "../../format";

const STAGES = [
  { n: "01", label: "Profile", body: "Reads the homepage, pricing, about and docs" },
  { n: "02", label: "Propose", body: "Suggests 15–25 searches a buyer might type" },
  { n: "03", label: "Test", body: "Runs each on Google and keeps what holds up" },
  { n: "04", label: "Rivals", body: "Whoever ranks is the competition" },
  { n: "05", label: "Advise", body: "Predictions it scores itself on later" },
];

/** The onboarding screen: one URL in, a whole discovery out. */
export function DiscoverStart({
  runs,
  onOpen,
}: {
  runs: {
    _id: Id<"discoveryRuns">;
    url: string;
    state: string;
    error?: string;
    searchCalls: number;
    llmCalls: number;
    createdAt: number;
  }[];
  onOpen: (id: Id<"discoveryRuns">) => void;
}) {
  const start = useMutation(api.discovery.index.start);
  const resume = useMutation(api.discovery.index.resume);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await start({ url });
      onOpen(result.discoveryId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="start">
      <div className="start-hero">
        <span className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          Auto-discovery
        </span>
        <h2 className="start-title">Point Signal at a website.</h2>
        <p className="start-lede">
          It reads the site, proposes the searches a buyer would type, tests every one
          against real Google results, works out who actually ranks — then writes
          recommendations it will later grade itself on.
        </p>
      </div>

      <form className="start-form" onSubmit={submit}>
        <div className="start-field">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
          </svg>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="yourcompany.com"
            aria-label="Website address"
          />
        </div>
        <button className="btn btn-primary start-go" type="submit" disabled={busy || !url.trim()}>
          {busy ? "Starting…" : "Start discovery"}
        </button>
      </form>
      {error ? (
        <p className="start-note" style={{ color: "var(--bad)" }}>{error}</p>
      ) : (
        <p className="start-note">
          Costs about 23 searches and 10 model calls. Nothing is tracked until you approve it.
        </p>
      )}

      <div className="stages">
        {STAGES.map((s) => (
          <div className="stage" key={s.n}>
            <div className="stage-n">{s.n} · {s.label.toUpperCase()}</div>
            <div className="stage-body">{s.body}</div>
          </div>
        ))}
      </div>

      {runs.length > 0 && (
        <div className="prev">
          <div className="prev-head">
            <h3>Previous discoveries</h3>
            <span className="quiet">Re-running a site reuses any search less than 24h old</span>
          </div>
          {runs.map((run) => {
            const failed = run.state === "FAILED";
            const done = run.state === "COMPLETE";
            return (
              <div className={`prev-row ${done ? "prev-done" : ""}`} key={run._id}>
                <span className={`feed-icon feed-icon-${failed ? "bad" : done ? "good" : "idle"}`}>
                  {failed ? "✕" : done ? "✓" : "◌"}
                </span>
                <div className="prev-main">
                  <div className="prev-url">{run.url.replace(/^https?:\/\//, "")}</div>
                  <div className="quiet">
                    {failed
                      ? run.error ?? "Failed"
                      : `${run.state.toLowerCase().replace(/_/g, " ")} · started ${formatAgo(run.createdAt)}`}
                  </div>
                </div>
                <div className="prev-cost">
                  <span>{run.searchCalls} searches</span>
                  <span>{run.llmCalls} model calls</span>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    if (failed) await resume({ discoveryId: run._id });
                    onOpen(run._id);
                  }}
                >
                  {failed ? "Resume" : "Open"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
