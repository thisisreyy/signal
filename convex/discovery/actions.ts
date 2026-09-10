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
  aggregateDomains,
  buildGroundTruth,
  COMPETITORS_TOOL_SCHEMA,
  competitorsPrompt,
  DEFAULT_TOP_COMPETITORS,
  excludedCategory,
  MAX_DOMAINS_TO_CLASSIFY,
  rankCompetitors,
  SEARCH_CACHE_MS,
  SEARCH_PACING_MS,
  toSerpDomains,
  validateKeywords,
  validateProfile,
  RECOMMENDATIONS_TOOL_SCHEMA,
  recommendationsPrompt,
  validateClassifications,
  validateRecommendations,
  validateVerdicts,
  verifyGrounding,
  VERDICTS_TOOL_SCHEMA,
  verdictsPrompt,
  type SerpDomain,
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
      } else if (step.kind === "VALIDATE_BATCH") {
        await doValidateBatch(ctx, run, step);
      } else if (step.kind === "EXTRACT_COMPETITORS") {
        await doExtractCompetitors(ctx, run, step);
      } else if (step.kind === "RECOMMEND") {
        await doRecommend(ctx, run, step);
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
    // Only a SUCCESSFUL call is authoritative. Reusing a cached failure would
    // make one transient timeout permanent for the life of the run — and
    // since fetchPage turns every error into {ok:false}, that could fail a
    // run outright on a site that is actually fine.
    if (cached?.ok) {
      pages.push({ url, ok: true, chars: cached.response?.text?.length ?? 0 });
      continue; // healed retry: the call already succeeded, don't re-pay
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
  // Same rule as fetches: never reuse a failed call. A response with no tool
  // block records ok:false, and reusing it would make both the original call
  // and its corrective retry return the same null — guaranteeing a terminal
  // failure that no retry could ever recover from.
  if (cached?.ok) return cached.response;

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

// ---------- VALIDATE_BATCH ----------

/**
 * Validate one small batch of candidate keywords against real search results.
 *
 * Sequential by design: the provider allows 5 queries/second, and firing a
 * step per keyword would breach that, make every action contend on the same
 * run document, and cost one LLM call per keyword instead of one per batch.
 *
 * Failure policy mirrors the daily tracker: a single keyword that cannot be
 * searched or classified is recorded as errored DATA and the batch carries
 * on. Only a batch where nothing at all succeeded is a step failure.
 */
async function doValidateBatch(
  ctx: ActionCtx,
  run: Doc<"discoveryRuns">,
  step: Doc<"discoverySteps">,
) {
  const profile = await ctx.runQuery(internal.discovery.index.getProfileForRun, {
    discoveryId: run._id,
  });
  if (!profile) throw terminal("no business profile exists for this run");

  const batch = await ctx.runQuery(internal.discovery.index.getValidationBatch, {
    discoveryId: run._id,
  });
  if (batch.length === 0) {
    // Nothing left to do (a healed retry after the batch already landed).
    await ctx.runMutation(internal.discovery.index.completeValidationBatch, {
      stepId: step._id,
      results: [],
    });
    return;
  }

  const apiKey = env.SERPER_API_KEY;
  if (!apiKey) throw terminal("SERPER_API_KEY is not set in the Convex deployment", 401);

  type Searched = { keyword: string; domains: SerpDomain[]; error?: string };
  const searched: Searched[] = [];

  maybeInjectCrash(run, step, "before-ledger");
  for (const [index, keyword] of batch.entries()) {
    // Searches are keyed by CONTENT ONLY, not by run — two businesses sharing
    // a keyword, or a re-run of the same discovery, reuse the same result for
    // 24 hours instead of paying twice.
    const key = callKey("serper", keyword);
    const cached = await ctx.runQuery(internal.discovery.index.getExternalCall, {
      callKey: key,
      maxAgeMs: SEARCH_CACHE_MS,
      now: Date.now(),
    });
    if (cached?.ok) {
      searched.push({ keyword, domains: (cached.response?.domains ?? []) as SerpDomain[] });
      continue;
    }

    if (index > 0) await sleep(SEARCH_PACING_MS); // stay under 5 queries/sec
    try {
      const domains = await serperSearch(keyword, apiKey);
      await ctx.runMutation(internal.discovery.index.recordExternalCall, {
        callKey: key,
        kind: "serper",
        discoveryId: run._id,
        request: `search "${keyword}"`,
        response: { domains },
        ok: true,
      });
      searched.push({ keyword, domains });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { httpStatus?: number }).httpStatus;
      // A dead or unauthorized key is not a per-keyword problem — stop now.
      if (status === 401 || status === 403) throw error;
      // First attempt: let a transient failure retry the whole batch (already
      // cached searches are not re-paid). By the second attempt, stop letting
      // one bad keyword hold up the rest.
      if (step.attempts < 2 && classifyError(message, status) === "retryable") throw error;
      searched.push({ keyword, domains: [], error: message.slice(0, 200) });
    }
  }
  maybeInjectCrash(run, step, "after-ledger");

  const searchable = searched.filter((s) => !s.error);
  if (searchable.length === 0) {
    throw new Error(`every search in the batch failed: ${searched[0]?.error ?? "unknown"}`);
  }

  // ONE classification call for the whole batch — this is what keeps the
  // per-run LLM cost proportional to batches, not keywords.
  const prompt = verdictsPrompt(profile, searchable);
  let parsed = validateVerdicts(
    await llmToolCall(ctx, run, {
      keyContent: `${run._id}:verdicts:${contentHash(prompt)}`,
      prompt,
      tool: VERDICTS_TOOL_SCHEMA,
      maxTokens: 2000,
    }),
  );
  if (!parsed.ok) {
    const fixPrompt = `${prompt}\n\nYour previous output was rejected: ${parsed.reason}. Emit the verdicts again, following the schema exactly.`;
    parsed = validateVerdicts(
      await llmToolCall(ctx, run, {
        keyContent: `${run._id}:verdicts-fix:${contentHash(fixPrompt)}`,
        prompt: fixPrompt,
        tool: VERDICTS_TOOL_SCHEMA,
        maxTokens: 2000,
      }),
    );
  }

  const byKeyword = new Map(parsed.ok ? parsed.verdicts.map((v) => [v.keyword, v]) : []);
  const results = searched.map((s) => {
    if (s.error) {
      return {
        keyword: s.keyword,
        status: "error" as const,
        reasoning: "The search for this keyword could not be completed.",
        error: s.error,
        topDomains: [],
      };
    }
    const verdict = byKeyword.get(s.keyword);
    if (!verdict) {
      // Uncovered by the classifier: recorded as errored so the batch always
      // makes progress instead of looping on the same keyword forever.
      return {
        keyword: s.keyword,
        status: "error" as const,
        reasoning: "The classifier returned no verdict for this keyword.",
        error: parsed.ok ? "missing verdict" : parsed.reason,
        topDomains: s.domains,
      };
    }
    return {
      keyword: s.keyword,
      status: verdict.verdict,
      reasoning: verdict.reasoning,
      confidence: verdict.confidence,
      topDomains: s.domains,
    };
  });

  await ctx.runMutation(internal.discovery.index.completeValidationBatch, {
    stepId: step._id,
    results,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One real Google search via Serper, trimmed to the evidence we keep. */
async function serperSearch(keyword: string, apiKey: string): Promise<SerpDomain[]> {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: keyword, num: 20, gl: "us", hl: "en" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const err = new Error(`Serper ${response.status}: ${body.slice(0, 150)}`);
    (err as { httpStatus?: number }).httpStatus = response.status;
    throw err;
  }
  const json = (await response.json()) as {
    organic?: { position?: number; link?: string; title?: string }[];
  };
  return toSerpDomains(json.organic ?? []);
}

// ---------- EXTRACT_COMPETITORS ----------

/** Exactly the shape completeCompetitorsStep stores. */
interface StoredCompetitor {
  domain: string;
  classification:
    | "competitor" | "adjacent" | "directory" | "forum"
    | "media" | "reference" | "social" | "marketplace" | "other";
  decidedBy: "list" | "llm";
  reasoning: string;
  confidence?: number;
  appearances: number;
  averagePosition: number;
  bestPosition: number;
  score: number;
  evidence: { keyword: string; position: number }[];
  rank?: number;
  selected: boolean;
}

/**
 * Turn the validated keywords' page-one results into a ranked competitor set.
 *
 * Costs ZERO searches: Phase 3 already stored each keyword's ranking domains
 * as the evidence behind its verdict, so this phase is pure aggregation plus
 * a single classification call.
 *
 * Two-stage filtering by design. A hardcoded list removes the domains that
 * are never competition (Reddit, G2, Wikipedia) — unambiguous, free, and more
 * reliable than asking a model. Only the remainder, where the answer genuinely
 * depends on what the company sells, costs an LLM call.
 */
async function doExtractCompetitors(
  ctx: ActionCtx,
  run: Doc<"discoveryRuns">,
  step: Doc<"discoverySteps">,
) {
  const profile = await ctx.runQuery(internal.discovery.index.getProfileForRun, {
    discoveryId: run._id,
  });
  if (!profile) throw terminal("no business profile exists for this run");

  const validated = await ctx.runQuery(internal.discovery.index.getValidatedEvidence, {
    discoveryId: run._id,
  });
  if (validated.length === 0) {
    throw terminal("no validated keywords produced any ranking evidence");
  }

  const businessDomain = new URL(run.url).hostname;
  const all = aggregateDomains(validated, businessDomain);

  // Stage 1: the hardcoded list.
  const excluded: StoredCompetitor[] = [];
  const needsClassifying: typeof all = [];
  for (const stats of all) {
    const category = excludedCategory(stats.domain);
    if (category) {
      excluded.push({
        ...stats,
        classification: category as StoredCompetitor["classification"],
        decidedBy: "list",
        reasoning: `Known ${category} domain, excluded before classification.`,
        selected: false,
      });
    } else {
      needsClassifying.push(stats);
    }
  }

  // Stage 2: the model, on the remainder only, in one call.
  const shortlist = needsClassifying.slice(0, MAX_DOMAINS_TO_CLASSIFY);
  const prompt = competitorsPrompt(profile, shortlist);

  maybeInjectCrash(run, step, "before-ledger");
  let parsed = validateClassifications(
    await llmToolCall(ctx, run, {
      keyContent: `${run._id}:competitors:${contentHash(prompt)}`,
      prompt,
      tool: COMPETITORS_TOOL_SCHEMA,
      maxTokens: 3000,
    }),
  );
  maybeInjectCrash(run, step, "after-ledger");

  if (!parsed.ok) {
    const fixPrompt = `${prompt}\n\nYour previous output was rejected: ${parsed.reason}. Emit the classifications again, following the schema exactly.`;
    parsed = validateClassifications(
      await llmToolCall(ctx, run, {
        keyContent: `${run._id}:competitors-fix:${contentHash(fixPrompt)}`,
        prompt: fixPrompt,
        tool: COMPETITORS_TOOL_SCHEMA,
        maxTokens: 3000,
      }),
    );
  }
  if (!parsed.ok) {
    throw terminal(`classifier produced malformed output twice: ${parsed.reason}`);
  }

  const byDomain = new Map(parsed.classifications.map((c) => [c.domain, c]));
  const classified = shortlist.map((stats) => {
    const verdict = byDomain.get(stats.domain);
    return {
      ...stats,
      // Unclassified domains default to "other", never to "competitor":
      // an unsupported competitor claim is exactly what must not ship.
      classification: verdict?.classification ?? ("other" as const),
      decidedBy: "llm" as const,
      reasoning: verdict?.reasoning ?? "The classifier returned no verdict for this domain.",
      confidence: verdict?.confidence,
      selected: false,
    };
  });

  const ranked = rankCompetitors(classified, run.topCompetitors ?? DEFAULT_TOP_COMPETITORS);
  const rankedByDomain = new Map(ranked.map((r) => [r.domain, r]));

  const toStore: StoredCompetitor[] = [
    ...classified.map((c) => {
      const r = rankedByDomain.get(c.domain);
      return { ...c, rank: r?.rank, selected: r?.selected ?? false };
    }),
    ...excluded,
  ];

  await ctx.runMutation(internal.discovery.index.completeCompetitorsStep, {
    stepId: step._id,
    domains: toStore,
  });
}

// ---------- RECOMMEND ----------

/** Exactly the shape completeRecommendStep accepts. */
interface GroundedRecommendation {
  action: string;
  rationale: string;
  evidence: {
    type: "ranking";
    keyword: string;
    ourRank?: number;
    competitor?: string;
    theirRank?: number;
    candidateId?: Doc<"keywordCandidates">["_id"];
  }[];
  expectedOutcome: {
    keyword: string;
    currentRank?: number;
    predictedRank: number;
    timeframeDays: number;
  };
  confidence: number;
  fallback: string;
}

/**
 * Generate recommendations, then refuse to store any that cannot be backed by
 * stored ranking data.
 *
 * The model is handed the ranking facts and asked to cite them verbatim; every
 * citation is then re-checked against the same records before anything is
 * written. Structural validity is not grounding — a well-formed recommendation
 * claiming a position nobody observed is exactly the failure this gate exists
 * to catch, and it is discarded rather than shown.
 */
async function doRecommend(ctx: ActionCtx, run: Doc<"discoveryRuns">, step: Doc<"discoverySteps">) {
  const profile = await ctx.runQuery(internal.discovery.index.getProfileForRun, {
    discoveryId: run._id,
  });
  if (!profile) throw terminal("no business profile exists for this run");

  const { validated, competitorDomains } = await ctx.runQuery(
    internal.discovery.index.getRecommendationInputs,
    { discoveryId: run._id },
  );
  if (validated.length === 0) {
    throw terminal("no validated keywords to recommend against");
  }

  const truth = buildGroundTruth(validated, run.url, competitorDomains);
  const candidateIdByKeyword = new Map(validated.map((v) => [v.keyword, v.candidateId]));
  const prompt = recommendationsPrompt(profile, truth);

  maybeInjectCrash(run, step, "before-ledger");
  let parsed = validateRecommendations(
    await llmToolCall(ctx, run, {
      keyContent: `${run._id}:recommend:${contentHash(prompt)}`,
      prompt,
      tool: RECOMMENDATIONS_TOOL_SCHEMA,
      maxTokens: 4000,
    }),
  );
  maybeInjectCrash(run, step, "after-ledger");

  if (!parsed.ok) {
    const fixPrompt = `${prompt}\n\nYour previous output was rejected: ${parsed.reason}. Emit the recommendations again, following the schema exactly.`;
    parsed = validateRecommendations(
      await llmToolCall(ctx, run, {
        keyContent: `${run._id}:recommend-fix:${contentHash(fixPrompt)}`,
        prompt: fixPrompt,
        tool: RECOMMENDATIONS_TOOL_SCHEMA,
        maxTokens: 4000,
      }),
    );
  }
  if (!parsed.ok) {
    throw terminal(`recommendation output malformed twice: ${parsed.reason}`);
  }

  // The grounding gate. Anything that fails it never reaches the database.
  const grounded: GroundedRecommendation[] = [];
  let rejected = 0;

  for (const rec of parsed.recommendations) {
    const check = verifyGrounding(rec, truth);
    if (!check.ok) {
      rejected += 1;
      continue;
    }
    grounded.push({
      action: rec.action,
      rationale: rec.rationale,
      evidence: check.evidence.map((e) => ({
        type: "ranking" as const,
        keyword: e.keyword,
        ourRank: e.ourRank,
        competitor: e.competitor,
        theirRank: e.theirRank,
        candidateId: candidateIdByKeyword.get(e.keyword),
      })),
      expectedOutcome: rec.expectedOutcome,
      confidence: rec.confidence,
      fallback: rec.fallback,
    });
  }

  if (grounded.length === 0) {
    throw terminal(
      `every recommendation failed the grounding check (${rejected} rejected)`,
    );
  }

  await ctx.runMutation(internal.discovery.index.completeRecommendStep, {
    stepId: step._id,
    recommendations: grounded,
    rejected,
  });
}
