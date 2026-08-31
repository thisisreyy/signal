import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { domainPosition, rankChange } from "./schema";

/**
 * Record one keyword's ranking results, upserting on (runId, keyword) so a
 * re-record (defensive; duplicate runs are already skipped) never duplicates.
 * Same durable per-item pattern as the original URL checks.
 */
export const record = mutation({
  args: {
    runId: v.id("runs"),
    keyword: v.string(),
    error: v.optional(v.string()),
    positions: v.array(domainPosition),
    changes: v.array(rankChange),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error(`Run ${args.runId} not found`);

    const { runId, ...result } = args;
    const existing = await ctx.db
      .query("keywordChecks")
      .withIndex("by_run_keyword", (q) =>
        q.eq("runId", runId).eq("keyword", args.keyword),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { ...result, checkedAt: Date.now() });
      return existing._id;
    }

    const id = await ctx.db.insert("keywordChecks", {
      runId,
      ...result,
      checkedAt: Date.now(),
    });
    await ctx.db.patch(runId, {
      itemsCompleted: (run.itemsCompleted ?? 0) + 1,
      changesCount: run.changesCount + args.changes.length,
    });
    return id;
  },
});

/** All keyword results for one run, for the run-detail view. */
export const byRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("keywordChecks")
      .withIndex("by_run_keyword", (q) => q.eq("runId", args.runId))
      .collect();
  },
});

/**
 * The signals feed: every detected change from recent finished runs, newest
 * first, tagged with the business that was being tracked at the time — the
 * row's positions record which domain was "the business" when it was written,
 * so past eras (a previously tracked business) group correctly with no
 * migration.
 */
export const signals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const recentRuns = await ctx.db
      .query("runs")
      .withIndex("by_startedAt")
      .order("desc")
      .take(100);
    const signals: {
      at: number;
      runId: string;
      keyword: string;
      business: string;
      change: (typeof rankChange)["type"];
    }[] = [];
    for (const run of recentRuns) {
      if (run.changesCount === 0) continue;
      const rows = await ctx.db
        .query("keywordChecks")
        .withIndex("by_run_keyword", (q) => q.eq("runId", run._id))
        .collect();
      for (const row of rows) {
        const business = row.positions.find((p) => p.isBusiness)?.domain;
        if (!business) continue;
        for (const change of row.changes) {
          signals.push({
            at: row.checkedAt,
            runId: run._id,
            keyword: row.keyword,
            business,
            change,
          });
        }
      }
    }
    signals.sort((a, b) => b.at - a.at);
    return signals.slice(0, args.limit ?? 100);
  },
});

/** Recent history for one keyword, oldest first — the ranking timeline. */
export const history = query({
  args: { keyword: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query("keywordChecks")
      .withIndex("by_keyword", (q) => q.eq("keyword", args.keyword))
      .order("desc")
      .take(args.limit ?? 30);
    return recent.reverse();
  },
});
