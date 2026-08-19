import type { CheckResult } from "./checker";
import type { BaselineEntry, Change } from "./diff";

/**
 * Everything the runner needs from durable storage, as a narrow interface.
 * Production uses ConvexRunStore; tests use an in-memory fake that mimics the
 * same transactional contract (insert-if-absent on runKey, checkpoint only
 * advancing on success).
 */
export interface RunStore {
  /** Mark crashed runs (stuck in "running") as failed. Returns count. */
  recoverStaleRuns(): Promise<number>;
  isPaused(): Promise<boolean>;
  getConfig(): Promise<{ urls: string[]; injectFailure: boolean }>;
  /** Idempotent: a duplicate runKey returns the existing run, created=false. */
  startRun(args: {
    runKey: string;
    trigger: "cron" | "manual";
    itemsTotal: number;
  }): Promise<{ runId: string; created: boolean }>;
  /** Per-URL results from the last successful run, keyed by URL. */
  getBaseline(): Promise<Record<string, BaselineEntry>>;
  recordCheck(
    runId: string,
    result: CheckResult,
    change: Change | undefined,
  ): Promise<void>;
  /** On "succeeded", the store must also advance the checkpoint. */
  finishRun(
    runId: string,
    status: "succeeded" | "failed",
    error?: string,
  ): Promise<void>;
}
