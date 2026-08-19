import { describe, expect, test } from "bun:test";
import { executeRun } from "../src/runner";
import type { CheckerOptions } from "../src/checker";
import { FakeStore } from "./fakeStore";

/** Checker options whose fetch serves canned statuses, no network. */
function servingStatuses(statuses: Record<string, number>): CheckerOptions {
  return {
    fetchImpl: (async (input: unknown) => {
      const status = statuses[String(input)];
      if (status === undefined) throw new Error("ECONNREFUSED");
      return new Response("", { status });
    }) as unknown as typeof fetch,
  };
}

const URLS = ["https://a.test", "https://b.test", "https://c.test"];

function makeStore(): FakeStore {
  const store = new FakeStore();
  store.urls = [...URLS];
  return store;
}

describe("executeRun", () => {
  test("happy path: records every URL and advances the checkpoint", async () => {
    const store = makeStore();
    const outcome = await executeRun({
      store,
      runKey: "cron-1",
      trigger: "cron",
      checkerOptions: servingStatuses({
        "https://a.test": 200,
        "https://b.test": 200,
        "https://c.test": 404,
      }),
    });

    expect(outcome.kind).toBe("succeeded");
    const runId = (outcome as { runId: string }).runId;
    expect(store.checks.get(runId)).toHaveLength(3);
    expect(store.lastSuccessfulRunId).toBe(runId);
    // First run ever: every URL is a "new" change.
    expect(store.checks.get(runId)!.every((c) => c.change?.kind === "new")).toBe(true);
  });

  test("idempotency: the same runKey twice runs exactly once", async () => {
    const store = makeStore();
    const options = servingStatuses({
      "https://a.test": 200,
      "https://b.test": 200,
      "https://c.test": 200,
    });
    const first = await executeRun({ store, runKey: "cron-42", trigger: "cron", checkerOptions: options });
    const second = await executeRun({ store, runKey: "cron-42", trigger: "cron", checkerOptions: options });

    expect(first.kind).toBe("succeeded");
    expect(second).toEqual({ kind: "skipped", reason: "duplicate" });
    expect(store.runs).toHaveLength(1);
    expect([...store.checks.values()].flat()).toHaveLength(3);
  });

  test("paused agent does not run at all", async () => {
    const store = makeStore();
    store.paused = true;
    const outcome = await executeRun({ store, runKey: "cron-1", trigger: "cron" });
    expect(outcome).toEqual({ kind: "skipped", reason: "paused" });
    expect(store.runs).toHaveLength(0);
  });

  test("injected mid-run failure leaves consistent partial state and no checkpoint", async () => {
    const store = makeStore();
    store.injectFailure = true;
    const outcome = await executeRun({
      store,
      runKey: "cron-1",
      trigger: "cron",
      checkerOptions: servingStatuses({ "https://a.test": 200 }),
    });

    expect(outcome.kind).toBe("failed");
    const runId = (outcome as { runId: string }).runId;
    const run = store.runs.find((r) => r.runId === runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("injected failure");
    // It got through 1 of 3 URLs before the injection point — that partial
    // result is durably recorded, not rolled back and not corrupted.
    expect(store.checks.get(runId)).toHaveLength(1);
    // The failed run must never become the diff baseline.
    expect(store.lastSuccessfulRunId).toBeUndefined();
  });

  test("recovery: the run after a failure diffs against the last SUCCESSFUL run", async () => {
    const store = makeStore();
    const healthy = servingStatuses({
      "https://a.test": 200,
      "https://b.test": 200,
      "https://c.test": 200,
    });

    // Run 1 succeeds and becomes the baseline.
    const first = await executeRun({ store, runKey: "cron-1", trigger: "cron", checkerOptions: healthy });
    const firstRunId = (first as { runId: string }).runId;

    // Run 2 fails midway (injection). Checkpoint must not move.
    store.injectFailure = true;
    await executeRun({ store, runKey: "cron-2", trigger: "cron", checkerOptions: healthy });
    expect(store.lastSuccessfulRunId).toBe(firstRunId);

    // Run 3 runs clean with one URL now broken. Its diff must be computed
    // against run 1 (the checkpoint), so exactly one "broke" change appears.
    store.injectFailure = false;
    const third = await executeRun({
      store,
      runKey: "cron-3",
      trigger: "cron",
      checkerOptions: servingStatuses({
        "https://a.test": 200,
        "https://b.test": 500,
        "https://c.test": 200,
      }),
    });
    expect(third.kind).toBe("succeeded");
    const thirdRunId = (third as { runId: string }).runId;
    const changes = store.checks.get(thirdRunId)!.filter((c) => c.change);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.change).toEqual({
      kind: "broke",
      prevOk: true,
      prevStatusCode: 200,
    });
    expect(store.lastSuccessfulRunId).toBe(thirdRunId);
  });

  test("a crashed run (stuck 'running') is marked failed by the next run's sweep", async () => {
    const store = makeStore();
    // Simulate a crash: a run started long ago that never finalized.
    await store.startRun({ runKey: "cron-old", trigger: "cron", itemsTotal: 3 });
    const crashed = store.runs[0]!;
    crashed.startedAt = Date.now() - 60 * 60 * 1000;
    expect(crashed.status).toBe("running");

    const outcome = await executeRun({
      store,
      runKey: "cron-new",
      trigger: "cron",
      checkerOptions: servingStatuses({
        "https://a.test": 200,
        "https://b.test": 200,
        "https://c.test": 200,
      }),
    });
    expect(outcome.kind).toBe("succeeded");
    expect(crashed.status).toBe("failed");
    expect(crashed.error).toContain("recovery sweep");
  });
});
