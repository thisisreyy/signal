import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Heals the discovery pipeline: re-schedules due retries and re-pends steps
// stuck "running" past the staleness threshold (a crashed action).
crons.interval("discovery step sweep", { minutes: 1 }, internal.discovery.index.sweep, {});

export default crons;
