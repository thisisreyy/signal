import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  DEFAULT_URLS,
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
    return { urls: config?.urls ?? DEFAULT_URLS };
  },
});

export const setUrls = mutation({
  args: { urls: v.array(v.string()) },
  handler: async (ctx, args) => {
    const config = await getConfigDoc(ctx);
    if (config) {
      await ctx.db.patch(config._id, { urls: args.urls });
    } else {
      await ctx.db.insert("config", { key: "singleton", urls: args.urls });
    }
  },
});
