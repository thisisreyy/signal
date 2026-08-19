import type { DomainPosition, GrowthConfig, KeywordCheckResult } from "./growth/types";

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
  getConfig(): Promise<GrowthConfig>;
  /** Idempotent: a duplicate runKey returns the existing run, created=false. */
  startRun(args: {
    runKey: string;
    trigger: "cron" | "manual";
    itemsTotal: number;
    source: string;
  }): Promise<{ runId: string; created: boolean }>;
  /**
   * Per-keyword positions from the last successful run, keyed by keyword.
   * Keyword rows that errored are excluded, so a transient fetch failure can
   * never masquerade as "everyone dropped out".
   */
  getBaseline(): Promise<Record<string, DomainPosition[]>>;
  recordKeywordCheck(runId: string, result: KeywordCheckResult): Promise<void>;
  /** On "succeeded", the store must also advance the checkpoint. */
  finishRun(
    runId: string,
    status: "succeeded" | "failed",
    error?: string,
  ): Promise<void>;
}
