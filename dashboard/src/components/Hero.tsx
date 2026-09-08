import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { api } from "../../../convex/_generated/api";
import { formatAgo } from "../format";
import { useCalm } from "./motion";

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
  const calm = useCalm();

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

  const sub = (
    <>
      {businessName} vs competitors on {keywordCount} keywords
      {" · "}
      {lastSuccessfulAt ? <>last checked {formatAgo(lastSuccessfulAt)}</> : "not checked yet"}
      {" · "}
      {paused ? "automatic checks are off" : "checks run daily"}
    </>
  );

  if (calm) {
    return (
      <section className={`hero hero-${mood}`}>
        <span className={`hero-dot hero-dot-${mood}`} aria-hidden="true" />
        <h2 className="hero-headline">{headline}</h2>
        <p className="hero-sub">{sub}</p>
      </section>
    );
  }

  // One-time load choreography: dot springs in, headline resolves from a
  // slight blur, the sub fades last. Stationary from then on.
  return (
    <section className={`hero hero-${mood}`}>
      <motion.span
        className={`hero-dot hero-dot-${mood}`}
        aria-hidden="true"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 17, delay: 0.05 }}
      />
      <motion.h2
        key={headline}
        className="hero-headline"
        initial={{ opacity: 0, y: 14, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.65, delay: 0.12, ease: [0.22, 0.61, 0.36, 1] }}
      >
        {headline}
      </motion.h2>
      <motion.p
        className="hero-sub"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.45 }}
      >
        {sub}
      </motion.p>
    </section>
  );
}
