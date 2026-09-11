import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { SCORING_INTERVAL_HOURS } from "./discovery/logic";

const crons = cronJobs();

// Heals the discovery pipeline: re-schedules due retries and re-pends steps
// stuck "running" past the staleness threshold (a crashed action).
crons.interval("discovery step sweep", { minutes: 1 }, internal.discovery.index.sweep, {});

// The outcome loop: every prediction whose timeframe has elapsed is compared
// against real measured rankings. Predictions are day-scale, so hourly is
// ample and keeps the work per tick tiny.
crons.interval(
  "score due recommendations",
  { hours: SCORING_INTERVAL_HOURS },
  internal.discovery.index.scoreDueRecommendations,
  {},
);

export default crons;
