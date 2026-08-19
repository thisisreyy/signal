import type { MutationCtx, QueryCtx } from "./_generated/server";

// Demo growth config — a real business with real, competitive SERPs, so the
// agent produces meaningful data before the user customizes anything.
export const DEFAULT_BUSINESS = { name: "Anthropic", domain: "anthropic.com" };
export const DEFAULT_KEYWORDS = ["ai assistant", "llm api", "ai coding agent"];
export const DEFAULT_COMPETITORS = ["openai.com", "google.com", "mistral.ai"];

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
