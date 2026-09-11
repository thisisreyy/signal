import type { Doc } from "../../../../convex/_generated/dataModel";
import { CountUp, SpotlightCard } from "../bits";

type RunData = {
  run: Doc<"discoveryRuns">;
  steps: Doc<"discoverySteps">[];
  recommendations: Doc<"recommendations">[];
};

const STATUS_CLASS: Record<string, string> = {
  open: "pill-new",
  correct: "pill-good",
  incorrect: "pill-critical",
  inconclusive: "pill-warning",
};

/** Recommendations, each carrying the stored measurement that backs it. */
export function RecommendationList({ data }: { data: RunData }) {
  const step = data.steps.find((s) => s.kind === "RECOMMEND");
  const rejected = (step?.result as { rejectedUngrounded?: number } | undefined)
    ?.rejectedUngrounded;

  return (
    <section>
      <span className="eyebrow">
        <span className="eyebrow-dot" aria-hidden="true" />
        Every claim is checked
      </span>
      <h2 className="sec-title">
        <CountUp to={data.recommendations.length} /> recommendations
        {rejected ? (
          <>
            . <CountUp to={rejected} /> were thrown away.
          </>
        ) : (
          "."
        )}
      </h2>
      <p className="sec-sub">
        Each one&apos;s citations were re-checked against the stored search results. Anything
        citing a position nobody actually observed was discarded rather than shown to you.
      </p>

      <div className="rec-note">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 12l2 2 4-4" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        <span>
          Each prediction is scored automatically when its deadline passes. You will see
          whether it was right — including when it is wrong.
        </span>
      </div>

      <div className="recs">
        {data.recommendations.map((r) => (
          <SpotlightCard className="rec" key={r._id}>
            <div className="rec-head">
              <h3 className="rec-action">{r.action}</h3>
              <div className="rec-conf">
                <div className="evidence-label">Confidence</div>
                <div className="rec-conf-row">
                  <span className="rec-conf-bar">
                    <span style={{ width: `${r.confidence * 100}%` }} />
                  </span>
                  <span className="rec-conf-n">{r.confidence.toFixed(2)}</span>
                </div>
              </div>
            </div>
            <p className="rec-why">{r.rationale}</p>

            {r.evidence.map((e, i) => (
              <div className="rec-evidence" key={i}>
                <span className="evidence-label">Evidence</span>
                <span className="rec-evidence-body">
                  <span>“{e.keyword}”</span>
                  <span className="quiet">·</span>
                  {e.competitor ? (
                    <span>
                      {e.competitor} <span className="pos-good">#{e.theirRank}</span>
                    </span>
                  ) : (
                    <span className="quiet">no competitor cited</span>
                  )}
                  <span className="quiet">·</span>
                  <span className="quiet">
                    you: {e.ourRank !== undefined ? `#${e.ourRank}` : "not ranked"}
                  </span>
                </span>
              </div>
            ))}

            <div className="rec-predict">
              <div className="rec-predict-main">
                <span className="evidence-label">Predicts</span>
                <span className="quiet">
                  {r.expectedOutcome.currentRank !== undefined
                    ? `#${r.expectedOutcome.currentRank}`
                    : "not ranked"}
                </span>
                <svg width="20" height="12" viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M1 6h17M13 1l5 5-5 5" />
                </svg>
                <span className="rec-target">#{r.expectedOutcome.predictedRank}</span>
                <span className="quiet">
                  within {r.expectedOutcome.timeframeDays} days · due{" "}
                  {new Date(r.dueAt).toLocaleDateString([], { day: "numeric", month: "short" })}
                </span>
              </div>
              <span className={`pill ${STATUS_CLASS[r.status] ?? "pill-new"}`}>{r.status}</span>
            </div>

            {r.scoringNote && <div className="rec-scored">{r.scoringNote}</div>}
            {r.fallback && (
              <div className="rec-fallback">
                <span>If it stalls:</span> {r.fallback}
              </div>
            )}
          </SpotlightCard>
        ))}
        {data.recommendations.length === 0 && (
          <p className="quiet">No recommendation survived the evidence check.</p>
        )}
      </div>
    </section>
  );
}
