import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const runStatus = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);

export const trigger = v.union(v.literal("cron"), v.literal("manual"));

// Present on a check only when its outcome differs from the last successful run.
export const change = v.object({
  kind: v.union(
    v.literal("new"), // URL not present in the baseline run
    v.literal("broke"), // ok -> not ok
    v.literal("recovered"), // not ok -> ok
    v.literal("statusChanged"), // ok both times, different status code
  ),
  prevOk: v.optional(v.boolean()),
  prevStatusCode: v.optional(v.number()),
});

export default defineSchema({
  // One document per agent run. runKey is the idempotency key: a duplicate
  // trigger resolves to the same key and is dropped by the start mutation.
  runs: defineTable({
    runKey: v.string(),
    trigger,
    status: runStatus,
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    urlsTotal: v.number(),
    urlsCompleted: v.number(),
    changesCount: v.number(),
  })
    .index("by_runKey", ["runKey"])
    .index("by_startedAt", ["startedAt"]),

  // One document per (run, URL) result, written as each check completes so a
  // partially failed run still leaves durable, consistent rows.
  checks: defineTable({
    runId: v.id("runs"),
    url: v.string(),
    ok: v.boolean(),
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    error: v.optional(v.string()),
    checkedAt: v.number(),
    change: v.optional(change),
  })
    .index("by_run_url", ["runId", "url"])
    // Per-site history for the dashboard's site cards.
    .index("by_url", ["url"]),

  // Singleton checkpoint. lastSuccessfulRunId only advances on success, so a
  // failed run can never corrupt the diff baseline.
  agentState: defineTable({
    key: v.literal("singleton"),
    paused: v.boolean(),
    lastSuccessfulRunId: v.optional(v.id("runs")),
    lastSuccessfulAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // Singleton config, editable from the dashboard; the Worker reads it here so
  // there is one source of truth for the URL list.
  config: defineTable({
    key: v.literal("singleton"),
    urls: v.array(v.string()),
    // Phase 6: when true, the agent throws mid-run to prove recovery works.
    injectFailure: v.optional(v.boolean()),
  }).index("by_key", ["key"]),
});
