import type { MutationCtx, QueryCtx } from "./_generated/server";

// Demo growth config — chosen so tracked domains genuinely appear in these
// keywords' results, giving meaningful data before the user customizes it.
export const DEFAULT_BUSINESS = { name: "Claude", domain: "claude.ai" };
export const DEFAULT_KEYWORDS = ["claude ai", "gpt 4 alternative", "ai coding agent"];
export const DEFAULT_COMPETITORS = ["openai.com", "cursor.com", "google.com"];

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
