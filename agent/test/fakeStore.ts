import type { DomainPosition, GrowthConfig, KeywordCheckResult } from "../src/growth/types";
import type { RunStore } from "../src/store";

interface FakeRun {
  runId: string;
  runKey: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
  startedAt: number;
  source: string;
}

/**
 * In-memory RunStore honoring the same contract the Convex mutations enforce:
 * insert-if-absent on runKey, checkpoint advances only on success, finish is
 * a no-op unless the run is still "running", errored keyword rows are
 * excluded from the baseline.
 */
export class FakeStore implements RunStore {
  runs: FakeRun[] = [];
  keywordChecks = new Map<string, KeywordCheckResult[]>();
  lastSuccessfulRunId: string | undefined;
  paused = false;
  config: GrowthConfig = {
    business: { name: "Acme", domain: "acme.com" },
    keywords: [],
    competitors: [],
    injectFailure: false,
  };
  staleAfterMs = 10 * 60 * 1000;
  now = () => Date.now();

  async recoverStaleRuns(): Promise<number> {
    let recovered = 0;
    for (const run of this.runs) {
      if (run.status === "running" && run.startedAt < this.now() - this.staleAfterMs) {
        run.status = "failed";
        run.error = "crashed mid-run; marked failed by recovery sweep";
        recovered += 1;
      }
    }
    return recovered;
  }

  async isPaused(): Promise<boolean> {
    return this.paused;
  }

  async getConfig(): Promise<GrowthConfig> {
    return this.config;
  }

  async startRun(args: {
    runKey: string;
    trigger: "cron" | "manual";
    itemsTotal: number;
    source: string;
  }) {
    const existing = this.runs.find((r) => r.runKey === args.runKey);
    if (existing) return { runId: existing.runId, created: false };
    const runId = `run-${this.runs.length + 1}`;
    this.runs.push({
      runId,
      runKey: args.runKey,
      status: "running",
      startedAt: this.now(),
      source: args.source,
    });
    this.keywordChecks.set(runId, []);
    return { runId, created: true };
  }

  async getBaseline(): Promise<Record<string, DomainPosition[]>> {
    if (!this.lastSuccessfulRunId) return {};
    const baseline: Record<string, DomainPosition[]> = {};
    for (const check of this.keywordChecks.get(this.lastSuccessfulRunId) ?? []) {
      if (check.error !== undefined) continue;
      baseline[check.keyword] = check.positions;
    }
    return baseline;
  }

  async recordKeywordCheck(runId: string, result: KeywordCheckResult) {
    this.keywordChecks.get(runId)!.push(result);
  }

  async finishRun(runId: string, status: "succeeded" | "failed", error?: string) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run || run.status !== "running") return;
    run.status = status;
    run.error = error;
    if (status === "succeeded") {
      this.lastSuccessfulRunId = runId;
    }
  }
}
