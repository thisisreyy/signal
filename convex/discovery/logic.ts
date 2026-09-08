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
export const IMPLEMENTED_FRONTIER: DiscoveryState = "GENERATING_KEYWORDS";

export const STEP_KINDS = ["FETCH_PAGES", "PROFILE"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

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
export const MAX_LLM_CALLS = 6;

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
