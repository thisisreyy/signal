import type { DomainPosition, RankChange } from "./types";

/**
 * The brain: compare one keyword's current positions against the last
 * successful run and produce the notable changes.
 *
 * Rules:
 * - No baseline for the keyword (first run, or the keyword is new): no
 *   changes — a flood of "entered" on day one is noise, not signal.
 * - Per-domain: entered / dropped out of the top N; a move only counts when
 *   |delta| >= MOVE_THRESHOLD, so ±1 position jitter stays quiet.
 * - Business vs each competitor: report when the relative order flips
 *   ("overtaken"/"overtook"), ignoring competitors that never ranked.
 */

export const MOVE_THRESHOLD = 2;

const UNRANKED = Number.POSITIVE_INFINITY;

export function detectChanges(
  baseline: DomainPosition[] | undefined,
  current: DomainPosition[],
): RankChange[] {
  if (!baseline) return [];

  const prevOf = new Map(baseline.map((p) => [p.domain, p.position]));
  const changes: RankChange[] = [];

  // Per-domain movement.
  for (const { domain, position } of current) {
    if (!prevOf.has(domain)) continue; // domain newly tracked: no baseline
    const prev = prevOf.get(domain);
    if (prev === undefined && position === undefined) continue;
    if (prev === undefined && position !== undefined) {
      changes.push({ kind: "entered", domain, position });
    } else if (prev !== undefined && position === undefined) {
      changes.push({ kind: "dropped_out", domain, prevPosition: prev });
    } else if (Math.abs(prev! - position!) >= MOVE_THRESHOLD) {
      changes.push({ kind: "moved", domain, prevPosition: prev, position });
    }
  }

  // Business vs competitors: relative-order flips.
  const business = current.find((p) => p.isBusiness);
  if (business && prevOf.has(business.domain)) {
    const bPrev = prevOf.get(business.domain) ?? UNRANKED;
    const bCur = business.position ?? UNRANKED;
    for (const comp of current.filter((p) => !p.isBusiness)) {
      if (!prevOf.has(comp.domain)) continue;
      const cPrev = prevOf.get(comp.domain) ?? UNRANKED;
      const cCur = comp.position ?? UNRANKED;
      if (cPrev === UNRANKED && cCur === UNRANKED) continue; // never a rival

      const wasAhead = bPrev < cPrev;
      const isAhead = bCur < cCur;
      if (wasAhead && !isAhead && cCur !== UNRANKED) {
        changes.push({
          kind: "overtaken",
          domain: business.domain,
          competitor: comp.domain,
          prevPosition: finiteOrUndefined(bPrev),
          position: finiteOrUndefined(bCur),
        });
      } else if (!wasAhead && isAhead && bCur !== UNRANKED) {
        changes.push({
          kind: "overtook",
          domain: business.domain,
          competitor: comp.domain,
          prevPosition: finiteOrUndefined(bPrev),
          position: finiteOrUndefined(bCur),
        });
      }
    }
  }

  return changes;
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}
