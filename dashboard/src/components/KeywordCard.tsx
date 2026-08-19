import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatAgo, formatTime } from "../format";
import { faviconOf } from "../lib";
import { Sparkline } from "./Sparkline";

/** One target keyword: your position, the trend, and the ranked field. */
export function KeywordCard({ keyword }: { keyword: string }) {
  const history = useQuery(api.keywordChecks.history, { keyword, limit: 30 });
  if (history === undefined) {
    return <article className="site quiet">Loading “{keyword}”…</article>;
  }

  const clean = history.filter((row) => row.error === undefined);
  const latest = clean[clean.length - 1];
  const businessNow = latest?.positions.find((p) => p.isBusiness);
  const prev = clean[clean.length - 2]?.positions.find((p) => p.isBusiness);

  const trend = clean
    .map((row) => ({
      at: row.checkedAt,
      position: row.positions.find((p) => p.isBusiness)?.position,
    }))
    .filter((p): p is { at: number; position: number } => p.position !== undefined)
    .slice(-12);

  const delta =
    businessNow?.position !== undefined && prev?.position !== undefined
      ? prev.position - businessNow.position // positive = climbed
      : null;

  const ranked = latest
    ? [...latest.positions].sort(
        (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity),
      )
    : [];

  return (
    <article className="site">
      <header className="site-top">
        <div className="site-names">
          <h3>“{keyword}”</h3>
          {latest && <span className="site-url">checked {formatAgo(latest.checkedAt)}</span>}
        </div>
      </header>

      <div className="site-status">
        <span className="rank-big">
          {businessNow?.position !== undefined ? (
            <>#{businessNow.position}</>
          ) : (
            <span className="rank-unranked">not in top 20</span>
          )}
        </span>
        {delta !== null && delta !== 0 && (
          <span className={`badge ${delta > 0 ? "badge-up" : "badge-down"}`}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
          </span>
        )}
      </div>

      {trend.length >= 2 && (
        <Sparkline
          points={trend.map((p) => ({ label: formatTime(p.at), value: p.position }))}
          formatValue={(v) => `#${v}`}
          width={200}
          height={40}
          invert
        />
      )}

      {ranked.length > 0 && (
        <ul className="ranklist">
          {ranked.map((entry) => (
            <li
              key={entry.domain}
              className={entry.isBusiness ? "ranklist-you" : ""}
            >
              <img src={faviconOf(`https://${entry.domain}`)} alt="" className="ranklist-icon"
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
              <span className="ranklist-domain">
                {entry.isBusiness ? `${entry.domain} (you)` : entry.domain}
              </span>
              <span className="ranklist-pos">
                {entry.position !== undefined ? `#${entry.position}` : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!latest && <span className="quiet">No data yet — run a check.</span>}
    </article>
  );
}
