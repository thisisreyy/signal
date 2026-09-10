import { defineApp } from "convex/server";
import { v } from "convex/values";

/**
 * Typed deployment environment variables. Declaring them here makes them
 * available as `env.X` from `_generated/server` with real types, instead of
 * reaching for an untyped `process.env`. Values are still set out-of-band
 * (`convex env set ANTHROPIC_API_KEY ...`) and never live in the repo.
 */
export default defineApp({
  env: {
    ANTHROPIC_API_KEY: v.optional(v.string()),
    LLM_MODEL: v.optional(v.string()),
  },
});
