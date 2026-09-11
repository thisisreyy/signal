import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { CountUp, SpotlightCard } from "../bits";

type RunData = { run: Doc<"discoveryRuns">; competitors: Doc<"competitors">[] };

const ADJACENT_PREVIEW = 6;

/** Competitors found from real results, with the evidence that identified them. */
export function CompetitorSet({ data }: { data: RunData }) {
  const setSelected = useMutation(api.discovery.index.setCompetitorSelected);
  const [showAllAdjacent, setShowAllAdjacent] = useState(false);
  const rivals = data.competitors.filter((c) => c.classification === "competitor");
  const adjacent = data.competitors.filter((c) => c.classification === "adjacent");
  const shownAdjacent = showAllAdjacent ? adjacent : adjacent.slice(0, ADJACENT_PREVIEW);
  // Every remaining domain was ruled out, either by the static list or by the model.
  // Splitting them keeps the two mechanisms honest instead of implying one did all the work.
  const ruledOut = data.competitors.filter(
    (c) => c.classification !== "competitor" && c.classification !== "adjacent",
  );
  const byList = ruledOut.filter((c) => c.decidedBy === "list");
  const byModel = ruledOut.filter((c) => c.decidedBy !== "list");

  return (
    <section>
      <span className="eyebrow">
        <span className="eyebrow-dot" aria-hidden="true" />
        Found, not guessed
      </span>
      <h2 className="sec-title">
        <CountUp to={data.competitors.length} /> domains rank for your keywords.{" "}
        <CountUp to={rivals.length} /> compete with you.
      </h2>
      <p className="sec-sub">
        Nobody typed these in. They are whoever showed up on page one for the searches that
        survived testing — then filtered, because ranking for the same phrase is not the
        same as selling the same thing.
      </p>

      <div className="rivals">
        {rivals.map((c) => (
          <SpotlightCard className="rival" key={c._id}>
            <div className="rival-head">
              <div>
                <h3 className="rival-domain">{c.domain}</h3>
                <div className="quiet">
                  ranks for {c.appearances} of your keywords · best #{c.bestPosition} · average #
                  {c.averagePosition}
                </div>
              </div>
              <div className="rival-score">
                <span className="rival-score-n">{c.score.toFixed(2)}</span>
                <span className="quiet">pressure</span>
              </div>
            </div>
            <p className="rival-why">{c.reasoning}</p>
            <div className="rival-evidence">
              <div className="evidence-label">Where it beats you</div>
              {c.evidence.slice(0, 3).map((e) => (
                <div className="evidence-row" key={e.keyword}>
                  <span>“{e.keyword}”</span>
                  <span className="evidence-pos">
                    <span className="pos-good">#{e.position}</span>
                    <span className="quiet"> vs you —</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="rival-actions">
              <button
                className={`btn ${c.selected ? "btn-accept" : ""}`}
                onClick={() => setSelected({ competitorId: c._id, selected: !c.selected })}
              >
                {c.selected ? "Tracking" : "Track"}
              </button>
            </div>
          </SpotlightCard>
        ))}
        {rivals.length === 0 && (
          <p className="quiet">No domain in the results sells anything comparable.</p>
        )}
      </div>

      {adjacent.length > 0 && (
        <>
          <h3 className="sub-title">
            Ranked, but not your competition <span className="sub-count">{adjacent.length}</span>
          </h3>
          <p className="sec-sub">
            Real companies in nearby markets. Counting appearances alone would have made the
            highest-scoring one your top rival.
          </p>
          <div className="adjacent">
            {shownAdjacent.map((c) => (
              <div className="adjacent-row" key={c._id}>
                <span className="adjacent-domain">{c.domain}</span>
                <span className="adjacent-score">{c.score.toFixed(2)}</span>
                <span className="adjacent-why">{c.reasoning}</span>
              </div>
            ))}
          </div>
          {adjacent.length > ADJACENT_PREVIEW && (
            <button className="more-btn" onClick={() => setShowAllAdjacent((v) => !v)}>
              {showAllAdjacent
                ? "Show fewer"
                : `Show ${adjacent.length - ADJACENT_PREVIEW} more`}
            </button>
          )}
        </>
      )}

      {byList.length > 0 && (
        <>
          <h3 className="sub-title">
            Filtered out before anything was asked{" "}
            <span className="sub-count">{byList.length}</span>
          </h3>
          <p className="sec-sub">
            Known directories, forums and platforms. Excluding these costs nothing and is more
            reliable than asking a model whether Reddit sells software.
          </p>
          <div className="excluded">
            {byList.map((c) => (
              <span className="excluded-chip" key={c._id}>
                {c.domain} <span className="excluded-kind">{c.classification}</span>
              </span>
            ))}
          </div>
        </>
      )}

      {byModel.length > 0 && (
        <>
          <h3 className="sub-title">
            Ruled out by the model <span className="sub-count">{byModel.length}</span>
          </h3>
          <p className="sec-sub">
            Not on any list — these rank for your keywords but read as coverage rather than
            competition, so the model set them aside and said why.
          </p>
          <div className="adjacent">
            {byModel.map((c) => (
              <div className="adjacent-row" key={c._id}>
                <span className="adjacent-domain">{c.domain}</span>
                <span className="adjacent-score">{c.classification}</span>
                <span className="adjacent-why">{c.reasoning}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
