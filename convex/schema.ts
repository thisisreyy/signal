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
    // Set when a run fails, so a human-initiated resume knows which phase to
    // restore. FAILED alone would erase where the run actually was.
    stateBeforeFailure: v.optional(
      v.union(
        v.literal("PROFILING"),
        v.literal("GENERATING_KEYWORDS"),
        v.literal("VALIDATING"),
        v.literal("EXTRACTING_COMPETITORS"),
        v.literal("RECOMMENDING"),
      ),
    ),
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
    // Consecutive step failures; resets on any completion. Opens the circuit
    // so a dead provider stops the run early instead of grinding every
    // remaining step through its full retry budget.
    consecutiveFailures: v.optional(v.number()),
    // How many competitors to carry forward into tracking (configurable).
    topCompetitors: v.optional(v.number()),
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

  // Phase 2 output: proposed keywords, stored as guesses. Nothing here is
  // tracked — status stays "unvalidated" until real search results in Phase 3
  // promote or reject each one.
  keywordCandidates: defineTable({
    discoveryId: v.id("discoveryRuns"),
    keyword: v.string(),
    kind: v.union(
      v.literal("category"),
      v.literal("problem"),
      v.literal("comparison"),
      v.literal("longtail"),
    ),
    rationale: v.string(), // why the model thinks a buyer would search this
    status: v.union(
      v.literal("unvalidated"),
      v.literal("relevant"),
      v.literal("irrelevant"),
      v.literal("ambiguous"),
      // A keyword whose search or classification could not complete. Kept
      // distinct from "irrelevant": we failed to judge it, we did not judge
      // it unsuitable.
      v.literal("error"),
    ),
    // The verdict AND what produced it. A classification with no visible
    // evidence is exactly what this pipeline is supposed to never ship.
    validation: v.optional(
      v.object({
        reasoning: v.string(),
        confidence: v.optional(v.number()),
        checkedAt: v.number(),
        // Trimmed page-one evidence; the full response stays in externalCalls.
        topDomains: v.array(
          v.object({
            position: v.number(),
            domain: v.string(),
            title: v.optional(v.string()),
          }),
        ),
        error: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_discoveryId", ["discoveryId"])
    .index("by_discoveryId_and_status", ["discoveryId", "status"]),

  // Phase 4 output: every domain that ranked for a validated keyword, with
  // the classification that decided whether it counts as competition and the
  // evidence (which keywords, which positions) that identified it.
  competitors: defineTable({
    discoveryId: v.id("discoveryRuns"),
    domain: v.string(),
    classification: v.union(
      v.literal("competitor"),
      v.literal("adjacent"),
      v.literal("directory"),
      v.literal("forum"),
      v.literal("media"),
      v.literal("reference"),
      v.literal("social"),
      v.literal("marketplace"),
      v.literal("other"),
    ),
    // "list" = hardcoded exclusion, "llm" = classified by model. Which
    // mechanism made the call is itself inspectable.
    decidedBy: v.union(v.literal("list"), v.literal("llm")),
    reasoning: v.string(),
    confidence: v.optional(v.number()),
    appearances: v.number(),
    averagePosition: v.number(),
    bestPosition: v.number(),
    score: v.number(),
    evidence: v.array(v.object({ keyword: v.string(), position: v.number() })),
    rank: v.optional(v.number()), // among true competitors only
    selected: v.boolean(), // in the top N carried into tracking
    createdAt: v.number(),
  })
    .index("by_discoveryId", ["discoveryId"])
    .index("by_discoveryId_and_selected", ["discoveryId", "selected"]),

  // Phase 5 output. Every row here has been verified against stored ranking
  // data at write time — the evidence array cannot contain a position nobody
  // observed, because verifyGrounding rejects the whole recommendation first.
  recommendations: defineTable({
    discoveryId: v.id("discoveryRuns"),
    action: v.string(),
    rationale: v.string(),
    evidence: v.array(
      v.object({
        type: v.literal("ranking"),
        keyword: v.string(),
        ourRank: v.optional(v.number()), // absent = the business does not rank
        competitor: v.optional(v.string()),
        theirRank: v.optional(v.number()),
        // Which stored record backs this claim, so the UI can link to it.
        candidateId: v.optional(v.id("keywordCandidates")),
      }),
    ),
    expectedOutcome: v.object({
      keyword: v.string(),
      currentRank: v.optional(v.number()),
      predictedRank: v.number(),
      timeframeDays: v.number(),
    }),
    confidence: v.number(),
    fallback: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("correct"),
      v.literal("incorrect"),
      v.literal("inconclusive"),
    ),
    // When the prediction becomes checkable, and how it turned out (Phase 6).
    dueAt: v.number(),
    scoredAt: v.optional(v.number()),
    actualRank: v.optional(v.number()),
    delta: v.optional(v.number()), // predicted - actual; negative = beat it
    scoringNote: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_discoveryId", ["discoveryId"])
    .index("by_status_and_dueAt", ["status", "dueAt"]),

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
