import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";
import { CountUp, ShinyText } from "../bits";

type RunData = {
  run: Doc<"discoveryRuns">;
  steps: Doc<"discoverySteps">[];
  profile: Doc<"businessProfiles"> | null;
  candidates: Doc<"keywordCandidates">[];
};

const PHASES = [
  { state: "PROFILING", kinds: ["FETCH_PAGES", "PROFILE"], label: "Profiled the business" },
  { state: "GENERATING_KEYWORDS", kinds: ["GENERATE_KEYWORDS"], label: "Proposed keywords" },
  { state: "VALIDATING", kinds: ["VALIDATE_BATCH"], label: "Testing them against Google" },
  { state: "EXTRACTING_COMPETITORS", kinds: ["EXTRACT_COMPETITORS"], label: "Finding who actually ranks" },
  { state: "RECOMMENDING", kinds: ["RECOMMEND"], label: "Writing recommendations" },
] as const;

const ORDER = PHASES.map((p) => p.state);

/** The live pipeline: what is done, what it cost, and what is happening now. */
export function PipelineProgress({ data }: { data: RunData }) {
  const resume = useMutation(api.discovery.index.resume);
  const { run, steps, profile, candidates } = data;

  const failed = run.state === "FAILED";
  const currentState = failed ? (run.stateBeforeFailure ?? "PROFILING") : run.state;
  const currentIndex = ORDER.indexOf(currentState as (typeof ORDER)[number]);

  const validated = candidates.filter((c) => c.status !== "unvalidated").length;
  const kept = candidates.filter((c) => c.status === "relevant").length;
  const unclear = candidates.filter((c) => c.status === "ambiguous").length;
  const rejected = candidates.filter((c) => c.status === "irrelevant").length;

  function summary(phase: (typeof PHASES)[number]): string | null {
    switch (phase.state) {
      case "PROFILING":
        return profile
          ? `${profile.whatTheySell ?? "Profile extracted"}${profile.audience ? ` · ${profile.audience.toUpperCase()}` : ""}`
          : null;
      case "GENERATING_KEYWORDS":
        return candidates.length > 0 ? `${candidates.length} proposed — none tracked yet` : null;
      case "VALIDATING":
        return candidates.length > 0 ? `${validated} of ${candidates.length} checked` : null;
      case "EXTRACTING_COMPETITORS":
        return "Free — reuses the results already collected";
      case "RECOMMENDING":
        return "Anything it cannot back with the data above is discarded";
    }
  }

  return (
    <div className="pipe">
      <div className="pipe-main">
        <span className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          {failed ? "Stopped" : "In progress"}
        </span>
        <h2 className="pipe-title">
          {failed ? (
            "This run stopped"
          ) : currentState === "VALIDATING" && candidates.length > 0 ? (
            <ShinyText>
              Testing keyword {Math.min(validated + 1, candidates.length)} of {candidates.length}
            </ShinyText>
          ) : (
            <ShinyText>{PHASES[Math.max(0, currentIndex)]?.label ?? "Working"}</ShinyText>
          )}
        </h2>
        <p className="pipe-sub">
          {failed
            ? run.error
            : "Each one is a real Google search. You can leave — it keeps going, and heals itself if a step crashes."}
        </p>

        {failed && (
          <button className="btn btn-primary" onClick={() => resume({ discoveryId: run._id })}>
            Resume from where it stopped
          </button>
        )}

        <ol className="pipe-steps">
          {PHASES.map((phase, index) => {
            const done = index < currentIndex;
            const current = index === currentIndex && !failed;
            const stepRows = steps.filter((s) => phase.kinds.includes(s.kind as never));
            const cost = stepRows.length;
            return (
              <li className="pipe-step" key={phase.state}>
                <div className="pipe-rail">
                  <span className={`pipe-dot ${done ? "done" : current ? "current" : ""}`}>
                    {done ? "✓" : current ? "◌" : index + 1}
                  </span>
                  {index < PHASES.length - 1 && <span className="pipe-line" />}
                </div>
                <div className="pipe-body">
                  <div className="pipe-row">
                    <span className={`pipe-label ${current ? "current" : done ? "" : "pending"}`}>
                      {phase.label}
                    </span>
                    {cost > 0 && (
                      <span className="pipe-cost">
                        {cost} step{cost > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  {(done || current) && summary(phase) && (
                    <div className="pipe-summary">{summary(phase)}</div>
                  )}
                  {current && phase.state === "VALIDATING" && candidates.length > 0 && (
                    <>
                      <div className="pipe-bar">
                        <span style={{ width: `${(validated / candidates.length) * 100}%` }} />
                      </div>
                      <div className="pipe-pills">
                        <span className="pill pill-good">{kept} kept</span>
                        <span className="pill pill-warning">{unclear} unclear</span>
                        <span className="pill pill-critical">{rejected} rejected</span>
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <aside className="pipe-side">
        <span className="eyebrow">Budget</span>
        <Meter label="Searches" value={run.searchCalls} max={40} />
        <Meter label="Model calls" value={run.llmCalls} max={30} />
        <p className="quiet pipe-note">
          A run stops itself at these ceilings rather than spending past them. If a step
          crashes, the next sweep picks it up within a minute — already-paid searches are
          reused, not bought twice.
        </p>
        <div className="pipe-warn">
          <div className="pipe-warn-title">Nothing is tracked yet</div>
          <div className="quiet">
            Your daily rankings are untouched until you approve what this finds.
          </div>
        </div>
      </aside>
    </div>
  );
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="meter-row">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-val">
          <CountUp to={value} />
          <span className="quiet"> / {max}</span>
        </span>
      </div>
      <div className="pipe-bar">
        <span style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </div>
    </div>
  );
}
