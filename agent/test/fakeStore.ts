import type { CheckResult } from "../src/checker";
import type { BaselineEntry, Change } from "../src/diff";
import type { RunStore } from "../src/store";

interface FakeRun {
  runId: string;
  runKey: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
  startedAt: number;
}

/**
 * In-memory RunStore honoring the same contract the Convex mutations enforce:
 * insert-if-absent on runKey, checkpoint advances only on success, finish is
 * a no-op unless the run is still "running".
 */
export class FakeStore implements RunStore {
  runs: FakeRun[] = [];
  checks = new Map<string, (CheckResult & { change?: Change })[]>();
  lastSuccessfulRunId: string | undefined;
  paused = false;
  urls: string[] = [];
  injectFailure = false;
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

  async getConfig() {
    return { urls: this.urls, injectFailure: this.injectFailure };
  }

  async startRun(args: { runKey: string; trigger: "cron" | "manual"; urlsTotal: number }) {
    const existing = this.runs.find((r) => r.runKey === args.runKey);
    if (existing) return { runId: existing.runId, created: false };
    const runId = `run-${this.runs.length + 1}`;
    this.runs.push({
      runId,
      runKey: args.runKey,
      status: "running",
      startedAt: this.now(),
    });
    this.checks.set(runId, []);
    return { runId, created: true };
  }

  async getBaseline(): Promise<Record<string, BaselineEntry>> {
    if (!this.lastSuccessfulRunId) return {};
    const baseline: Record<string, BaselineEntry> = {};
    for (const check of this.checks.get(this.lastSuccessfulRunId) ?? []) {
      baseline[check.url] = { ok: check.ok, statusCode: check.statusCode };
    }
    return baseline;
  }

  async recordCheck(runId: string, result: CheckResult, change: Change | undefined) {
    this.checks.get(runId)!.push({ ...result, change });
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
