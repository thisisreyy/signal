import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { change } from "./schema";

/**
 * Record one URL's result, upserting on (runId, url) so a re-run of the same
 * run (recovery, double trigger) overwrites rather than duplicates.
 */
export const record = mutation({
  args: {
    runId: v.id("runs"),
    url: v.string(),
    ok: v.boolean(),
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    error: v.optional(v.string()),
    change: v.optional(change),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error(`Run ${args.runId} not found`);

    const { runId, ...result } = args;
    const existing = await ctx.db
      .query("checks")
      .withIndex("by_run_url", (q) => q.eq("runId", runId).eq("url", args.url))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { ...result, checkedAt: Date.now() });
      return existing._id;
    }

    const checkId = await ctx.db.insert("checks", {
      runId,
      ...result,
      checkedAt: Date.now(),
    });
    await ctx.db.patch(runId, {
      itemsCompleted: (run.itemsCompleted ?? 0) + 1,
      changesCount: run.changesCount + (args.change ? 1 : 0),
    });
    return checkId;
  },
});
