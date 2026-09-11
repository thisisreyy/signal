import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { DiscoverStart } from "./DiscoverStart";
import { PipelineProgress } from "./PipelineProgress";
import { KeywordVerdicts } from "./KeywordVerdicts";
import { CompetitorSet } from "./CompetitorSet";
import { RecommendationList } from "./RecommendationList";
import { AccuracyPanel } from "./AccuracyPanel";

export type DiscoveryTab = "keywords" | "competitors" | "recommendations" | "accuracy";

const TABS: { id: DiscoveryTab; label: string }[] = [
  { id: "keywords", label: "Keywords" },
  { id: "competitors", label: "Competitors" },
  { id: "recommendations", label: "Recommendations" },
  { id: "accuracy", label: "Accuracy" },
];

/** Everything the discovery pipeline produces, and the controls to steer it. */
export function DiscoveryView() {
  const runs = useQuery(api.discovery.index.listRuns, {});
  const [openId, setOpenId] = useState<Id<"discoveryRuns"> | null>(null);
  const [tab, setTab] = useState<DiscoveryTab>("keywords");

  const active = openId ?? runs?.[0]?._id ?? null;
  const data = useQuery(
    api.discovery.index.getRun,
    active ? { discoveryId: active } : "skip",
  );

  if (runs === undefined) {
    return (
      <div className="loading">
        <span className="loading-dot" aria-hidden="true" />
        <span>Loading discoveries…</span>
      </div>
    );
  }

  if (runs.length === 0 || openId === "new") {
    return <DiscoverStart runs={runs} onOpen={setOpenId} />;
  }

  if (!data) {
    return (
      <div className="loading">
        <span className="loading-dot" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }

  const running = data.run.state !== "COMPLETE" && data.run.state !== "FAILED";

  return (
    <div className="disco">
      <DiscoveryHeader
        url={data.run.url}
        runs={runs}
        activeId={active}
        onOpen={setOpenId}
      />

      {running || data.run.state === "FAILED" ? (
        <PipelineProgress data={data} />
      ) : (
        <>
          <nav className="disco-tabs" aria-label="Discovery sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`disco-tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {tab === "keywords" && <KeywordVerdicts data={data} />}
          {tab === "competitors" && <CompetitorSet data={data} />}
          {tab === "recommendations" && <RecommendationList data={data} />}
          {tab === "accuracy" && <AccuracyPanel discoveryId={data.run._id} />}
        </>
      )}
    </div>
  );
}

function DiscoveryHeader({
  url,
  runs,
  activeId,
  onOpen,
}: {
  url: string;
  runs: { _id: Id<"discoveryRuns">; url: string; state: string }[];
  activeId: Id<"discoveryRuns"> | null;
  onOpen: (id: Id<"discoveryRuns">) => void;
}) {
  return (
    <div className="disco-head">
      <div>
        <span className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          Auto-discovery
        </span>
        <h2>{url.replace(/^https?:\/\//, "")}</h2>
      </div>
      <div className="disco-head-actions">
        {runs.length > 1 && (
          <select
            className="disco-select"
            value={activeId ?? ""}
            onChange={(e) => onOpen(e.target.value as Id<"discoveryRuns">)}
            aria-label="Choose a discovery"
          >
            {runs.map((r) => (
              <option key={r._id} value={r._id}>
                {r.url.replace(/^https?:\/\//, "")} · {r.state.toLowerCase()}
              </option>
            ))}
          </select>
        )}
        <button className="btn" onClick={() => onOpen("new" as Id<"discoveryRuns">)}>
          New discovery
        </button>
      </div>
    </div>
  );
}

/** Shared by the tabs: apply everything approved to the live tracker. */
export function ApplyBar({
  discoveryId,
  keywords,
  competitors,
}: {
  discoveryId: Id<"discoveryRuns">;
  keywords: number;
  competitors: number;
}) {
  const apply = useMutation(api.discovery.index.applyToTracking);
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("saving");
    try {
      const result = await apply({ discoveryId });
      setMessage(
        `Now tracking ${result.keywords} keywords against ${result.competitors} competitors.`,
      );
      setState("done");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    }
  }

  return (
    <div className="apply-bar">
      <div>
        <div className="apply-title">
          Track {keywords} keywords against {competitors} competitors
        </div>
        <div className="quiet">
          {state === "done" || state === "error"
            ? message
            : "Adds them to the daily check. Nothing moves until you press this."}
        </div>
      </div>
      <button className="btn btn-primary" onClick={run} disabled={state === "saving"}>
        {state === "saving" ? "Applying…" : state === "done" ? "Applied" : "Track these"}
      </button>
    </div>
  );
}
