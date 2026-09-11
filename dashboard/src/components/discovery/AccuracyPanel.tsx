import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { CountUp } from "../bits";
import { formatAgo } from "../../format";

const STATUS_LABEL: Record<string, string> = {
  correct: "correct",
  incorrect: "missed",
  inconclusive: "couldn't judge",
  open: "open",
};

/** The outcome loop, visible: how often the recommendations were right. */
export function AccuracyPanel({ discoveryId }: { discoveryId: Id<"discoveryRuns"> }) {
  const summary = useQuery(api.discovery.index.accuracy, { discoveryId });
  const data = useQuery(api.discovery.index.getRun, { discoveryId });
  const scoreNow = useMutation(api.discovery.index.scoreNow);

  if (!summary || !data) return <p className="quiet">Loading…</p>;

  const judged = summary.correct + summary.incorrect;
  const scored = data.recommendations.filter((r) => r.status !== "open");

  return (
    <section className="acc">
      <div className="acc-side">
        <span className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          Self-scored
        </span>
        <div className="acc-big">
          {summary.accuracyRate === null ? (
            "—"
          ) : (
            <>
              <CountUp to={Math.round(summary.accuracyRate * 100)} />%
            </>
          )}
        </div>
        <div className="acc-cap">of predictions came true</div>
        <p className="sec-sub">
          {judged === 0
            ? "No deadline has passed yet. Predictions are checked hourly."
            : `${judged} deadline${judged > 1 ? "s have" : " has"} passed.`}
        </p>

        <div className="acc-rows">
          <div className="acc-row">
            <span style={{ color: "var(--good)" }}>Correct</span>
            <span className="acc-n">{summary.correct}</span>
          </div>
          <div className="acc-row">
            <span style={{ color: "var(--bad)" }}>Missed</span>
            <span className="acc-n">{summary.incorrect}</span>
          </div>
          <div className="acc-row">
            <span className="quiet">Couldn&apos;t judge</span>
            <span className="acc-n quiet">{summary.inconclusive}</span>
          </div>
          <div className="acc-row">
            <span style={{ color: "var(--accent)" }}>Still open</span>
            <span className="acc-n" style={{ color: "var(--accent)" }}>{summary.open}</span>
          </div>
        </div>

        <div className="acc-explain">
          <div className="acc-explain-title">Why “couldn&apos;t judge” is counted separately</div>
          <div className="quiet">
            If a keyword stops being tracked, that prediction is set aside rather than
            forgiven. Folding it into the score would let the number improve by losing data.
          </div>
        </div>

        {summary.open > 0 && (
          <button className="btn acc-score" onClick={() => scoreNow({ discoveryId })}>
            Score them now
          </button>
        )}
      </div>

      <div className="acc-main">
        <h2 className="sec-title">Every prediction, graded</h2>
        <p className="sec-sub">
          Compared against the same daily measurements the rankings page shows. No one grades
          these by hand.
        </p>

        <div className="acc-table">
          <div className="acc-thead">
            <span>Keyword</span>
            <span>Predicted</span>
            <span>Actual</span>
            <span>Verdict</span>
          </div>
          {scored.map((r) => (
            <div className="acc-trow" key={r._id}>
              <div>
                <div className="acc-kw">“{r.expectedOutcome.keyword}”</div>
                {r.scoringNote && <div className="quiet acc-note">{r.scoringNote}</div>}
              </div>
              <div className="acc-rank">#{r.expectedOutcome.predictedRank}</div>
              <div className={r.actualRank !== undefined ? "acc-rank acc-actual" : "quiet"}>
                {r.actualRank !== undefined ? `#${r.actualRank}` : "not ranked"}
              </div>
              <div>
                <span
                  className={`pill ${
                    r.status === "correct"
                      ? "pill-good"
                      : r.status === "incorrect"
                        ? "pill-critical"
                        : "pill-warning"
                  }`}
                >
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
                {r.scoredAt && <div className="quiet acc-when">{formatAgo(r.scoredAt)}</div>}
              </div>
            </div>
          ))}
          {scored.length === 0 && (
            <p className="quiet acc-empty">
              Nothing has come due yet. Each prediction is checked when its timeframe elapses.
            </p>
          )}
        </div>

        <div className="acc-foot">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          Deadlines are checked hourly. A prediction is never scored against a measurement
          taken before it was made.
        </div>
      </div>
    </section>
  );
}
