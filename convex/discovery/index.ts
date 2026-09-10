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
  IMPLEMENTED_FRONTIER,
  KEYWORD_KINDS,
  MAX_ATTEMPTS,
  MAX_FETCH_CALLS,
  MAX_LLM_CALLS,
  nextStepKind,
  STEP_STALE_MS,
  stepKey,
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

    // Cost caps, enforced transactionally before any spend.
    if (run.fetchCalls > MAX_FETCH_CALLS || run.llmCalls > MAX_LLM_CALLS) {
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
    if (existing) return existing._id; // retry after window (c): no double record

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
  args: { callKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("externalCalls")
      .withIndex("by_callKey", (q) => q.eq("callKey", args.callKey))
      .unique();
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
    await ctx.db.patch(run._id, { state: "GENERATING_KEYWORDS", updatedAt: Date.now() });
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
    // VALIDATING is the implemented frontier: the run parks here awaiting
    // Phase 3 rather than pretending to be COMPLETE.
    await ctx.db.patch(run._id, { state: "VALIDATING", updatedAt: now });
  },
});

const MAX_CANDIDATES = 100;

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
    for (const state of ["PROFILING", "GENERATING_KEYWORDS"] as const) {
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
    return { run, steps, profile, candidates, implementedFrontier: IMPLEMENTED_FRONTIER };
  },
});

export const listRuns = query({
  args: {},
  handler: async (ctx) => {
    // Newest first via the built-in creation-time index — no JS sorting.
    return await ctx.db.query("discoveryRuns").order("desc").take(20);
  },
});
