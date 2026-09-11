import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  backoffMs,
  CIRCUIT_BREAK_FAILURES,
  IMPLEMENTED_FRONTIER,
  KEYWORD_KINDS,
  MAX_ATTEMPTS,
  MAX_CANDIDATES_TO_VALIDATE,
  MAX_FETCH_CALLS,
  MAX_LLM_CALLS,
  MAX_SEARCH_CALLS,
  DEFAULT_TOP_COMPETITORS,
  DOMAIN_CLASSES,
  MAX_RECOMMENDATIONS,
  nextStepKind,
  scoreRecommendation,
  summarizeAccuracy,
  type Measurement,
  nextValidationBatch,
  STEP_STALE_MS,
  stepKey,
  VERDICTS,
  type BusinessProfileFields,
  type DiscoveryState,
  type StepKind,
} from "./logic";

/**
 * THE OUTBOX CONTRACT (the dual-write answer, in one place):
 *
 * 1. Intent first, transactionally. A step row is inserted as "pending" and
 *    the action that will execute it is scheduled in the SAME mutation —
 *    Convex guarantees functions scheduled from a mutation are enqueued
 *    atomically with that mutation's writes. There is no state where the
 *    intent exists but nothing will run it, or vice versa.
 * 2. Effects are recorded the moment they happen. The action performs the
 *    external call, then immediately calls recordExternalCall (a mutation)
 *    to persist the response into the ledger, keyed by request content.
 * 3. Completion is transactional. Marking the step done, writing its output,
 *    creating the NEXT step's intent, and scheduling it happen in one
 *    mutation. The pipeline can never half-advance.
 *
 * The crash windows, and how each heals:
 *   a) Crash before the external call         → nothing happened. Sweep finds
 *      the stale "running" step, re-pends it, retry re-executes. Cost: zero.
 *   b) Crash AFTER the call, BEFORE the ledger write → the one unavoidable
 *      window. The provider was paid but we have no record. Retry re-issues
 *      the call: cost = one duplicate call per crash in this window, bounded
 *      by MAX_ATTEMPTS. State is never wrong — only the meter runs twice.
 *   c) Crash after the ledger write, before completion → retry finds the
 *      ledger entry by derived callKey and SKIPS the external call entirely.
 *      Cost: zero. This is why the ledger write is its own mutation instead
 *      of being folded into completion.
 *   Window (b) cannot be closed from our side without provider-side
 *   idempotency keys, which neither Serper nor the LLM API offers. The
 *   design minimizes the window to a single mutation call and makes the
 *   worst case "spend one extra credit", never "corrupt state".
 */

const STEP_SCAN_LIMIT = 200;

// ---------- Starting a run ----------

export const start = mutation({
  args: {
    url: v.string(),
    topCompetitors: v.optional(v.number()),
    injectCrash: v.optional(
      v.object({
        step: v.string(),
        where: v.union(v.literal("before-ledger"), v.literal("after-ledger")),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const url = normalizeUrl(args.url);
    if (!url) throw new Error("Enter a full URL like https://example.com");

    // Idempotent-by-active-run: a double submit returns the run in flight
    // instead of starting a second discovery for the same site.
    const existing = await ctx.db
      .query("discoveryRuns")
      .withIndex("by_url", (q) => q.eq("url", url))
      .take(20);
    const active = existing.find((r) => r.state !== "COMPLETE" && r.state !== "FAILED");
    if (active) return { discoveryId: active._id, created: false };

    const now = Date.now();
    const discoveryId = await ctx.db.insert("discoveryRuns", {
      url,
      state: "PROFILING",
      injectCrash: args.injectCrash,
      topCompetitors: args.topCompetitors ?? DEFAULT_TOP_COMPETITORS,
      fetchCalls: 0,
      llmCalls: 0,
      searchCalls: 0,
      createdAt: now,
      updatedAt: now,
    });
    await insertStepAndSchedule(ctx, discoveryId, "FETCH_PAGES", url);
    return { discoveryId, created: true };
  },
});

function normalizeUrl(raw: string): string | null {
  let candidate = raw.trim();
  if (!/^https?:\/\//.test(candidate)) candidate = `https://${candidate}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/** Intent + schedule, atomically. The heart of the outbox. */
async function insertStepAndSchedule(
  ctx: MutationCtx,
  discoveryId: Id<"discoveryRuns">,
  kind: StepKind,
  input: string,
): Promise<Id<"discoverySteps">> {
  const key = stepKey(discoveryId, kind, input);
  const existing = await ctx.db
    .query("discoverySteps")
    .withIndex("by_stepKey", (q) => q.eq("stepKey", key))
    .unique();
  if (existing) return existing._id; // derived key: re-creating intent is a no-op

  const stepId = await ctx.db.insert("discoverySteps", {
    discoveryId,
    kind,
    stepKey: key,
    status: "pending",
    attempts: 0,
  });
  await ctx.scheduler.runAfter(0, internal.discovery.actions.runStep, { stepId });
  return stepId;
}

// ---------- The action's transactional touchpoints ----------

/** pending → running gate. The only door through which work may start. */
export const claimStep = internalMutation({
  args: { stepId: v.id("discoverySteps") },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "pending") return null; // already claimed/done
    const run = await ctx.db.get(step.discoveryId);
    if (!run || run.state === "FAILED" || run.state === "COMPLETE") return null;

    // The provider looks dead: stop before grinding every remaining step
    // through its full retry budget.
    if ((run.consecutiveFailures ?? 0) >= CIRCUIT_BREAK_FAILURES) {
      await ctx.db.patch(step._id, {
        status: "failed",
        errorClass: "terminal",
        error: "circuit opened after repeated provider failures",
      });
      await ctx.db.patch(run._id, {
        state: "FAILED",
        stateBeforeFailure: run.state as Exclude<DiscoveryState, "COMPLETE" | "FAILED">,
        error: "circuit opened after repeated provider failures",
        updatedAt: Date.now(),
      });
      return null;
    }

    // Cost caps, enforced transactionally before any spend.
    if (
      // >= not >: this runs BEFORE a step that will spend more, so a run
      // sitting exactly at its cap must stop rather than exceed it by one.
      run.fetchCalls >= MAX_FETCH_CALLS ||
      run.llmCalls >= MAX_LLM_CALLS ||
      run.searchCalls >= MAX_SEARCH_CALLS
    ) {
      await ctx.db.patch(step._id, {
        status: "failed",
        errorClass: "terminal",
        error: "per-run cost cap exceeded",
      });
      await ctx.db.patch(run._id, {
        state: "FAILED",
        stateBeforeFailure: run.state as Exclude<DiscoveryState, "COMPLETE" | "FAILED">,
        error: "cost cap exceeded",
        updatedAt: Date.now(),
      });
      return null;
    }

    await ctx.db.patch(step._id, {
      status: "running",
      attempts: step.attempts + 1,
      startedAt: Date.now(),
    });
    return { step: { ...step, attempts: step.attempts + 1 }, run };
  },
});

/** The effect ledger write — called the instant an external call returns. */
export const recordExternalCall = internalMutation({
  args: {
    callKey: v.string(),
    kind: v.union(v.literal("fetch"), v.literal("llm"), v.literal("serper")),
    discoveryId: v.id("discoveryRuns"),
    request: v.string(),
    response: v.any(),
    ok: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("externalCalls")
      .withIndex("by_callKey", (q) => q.eq("callKey", args.callKey))
      .unique();
    if (existing) {
      // A retry that finally succeeded must replace a recorded failure —
      // otherwise the good result is silently discarded and the run keeps
      // reading the failed one. Successes are never overwritten.
      if (!existing.ok && args.ok) {
        await ctx.db.patch(existing._id, {
          response: args.response,
          ok: true,
          request: args.request,
          createdAt: Date.now(),
        });
        const run = await ctx.db.get(args.discoveryId);
        if (run) {
          const field =
            args.kind === "fetch" ? "fetchCalls" : args.kind === "llm" ? "llmCalls" : "searchCalls";
          // The retry really was a second call; count the spend honestly.
          await ctx.db.patch(run._id, { [field]: run[field] + 1, updatedAt: Date.now() });
        }
      }
      return existing._id; // retry after window (c): no double record
    }

    const id = await ctx.db.insert("externalCalls", {
      callKey: args.callKey,
      kind: args.kind,
      discoveryId: args.discoveryId,
      request: args.request,
      response: args.response,
      ok: args.ok,
      createdAt: Date.now(),
    });
    const run = await ctx.db.get(args.discoveryId);
    if (run) {
      const field =
        args.kind === "fetch" ? "fetchCalls" : args.kind === "llm" ? "llmCalls" : "searchCalls";
      await ctx.db.patch(run._id, { [field]: run[field] + 1, updatedAt: Date.now() });
    }
    return id;
  },
});

export const getExternalCall = internalQuery({
  args: {
    callKey: v.string(),
    // Searches are reusable across runs but go stale; pass a window to treat
    // an old entry as absent. Omitted = any age (page fetches, LLM calls,
    // which are keyed to one run and never worth repeating).
    maxAgeMs: v.optional(v.number()),
    now: v.optional(v.number()), // caller-supplied: queries must not read the clock
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("externalCalls")
      .withIndex("by_callKey", (q) => q.eq("callKey", args.callKey))
      .unique();
    if (!entry) return null;
    if (args.maxAgeMs !== undefined && args.now !== undefined) {
      if (entry.createdAt < args.now - args.maxAgeMs) return null; // stale
    }
    return entry;
  },
});

/** The next batch of still-unvalidated candidates, planned from data. */
export const getValidationBatch = internalQuery({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", args.discoveryId))
      .take(MAX_CANDIDATES_TO_VALIDATE);
    return nextValidationBatch(candidates).map((c) => c.keyword);
  },
});

/**
 * The page-one evidence Phase 3 already stored, for the keywords real search
 * data confirmed as relevant. Phase 4 needs no new searches because of this.
 */
export const getValidatedEvidence = internalQuery({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const relevant = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId_and_status", (q) =>
        q.eq("discoveryId", args.discoveryId).eq("status", "relevant"),
      )
      .take(MAX_CANDIDATES_TO_VALIDATE);
    return relevant.map((c) => ({
      keyword: c.keyword,
      topDomains: (c.validation?.topDomains ?? []).map((d) => ({
        domain: d.domain,
        position: d.position,
      })),
    }));
  },
});

/** Validated evidence plus the selected competitor set, for Phase 5. */
export const getRecommendationInputs = internalQuery({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const relevant = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId_and_status", (q) =>
        q.eq("discoveryId", args.discoveryId).eq("status", "relevant"),
      )
      .take(MAX_CANDIDATES_TO_VALIDATE);
    const selected = await ctx.db
      .query("competitors")
      .withIndex("by_discoveryId_and_selected", (q) =>
        q.eq("discoveryId", args.discoveryId).eq("selected", true),
      )
      .take(50);
    return {
      validated: relevant.map((c) => ({
        candidateId: c._id,
        keyword: c.keyword,
        topDomains: (c.validation?.topDomains ?? []).map((d) => ({
          domain: d.domain,
          position: d.position,
        })),
      })),
      competitorDomains: selected.map((c) => c.domain),
    };
  },
});

export const getProfileForRun = internalQuery({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("businessProfiles")
      .withIndex("by_discovery", (q) => q.eq("discoveryId", args.discoveryId))
      .unique();
  },
});

/** FETCH_PAGES done → record summary, create PROFILE intent. One transaction. */
export const completeFetchStep = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    pages: v.array(v.object({ url: v.string(), ok: v.boolean(), chars: v.number() })),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return; // late duplicate: no-op
    await ctx.db.patch(step._id, {
      status: "done",
      doneAt: Date.now(),
      result: { pages: args.pages },
    });
    const run = await ctx.db.get(step.discoveryId);
    if (!run) return;
    await ctx.db.patch(run._id, { consecutiveFailures: 0 });
    await insertStepAndSchedule(ctx, run._id, "PROFILE", run.url);
  },
});

/**
 * PROFILE done → store the profile, advance to GENERATING_KEYWORDS, and
 * create that phase's intent. All one transaction: the run can never be in
 * "profiled but nothing will generate keywords".
 */
export const completeProfileStep = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    profile: v.any(),
    pagesFetched: v.array(v.object({ url: v.string(), ok: v.boolean(), chars: v.number() })),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return;
    const run = await ctx.db.get(step.discoveryId);
    if (!run) return;
    const p = args.profile as BusinessProfileFields;

    await ctx.db.insert("businessProfiles", {
      discoveryId: run._id,
      url: run.url,
      name: p.name,
      whatTheySell: p.what_they_sell,
      audience: p.audience,
      buyerType: p.buyer_type,
      pricePoint: p.price_point,
      businessStage: p.business_stage,
      category: p.category,
      fieldConfidence: p.field_confidence,
      pagesFetched: args.pagesFetched,
      createdAt: Date.now(),
    });
    await ctx.db.patch(step._id, { status: "done", doneAt: Date.now() });
    await ctx.db.patch(run._id, {
      state: "GENERATING_KEYWORDS",
      consecutiveFailures: 0,
      updatedAt: Date.now(),
    });
    await insertStepAndSchedule(ctx, run._id, "GENERATE_KEYWORDS", run.url);
  },
});

/**
 * GENERATE_KEYWORDS done → store candidates as UNVALIDATED and advance to
 * VALIDATING. Nothing here is tracked: these are hypotheses awaiting Phase 3,
 * which is why status is not a boolean and config is left untouched.
 */
export const completeKeywordsStep = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    keywords: v.array(
      v.object({
        keyword: v.string(),
        kind: v.union(...KEYWORD_KINDS.map((k) => v.literal(k))),
        rationale: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return;
    const run = await ctx.db.get(step.discoveryId);
    if (!run) return;

    // Re-running this step (a healed crash) must not duplicate candidates.
    const existing = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", run._id))
      .take(MAX_CANDIDATES);
    const known = new Set(existing.map((c) => c.keyword));

    const now = Date.now();
    for (const candidate of args.keywords) {
      if (known.has(candidate.keyword)) continue;
      await ctx.db.insert("keywordCandidates", {
        discoveryId: run._id,
        keyword: candidate.keyword,
        kind: candidate.kind,
        rationale: candidate.rationale,
        status: "unvalidated",
        createdAt: now,
      });
    }
    await ctx.db.patch(step._id, {
      status: "done",
      doneAt: now,
      result: { generated: args.keywords.length },
    });
    await ctx.db.patch(run._id, {
      state: "VALIDATING",
      consecutiveFailures: 0,
      updatedAt: now,
    });
    await ensureValidationStep(ctx, run._id);
  },
});

/**
 * Plan the next validation batch from the candidates themselves. The cursor
 * is the data ("which candidates are still unvalidated"), not a counter, so a
 * resumed or healed run can never re-validate a keyword or skip one.
 * When nothing is left, the phase is finished and the state advances.
 */
async function ensureValidationStep(ctx: MutationCtx, discoveryId: Id<"discoveryRuns">) {
  const run = await ctx.db.get(discoveryId);
  if (!run || run.state !== "VALIDATING") return;

  const candidates = await ctx.db
    .query("keywordCandidates")
    .withIndex("by_discoveryId", (q) => q.eq("discoveryId", discoveryId))
    .take(MAX_CANDIDATES_TO_VALIDATE);
  const batch = nextValidationBatch(candidates);

  if (batch.length === 0) {
    // EXTRACTING_COMPETITORS is the implemented frontier: park here awaiting
    // Phase 4 rather than pretending to be COMPLETE.
    await ctx.db.patch(discoveryId, {
      state: "EXTRACTING_COMPETITORS",
      updatedAt: Date.now(),
    });
    return;
  }
  // Batch identity = its contents, so the derived stepKey is stable across
  // retries of the same batch and distinct between different batches.
  const input = batch.map((c) => c.keyword).join("|");
  await insertStepAndSchedule(ctx, discoveryId, "VALIDATE_BATCH", input);
}

/**
 * One batch validated → write each verdict with the evidence that produced
 * it, then plan the next batch. All one transaction, so the phase can never
 * stall between "batch finished" and "next batch exists".
 */
export const completeValidationBatch = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    results: v.array(
      v.object({
        keyword: v.string(),
        status: v.union(...VERDICTS.map((s) => v.literal(s)), v.literal("error")),
        reasoning: v.string(),
        confidence: v.optional(v.number()),
        error: v.optional(v.string()),
        topDomains: v.array(
          v.object({
            position: v.number(),
            domain: v.string(),
            title: v.optional(v.string()),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return;
    const run = await ctx.db.get(step.discoveryId);
    if (!run) return;

    const candidates = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", run._id))
      .take(MAX_CANDIDATES_TO_VALIDATE);
    const byKeyword = new Map(candidates.map((c) => [c.keyword, c]));

    const now = Date.now();
    for (const result of args.results) {
      const candidate = byKeyword.get(result.keyword);
      if (!candidate) continue;
      await ctx.db.patch(candidate._id, {
        status: result.status,
        validation: {
          reasoning: result.reasoning,
          confidence: result.confidence,
          checkedAt: now,
          topDomains: result.topDomains,
          error: result.error,
        },
      });
    }

    await ctx.db.patch(step._id, {
      status: "done",
      doneAt: now,
      result: { validated: args.results.length },
    });
    await ctx.db.patch(run._id, { consecutiveFailures: 0, updatedAt: now });
    await ensureValidationStep(ctx, run._id);
  },
});

const MAX_CANDIDATES = 100;

/**
 * Competitors extracted → store every domain with its classification, the
 * mechanism that decided it, and the evidence that identified it. Advances
 * to RECOMMENDING (the implemented frontier) in the same transaction.
 */
export const completeCompetitorsStep = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    domains: v.array(
      v.object({
        domain: v.string(),
        classification: v.union(...DOMAIN_CLASSES.map((c) => v.literal(c)), v.literal("social"), v.literal("marketplace")),
        decidedBy: v.union(v.literal("list"), v.literal("llm")),
        reasoning: v.string(),
        confidence: v.optional(v.number()),
        appearances: v.number(),
        averagePosition: v.number(),
        bestPosition: v.number(),
        score: v.number(),
        evidence: v.array(v.object({ keyword: v.string(), position: v.number() })),
        rank: v.optional(v.number()),
        selected: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return;
    const run = await ctx.db.get(step.discoveryId);
    if (!run) return;

    // A healed retry rewrites rather than duplicates.
    const existing = await ctx.db
      .query("competitors")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", run._id))
      .take(200);
    for (const row of existing) await ctx.db.delete(row._id);

    const now = Date.now();
    for (const d of args.domains) {
      await ctx.db.insert("competitors", { discoveryId: run._id, ...d, createdAt: now });
    }
    await ctx.db.patch(step._id, {
      status: "done",
      doneAt: now,
      result: {
        classified: args.domains.length,
        competitors: args.domains.filter((d) => d.classification === "competitor").length,
      },
    });
    await ctx.db.patch(run._id, {
      state: "RECOMMENDING",
      consecutiveFailures: 0,
      updatedAt: now,
    });
  },
});

/**
 * The human-gated bridge from discovery into the live daily tracker. Nothing
 * writes to the tracker's config automatically: discovery PROPOSES, a person
 * (or the Phase 7 UI) decides. Keeps "never track what a human hasn't seen".
 */
export const applyToTracking = mutation({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.discoveryId);
    if (!run) throw new Error("discovery run not found");
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_discovery", (q) => q.eq("discoveryId", args.discoveryId))
      .unique();
    if (!profile) throw new Error("this discovery has no profile yet");

    const relevant = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId_and_status", (q) =>
        q.eq("discoveryId", args.discoveryId).eq("status", "relevant"),
      )
      .take(MAX_CANDIDATES_TO_VALIDATE);
    const selected = await ctx.db
      .query("competitors")
      .withIndex("by_discoveryId_and_selected", (q) =>
        q.eq("discoveryId", args.discoveryId).eq("selected", true),
      )
      .take(50);
    if (relevant.length === 0) {
      throw new Error("no validated keywords to track yet");
    }

    const business = {
      name: profile.name ?? new URL(run.url).hostname,
      domain: new URL(run.url).hostname.replace(/^www\./, ""),
    };
    const config = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();
    const patch = {
      business,
      keywords: relevant.map((c) => c.keyword),
      competitors: selected.map((c) => c.domain),
    };
    if (config) await ctx.db.patch(config._id, patch);
    else await ctx.db.insert("config", { key: "singleton", ...patch });

    return {
      business,
      keywords: patch.keywords.length,
      competitors: patch.competitors.length,
    };
  },
});

/**
 * Recommendations verified and stored → the run is COMPLETE.
 *
 * The action has already discarded anything whose citations did not match
 * stored data; this mutation records what survived, stamps each prediction
 * with the moment it becomes checkable, and never invents a status other
 * than "open" — scoring is Phase 6's job, done from measurements.
 */
export const completeRecommendStep = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    recommendations: v.array(
      v.object({
        action: v.string(),
        rationale: v.string(),
        evidence: v.array(
          v.object({
            type: v.literal("ranking"),
            keyword: v.string(),
            ourRank: v.optional(v.number()),
            competitor: v.optional(v.string()),
            theirRank: v.optional(v.number()),
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
      }),
    ),
    rejected: v.number(),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return;
    const run = await ctx.db.get(step.discoveryId);
    if (!run) return;

    // A healed retry rewrites rather than duplicates.
    const existing = await ctx.db
      .query("recommendations")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", run._id))
      .take(MAX_RECOMMENDATIONS * 2);
    for (const row of existing) await ctx.db.delete(row._id);

    const now = Date.now();
    for (const rec of args.recommendations) {
      if (rec.evidence.length === 0) continue; // belt and braces: never ungrounded
      await ctx.db.insert("recommendations", {
        discoveryId: run._id,
        ...rec,
        status: "open",
        dueAt: now + rec.expectedOutcome.timeframeDays * 24 * 60 * 60 * 1000,
        createdAt: now,
      });
    }
    await ctx.db.patch(step._id, {
      status: "done",
      doneAt: now,
      result: { stored: args.recommendations.length, rejectedUngrounded: args.rejected },
    });
    await ctx.db.patch(run._id, {
      state: "COMPLETE",
      consecutiveFailures: 0,
      updatedAt: now,
    });
  },
});

/** Failure path: retryable → backoff + re-pend; terminal → run FAILED. */
export const failStep = internalMutation({
  args: {
    stepId: v.id("discoverySteps"),
    error: v.string(),
    errorClass: v.union(v.literal("retryable"), v.literal("terminal")),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") return;
    const exhausted = step.attempts >= MAX_ATTEMPTS;

    const runForCount = await ctx.db.get(step.discoveryId);
    if (runForCount) {
      await ctx.db.patch(runForCount._id, {
        consecutiveFailures: (runForCount.consecutiveFailures ?? 0) + 1,
      });
    }

    if (args.errorClass === "retryable" && !exhausted) {
      await ctx.db.patch(step._id, {
        status: "pending",
        error: args.error,
        errorClass: args.errorClass,
        nextAttemptAt: Date.now() + backoffMs(step.attempts),
      });
      return; // the cron sweep re-schedules it when due
    }

    await ctx.db.patch(step._id, {
      status: "failed",
      error: args.error,
      errorClass: args.errorClass,
      doneAt: Date.now(),
    });
    const run = await ctx.db.get(step.discoveryId);
    if (!run || run.state === "FAILED" || run.state === "COMPLETE") return;
    await ctx.db.patch(run._id, {
      state: "FAILED",
      stateBeforeFailure: run.state as Exclude<DiscoveryState, "COMPLETE" | "FAILED">,
      error: `${step.kind}: ${args.error}${exhausted ? " (retries exhausted)" : ""}`,
      updatedAt: Date.now(),
    });
  },
});

// ---------- Resume: a crashed or parked run restarts from its stored state ----------

export const resume = mutation({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.discoveryId);
    if (!run) throw new Error("discovery run not found");
    if (run.state === "COMPLETE") return { resumed: false, reason: "run is COMPLETE" };

    // A FAILED run resumes at the phase it failed in — which is why the
    // failure path records stateBeforeFailure instead of erasing it.
    const state: DiscoveryState =
      run.state === "FAILED" ? (run.stateBeforeFailure ?? "PROFILING") : run.state;

    const steps = await ctx.db
      .query("discoverySteps")
      .withIndex("by_discovery", (q) => q.eq("discoveryId", run._id))
      .take(STEP_SCAN_LIMIT);
    const active = steps.find((s) => s.status === "pending" || s.status === "running");
    if (active) {
      return { resumed: false, reason: `${active.kind} is already ${active.status}` };
    }

    // VALIDATING plans from candidate statuses rather than a step sequence.
    if (state === "VALIDATING") {
      if (run.state === "FAILED") {
        await ctx.db.patch(run._id, {
          state,
          error: undefined,
          stateBeforeFailure: undefined,
          consecutiveFailures: 0,
          updatedAt: Date.now(),
        });
      }
      const failedBatch = steps.find((s) => s.kind === "VALIDATE_BATCH" && s.status === "failed");
      if (failedBatch) {
        await ctx.db.patch(failedBatch._id, {
          status: "pending",
          attempts: 0,
          error: undefined,
          errorClass: undefined,
          nextAttemptAt: undefined,
        });
        await ctx.scheduler.runAfter(0, internal.discovery.actions.runStep, {
          stepId: failedBatch._id,
        });
      } else {
        await ensureValidationStep(ctx, run._id);
      }
      return { resumed: true, kind: "VALIDATE_BATCH" as const };
    }

    const doneKinds = steps.filter((s) => s.status === "done").map((s) => s.kind);
    const kind = nextStepKind(state, doneKinds);
    if (!kind) {
      return { resumed: false, reason: `${state} is at the implemented frontier` };
    }

    if (run.state === "FAILED") {
      await ctx.db.patch(run._id, {
        state,
        error: undefined,
        stateBeforeFailure: undefined,
        updatedAt: Date.now(),
      });
    }

    // A previously failed step for this kind is reset rather than skipped —
    // a human resuming is an explicit decision to grant fresh attempts.
    const failed = steps.find((s) => s.kind === kind && s.status === "failed");
    if (failed) {
      await ctx.db.patch(failed._id, {
        status: "pending",
        attempts: 0,
        error: undefined,
        errorClass: undefined,
        nextAttemptAt: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.discovery.actions.runStep, {
        stepId: failed._id,
      });
    } else {
      await insertStepAndSchedule(ctx, run._id, kind, run.url);
    }
    return { resumed: true, kind };
  },
});

// ---------- The healing sweep (cron, every minute) ----------

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Due retries: pending steps whose backoff has elapsed.
    const pending = await ctx.db
      .query("discoverySteps")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(STEP_SCAN_LIMIT);
    for (const step of pending) {
      if (step.nextAttemptAt !== undefined && step.nextAttemptAt <= now) {
        await ctx.db.patch(step._id, { nextAttemptAt: undefined });
        await ctx.scheduler.runAfter(0, internal.discovery.actions.runStep, {
          stepId: step._id,
        });
      }
    }

    // Crashed steps: "running" past the staleness threshold. This is what
    // heals windows (a), (b) and (c) — the retry re-executes, and the ledger
    // decides whether the external call actually needs to happen again.
    const running = await ctx.db
      .query("discoverySteps")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(STEP_SCAN_LIMIT);
    for (const step of running) {
      if ((step.startedAt ?? 0) >= now - STEP_STALE_MS) continue;
      if (step.attempts >= MAX_ATTEMPTS) {
        await ctx.db.patch(step._id, {
          status: "failed",
          error: "crashed repeatedly; retries exhausted",
          errorClass: "terminal",
          doneAt: now,
        });
        const run = await ctx.db.get(step.discoveryId);
        if (run && run.state !== "FAILED" && run.state !== "COMPLETE") {
          await ctx.db.patch(run._id, {
            state: "FAILED",
            stateBeforeFailure: run.state as Exclude<DiscoveryState, "COMPLETE" | "FAILED">,
            error: `${step.kind}: crashed repeatedly`,
            updatedAt: now,
          });
        }
      } else {
        await ctx.db.patch(step._id, { status: "pending" });
        await ctx.scheduler.runAfter(0, internal.discovery.actions.runStep, {
          stepId: step._id,
        });
      }
    }

    // Parked runs: a live state whose next step simply doesn't exist. This is
    // how a run picks up when a later pipeline phase is deployed, and the
    // backstop if an intent were ever lost.
    // A VALIDATING run with no live step simply needs its next batch planned.
    const validating = await ctx.db
      .query("discoveryRuns")
      .withIndex("by_state", (q) => q.eq("state", "VALIDATING"))
      .take(50);
    for (const run of validating) {
      if (run.updatedAt > now - 60_000) continue;
      const steps = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", run._id))
        .take(STEP_SCAN_LIMIT);
      if (steps.some((s) => s.status === "pending" || s.status === "running")) continue;
      if (steps.some((s) => s.kind === "VALIDATE_BATCH" && s.status === "failed")) continue;
      await ensureValidationStep(ctx, run._id);
    }

    for (const state of [
      "PROFILING",
      "GENERATING_KEYWORDS",
      "EXTRACTING_COMPETITORS",
      "RECOMMENDING",
    ] as const) {
      const runs = await ctx.db
        .query("discoveryRuns")
        .withIndex("by_state", (q) => q.eq("state", state))
        .take(50);
      for (const run of runs) {
        if (run.updatedAt > now - 60_000) continue; // let in-flight work settle
        const steps = await ctx.db
          .query("discoverySteps")
          .withIndex("by_discovery", (q) => q.eq("discoveryId", run._id))
          .take(STEP_SCAN_LIMIT);
        if (steps.some((s) => s.status !== "done")) continue; // active or failed: not ours
        const kind = nextStepKind(state, steps.map((s) => s.kind));
        if (kind) await insertStepAndSchedule(ctx, run._id, kind, run.url);
      }
    }
  },
});

// ---------- Phase 6: the outcome loop ----------

/**
 * The measured truth for one keyword, read from the DAILY TRACKER — the same
 * records the live dashboard shows. Recommendations are never scored against
 * discovery-time data: a prediction made from a discovery snapshot must be
 * judged by an independent measurement taken afterwards.
 */
async function measureKeyword(ctx: MutationCtx, keyword: string): Promise<Measurement> {
  const config = await ctx.db
    .query("config")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .unique();
  const tracked = (config?.keywords ?? []).includes(keyword);
  if (!tracked) return { tracked: false };

  // Most recent checks for this keyword, newest first.
  const recent = await ctx.db
    .query("keywordChecks")
    .withIndex("by_keyword", (q) => q.eq("keyword", keyword))
    .order("desc")
    .take(10);

  for (const row of recent) {
    const run = await ctx.db.get(row.runId);
    if (!run || run.status !== "succeeded") continue; // only trust finished runs
    if (row.error !== undefined) return { tracked: true, errored: true, measuredAt: row.checkedAt };
    return {
      tracked: true,
      measuredAt: row.checkedAt,
      measuredRank: row.positions.find((p) => p.isBusiness)?.position,
    };
  }
  return { tracked: true };
}

/**
 * Score one pending recommendation in place.
 *
 * "open" and "inconclusive" are both re-scorable; a settled verdict is not.
 * Inconclusive means "could not be judged YET" — usually because no check has
 * run since the prediction — and that reason expires. Treating it as final
 * would permanently discard predictions that were merely early.
 */
async function scoreOne(ctx: MutationCtx, recId: Id<"recommendations">) {
  const rec = await ctx.db.get(recId);
  if (!rec) return null;
  if (rec.status === "correct" || rec.status === "incorrect") return null; // settled

  const measurement = await measureKeyword(ctx, rec.expectedOutcome.keyword);
  const outcome = scoreRecommendation(
    rec.expectedOutcome.predictedRank,
    rec.createdAt,
    measurement,
  );
  await ctx.db.patch(rec._id, {
    status: outcome.status,
    actualRank: outcome.actualRank,
    delta: outcome.delta,
    scoringNote: outcome.note,
    scoredAt: Date.now(),
  });
  return outcome;
}

/**
 * The cron-driven loop: every prediction whose timeframe has elapsed gets
 * compared against real measurements, with no human scoring anything.
 */
export const scoreDueRecommendations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Both pending states: an inconclusive verdict is revisited once a
    // measurement finally exists.
    const due = [
      ...(await ctx.db
        .query("recommendations")
        .withIndex("by_status_and_dueAt", (q) => q.eq("status", "open").lte("dueAt", now))
        .take(50)),
      ...(await ctx.db
        .query("recommendations")
        .withIndex("by_status_and_dueAt", (q) =>
          q.eq("status", "inconclusive").lte("dueAt", now),
        )
        .take(50)),
    ];
    let scored = 0;
    for (const rec of due) {
      if (await scoreOne(ctx, rec._id)) scored += 1;
    }
    return { considered: due.length, scored };
  },
});

/**
 * Manual scoring, for demonstrating the loop without waiting out a 90-day
 * timeframe. Identical logic to the cron path — it only bypasses the clock,
 * never the evidence.
 */
export const scoreNow = mutation({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const open = await ctx.db
      .query("recommendations")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", args.discoveryId))
      .take(MAX_RECOMMENDATIONS * 2);
    const results: { keyword: string; status: string; note: string }[] = [];
    for (const rec of open) {
      if (rec.status === "correct" || rec.status === "incorrect") continue;
      const outcome = await scoreOne(ctx, rec._id);
      if (outcome) {
        results.push({
          keyword: rec.expectedOutcome.keyword,
          status: outcome.status,
          note: outcome.note,
        });
      }
    }
    return results;
  },
});

/**
 * "How often are my recommendations right?" — answered from scored outcomes,
 * with inconclusive results excluded from the denominator.
 */
export const accuracy = query({
  args: { discoveryId: v.optional(v.id("discoveryRuns")) },
  handler: async (ctx, args) => {
    const rows = args.discoveryId
      ? await ctx.db
          .query("recommendations")
          .withIndex("by_discoveryId", (q) => q.eq("discoveryId", args.discoveryId!))
          .take(200)
      : await ctx.db.query("recommendations").order("desc").take(200);
    return summarizeAccuracy(rows);
  },
});

// ---------- Reads (UI and CLI) ----------

export const getRun = query({
  args: { discoveryId: v.id("discoveryRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.discoveryId);
    if (!run) return null;
    const steps = await ctx.db
      .query("discoverySteps")
      .withIndex("by_discovery", (q) => q.eq("discoveryId", args.discoveryId))
      .take(STEP_SCAN_LIMIT);
    const profile = await ctx.db
      .query("businessProfiles")
      .withIndex("by_discovery", (q) => q.eq("discoveryId", args.discoveryId))
      .unique();
    const candidates = await ctx.db
      .query("keywordCandidates")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", args.discoveryId))
      .take(MAX_CANDIDATES);
    const competitors = await ctx.db
      .query("competitors")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", args.discoveryId))
      .take(200);
    const recommendations = await ctx.db
      .query("recommendations")
      .withIndex("by_discoveryId", (q) => q.eq("discoveryId", args.discoveryId))
      .take(MAX_RECOMMENDATIONS * 2);
    return {
      run,
      steps,
      profile,
      candidates,
      competitors: competitors.sort((a, b) => b.score - a.score),
      recommendations,
      implementedFrontier: IMPLEMENTED_FRONTIER,
    };
  },
});

export const listRuns = query({
  args: {},
  handler: async (ctx) => {
    // Newest first via the built-in creation-time index — no JS sorting.
    return await ctx.db.query("discoveryRuns").order("desc").take(20);
  },
});
