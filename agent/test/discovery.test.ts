import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  callKey,
  classifyError,
  contentHash,
  htmlToText,
  pagesToFetch,
  profilePrompt,
  stepKey,
  validateProfile,
} from "../../convex/discovery/logic";

describe("derived idempotency keys", () => {
  test("same input always produces the same key", () => {
    expect(stepKey("run1", "PROFILE", "https://acme.com")).toBe(
      stepKey("run1", "PROFILE", "https://acme.com"),
    );
    expect(callKey("fetch", "run1:https://acme.com")).toBe(
      callKey("fetch", "run1:https://acme.com"),
    );
  });

  test("different run, step, or input produce different keys", () => {
    const base = stepKey("run1", "PROFILE", "https://acme.com");
    expect(stepKey("run2", "PROFILE", "https://acme.com")).not.toBe(base);
    expect(stepKey("run1", "FETCH_PAGES", "https://acme.com")).not.toBe(base);
    expect(stepKey("run1", "PROFILE", "https://other.com")).not.toBe(base);
  });

  test("hash is stable across calls", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("error classification", () => {
  test("rate limits, timeouts and 5xx are retryable", () => {
    expect(classifyError("anything", 429)).toBe("retryable");
    expect(classifyError("anything", 503)).toBe("retryable");
    expect(classifyError("connect timeout")).toBe("retryable");
    expect(classifyError("fetch failed")).toBe("retryable");
  });

  test("auth and validation failures are terminal", () => {
    expect(classifyError("anything", 401)).toBe("terminal");
    expect(classifyError("anything", 422)).toBe("terminal");
    expect(classifyError("malformed whatever")).toBe("terminal");
  });

  test("the injected crash heals through the retryable path", () => {
    expect(classifyError("injected crash (PROFILE, after-ledger)")).toBe("retryable");
  });
});

describe("backoff", () => {
  test("grows with attempts and stays within bounds", () => {
    const fixed = () => 0.5;
    const a1 = backoffMs(1, fixed);
    const a2 = backoffMs(2, fixed);
    const a3 = backoffMs(3, fixed);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    expect(backoffMs(20, fixed)).toBeLessThanOrEqual(5 * 60_000);
  });

  test("jitter keeps it above half the exponential", () => {
    expect(backoffMs(1, () => 0)).toBeGreaterThanOrEqual(2_500);
    expect(backoffMs(1, () => 0.999)).toBeLessThanOrEqual(5_000);
  });
});

describe("profile validation", () => {
  const good = {
    name: "Acme",
    what_they_sell: "invoicing software",
    audience: "b2b",
    buyer_type: "technical",
    price_point: null,
    business_stage: "startup",
    category: "invoicing software",
    field_confidence: { name: 0.9, price_point: 0.1 },
  };

  test("accepts a well-formed profile, nulls allowed", () => {
    const result = validateProfile(good);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.price_point).toBeNull();
      expect(result.profile.audience).toBe("b2b");
    }
  });

  test("rejects a missing field rather than guessing", () => {
    const { name, ...missing } = good;
    const result = validateProfile(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("name");
  });

  test("rejects an invalid audience value", () => {
    expect(validateProfile({ ...good, audience: "everyone" }).ok).toBe(false);
  });

  test("rejects out-of-range confidence", () => {
    expect(validateProfile({ ...good, field_confidence: { name: 1.4 } }).ok).toBe(false);
  });

  test("rejects non-object payloads", () => {
    expect(validateProfile("a profile as prose").ok).toBe(false);
    expect(validateProfile(null).ok).toBe(false);
  });
});

describe("page handling", () => {
  test("fetch plan is a small fixed set on the site origin", () => {
    const pages = pagesToFetch("https://acme.com/some/deep/path");
    expect(pages[0]).toBe("https://acme.com");
    expect(pages).toContain("https://acme.com/pricing");
    expect(pages.length).toBeLessThanOrEqual(4);
  });

  test("htmlToText strips scripts, styles and tags", () => {
    const text = htmlToText(
      "<html><script>evil()</script><style>.x{}</style><h1>Acme</h1><p>We sell invoices&nbsp;fast</p></html>",
    );
    expect(text).toContain("Acme");
    expect(text).toContain("We sell invoices");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("<h1>");
  });

  test("prompt includes every page and the null instruction", () => {
    const prompt = profilePrompt("https://acme.com", [
      { url: "https://acme.com", text: "hello" },
      { url: "https://acme.com/pricing", text: "" },
    ]);
    expect(prompt).toContain("https://acme.com/pricing");
    expect(prompt).toContain("null");
  });
});

// ---------- Phase 2 ----------

import {
  KEYWORD_KINDS,
  keywordsPrompt,
  MIN_KEYWORDS,
  nextStepKind,
  normalizeKeyword,
  validateKeywords,
} from "../../convex/discovery/logic";

function makeKeywords(n: number, kind: string = "category") {
  return Array.from({ length: n }, (_, i) => ({
    keyword: `keyword number ${i}`,
    kind: KEYWORD_KINDS[i % KEYWORD_KINDS.length] ?? kind,
    rationale: "a buyer would search this",
  }));
}

describe("state machine resumption", () => {
  test("derives the next step from state plus finished steps", () => {
    expect(nextStepKind("PROFILING", [])).toBe("FETCH_PAGES");
    expect(nextStepKind("PROFILING", ["FETCH_PAGES"])).toBe("PROFILE");
    expect(nextStepKind("PROFILING", ["FETCH_PAGES", "PROFILE"])).toBeNull();
    expect(nextStepKind("GENERATING_KEYWORDS", [])).toBe("GENERATE_KEYWORDS");
    expect(nextStepKind("GENERATING_KEYWORDS", ["GENERATE_KEYWORDS"])).toBeNull();
  });

  test("states past the implemented frontier have no next step", () => {
    expect(nextStepKind("VALIDATING", [])).toBeNull();
    expect(nextStepKind("COMPLETE", [])).toBeNull();
    expect(nextStepKind("FAILED", [])).toBeNull();
  });
});

describe("keyword normalization", () => {
  test("lowercases, trims, collapses whitespace and strips quotes", () => {
    expect(normalizeKeyword('  "Invoicing   Software" ')).toBe("invoicing software");
    expect(normalizeKeyword("AI BDR")).toBe("ai bdr");
  });

  test("normalization is what makes dedup work", () => {
    expect(normalizeKeyword("AI BDR")).toBe(normalizeKeyword("  ai bdr  "));
  });
});

describe("keyword validation", () => {
  test("accepts a well-formed mixed pool", () => {
    const result = validateKeywords({ keywords: makeKeywords(16) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keywords).toHaveLength(16);
  });

  test("rejects a pool that is too thin to be a pool", () => {
    const result = validateKeywords({ keywords: makeKeywords(5) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(`at least ${MIN_KEYWORDS}`);
  });

  test("rejects more than the maximum", () => {
    expect(validateKeywords({ keywords: makeKeywords(40) }).ok).toBe(false);
  });

  test("drops duplicates rather than failing", () => {
    const dupes = [...makeKeywords(16), ...makeKeywords(4)]; // 4 exact repeats
    const result = validateKeywords({ keywords: dupes.slice(0, 20) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const unique = new Set(result.keywords.map((k) => k.keyword));
      expect(unique.size).toBe(result.keywords.length);
    }
  });

  test("rejects a single-flavour pool — the phase promises a mix", () => {
    const flat = Array.from({ length: 16 }, (_, i) => ({
      keyword: `category term ${i}`,
      kind: "category",
      rationale: "why",
    }));
    const result = validateKeywords({ keywords: flat });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("mix");
  });

  test("rejects an unknown kind", () => {
    const bad = makeKeywords(16);
    bad[0]!.kind = "vibes";
    const result = validateKeywords({ keywords: bad });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("kind");
  });

  test("rejects prose where a schema is required", () => {
    expect(validateKeywords("here are some keywords: invoicing software").ok).toBe(false);
    expect(validateKeywords({ keywords: "invoicing software" }).ok).toBe(false);
    expect(validateKeywords(null).ok).toBe(false);
  });

  test("rejects an over-long keyword", () => {
    const bad = makeKeywords(16);
    bad[0]!.keyword = "x".repeat(200);
    expect(validateKeywords({ keywords: bad }).ok).toBe(false);
  });
});

describe("keyword prompt", () => {
  const profile = {
    name: "Revnu",
    whatTheySell: "AI growth automation",
    audience: "b2b" as const,
    buyerType: "founders",
    pricePoint: null,
    businessStage: "early-stage",
    category: "growth automation platform",
  };

  test("includes the profile and demands the required mix", () => {
    const prompt = keywordsPrompt("https://revnu.com", profile);
    expect(prompt).toContain("growth automation platform");
    for (const kind of KEYWORD_KINDS) expect(prompt).toContain(kind);
  });

  test("marks unknown fields as not determinable instead of inviting a guess", () => {
    const prompt = keywordsPrompt("https://revnu.com", profile);
    expect(prompt).toContain("not determinable");
  });

  test("tells the model to exclude the business's own brand", () => {
    expect(keywordsPrompt("https://revnu.com", profile)).toContain("own brand name");
  });
});
