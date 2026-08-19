import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatAgo } from "../format";

interface Signal {
  at: number;
  keyword: string;
  change: {
    kind: "moved" | "entered" | "dropped_out" | "overtaken" | "overtook";
    domain: string;
    competitor?: string;
    prevPosition?: number;
    position?: number;
  };
}

/** Detected ranking changes as plain-English, business-centric sentences. */
export function SignalsFeed({ businessDomain }: { businessDomain: string }) {
  const signals = useQuery(api.keywordChecks.signals, { limit: 25 });

  return (
    <section className="panel-card">
      <h2>Signals</h2>
      {signals === undefined && <p className="quiet">Loading…</p>}
      {signals && signals.length === 0 && (
        <p className="quiet">
          No ranking changes detected yet. Signals appear here when positions
          move between checks.
        </p>
      )}
      <ul className="signals">
        {(signals ?? []).map((signal, index) => {
          const { icon, tone, text } = phrase(signal as Signal, businessDomain);
          return (
            <li key={index} className="signal-row">
              <span className={`feed-icon feed-icon-${tone}`}>{icon}</span>
              <span className="signal-text">{text}</span>
              <span className="signal-when">{formatAgo(signal.at)}</span>
            </li>
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
