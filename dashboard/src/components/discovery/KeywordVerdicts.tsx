import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { CountUp, GradualBlur } from "../bits";
import { ApplyBar } from "./DiscoveryView";

type RunData = {
  run: Doc<"discoveryRuns">;
  candidates: Doc<"keywordCandidates">[];
  competitors: Doc<"competitors">[];
};

type Filter = "all" | "relevant" | "ambiguous" | "irrelevant";

const VERDICT_LABEL: Record<string, string> = {
  relevant: "kept",
  ambiguous: "needs you",
  irrelevant: "rejected",
  unvalidated: "queued",
  error: "check failed",
};

const VERDICT_CLASS: Record<string, string> = {
  relevant: "pill-good",
  ambiguous: "pill-warning",
  irrelevant: "pill-critical",
  unvalidated: "pill-new",
  error: "pill-critical",
};

/** Each verdict shown beside the page-one results that decided it. */
export function KeywordVerdicts({ data }: { data: RunData }) {
  const setStatus = useMutation(api.discovery.index.setCandidateStatus);
  const addCandidate = useMutation(api.discovery.index.addCandidate);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");

  const counts = {
    all: data.candidates.length,
    relevant: data.candidates.filter((c) => c.status === "relevant").length,
    ambiguous: data.candidates.filter((c) => c.status === "ambiguous").length,
    irrelevant: data.candidates.filter((c) => c.status === "irrelevant").length,
  };
  const visible =
    filter === "all" ? data.candidates : data.candidates.filter((c) => c.status === filter);

  return (
    <section>
      <div className="sec-head">
        <div>
          <span className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            Tested against Google
          </span>
          <h2 className="sec-title">
            <CountUp to={counts.all} /> proposed, <CountUp to={counts.relevant} /> held up
          </h2>
          <p className="sec-sub">
            Every verdict was decided by who actually ranks on page one — not by how the
            phrase reads.
          </p>
        </div>
        <div className="filters">
          {(["all", "relevant", "ambiguous", "irrelevant"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`filter ${filter === f ? "active" : ""} filter-${f}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : VERDICT_LABEL[f]} {counts[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="verdicts">
        {visible.map((c) => (
          <article
            className={`verdict ${c.status === "ambiguous" ? "verdict-review" : ""}`}
            key={c._id}
          >
            <div>
              <div className="verdict-head">
                <span className={`pill ${VERDICT_CLASS[c.status] ?? "pill-new"}`}>
                  {VERDICT_LABEL[c.status] ?? c.status}
                </span>
                <h3 className="verdict-kw">“{c.keyword}”</h3>
                {c.validation?.confidence !== undefined && (
                  <span className="verdict-conf">
                    confidence {c.validation.confidence.toFixed(2)}
                  </span>
                )}
              </div>
              <p className="verdict-why">
                {c.validation?.reasoning ?? "Not yet checked — it joins the next batch."}
              </p>
              {c.status === "ambiguous" && (
                <div className="verdict-actions">
                  <button
                    className="btn btn-accept"
                    onClick={() => setStatus({ candidateId: c._id, status: "relevant" })}
                  >
                    Track it
                  </button>
                  <button
                    className="btn"
                    onClick={() => setStatus({ candidateId: c._id, status: "irrelevant" })}
                  >
                    Discard
                  </button>
                </div>
              )}
            </div>

            <div className="evidence">
              <div className="evidence-label">Evidence · page one</div>
              {(c.validation?.topDomains ?? []).slice(0, 4).map((d) => (
                <div className="evidence-row" key={`${d.domain}-${d.position}`}>
                  <span>{d.domain}</span>
                  <span className="evidence-pos">#{d.position}</span>
                </div>
              ))}
              {(c.validation?.topDomains?.length ?? 0) > 4 && (
                <div className="evidence-row quiet">
                  <span>+ {(c.validation?.topDomains.length ?? 0) - 4} more</span>
                </div>
              )}
              {(c.validation?.topDomains?.length ?? 0) === 0 && (
                <div className="quiet">No results recorded yet.</div>
              )}
            </div>
          </article>
        ))}
        <GradualBlur />
      </div>

      <form
        className="add-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          await addCandidate({ discoveryId: data.run._id, keyword: draft });
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a keyword of your own — it gets tested the same way"
          aria-label="Add a keyword"
        />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          Test it
        </button>
      </form>

      <ApplyBar
        discoveryId={data.run._id}
        keywords={counts.relevant}
        competitors={data.competitors.filter((c) => c.selected).length}
      />
    </section>
  );
}
