/**
 * Pure discovery-pipeline logic: no ctx, no network, fully unit-testable.
 * Everything here is deterministic — the actions layer is thin glue around it.
 */

// ---------- State machine ----------

export const DISCOVERY_STATES = [
  "PROFILING",
  "GENERATING_KEYWORDS",
  "VALIDATING",
  "EXTRACTING_COMPETITORS",
  "RECOMMENDING",
  "COMPLETE",
  "FAILED",
] as const;
export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

/**
 * How far the pipeline is implemented. A run parked at the frontier is
 * "awaiting the next phase of the build", not stuck — the sweep leaves it
 * alone and the UI can say so honestly.
 */
export const IMPLEMENTED_FRONTIER: DiscoveryState = "EXTRACTING_COMPETITORS";

export const STEP_KINDS = [
  "FETCH_PAGES",
  "PROFILE",
  "GENERATE_KEYWORDS",
  "VALIDATE_BATCH",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Which steps a state is made of, in order. Resumption reads this rather than
 * a pile of booleans: given the state and which steps already finished, the
 * next unit of work is derivable, so a crashed or parked run can always be
 * restarted from exactly where it stopped.
 */
export const STEPS_FOR_STATE: Record<DiscoveryState, readonly StepKind[]> = {
  PROFILING: ["FETCH_PAGES", "PROFILE"],
  GENERATING_KEYWORDS: ["GENERATE_KEYWORDS"],
  VALIDATING: [], // data-driven: see nextValidationBatch / ensureValidationStep
  EXTRACTING_COMPETITORS: [], // Phase 4
  RECOMMENDING: [], // Phase 5
  COMPLETE: [],
  FAILED: [],
};

/** The first step of this state that has not finished, or null if none remain. */
export function nextStepKind(
  state: DiscoveryState,
  doneKinds: readonly string[],
): StepKind | null {
  for (const kind of STEPS_FOR_STATE[state] ?? []) {
    if (!doneKinds.includes(kind)) return kind;
  }
  return null;
}

// ---------- Idempotency keys (derived, never random) ----------

/** FNV-1a — stable content hash for keys; not cryptographic, doesn't need to be. */
export function contentHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Step identity = which run + which step + what input. A retry reuses it. */
export function stepKey(discoveryId: string, kind: StepKind, input: string): string {
  return `${discoveryId}:${kind}:${contentHash(input)}`;
}

/** External-call identity: same request content → same key → cached result. */
export function callKey(kind: "fetch" | "llm" | "serper", requestContent: string): string {
  return `${kind}:${contentHash(requestContent)}`;
}

// ---------- Error classification & backoff ----------

export type ErrorClass = "retryable" | "terminal";

export function classifyError(message: string, httpStatus?: number): ErrorClass {
  if (httpStatus !== undefined) {
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return "retryable";
    return "terminal"; // 4xx: bad request/auth/validation — retrying can't help
  }
  const m = message.toLowerCase();
  if (
    m.includes("injected crash") || // crash simulation heals via the retry path
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("network") ||
    m.includes("econnreset") ||
    m.includes("fetch failed") ||
    m.includes("overloaded")
  ) {
    return "retryable";
  }
  return "terminal";
}

export const MAX_ATTEMPTS = 4;
export const BACKOFF_BASE_MS = 5_000;

/** Exponential backoff with full jitter, capped at 5 minutes. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
  return Math.floor(exp / 2 + random() * (exp / 2));
}

/** A step stuck "running" longer than this crashed mid-flight. */
export const STEP_STALE_MS = 3 * 60_000;

// ---------- Cost caps (per discovery run) ----------

export const MAX_FETCH_CALLS = 8;
/** Phase 3 classifies a whole batch per call, so 23 keywords cost ~6 calls. */
export const MAX_LLM_CALLS = 30;
/** Hard per-run ceiling on paid searches — the cap the requirements demand. */
export const MAX_SEARCH_CALLS = 40;
/** Never validate an unbounded candidate list, whatever the model proposed. */
export const MAX_CANDIDATES_TO_VALIDATE = 30;
/** Consecutive step failures before we stop calling a provider entirely. */
export const CIRCUIT_BREAK_FAILURES = 8;

// ---------- Page fetching plan ----------

/** Small fixed set — never a crawl. */
export function pagesToFetch(baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  return [origin, `${origin}/pricing`, `${origin}/about`, `${origin}/docs`];
}

export const MAX_PAGE_BYTES = 300_000;
export const MAX_PAGE_TEXT_CHARS = 8_000;

/** Crude but dependency-free HTML → text. Good enough for LLM profiling. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PAGE_TEXT_CHARS);
}

// ---------- Business profile: schema + validation ----------

export interface BusinessProfileFields {
  name: string | null;
  what_they_sell: string | null;
  audience: "b2b" | "b2c" | null;
  buyer_type: string | null;
  price_point: string | null;
  business_stage: string | null;
  category: string | null;
  field_confidence: Record<string, number>;
}

export const PROFILE_FIELDS = [
  "name",
  "what_they_sell",
  "audience",
  "buyer_type",
  "price_point",
  "business_stage",
  "category",
] as const;

/** The JSON schema handed to the LLM as a forced tool call. */
export const PROFILE_TOOL_SCHEMA = {
  name: "emit_business_profile",
  description:
    "Emit the structured business profile extracted from the provided website text. Use null for any field the text does not support — never guess.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: ["string", "null"] },
      what_they_sell: { type: ["string", "null"] },
      audience: { type: ["string", "null"], enum: ["b2b", "b2c", null] },
      buyer_type: { type: ["string", "null"] },
      price_point: { type: ["string", "null"] },
      business_stage: { type: ["string", "null"] },
      category: { type: ["string", "null"] },
      field_confidence: {
        type: "object",
        description: "0..1 confidence per field above",
        additionalProperties: { type: "number" },
      },
    },
    required: [...PROFILE_FIELDS, "field_confidence"],
  },
} as const;

/**
 * Validate a raw LLM tool payload into a typed profile, or explain why not.
 * Deliberately strict: this is the "reject malformed output" requirement.
 */
export function validateProfile(
  raw: unknown,
): { ok: true; profile: BusinessProfileFields } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const field of PROFILE_FIELDS) {
    const value = obj[field];
    if (value === undefined) return { ok: false, reason: `missing field ${field}` };
    if (value !== null && typeof value !== "string") {
      return { ok: false, reason: `field ${field} must be string or null` };
    }
  }
  const audience = obj.audience;
  if (audience !== null && audience !== "b2b" && audience !== "b2c") {
    return { ok: false, reason: `audience must be "b2b", "b2c", or null` };
  }
  const conf = obj.field_confidence;
  if (typeof conf !== "object" || conf === null) {
    return { ok: false, reason: "field_confidence missing" };
  }
  const confidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(conf as Record<string, unknown>)) {
    if (typeof v !== "number" || v < 0 || v > 1) {
      return { ok: false, reason: `confidence for ${k} must be a number in 0..1` };
    }
    confidence[k] = v;
  }
  return {
    ok: true,
    profile: {
      name: obj.name as string | null,
      what_they_sell: obj.what_they_sell as string | null,
      audience: audience as "b2b" | "b2c" | null,
      buyer_type: obj.buyer_type as string | null,
      price_point: obj.price_point as string | null,
      business_stage: obj.business_stage as string | null,
      category: obj.category as string | null,
      field_confidence: confidence,
    },
  };
}

export function profilePrompt(url: string, pages: { url: string; text: string }[]): string {
  const sections = pages
    .map((p) => `--- PAGE: ${p.url} ---\n${p.text || "(fetch failed or empty)"}`)
    .join("\n\n");
  return `You are profiling the business behind ${url} using only the page text below.
Extract only what the text supports. If a field cannot be determined from the text, use null — an honest null is more useful than a guess. Give each field a 0..1 confidence in field_confidence (use the field names as keys).

${sections}`;
}

// ---------- Phase 2: keyword candidate generation ----------

export const KEYWORD_KINDS = ["category", "problem", "comparison", "longtail"] as const;
export type KeywordKind = (typeof KEYWORD_KINDS)[number];

export const MIN_KEYWORDS = 15;
export const MAX_KEYWORDS = 25;
/** Dedup can legitimately shave a few; below this the pool isn't a pool. */
export const MIN_UNIQUE_KEYWORDS = 12;
/** A candidate pool of one flavour isn't the mix the phase promises. */
export const MIN_DISTINCT_KINDS = 3;
export const MAX_KEYWORD_CHARS = 80;

export interface KeywordCandidate {
  keyword: string;
  kind: KeywordKind;
  rationale: string;
}

/** Profile shape as stored (camelCase), so the action can pass the doc straight in. */
export interface StoredProfile {
  name: string | null;
  whatTheySell: string | null;
  audience: "b2b" | "b2c" | null;
  buyerType: string | null;
  pricePoint: string | null;
  businessStage: string | null;
  category: string | null;
}

export const KEYWORDS_TOOL_SCHEMA = {
  name: "emit_keyword_candidates",
  description:
    "Emit candidate search queries a potential customer of this business might type into Google. These are hypotheses that will be tested against real search results, so propose breadth across the required kinds.",
  input_schema: {
    type: "object",
    properties: {
      keywords: {
        type: "array",
        minItems: MIN_KEYWORDS,
        maxItems: MAX_KEYWORDS,
        items: {
          type: "object",
          properties: {
            keyword: {
              type: "string",
              description: "The search query itself, lowercase, 2-8 words",
            },
            kind: { type: "string", enum: [...KEYWORD_KINDS] },
            rationale: {
              type: "string",
              description: "One short sentence: why a buyer would search this",
            },
          },
          required: ["keyword", "kind", "rationale"],
        },
      },
    },
    required: ["keywords"],
  },
} as const;

/** Lowercase, collapse whitespace, strip wrapping quotes. */
export function normalizeKeyword(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”']+|["'“”']+$/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Structural gate on the LLM's keyword output. Strict about the contract
 * (count, kinds, shape) because a thin or single-flavour pool silently
 * degrades every phase downstream; lenient about duplicates, which are
 * dropped rather than treated as failure.
 */
export function validateKeywords(
  raw: unknown,
): { ok: true; keywords: KeywordCandidate[] } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const list = (raw as Record<string, unknown>).keywords;
  if (!Array.isArray(list)) return { ok: false, reason: "keywords must be an array" };
  if (list.length < MIN_KEYWORDS) {
    return { ok: false, reason: `expected at least ${MIN_KEYWORDS} keywords, got ${list.length}` };
  }
  if (list.length > MAX_KEYWORDS) {
    return { ok: false, reason: `expected at most ${MAX_KEYWORDS} keywords, got ${list.length}` };
  }

  const seen = new Set<string>();
  const keywords: KeywordCandidate[] = [];
  for (const [i, item] of list.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: `item ${i} is not an object` };
    }
    const o = item as Record<string, unknown>;
    if (typeof o.keyword !== "string") {
      return { ok: false, reason: `item ${i}: keyword must be a string` };
    }
    if (typeof o.rationale !== "string") {
      return { ok: false, reason: `item ${i}: rationale must be a string` };
    }
    if (!KEYWORD_KINDS.includes(o.kind as KeywordKind)) {
      return { ok: false, reason: `item ${i}: kind must be one of ${KEYWORD_KINDS.join(", ")}` };
    }
    const keyword = normalizeKeyword(o.keyword);
    if (keyword.length < 2 || keyword.length > MAX_KEYWORD_CHARS) {
      return { ok: false, reason: `item ${i}: keyword length out of range` };
    }
    if (seen.has(keyword)) continue; // duplicates are noise, not failure
    seen.add(keyword);
    keywords.push({
      keyword,
      kind: o.kind as KeywordKind,
      rationale: o.rationale.trim().slice(0, 300),
    });
  }

  if (keywords.length < MIN_UNIQUE_KEYWORDS) {
    return { ok: false, reason: `only ${keywords.length} unique keywords survived dedup` };
  }
  const distinctKinds = new Set(keywords.map((k) => k.kind)).size;
  if (distinctKinds < MIN_DISTINCT_KINDS) {
    return {
      ok: false,
      reason: `needs a mix: only ${distinctKinds} distinct kind(s) present`,
    };
  }
  return { ok: true, keywords };
}

export function keywordsPrompt(url: string, profile: StoredProfile): string {
  const field = (label: string, value: string | null) =>
    `${label}: ${value ?? "(not determinable from the site — do not invent it)"}`;

  return `You are proposing search queries for the business at ${url}.

BUSINESS PROFILE
${field("Name", profile.name)}
${field("Category", profile.category)}
${field("What they sell", profile.whatTheySell)}
${field("Audience", profile.audience)}
${field("Buyer", profile.buyerType)}
${field("Price point", profile.pricePoint)}
${field("Stage", profile.businessStage)}

Propose ${MIN_KEYWORDS}-${MAX_KEYWORDS} queries a potential CUSTOMER would realistically type into Google while looking for a solution of this kind.

Required mix — include several of each:
- category: what this product category is called ("invoicing software")
- problem: the pain in the buyer's own words, often a question ("how to send invoices faster")
- comparison: alternatives and comparisons ("<known player> alternative", "best invoicing tools")
- longtail: qualified specifics — segment, geography, use case ("invoicing software for accountants uk")

Rules:
- Write what a buyer types, not marketing copy or slogans.
- Do NOT include this business's own brand name. We are looking for demand they could capture from strangers, not people already searching for them.
- For comparison queries, only name companies you are reasonably confident actually exist in this market.
- Keep each query 2-8 words, lowercase.
- These are hypotheses. Real search results will test them next, so breadth matters more than certainty.`;
}

// ---------- Phase 3: keyword validation against real search results ----------

/**
 * Keywords are validated in small sequential batches rather than fanned out
 * one step per keyword. Three failures are avoided by that single choice:
 * the provider's 5 queries/second ceiling is never breached, the run
 * document never becomes a write-contention hotspot under concurrent
 * actions, and classification costs one LLM call per batch instead of one
 * per keyword (which would blow the per-run cost cap outright).
 */
export const VALIDATION_BATCH_SIZE = 4;
/** Spacing between searches inside a batch; keeps us under 5 queries/sec. */
export const SEARCH_PACING_MS = 250;
/** Ledger entries older than this are re-searched; fresher ones are reused. */
export const SEARCH_CACHE_MS = 24 * 60 * 60 * 1000;
/** Results kept as evidence on each candidate (the ledger holds the rest). */
export const EVIDENCE_DOMAINS = 10;

export type Verdict = "relevant" | "irrelevant" | "ambiguous";
export const VERDICTS = ["relevant", "irrelevant", "ambiguous"] as const;

export interface SerpDomain {
  position: number;
  domain: string;
  title?: string;
}

export interface KeywordVerdict {
  keyword: string;
  verdict: Verdict;
  reasoning: string;
  confidence: number;
}

/** Which candidates the next batch should cover. Source of truth is the
 *  candidates' own statuses, so a resumed run never re-validates or skips. */
export function nextValidationBatch<T extends { keyword: string; status: string }>(
  candidates: readonly T[],
  batchSize: number = VALIDATION_BATCH_SIZE,
): T[] {
  return candidates
    .filter((c) => c.status === "unvalidated")
    .slice(0, Math.max(1, batchSize));
}

/** Domain of a result URL, normalized for comparison. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}

/** Serper's organic array → the trimmed evidence we store and classify on. */
export function toSerpDomains(
  organic: readonly { position?: number; link?: string; title?: string }[],
): SerpDomain[] {
  return organic
    .filter((o): o is { position?: number; link: string; title?: string } =>
      typeof o.link === "string",
    )
    .map((o, i) => ({
      position: o.position ?? i + 1,
      domain: domainOf(o.link),
      title: o.title?.slice(0, 120),
    }))
    .slice(0, EVIDENCE_DOMAINS);
}

export const VERDICTS_TOOL_SCHEMA = {
  name: "emit_keyword_verdicts",
  description:
    "Judge whether each search query is one that buyers of this business's product would type, using the domains that actually rank on page one as the evidence.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            keyword: { type: "string", description: "Echo the query exactly as given" },
            verdict: { type: "string", enum: [...VERDICTS] },
            reasoning: {
              type: "string",
              description: "One sentence citing what the ranking domains show",
            },
            confidence: { type: "number", description: "0..1" },
          },
          required: ["keyword", "verdict", "reasoning", "confidence"],
        },
      },
    },
    required: ["verdicts"],
  },
} as const;

/**
 * Parse the classifier's payload. Deliberately forgiving: a batch must always
 * make forward progress, so an unusable payload is rejected (one corrective
 * retry) but a payload merely missing some keywords is accepted — the caller
 * marks the uncovered ones as errored rather than looping on them forever.
 */
export function validateVerdicts(
  raw: unknown,
): { ok: true; verdicts: KeywordVerdict[] } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const list = (raw as Record<string, unknown>).verdicts;
  if (!Array.isArray(list)) return { ok: false, reason: "verdicts must be an array" };
  if (list.length === 0) return { ok: false, reason: "verdicts array is empty" };

  const verdicts: KeywordVerdict[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.keyword !== "string") continue;
    if (!VERDICTS.includes(o.verdict as Verdict)) continue;
    const confidence =
      typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1
        ? o.confidence
        : 0.5;
    verdicts.push({
      keyword: normalizeKeyword(o.keyword),
      verdict: o.verdict as Verdict,
      reasoning:
        typeof o.reasoning === "string" ? o.reasoning.trim().slice(0, 400) : "(no reasoning given)",
      confidence,
    });
  }
  if (verdicts.length === 0) {
    return { ok: false, reason: "no well-formed verdicts in the payload" };
  }
  return { ok: true, verdicts };
}

export function verdictsPrompt(
  profile: StoredProfile,
  searched: readonly { keyword: string; domains: readonly SerpDomain[] }[],
): string {
  const field = (label: string, value: string | null) =>
    `${label}: ${value ?? "(unknown)"}`;

  const blocks = searched
    .map(({ keyword, domains }) => {
      const listing = domains.length
        ? domains.map((d) => `  ${d.position}. ${d.domain}${d.title ? ` — ${d.title}` : ""}`).join("\n")
        : "  (no organic results returned)";
      return `QUERY: "${keyword}"\nRANKS ON PAGE ONE:\n${listing}`;
    })
    .join("\n\n");

  return `Judge each search query below for this business.

BUSINESS
${field("Name", profile.name)}
${field("Category", profile.category)}
${field("What they sell", profile.whatTheySell)}
${field("Audience", profile.audience)}
${field("Buyer", profile.buyerType)}

${blocks}

For each query, decide:
- "relevant": page one is dominated by companies selling something comparable to this business. Someone searching this is plausibly in the market for what this business offers.
- "irrelevant": page one is a different industry, or a different intent entirely — definitions, news, jobs, forums, or a specific company someone was already looking for.
- "ambiguous": genuinely mixed — some comparable companies alongside significant off-target results.

Judge only from the ranking domains shown. They are the evidence; the query's wording is not. Echo each keyword exactly as given, and give one sentence of reasoning that cites what the domains show.`;
}
