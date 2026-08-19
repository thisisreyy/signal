import { formatAgo } from "../format";

export interface SiteSummary {
  url: string;
  latest: { ok: boolean; checkedAt: number } | null;
}

/** One plain-English sentence about the whole system, nothing to decode. */
export function Hero({
  sites,
  paused,
  lastSuccessfulAt,
}: {
  sites: SiteSummary[];
  paused: boolean;
  lastSuccessfulAt: number | null;
}) {
  const checked = sites.filter((s) => s.latest !== null);
  const down = checked.filter((s) => !s.latest!.ok);

  let mood: "good" | "bad" | "idle" = "good";
  let headline = "All systems up";
  if (checked.length === 0) {
    mood = "idle";
    headline = "Add a website to start watching";
  } else if (down.length > 0) {
    mood = "bad";
    headline =
      down.length === 1
        ? `1 of ${checked.length} sites is down`
        : `${down.length} of ${checked.length} sites are down`;
  }

  return (
    <section className={`hero hero-${mood}`}>
      <span className={`hero-dot hero-dot-${mood}`} aria-hidden="true" />
      <h2 className="hero-headline">{headline}</h2>
      <p className="hero-sub">
        {lastSuccessfulAt ? <>Last checked {formatAgo(lastSuccessfulAt)}</> : "Not checked yet"}
        {" · "}
        {paused ? "automatic checks are off" : "checks run every 5 minutes"}
      </p>
    </section>
  );
}
