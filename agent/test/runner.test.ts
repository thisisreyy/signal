import { describe, expect, test } from "bun:test";
import { executeRun } from "../src/runner";
import type { RankingSource, SerpResult } from "../src/ranking/source";
import { FakeStore } from "./fakeStore";

/** A source serving canned SERPs per keyword; throws for unknown keywords. */
function servingSerps(serps: Record<string, string[]>): RankingSource {
  return {
    name: "fake",
    async search(keyword: string): Promise<SerpResult[]> {
      const domains = serps[keyword];
      if (!domains) throw new Error(`quota exhausted for ${keyword}`);
      return domains.map((domain, i) => ({
        position: i + 1,
        domain,
        url: `https://${domain}/`,
      }));
    },
  };
}

const KEYWORDS = ["ai tools", "crm software", "ats platform"];

function makeStore(): FakeStore {
  const store = new FakeStore();
  store.config = {
    business: { name: "Acme", domain: "acme.com" },
    keywords: [...KEYWORDS],
    competitors: ["rival.com"],
    injectFailure: false,
  };
  return store;
}

const HEALTHY = servingSerps({
  "ai tools": ["rival.com", "acme.com", "x.example"],
  "crm software": ["acme.com", "y.example", "rival.com"],
  "ats platform": ["z.example", "rival.com", "acme.com"],
});

describe("executeRun (growth task)", () => {
  test("happy path: records every keyword and advances the checkpoint", async () => {
    const store = makeStore();
    const outcome = await executeRun({
      store,
      source: HEALTHY,
      runKey: "cron-1",
      trigger: "cron",
    });

    expect(outcome.kind).toBe("succeeded");
    const runId = (outcome as { runId: string }).runId;
    const rows = store.keywordChecks.get(runId)!;
    expect(rows).toHaveLength(3);
    expect(store.lastSuccessfulRunId).toBe(runId);
    // First run: positions recorded, but no changes (no baseline yet).
    expect(rows.every((r) => r.changes.length === 0)).toBe(true);
    const aiTools = rows.find((r) => r.keyword === "ai tools")!;
    expect(aiTools.positions).toContainEqual({
      domain: "acme.com",
      isBusiness: true,
      position: 2,
      url: "https://acme.com/",
    });
  });

  test("idempotency: the same runKey twice runs exactly once", async () => {
    const store = makeStore();
    const first = await executeRun({ store, source: HEALTHY, runKey: "cron-42", trigger: "cron" });
    const second = await executeRun({ store, source: HEALTHY, runKey: "cron-42", trigger: "cron" });

    expect(first.kind).toBe("succeeded");
    expect(second).toEqual({ kind: "skipped", reason: "duplicate" });
    expect(store.runs).toHaveLength(1);
    expect([...store.keywordChecks.values()].flat()).toHaveLength(3);
  });

  test("paused agent does not run at all", async () => {
    const store = makeStore();
    store.paused = true;
    const outcome = await executeRun({ store, source: HEALTHY, runKey: "cron-1", trigger: "cron" });
    expect(outcome).toEqual({ kind: "skipped", reason: "paused" });
    expect(store.runs).toHaveLength(0);
  });

  test("changes are detected against the previous successful run", async () => {
    const store = makeStore();
    await executeRun({ store, source: HEALTHY, runKey: "cron-1", trigger: "cron" });

    // Next day: rival overtakes acme on "crm software" and acme slides 1→4.
    const shifted = servingSerps({
      "ai tools": ["rival.com", "acme.com", "x.example"], // unchanged
      "crm software": ["rival.com", "y.example", "q.example", "acme.com"],
      "ats platform": ["z.example", "rival.com", "acme.com"], // unchanged
    });
    const second = await executeRun({ store, source: shifted, runKey: "cron-2", trigger: "cron" });
    const runId = (second as { runId: string }).runId;
    const crm = store.keywordChecks.get(runId)!.find((r) => r.keyword === "crm software")!;

    expect(crm.changes).toContainEqual({
      kind: "moved",
      domain: "acme.com",
      prevPosition: 1,
      position: 4,
    });
    expect(crm.changes).toContainEqual({
      kind: "overtaken",
      domain: "acme.com",
      competitor: "rival.com",
      prevPosition: 1,
      position: 4,
    });
    const unchanged = store.keywordChecks.get(runId)!.find((r) => r.keyword === "ai tools")!;
    expect(unchanged.changes).toEqual([]);
  });

  test("injected mid-run failure leaves consistent partial state and no checkpoint", async () => {
    const store = makeStore();
    store.config.injectFailure = true;
    const outcome = await executeRun({ store, source: HEALTHY, runKey: "cron-1", trigger: "cron" });

    expect(outcome.kind).toBe("failed");
    const runId = (outcome as { runId: string }).runId;
    const run = store.runs.find((r) => r.runId === runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("injected failure");
    // 1 of 3 keywords recorded before the injection point — kept, not rolled
    // back, and the failed run never becomes the diff baseline.
    expect(store.keywordChecks.get(runId)).toHaveLength(1);
    expect(store.lastSuccessfulRunId).toBeUndefined();
  });

  test("recovery: the run after a failure diffs against the last SUCCESSFUL run", async () => {
    const store = makeStore();
    const first = await executeRun({ store, source: HEALTHY, runKey: "cron-1", trigger: "cron" });
    const firstRunId = (first as { runId: string }).runId;

    store.config.injectFailure = true;
    await executeRun({ store, source: HEALTHY, runKey: "cron-2", trigger: "cron" });
    expect(store.lastSuccessfulRunId).toBe(firstRunId);

    store.config.injectFailure = false;
    const shifted = servingSerps({
      "ai tools": ["acme.com", "rival.com", "x.example"], // acme 2 -> 1: overtook
      "crm software": ["acme.com", "y.example", "rival.com"],
      "ats platform": ["z.example", "rival.com", "acme.com"],
    });
    const third = await executeRun({ store, source: shifted, runKey: "cron-3", trigger: "cron" });
    expect(third.kind).toBe("succeeded");
    const thirdRunId = (third as { runId: string }).runId;
    const aiTools = store.keywordChecks.get(thirdRunId)!.find((r) => r.keyword === "ai tools")!;
    // Diffed against run 1 (checkpoint), not the failed run 2.
    expect(aiTools.changes).toContainEqual({
      kind: "overtook",
      domain: "acme.com",
      competitor: "rival.com",
      prevPosition: 2,
      position: 1,
    });
    expect(store.lastSuccessfulRunId).toBe(thirdRunId);
  });

  test("one keyword's fetch failure is recorded as data; the run still succeeds", async () => {
    const store = makeStore();
    const flaky = servingSerps({
      "ai tools": ["acme.com"],
      "ats platform": ["rival.com"],
      // "crm software" missing -> source throws for it
    });
    const outcome = await executeRun({ store, source: flaky, runKey: "cron-1", trigger: "cron" });
    expect(outcome.kind).toBe("succeeded");
    const runId = (outcome as { runId: string }).runId;
    const rows = store.keywordChecks.get(runId)!;
    expect(rows).toHaveLength(3);
    const errored = rows.find((r) => r.keyword === "crm software")!;
    expect(errored.error).toContain("quota exhausted");

    // The errored row is excluded from the next baseline, so the next run
    // reports no fabricated "entered" flood for that keyword.
    const next = await executeRun({ store, source: HEALTHY, runKey: "cron-2", trigger: "cron" });
    const nextRows = store.keywordChecks.get((next as { runId: string }).runId)!;
    expect(nextRows.find((r) => r.keyword === "crm software")!.changes).toEqual([]);
  });

  test("every keyword failing fails the run and holds the checkpoint", async () => {
    const store = makeStore();
    await executeRun({ store, source: HEALTHY, runKey: "cron-1", trigger: "cron" });
    const checkpoint = store.lastSuccessfulRunId;

    const dead = servingSerps({}); // throws for everything (dead API key)
    const outcome = await executeRun({ store, source: dead, runKey: "cron-2", trigger: "cron" });
    expect(outcome.kind).toBe("failed");
    expect((outcome as { error: string }).error).toContain("every keyword check failed");
    expect(store.lastSuccessfulRunId).toBe(checkpoint);
  });

  test("a crashed run (stuck 'running') is marked failed by the next run's sweep", async () => {
    const store = makeStore();
    await store.startRun({ runKey: "cron-old", trigger: "cron", itemsTotal: 3, source: "fake" });
    const crashed = store.runs[0]!;
    crashed.startedAt = Date.now() - 60 * 60 * 1000;

    const outcome = await executeRun({ store, source: HEALTHY, runKey: "cron-new", trigger: "cron" });
    expect(outcome.kind).toBe("succeeded");
    expect(crashed.status).toBe("failed");
    expect(crashed.error).toContain("recovery sweep");
  });
});
