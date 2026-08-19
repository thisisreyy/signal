import type { SerpResult } from "../ranking/source";
import type { DomainPosition } from "./types";

/**
 * Find every tracked domain's best position in one keyword's results.
 * Subdomains count (docs.example.com matches example.com); every tracked
 * domain gets an entry so "not ranked" is recorded explicitly.
 */
export function extractPositions(
  serp: SerpResult[],
  businessDomain: string,
  competitors: string[],
): DomainPosition[] {
  const tracked = [
    { domain: normalize(businessDomain), isBusiness: true },
    ...competitors.map((domain) => ({ domain: normalize(domain), isBusiness: false })),
  ];
  return tracked.map(({ domain, isBusiness }) => {
    const best = serp.find((result) => domainMatches(result.domain, domain));
    return {
      domain,
      isBusiness,
      position: best?.position,
      url: best?.url,
    };
  });
}

export function domainMatches(resultDomain: string, target: string): boolean {
  const result = normalize(resultDomain);
  return result === target || result.endsWith(`.${target}`);
}

function normalize(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "").replace(/\/.*$/, "");
}
