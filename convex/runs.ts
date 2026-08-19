import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { runStatus, trigger } from "./schema";

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

/** Finalize a run. Checkpoint advancement is wired in here in Phase 3. */
export const finish = mutation({
  args: {
    runId: v.id("runs"),
    status: runStatus,
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
      finishedAt: Date.now(),
      error: args.error,
    });
  },
});
