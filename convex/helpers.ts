import type { MutationCtx, QueryCtx } from "./_generated/server";

export const DEFAULT_URLS = [
  "https://example.com",
  "https://www.anthropic.com",
  "https://httpstat.us/200",
];

export async function getAgentState(ctx: QueryCtx) {
  return await ctx.db
    .query("agentState")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .unique();
}

export async function getConfigDoc(ctx: QueryCtx) {
  return await ctx.db
    .query("config")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .unique();
}

/** Ensure the singleton state row exists and return it. */
export async function ensureAgentState(ctx: MutationCtx) {
  const existing = await getAgentState(ctx);
  if (existing) return existing;
  const id = await ctx.db.insert("agentState", {
    key: "singleton",
    paused: false,
  });
  return (await ctx.db.get(id))!;
}
