/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A run advanced to the point where keyword candidates exist. */
async function seedCandidates(t: ReturnType<typeof convexTest>, url = "https://acme.com") {
  const { discoveryId } = await t.mutation(api.discovery.index.start, { url });
  await t.run(async (ctx) => {
    await ctx.db.patch(discoveryId, { state: "VALIDATING" });
    for (const keyword of ["alpha term", "beta term", "gamma term"]) {
      await ctx.db.insert("keywordCandidates", {
        discoveryId,
        keyword,
        kind: "category",
        rationale: "seeded",
        status: "unvalidated",
        createdAt: Date.now(),
      });
    }
  });
  return discoveryId;
}

describe("discovery: idempotency", () => {
  test("starting the same URL twice returns the run in flight, never a second run", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    const second = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.discoveryId).toBe(first.discoveryId);

    const runs = await t.query(api.discovery.index.listRuns, {});
    expect(runs).toHaveLength(1);
  });

  test("URL normalization means acme.com and https://acme.com/path are one run", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(api.discovery.index.start, { url: "acme.com" });
    const b = await t.mutation(api.discovery.index.start, { url: "https://acme.com/pricing" });
    expect(b.discoveryId).toBe(a.discoveryId);
  });

  test("a step's derived key makes re-creating its intent a no-op", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    // The sweep re-plans parked runs; it must never duplicate the pending step.
    await t.mutation(internal.discovery.index.sweep, {});
    const steps = await t.run((ctx) =>
      ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .collect(),
    );
    expect(steps.filter((s) => s.kind === "FETCH_PAGES")).toHaveLength(1);
  });
});

describe("discovery: the claim gate", () => {
  test("only one caller can claim a pending step", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    const stepId = await t.run(async (ctx) => {
      const step = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .first();
      return step!._id;
    });

    const first = await t.mutation(internal.discovery.index.claimStep, { stepId });
    const second = await t.mutation(internal.discovery.index.claimStep, { stepId });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // already running — no double execution
  });

  test("the cost cap stops a run before it can spend more", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    await t.run((ctx) => ctx.db.patch(discoveryId, { searchCalls: 9999 }));

    const stepId = await t.run(async (ctx) => {
      const step = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .first();
      return step!._id;
    });
    expect(await t.mutation(internal.discovery.index.claimStep, { stepId })).toBeNull();

    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.state).toBe("FAILED");
    expect(run!.error).toContain("cost cap");
  });

  test("the circuit breaker stops a run after repeated provider failures", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    await t.run((ctx) => ctx.db.patch(discoveryId, { consecutiveFailures: 99 }));

    const stepId = await t.run(async (ctx) => {
      const step = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .first();
      return step!._id;
    });
    expect(await t.mutation(internal.discovery.index.claimStep, { stepId })).toBeNull();
    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.error).toContain("circuit opened");
  });
});

describe("discovery: the effect ledger", () => {
  test("recording the same call twice keeps one entry and counts one spend", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });

    const args = {
      callKey: "serper:abc123",
      kind: "serper" as const,
      discoveryId,
      request: 'search "x"',
      response: { domains: [] },
      ok: true,
    };
    const a = await t.mutation(internal.discovery.index.recordExternalCall, args);
    const b = await t.mutation(internal.discovery.index.recordExternalCall, args);
    expect(b).toBe(a); // same row — a healed retry does not double-record

    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.searchCalls).toBe(1); // and does not double-count the spend
  });

  test("a stale search is treated as absent so it gets re-searched", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    await t.mutation(internal.discovery.index.recordExternalCall, {
      callKey: "serper:old",
      kind: "serper",
      discoveryId,
      request: "search",
      response: { domains: [] },
      ok: true,
    });
    const now = Date.now();
    const fresh = await t.query(internal.discovery.index.getExternalCall, {
      callKey: "serper:old",
      maxAgeMs: 60_000,
      now,
    });
    const stale = await t.query(internal.discovery.index.getExternalCall, {
      callKey: "serper:old",
      maxAgeMs: 60_000,
      now: now + 120_000,
    });
    expect(fresh).not.toBeNull();
    expect(stale).toBeNull();
  });
});

describe("discovery: validation progression", () => {
  test("a completed batch writes verdicts with evidence and plans the next batch", async () => {
    const t = convexTest(schema, modules);
    const discoveryId = await seedCandidates(t);
    await t.run(async (ctx) => {
      const stepId = await ctx.db.insert("discoverySteps", {
        discoveryId,
        kind: "VALIDATE_BATCH",
        stepKey: "seeded",
        status: "running",
        attempts: 1,
        startedAt: Date.now(),
      });
      return stepId;
    });
    const stepId = await t.run(async (ctx) => {
      const s = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .filter((q) => q.eq(q.field("kind"), "VALIDATE_BATCH"))
        .first();
      return s!._id;
    });

    await t.mutation(internal.discovery.index.completeValidationBatch, {
      stepId,
      results: [
        {
          keyword: "alpha term",
          status: "relevant",
          reasoning: "competitors rank here",
          confidence: 0.9,
          topDomains: [{ position: 1, domain: "rival.com" }],
        },
      ],
    });

    const candidates = await t.run((ctx) =>
      ctx.db
        .query("keywordCandidates")
        .withIndex("by_discoveryId", (q) => q.eq("discoveryId", discoveryId))
        .collect(),
    );
    const alpha = candidates.find((c) => c.keyword === "alpha term")!;
    expect(alpha.status).toBe("relevant");
    // The verdict is never stored without the evidence that produced it.
    expect(alpha.validation!.topDomains[0]!.domain).toBe("rival.com");
    expect(alpha.validation!.reasoning).toContain("competitors");
  });

  test("the phase ends by advancing state only once nothing is unvalidated", async () => {
    const t = convexTest(schema, modules);
    const discoveryId = await seedCandidates(t);
    await t.run(async (ctx) => {
      const candidates = await ctx.db
        .query("keywordCandidates")
        .withIndex("by_discoveryId", (q) => q.eq("discoveryId", discoveryId))
        .collect();
      for (const c of candidates) await ctx.db.patch(c._id, { status: "relevant" });
      await ctx.db.insert("discoverySteps", {
        discoveryId,
        kind: "VALIDATE_BATCH",
        stepKey: "seeded-2",
        status: "running",
        attempts: 1,
        startedAt: Date.now(),
      });
    });
    const stepId = await t.run(async (ctx) => {
      const s = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .filter((q) => q.eq(q.field("kind"), "VALIDATE_BATCH"))
        .first();
      return s!._id;
    });

    await t.mutation(internal.discovery.index.completeValidationBatch, { stepId, results: [] });
    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.state).toBe("EXTRACTING_COMPETITORS");
  });
});

describe("discovery: resumability", () => {
  test("a FAILED run resumes in the phase it failed in, not from the start", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    await t.run(async (ctx) => {
      const step = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .first();
      await ctx.db.patch(step!._id, { status: "failed", error: "boom", errorClass: "terminal" });
      await ctx.db.patch(discoveryId, {
        state: "FAILED",
        stateBeforeFailure: "PROFILING",
        error: "FETCH_PAGES: boom",
      });
    });

    const result = await t.mutation(api.discovery.index.resume, { discoveryId });
    expect(result.resumed).toBe(true);

    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.state).toBe("PROFILING"); // restored, not restarted
    expect(run!.error).toBeUndefined();

    const step = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("discoverySteps")
          .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
          .collect()
      )[0],
    );
    expect(step!.status).toBe("pending");
    expect(step!.attempts).toBe(0); // a human retry grants fresh attempts
  });

  test("resuming a run with live work reports it rather than duplicating it", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    const result = await t.mutation(api.discovery.index.resume, { discoveryId });
    expect(result.resumed).toBe(false);
    expect(result.reason).toContain("pending");
  });
});

describe("discovery: the read surface the UI depends on", () => {
  test("getRun returns every section, including competitors", async () => {
    const t = convexTest(schema, modules);
    const discoveryId = await seedCandidates(t);
    await t.run((ctx) =>
      ctx.db.insert("competitors", {
        discoveryId,
        domain: "rival.com",
        classification: "competitor",
        decidedBy: "llm",
        reasoning: "sells the same thing",
        appearances: 2,
        averagePosition: 3,
        bestPosition: 1,
        score: 1.8,
        evidence: [{ keyword: "alpha term", position: 1 }],
        rank: 1,
        selected: true,
        createdAt: Date.now(),
      }),
    );

    const data = await t.query(api.discovery.index.getRun, { discoveryId });
    // This assertion is the regression test for a silently-dropped field:
    // the extraction step succeeded while this query returned nothing.
    expect(data!.competitors).toHaveLength(1);
    expect(data!.competitors[0]!.domain).toBe("rival.com");
    expect(data!.candidates).toHaveLength(3);
    expect(data!.run.url).toBe("https://acme.com");
    expect(data!.implementedFrontier).toBeTruthy();
  });

  test("applyToTracking writes validated keywords and selected competitors into the live config", async () => {
    const t = convexTest(schema, modules);
    const discoveryId = await seedCandidates(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("businessProfiles", {
        discoveryId,
        url: "https://acme.com",
        name: "Acme",
        whatTheySell: "widgets",
        audience: "b2b",
        buyerType: null,
        pricePoint: null,
        businessStage: null,
        category: "widgets",
        fieldConfidence: {},
        pagesFetched: [],
        createdAt: Date.now(),
      });
      const candidates = await ctx.db
        .query("keywordCandidates")
        .withIndex("by_discoveryId", (q) => q.eq("discoveryId", discoveryId))
        .collect();
      await ctx.db.patch(candidates[0]!._id, { status: "relevant" });
      await ctx.db.patch(candidates[1]!._id, { status: "irrelevant" });
      await ctx.db.insert("competitors", {
        discoveryId,
        domain: "rival.com",
        classification: "competitor",
        decidedBy: "llm",
        reasoning: "x",
        appearances: 1,
        averagePosition: 1,
        bestPosition: 1,
        score: 1,
        evidence: [],
        rank: 1,
        selected: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("competitors", {
        discoveryId,
        domain: "reddit.com",
        classification: "forum",
        decidedBy: "list",
        reasoning: "forum",
        appearances: 3,
        averagePosition: 2,
        bestPosition: 1,
        score: 3,
        evidence: [],
        selected: false,
        createdAt: Date.now(),
      });
    });

    const result = await t.mutation(api.discovery.index.applyToTracking, { discoveryId });
    expect(result.keywords).toBe(1); // only the validated one
    expect(result.competitors).toBe(1); // only the selected one

    const config = await t.run((ctx) =>
      ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "singleton")).unique(),
    );
    expect(config!.keywords).toEqual(["alpha term"]);
    expect(config!.competitors).toEqual(["rival.com"]); // reddit never reaches tracking
  });
});

describe("bugfix: a recorded failure never becomes permanent", () => {
  test("a retry that succeeds replaces the failed response instead of discarding it", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });

    // First attempt: the page fetch failed (a timeout looks exactly like this).
    await t.mutation(internal.discovery.index.recordExternalCall, {
      callKey: "fetch:abc",
      kind: "fetch",
      discoveryId,
      request: "GET https://acme.com",
      response: { ok: false, status: 0, text: "" },
      ok: false,
    });
    // Retry succeeds.
    await t.mutation(internal.discovery.index.recordExternalCall, {
      callKey: "fetch:abc",
      kind: "fetch",
      discoveryId,
      request: "GET https://acme.com",
      response: { ok: true, status: 200, text: "real page content" },
      ok: true,
    });

    const entry = await t.query(internal.discovery.index.getExternalCall, { callKey: "fetch:abc" });
    expect(entry!.ok).toBe(true);
    expect(entry!.response.text).toBe("real page content");

    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.fetchCalls).toBe(2); // both calls really happened; count honestly
  });

  test("a success is never overwritten by a later failure", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    const args = {
      callKey: "llm:xyz",
      kind: "llm" as const,
      discoveryId,
      request: "messages",
    };
    await t.mutation(internal.discovery.index.recordExternalCall, {
      ...args,
      response: { good: true },
      ok: true,
    });
    await t.mutation(internal.discovery.index.recordExternalCall, {
      ...args,
      response: null,
      ok: false,
    });

    const entry = await t.query(internal.discovery.index.getExternalCall, { callKey: "llm:xyz" });
    expect(entry!.ok).toBe(true);
    expect(entry!.response).toEqual({ good: true });
  });
});

describe("bugfix: cost caps stop AT the cap, not one past it", () => {
  test("a run sitting exactly at its search cap cannot claim another step", async () => {
    const t = convexTest(schema, modules);
    const { discoveryId } = await t.mutation(api.discovery.index.start, { url: "https://acme.com" });
    await t.run((ctx) => ctx.db.patch(discoveryId, { searchCalls: 40 })); // exactly MAX

    const stepId = await t.run(async (ctx) => {
      const s = await ctx.db
        .query("discoverySteps")
        .withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId))
        .first();
      return s!._id;
    });
    expect(await t.mutation(internal.discovery.index.claimStep, { stepId })).toBeNull();
    const run = await t.run((ctx) => ctx.db.get(discoveryId));
    expect(run!.state).toBe("FAILED");
  });
});
