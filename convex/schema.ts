import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const runStatus = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);

export const trigger = v.union(v.literal("cron"), v.literal("manual"));

/** One tracked domain's position in a keyword's search results. */
export const domainPosition = v.object({
  domain: v.string(),
  isBusiness: v.boolean(),
  position: v.optional(v.number()), // absent = not in the top N results
  url: v.optional(v.string()),
});

/** A notable ranking change, computed at write time vs the last successful run. */
export const rankChange = v.object({
  kind: v.union(
    v.literal("moved"), // material position change (up or down)
    v.literal("entered"), // entered the top N
    v.literal("dropped_out"), // left the top N
    v.literal("overtaken"), // a competitor moved above the business
    v.literal("overtook"), // the business moved above a competitor
  ),
  domain: v.string(), // whose position the change is about
  competitor: v.optional(v.string()), // the other party for overtaken/overtook
  prevPosition: v.optional(v.number()), // absent = was not ranked
  position: v.optional(v.number()), // absent = not ranked now
});

export default defineSchema({
  // One document per agent run. runKey is the idempotency key: a duplicate
  // trigger resolves to the same key and is dropped by the start mutation.
  runs: defineTable({
    runKey: v.string(),
    trigger,
    // Which data source produced this run ("serper" | "simulated").
    source: v.optional(v.string()),
    status: runStatus,
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    // An "item" is one unit of the run's work — one keyword for the growth
    // task (one URL in the original checker).
    itemsTotal: v.number(),
    itemsCompleted: v.number(),
    changesCount: v.number(),
  })
    .index("by_runKey", ["runKey"])
    .index("by_startedAt", ["startedAt"]),

  // Singleton checkpoint. lastSuccessfulRunId only advances on success, so a
  // failed run can never corrupt the diff baseline.
  agentState: defineTable({
    key: v.literal("singleton"),
    paused: v.boolean(),
    lastSuccessfulRunId: v.optional(v.id("runs")),
    lastSuccessfulAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // One row per (run × keyword), written the moment that keyword's SERP fetch
  // completes — the same per-item durable-write pattern `checks` used, so a
  // crash mid-run keeps every finished keyword.
  keywordChecks: defineTable({
    runId: v.id("runs"),
    keyword: v.string(),
    checkedAt: v.number(),
    error: v.optional(v.string()),
    positions: v.array(domainPosition),
    changes: v.array(rankChange),
  })
    .index("by_run_keyword", ["runId", "keyword"])
    .index("by_keyword", ["keyword"]),

  // Singleton config, editable from the dashboard; the Worker reads it here so
  // there is one source of truth.
  config: defineTable({
    key: v.literal("singleton"),
    // Growth agent config.
    business: v.optional(v.object({ name: v.string(), domain: v.string() })),
    keywords: v.optional(v.array(v.string())),
    competitors: v.optional(v.array(v.string())),
    // When true, the agent throws mid-run to prove recovery works.
    injectFailure: v.optional(v.boolean()),
  }).index("by_key", ["key"]),
});
