import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatAgo } from "../format";

/** One plain-English sentence about where the business stands. */
export function Hero({
  businessName,
  keywordCount,
  paused,
  lastSuccessfulAt,
}: {
  businessName: string;
  keywordCount: number;
  paused: boolean;
  lastSuccessfulAt: number | null;
}) {
  const baseline = useQuery(api.runs.baseline, {});

  let mood: "good" | "bad" | "idle" = "idle";
  let headline = "Waiting for the first ranking check";

  if (baseline && baseline.length > 0) {
    const yours = baseline.map(
      (row) => row.positions.find((p) => p.isBusiness)?.position,
    );
    const ranked = yours.filter((p) => p !== undefined).length;
    const top3 = yours.filter((p) => p !== undefined && p <= 3).length;
    if (ranked === 0) {
      mood = "bad";
      headline = `${businessName} isn't in the top 20 for any tracked keyword`;
    } else if (top3 > 0) {
      mood = "good";
      headline = `Top 3 for ${top3} of ${baseline.length} keywords`;
    } else {
      mood = "good";
      headline = `Ranking for ${ranked} of ${baseline.length} keywords`;
    }
  }

  return (
    <section className={`hero hero-${mood}`}>
      <span className={`hero-dot hero-dot-${mood}`} aria-hidden="true" />
      <h2 className="hero-headline">{headline}</h2>
      <p className="hero-sub">
        {businessName} vs {`competitors on ${keywordCount} keywords`}
        {" · "}
        {lastSuccessfulAt ? <>last checked {formatAgo(lastSuccessfulAt)}</> : "not checked yet"}
        {" · "}
        {paused ? "automatic checks are off" : "checks run daily"}
      </p>
    </section>
  );
}
