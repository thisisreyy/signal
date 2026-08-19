import type { RankingSource, SerpResult } from "./source";

/**
 * Deterministic fabricated rankings for tests and key-less demo mode.
 * Positions are a pure function of (keyword, domain, time bucket): stable
 * within a bucket, drifting a little between buckets so change detection has
 * something real to detect. Clearly labeled "simulated" in run records.
 */
export class SimulatedSource implements RankingSource {
  readonly name = "simulated";

  constructor(
    private options: { bucketMs?: number; now?: () => number } = {},
  ) {}

  async search(keyword: string, trackedDomains: string[]): Promise<SerpResult[]> {
    const now = this.options.now ?? Date.now;
    const bucket = Math.floor(now() / (this.options.bucketMs ?? 10 * 60 * 1000));

    // Tracked domains that "rank" this bucket, at a fabricated position.
    const entries: { domain: string; slot: number }[] = [];
    for (const domain of trackedDomains) {
      const base = hash(`${keyword}|${domain}`);
      if (base % 10 >= 8) continue; // ~20% chance a domain just isn't ranked
      const drift = (hash(`${keyword}|${domain}|${bucket}`) % 7) - 3; // -3..+3
      const slot = clamp(1 + (base % 15) + drift, 1, 20);
      entries.push({ domain, slot });
    }

    // Interleave stable filler domains across the whole 1..24 slot range so
    // tracked domains get realistic absolute positions (and can be pushed out
    // of the top 20), then re-number sequentially like a real SERP.
    for (let i = 0; i < 24; i++) {
      entries.push({
        domain: `web-directory-${i + 1}.example`,
        slot: 1 + (hash(`${keyword}|filler-${i}`) % 24),
      });
    }
    entries.sort((a, b) => a.slot - b.slot);
    return entries.slice(0, 20).map((entry, index) => ({
      position: index + 1,
      domain: entry.domain,
      url: `https://${entry.domain}/`,
      title: `${entry.domain} — ${keyword}`,
    }));
  }
}

/** FNV-1a, good enough for stable fake data. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
