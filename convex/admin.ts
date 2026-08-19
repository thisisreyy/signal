import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  DEFAULT_BUSINESS,
  DEFAULT_COMPETITORS,
  DEFAULT_KEYWORDS,
  ensureAgentState,
  getAgentState,
  getConfigDoc,
} from "./helpers";

/** Agent state for the dashboard; defaults returned before first write. */
export const state = query({
  args: {},
  handler: async (ctx) => {
    const state = await getAgentState(ctx);
    return {
      paused: state?.paused ?? false,
      lastSuccessfulRunId: state?.lastSuccessfulRunId ?? null,
      lastSuccessfulAt: state?.lastSuccessfulAt ?? null,
    };
  },
});

export const setPaused = mutation({
  args: { paused: v.boolean() },
  handler: async (ctx, args) => {
    const state = await ensureAgentState(ctx);
    await ctx.db.patch(state._id, { paused: args.paused });
  },
});

export const getConfig = query({
  args: {},
  handler: async (ctx) => {
    const config = await getConfigDoc(ctx);
    return {
      business: config?.business ?? DEFAULT_BUSINESS,
      keywords: config?.keywords ?? DEFAULT_KEYWORDS,
      competitors: config?.competitors ?? DEFAULT_COMPETITORS,
      injectFailure: config?.injectFailure ?? false,
    };
  },
});

/** Update any part of the growth config; omitted fields are left alone. */
export const setGrowthConfig = mutation({
  args: {
    business: v.optional(v.object({ name: v.string(), domain: v.string() })),
    keywords: v.optional(v.array(v.string())),
    competitors: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const patch = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    );
    const config = await getConfigDoc(ctx);
    if (config) {
      await ctx.db.patch(config._id, patch);
    } else {
      await ctx.db.insert("config", { key: "singleton", ...patch });
    }
  },
});

export const setInjectFailure = mutation({
  args: { injectFailure: v.boolean() },
  handler: async (ctx, args) => {
    const config = await getConfigDoc(ctx);
    if (config) {
      await ctx.db.patch(config._id, { injectFailure: args.injectFailure });
    } else {
      await ctx.db.insert("config", {
        key: "singleton",
        injectFailure: args.injectFailure,
      });
    }
  },
});

/** Dev/demo reset: wipe all run history (config and state survive). */
export const resetHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["runs", "keywordChecks"] as const) {
      const docs = await ctx.db.query(table).collect();
      for (const doc of docs) await ctx.db.delete(doc._id);
    }
    const state = await getAgentState(ctx);
    if (state) {
      await ctx.db.patch(state._id, {
        lastSuccessfulRunId: undefined,
        lastSuccessfulAt: undefined,
      });
    }
  },
});

