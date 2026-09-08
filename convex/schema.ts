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

  // ---------- Auto-discovery pipeline (additive; daily tracking untouched) ----------

  // One document per discovery run: an explicit state machine, not booleans.
  discoveryRuns: defineTable({
    url: v.string(),
    state: v.union(
      v.literal("PROFILING"),
      v.literal("GENERATING_KEYWORDS"),
      v.literal("VALIDATING"),
      v.literal("EXTRACTING_COMPETITORS"),
      v.literal("RECOMMENDING"),
      v.literal("COMPLETE"),
      v.literal("FAILED"),
    ),
    error: v.optional(v.string()),
    // Crash-simulation across the pipeline: throw once (attempt 1 only) at a
    // chosen point inside the named step. "before-ledger"/"after-ledger"
    // target the exact dual-write gap on purpose.
    injectCrash: v.optional(
      v.object({
        step: v.string(),
        where: v.union(v.literal("before-ledger"), v.literal("after-ledger")),
      }),
    ),
    // Cost accounting, incremented transactionally with each ledger write.
    fetchCalls: v.number(),
    llmCalls: v.number(),
    searchCalls: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_url", ["url"])
    .index("by_state", ["state"]),

  // The outbox: one row per unit of work. The intent is written (and the next
  // action scheduled) in the same mutation — transactionally — before any
  // external call happens. Status lifecycle: pending → running → done|failed.
  discoverySteps: defineTable({
    discoveryId: v.id("discoveryRuns"),
    kind: v.string(),
    stepKey: v.string(), // derived: discoveryId + kind + input hash
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    doneAt: v.optional(v.number()),
    error: v.optional(v.string()),
    errorClass: v.optional(v.union(v.literal("retryable"), v.literal("terminal"))),
    result: v.optional(v.any()), // small summaries only; big payloads live in externalCalls
  })
    .index("by_stepKey", ["stepKey"])
    .index("by_discovery", ["discoveryId"])
    .index("by_status", ["status"]),

  // The effect ledger: every external call's result, keyed by request content.
  // Doubles as the retry cache (a healed crash re-reads instead of re-calling)
  // and the 24h search cache. Written by a mutation the moment a call returns.
  externalCalls: defineTable({
    callKey: v.string(),
    kind: v.union(v.literal("fetch"), v.literal("llm"), v.literal("serper")),
    discoveryId: v.optional(v.id("discoveryRuns")),
    request: v.string(), // human-readable request summary (never secrets)
    response: v.any(),
    ok: v.boolean(),
    createdAt: v.number(),
  }).index("by_callKey", ["callKey"]),

  // The profiling step's output. Nulls are honest answers, each field scored.
  businessProfiles: defineTable({
    discoveryId: v.id("discoveryRuns"),
    url: v.string(),
    name: v.union(v.string(), v.null()),
    whatTheySell: v.union(v.string(), v.null()),
    audience: v.union(v.literal("b2b"), v.literal("b2c"), v.null()),
    buyerType: v.union(v.string(), v.null()),
    pricePoint: v.union(v.string(), v.null()),
    businessStage: v.union(v.string(), v.null()),
    category: v.union(v.string(), v.null()),
    fieldConfidence: v.record(v.string(), v.number()),
    pagesFetched: v.array(
      v.object({ url: v.string(), ok: v.boolean(), chars: v.number() }),
    ),
    createdAt: v.number(),
  }).index("by_discovery", ["discoveryId"]),

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
