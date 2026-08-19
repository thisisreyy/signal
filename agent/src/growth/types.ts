/** One tracked domain's position for a keyword. Mirrors the Convex schema. */
export interface DomainPosition {
  domain: string;
  isBusiness: boolean;
  position?: number; // absent = not in the top N
  url?: string;
}

export type RankChangeKind =
  | "moved"
  | "entered"
  | "dropped_out"
  | "overtaken"
  | "overtook";

export interface RankChange {
  kind: RankChangeKind;
  domain: string;
  competitor?: string;
  prevPosition?: number;
  position?: number;
}

export interface GrowthConfig {
  business: { name: string; domain: string };
  keywords: string[];
  competitors: string[];
  injectFailure: boolean;
}

/** The durable record for one keyword in one run. */
export interface KeywordCheckResult {
  keyword: string;
  positions: DomainPosition[];
  changes: RankChange[];
  error?: string;
}
