import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatAgo } from "../format";
import { faviconOf } from "../lib";
import { ProgressRow, useBandProgress } from "./Observatory";

interface Signal {
  at: number;
  keyword: string;
  business: string;
  change: {
    kind: "moved" | "entered" | "dropped_out" | "overtaken" | "overtook";
    domain: string;
    competitor?: string;
    prevPosition?: number;
    position?: number;
  };
}

/**
 * Detected ranking changes as plain-English sentences, grouped into one tab
 * per tracked business — switching what the agent tracks starts a new tab,
 * and past eras stay browsable.
 */
export function SignalsFeed({ businessDomain }: { businessDomain: string }) {
  const signals = useQuery(api.keywordChecks.signals, {}) as Signal[] | undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const progress = useBandProgress();

  // Tabs: current business first, then past eras by most recent signal.
  const eras: string[] = [];
  for (const signal of signals ?? []) {
    if (!eras.includes(signal.business)) eras.push(signal.business);
  }
  if (!eras.includes(businessDomain)) eras.unshift(businessDomain);
  else eras.sort((a, b) => (a === businessDomain ? -1 : b === businessDomain ? 1 : 0));

  const active = selected && eras.includes(selected) ? selected : businessDomain;
  const visible = (signals ?? []).filter((s) => s.business === active);

  return (
    <section className="obs-col signals-col">
      <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Observation</span>
      <h2>Signals</h2>
      <p className="sec-sub">Every meaningful ranking change the agent has caught, newest first.</p>

      {eras.length > 1 && (
        <div className="signal-tabs" role="tablist" aria-label="Tracked business">
          {eras.map((era) => (
            <button
              key={era}
              role="tab"
              aria-selected={era === active}
              className={`signal-tab ${era === active ? "active" : ""}`}
              onClick={() => setSelected(era)}
            >
              <img src={faviconOf(`https://${era}`)} alt="" className="signal-tab-icon"
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
              {era}
              {era === businessDomain && <span className="signal-tab-now">now</span>}
            </button>
          ))}
        </div>
      )}

      {signals === undefined && <p className="quiet">Loading…</p>}
      {signals && visible.length === 0 && (
        <p className="quiet">
          No ranking changes for {active} yet. Signals appear here when
          positions move between checks.
        </p>
      )}
      <ul className="signals">
        {visible.map((signal, index) => {
          const { icon, tone, text } = phrase(signal, active);
          const content = (
            <>
              <span className={`feed-icon feed-icon-${tone}`}>{icon}</span>
              <span className="signal-text">{text}</span>
              <span className="signal-when">{formatAgo(signal.at)}</span>
            </>
          );
          // The first rows reveal sequentially with the band's scroll
          // progress; everything past the sequence shares the final slot so
          // no later row is ever brighter than the ones still revealing.
          return progress ? (
            <ProgressRow key={`${active}-${index}`} progress={progress} index={Math.min(index, 7)}>
              {content}
            </ProgressRow>
          ) : (
            <li key={`${active}-${index}`} className="signal-row">{content}</li>
          );
        })}
      </ul>
    </section>
  );
}

function phrase(
  { keyword, change }: Signal,
  businessDomain: string,
): { icon: string; tone: "good" | "bad" | "warn"; text: string } {
  const isYou = change.domain === businessDomain;
  const who = isYou ? "You" : change.domain;
  const kw = `“${keyword}”`;

  switch (change.kind) {
    case "moved": {
      const up = (change.position ?? 99) < (change.prevPosition ?? 99);
      return {
        icon: up ? "▲" : "▼",
        // A competitor climbing is a warning for you; you climbing is good.
        tone: isYou ? (up ? "good" : "bad") : up ? "warn" : "good",
        text: `${who} ${up ? "climbed" : "dropped"} from #${change.prevPosition} to #${change.position} for ${kw}`,
      };
    }
    case "entered":
      return {
        icon: "＋",
        tone: isYou ? "good" : "warn",
        text: `${who} entered the top 20 at #${change.position} for ${kw}`,
      };
    case "dropped_out":
      return {
        icon: "−",
        tone: isYou ? "bad" : "good",
        text: `${who} fell out of the top 20 for ${kw} (was #${change.prevPosition})`,
      };
    case "overtaken":
      return {
        icon: "⚠",
        tone: "bad",
        text: `${change.competitor} overtook you for ${kw}${change.position !== undefined ? ` — you're now #${change.position}` : ""}`,
      };
    case "overtook":
      return {
        icon: "✓",
        tone: "good",
        text: `You overtook ${change.competitor} for ${kw}, now #${change.position}`,
      };
  }
}
