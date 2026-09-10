import { v } from "convex/values";
import { env, internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  callKey,
  classifyError,
  contentHash,
  htmlToText,
  KEYWORDS_TOOL_SCHEMA,
  keywordsPrompt,
  MAX_PAGE_BYTES,
  pagesToFetch,
  PROFILE_TOOL_SCHEMA,
  profilePrompt,
  validateKeywords,
  validateProfile,
} from "./logic";

/**
 * Actions are NOT transactional — this file treats every external call as
 * "may have happened even if we crashed". The rules it lives by:
 *   - never touch the outside world before claimStep succeeds
 *   - ledger-check (getExternalCall) before every call; the derived callKey
 *     makes a healed retry reuse the recorded response instead of re-paying
 *   - record every response via recordExternalCall the moment it returns
 *   - all state advancement happens in mutations, never here
 */

export const runStep = internalAction({
  args: { stepId: v.id("discoverySteps") },
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(internal.discovery.index.claimStep, {
      stepId: args.stepId,
    });
    if (!claimed) return; // already claimed, done, or run is terminal
    const { step, run } = claimed;

    try {
      if (step.kind === "FETCH_PAGES") {
        await doFetchPages(ctx, run, step);
      } else if (step.kind === "PROFILE") {
        await doProfile(ctx, run, step);
      } else if (step.kind === "GENERATE_KEYWORDS") {
        await doGenerateKeywords(ctx, run, step);
      } else {
        throw new Error(`unknown step kind ${step.kind}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { httpStatus?: number }).httpStatus;
      await ctx.runMutation(internal.discovery.index.failStep, {
        stepId: step._id,
        error: message.slice(0, 500),
        errorClass: classifyError(message, status),
      });
    }
  },
});

/** Crash simulation: fires on attempt 1 only, so the retry demonstrates healing. */
function maybeInjectCrash(
  run: Doc<"discoveryRuns">,
  step: Doc<"discoverySteps">,
  where: "before-ledger" | "after-ledger",
) {
  if (run.injectCrash?.step === step.kind && run.injectCrash.where === where && step.attempts === 1) {
    throw new Error(`injected crash (${step.kind}, ${where})`);
  }
}

/** Attach an HTTP status so classifyError can call it terminal. */
function terminal(message: string, status = 422): Error {
  const err = new Error(message);
  (err as { httpStatus?: number }).httpStatus = status;
  return err;
}

// ---------- FETCH_PAGES ----------

async function doFetchPages(
  ctx: ActionCtx,
  run: Doc<"discoveryRuns">,
  step: Doc<"discoverySteps">,
) {
  const pages: { url: string; ok: boolean; chars: number }[] = [];

  for (const [index, url] of pagesToFetch(run.url).entries()) {
    const key = callKey("fetch", `${run._id}:${url}`);
    const cached = await ctx.runQuery(internal.discovery.index.getExternalCall, { callKey: key });
    if (cached) {
      pages.push({ url, ok: cached.ok, chars: cached.response?.text?.length ?? 0 });
      continue; // healed retry: the call already happened, don't re-pay
    }

    if (index === 0) maybeInjectCrash(run, step, "before-ledger");
    const result = await fetchPage(url);
    await ctx.runMutation(internal.discovery.index.recordExternalCall, {
      callKey: key,
      kind: "fetch",
      discoveryId: run._id,
      request: `GET ${url}`,
      response: result,
      ok: result.ok,
    });
    if (index === 0) maybeInjectCrash(run, step, "after-ledger");
    pages.push({ url, ok: result.ok, chars: result.text.length });
  }

  await ctx.runMutation(internal.discovery.index.completeFetchStep, {
    stepId: step._id,
    pages,
  });
}

async function fetchPage(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { Accept: "text/html", "User-Agent": "SignalDiscovery/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const raw = (await response.text()).slice(0, MAX_PAGE_BYTES);
    return { ok: response.ok, status: response.status, text: htmlToText(raw) };
  } catch {
    // A page that doesn't exist (/pricing on a site without one) is data,
    // not a step failure — record it and move on.
    return { ok: false, status: 0, text: "" };
  }
}

// ---------- PROFILE ----------

async function doProfile(ctx: ActionCtx, run: Doc<"discoveryRuns">, step: Doc<"discoverySteps">) {
  // Page texts come from the ledger — written by FETCH_PAGES, never refetched.
  const pages: { url: string; ok: boolean; text: string }[] = [];
  for (const url of pagesToFetch(run.url)) {
    const cached = await ctx.runQuery(internal.discovery.index.getExternalCall, {
      callKey: callKey("fetch", `${run._id}:${url}`),
    });
    pages.push({ url, ok: cached?.ok ?? false, text: cached?.response?.text ?? "" });
  }
  if (!pages.some((p) => p.ok && p.text.length > 0)) {
    throw terminal("no page content could be fetched from the site");
  }

  const prompt = profilePrompt(run.url, pages.map((p) => ({ url: p.url, text: p.text })));

  maybeInjectCrash(run, step, "before-ledger");
  const payload = await llmToolCall(ctx, run, {
    keyContent: `${run._id}:profile:${contentHash(prompt)}`,
    prompt,
    tool: PROFILE_TOOL_SCHEMA,
    maxTokens: 1200,
  });
  maybeInjectCrash(run, step, "after-ledger");

  let validated = validateProfile(payload);
  if (!validated.ok) {
    // One corrective retry with the validation error, then fail cleanly.
    const fixPrompt = `${prompt}\n\nYour previous output was rejected: ${validated.reason}. Emit the profile again, following the schema exactly.`;
    const retry = await llmToolCall(ctx, run, {
      keyContent: `${run._id}:profile-fix:${contentHash(fixPrompt)}`,
      prompt: fixPrompt,
      tool: PROFILE_TOOL_SCHEMA,
      maxTokens: 1200,
    });
    validated = validateProfile(retry);
  }
  if (!validated.ok) {
    throw terminal(`LLM produced malformed profile twice: ${validated.reason}`);
  }

  await ctx.runMutation(internal.discovery.index.completeProfileStep, {
    stepId: step._id,
    profile: validated.profile,
    pagesFetched: pages.map((p) => ({ url: p.url, ok: p.ok, chars: p.text.length })),
  });
}

// ---------- GENERATE_KEYWORDS ----------

async function doGenerateKeywords(
  ctx: ActionCtx,
  run: Doc<"discoveryRuns">,
  step: Doc<"discoverySteps">,
) {
  const profile = await ctx.runQuery(internal.discovery.index.getProfileForRun, {
    discoveryId: run._id,
  });
  if (!profile) {
    // Structurally impossible via the normal path (completeProfileStep writes
    // the profile and creates this step in one transaction), so if it happens
    // the pipeline is wrong, not the provider — terminal, not retryable.
    throw terminal("no business profile exists for this run");
  }

  const prompt = keywordsPrompt(run.url, profile);

  maybeInjectCrash(run, step, "before-ledger");
  const payload = await llmToolCall(ctx, run, {
    keyContent: `${run._id}:keywords:${contentHash(prompt)}`,
    prompt,
    tool: KEYWORDS_TOOL_SCHEMA,
    maxTokens: 3000,
  });
  maybeInjectCrash(run, step, "after-ledger");

  let validated = validateKeywords(payload);
  if (!validated.ok) {
    const fixPrompt = `${prompt}\n\nYour previous output was rejected: ${validated.reason}. Emit the keyword list again, following the schema and the required mix exactly.`;
    const retry = await llmToolCall(ctx, run, {
      keyContent: `${run._id}:keywords-fix:${contentHash(fixPrompt)}`,
      prompt: fixPrompt,
      tool: KEYWORDS_TOOL_SCHEMA,
      maxTokens: 3000,
    });
    validated = validateKeywords(retry);
  }
  if (!validated.ok) {
    throw terminal(`LLM produced malformed keywords twice: ${validated.reason}`);
  }

  await ctx.runMutation(internal.discovery.index.completeKeywordsStep, {
    stepId: step._id,
    keywords: validated.keywords,
  });
}

// ---------- The one LLM entry point ----------

/** One ledger-cached, schema-forced tool call. Returns the tool payload. */
async function llmToolCall(
  ctx: ActionCtx,
  run: Doc<"discoveryRuns">,
  opts: { keyContent: string; prompt: string; tool: unknown; maxTokens: number },
): Promise<unknown> {
  const key = callKey("llm", opts.keyContent);
  const cached = await ctx.runQuery(internal.discovery.index.getExternalCall, { callKey: key });
  if (cached) return cached.response;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw terminal("ANTHROPIC_API_KEY is not set in the Convex deployment", 401);
  }
  const model = env.LLM_MODEL ?? "claude-haiku-4-5";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens,
      tools: [opts.tool],
      tool_choice: { type: "tool", name: (opts.tool as { name: string }).name },
      messages: [{ role: "user", content: opts.prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Never log or surface the key; only status and provider message.
    const err = new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
    (err as { httpStatus?: number }).httpStatus = response.status;
    throw err;
  }
  const json = (await response.json()) as { content?: { type: string; input?: unknown }[] };
  const tool = json.content?.find((block) => block.type === "tool_use");
  const payload = tool?.input ?? null;

  await ctx.runMutation(internal.discovery.index.recordExternalCall, {
    callKey: key,
    kind: "llm",
    discoveryId: run._id,
    request: `messages ${model} (${opts.prompt.length} chars)`,
    response: payload,
    ok: payload !== null,
  });
  return payload;
}
