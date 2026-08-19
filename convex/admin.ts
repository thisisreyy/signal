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
    return {
      urls: config?.urls ?? DEFAULT_URLS,
      injectFailure: config?.injectFailure ?? false,
    };
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
        urls: DEFAULT_URLS,
        injectFailure: args.injectFailure,
      });
    }
  },
});

/**
 * One entry per watched site: its latest result plus recent history, powering
 * the dashboard's site cards.
 */
export const sites = query({
  args: {},
  handler: async (ctx) => {
    const config = await getConfigDoc(ctx);
    const urls = config?.urls ?? DEFAULT_URLS;
    return await Promise.all(
      urls.map(async (url) => {
        const recent = await ctx.db
          .query("checks")
          .withIndex("by_url", (q) => q.eq("url", url))
          .order("desc")
          .take(24);
        const latest = recent[0] ?? null;
        const okCount = recent.filter((c) => c.ok).length;
        return {
          url,
          latest: latest && {
            ok: latest.ok,
            statusCode: latest.statusCode,
            latencyMs: latest.latencyMs,
            error: latest.error,
            checkedAt: latest.checkedAt,
          },
          history: recent
            .slice()
            .reverse()
            .map((c) => ({
              ok: c.ok,
              latencyMs: c.latencyMs ?? 0,
              checkedAt: c.checkedAt,
            })),
          uptimePct:
            recent.length > 0 ? Math.round((okCount / recent.length) * 100) : null,
        };
      }),
    );
  },
});

export const addUrl = mutation({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const url = args.url.trim();
    if (!/^https?:\/\/.+\..+/.test(url)) {
      throw new Error("Enter a full address like https://example.com");
    }
    const config = await getConfigDoc(ctx);
    const urls = config?.urls ?? DEFAULT_URLS;
    if (urls.includes(url)) return;
    if (config) {
      await ctx.db.patch(config._id, { urls: [...urls, url] });
    } else {
      await ctx.db.insert("config", { key: "singleton", urls: [...urls, url] });
    }
  },
});

export const removeUrl = mutation({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const config = await getConfigDoc(ctx);
    const urls = config?.urls ?? DEFAULT_URLS;
    const next = urls.filter((u) => u !== args.url);
    if (config) {
      await ctx.db.patch(config._id, { urls: next });
    } else {
      await ctx.db.insert("config", { key: "singleton", urls: next });
    }
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
