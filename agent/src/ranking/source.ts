/**
 * The swappable data-source boundary. Everything above this interface is
 * provider-agnostic: if a source dies (quota, API change), replace it here
 * and nothing else in the system moves.
 */

/** One organic search result, 1-indexed by position. */
export interface SerpResult {
  position: number;
  url: string;
  domain: string;
  title?: string;
}

export interface RankingSource {
  /** Identifies the provider in run records ("serper", "simulated"). */
  readonly name: string;
  /**
   * Top organic results for a keyword, best first. `trackedDomains` is a
   * hint real providers ignore; the simulated source uses it so the domains
   * under observation actually appear in its fabricated results.
   */
  search(keyword: string, trackedDomains: string[]): Promise<SerpResult[]>;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}
