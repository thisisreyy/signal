export { executeRun, InjectedFailureError, type RunOutcome } from "./runner";
export type { RunStore } from "./store";
export { ConvexRunStore } from "./convexStore";
export { detectChanges, MOVE_THRESHOLD } from "./growth/detect";
export { extractPositions, domainMatches } from "./growth/extract";
export type {
  DomainPosition,
  GrowthConfig,
  KeywordCheckResult,
  RankChange,
  RankChangeKind,
} from "./growth/types";
export { SerperSource, parseSerperOrganic } from "./ranking/serper";
export { SimulatedSource } from "./ranking/simulated";
export { domainOf, type RankingSource, type SerpResult } from "./ranking/source";
