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

// ---------- Phase 3 ----------

import {
  domainOf,
  nextValidationBatch,
  toSerpDomains,
  validateVerdicts,
  VALIDATION_BATCH_SIZE,
  verdictsPrompt,
} from "../../convex/discovery/logic";

describe("validation batch planning", () => {
  const candidates = [
    { keyword: "a", status: "relevant" },
    { keyword: "b", status: "unvalidated" },
    { keyword: "c", status: "error" },
    { keyword: "d", status: "unvalidated" },
    { keyword: "e", status: "unvalidated" },
    { keyword: "f", status: "unvalidated" },
    { keyword: "g", status: "unvalidated" },
  ];

  test("takes only unvalidated candidates, up to the batch size", () => {
    const batch = nextValidationBatch(candidates);
    expect(batch).toHaveLength(VALIDATION_BATCH_SIZE);
    expect(batch.every((c) => c.status === "unvalidated")).toBe(true);
    expect(batch.map((c) => c.keyword)).toEqual(["b", "d", "e", "f"]);
  });

  test("never re-validates a keyword that already has a verdict", () => {
    const batch = nextValidationBatch(candidates);
    expect(batch.map((c) => c.keyword)).not.toContain("a");
    expect(batch.map((c) => c.keyword)).not.toContain("c");
  });

  test("empty when everything is judged — that is how the phase ends", () => {
    const done = candidates.map((c) => ({ ...c, status: "relevant" }));
    expect(nextValidationBatch(done)).toHaveLength(0);
  });

  test("progress is derived from data, so a resumed run picks up exactly where it stopped", () => {
    const first = nextValidationBatch(candidates);
    const after = candidates.map((c) =>
      first.some((f) => f.keyword === c.keyword) ? { ...c, status: "relevant" } : c,
    );
    const second = nextValidationBatch(after);
    expect(second.map((c) => c.keyword)).toEqual(["g"]);
  });
});

describe("SERP evidence extraction", () => {
  test("domainOf strips protocol, www and path", () => {
    expect(domainOf("https://www.clay.com/claygent")).toBe("clay.com");
    expect(domainOf("https://docs.saasquatch.com/x")).toBe("docs.saasquatch.com");
  });

  test("keeps position, domain and a trimmed title", () => {
    const domains = toSerpDomains([
      { position: 1, link: "https://www.artisan.co/ai-sales-agent", title: "Ava" },
      { link: "https://lindy.ai/", title: "Lindy" },
    ]);
    expect(domains[0]).toEqual({ position: 1, domain: "artisan.co", title: "Ava" });
    expect(domains[1]!.position).toBe(2); // falls back to index order
  });

  test("drops malformed results rather than throwing", () => {
    expect(toSerpDomains([{ position: 1 }, { position: 2, link: "https://ok.com" }])).toHaveLength(1);
  });
});

describe("verdict parsing", () => {
  const good = {
    verdicts: [
      { keyword: "ai bdr", verdict: "relevant", reasoning: "competitors rank here", confidence: 0.9 },
      { keyword: "AI SDR", verdict: "ambiguous", reasoning: "mixed", confidence: 0.5 },
    ],
  };

  test("accepts well-formed verdicts and normalizes the keyword", () => {
    const result = validateVerdicts(good);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdicts[1]!.keyword).toBe("ai sdr"); // normalized for matching
    }
  });

  test("skips individual malformed entries but keeps the usable ones", () => {
    const mixed = { verdicts: [...good.verdicts, { keyword: "x", verdict: "maybe" }, null] };
    const result = validateVerdicts(mixed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdicts).toHaveLength(2);
  });

  test("defaults an out-of-range confidence rather than failing the batch", () => {
    const odd = { verdicts: [{ ...good.verdicts[0], confidence: 42 }] };
    const result = validateVerdicts(odd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdicts[0]!.confidence).toBe(0.5);
  });

  test("rejects an entirely unusable payload so the corrective retry fires", () => {
    expect(validateVerdicts({ verdicts: [] }).ok).toBe(false);
    expect(validateVerdicts({ verdicts: "relevant" }).ok).toBe(false);
    expect(validateVerdicts("all of them are fine").ok).toBe(false);
  });
});

describe("verdict prompt", () => {
  const profile = {
    name: "Revnu",
    whatTheySell: "AI growth automation",
    audience: "b2b" as const,
    buyerType: "founders",
    pricePoint: null,
    businessStage: null,
    category: "growth automation platform",
  };

  test("shows the ranking domains as the evidence to judge on", () => {
    const prompt = verdictsPrompt(profile, [
      { keyword: "ai bdr", domains: [{ position: 1, domain: "artisan.co", title: "Ava" }] },
    ]);
    expect(prompt).toContain("artisan.co");
    expect(prompt).toContain("RANKS ON PAGE ONE");
    expect(prompt).toContain("Judge only from the ranking domains");
  });

  test("handles a keyword with no organic results without breaking", () => {
    const prompt = verdictsPrompt(profile, [{ keyword: "nothing", domains: [] }]);
    expect(prompt).toContain("no organic results");
  });
});

// ---------- Phase 4 ----------

import {
  aggregateDomains,
  competitorsPrompt,
  excludedCategory,
  positionScore,
  rankCompetitors,
  registrableDomain,
  validateClassifications,
} from "../../convex/discovery/logic";

describe("domain normalization", () => {
  test("collapses subdomains to the company domain", () => {
    expect(registrableDomain("docs.saasquatch.com")).toBe("saasquatch.com");
    expect(registrableDomain("www.artisan.co")).toBe("artisan.co");
    expect(registrableDomain("play.google.com")).toBe("google.com");
  });

  test("handles multi-part TLDs", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
  });

  test("subdomain tricks cannot bypass the exclusion list", () => {
    expect(excludedCategory("old.reddit.com")).toBe("forum");
    expect(excludedCategory("apps.apple.com")).toBe("marketplace");
    expect(excludedCategory("artisan.co")).toBeNull();
  });
});

describe("competitor aggregation", () => {
  const validated = [
    {
      keyword: "ai bdr",
      topDomains: [
        { domain: "artisan.co", position: 1 },
        { domain: "reddit.com", position: 2 },
        { domain: "lindy.ai", position: 5 },
      ],
    },
    {
      keyword: "ai sdr",
      topDomains: [
        { domain: "artisan.co", position: 3 },
        { domain: "clay.com", position: 4 },
      ],
    },
  ];

  test("counts appearances and averages positions across keywords", () => {
    const stats = aggregateDomains(validated);
    const artisan = stats.find((s) => s.domain === "artisan.co")!;
    expect(artisan.appearances).toBe(2);
    expect(artisan.bestPosition).toBe(1);
    expect(artisan.averagePosition).toBe(2);
    expect(artisan.evidence).toHaveLength(2);
  });

  test("ranking often and ranking well both raise the score", () => {
    const stats = aggregateDomains(validated);
    const artisan = stats.find((s) => s.domain === "artisan.co")!;
    const lindy = stats.find((s) => s.domain === "lindy.ai")!;
    expect(artisan.score).toBeGreaterThan(lindy.score);
    expect(stats[0]!.domain).toBe("artisan.co"); // sorted by score
  });

  test("the business is never its own competitor", () => {
    const stats = aggregateDomains(validated, "https://artisan.co");
    expect(stats.find((s) => s.domain === "artisan.co")).toBeUndefined();
  });

  test("a domain holding several slots on one page counts once for it", () => {
    const stats = aggregateDomains([
      {
        keyword: "x",
        topDomains: [
          { domain: "artisan.co", position: 1 },
          { domain: "artisan.co", position: 7 },
        ],
      },
    ]);
    const artisan = stats.find((s) => s.domain === "artisan.co")!;
    expect(artisan.appearances).toBe(1);
    expect(artisan.bestPosition).toBe(1); // keeps the best of the two
  });

  test("position score decays with rank and floors at zero", () => {
    expect(positionScore(1)).toBe(1);
    expect(positionScore(11)).toBeCloseTo(0.5, 5);
    expect(positionScore(50)).toBe(0);
  });
});

describe("competitor ranking and selection", () => {
  const classified = [
    { domain: "a.com", classification: "competitor" as const, score: 3 },
    { domain: "b.com", classification: "competitor" as const, score: 9 },
    { domain: "c.com", classification: "directory" as const, score: 20 },
    { domain: "d.com", classification: "competitor" as const, score: 5 },
  ];

  test("only true competitors are ranked, best score first", () => {
    const ranked = rankCompetitors(classified, 5);
    expect(ranked.map((r) => r.domain)).toEqual(["b.com", "d.com", "a.com"]);
    expect(ranked.every((r) => r.classification === "competitor")).toBe(true);
  });

  test("a high-scoring directory never becomes a tracked competitor", () => {
    expect(rankCompetitors(classified, 5).find((r) => r.domain === "c.com")).toBeUndefined();
  });

  test("top N is configurable and marks only those as selected", () => {
    const ranked = rankCompetitors(classified, 2);
    expect(ranked.filter((r) => r.selected).map((r) => r.domain)).toEqual(["b.com", "d.com"]);
  });
});

describe("classification parsing", () => {
  test("accepts valid classifications and normalizes the domain", () => {
    const result = validateClassifications({
      domains: [
        { domain: "www.Artisan.co", classification: "competitor", reasoning: "AI BDR", confidence: 0.9 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.classifications[0]!.domain).toBe("artisan.co");
  });

  test("drops entries with an unknown classification", () => {
    const result = validateClassifications({
      domains: [
        { domain: "a.com", classification: "competitor", reasoning: "x", confidence: 1 },
        { domain: "b.com", classification: "rival-ish", reasoning: "x", confidence: 1 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.classifications).toHaveLength(1);
  });

  test("rejects an unusable payload so the corrective retry fires", () => {
    expect(validateClassifications({ domains: [] }).ok).toBe(false);
    expect(validateClassifications("they are all competitors").ok).toBe(false);
  });
});

describe("competitor prompt", () => {
  test("carries the evidence and warns against loose competitor calls", () => {
    const prompt = competitorsPrompt(
      {
        name: "Revnu", whatTheySell: "growth automation", audience: "b2b",
        buyerType: "founders", pricePoint: null, businessStage: null,
        category: "growth automation platform",
      },
      [
        {
          domain: "artisan.co", appearances: 2, averagePosition: 2, bestPosition: 1, score: 1.9,
          evidence: [{ keyword: "ai bdr", position: 1 }],
        },
      ],
    );
    expect(prompt).toContain("artisan.co");
    expect(prompt).toContain('"ai bdr" #1');
    expect(prompt).toContain("Be strict");
  });
});

describe("registrableDomain robustness", () => {
  test("tolerates a full URL, a port, and a path", () => {
    expect(registrableDomain("https://www.artisan.co/ai-sales-agent?x=1")).toBe("artisan.co");
    expect(registrableDomain("http://localhost:3000")).toBe("localhost");
    expect(registrableDomain("https://docs.saasquatch.com/guide")).toBe("saasquatch.com");
  });
});

// ---------- Regression tests for fixed bugs ----------

import { hasStaleYear, MAX_FETCH_CALLS } from "../../convex/discovery/logic";

describe("bugfix: stale-year keywords are dropped", () => {
  test("a query pinned to a past year is rotted", () => {
    expect(hasStaleYear("best marketing automation tools 2024", 2026)).toBe(true);
    expect(hasStaleYear("crm software 2019", 2026)).toBe(true);
  });

  test("the current year, or no year at all, is fine", () => {
    expect(hasStaleYear("best crm tools 2026", 2026)).toBe(false);
    expect(hasStaleYear("marketing automation software", 2026)).toBe(false);
  });

  test("a number that isn't a year is not mistaken for one", () => {
    expect(hasStaleYear("top 10 crm tools", 2026)).toBe(false);
    expect(hasStaleYear("g2 crm", 2026)).toBe(false);
  });

  test("validateKeywords silently drops stale ones instead of failing", () => {
    const list = makeKeywords(16);
    list[0]!.keyword = "best marketing automation tools 2024";
    const result = validateKeywords({ keywords: list }, 2026);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keywords.map((k) => k.keyword)).not.toContain(
        "best marketing automation tools 2024",
      );
      expect(result.keywords).toHaveLength(15);
    }
  });
});

describe("bugfix: competitor ranking is deterministic on ties", () => {
  test("equal scores always order the same way", () => {
    const tied = [
      { domain: "zzz.com", classification: "competitor" as const, score: 5 },
      { domain: "aaa.com", classification: "competitor" as const, score: 5 },
    ];
    expect(rankCompetitors(tied, 5).map((r) => r.domain)).toEqual(["aaa.com", "zzz.com"]);
    expect(rankCompetitors([...tied].reverse(), 5).map((r) => r.domain)).toEqual([
      "aaa.com",
      "zzz.com",
    ]);
  });
});

describe("bugfix: fetch budget has headroom for re-attempts", () => {
  test("a failed page can be retried without tripping the cap", () => {
    // 4 pages per run; failures now re-attempt rather than caching forever.
    expect(MAX_FETCH_CALLS).toBeGreaterThanOrEqual(4 * 3);
  });
});

// ---------- Phase 5: the grounding gate ----------

import {
  buildGroundTruth,
  MAX_PREDICTED_RANK,
  recommendationsPrompt,
  validateRecommendations,
  verifyGrounding,
  type KeywordTruth,
} from "../../convex/discovery/logic";

const TRUTH: KeywordTruth[] = [
  { keyword: "ai bdr", ourRank: undefined, competitors: [{ domain: "artisan.co", rank: 1 }] },
  { keyword: "gtm automation platform", ourRank: 8, competitors: [{ domain: "clay.com", rank: 4 }] },
];

function rec(over: Partial<Parameters<typeof verifyGrounding>[0]> = {}) {
  return {
    action: "Publish a comparison page",
    rationale: "because",
    evidence: [{ keyword: "ai bdr", competitor: "artisan.co", theirRank: 1 }],
    expectedOutcome: { keyword: "ai bdr", predictedRank: 15, timeframeDays: 30 },
    confidence: 0.6,
    fallback: "try something else",
    ...over,
  };
}

describe("ground truth from stored evidence", () => {
  test("records our rank and each tracked competitor's rank", () => {
    const truth = buildGroundTruth(
      [
        {
          keyword: "ai bdr",
          topDomains: [
            { domain: "artisan.co", position: 1 },
            { domain: "reddit.com", position: 2 },
            { domain: "acme.com", position: 6 },
          ],
        },
      ],
      "https://acme.com",
      ["artisan.co"],
    );
    expect(truth[0]!.ourRank).toBe(6);
    expect(truth[0]!.competitors).toEqual([{ domain: "artisan.co", rank: 1 }]);
  });

  test("untracked domains never become facts", () => {
    const truth = buildGroundTruth(
      [{ keyword: "k", topDomains: [{ domain: "random.com", position: 1 }] }],
      "https://acme.com",
      ["artisan.co"],
    );
    expect(truth[0]!.competitors).toHaveLength(0);
  });

  test("not ranking is recorded as absent, not as a large number", () => {
    const truth = buildGroundTruth(
      [{ keyword: "k", topDomains: [{ domain: "artisan.co", position: 1 }] }],
      "https://acme.com",
      ["artisan.co"],
    );
    expect(truth[0]!.ourRank).toBeUndefined();
  });
});

describe("the grounding gate rejects fabrication", () => {
  test("accepts a recommendation whose citations match stored data", () => {
    const result = verifyGrounding(rec(), TRUTH);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence[0]!.competitor).toBe("artisan.co");
  });

  test("rejects a hallucinated competitor rank", () => {
    const result = verifyGrounding(
      rec({ evidence: [{ keyword: "ai bdr", competitor: "artisan.co", theirRank: 9 }] }),
      TRUTH,
    );
    expect(result.ok).toBe(false); // stored data says #1, not #9
  });

  test("rejects a competitor that does not rank for that keyword", () => {
    const result = verifyGrounding(
      rec({ evidence: [{ keyword: "ai bdr", competitor: "clay.com", theirRank: 4 }] }),
      TRUTH,
    );
    expect(result.ok).toBe(false); // clay ranks for a different keyword
  });

  test("rejects a keyword we never validated", () => {
    const result = verifyGrounding(
      rec({ evidence: [{ keyword: "invented keyword", competitor: "artisan.co", theirRank: 1 }] }),
      TRUTH,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a claim that we rank when stored data says we don't", () => {
    const result = verifyGrounding(
      rec({ evidence: [{ keyword: "ai bdr", ourRank: 3 }] }),
      TRUTH,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a prediction about an untracked keyword", () => {
    const result = verifyGrounding(
      rec({ expectedOutcome: { keyword: "not tracked", predictedRank: 5, timeframeDays: 30 } }),
      TRUTH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not tracked");
  });

  test("rejects a stated current rank that contradicts stored data", () => {
    const result = verifyGrounding(
      rec({
        evidence: [{ keyword: "gtm automation platform", competitor: "clay.com", theirRank: 4 }],
        expectedOutcome: {
          keyword: "gtm automation platform",
          currentRank: 2, // stored says 8
          predictedRank: 3,
          timeframeDays: 30,
        },
      }),
      TRUTH,
    );
    expect(result.ok).toBe(false);
  });

  test("keeps only the citations that check out, dropping the rest", () => {
    const result = verifyGrounding(
      rec({
        evidence: [
          { keyword: "ai bdr", competitor: "artisan.co", theirRank: 1 }, // true
          { keyword: "ai bdr", competitor: "clay.com", theirRank: 4 }, // false
        ],
      }),
      TRUTH,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence).toHaveLength(1);
  });

  test("backfills the true rank rather than trusting what was claimed", () => {
    const result = verifyGrounding(
      rec({ evidence: [{ keyword: "ai bdr", competitor: "artisan.co" }] }),
      TRUTH,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence[0]!.theirRank).toBe(1); // from the database
  });
});

describe("recommendation structure", () => {
  const good = {
    recommendations: [
      {
        action: "do the thing",
        rationale: "because of the data",
        evidence: [{ keyword: "ai bdr", competitor: "artisan.co", their_rank: 1 }],
        expected_outcome: { keyword: "ai bdr", predicted_rank: 12, timeframe_days: 30 },
        confidence: 0.7,
        fallback: "otherwise this",
      },
    ],
  };

  test("accepts a well-formed recommendation", () => {
    const result = validateRecommendations(good);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recommendations[0]!.expectedOutcome.predictedRank).toBe(12);
  });

  test("drops a recommendation with no evidence array entries at all", () => {
    const bare = { recommendations: [{ ...good.recommendations[0], evidence: [] }] };
    expect(validateRecommendations(bare).ok).toBe(false);
  });

  test("drops an unfalsifiable prediction", () => {
    const noTimeframe = {
      recommendations: [
        {
          ...good.recommendations[0],
          expected_outcome: { keyword: "ai bdr", predicted_rank: 12 },
        },
      ],
    };
    expect(validateRecommendations(noTimeframe).ok).toBe(false);
  });

  test("drops an out-of-range prediction", () => {
    const absurd = {
      recommendations: [
        {
          ...good.recommendations[0],
          expected_outcome: {
            keyword: "ai bdr",
            predicted_rank: MAX_PREDICTED_RANK + 500,
            timeframe_days: 30,
          },
        },
      ],
    };
    expect(validateRecommendations(absurd).ok).toBe(false);
  });

  test("rejects prose where a schema is required", () => {
    expect(validateRecommendations("You should write more blog posts.").ok).toBe(false);
  });
});

describe("recommendation prompt", () => {
  test("states the facts and warns that citations are checked", () => {
    const prompt = recommendationsPrompt(
      {
        name: "Acme", whatTheySell: "widgets", audience: "b2b", buyerType: null,
        pricePoint: null, businessStage: null, category: "widgets",
      },
      TRUTH,
    );
    expect(prompt).toContain("NOT RANKED");
    expect(prompt).toContain("artisan.co #1");
    expect(prompt).toContain("checked against the database");
    expect(prompt).toContain("Do not invent");
  });
});
