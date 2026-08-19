import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { trigger } from "./schema";
import { ensureAgentState, getAgentState } from "./helpers";

/** Latest runs, newest first, for the dashboard timeline. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_startedAt")
      .order("desc")
      .take(args.limit ?? 50);
  },
});

/** One run plus all of its per-URL checks, for the detail view. */
export const get = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const checks = await ctx.db
      .query("checks")
      .withIndex("by_run_url", (q) => q.eq("runId", args.runId))
      .collect();
    return { run, checks };
  },
});

/**
 * Begin a run, idempotently. Convex mutations are transactions, so the
 * check-then-insert below cannot race: a second trigger with the same runKey
 * always sees the first insert and returns it instead of creating a run.
 */
export const start = mutation({
  args: {
    runKey: v.string(),
    trigger,
    urlsTotal: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_runKey", (q) => q.eq("runKey", args.runKey))
      .unique();
    if (existing) {
      return { runId: existing._id, created: false as const };
    }
    const runId = await ctx.db.insert("runs", {
      runKey: args.runKey,
      trigger: args.trigger,
      status: "running",
      startedAt: Date.now(),
      urlsTotal: args.urlsTotal,
      urlsCompleted: 0,
      changesCount: 0,
    });
    return { runId, created: true as const };
  },
});

/**
 * Finalize a run. Only a "running" run can be finalized (a late duplicate
 * finish is a no-op), and the checkpoint advances only on success — a failed
 * run can never become the diff baseline. Both happen in one transaction, so
 * "run succeeded" and "checkpoint advanced" are never observable apart.
 */
export const finish = mutation({
  args: {
    runId: v.id("runs"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return;

    const finishedAt = Date.now();
    await ctx.db.patch(args.runId, {
      status: args.status,
      finishedAt,
      error: args.error,
    });
    if (args.status === "succeeded") {
      const state = await ensureAgentState(ctx);
      await ctx.db.patch(state._id, {
        lastSuccessfulRunId: args.runId,
        lastSuccessfulAt: finishedAt,
      });
    }
  },
});

/**
 * Per-URL results of the last successful run — the baseline new results are
 * diffed against. Failed runs never appear here because the checkpoint only
 * advances in `finish` on success.
 */
export const baseline = query({
  args: {},
  handler: async (ctx) => {
    const state = await getAgentState(ctx);
    if (!state?.lastSuccessfulRunId) return [];
    const checks = await ctx.db
      .query("checks")
      .withIndex("by_run_url", (q) =>
        q.eq("runId", state.lastSuccessfulRunId!),
      )
      .collect();
    return checks.map((c) => ({
      url: c.url,
      ok: c.ok,
      statusCode: c.statusCode,
    }));
  },
});

/**
 * Recovery sweep: any run still "running" after staleAfterMs crashed without
 * finalizing (worker eviction, network loss). Mark it failed so history is
 * honest and nothing waits on a phantom run. Its partial checks remain —
 * they are real results — but it can never become the baseline.
 */
export const recoverStale = mutation({
  args: { staleAfterMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - (args.staleAfterMs ?? 10 * 60 * 1000);
    const recent = await ctx.db
      .query("runs")
      .withIndex("by_startedAt")
      .order("desc")
      .take(50);
    let recovered = 0;
    for (const run of recent) {
      if (run.status === "running" && run.startedAt < cutoff) {
        await ctx.db.patch(run._id, {
          status: "failed",
          finishedAt: Date.now(),
          error: "crashed mid-run; marked failed by recovery sweep",
        });
        recovered += 1;
      }
    }
    return recovered;
  },
});
